import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { connect, Index, type Table } from '@lancedb/lancedb';
import { Bool, Field, FixedSizeList, Float32, List, Schema, Utf8 } from 'apache-arrow';
import { memoryForEvent } from '$lib/theater/memory';
import type { WitnessedEvent, World } from '$lib/theater/types';
import { createEmbedder, modelSettings, type Settings } from './oev';
import { resolveProviderModel } from './providers';

type Fields = Record<string, unknown>;
type Embed = (input: string[], inputType: 'query' | 'document') => Promise<number[][]>;
export interface MemoryRecall {
	status: 'hybrid' | 'bm25' | 'unavailable' | 'disabled' | 'not_needed';
	events: WitnessedEvent[];
	names?: Record<string, string>;
}
interface MemoryDocument {
	eventId: string;
	sourceHash: string;
	text: string;
	witnesses: string[];
}
interface Dependencies {
	settings: Settings;
	directory: string;
	embed?: Embed;
	signal: AbortSignal;
	checkpoint: () => void;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const locks = new Map<string, Promise<unknown>>();
const maxDocumentBytes = 6000;

/** Serialize projection changes per world/configuration; failures never poison the next query. */
async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	const current = previous.catch(() => {}).then(operation);
	locks.set(key, current);
	try { return await current; }
	finally { if (locks.get(key) === current) locks.delete(key); }
}

function documents(world: World): MemoryDocument[] {
	const names = new Map([['player', '플레이어'], ...world.state.instances.map((actor): [string, string] => [actor.id, actor.name])]);
	const scenes = new Map(world.definition.scenes.map((scene) => [scene.id, scene.name]));
	const witnesses = new Map<string, string[]>();
	for (const actor of world.state.instances) {
		for (const eventId of new Set(actor.memories.map((memory) => memory.eventId))) {
			const ids = witnesses.get(eventId) ?? [];
			ids.push(actor.id);
			witnesses.set(eventId, ids);
		}
	}
	let oversized = 0;
	const result = world.state.events.flatMap((event): MemoryDocument[] => {
		const observers = witnesses.get(event.id);
		if (event.kind === 'wait' || !observers?.length) return [];
		const memory = memoryForEvent(event);
		// Names aid retrieval; the canonical structured event remains the only prompt source.
		const text = [
			`주체: ${names.get(event.actorId) ?? event.actorId}. 대상: ${event.targetId ? names.get(event.targetId) ?? event.targetId : '없음'}. 장소: ${scenes.get(event.sceneId) ?? event.sceneId}.`,
			memory.body.narrative ? `행동: ${memory.body.narrative}` : '',
			memory.body.utterance ? `발언: ${memory.body.utterance}` : '',
			memory.destinationId ? `이동 목적지: ${scenes.get(memory.destinationId) ?? memory.destinationId}` : '',
			memory.changes ? `상태 변화: ${JSON.stringify(memory.changes)}` : ''
		].filter(Boolean).join('\n');
		// Do not silently truncate imported transcripts or mistake a skipped document for lost memory.
		if (Buffer.byteLength(text) > maxDocumentBytes) { oversized++; return []; }
		return [{ eventId: event.id, sourceHash: hash(JSON.stringify([memory, text, observers.sort()])), text, witnesses: observers }];
	});
	if (oversized) console.warn('[기억 검색] 색인 입력 한도를 넘는 사건을 건너뜁니다. 원본은 유지됩니다.', { worldId: world.id, count: oversized, maxDocumentBytes });
	return result;
}

function schema(dimensions: number): Schema {
	return new Schema([
		new Field('eventId', new Utf8(), false), new Field('sourceHash', new Utf8(), false), new Field('text', new Utf8(), false),
		new Field('witnesses', new List(new Field('item', new Utf8(), false)), false),
		new Field('hasVector', new Bool(), false),
		new Field('vector', new FixedSizeList(dimensions, new Field('item', new Float32(), true)), true)
	]);
}

