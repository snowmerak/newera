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

export const PALAM_METADATA = [
	{ key: 'rapport', label: '교감', description: '현재 대화와 행동이 서로 잘 통하는 정도' },
	{ key: 'comfort', label: '편안함', description: '현재 상황에서 경계를 풀고 안정된 정도' },
	{ key: 'arousal', label: '흥분', description: '현재 장면에서의 성적 흥분' },
	{ key: 'pleasure', label: '쾌감', description: '현재 느끼는 신체적·감정적 쾌감' },
	{ key: 'embarrassment', label: '부끄러움', description: '현재 느끼는 수치심과 당혹스러움' },
	{ key: 'tension', label: '긴장', description: '현재 상황에서의 경계·압박·기대' },
	{ key: 'frustration', label: '좌절', description: '풀리지 않은 욕구와 불만이 쌓인 정도' },
	{ key: 'satisfaction', label: '만족', description: '현재 장면의 결과에 충족된 정도' }
] as const satisfies ReadonlyArray<{ key: keyof PalamStats; label: string; description: string }>;

export const ACTION_REQUIREMENT_ACTIONS = ['talk', 'listen', 'flirt', 'kiss', 'intimacy'] as const;
export type RequirementActionId = typeof ACTION_REQUIREMENT_ACTIONS[number];
export const ACTION_REQUIREMENT_STATS = [
	'base.energy',
	'talent.pride', 'talent.openness', 'talent.libido', 'talent.modesty', 'talent.assertiveness', 'talent.receptiveness', 'talent.curiosity',
	'abl.conversation', 'abl.empathy', 'abl.seduction', 'abl.intimacy',
	'exp.social', 'exp.romantic', 'exp.seduction', 'exp.intimacy',
	'relation.affection', 'relation.trust', 'relation.desire', 'relation.attachment', 'relation.jealousy', 'relation.resentment',
	'palam.rapport', 'palam.comfort', 'palam.arousal', 'palam.pleasure', 'palam.embarrassment', 'palam.tension', 'palam.frustration', 'palam.satisfaction'
] as const;
export type ActionRequirementStat = typeof ACTION_REQUIREMENT_STATS[number];
export interface ActionRequirement { actionId: RequirementActionId; stat: ActionRequirementStat; minimum: number }

export const DEFAULT_ACTION_REQUIREMENTS: ActionRequirement[] = [
	{ actionId: 'flirt', stat: 'relation.trust', minimum: 2 },
	{ actionId: 'kiss', stat: 'relation.affection', minimum: 5 },
	{ actionId: 'kiss', stat: 'relation.trust', minimum: 4 },
	{ actionId: 'kiss', stat: 'relation.desire', minimum: 3 },
	{ actionId: 'intimacy', stat: 'relation.affection', minimum: 8 },
	{ actionId: 'intimacy', stat: 'relation.trust', minimum: 7 },
	{ actionId: 'intimacy', stat: 'relation.desire', minimum: 9 }
];

export const ACTION_REQUIREMENT_LABELS: Record<ActionRequirementStat, string> = {
	'base.energy': 'BASE 체력',
	'talent.pride': 'TALENT 자존심', 'talent.openness': 'TALENT 개방성', 'talent.libido': 'TALENT 기본 욕구',
	'talent.modesty': 'TALENT 수치심 성향', 'talent.assertiveness': 'TALENT 주도성', 'talent.receptiveness': 'TALENT 수용성', 'talent.curiosity': 'TALENT 호기심',
	'abl.conversation': 'ABL 대화', 'abl.empathy': 'ABL 공감', 'abl.seduction': 'ABL 유혹', 'abl.intimacy': 'ABL 친밀함',
	'exp.social': 'EXP 사회 경험', 'exp.romantic': 'EXP 연애 경험', 'exp.seduction': 'EXP 유혹 경험', 'exp.intimacy': 'EXP 친밀 경험',
	'relation.affection': '호감', 'relation.trust': '신뢰', 'relation.desire': '욕망', 'relation.attachment': '애착',
	'relation.jealousy': '질투', 'relation.resentment': '반감',
	'palam.rapport': 'PALAM 교감', 'palam.comfort': 'PALAM 편안함', 'palam.arousal': 'PALAM 흥분', 'palam.pleasure': 'PALAM 쾌감',
	'palam.embarrassment': 'PALAM 부끄러움', 'palam.tension': 'PALAM 긴장', 'palam.frustration': 'PALAM 좌절', 'palam.satisfaction': 'PALAM 만족'
};

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

