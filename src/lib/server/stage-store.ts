import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exampleWorld } from '$lib/theater/fixtures';
import { convertLegacy } from '$lib/theater/legacy';
import { actionForRequest, initialState, templateFor } from '$lib/theater/runtime';
import type { GenerationJob, PlayerRequest, SaveSlot, StageView, World, WorldDefinition, WorldSummary } from '$lib/theater/types';
import { record, text, validateDefinition, validateState } from '$lib/theater/validation';

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
			state_json TEXT NOT NULL, legacy_json TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS theater_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS theater_saves (
			world_id TEXT NOT NULL REFERENCES theater_worlds(id), slot INTEGER NOT NULL,
			saved_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(world_id, slot)
		);
		CREATE TABLE IF NOT EXISTS theater_jobs (
			id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES theater_worlds(id), revision INTEGER NOT NULL,
			request_json TEXT NOT NULL, status TEXT NOT NULL, worker_id TEXT, heartbeat_at TEXT,
			created_at TEXT NOT NULL, completed_at TEXT, error TEXT
		);
		CREATE UNIQUE INDEX IF NOT EXISTS theater_jobs_active ON theater_jobs(world_id) WHERE status IN ('pending', 'running');
		CREATE INDEX IF NOT EXISTS theater_jobs_recent ON theater_jobs(world_id, created_at DESC);`);
	database = db;
	try {
		transaction(() => {
			if (!db.prepare("SELECT value FROM theater_meta WHERE key = 'migrated'").get()) {
				migrateLegacy(db);
				db.prepare("INSERT INTO theater_meta VALUES ('migrated', '1')").run();
			}
			if (!db.prepare('SELECT id FROM theater_worlds LIMIT 1').get()) insertWorld(exampleWorld());
			if (!db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get()) {
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
	return { id: String(row.id), revision: Number(row.revision), definition: JSON.parse(String(row.definition_json)), state: JSON.parse(String(row.state_json)) };
}
export function listWorlds(): WorldSummary[] {
	return (store().prepare('SELECT id, revision, definition_json FROM theater_worlds ORDER BY created_at, rowid').all() as Row[])
		.map((row) => ({ id: String(row.id), revision: Number(row.revision), name: String(JSON.parse(String(row.definition_json)).name) }));
}

function insertWorld(definition: WorldDefinition, state = initialState(definition), id: string = randomUUID(), legacy: unknown = null): string {
	store().prepare('INSERT INTO theater_worlds VALUES (?, 0, ?, ?, ?, ?)').run(id, JSON.stringify(definition), JSON.stringify(state), legacy === null ? null : JSON.stringify(legacy), new Date().toISOString());
	return id;
}

function migrateLegacy(db: DatabaseSync): void {
	const has = (name: string) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
	if (!has('world_state')) return;
	const capture = () => Object.fromEntries(['world_state', 'scenario_config', 'characters', 'character_templates', 'events', 'memories', 'modules'].map((table) => [
		({ world_state: 'world', scenario_config: 'config', character_templates: 'characterTemplates' } as Record<string, string>)[table] || table,
		has(table) ? db.prepare(`SELECT * FROM ${table}`).all() : []
	]));
	const active = has('lore_meta') ? String((db.prepare('SELECT active_lore_id FROM lore_meta WHERE id = 1').get() as Row | undefined)?.active_lore_id ?? '') : '';
	const lores = has('lores') ? db.prepare('SELECT * FROM lores ORDER BY created_at, rowid').all() as Row[] : [];
	if (!lores.length) {
		const snapshot = capture();
		if (!(snapshot.world as unknown[]).length) return;
		const converted = convertLegacy('이전 이야기', snapshot);
		insertWorld(converted.definition, converted.state, randomUUID(), snapshot);
		return;
	}
	for (const lore of lores) {
		const snapshot = String(lore.id) === active || lore.state_json === null ? capture() : JSON.parse(String(lore.state_json));
		const converted = convertLegacy(String(lore.title), snapshot);
		const id = `legacy-${lore.id}`;
		insertWorld(converted.definition, converted.state, id, snapshot);
		if (String(lore.id) === active) setActive(id);
		if (has('lore_save_slots')) {
			for (const save of db.prepare('SELECT * FROM lore_save_slots WHERE lore_id = ?').all(String(lore.id)) as Row[]) {
				const previous = convertLegacy(String(lore.title), JSON.parse(String(save.snapshot_json)));
				db.prepare('INSERT INTO theater_saves VALUES (?, ?, ?, ?)').run(id, Number(save.slot), String(save.saved_at), JSON.stringify(previous));
			}
		}
	}
}

export function createWorld(name: string, description: string): string {
	const definition = validateDefinition({ name, description, rules: '', startingSceneId: 'opening', scenes: [{ id: 'opening', name: '첫 장면', description: '이야기가 시작되는 곳.', exits: [] }], templates: [], spawns: [] });
	return transaction(() => { const id = insertWorld(definition); setActive(id); return id; });
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
		for (const scene of world.definition.scenes) if (exits.includes(scene.id)) scene.exits.push(sceneId);
	});
}

export function addTemplate(id: string, revision: number, input: unknown): void {
	editWorld(id, revision, (world) => { world.definition.templates.push({ ...record(input, '원형'), id: randomUUID() } as unknown as WorldDefinition['templates'][number]); });
}

export function spawnInstance(id: string, revision: number, templateId: string, sceneId: string, name: string, companion: boolean): void {
	editWorld(id, revision, (world) => {
		const template = world.definition.templates.find((candidate) => candidate.id === templateId);
		if (!template) throw new Error('원형을 찾을 수 없습니다.');
		if (companion && sceneId !== world.state.activeSceneId) throw new Error('동행은 플레이어가 있는 씬에 배치해 주세요.');
		const instance = { id: randomUUID(), templateId, sceneId, name: name.trim() || template.name, companion, state: { ...template.initialState } };
		world.definition.spawns.push({ ...instance, sceneId: companion ? world.definition.startingSceneId : sceneId });
		world.state.instances.push({ ...instance, active: true, memories: [] });
	});
}

export function editInstance(id: string, revision: number, instanceId: string, input: { name: string; sceneId: string; companion: boolean; state: unknown }): void {
	editWorld(id, revision, (world) => {
		const instance = world.state.instances.find((candidate) => candidate.id === instanceId);
		if (!instance) throw new Error('인스턴스를 찾을 수 없습니다.');
		if (input.companion && (templateFor(world, instance).kind !== 'character' || input.sceneId !== world.state.activeSceneId)) throw new Error('현재 씬에 있는 캐릭터만 동행할 수 있습니다.');
		Object.assign(instance, { ...input, state: record(input.state, '상태') });
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
	const legacy = (store().prepare('SELECT legacy_json FROM theater_worlds WHERE id = ?').get(id) as Row).legacy_json;
	const saves = (store().prepare('SELECT * FROM theater_saves WHERE world_id = ? ORDER BY slot').all(id) as Row[])
		.map((row) => ({ slot: Number(row.slot), savedAt: String(row.saved_at), world: JSON.parse(String(row.snapshot_json)) }));
	return JSON.stringify({ format: 'newera-theater', version: 2, world: { definition: world.definition, state: world.state }, saves, legacyArchive: legacy ? JSON.parse(String(legacy)) : null }, null, 2);
}

export function importWorld(raw: string): string {
	if (Buffer.byteLength(raw, 'utf8') > 100000000) throw new Error('세계관 파일은 100MB 이하여야 합니다.');
	const bundle = record(JSON.parse(raw), '세계관 파일');
	const legacy = bundle.format === 'newera-lore' && bundle.version === 1;
	if (!legacy && (bundle.format !== 'newera-theater' || bundle.version !== 2)) throw new Error('지원하지 않는 세계관 파일입니다.');
	const source = legacy ? convertLegacy(text(bundle.title, '세계관 이름', 200), bundle.state) : record(bundle.world, 'world');
	const definition = validateDefinition(source.definition);
	const state = source.state === undefined ? initialState(definition) : validateState(source.state, definition);
	if (!Array.isArray(bundle.saves) || bundle.saves.length > 3) throw new Error('저장 슬롯은 최대 3개입니다.');
	const saves = bundle.saves.map((entry) => {
		const save = record(entry, '슬롯');
		const slot = Number(save.slot);
		checkedSlot(slot);
		const previous = legacy ? convertLegacy(definition.name, save.state) : record(save.world, '슬롯 세계관');
		const savedDefinition = validateDefinition(previous.definition);
		return { slot, savedAt: text(save.savedAt, 'savedAt', 100), world: { definition: savedDefinition, state: validateState(previous.state, savedDefinition) } };
	});
	if (new Set(saves.map((save) => save.slot)).size !== saves.length) throw new Error('저장 슬롯이 중복됩니다.');
	return transaction(() => {
		const id = insertWorld(definition, state, randomUUID(), legacy ? bundle : bundle.legacyArchive ?? null);
		for (const save of saves) store().prepare('INSERT INTO theater_saves VALUES (?, ?, ?, ?)').run(id, save.slot, save.savedAt, JSON.stringify(save.world));
		setActive(id);
		return id;
	});
}

function jobFromRow(row: Row): GenerationJob {
	return { id: String(row.id), worldId: String(row.world_id), revision: Number(row.revision), status: row.status as GenerationJob['status'], request: JSON.parse(String(row.request_json)), createdAt: String(row.created_at), error: row.error === null ? null : String(row.error) };
}
export function getJob(id: string): GenerationJob | null {
	const row = store().prepare('SELECT * FROM theater_jobs WHERE id = ?').get(id) as Row | undefined;
	return row ? jobFromRow(row) : null;
}
export function latestJob(worldId: string): GenerationJob | null {
	const row = store().prepare('SELECT * FROM theater_jobs WHERE world_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(worldId) as Row | undefined;
	return row ? jobFromRow(row) : null;
}
export function enqueue(worldId: string, revision: number, request: PlayerRequest): GenerationJob {
	return transaction(() => {
		const world = getWorld(worldId);
		if (world.revision !== revision) throw new Error('장면이 변경되었습니다. 다시 시도해 주세요.');
		actionForRequest(world, request);
		if (store().prepare("SELECT id FROM theater_jobs WHERE world_id = ? AND status IN ('pending', 'running')").get(worldId)) throw new Error('이 세계관의 장면을 이미 진행하고 있습니다.');
		const id = randomUUID();
		store().prepare("INSERT INTO theater_jobs (id, world_id, revision, request_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
			.run(id, worldId, revision, JSON.stringify(request), new Date().toISOString());
		return getJob(id)!;
	});
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
	const row = store().prepare('SELECT status, worker_id FROM theater_jobs WHERE id = ?').get(job.id) as Row | undefined;
	if (!row || row.status !== 'running' || row.worker_id !== workerId) throw new Error('생성 작업의 실행 권한을 잃었습니다.');
	if (getWorld(job.worldId).revision !== job.revision) throw new Error('생성 중 세계관이 변경되어 이전 결과를 폐기했습니다.');
}
export function heartbeatJob(id: string, workerId: string): void {
	store().prepare("UPDATE theater_jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?").run(new Date().toISOString(), id, workerId);
}
export function finishJob(job: GenerationJob, workerId: string, world: World): void {
	transaction(() => {
		checkJob(job, workerId);
		if (world.id !== job.worldId || world.revision !== job.revision) throw new Error('생성 결과의 세계관이 일치하지 않습니다.');
		const state = validateState(world.state, world.definition);
		store().prepare('UPDATE theater_worlds SET state_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(JSON.stringify(state), job.worldId, job.revision);
		store().prepare("UPDATE theater_jobs SET status = 'completed', completed_at = ? WHERE id = ? AND worker_id = ?").run(new Date().toISOString(), job.id, workerId);
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
