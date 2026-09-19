import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_ABL, DEFAULT_ACTION_REQUIREMENTS, DEFAULT_EXP, DEFAULT_PALAM, DEFAULT_RELATION, DEFAULT_TALENT, clampBase, normalizeAbl, normalizeActionRequirements, normalizeExp, normalizeMarks, normalizePalam, normalizeRelations, normalizeTalent } from '$lib/game/types';
import type {
	Character,
	CharacterLore,
	EventRecord,
	GameView,
	InstalledModule,
	LoreSummary,
	MemoryRecord,
	ScenarioConfig,
	SaveSlot,
	WorldLore,
	WorldState
} from '$lib/game/types';
import { parseModuleManifest, type ModuleManifest } from './modules';

let database: DatabaseSync | undefined;

type Row = Record<string, unknown>;

function rows(sql: string, ...params: Array<string | number>): Row[] {
	return getDb().prepare(sql).all(...params) as Row[];
}

function one(sql: string, ...params: Array<string | number>): Row | undefined {
	return getDb().prepare(sql).get(...params) as Row | undefined;
}

function parse<T>(value: unknown): T {
	return JSON.parse(String(value)) as T;
}

function characterFromRow(row: Row): Character {
	return {
		id: String(row.id),
		moduleId: row.module_id ? String(row.module_id) : null,
		name: String(row.name),
		age: Number(row.age),
		portrait: String(row.portrait),
		introduction: String(row.introduction),
		profile: String(row.profile ?? row.introduction),
		base: clampBase(parse(row.base_json)),
		trait: parse(row.trait_json),
		talent: normalizeTalent(row.talent_json ? parse(row.talent_json) : null),
		abl: normalizeAbl(parse(row.abl_json)),
		exp: normalizeExp(parse(row.exp_json)),
		mark: normalizeMarks(parse(row.mark_json)),
		relations: normalizeRelations(parse(row.relation_json)),
		palam: normalizePalam(parse(row.palam_json)),
		actionRequirements: normalizeActionRequirements(row.action_requirements_json ? parse(row.action_requirements_json) : undefined)
	};
}

function migrateCharacterRow(row: Row): Row {
	const character = characterFromRow(row);
	return {
		...row,
		base_json: JSON.stringify(character.base),
		talent_json: JSON.stringify(character.talent),
		abl_json: JSON.stringify(character.abl),
		exp_json: JSON.stringify(character.exp),
		mark_json: JSON.stringify(character.mark),
		relation_json: JSON.stringify(character.relations),
		palam_json: JSON.stringify(character.palam),
		action_requirements_json: JSON.stringify(character.actionRequirements)
	};
}

function migrateStoredManifest(manifest: ModuleManifest): ModuleManifest {
	return { ...manifest, characters: manifest.characters.map((character) => {
		const legacy = character as Character & { relation?: unknown };
		const { relation: oldRelation, ...rest } = legacy;
		return {
			...rest,
			base: clampBase(character.base ?? { energy: 20, maxEnergy: 20 }),
			talent: normalizeTalent(character.talent),
			abl: normalizeAbl(character.abl),
			exp: normalizeExp(character.exp),
			mark: normalizeMarks(character.mark),
			relations: normalizeRelations(character.relations ?? oldRelation),
			palam: normalizePalam(character.palam),
			actionRequirements: normalizeActionRequirements(character.actionRequirements)
		};
	}) };
}

function eventFromRow(row: Row): EventRecord {
	return {
		id: Number(row.id),
		turn: Number(row.turn),
		day: Number(row.day),
		minute: Number(row.minute),
		location: String(row.location),
		actionId: String(row.action_id) as EventRecord['actionId'],
		characterId: row.character_id === null ? null : String(row.character_id),
		summary: String(row.summary),
		source: parse(row.source_json),
		changes: parse(row.changes_json),
		narrative: String(row.narrative),
		renderer: String(row.renderer) as EventRecord['renderer'],
		semanticEvent: row.semantic_json ? parse(row.semantic_json) : null,
		stateChanges: row.state_changes_json ? parse(row.state_changes_json) : []
	};
}

function cleanMemorySummary(row: Row): string {
	const rawSummary = String(row.summary);
	const eventSummary = row.event_summary ? String(row.event_summary) : null;
	return eventSummary && (rawSummary === eventSummary || rawSummary.startsWith(`${eventSummary} `))
		? eventSummary
		: rawSummary;
}

function isDetailedMemory(row: Row): boolean {
	return cleanMemorySummary(row) !== String(row.event_summary ?? '');
}

function memoryFromRow(row: Row): MemoryRecord {
	return {
		id: Number(row.id),
		eventId: Number(row.event_id),
		characterId: String(row.character_id),
		summary: cleanMemorySummary(row),
		isDetail: isDetailedMemory(row),
		createdTurn: Number(row.created_turn),
		embedding: row.embedding_json ? parse(row.embedding_json) : null,
		embeddingModel: row.embedding_model ? String(row.embedding_model) : null
	};
}

