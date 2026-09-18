export type ActionId = 'talk' | 'listen' | 'flirt' | 'kiss' | 'intimacy' | 'rest';

export interface BaseStats {
	energy: number;
	maxEnergy: number;
}

export interface Character {
	id: string;
	name: string;
	age: number;
	portrait: string;
	introduction: string;
	profile: string;
	base: BaseStats;
	trait: string[];
	abl: { conversation: number; empathy: number; seduction: number };
	exp: { conversation: number; empathy: number; seduction: number };
	mark: string[];
	relation: { affection: number; trust: number; desire: number };
	palam: { rapport: number; trust: number; arousal: number; pleasure: number };
}

export interface WorldState {
	turn: number;
	day: number;
	minute: number;
	location: string;
}

export interface Source {
	rapport?: number;
	trust?: number;
	desire?: number;
	arousal?: number;
	pleasure?: number;
	recovery?: number;
}

export interface EventRecord {
	id: number;
	turn: number;
	day: number;
	minute: number;
	location: string;
	actionId: ActionId | 'advance' | 'decline' | 'custom';
	characterId: string | null;
	summary: string;
	source: Source;
	changes: Record<string, number>;
	narrative: string;
	renderer: 'template' | 'llm';
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
	world: WorldState;
	config: ScenarioConfig;
	player: BaseStats;
	characters: Character[];
	events: EventRecord[];
	memories: Array<Pick<MemoryRecord, 'id' | 'eventId' | 'characterId' | 'summary' | 'isDetail' | 'createdTurn'>>;
	saves: SaveSlot[];
	latestNarrative: string;
	latestRenderer: 'template' | 'llm';
}