/** Reconcile IDs and content on every read, including after restore/reset or manual recovery. */
async function synchronize(table: Table, source: MemoryDocument[], checkpoint: () => void): Promise<MemoryDocument[]> {
	const saved = await table.query().select(['eventId', 'sourceHash', 'hasVector']).toArray();
	checkpoint();
	const existing = new Map(saved.map((row) => [String(row.eventId), row]));
	const current = new Map(source.map((doc) => [doc.eventId, doc]));
	const removed = [...existing.keys()].filter((id) => !current.has(id));
	for (let offset = 0; offset < removed.length; offset += 100) {
		checkpoint();
		await table.delete(`eventId IN (${removed.slice(offset, offset + 100).map(literal).join(',')})`);
	}
	const changed = source.filter((doc) => existing.get(doc.eventId)?.sourceHash !== doc.sourceHash);
	for (let offset = 0; offset < changed.length; offset += 64) {
		checkpoint();
		await table.mergeInsert('eventId').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(changed.slice(offset, offset + 64).map((doc) => ({ ...doc, hasVector: false, vector: null })));
	}
	return source.filter((doc) => existing.get(doc.eventId)?.sourceHash !== doc.sourceHash || !existing.get(doc.eventId)?.hasVector);
}

function embeddingBatches(docs: MemoryDocument[]): MemoryDocument[][] {
	const batches: MemoryDocument[][] = [];
	let batch: MemoryDocument[] = [];
	let bytes = 0;
	for (const doc of docs) {
		const size = Buffer.byteLength(doc.text);
		if (batch.length && (batch.length === 8 || bytes + size > 12000)) { batches.push(batch); batch = []; bytes = 0; }
		batch.push(doc); bytes += size;
	}
	if (batch.length) batches.push(batch);
	return batches;
}

/** RRF combines ranks rather than incompatible BM25 scores and cosine distances. */
function fusedIds(keyword: Fields[], vector: Fields[]): string[] {
	const scores = new Map<string, number>();
	for (const ranked of [keyword, vector]) {
		for (const [rank, row] of ranked.entries()) {
			const id = String(row.eventId);
			scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1));
		}
	}
	return [...scores].sort((left, right) => right[1] - left[1]).map(([id]) => id);
}

function queryText(state: Fields): string {
	const self = state.self as Fields;
	const memo = self.memo as Fields | null | undefined;
	const recent = state.recentEvents as WitnessedEvent[] | undefined;
	// The immediate stimulus comes first. No world exposition or another actor's private memo.
	return [...(recent ?? []).slice(-2).flatMap((event) => [event.body.narrative, event.body.utterance]), memo?.currentIntention, (state.scene as Fields)?.name]
		.filter((value): value is string => typeof value === 'string' && !!value.trim()).join('\n').slice(0, 1200);
}