export function getDb(): DatabaseSync {
	if (database) return database;
	const dataDirectory = process.env.NEWERA_DATA_DIR || join(process.cwd(), 'data');
	mkdirSync(dataDirectory, { recursive: true });
	const db = new DatabaseSync(join(dataDirectory, 'newera.sqlite'), { timeout: 5000 });
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
	db.exec(`
		CREATE TABLE IF NOT EXISTS world_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			turn INTEGER NOT NULL,
			day INTEGER NOT NULL,
			minute INTEGER NOT NULL,
			location TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS characters (
			id TEXT PRIMARY KEY,
			module_id TEXT,
			sort_order INTEGER NOT NULL,
			name TEXT NOT NULL,
			age INTEGER NOT NULL,
			portrait TEXT NOT NULL,
			introduction TEXT NOT NULL,
			profile TEXT NOT NULL DEFAULT '',
			base_json TEXT NOT NULL,
			trait_json TEXT NOT NULL,
			talent_json TEXT NOT NULL DEFAULT '{"pride":50,"openness":50,"empathy":50,"assertiveness":50}',
			abl_json TEXT NOT NULL,
			exp_json TEXT NOT NULL,
			mark_json TEXT NOT NULL,
			relation_json TEXT NOT NULL,
			palam_json TEXT NOT NULL,
			action_requirements_json TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS character_templates (
			id TEXT PRIMARY KEY,
			sort_order INTEGER NOT NULL,
			character_json TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			turn INTEGER NOT NULL,
			day INTEGER NOT NULL,
			minute INTEGER NOT NULL,
			location TEXT NOT NULL,
			action_id TEXT NOT NULL,
			character_id TEXT REFERENCES characters(id),
			summary TEXT NOT NULL,
			source_json TEXT NOT NULL,
			changes_json TEXT NOT NULL,
			narrative TEXT NOT NULL,
			renderer TEXT NOT NULL,
			semantic_json TEXT,
			state_changes_json TEXT
		);
		CREATE TABLE IF NOT EXISTS memories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
			character_id TEXT NOT NULL REFERENCES characters(id),
			summary TEXT NOT NULL,
			created_turn INTEGER NOT NULL,
			embedding_json TEXT,
			embedding_model TEXT
		);
		CREATE INDEX IF NOT EXISTS memories_by_character ON memories(character_id, created_turn DESC);
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
			summary,
			content='memories',
			content_rowid='id',
			tokenize='trigram'
		);
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memory_fts(rowid, summary) VALUES (new.id, new.summary);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memory_fts(memory_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF summary ON memories BEGIN
			INSERT INTO memory_fts(memory_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
			INSERT INTO memory_fts(rowid, summary) VALUES (new.id, new.summary);
		END;
		CREATE TABLE IF NOT EXISTS save_slots (
			slot INTEGER PRIMARY KEY,
			saved_at TEXT NOT NULL,
			turn INTEGER NOT NULL,
			snapshot_json TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS lores (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			state_json TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS lore_meta (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			active_lore_id TEXT NOT NULL REFERENCES lores(id)
		);
		CREATE TABLE IF NOT EXISTS lore_save_slots (
			lore_id TEXT NOT NULL REFERENCES lores(id),
			slot INTEGER NOT NULL,
			saved_at TEXT NOT NULL,
			turn INTEGER NOT NULL,
			snapshot_json TEXT NOT NULL,
			PRIMARY KEY (lore_id, slot)
		);
		CREATE TABLE IF NOT EXISTS modules (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			version TEXT NOT NULL,
			manifest_json TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE IF NOT EXISTS scenario_config (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			world_setting TEXT NOT NULL,
			era_rules TEXT NOT NULL,
			world_memory TEXT NOT NULL DEFAULT '',
			scene_note TEXT NOT NULL DEFAULT '',
			pending_proposal_json TEXT,
			player_suggestions_json TEXT
		);
	`);
	const characterColumns = db.prepare('PRAGMA table_info(characters)').all() as Row[];
	if (!characterColumns.some((column) => column.name === 'profile')) {
		db.exec("ALTER TABLE characters ADD COLUMN profile TEXT NOT NULL DEFAULT ''");
		db.exec('UPDATE characters SET profile = introduction WHERE profile = \'\'');
	}
	if (!characterColumns.some((column) => column.name === 'module_id')) {
		db.exec('ALTER TABLE characters ADD COLUMN module_id TEXT');
	}
	if (!characterColumns.some((column) => column.name === 'talent_json')) {
		db.exec('ALTER TABLE characters ADD COLUMN talent_json TEXT NOT NULL DEFAULT \'{"pride":50,"openness":50,"empathy":50,"assertiveness":50}\'');
	}
	if (!characterColumns.some((column) => column.name === 'action_requirements_json')) {
		db.exec('ALTER TABLE characters ADD COLUMN action_requirements_json TEXT');
	}
	const eventColumns = db.prepare('PRAGMA table_info(events)').all() as Row[];
	if (!eventColumns.some((column) => column.name === 'semantic_json')) db.exec('ALTER TABLE events ADD COLUMN semantic_json TEXT');
	if (!eventColumns.some((column) => column.name === 'state_changes_json')) db.exec('ALTER TABLE events ADD COLUMN state_changes_json TEXT');
	const configColumns = db.prepare('PRAGMA table_info(scenario_config)').all() as Row[];
	if (!configColumns.some((column) => column.name === 'world_memory')) {
		db.exec("ALTER TABLE scenario_config ADD COLUMN world_memory TEXT NOT NULL DEFAULT ''");
	}
	if (!configColumns.some((column) => column.name === 'player_suggestions_json')) {
		db.exec('ALTER TABLE scenario_config ADD COLUMN player_suggestions_json TEXT');
	}
	if (!configColumns.some((column) => column.name === 'scene_note')) {
		db.exec("ALTER TABLE scenario_config ADD COLUMN scene_note TEXT NOT NULL DEFAULT ''");
	}
	database = db;
	const hadWorld = Boolean(one('SELECT id FROM world_state WHERE id = 1'));
	if (!hadWorld) seed();
	db.prepare(`INSERT OR IGNORE INTO scenario_config (id, world_setting, era_rules)
		VALUES (1, ?, ?)`).run(
		'현대 서울의 망원동. 성인들이 각자의 일상과 욕망을 지닌 채 같은 동네에서 살아간다.',
		'era의 BASE·TRAIT·ABL·EXP·MARK·RELATION과 SOURCE·PALAM을 따른다. 인물은 자기 사정과 의지로 행동하며 세계는 플레이어가 가만히 있어도 진행된다.'
	);
	if (!one('SELECT id FROM lore_meta WHERE id = 1')) {
		withTransaction(() => {
			const id = randomUUID();
			db.prepare('INSERT INTO lores (id, title, state_json, created_at) VALUES (?, ?, NULL, ?)')
				.run(id, '망원동의 세 사람', new Date().toISOString());
			db.prepare('INSERT INTO lore_meta (id, active_lore_id) VALUES (1, ?)').run(id);
			db.prepare(`INSERT INTO lore_save_slots (lore_id, slot, saved_at, turn, snapshot_json)
				SELECT ?, slot, saved_at, turn, snapshot_json FROM save_slots`).run(id);
		});
	}
	withTransaction(() => {
		for (const row of db.prepare('SELECT id, manifest_json FROM modules').all() as Row[]) {
			const migrated = migrateStoredManifest(parse<ModuleManifest>(row.manifest_json));
			db.prepare('UPDATE modules SET manifest_json = ? WHERE id = ?').run(JSON.stringify(migrated), row.id as string);
		}
		for (const row of db.prepare('SELECT * FROM characters').all() as Row[]) {
			const migrated = migrateCharacterRow(row);
			db.prepare(`UPDATE characters SET base_json = ?, talent_json = ?, abl_json = ?, exp_json = ?, mark_json = ?, relation_json = ?, palam_json = ?, action_requirements_json = ? WHERE id = ?`)
				.run(migrated.base_json as string, migrated.talent_json as string, migrated.abl_json as string,
					migrated.exp_json as string, migrated.mark_json as string, migrated.relation_json as string,
					migrated.palam_json as string, migrated.action_requirements_json as string, row.id as string);
		}
		if (!one('SELECT id FROM character_templates LIMIT 1')) {
			for (const row of db.prepare('SELECT * FROM characters ORDER BY sort_order, id').all() as Row[]) {
				updateCharacterTemplate(characterFromRow(row), Number(row.sort_order));
			}
		}
	});
	return db;
}

