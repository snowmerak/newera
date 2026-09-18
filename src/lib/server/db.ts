import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
	BaseStats,
	Character,
	EventRecord,
	GameView,
	MemoryRecord,
	ScenarioConfig,
	SaveSlot,
	WorldState
} from '$lib/game/types';

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
	const abl = parse<Partial<Character['abl']>>(row.abl_json);
	const exp = parse<Partial<Character['exp']>>(row.exp_json);
	const relation = parse<Partial<Character['relation']>>(row.relation_json);
	const palam = parse<Partial<Character['palam']>>(row.palam_json);
	return {
		id: String(row.id),
		name: String(row.name),
		age: Number(row.age),
		portrait: String(row.portrait),
		introduction: String(row.introduction),
		profile: String(row.profile ?? row.introduction),
		base: parse(row.base_json),
		trait: parse(row.trait_json),
		abl: { conversation: abl.conversation ?? 1, empathy: abl.empathy ?? 1, seduction: abl.seduction ?? 1 },
		exp: { conversation: exp.conversation ?? 0, empathy: exp.empathy ?? 0, seduction: exp.seduction ?? 0 },
		mark: parse(row.mark_json),
		relation: { affection: relation.affection ?? 0, trust: relation.trust ?? 0, desire: relation.desire ?? 0 },
		palam: {
			rapport: palam.rapport ?? 0,
			trust: palam.trust ?? 0,
			arousal: palam.arousal ?? 0,
			pleasure: palam.pleasure ?? 0
		}
	};
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
		renderer: String(row.renderer) as EventRecord['renderer']
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
		CREATE TABLE IF NOT EXISTS player_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			energy INTEGER NOT NULL,
			max_energy INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS characters (
			id TEXT PRIMARY KEY,
			sort_order INTEGER NOT NULL,
			name TEXT NOT NULL,
			age INTEGER NOT NULL,
			portrait TEXT NOT NULL,
			introduction TEXT NOT NULL,
			profile TEXT NOT NULL DEFAULT '',
			base_json TEXT NOT NULL,
			trait_json TEXT NOT NULL,
			abl_json TEXT NOT NULL,
			exp_json TEXT NOT NULL,
			mark_json TEXT NOT NULL,
			relation_json TEXT NOT NULL,
			palam_json TEXT NOT NULL
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
			renderer TEXT NOT NULL
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
		CREATE TABLE IF NOT EXISTS scenario_config (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			world_setting TEXT NOT NULL,
			era_rules TEXT NOT NULL,
			world_memory TEXT NOT NULL DEFAULT '',
			pending_proposal_json TEXT,
			player_suggestions_json TEXT
		);
	`);
	const characterColumns = db.prepare('PRAGMA table_info(characters)').all() as Row[];
	if (!characterColumns.some((column) => column.name === 'profile')) {
		db.exec("ALTER TABLE characters ADD COLUMN profile TEXT NOT NULL DEFAULT ''");
		db.exec('UPDATE characters SET profile = introduction WHERE profile = \'\'');
	}
	const configColumns = db.prepare('PRAGMA table_info(scenario_config)').all() as Row[];
	if (!configColumns.some((column) => column.name === 'world_memory')) {
		db.exec("ALTER TABLE scenario_config ADD COLUMN world_memory TEXT NOT NULL DEFAULT ''");
	}
	if (!configColumns.some((column) => column.name === 'player_suggestions_json')) {
		db.exec('ALTER TABLE scenario_config ADD COLUMN player_suggestions_json TEXT');
	}
	database = db;
	if (!one('SELECT id FROM world_state WHERE id = 1')) seed();
	db.prepare(`INSERT OR IGNORE INTO scenario_config (id, world_setting, era_rules)
		VALUES (1, ?, ?)`).run(
		'현대 서울의 망원동. 성인들이 각자의 일상과 욕망을 지닌 채 같은 동네에서 살아간다.',
		'era의 BASE·TRAIT·ABL·EXP·MARK·RELATION과 SOURCE·PALAM을 따른다. 인물은 자기 사정과 의지로 행동하며 세계는 플레이어가 가만히 있어도 진행된다.'
	);
	return db;
}

function seed(): void {
	const db = getDb();
	withTransaction(() => {
		db.prepare('INSERT INTO world_state VALUES (1, 0, 1, 18 * 60 + 20, ?)').run('서울 · 망원동');
		db.prepare('INSERT INTO player_state VALUES (1, 24, 24)').run();
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
				abl: { conversation: 1, empathy: 2, seduction: 1 },
				exp: { conversation: 0, empathy: 15, seduction: 0 },
				mark: [],
				relation: { affection: 3, trust: 2, desire: 0 },
				palam: { rapport: 0, trust: 0, arousal: 0, pleasure: 0 }
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
				abl: { conversation: 1, empathy: 1, seduction: 1 },
				exp: { conversation: 0, empathy: 0, seduction: 0 },
				mark: [],
				relation: { affection: 1, trust: 1, desire: 0 },
				palam: { rapport: 0, trust: 0, arousal: 0, pleasure: 0 }
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

export function getPlayer(): BaseStats {
	const row = one('SELECT energy, max_energy FROM player_state WHERE id = 1');
	if (!row) throw new Error('플레이어 상태를 찾을 수 없습니다.');
	return { energy: Number(row.energy), maxEnergy: Number(row.max_energy) };
}

export function updatePlayer(player: BaseStats): void {
	getDb()
		.prepare('UPDATE player_state SET energy = ?, max_energy = ? WHERE id = 1')
		.run(player.energy, player.maxEnergy);
}

export function getCharacter(id: string): Character | null {
	const row = one('SELECT * FROM characters WHERE id = ?', id);
	return row ? characterFromRow(row) : null;
}

export function getCharacters(): Character[] {
	return rows('SELECT * FROM characters ORDER BY sort_order, id').map(characterFromRow);
}

export function getScenarioConfig(): ScenarioConfig {
	const row = one('SELECT * FROM scenario_config WHERE id = 1');
	if (!row) throw new Error('세계관 설정을 찾을 수 없습니다.');
	return {
		worldSetting: String(row.world_setting),
		eraRules: String(row.era_rules),
		worldMemory: String(row.world_memory),
		pendingProposal: row.pending_proposal_json ? parse(row.pending_proposal_json) : null,
		playerSuggestions: row.player_suggestions_json ? parse(row.player_suggestions_json) : null
	};
}

export function updateScenarioConfig(config: ScenarioConfig): void {
	getDb().prepare(`UPDATE scenario_config SET world_setting = ?, era_rules = ?, world_memory = ?, pending_proposal_json = ?, player_suggestions_json = ? WHERE id = 1`).run(
		config.worldSetting,
		config.eraRules,
		config.worldMemory,
		config.pendingProposal ? JSON.stringify(config.pendingProposal) : null,
		config.playerSuggestions ? JSON.stringify(config.playerSuggestions) : null
	);
}

export function updateCharacter(character: Character, sortOrder?: number): void {
	const order = sortOrder ?? Number(one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM characters')?.next_order ?? 0);
	getDb()
		.prepare(`
			INSERT INTO characters (
				id, sort_order, name, age, portrait, introduction, profile, base_json,
				trait_json, abl_json, exp_json, mark_json, relation_json, palam_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name=excluded.name, age=excluded.age, portrait=excluded.portrait,
				introduction=excluded.introduction, profile=excluded.profile, base_json=excluded.base_json,
				trait_json=excluded.trait_json, abl_json=excluded.abl_json,
				exp_json=excluded.exp_json, mark_json=excluded.mark_json,
				relation_json=excluded.relation_json, palam_json=excluded.palam_json
		`)
		.run(
			character.id,
			order,
			character.name,
			character.age,
			character.portrait,
			character.introduction,
			character.profile,
			JSON.stringify(character.base),
			JSON.stringify(character.trait),
			JSON.stringify(character.abl),
			JSON.stringify(character.exp),
			JSON.stringify(character.mark),
			JSON.stringify(character.relation),
			JSON.stringify(character.palam)
		);
}

export function insertEvent(event: Omit<EventRecord, 'id'>): number {
	const result = getDb()
		.prepare(`
			INSERT INTO events (
				turn, day, minute, location, action_id, character_id,
				summary, source_json, changes_json, narrative, renderer
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			event.renderer
		);
	return Number(result.lastInsertRowid);
}

export function updateEventNarrative(id: number, narrative: string, renderer: 'template' | 'llm'): void {
	getDb().prepare('UPDATE events SET narrative = ?, renderer = ? WHERE id = ?').run(narrative, renderer, id);
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

export function getGameView(): GameView {
	const latestEvents = rows('SELECT * FROM events ORDER BY id DESC LIMIT 30').map(eventFromRow);
	const characters = getCharacters();
	const config = getScenarioConfig();
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
	const saves: SaveSlot[] = rows('SELECT slot, saved_at, turn FROM save_slots ORDER BY slot').map(
		(row) => ({ slot: Number(row.slot), savedAt: String(row.saved_at), turn: Number(row.turn) })
	);
	return {
		world: getWorld(),
		config,
		player: getPlayer(),
		characters,
		events: latestEvents,
		memories,
		saves,
		latestNarrative:
			latestEvents[0]?.narrative ??
			'해가 저물고 창밖으로 서울의 불빛이 하나둘 켜진다. 성인인 당신과 이곳의 사람들은 서로의 마음과 욕망을 아직 알아가는 중이다.',
		latestRenderer: latestEvents[0]?.renderer ?? 'template'
	};
}

interface Snapshot {
	world: Row[];
	config?: Row[];
	player: Row[];
	characters: Row[];
	events: Row[];
	memories: Row[];
}

export function saveGame(slot: number): void {
	if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('저장 슬롯이 올바르지 않습니다.');
	const snapshot: Snapshot = {
		world: rows('SELECT * FROM world_state'),
		config: rows('SELECT * FROM scenario_config'),
		player: rows('SELECT * FROM player_state'),
		characters: rows('SELECT * FROM characters ORDER BY sort_order'),
		events: rows('SELECT * FROM events ORDER BY id'),
		memories: rows('SELECT * FROM memories ORDER BY id')
	};
	getDb()
		.prepare(`
			INSERT INTO save_slots (slot, saved_at, turn, snapshot_json)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(slot) DO UPDATE SET
				saved_at=excluded.saved_at, turn=excluded.turn, snapshot_json=excluded.snapshot_json
		`)
		.run(slot, new Date().toISOString(), getWorld().turn, JSON.stringify(snapshot));
}

export function loadGame(slot: number): void {
	if (!Number.isInteger(slot) || slot < 1 || slot > 3) throw new Error('저장 슬롯이 올바르지 않습니다.');
	const row = one('SELECT snapshot_json FROM save_slots WHERE slot = ?', slot);
	if (!row) throw new Error('이 슬롯에는 저장된 게임이 없습니다.');
	const snapshot = parse<Snapshot>(row.snapshot_json);
	withTransaction(() => {
		const db = getDb();
		db.exec('DELETE FROM memories; DELETE FROM events; DELETE FROM characters; DELETE FROM player_state; DELETE FROM world_state;');
		for (const value of snapshot.world) {
			db.prepare('INSERT INTO world_state VALUES (?, ?, ?, ?, ?)').run(
				value.id as number,
				value.turn as number,
				value.day as number,
				value.minute as number,
				value.location as string
			);
		}
		for (const value of snapshot.player) {
			db.prepare('INSERT INTO player_state VALUES (?, ?, ?)').run(
				value.id as number,
				value.energy as number,
				value.max_energy as number
			);
		}
		for (const value of snapshot.characters) {
			db.prepare(`INSERT INTO characters (
				id, sort_order, name, age, portrait, introduction, profile, base_json,
				trait_json, abl_json, exp_json, mark_json, relation_json, palam_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				value.id as string,
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
				value.palam_json as string
			);
		}
		for (const value of snapshot.events) {
			db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
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
				value.renderer as string
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
			db.prepare(`UPDATE scenario_config SET world_setting = ?, era_rules = ?, world_memory = ?, pending_proposal_json = ?, player_suggestions_json = ? WHERE id = 1`).run(
				value.world_setting as string,
				value.era_rules as string,
				(value.world_memory ?? '') as string,
				value.pending_proposal_json as string | null,
				(value.player_suggestions_json ?? null) as string | null
			);
		} else {
			db.prepare('UPDATE scenario_config SET pending_proposal_json = NULL, player_suggestions_json = NULL WHERE id = 1').run();
		}
	});
}
