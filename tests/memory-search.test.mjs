import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect } from '@lancedb/lancedb';
import { createMemoryRecall } from '../src/lib/server/memory-search.ts';
import { checkedEmbeddings, createEmbedder, modelSettings } from '../src/lib/server/oev.ts';
import { memoryForEvent } from '../src/lib/theater/memory.ts';
import { participationContext, performanceContext, performanceReviewContext, outfitContext, reflectionInput } from '../src/lib/theater/inference-context.ts';

function fixture() {
	const event = (id, actorId, text, kind = 'speak') => ({ id, actorId, targetId: 'player', sceneId: 'gate', tick: 1, kind, text });
	const promise = event('promise', 'seo', '교실로 안내하기로 약속했어. 파란 우산은 내가 맡아둘게.');
	const unseen = event('private', 'sun', '교실 비밀 열쇠의 위치는 창고다.');
	const waits = Array.from({ length: 20 }, (_, i) => event(`wait-${i}`, 'observer', '주변을 지켜본다.', 'wait'));
	const events = [promise, unseen, ...waits];
	const observer = { id: 'observer', name: '민지', memories: [promise, ...waits].map(memoryForEvent) };
	const other = { id: 'sun', name: '양순자', memories: [unseen].map(memoryForEvent) };
	const world = { id: 'world-A', revision: 1, definition: { scenes: [{ id: 'gate', name: '정문' }] }, state: { events, instances: [observer, other, { id: 'seo', name: '서우', memories: [] }] } };
	const state = { self: { id: observer.id, name: observer.name, memories: observer.memories.slice(-16), memo: { currentIntention: '교실에 가고 우산을 돌려받고 싶다.' } }, scene: { id: 'gate', name: '정문' }, recentEvents: observer.memories.slice(-12), present: [{ id: 'seo', name: '서우', kind: 'character' }] };
	return { world, state, promise, unseen, observer };
}
const vector = (text) => text.includes('교실') ? [1, 0, 0] : [0, 1, 0];
async function harness(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'newera-memory-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settings = { ...modelSettings(), embeddingDimensions: 3, memoryEnabled: true, memoryTopK: 4, memoryTokenizer: 'ngram', ...options.settings };
	const calls = [];
	const embed = options.embed ?? (async (input, type) => { calls.push({ input, type }); return input.map(vector); });
	const controller = new AbortController();
	const recall = () => createMemoryRecall(controller.signal, () => controller.signal.throwIfAborted(), { settings, directory, embed });
	return { directory, settings, calls, recall, controller };
}

test('LanceDB hybrid recall returns older witnessed originals, preserves actors, and is reused within one observation', async (t) => {
	const { recall, calls } = await harness(t);
	const { world, state, promise } = fixture();
	const before = structuredClone(world);
	const enrich = recall();
	const result = await enrich(world, state);
	assert.equal(result.memoryRecall.status, 'hybrid');
	assert.deepEqual(result.memoryRecall.events, [memoryForEvent(promise)]);
	assert.equal(result.memoryRecall.events[0].actorId, 'seo', 'observer is not substituted for the speaker');
	assert.deepEqual(world, before, 'retrieval never changes canonical records or private state');
	const count = calls.length;
	assert.equal(await enrich(world, state), result);
	assert.equal(calls.length, count, 'participation and expression reuse one lookup');
	assert.ok(calls.some(call => call.type === 'document'));
	assert.ok(calls.some(call => call.type === 'query'));
});

test('Korean BM25 finds 교실로 with 교실; an embedding outage keeps keyword recall and a degraded status', async (t) => {
	const { recall } = await harness(t, { embed: async () => { throw new Error('embedding offline'); } });
	const { world, state } = fixture();
	state.recentEvents = [{ eventId: 'query', actorId: 'player', body: { narrative: null, utterance: '교실' } }];
	state.self.memo = null;
	state.scene.name = '';
	const result = await recall()(world, state);
	assert.equal(result.memoryRecall.status, 'bm25');
	assert.deepEqual(result.memoryRecall.events.map(event => event.eventId), ['promise']);
});

