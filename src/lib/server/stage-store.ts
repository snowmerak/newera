import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restoredProgress } from '$lib/theater/ensemble';
import { exampleWorld } from '$lib/theater/fixtures';
import { actionForRequest, initialState, templateFor } from '$lib/theater/runtime';
import type { GenerationJob, ModelSelection, PlayerRequest, RelationshipScores, SaveSlot, StageView, TurnProgress, World, WorldDefinition, WorldSummary } from '$lib/theater/types';
import { checkedModelSelection, checkedRelationships, record, text, validateDefinition, validateState } from '$lib/theater/validation';
import { checkedProviderSnapshot, type ProviderSnapshot } from './providers';

type Row = Record<string, unknown>;
let database: DatabaseSync | undefined;

export function store(): DatabaseSync {
	if (database) return database;
	const directory = process.env.NEWERA_DATA_DIR || join(process.cwd(), 'data');
	mkdirSync(directory, { recursive: true });
	const db = new DatabaseSync(join(directory, 'newera.sqlite'), { timeout: 5000 });
	db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS theater_worlds (
			id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, definition_json TEXT NOT NULL,
			state_json TEXT NOT NULL, created_at TEXT NOT NULL, model_settings_json TEXT
		);
		CREATE TABLE IF NOT EXISTS theater_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS theater_saves (
			world_id TEXT NOT NULL REFERENCES theater_worlds(id), slot INTEGER NOT NULL,
			saved_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(world_id, slot)
		);
		CREATE TABLE IF NOT EXISTS theater_jobs (
			id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES theater_worlds(id), revision INTEGER NOT NULL,
			request_json TEXT NOT NULL, status TEXT NOT NULL, worker_id TEXT, heartbeat_at TEXT,
			created_at TEXT NOT NULL, completed_at TEXT, error TEXT, progress_json TEXT, models_json TEXT, inputs_json TEXT
		);
		CREATE UNIQUE INDEX IF NOT EXISTS theater_jobs_active ON theater_jobs(world_id) WHERE status IN ('pending', 'running');
		CREATE INDEX IF NOT EXISTS theater_jobs_recent ON theater_jobs(world_id, created_at DESC);`);
	if (!(db.prepare('PRAGMA table_info(theater_jobs)').all() as Row[]).some((column) => column.name === 'progress_json')) {
		db.exec('ALTER TABLE theater_jobs ADD COLUMN progress_json TEXT');
	}
	if (!(db.prepare('PRAGMA table_info(theater_jobs)').all() as Row[]).some((column) => column.name === 'models_json')) db.exec('ALTER TABLE theater_jobs ADD COLUMN models_json TEXT');
	if (!(db.prepare('PRAGMA table_info(theater_jobs)').all() as Row[]).some((column) => column.name === 'providers_json')) db.exec('ALTER TABLE theater_jobs ADD COLUMN providers_json TEXT');
	if (!(db.prepare('PRAGMA table_info(theater_jobs)').all() as Row[]).some((column) => column.name === 'inputs_json')) db.exec('ALTER TABLE theater_jobs ADD COLUMN inputs_json TEXT');
	if (!(db.prepare('PRAGMA table_info(theater_worlds)').all() as Row[]).some((column) => column.name === 'model_settings_json')) db.exec('ALTER TABLE theater_worlds ADD COLUMN model_settings_json TEXT');
	database = db;
	try {
		transaction(() => {
			if (!db.prepare('SELECT id FROM theater_worlds LIMIT 1').get()) insertWorld(exampleWorld());
			const active = db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get() as Row | undefined;
			if (!active || !db.prepare('SELECT id FROM theater_worlds WHERE id = ?').get(String(active.value))) {
				setActive(String((db.prepare('SELECT id FROM theater_worlds ORDER BY created_at LIMIT 1').get() as Row).id));
			}
		});
	} catch (error) {
		database = undefined;
		db.close();
		throw error;
	}
	return db;
}

export function transaction<T>(operation: () => T): T {
	const db = store();
	db.exec('BEGIN IMMEDIATE');
	try { const result = operation(); db.exec('COMMIT'); return result; }
	catch (error) { db.exec('ROLLBACK'); throw error; }
}

function setActive(id: string): void {
	store().prepare("INSERT INTO theater_meta VALUES ('active', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
}
export function activeWorldId(): string {
	return String((store().prepare("SELECT value FROM theater_meta WHERE key = 'active'").get() as Row).value);
}
export function selectWorld(id: string): void { getWorld(id); setActive(id); }
export function getWorld(id = activeWorldId()): World {
	const row = store().prepare('SELECT * FROM theater_worlds WHERE id = ?').get(id) as Row | undefined;
	if (!row) throw new Error('세계관을 찾을 수 없습니다.');
	return { id: String(row.id), revision: Number(row.revision), definition: JSON.parse(String(row.definition_json)), state: JSON.parse(String(row.state_json)), models: row.model_settings_json ? checkedModelSelection(JSON.parse(String(row.model_settings_json))) : null };
}

/** Operational session preferences apply to the next accepted job, without invalidating an active job. */
export function setWorldModels(id: string, selection: ModelSelection | null): void {
	const models = selection === null ? null : checkedModelSelection(selection);
	const changed = store().prepare('UPDATE theater_worlds SET model_settings_json = ? WHERE id = ?').run(models ? JSON.stringify(models) : null, id);
	if (Number(changed.changes) !== 1) throw new Error('세계관을 찾을 수 없습니다.');
}
export function listWorlds(): WorldSummary[] {
	return (store().prepare('SELECT id, revision, definition_json FROM theater_worlds ORDER BY created_at, rowid').all() as Row[])
		.map((row) => ({ id: String(row.id), revision: Number(row.revision), name: String(JSON.parse(String(row.definition_json)).name) }));
}

function insertWorld(definition: WorldDefinition, state = initialState(definition), id: string = randomUUID()): string {
	store().prepare('INSERT INTO theater_worlds (id, revision, definition_json, state_json, created_at) VALUES (?, 0, ?, ?, ?)').run(id, JSON.stringify(definition), JSON.stringify(state), new Date().toISOString());
	return id;
}

function blankDefinition(name: string, description: string): WorldDefinition {
	return validateDefinition({ name, description, rules: '', startingSceneId: 'opening', scenes: [{ id: 'opening', name: '첫 장면', description: '이야기가 시작되는 곳.', exits: [] }], templates: [], spawns: [] });
}

export function createWorld(name: string, description: string): string {
	const definition = blankDefinition(name, description);
	return transaction(() => { const id = insertWorld(definition); setActive(id); return id; });
}

function clearWorldHistory(id: string): void {
	// Removing jobs also fences in-flight model responses before deleting their world or replacing its snapshot.
	store().prepare('DELETE FROM theater_jobs WHERE world_id = ?').run(id);
	store().prepare('DELETE FROM theater_saves WHERE world_id = ?').run(id);
}

export function deleteWorld(id: string, revision: number): void {
	transaction(() => {
		const world = getWorld(id);
		if (world.revision !== revision) throw new Error('세계관이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
		const active = activeWorldId() === id;
		clearWorldHistory(id);
		store().prepare('DELETE FROM theater_worlds WHERE id = ?').run(id);
		if (active) {
			const next = store().prepare('SELECT id FROM theater_worlds ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as Row | undefined;
			setActive(next ? String(next.id) : insertWorld(blankDefinition('새 이야기', '새로운 세계관을 만들거나 파일을 가져와 주세요.')));
		}
	});
}

export function editWorld(id: string, revision: number, operation: (world: World) => void): void {
	transaction(() => {
		const world = getWorld(id);
		if (world.revision !== revision) throw new Error('세계관이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
		operation(world);
		world.definition = validateDefinition(world.definition);
		world.state = validateState(world.state, world.definition);
		store().prepare('UPDATE theater_worlds SET definition_json = ?, state_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
			.run(JSON.stringify(world.definition), JSON.stringify(world.state), id, revision);
	});
}

export function saveDefinition(id: string, revision: number, input: unknown): void {
	const definition = validateDefinition(input);
	editWorld(id, revision, (world) => { world.definition = definition; });
}

export function addScene(id: string, revision: number, name: string, description: string, exits: string[]): void {
	editWorld(id, revision, (world) => {
		const sceneId = randomUUID();
		world.definition.scenes.push({ id: sceneId, name, description, exits });
	});
}

export function editScene(id: string, revision: number, sceneId: string, input: { name: string; description: string; exits: string[] }): void {
	editWorld(id, revision, (world) => {
		const scene = world.definition.scenes.find((scene) => scene.id === sceneId);
		if (!scene) throw new Error('씬을 찾을 수 없습니다.');
		// Existing exits may be one-way. Editing this scene must preserve the other scenes' exits.
		Object.assign(scene, input);
	});
}

export function addTemplate(id: string, revision: number, input: unknown): void {
	editWorld(id, revision, (world) => { world.definition.templates.push({ ...record(input, '원형'), id: randomUUID() } as unknown as WorldDefinition['templates'][number]); });
}

export function editTemplate(id: string, revision: number, templateId: string, input: Record<string, unknown>): void {
	editWorld(id, revision, (world) => {
		const template = world.definition.templates.find((template) => template.id === templateId);
		if (!template) throw new Error('캐릭터·사물 설정을 찾을 수 없습니다.');
		const { name, description, personality, goals, initialState, interactions, reactions } = input;
		Object.assign(template, { name, description, personality, goals, initialState });
		if (interactions !== undefined) template.interactions = interactions as typeof template.interactions;
		if (reactions !== undefined) template.reactions = reactions as typeof template.reactions;
		for (const key of ['baseAppearance', 'clothingPreferences', 'foodPreferences', 'wardrobe'] as const) {
			if (Object.hasOwn(input, key)) Object.assign(template, { [key]: input[key] });
		}
	});
}

export function spawnInstance(id: string, revision: number, templateId: string, sceneId: string, name: string, companion: boolean, presentation: { appearance?: string; playerContext?: string } = {}): void {
	editWorld(id, revision, (world) => {
		const template = world.definition.templates.find((candidate) => candidate.id === templateId);
		if (!template) throw new Error('원형을 찾을 수 없습니다.');
		if (companion && sceneId !== world.state.activeSceneId) throw new Error('동행은 플레이어가 있는 씬에 배치해 주세요.');
		const instance = { id: randomUUID(), templateId, sceneId, name: name.trim() || template.name, companion, ...presentation, state: { ...template.initialState } };
		world.definition.spawns.push({ ...instance, sceneId: companion ? world.definition.startingSceneId : sceneId });
		world.state.instances.push({ ...instance, active: true, memories: [], relationships: {}, reflectedThroughEventId: null });
	});
}

export function editInstance(id: string, revision: number, instanceId: string, input: { name: string; sceneId: string; companion: boolean; state: unknown; relationships?: unknown; appearance?: string; playerContext?: string }): void {
	editWorld(id, revision, (world) => {
		const instance = world.state.instances.find((candidate) => candidate.id === instanceId);
		if (!instance) throw new Error('인스턴스를 찾을 수 없습니다.');
		if (input.companion && (templateFor(world, instance).kind !== 'character' || input.sceneId !== world.state.activeSceneId)) throw new Error('현재 씬에 있는 캐릭터만 동행할 수 있습니다.');
		const { relationships, ...fields } = input;
		const appearanceChanged = input.appearance !== undefined && input.appearance !== instance.appearance;
		Object.assign(instance, { ...fields, state: record(input.state, '상태') });
		if (appearanceChanged) instance.appearanceSelection = { day: world.state.day, minute: world.state.minute, sceneId: instance.sceneId, outfitId: null, model: 'manual' };
		if (relationships !== undefined) instance.relationships = checkedRelationships(relationships);
	});
}

export function editInitialInstance(id: string, revision: number, instanceId: string, input: { name: string; sceneId: string; companion: boolean; state: unknown; appearance?: string; playerContext?: string }): void {
	editWorld(id, revision, (world) => {
		const spawn = world.definition.spawns.find((spawn) => spawn.id === instanceId);
		if (!spawn) throw new Error('처음 배치 설정을 찾을 수 없습니다.');
		Object.assign(spawn, { ...input, state: record(input.state, '초기 상태') });
	});
}

export function editRelationship(id: string, revision: number, instanceId: string, scope: 'current' | 'initial', targetId: string, scores: RelationshipScores | null, impression: string): void {
	editWorld(id, revision, (world) => {
		const instances = scope === 'initial' ? world.definition.spawns : world.state.instances;
		const instance = instances.find((instance) => instance.id === instanceId);
		if (!instance || world.definition.templates.find((template) => template.id === instance.templateId)?.kind !== 'character') throw new Error('관계를 편집할 캐릭터를 찾을 수 없습니다.');
		const target = instances.find((instance) => instance.id === targetId);
		if (targetId === instanceId || (targetId !== 'player' && (!target || world.definition.templates.find((template) => template.id === target.templateId)?.kind !== 'character'))) throw new Error('다른 캐릭터 또는 플레이어를 선택해 주세요.');
		const relationships = { ...(instance.relationships ?? {}) };
		if (scores === null) delete relationships[targetId];
		else relationships[targetId] = { ...scores, impression, evidenceEventIds: scope === 'current' ? [...(relationships[targetId]?.evidenceEventIds ?? [])] : [] };
		instance.relationships = checkedRelationships(relationships);
	});
}

function checkedSlot(slot: number): void { if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('저장 슬롯은 1~3입니다.'); }
export function saveWorld(id: string, slot: number): void {
	checkedSlot(slot);
	const world = getWorld(id);
	store().prepare('INSERT INTO theater_saves VALUES (?, ?, ?, ?) ON CONFLICT(world_id, slot) DO UPDATE SET saved_at = excluded.saved_at, snapshot_json = excluded.snapshot_json')
		.run(id, slot, new Date().toISOString(), JSON.stringify({ definition: world.definition, state: world.state }));
}
export function loadWorld(id: string, revision: number, slot: number): void {
	checkedSlot(slot);
	const save = store().prepare('SELECT snapshot_json FROM theater_saves WHERE world_id = ? AND slot = ?').get(id, slot) as Row | undefined;
	if (!save) throw new Error('비어 있는 슬롯입니다.');
	const snapshot = record(JSON.parse(String(save.snapshot_json)), '슬롯');
	editWorld(id, revision, (world) => {
		world.definition = validateDefinition(snapshot.definition);
		world.state = validateState(snapshot.state, world.definition);
	});
}
export function resetWorld(id: string, revision: number): void {
	editWorld(id, revision, (world) => { world.state = initialState(world.definition); });
}

export function exportWorld(id: string): string {
	const world = getWorld(id);
	const saves = (store().prepare('SELECT * FROM theater_saves WHERE world_id = ? ORDER BY slot').all(id) as Row[])
		.map((row) => ({ slot: Number(row.slot), savedAt: String(row.saved_at), world: JSON.parse(String(row.snapshot_json)) }));
	return JSON.stringify({ format: 'newera-theater', version: 2, world: { definition: world.definition, state: world.state }, saves }, null, 2);
}

export function importWorld(raw: string, replace?: { worldId: string; revision: number }): string {
	if (Buffer.byteLength(raw, 'utf8') > 100000000) throw new Error('세계관 파일은 100MB 이하여야 합니다.');
	const bundle = record(JSON.parse(raw), '세계관 파일');
	if (bundle.format !== 'newera-theater' || bundle.version !== 2) throw new Error('씬 기반 세계관(version 2)만 가져올 수 있습니다.');
	const source = record(bundle.world, 'world');
	const definition = validateDefinition(source.definition);
	const state = source.state === undefined ? initialState(definition) : validateState(source.state, definition);
	if (!Array.isArray(bundle.saves) || bundle.saves.length > 3) throw new Error('저장 슬롯은 최대 3개입니다.');
	const saves = bundle.saves.map((entry) => {
		const save = record(entry, '슬롯');
		const slot = Number(save.slot);
		checkedSlot(slot);
		const previous = record(save.world, '슬롯 세계관');
		const savedDefinition = validateDefinition(previous.definition);
		return { slot, savedAt: text(save.savedAt, 'savedAt', 100), world: { definition: savedDefinition, state: validateState(previous.state, savedDefinition) } };
	});
	if (new Set(saves.map((save) => save.slot)).size !== saves.length) throw new Error('저장 슬롯이 중복됩니다.');
	return transaction(() => {
		let id;
		if (replace) {
			const previous = getWorld(replace.worldId);
			if (previous.revision !== replace.revision) throw new Error('세계관이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
			id = previous.id;
			clearWorldHistory(id);
			store().prepare('UPDATE theater_worlds SET definition_json = ?, state_json = ?, model_settings_json = NULL, revision = revision + 1 WHERE id = ?')
				.run(JSON.stringify(definition), JSON.stringify(state), id);
		} else id = insertWorld(definition, state);
		for (const save of saves) store().prepare('INSERT INTO theater_saves VALUES (?, ?, ?, ?)').run(id, save.slot, save.savedAt, JSON.stringify(save.world));
		setActive(id);
		return id;
	});
}

function jobFromRow(row: Row): GenerationJob {
	return { id: String(row.id), worldId: String(row.world_id), revision: Number(row.revision), status: row.status as GenerationJob['status'], request: JSON.parse(String(row.request_json)), createdAt: String(row.created_at), error: row.error === null ? null : String(row.error), progress: restoredProgress(row.progress_json ? JSON.parse(String(row.progress_json)) : null), models: row.models_json ? checkedModelSelection(JSON.parse(String(row.models_json))) : null };
}
export function getJob(id: string): GenerationJob | null {
	const row = store().prepare('SELECT * FROM theater_jobs WHERE id = ?').get(id) as Row | undefined;
	return row ? jobFromRow(row) : null;
}
/** Credentials are worker-only; jobFromRow deliberately excludes this column from all public data. */
export function getJobProviders(id: string): ProviderSnapshot | null {
	const row = store().prepare('SELECT providers_json FROM theater_jobs WHERE id = ?').get(id) as Row | undefined;
	return row?.providers_json ? checkedProviderSnapshot(JSON.parse(String(row.providers_json))) : null;
}
export function pinJobProviders(job: GenerationJob, workerId: string, snapshot: ProviderSnapshot): ProviderSnapshot {
	checkJob(job, workerId);
	store().prepare("UPDATE theater_jobs SET providers_json = ? WHERE id = ? AND worker_id = ? AND status = 'running' AND providers_json IS NULL").run(JSON.stringify(snapshot), job.id, workerId);
	return getJobProviders(job.id)!;
}
export function latestJob(worldId: string): GenerationJob | null {
	const row = store().prepare('SELECT * FROM theater_jobs WHERE world_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(worldId) as Row | undefined;
	return row ? jobFromRow(row) : null;
}
export function retryFailedJob(worldId: string, revision: number, jobId: string, defaults: ModelSelection, providers: (selection: ModelSelection) => ProviderSnapshot): GenerationJob {
	return transaction(() => {
		const world = getWorld(worldId);
		const job = latestJob(worldId);
		if (!job || job.id !== jobId || job.status !== 'failed') throw new Error('재시도할 실패 작업이 없습니다. 진행 상태를 새로고침해 주세요.');
		if (world.revision !== revision || job.revision !== world.revision) throw new Error('실패 이후 장면이 변경되어 이어서 재시도할 수 없습니다.');
		const models = checkedModelSelection(world.models ?? defaults);
		const routes = providers(models);
		// Keep the request, committed cursor and queued chat; manual retry adopts the current model routes atomically.
		store().prepare("UPDATE theater_jobs SET status = 'pending', worker_id = NULL, heartbeat_at = NULL, completed_at = NULL, error = NULL, models_json = ?, providers_json = ? WHERE id = ? AND status = 'failed'")
			.run(JSON.stringify(models), JSON.stringify(routes), job.id);
		return getJob(job.id)!;
	});
}
export function stopJob(worldId: string, jobId: string): void {
	transaction(() => {
		const job = latestJob(worldId);
		if (!job || job.id !== jobId || !['pending', 'running'].includes(job.status)) throw new Error('중단할 진행 중인 작업이 없습니다.');
		// Clear ownership first so even a response arriving before the next heartbeat cannot commit.
		store().prepare("UPDATE theater_jobs SET status = 'failed', worker_id = NULL, error = ?, completed_at = ? WHERE id = ?")
			.run('사용자가 자동 생성을 중단했습니다.', new Date().toISOString(), job.id);
	});
}
export function enqueue(worldId: string, revision: number, request: PlayerRequest, defaults: ModelSelection, providers?: (selection: ModelSelection) => ProviderSnapshot): GenerationJob {
	return transaction(() => {
		const world = getWorld(worldId);
		const active = store().prepare("SELECT * FROM theater_jobs WHERE world_id = ? AND status IN ('pending', 'running')").get(worldId) as Row | undefined;
		if (active) {
			// Chat may arrive during inference with the revision rendered before its latest commit.
			if (Number(active.revision) !== world.revision) throw new Error('장면이 변경되었습니다. 진행 상태를 새로고침해 주세요.');
			if (request.kind !== 'speak') throw new Error('진행 중에는 채팅으로 말을 걸어 주세요.');
			actionForRequest(world, request);
			const inputs: PlayerRequest[] = active.inputs_json ? JSON.parse(String(active.inputs_json)) : [];
			inputs.push(request);
			store().prepare('UPDATE theater_jobs SET inputs_json = ? WHERE id = ?').run(JSON.stringify(inputs), String(active.id));
			return jobFromRow(active);
		}
		if (world.revision !== revision) throw new Error('장면이 변경되었습니다. 다시 시도해 주세요.');
		actionForRequest(world, request);
		const id = randomUUID();
		const models = checkedModelSelection(world.models ?? defaults);
		const routes = providers?.(models);
		store().prepare("INSERT INTO theater_jobs (id, world_id, revision, request_json, status, created_at, models_json, providers_json) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
			.run(id, worldId, revision, JSON.stringify(request), new Date().toISOString(), JSON.stringify(models), routes ? JSON.stringify(routes) : null);
		return getJob(id)!;
	});
}
export function nextJobInput(job: GenerationJob, workerId: string, consumedInputs: number): PlayerRequest | null {
	checkJob(job, workerId);
	const row = store().prepare('SELECT inputs_json FROM theater_jobs WHERE id = ?').get(job.id) as Row;
	const inputs: PlayerRequest[] = row.inputs_json ? JSON.parse(String(row.inputs_json)) : [];
	return inputs[consumedInputs] ?? null;
}
export function runnableJobs(staleBefore: string): string[] {
	return (store().prepare("SELECT id FROM theater_jobs WHERE status = 'pending' OR (status = 'running' AND heartbeat_at < ?) ORDER BY created_at").all(staleBefore) as Row[]).map((row) => String(row.id));
}
export function claimJob(id: string, workerId: string, staleBefore: string): GenerationJob | null {
	const changed = store().prepare("UPDATE theater_jobs SET status = 'running', worker_id = ?, heartbeat_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'running' AND heartbeat_at < ?))")
		.run(workerId, new Date().toISOString(), id, staleBefore);
	return Number(changed.changes) === 1 ? getJob(id) : null;
}
export function checkJob(job: GenerationJob, workerId: string): void {
	const row = store().prepare('SELECT status, worker_id, revision FROM theater_jobs WHERE id = ?').get(job.id) as Row | undefined;
	if (!row || row.status !== 'running' || row.worker_id !== workerId) throw new Error('생성 작업의 실행 권한을 잃었습니다.');
	if (Number(row.revision) !== job.revision || getWorld(job.worldId).revision !== job.revision) throw new Error('생성 중 세계관이 변경되어 이전 결과를 폐기했습니다.');
}
export function heartbeatJob(id: string, workerId: string): void {
	store().prepare("UPDATE theater_jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?").run(new Date().toISOString(), id, workerId);
}
export function saveJobProgress(job: GenerationJob, workerId: string, world: World, progress: TurnProgress): void {
	transaction(() => {
		checkJob(job, workerId);
		if (world.id !== job.worldId || world.revision !== job.revision) throw new Error('생성 결과의 세계관이 일치하지 않습니다.');
		const state = validateState(world.state, world.definition);
		store().prepare('UPDATE theater_worlds SET state_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(JSON.stringify(state), job.worldId, job.revision);
		store().prepare('UPDATE theater_jobs SET revision = ?, progress_json = ?, heartbeat_at = ? WHERE id = ? AND worker_id = ?')
			.run(job.revision + 1, JSON.stringify(progress), new Date().toISOString(), job.id, workerId);
	});
	// Publish the new in-process revision only after the state and resume cursor are both durable.
	job.revision += 1;
	job.progress = structuredClone(progress);
	world.revision = job.revision;
}
export function finishJob(job: GenerationJob, workerId: string): boolean {
	return transaction(() => {
		checkJob(job, workerId);
		if (!job.progress || job.progress.pendingActorIds.length) throw new Error('아직 처리하지 않은 반응이 있습니다.');
		if (nextJobInput(job, workerId, job.progress.consumedInputs)) return false;
		store().prepare("UPDATE theater_jobs SET status = 'completed', completed_at = ? WHERE id = ? AND worker_id = ?").run(new Date().toISOString(), job.id, workerId);
		return true;
	});
}
export function failJob(id: string, workerId: string, error: string): void {
	store().prepare("UPDATE theater_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'")
		.run(error.slice(0, 1000), new Date().toISOString(), id, workerId);
}
export function getStageView(): StageView {
	const world = getWorld();
	const saves = (store().prepare('SELECT slot, saved_at, snapshot_json FROM theater_saves WHERE world_id = ? ORDER BY slot').all(world.id) as Row[])
		.map((row): SaveSlot => ({ slot: Number(row.slot), savedAt: String(row.saved_at), tick: Number(JSON.parse(String(row.snapshot_json)).state.tick) }));
	return { world, worlds: listWorlds(), generation: latestJob(world.id), saves };
}