export function actionRequirementMaximum(stat: ActionRequirementStat): number | undefined {
	return stat.startsWith('talent.') || stat.startsWith('relation.') || stat.startsWith('palam.') ? 100 : undefined;
}

export function normalizeActionRequirements(raw: unknown): ActionRequirement[] {
	if (raw === undefined || raw === null) return DEFAULT_ACTION_REQUIREMENTS.map((requirement) => ({ ...requirement }));
	if (!Array.isArray(raw)) return DEFAULT_ACTION_REQUIREMENTS.map((requirement) => ({ ...requirement }));
	const actions = new Set<string>(ACTION_REQUIREMENT_ACTIONS);
	const stats = new Set<string>(ACTION_REQUIREMENT_STATS);
	const normalized: ActionRequirement[] = [];
	const seen = new Set<string>();
	for (const value of raw.slice(0, 50)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		const candidate = value as Record<string, unknown>;
		if (!actions.has(String(candidate.actionId)) || !stats.has(String(candidate.stat)) ||
			typeof candidate.minimum !== 'number' || !Number.isSafeInteger(candidate.minimum) || candidate.minimum < 0) continue;
		const requirement = candidate as unknown as ActionRequirement;
		const maximum = actionRequirementMaximum(requirement.stat);
		if (maximum !== undefined && requirement.minimum > maximum) continue;
		const key = `${requirement.actionId}:${requirement.stat}`;
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push({ actionId: requirement.actionId, stat: requirement.stat, minimum: requirement.minimum });
	}
	return normalized;
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
	actionRequirements: ActionRequirement[];
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
	embarrassment?: number;
	frustration?: number;
	satisfaction?: number;
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

export const NARRATIVE_MODES = [
	{ value: 'restrained', label: '절제됨', description: '일상과 감정을 간결하게 쓰고 성적 장면도 여운과 암시를 중심으로 묘사합니다.' },
	{ value: 'sensual', label: '관능적', description: '감각과 분위기, 직접적인 표현을 섞되 과도한 수사와 반복을 피합니다.' },
	{ value: 'explicit', label: '노골적', description: '성적 장면에서 생략하거나 돌려 말하지 않고 행위와 신체 반응을 직접 묘사합니다.' }
] as const;
export type NarrativeMode = typeof NARRATIVE_MODES[number]['value'];

export function normalizeNarrativeMode(value: unknown): NarrativeMode {
	return NARRATIVE_MODES.some((mode) => mode.value === value) ? value as NarrativeMode : 'sensual';
}

export type GenerationJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface GenerationJob {
	id: string;
	loreId: string;
	kind: 'advance' | 'act' | 'free' | 'accept' | 'decline';
	status: GenerationJobStatus;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	error: string | null;
	resultEventId: number | null;
}

export interface ScenarioConfig {
	worldSetting: string;
	eraRules: string;
	narrativeMode: NarrativeMode;
	worldMemory: string;
	sceneNote: string;
	pendingProposal: Proposal | null;
	playerSuggestions: PlayerSuggestionSet | null;
}

export interface GameView {
	lore: LoreSummary;
	lores: LoreSummary[];
	world: WorldState;
	config: ScenarioConfig;
	characters: Character[];
	characterTemplates: Character[];
	modules: InstalledModule[];
	worldLore: WorldLore[];
	characterLore: CharacterLore[];
	events: EventRecord[];
	memories: Array<Pick<MemoryRecord, 'id' | 'eventId' | 'characterId' | 'summary' | 'isDetail' | 'createdTurn'>>;
	saves: SaveSlot[];
	latestNarrative: string;
	latestRenderer: 'template' | 'llm';
}