test('restart reuses persisted vectors; restore and rewritten event IDs reconcile to the current source', async (t) => {
	const { recall, calls, directory } = await harness(t);
	const { world, state, observer } = fixture();
	await recall()(world, state);
	const oldDocumentCalls = calls.filter(call => call.type === 'document').length;
	await recall()(world, structuredClone(state));
	assert.equal(calls.filter(call => call.type === 'document').length, oldDocumentCalls, 'new director reuses vectors from disk');
	world.state.events[0].text = '교실 안내를 취소했다. 우산을 이미 돌려주었다.';
	const rewritten = await recall()(world, structuredClone(state));
	assert.equal(rewritten.memoryRecall.events[0].body.utterance, world.state.events[0].text);
	const retained = { ...world.state.events[0], id: 'restored', text: '교실에서 다시 만나기로 약속했다.' };
	world.state.events = [retained, ...world.state.events.slice(1)];
	observer.memories = [memoryForEvent(retained), ...observer.memories.slice(1)];
	const restored = await recall()(world, structuredClone(state));
	assert.deepEqual(restored.memoryRecall.events.map(event => event.eventId), ['restored']);
	const db = await connect(directory);
	try {
		const table = await db.openTable((await db.tableNames())[0]);
		try { assert.equal(await table.countRows("eventId = 'promise'"), 0, 'removed source event is pruned from the projection'); }
		finally { table.close(); }
	} finally { db.close(); }
});

test('worlds, observers and SQL-sensitive identifiers stay isolated before ranking', async (t) => {
	const { recall } = await harness(t);
	const { world, state, observer } = fixture();
	await recall()(world, state);
	const otherWorld = structuredClone(world);
	otherWorld.id = 'world-B';
	otherWorld.state.events[0].text = '교실 예약은 다른 학교 이야기다.';
	const other = await recall()(otherWorld, structuredClone(state));
	assert.match(other.memoryRecall.events[0].body.utterance, /다른 학교/);
	const first = await recall()(world, structuredClone(state));
	assert.ok(!JSON.stringify(first.memoryRecall).includes('다른 학교'));
	observer.id = "민지' OR true --";
	state.self.id = observer.id;
	const quoted = await recall()(world, structuredClone(state));
	assert.deepEqual(quoted.memoryRecall.events.map(event => event.eventId), ['promise']);
});

test('recent-only history skips embeddings; byte budgets omit whole events and disabled search is explicit', async (t) => {
	const { recall, calls } = await harness(t, { settings: { memoryMaxBytes: 20 } });
	const { world, state, observer } = fixture();
	const limited = await recall()(world, state);
	assert.deepEqual(limited.memoryRecall.events, [], 'do not silently trim a quoted event to fit');
	observer.memories = observer.memories.slice(-16);
	calls.length = 0;
	assert.equal((await recall()(world, structuredClone(state))).memoryRecall.status, 'not_needed');
	assert.equal(calls.length, 0);
	const disabled = await harness(t, { settings: { memoryEnabled: false } });
	assert.equal((await disabled.recall()(world, state)).memoryRecall.status, 'disabled');
});

test('index failure is distinct from no remembered events; cancellation is never swallowed', async (t) => {
	const { directory, settings, controller } = await harness(t);
	const { writeFile } = await import('node:fs/promises');
	const file = join(directory, 'not-a-directory');
	await writeFile(file, 'x');
	const { world, state } = fixture();
	const recall = createMemoryRecall(controller.signal, () => controller.signal.throwIfAborted(), { settings, directory: file, embed: async input => input.map(vector) });
	assert.equal((await recall(world, state)).memoryRecall.status, 'unavailable');
	controller.abort(new Error('operator stopped'));
	await assert.rejects(recall(world, structuredClone(state)), /operator stopped/);
});