function seed(): void {
	const db = getDb();
	withTransaction(() => {
		db.prepare('INSERT INTO world_state VALUES (1, 0, 1, 18 * 60 + 20, ?)').run('서울 · 망원동');
		const characters: Character[] = [
			{
				id: 'seoyeon',
				name: '서연',
				age: 27,
				portrait: '/images/seoyeon.png',
				introduction: '책을 읽다 가끔 창밖을 바라본다.',
				profile: '서연은 망원동의 독립 서점에서 일한다. 말수가 적지만 관찰력이 좋고, 친해진 사람에게는 자기 생각을 솔직하게 털어놓는다.',
				base: { energy: 20, maxEnergy: 20 },
				trait: ['차분함', '섬세함'],
				talent: { ...DEFAULT_TALENT, pride: 45, openness: 65, assertiveness: 40 },
				abl: { ...DEFAULT_ABL, empathy: 2 },
				exp: { ...DEFAULT_EXP, social: 15 },
				mark: [],
				relations: { player: { ...DEFAULT_RELATION, affection: 3, trust: 2 } },
				palam: { ...DEFAULT_PALAM },
				actionRequirements: DEFAULT_ACTION_REQUIREMENTS.map((requirement) => ({ ...requirement }))
			},
			{
				id: 'jieun',
				name: '지은',
				age: 29,
				portrait: '/images/jieun.png',
				introduction: '늦은 시간에도 메모를 정리한다.',
				profile: '지은은 프리랜서 편집자다. 상대의 말보다 행동을 오래 기억하며, 먼저 다가갈 때에도 자신의 기준을 분명히 한다.',
				base: { energy: 18, maxEnergy: 18 },
				trait: ['신중함', '관찰력'],
				talent: { ...DEFAULT_TALENT, pride: 65, openness: 45, assertiveness: 70 },
				abl: { ...DEFAULT_ABL },
				exp: { ...DEFAULT_EXP },
				mark: [],
				relations: { player: { ...DEFAULT_RELATION, affection: 1, trust: 1 } },
				palam: { ...DEFAULT_PALAM },
				actionRequirements: [
					{ actionId: 'flirt', stat: 'relation.trust', minimum: 8 },
					{ actionId: 'kiss', stat: 'relation.affection', minimum: 15 },
					{ actionId: 'kiss', stat: 'relation.trust', minimum: 12 },
					{ actionId: 'kiss', stat: 'relation.desire', minimum: 8 },
					{ actionId: 'intimacy', stat: 'relation.affection', minimum: 30 },
					{ actionId: 'intimacy', stat: 'relation.trust', minimum: 25 },
					{ actionId: 'intimacy', stat: 'relation.desire', minimum: 20 }
				]
			}
		];
		characters.forEach((character, index) => updateCharacter(character, index));
	});
}