async function recall(world: World, state: Fields, deps: Dependencies): Promise<MemoryRecall> {
	const { settings, signal, checkpoint } = deps;
	checkpoint();
	if (!settings.memoryEnabled) return { status: 'disabled', events: [] };
	const actor = world.state.instances.find((instance) => instance.id === (state.self as Fields).id);
	if (!actor) return { status: 'not_needed', events: [] };
	const recent = new Set((actor.memories.slice(-16)).map((event) => event.eventId));
	const witnessed = new Set(actor.memories.map((event) => event.eventId));
	const candidates = new Map(world.state.events.filter((event) => witnessed.has(event.id) && !recent.has(event.id) && event.kind !== 'wait').map((event) => [event.id, memoryForEvent(event)]));
	const query = queryText(state);
	if (!candidates.size || !query.trim()) return { status: 'not_needed', events: [] };
	const source = documents(world);
	const canonical = new Map(source.map((doc) => [doc.eventId, doc]));
	const embedding = resolveProviderModel(settings, settings.embeddingModel, 'embedding');
	// The index identity and its vectors must use the same route, even if an alias is edited while awaiting I/O.
	const embed = deps.embed ?? createEmbedder(settings, signal, checkpoint, embedding);
	const tableName = `memories_${hash(JSON.stringify([world.id, embedding.baseUrl, embedding.kind, embedding.model, settings.embeddingDimensions, settings.memoryTokenizer, 'event-text-v1-ngram2-3'])).slice(0, 32)}`;
	return exclusive(`${deps.directory}:${tableName}`, async () => {
		checkpoint();
		const db = await connect(deps.directory);
		let table: Table | undefined;
		try {
			table = await db.createEmptyTable(tableName, schema(settings.embeddingDimensions), { existOk: true });
			const missing = await synchronize(table, source, checkpoint);
			if (!(await table.listIndices()).some((index) => index.columns.includes('text'))) {
				await table.createIndex('text', { config: Index.fts({ baseTokenizer: settings.memoryTokenizer, ngramMinLength: 2, ngramMaxLength: 3, stem: false, removeStopWords: false, withPosition: false }) });
			}
			checkpoint();
			// A table belongs to one world/configuration. Filter the observer before ranking.
			const filter = [`array_has(witnesses, ${literal(actor.id)})`, ...(recent.size ? [`eventId NOT IN (${[...recent].map(literal).join(',')})`] : [])].join(' AND ');
			const limit = Math.max(16, settings.memoryTopK * 4);
			const keyword = await table.search(query, 'fts').where(filter).select(['eventId', 'sourceHash', '_score']).limit(limit).toArray();
			let vector: Fields[] = [];
			let status: MemoryRecall['status'] = 'hybrid';
			let embedded = 0;
			try {
				const [queryVector] = await embed([query], 'query');
				// Bound catch-up work per lookup; BM25 covers the entire projection immediately.
				for (const batch of embeddingBatches(missing.slice().reverse().slice(0, 32))) {
					const vectors = await embed(batch.map((doc) => doc.text), 'document');
					checkpoint();
					await table.mergeInsert('eventId').whenMatchedUpdateAll().execute(batch.map((doc, index) => ({ ...doc, hasVector: true, vector: vectors[index] })));
					embedded += batch.length;
				}
				checkpoint();
				vector = await table.vectorSearch(queryVector).distanceType('cosine').where(`${filter} AND hasVector = true`).select(['eventId', 'sourceHash', '_distance']).limit(limit).toArray();
			} catch (error) {
				signal.throwIfAborted(); checkpoint();
				status = 'bm25';
				console.warn('[기억 검색] 벡터 검색을 사용할 수 없어 BM25로 진행합니다.', { worldId: world.id, reason: error instanceof Error ? error.message : '벡터 검색 오류' });
			}
			checkpoint();
			const valid = (rows: Fields[]) => rows.filter((row) => candidates.has(String(row.eventId)) && canonical.get(String(row.eventId))?.sourceHash === row.sourceHash);
			const events: WitnessedEvent[] = [];
			let bytes = 2;
			for (const id of fusedIds(valid(keyword), valid(vector))) {
				const event = candidates.get(id)!;
				const size = Buffer.byteLength(JSON.stringify(event)) + 1;
				if (events.length >= settings.memoryTopK) break;
				if (bytes + size > settings.memoryMaxBytes) continue;
				events.push(event); bytes += size;
			}
			const known = new Set(events.flatMap((event) => [event.actorId, event.targetId]));
			const names = Object.fromEntries(world.state.instances.filter((instance) => known.has(instance.id)).map((instance) => [instance.id, instance.name]));
			console.info('[기억 검색] 조회 완료', { worldId: world.id, observerId: actor.id, status, count: events.length, bytes, vectorBacklog: missing.length - embedded });
			return { status, events, names };
		} finally { table?.close(); db.close(); }
	});
}

/** One recall per immutable observation, reused by participation, generation and its review. */
export function createMemoryRecall(signal: AbortSignal, checkpoint: () => void, overrides?: Partial<Dependencies>) {
	const settings = overrides?.settings ?? modelSettings();
	const deps: Dependencies = {
		settings, signal, checkpoint,
		directory: resolve(process.env.NEWERA_MEMORY_DIR || resolve(process.env.NEWERA_DATA_DIR || 'data', 'memory-lance')),
		...overrides
	};
	const cached = new WeakMap<Fields, Promise<Fields>>();
	return (world: World, state: Fields): Promise<Fields> => {
		let result = cached.get(state);
		if (!result) {
			result = recall(world, state, deps).catch((error): MemoryRecall => {
				signal.throwIfAborted(); checkpoint();
				console.warn('[기억 검색] 검색을 사용할 수 없습니다. 최근 목격 기록과 현재 메모를 유지합니다.', { worldId: world.id, reason: error instanceof Error ? error.message : '검색 오류' });
				return { status: 'unavailable', events: [] };
			}).then((memoryRecall) => ({ ...state, memoryRecall }));
			cached.set(state, result);
		}
		return result;
	};
}