test('model/tokenizer revision creates a separate projection and bounded batches catch up without duplication', async (t) => {
	const { directory, settings, calls, controller, recall } = await harness(t);
	const { world, state, observer } = fixture();
	const old = Array.from({ length: 18 }, (_, i) => ({ ...world.state.events[0], id: `old-${i}`, text: '교실 안내에 대한 목격 기록이다. '.repeat(35) }));
	world.state.events.unshift(...old);
	observer.memories.unshift(...old.map(memoryForEvent));
	await recall()(world, state);
	const documents = calls.filter(call => call.type === 'document');
	assert.ok(documents.length > 2);
	assert.ok(documents.every(call => call.input.length <= 8 && call.input.reduce((size, text) => size + Buffer.byteLength(text), 0) <= 12000));
	const next = createMemoryRecall(controller.signal, () => {}, { settings: { ...settings, embeddingModel: 'another-model' }, directory, embed: async input => input.map(vector) });
	await next(world, structuredClone(state));
	const db = await connect(directory);
	try { assert.equal((await db.tableNames()).length, 2); }
	finally { db.close(); }
});

test('retrieved events stay separate and bounded in prompts, and never enter outfit or fresh-evidence reflection', () => {
	const { state, promise } = fixture();
	state.memoryRecall = { status: 'hybrid', events: Array.from({ length: 4 }, (_, i) => ({ ...memoryForEvent(promise), eventId: `old-${i}` })) };
	assert.equal(participationContext(state).recalledEvents.length, 2);
	assert.equal(performanceContext(state).history.filter(event => event.eventId.startsWith('old-')).length, 4);
	assert.ok(!('recalledEvents' in performanceContext(state)), 'generation history contains each event once');
	assert.equal(performanceReviewContext(state, {}).recalledEvents.length, 4);
	assert.equal(participationContext(state).recalledEvents[0].actorName, '서우');
	assert.ok(!('memorySearch' in outfitContext(state)));
	assert.ok(!('recalledEvents' in reflectionInput(state, { newEvents: [], evidenceEvents: [], targets: [] })));
});

test('embedding batches validate model, count, index mapping, dimensions and finite nonzero values before use', () => {
	const result = { model: 'embeddinggemma2', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] };
	assert.deepEqual(checkedEmbeddings(result, 2, 2, 'embeddinggemma2'), [[1, 0], [0, 1]]);
	for (const bad of [
		{ ...result, model: 'other' }, { ...result, data: result.data.slice(1) },
		{ ...result, data: [result.data[0], result.data[0]] },
		{ ...result, data: [{ index: 0, embedding: [NaN, 1] }, result.data[0]] },
		{ ...result, data: [{ index: 0, embedding: [0, 0] }, result.data[0]] }
	]) assert.throws(() => checkedEmbeddings(bad, 2, 2, 'embeddinggemma2'));
	assert.throws(() => checkedEmbeddings(result, 2, 768, 'embeddinggemma2'));
});

test('OEV embedding transport sends distinct query/document prompts and rejects oversized work before fetch', async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	const calls = [];
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url: String(url), body });
		return new Response(JSON.stringify({ model: body.model, data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
	};
	const embed = createEmbedder({ ...modelSettings(), embeddingDimensions: 2, maxRetries: 0 }, new AbortController().signal);
	await embed(['교실 안내'], 'query');
	await embed(['서우가 교실로 안내하기로 약속했다.'], 'document');
	assert.deepEqual(calls.map(call => call.body.input_type), ['query', 'document']);
	assert.ok(calls.every(call => call.url.endsWith('/embeddings') && call.body.model === 'embeddinggemma2' && call.body.dimensions === 2));
	await assert.rejects(embed(['가'.repeat(3000)], 'document'), /입력 크기/);
	assert.equal(calls.length, 2);
});
