import type { SemanticEvent, StateChange } from './simulation';

export type ActionId = 'talk' | 'listen' | 'flirt' | 'kiss' | 'intimacy' | 'rest';

export interface BaseStats {
	energy: number;
	maxEnergy: number;
}

export interface TalentStats {
	pride: number;
	openness: number;
	libido: number;
	modesty: number;
	assertiveness: number;
	receptiveness: number;
	curiosity: number;
}

export interface AbilityStats { conversation: number; empathy: number; seduction: number; intimacy: number }
export interface ExperienceStats { social: number; romantic: number; seduction: number; intimacy: number }
export interface RelationStats { affection: number; trust: number; desire: number; attachment: number; jealousy: number; resentment: number }
export interface PalamStats { rapport: number; comfort: number; arousal: number; pleasure: number; embarrassment: number; tension: number; frustration: number; satisfaction: number }

export const DEFAULT_TALENT: TalentStats = { pride: 50, openness: 50, libido: 50, modesty: 50, assertiveness: 50, receptiveness: 50, curiosity: 50 };
export const DEFAULT_ABL: AbilityStats = { conversation: 1, empathy: 1, seduction: 1, intimacy: 1 };
export const DEFAULT_EXP: ExperienceStats = { social: 0, romantic: 0, seduction: 0, intimacy: 0 };
export const DEFAULT_RELATION: RelationStats = { affection: 0, trust: 0, desire: 0, attachment: 0, jealousy: 0, resentment: 0 };
export const DEFAULT_PALAM: PalamStats = { rapport: 0, comfort: 0, arousal: 0, pleasure: 0, embarrassment: 0, tension: 0, frustration: 0, satisfaction: 0 };
export const STANDARD_MARKS = ['firstDate', 'firstKiss', 'firstIntimacy', 'becameLovers', 'exclusiveRelationship', 'relationshipCrisis', 'reconciled'] as const;
export type CustomState = Record<string, string | number | boolean | null>;

export function normalizeMarks(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const aliases: Record<string, string> = { '서로 원한 입맞춤': 'firstKiss', '서로 동의한 밤': 'firstIntimacy' };
	return [...new Set(raw.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
		.map((mark) => aliases[mark] ?? mark))];
}

export function clampCount(value: number): number {
	return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0;
}

export function clampPercent(value: number): number {
	return Math.min(100, clampCount(value));
}

export function clampBase(base: BaseStats): BaseStats {
	const maxEnergy = Math.max(1, clampCount(base.maxEnergy));
	return { maxEnergy, energy: Math.min(maxEnergy, clampCount(base.energy)) };
}

function fields<T extends object>(defaults: T, raw: unknown, clamp: (value: number) => number): T {
	const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
		[key, clamp(typeof source[key] === 'number' ? source[key] : fallback as number)])) as T;
}

export function normalizeTalent(raw: unknown): TalentStats { return fields(DEFAULT_TALENT, raw, clampPercent); }
export function normalizeAbl(raw: unknown): AbilityStats { return fields(DEFAULT_ABL, raw, clampCount); }
export function normalizeExp(raw: unknown): ExperienceStats {
	const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
	const legacySocial = (typeof source.conversation === 'number' ? source.conversation : 0) +
		(typeof source.empathy === 'number' ? source.empathy : 0);
	return fields(DEFAULT_EXP, { ...source, social: source.social ?? legacySocial }, clampCount);
}
export function normalizeRelation(raw: unknown): RelationStats { return fields(DEFAULT_RELATION, raw, clampPercent); }
export function normalizeRelations(raw: unknown): Record<string, RelationStats> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { player: { ...DEFAULT_RELATION } };
	const source = raw as Record<string, unknown>;
	if ('affection' in source || 'trust' in source || 'desire' in source) return { player: normalizeRelation(source) };
	const result = Object.fromEntries(Object.entries(source).map(([id, value]) => [id, normalizeRelation(value)]));
	return { player: { ...DEFAULT_RELATION }, ...result };
}
export function relationTo(character: Character, targetId = 'player'): RelationStats {
	return character.relations[targetId] ?? DEFAULT_RELATION;
}
export function normalizePalam(raw: unknown): PalamStats {
	const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
	return fields(DEFAULT_PALAM, { ...source, comfort: source.comfort ?? source.trust }, clampPercent);
}

export interface Character {
	id: string;
	moduleId?: string | null;
	name: string;
	age: number;
	portrait: string;
	introduction: string;
	profile: string;
	base: BaseStats;
	trait: string[];
	talent: TalentStats;
	abl: AbilityStats;
	exp: ExperienceStats;
	mark: string[];
	/** Directed edges from this character to a target ID. The player has ID `player`. */
	relations: Record<string, RelationStats>;
	palam: PalamStats;
}

export type CharacterStatsInput = Pick<Character, 'base' | 'abl' | 'exp' | 'palam'> & { talent?: TalentStats; relation: RelationStats };

export interface InstalledModule {
	id: string;
	name: string;
	version: string;
	description: string;
	enabled: boolean;
	hasWorld: boolean;
	characterCount: number;
}

export interface WorldLore {
	id: string | null;
	name: string;
	description: string;
	setting: string;
	eraRules: string;
	active: boolean;
}

export interface CharacterLore {
	character: Character;
	active: boolean;
}

export interface WorldState {
	turn: number;
	day: number;
	minute: number;
	location: string;
}

export interface Source {
	rapport?: number;
	comfort?: number;
	tension?: number;
	trust?: number;
	affection?: number;
	desire?: number;
	arousal?: number;
	pleasure?: number;
}

export interface EventRecord {
	id: number;
	turn: number;
	day: number;
	minute: number;
	location: string;
	actionId: ActionId | 'conversation' | 'advance' | 'decline' | 'custom';
	characterId: string | null;
	summary: string;
	source: Source;
	changes: Record<string, number>;
	narrative: string;
	renderer: 'template' | 'llm';
	semanticEvent?: SemanticEvent | null;
	stateChanges?: StateChange[];
}

export interface MemoryRecord {
	id: number;
	eventId: number;
	characterId: string;
	summary: string;
	isDetail: boolean;
	createdTurn: number;
	embedding: number[] | null;
	embeddingModel: string | null;
}

export interface SaveSlot {
	slot: number;
	savedAt: string;
	turn: number;
}

export interface LoreSummary {
	id: string;
	title: string;
	active: boolean;
}

export interface Proposal {
	characterId: string;
	actionId: Exclude<ActionId, 'rest'>;
	text: string;
}

export interface PlayerSuggestionSet {
	turn: number;
	targetId: string | null;
	options: string[];
}

export interface ScenarioConfig {
	worldSetting: string;
	eraRules: string;
	worldMemory: string;
	pendingProposal: Proposal | null;
	playerSuggestions: PlayerSuggestionSet | null;
}

export interface GameView {
	lore: LoreSummary;
	lores: LoreSummary[];
	world: WorldState;
	config: ScenarioConfig;
	characters: Character[];
	modules: InstalledModule[];
	worldLore: WorldLore[];
	characterLore: CharacterLore[];
	events: EventRecord[];
	memories: Array<Pick<MemoryRecord, 'id' | 'eventId' | 'characterId' | 'summary' | 'isDetail' | 'createdTurn'>>;
	saves: SaveSlot[];
	latestNarrative: string;
	latestRenderer: 'template' | 'llm';
}