export function withTransaction<T>(operation: () => T): T {
	const db = getDb();
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = operation();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function getWorld(): WorldState {
	const row = one('SELECT turn, day, minute, location FROM world_state WHERE id = 1');
	if (!row) throw new Error('월드 상태를 찾을 수 없습니다.');
	return {
		turn: Number(row.turn),
		day: Number(row.day),
		minute: Number(row.minute),
		location: String(row.location)
	};
}

export function updateWorld(world: WorldState): void {
	getDb()
		.prepare('UPDATE world_state SET turn = ?, day = ?, minute = ?, location = ? WHERE id = 1')
		.run(world.turn, world.day, world.minute, world.location);
}

export function getCharacter(id: string): Character | null {
	return getCharacters().find((character) => character.id === id) ?? null;
}

export function getCharacters(): Character[] {
	const activeIds = new Set(getModuleRows().filter((row) => Number(row.enabled) === 1)
		.flatMap((row) => parse<ModuleManifest>(row.manifest_json).characters.map((character) => character.id)));
	return rows('SELECT * FROM characters ORDER BY sort_order, id')
		.filter((row) => !row.module_id || activeIds.has(String(row.id)))
		.map(characterFromRow);
}

function getModuleRows(): Row[] {
	return rows('SELECT * FROM modules ORDER BY name, id').map((row) => ({
		...row, manifest_json: JSON.stringify(migrateStoredManifest(parse<ModuleManifest>(row.manifest_json)))
	}));
}

export function getInstalledModules(): InstalledModule[] {
	return getModuleRows().map((row) => {
		const manifest = parse<ModuleManifest>(row.manifest_json);
		return {
			id: String(row.id), name: String(row.name), version: String(row.version),
			description: manifest.description, enabled: Number(row.enabled) === 1,
			hasWorld: Boolean(manifest.world), characterCount: manifest.characters.length
		};
	});
}

export function getWorldLore(): WorldLore[] {
	const config = getScenarioConfig();
	const modules = getModuleRows().map((row) => ({ row, manifest: parse<ModuleManifest>(row.manifest_json) }))
		.filter(({ manifest }) => manifest.world);
	return [
		{
			id: null, name: '기본 세계관', description: '직접 작성한 세계관',
			setting: config.worldSetting, eraRules: config.eraRules,
			active: !modules.some(({ row }) => Number(row.enabled) === 1)
		},
		...modules.map(({ row, manifest }) => ({
			id: manifest.id, name: manifest.name, description: manifest.description,
			setting: manifest.world!.setting, eraRules: manifest.world!.eraRules ?? '',
			active: Number(row.enabled) === 1
		}))
	];
}

export function getCharacterLore(): CharacterLore[] {
	const modules = getModuleRows().map((row) => ({ row, manifest: parse<ModuleManifest>(row.manifest_json) }));
	const moduleCharacters = new Map(modules.flatMap(({ manifest }) => manifest.characters.map((character) => [character.id, character] as const)));
	const activeIds = new Set(modules.filter(({ row }) => Number(row.enabled) === 1)
		.flatMap(({ manifest }) => manifest.characters.map((character) => character.id)));
	const stored = getCharacterTemplates()
		.filter((character) => !character.moduleId || moduleCharacters.has(character.id));
	const storedIds = new Set(stored.map((character) => character.id));
	const missing = [...moduleCharacters.values()].filter((character) => !storedIds.has(character.id))
		.map((character) => ({ ...character, talent: character.talent ?? { ...DEFAULT_TALENT } }));
	return [...stored, ...missing].map((character) => ({
		character, active: !character.moduleId || activeIds.has(character.id)
	}));
}

export function getEffectiveScenarioConfig(): ScenarioConfig {
	const config = getScenarioConfig();
	const activeWorld = getModuleRows().find((row) => Number(row.enabled) === 1 && parse<ModuleManifest>(row.manifest_json).world);
	if (!activeWorld) return config;
	const world = parse<ModuleManifest>(activeWorld.manifest_json).world!;
	return { ...config, worldSetting: world.setting, eraRules: [config.eraRules, world.eraRules].filter(Boolean).join('\n\n') };
}

function ensureModuleCharacters(manifest: ModuleManifest, refreshMetadata: boolean): void {
	for (const character of manifest.characters) {
		const templateRow = one('SELECT character_json FROM character_templates WHERE id = ?', character.id);
		let template = templateRow ? normalizeCharacter(parse<Character>(templateRow.character_json)) : character;
		if (!templateRow || refreshMetadata) {
			template = { ...character, moduleId: manifest.id };
			updateCharacterTemplate(template);
		}
		const session = one('SELECT id FROM characters WHERE id = ?', character.id);
		if (!session) updateCharacter(template);
		else if (refreshMetadata) applyTemplateToSession(template);
	}
}

export function installModule(raw: string): string {
	const manifest = parseModuleManifest(raw);
	withTransaction(() => {
		const db = getDb();
		if (manifest.world) {
			for (const other of getModuleRows()) {
				if (other.id !== manifest.id && parse<ModuleManifest>(other.manifest_json).world) {
					db.prepare('UPDATE modules SET enabled = 0 WHERE id = ?').run(String(other.id));
				}
			}
		}
		db.prepare(`INSERT INTO modules (id, name, version, manifest_json, enabled) VALUES (?, ?, ?, ?, 1)
			ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version,
			manifest_json=excluded.manifest_json, enabled=1`).run(
			manifest.id, manifest.name, manifest.version, JSON.stringify(manifest)
		);
		ensureModuleCharacters(manifest, true);
		const config = getScenarioConfig();
		updateScenarioConfig({
			...config,
			worldMemory: manifest.world ? '' : config.worldMemory,
			sceneNote: manifest.world ? '' : config.sceneNote,
			pendingProposal: null,
			playerSuggestions: null
		});
	});
	return manifest.name;
}

export function setModuleEnabled(id: string, enabled: boolean): void {
	withTransaction(() => {
		const row = one('SELECT * FROM modules WHERE id = ?', id);
		if (!row) throw new Error('설치된 모듈을 찾을 수 없습니다.');
		const manifest = migrateStoredManifest(parse<ModuleManifest>(row.manifest_json));
		if (enabled && manifest.world) {
			for (const other of getModuleRows()) {
				if (other.id !== id && parse<ModuleManifest>(other.manifest_json).world) {
					getDb().prepare('UPDATE modules SET enabled = 0 WHERE id = ?').run(String(other.id));
				}
			}
		}
		getDb().prepare('UPDATE modules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
		if (enabled) ensureModuleCharacters(manifest, false);
		const config = getScenarioConfig();
		updateScenarioConfig({
			...config,
			worldMemory: manifest.world ? '' : config.worldMemory,
			sceneNote: manifest.world ? '' : config.sceneNote,
			pendingProposal: null,
			playerSuggestions: null
		});
	});
}

export function selectWorldModule(id: string | null): void {
	withTransaction(() => {
		const modules = getModuleRows().map((row) => ({ row, manifest: parse<ModuleManifest>(row.manifest_json) }));
		const selected = id ? modules.find(({ manifest }) => manifest.id === id && manifest.world) : null;
		if (id && !selected) throw new Error('선택한 세계관을 찾을 수 없습니다.');
		for (const { manifest } of modules) {
			if (manifest.world) getDb().prepare('UPDATE modules SET enabled = ? WHERE id = ?').run(manifest.id === id ? 1 : 0, manifest.id);
		}
		if (selected) ensureModuleCharacters(selected.manifest, false);
		const config = getScenarioConfig();
		updateScenarioConfig({ ...config, worldMemory: '', sceneNote: '', pendingProposal: null, playerSuggestions: null });
	});
}

export function getScenarioConfig(): ScenarioConfig {
	const row = one('SELECT * FROM scenario_config WHERE id = 1');
	if (!row) throw new Error('세계관 설정을 찾을 수 없습니다.');
	return {
		worldSetting: String(row.world_setting),
		eraRules: String(row.era_rules),
		worldMemory: String(row.world_memory),
		sceneNote: String(row.scene_note ?? ''),
		pendingProposal: row.pending_proposal_json ? parse(row.pending_proposal_json) : null,
		playerSuggestions: row.player_suggestions_json ? parse(row.player_suggestions_json) : null
	};
}

export function updateScenarioConfig(config: ScenarioConfig): void {
	getDb().prepare(`UPDATE scenario_config SET world_setting = ?, era_rules = ?, world_memory = ?, scene_note = ?, pending_proposal_json = ?, player_suggestions_json = ? WHERE id = 1`).run(
		config.worldSetting,
		config.eraRules,
		config.worldMemory,
		config.sceneNote,
		config.pendingProposal ? JSON.stringify(config.pendingProposal) : null,
		config.playerSuggestions ? JSON.stringify(config.playerSuggestions) : null
	);
}

export function updateCharacter(character: Character, sortOrder?: number): void {
	const bounded: Character = {
		...character,
		base: clampBase(character.base), talent: normalizeTalent(character.talent),
		abl: normalizeAbl(character.abl), exp: normalizeExp(character.exp),
		mark: normalizeMarks(character.mark), relations: normalizeRelations(character.relations),
		palam: normalizePalam(character.palam),
		actionRequirements: normalizeActionRequirements(character.actionRequirements)
	};
	const order = sortOrder ?? Number(one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM characters')?.next_order ?? 0);
	getDb()
		.prepare(`
			INSERT INTO characters (
				id, module_id, sort_order, name, age, portrait, introduction, profile, base_json,
				trait_json, abl_json, exp_json, mark_json, relation_json, palam_json, talent_json, action_requirements_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				module_id=excluded.module_id,
				name=excluded.name, age=excluded.age, portrait=excluded.portrait,
				introduction=excluded.introduction, profile=excluded.profile, base_json=excluded.base_json,
				trait_json=excluded.trait_json, abl_json=excluded.abl_json,
				exp_json=excluded.exp_json, mark_json=excluded.mark_json,
				relation_json=excluded.relation_json, palam_json=excluded.palam_json,
				talent_json=excluded.talent_json, action_requirements_json=excluded.action_requirements_json
		`)
		.run(
			bounded.id,
			bounded.moduleId ?? null,
			order,
			bounded.name,
			bounded.age,
			bounded.portrait,
			bounded.introduction,
			bounded.profile,
			JSON.stringify(bounded.base),
			JSON.stringify(bounded.trait),
			JSON.stringify(bounded.abl),
			JSON.stringify(bounded.exp),
			JSON.stringify(bounded.mark),
			JSON.stringify(bounded.relations),
			JSON.stringify(bounded.palam),
			JSON.stringify(bounded.talent),
			JSON.stringify(bounded.actionRequirements)
		);
}

function normalizeCharacter(character: Character): Character {
	return {
		...character,
		base: clampBase(character.base), talent: normalizeTalent(character.talent),
		abl: normalizeAbl(character.abl), exp: normalizeExp(character.exp),
		mark: normalizeMarks(character.mark), relations: normalizeRelations(character.relations),
		palam: normalizePalam(character.palam), actionRequirements: normalizeActionRequirements(character.actionRequirements)
	};
}

export function getCharacterTemplates(): Character[] {
	return rows('SELECT character_json FROM character_templates ORDER BY sort_order, id')
		.map((row) => normalizeCharacter(parse<Character>(row.character_json)));
}

export function updateCharacterTemplate(character: Character, sortOrder?: number): void {
	const normalized = normalizeCharacter(character);
	const order = sortOrder ?? Number(one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM character_templates')?.next_order ?? 0);
	getDb().prepare(`INSERT INTO character_templates (id, sort_order, character_json) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET character_json=excluded.character_json`)
		.run(normalized.id, order, JSON.stringify(normalized));
}

function applyTemplateToSession(template: Character): void {
	const row = one('SELECT * FROM characters WHERE id = ?', template.id);
	if (!row) {
		if (template.moduleId && Number(one('SELECT enabled FROM modules WHERE id = ?', template.moduleId)?.enabled ?? 0) !== 1) return;
		updateCharacter(template);
		return;
	}
	const current = characterFromRow(row);
	updateCharacter({
		...current,
		moduleId: template.moduleId, name: template.name, age: template.age,
		portrait: template.portrait, introduction: template.introduction, profile: template.profile,
		trait: [...template.trait], actionRequirements: template.actionRequirements.map((requirement) => ({ ...requirement }))
	}, Number(row.sort_order));
}

export function insertEvent(event: Omit<EventRecord, 'id'>): number {
	const result = getDb()
		.prepare(`
			INSERT INTO events (
				turn, day, minute, location, action_id, character_id,
				summary, source_json, changes_json, narrative, renderer, semantic_json, state_changes_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			event.turn,
			event.day,
			event.minute,
			event.location,
			event.actionId,
			event.characterId,
			event.summary,
			JSON.stringify(event.source),
			JSON.stringify(event.changes),
			event.narrative,
			event.renderer,
			event.semanticEvent ? JSON.stringify(event.semanticEvent) : null,
			event.stateChanges ? JSON.stringify(event.stateChanges) : null
		);
	return Number(result.lastInsertRowid);
}

export function updateEventNarrative(id: number, narrative: string, renderer: 'template' | 'llm'): void {
	getDb().prepare('UPDATE events SET narrative = ?, renderer = ? WHERE id = ?').run(narrative, renderer, id);
}

export function getRecentCharacterEvents(characterId: string, limit = 5): EventRecord[] {
	return rows(
		'SELECT * FROM events WHERE character_id = ? ORDER BY id DESC LIMIT ?',
		characterId,
		limit
	).map(eventFromRow);
}

export function insertMemory(eventId: number, characterId: string, summary: string, turn: number): number {
	const result = getDb()
		.prepare('INSERT INTO memories (event_id, character_id, summary, created_turn) VALUES (?, ?, ?, ?)')
		.run(eventId, characterId, summary, turn);
	return Number(result.lastInsertRowid);
}

export function updateMemoryEmbedding(id: number, embedding: number[], model: string): void {
	getDb()
		.prepare('UPDATE memories SET embedding_json = ?, embedding_model = ? WHERE id = ?')
		.run(JSON.stringify(embedding), model, id);
}

export function getMemories(characterId: string, limit = 60): MemoryRecord[] {
	return rows(
		`SELECT m.*, e.summary AS event_summary FROM memories m
		 JOIN events e ON e.id = m.event_id
		 WHERE m.character_id = ? ORDER BY m.created_turn DESC, m.id DESC LIMIT ?`,
		characterId,
		limit
	).map(memoryFromRow);
}

export function searchMemoryIds(characterId: string, query: string, limit = 12): number[] {
	const terms = [...new Set(query.split(/\s+/).map((word) => word.replace(/["'.,!?]/g, '')))]
		.filter((term) => [...term].length >= 3)
		.slice(0, 8);
	if (terms.length === 0) return [];
	const match = terms.map((term) => `"${term}"`).join(' OR ');
	try {
		return rows(
			`SELECT m.id FROM memory_fts
			 JOIN memories m ON m.id = memory_fts.rowid
			 WHERE memory_fts MATCH ? AND m.character_id = ?
			 ORDER BY bm25(memory_fts) LIMIT ?`,
			match,
			characterId,
			limit
		).map((row) => Number(row.id));
	} catch {
		return [];
	}
}

function activeLoreId(): string {
	const row = one('SELECT active_lore_id FROM lore_meta WHERE id = 1');
	if (!row) throw new Error('현재 로어를 찾을 수 없습니다.');
	return String(row.active_lore_id);
}

export function getLores(): LoreSummary[] {
	const activeId = activeLoreId();
	return rows('SELECT id, title FROM lores ORDER BY created_at, id').map((row) => ({
		id: String(row.id), title: String(row.title), active: row.id === activeId
	}));
}

export function renameLore(title: string): void {
	const clean = title.trim();
	if (!clean || clean.length > 80) throw new Error('로어 제목은 1~80자로 입력해 주세요.');
	getDb().prepare('UPDATE lores SET title = ? WHERE id = ?').run(clean, activeLoreId());
}

function activateLore(id: string): void {
	const current = activeLoreId();
	if (id === current) return;
	const target = one('SELECT state_json FROM lores WHERE id = ?', id);
	if (!target) throw new Error('선택한 로어를 찾을 수 없습니다.');
	if (!target.state_json) throw new Error('선택한 로어의 진행을 찾을 수 없습니다.');
	getDb().prepare('UPDATE lores SET state_json = ? WHERE id = ?').run(JSON.stringify(captureSnapshot()), current);
	restoreSnapshot(parse<Snapshot>(target.state_json), true);
	getDb().prepare('UPDATE lores SET state_json = NULL WHERE id = ?').run(id);
	getDb().prepare('UPDATE lore_meta SET active_lore_id = ? WHERE id = 1').run(id);
}

export function switchLore(id: string): void {
	withTransaction(() => activateLore(id));
}

export function createLore(title: string, worldSetting: string, eraRules: string): string {
	const cleanTitle = title.trim();
	const cleanWorld = worldSetting.trim();
	const cleanRules = eraRules.trim();
	if (!cleanTitle || cleanTitle.length > 80) throw new Error('로어 제목은 1~80자로 입력해 주세요.');
	if (!cleanWorld || cleanWorld.length > 20_000 || !cleanRules || cleanRules.length > 10_000) {
		throw new Error('세계관과 era 규칙을 입력해 주세요.');
	}
	const id = randomUUID();
	const snapshot: Snapshot = {
		world: [{ id: 1, turn: 0, day: 1, minute: 18 * 60, location: '시작 장소' }],
		config: [{ id: 1, world_setting: cleanWorld, era_rules: cleanRules,
			world_memory: '', scene_note: '', pending_proposal_json: null, player_suggestions_json: null }],
		characters: [], characterTemplates: [], events: [], memories: [], modules: [], enabledModuleIds: []
	};
	withTransaction(() => {
		getDb().prepare('INSERT INTO lores (id, title, state_json, created_at) VALUES (?, ?, ?, ?)')
			.run(id, cleanTitle, JSON.stringify(snapshot), new Date().toISOString());
		activateLore(id);
	});
	return id;
}

export function deleteLore(id: string, confirmation: string): void {
	withTransaction(() => {
		const lore = one('SELECT title FROM lores WHERE id = ?', id);
		if (!lore) throw new Error('삭제할 로어를 찾을 수 없습니다.');
		if (confirmation !== lore.title) throw new Error('로어 제목을 정확히 입력해 주세요.');
		const other = one('SELECT id FROM lores WHERE id <> ? ORDER BY created_at, id LIMIT 1', id);
		if (!other) throw new Error('마지막 로어는 삭제할 수 없습니다.');
		if (id === activeLoreId()) activateLore(String(other.id));
		getDb().prepare('DELETE FROM lore_save_slots WHERE lore_id = ?').run(id);
		getDb().prepare('DELETE FROM lores WHERE id = ?').run(id);
	});
}

export function getGameView(): GameView {
	const latestEvents = rows('SELECT * FROM events ORDER BY id DESC LIMIT 30').map(eventFromRow);
	const characters = getCharacters();
	const config = getScenarioConfig();
	if (config.pendingProposal && !characters.some((character) => character.id === config.pendingProposal?.characterId)) {
		config.pendingProposal = null;
	}
	if (config.playerSuggestions?.targetId) {
		const target = characters.find((character) => character.id === config.playerSuggestions?.targetId);
		const otherNames = characters.filter((character) => character.id !== target?.id).map((character) => character.name);
		config.playerSuggestions = target ? {
			...config.playerSuggestions,
			options: config.playerSuggestions.options.filter((option) => !otherNames.some((name) => option.includes(name)))
		} : null;
	}
	const memories = rows(`SELECT m.id, m.event_id, m.character_id, m.summary, m.created_turn,
		e.summary AS event_summary FROM memories m JOIN events e ON e.id = m.event_id
		ORDER BY m.id DESC LIMIT 40`).map(
		(row) => ({
			id: Number(row.id),
			eventId: Number(row.event_id),
			characterId: String(row.character_id),
			summary: cleanMemorySummary(row),
			isDetail: isDetailedMemory(row),
			createdTurn: Number(row.created_turn)
		})
	);
	const saves: SaveSlot[] = rows('SELECT slot, saved_at, turn FROM lore_save_slots WHERE lore_id = ? ORDER BY slot', activeLoreId()).map(
		(row) => ({ slot: Number(row.slot), savedAt: String(row.saved_at), turn: Number(row.turn) })
	);
	const lores = getLores();
	return {
		lore: lores.find((lore) => lore.active)!,
		lores,
		world: getWorld(),
		config,
		characters,
		characterTemplates: getCharacterTemplates(),
		modules: getInstalledModules(),
		worldLore: getWorldLore(),
		characterLore: getCharacterLore(),
		events: latestEvents,
		memories,
		saves,
		latestNarrative:
			latestEvents[0]?.narrative ??
			`아직 첫 장면이 시작되지 않았다.\n\n${config.worldSetting}`,
		latestRenderer: latestEvents[0]?.renderer ?? 'template'
	};
}

interface Snapshot {
	world: Row[];
	config?: Row[];
	/** Accepted only while importing older snapshots; current snapshots omit it. */
	player?: Row[];
	characters: Row[];
	characterTemplates?: Row[];
	events: Row[];
	memories: Row[];
	modules?: Row[];
	enabledModuleIds?: string[];
}

function captureSnapshot(): Snapshot {
	return {
		world: rows('SELECT * FROM world_state'),
		config: rows('SELECT * FROM scenario_config'),
		characters: rows('SELECT * FROM characters ORDER BY sort_order'),
		characterTemplates: rows('SELECT * FROM character_templates ORDER BY sort_order'),
		events: rows('SELECT * FROM events ORDER BY id'),
		memories: rows('SELECT * FROM memories ORDER BY id'),
		modules: getModuleRows(),
		enabledModuleIds: rows('SELECT id FROM modules WHERE enabled = 1').map((row) => String(row.id))
	};
}

function checkedSnapshot(value: unknown, full: boolean): Snapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('로어 진행 데이터가 올바르지 않습니다.');
	const snapshot = value as Record<string, unknown>;
	const required = ['world', 'characters', 'events', 'memories'];
	if (full) required.push('config', 'modules');
	for (const key of required) {
		if (!Array.isArray(snapshot[key]) || (snapshot[key] as unknown[]).some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
			throw new Error(`로어의 ${key} 데이터가 올바르지 않습니다.`);
		}
	}
	if ((snapshot.world as Row[]).length !== 1) {
		throw new Error('로어의 세계 상태가 올바르지 않습니다.');
	}
	const world = (snapshot.world as Row[])[0];
	if (world.id !== 1 || !Number.isInteger(world.turn) || !Number.isInteger(world.day) ||
		!Number.isInteger(world.minute) || typeof world.location !== 'string') {
		throw new Error('로어의 세계 상태가 올바르지 않습니다.');
	}
	if (snapshot.config !== undefined) {
		if (!Array.isArray(snapshot.config) || snapshot.config.length !== 1 ||
			typeof snapshot.config[0]?.world_setting !== 'string' || typeof snapshot.config[0]?.era_rules !== 'string') {
			throw new Error('로어의 세계관 설정이 올바르지 않습니다.');
		}
	}
	for (const character of snapshot.characters as Row[]) {
		if (typeof character.id !== 'string' || typeof character.name !== 'string' ||
			!Number.isInteger(character.age) || Number(character.age) < 20 ||
			(typeof character.profile !== 'string' && typeof character.introduction !== 'string')) {
			throw new Error('로어의 등장인물 설정이 올바르지 않습니다.');
		}
	}
	if (snapshot.characterTemplates !== undefined) {
		if (!Array.isArray(snapshot.characterTemplates)) throw new Error('로어의 인물 원본 데이터가 올바르지 않습니다.');
		for (const template of snapshot.characterTemplates as Row[]) {
			if (typeof template.id !== 'string' || !Number.isInteger(template.sort_order) || typeof template.character_json !== 'string') {
				throw new Error('로어의 인물 원본 데이터가 올바르지 않습니다.');
			}
			try { normalizeCharacter(parse<Character>(template.character_json)); } catch { throw new Error('로어의 인물 원본 데이터가 올바르지 않습니다.'); }
		}
	}
	if (snapshot.modules !== undefined) {
		if (!Array.isArray(snapshot.modules)) throw new Error('로어의 모듈 목록이 올바르지 않습니다.');
		for (const module of snapshot.modules as Row[]) {
			if (typeof module.id !== 'string' || typeof module.manifest_json !== 'string') {
				throw new Error('로어의 모듈 목록이 올바르지 않습니다.');
			}
			let manifest: ModuleManifest;
			try { manifest = parse<ModuleManifest>(module.manifest_json); } catch { throw new Error('로어의 모듈 목록이 올바르지 않습니다.'); }
			if (!manifest || manifest.schemaVersion !== 1 || manifest.id !== module.id || typeof manifest.name !== 'string' ||
				!Array.isArray(manifest.characters) || manifest.characters.some((character) =>
					!character || typeof character.id !== 'string' || !character.id.startsWith(`mod:${manifest.id}:`) ||
					!Number.isInteger(character.age) || character.age < 20)) {
				throw new Error('로어의 모듈 목록이 올바르지 않습니다.');
			}
		}
	}
	return value as Snapshot;
}

function migrateSnapshot(snapshot: Snapshot): Snapshot {
	const { player: _legacyPlayer, ...current } = snapshot;
	return { ...current,
		characters: snapshot.characters.map(migrateCharacterRow),
		characterTemplates: snapshot.characterTemplates?.map((row) => ({
			...row, character_json: JSON.stringify(normalizeCharacter(parse<Character>(row.character_json)))
		})),
		modules: snapshot.modules?.map((row) => ({
			...row, manifest_json: JSON.stringify(migrateStoredManifest(parse<ModuleManifest>(row.manifest_json)))
		}))
	};
}

function withCharacterTemplates(snapshot: Snapshot): Snapshot {
	if (snapshot.characterTemplates) return snapshot;
	return {
		...snapshot,
		characterTemplates: snapshot.characters.map((row, index) => {
			const character = characterFromRow(migrateCharacterRow(row));
			return { id: character.id, sort_order: Number(row.sort_order ?? index), character_json: JSON.stringify(character) };
		})
	};
}

export function exportLoreJson(id: string): string {
	const lore = one('SELECT title, state_json FROM lores WHERE id = ?', id);
	if (!lore) throw new Error('내보낼 로어를 찾을 수 없습니다.');
	const state = withCharacterTemplates(migrateSnapshot(id === activeLoreId() ? captureSnapshot() : checkedSnapshot(parse(lore.state_json), true)));
	const saves = rows('SELECT slot, saved_at, turn, snapshot_json FROM lore_save_slots WHERE lore_id = ? ORDER BY slot', id)
		.map((row) => ({ slot: Number(row.slot), savedAt: String(row.saved_at), turn: Number(row.turn),
			state: migrateSnapshot(parse<Snapshot>(row.snapshot_json)) }));
	return JSON.stringify({ format: 'newera-lore', version: 1, title: String(lore.title), state, saves }, null, 2);
}

export function importLoreJson(raw: string): string {
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error('로어 JSON 형식을 확인해 주세요.'); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('로어 파일 형식이 올바르지 않습니다.');
	const bundle = value as Record<string, unknown>;
	if (bundle.format !== 'newera-lore' || bundle.version !== 1 ||
		typeof bundle.title !== 'string' || !bundle.title.trim() || bundle.title.length > 80 ||
		!Array.isArray(bundle.saves) || bundle.saves.length > 3) {
		throw new Error('지원하지 않는 로어 파일입니다.');
	}
	const state = withCharacterTemplates(migrateSnapshot(checkedSnapshot(bundle.state, true)));
	const saves = bundle.saves.map((entry: unknown) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('저장 슬롯 형식이 올바르지 않습니다.');
		const save = entry as Record<string, unknown>;
		if (!Number.isInteger(save.slot) || Number(save.slot) < 1 || Number(save.slot) > 3 ||
			!Number.isInteger(save.turn) || typeof save.savedAt !== 'string') throw new Error('저장 슬롯 형식이 올바르지 않습니다.');
		return { slot: Number(save.slot), turn: Number(save.turn), savedAt: save.savedAt, state: migrateSnapshot(checkedSnapshot(save.state, false)) };
	});
	if (new Set(saves.map((save) => save.slot)).size !== saves.length) throw new Error('중복된 저장 슬롯이 있습니다.');
	const id = randomUUID();
	withTransaction(() => {
		getDb().prepare('INSERT INTO lores (id, title, state_json, created_at) VALUES (?, ?, ?, ?)')
			.run(id, (bundle.title as string).trim(), JSON.stringify(state), new Date().toISOString());
		for (const save of saves) {
			getDb().prepare('INSERT INTO lore_save_slots (lore_id, slot, saved_at, turn, snapshot_json) VALUES (?, ?, ?, ?, ?)')
				.run(id, save.slot, save.savedAt, save.turn, JSON.stringify(save.state));
		}
		activateLore(id);
		getGameView();
	});
	return id;
}

export function saveGame(slot: number): void {
	if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('저장 슬롯이 올바르지 않습니다.');
	withTransaction(() => {
		// A slot records progress and the selected modules. Installed packages belong to the lore itself.
		const { modules: _modules, characterTemplates: _characterTemplates, ...snapshot } = captureSnapshot();
		getDb().prepare(`
			INSERT INTO lore_save_slots (lore_id, slot, saved_at, turn, snapshot_json)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(lore_id, slot) DO UPDATE SET
				saved_at=excluded.saved_at, turn=excluded.turn, snapshot_json=excluded.snapshot_json
		`)
		.run(activeLoreId(), slot, new Date().toISOString(), getWorld().turn, JSON.stringify(snapshot));
	});
}

export function resetSaveSlot(slot: number): void {
	if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('저장 슬롯이 올바르지 않습니다.');
	withTransaction(() => {
		const result = getDb().prepare('DELETE FROM lore_save_slots WHERE lore_id = ? AND slot = ?')
			.run(activeLoreId(), slot);
		if (result.changes === 0) throw new Error('이 로어의 슬롯에는 저장된 게임이 없습니다.');
	});
}

function restoreSnapshot(snapshot: Snapshot, replaceLoreDefinitions = false): void {
	snapshot = migrateSnapshot(snapshot);
		const db = getDb();
		db.exec('DELETE FROM memories; DELETE FROM events; DELETE FROM characters; DELETE FROM world_state;');
		if (replaceLoreDefinitions) {
			const templates = withCharacterTemplates(snapshot).characterTemplates!;
			db.prepare('DELETE FROM character_templates').run();
			for (const value of templates) {
				db.prepare('INSERT INTO character_templates (id, sort_order, character_json) VALUES (?, ?, ?)').run(
					value.id as string, value.sort_order as number, value.character_json as string
				);
			}
		}
		if (snapshot.modules) {
			db.prepare('DELETE FROM modules').run();
			for (const value of snapshot.modules) {
				db.prepare('INSERT INTO modules (id, name, version, manifest_json, enabled) VALUES (?, ?, ?, ?, ?)').run(
					value.id as string, value.name as string, value.version as string,
					value.manifest_json as string, value.enabled as number
				);
			}
		}
		for (const value of snapshot.world) {
			db.prepare('INSERT INTO world_state VALUES (?, ?, ?, ?, ?)').run(
				value.id as number,
				value.turn as number,
				value.day as number,
				value.minute as number,
				value.location as string
			);
		}
		for (const value of snapshot.characters) {
			db.prepare(`INSERT INTO characters (
				id, module_id, sort_order, name, age, portrait, introduction, profile, base_json,
				trait_json, abl_json, exp_json, mark_json, relation_json, palam_json, talent_json, action_requirements_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				value.id as string,
				(value.module_id ?? null) as string | null,
				value.sort_order as number,
				value.name as string,
				value.age as number,
				value.portrait as string,
				value.introduction as string,
				(value.profile ?? value.introduction) as string,
				value.base_json as string,
				value.trait_json as string,
				value.abl_json as string,
				value.exp_json as string,
				value.mark_json as string,
				value.relation_json as string,
				value.palam_json as string,
				(value.talent_json ?? JSON.stringify(DEFAULT_TALENT)) as string,
				(value.action_requirements_json ?? JSON.stringify(DEFAULT_ACTION_REQUIREMENTS)) as string
			);
		}
		for (const value of snapshot.events) {
			db.prepare(`INSERT INTO events (id, turn, day, minute, location, action_id, character_id,
				summary, source_json, changes_json, narrative, renderer, semantic_json, state_changes_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				value.id as number,
				value.turn as number,
				value.day as number,
				value.minute as number,
				value.location as string,
				value.action_id as string,
				value.character_id as string | null,
				value.summary as string,
				value.source_json as string,
				value.changes_json as string,
				value.narrative as string,
				value.renderer as string,
				(value.semantic_json ?? null) as string | null,
				(value.state_changes_json ?? null) as string | null
			);
		}
		for (const value of snapshot.memories) {
			db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?)').run(
				value.id as number,
				value.event_id as number,
				value.character_id as string,
				value.summary as string,
				value.created_turn as number,
				value.embedding_json as string | null,
				value.embedding_model as string | null
			);
		}
		if (snapshot.config?.[0]) {
			const value = snapshot.config[0];
			db.prepare(`UPDATE scenario_config SET world_setting = ?, era_rules = ?, world_memory = ?, scene_note = ?, pending_proposal_json = ?, player_suggestions_json = ? WHERE id = 1`).run(
				value.world_setting as string,
				value.era_rules as string,
				(value.world_memory ?? '') as string,
				(value.scene_note ?? '') as string,
				value.pending_proposal_json as string | null,
				(value.player_suggestions_json ?? null) as string | null
			);
		} else {
			db.prepare("UPDATE scenario_config SET scene_note = '', pending_proposal_json = NULL, player_suggestions_json = NULL WHERE id = 1").run();
		}
		if (!snapshot.modules) {
			db.prepare('UPDATE modules SET enabled = 0').run();
			for (const id of snapshot.enabledModuleIds ?? []) {
				db.prepare('UPDATE modules SET enabled = 1 WHERE id = ?').run(id);
		}
		}
		for (const module of getModuleRows().filter((row) => Number(row.enabled) === 1)) {
			ensureModuleCharacters(parse<ModuleManifest>(module.manifest_json), false);
		}
		for (const template of getCharacterTemplates()) applyTemplateToSession(template);
}

export function loadGame(slot: number): void {
	if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('저장 슬롯이 올바르지 않습니다.');
	const row = one('SELECT snapshot_json FROM lore_save_slots WHERE lore_id = ? AND slot = ?', activeLoreId(), slot);
	if (!row) throw new Error('이 로어의 슬롯에는 저장된 게임이 없습니다.');
	withTransaction(() => restoreSnapshot(parse<Snapshot>(row.snapshot_json)));
}
