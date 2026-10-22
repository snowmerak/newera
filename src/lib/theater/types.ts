export type Value = string | number | boolean | null;
export type Properties = Record<string, Value>;
export type EntityKind = 'character' | 'object';
export type EventKind = 'speak' | 'interact' | 'wait' | 'move' | 'enter' | 'leave' | 'change';

export interface Condition { key: string; equals: Value }
export interface Interaction {
	id: string;
	label: string;
	description: string;
	conditions: Condition[];
	effects: Properties;
}
export interface ObjectReaction {
	id: string;
	on: EventKind;
	/** Whether this object must be the explicit target of the triggering event. */
	targeted: boolean;
	conditions: Condition[];
	effects: Properties;
	text: string;
}
export interface OutfitOption { id: string; name: string; appearance: string; context: string }
export interface AppearanceSelection { day: number; minute?: number; sceneId?: string; outfitId: string | null; model: string }
export interface EntityTemplate {
	id: string;
	kind: EntityKind;
	name: string;
	description: string;
	personality: string;
	goals: string[];
	baseAppearance?: string;
	clothingPreferences?: string;
	foodPreferences?: string;
	wardrobe?: OutfitOption[];
	initialState: Properties;
	interactions: Interaction[];
	reactions: ObjectReaction[];
}
export interface Scene {
	id: string;
	name: string;
	description: string;
	/** Directed graph edges: only these scenes can be reached in a single move. */
	exits: string[];
}
export interface Spawn {
	id: string;
	templateId: string;
	sceneId: string;
	name: string;
	companion: boolean;
	/** Visible current appearance; separate from private state and impressions. */
	appearance?: string;
	/** Player-known starting relationship, not the character's private opinion. */
	playerContext?: string;
	state: Properties;
	relationships?: Relationships;
}
export const relationshipMetrics = ['trust', 'affinity', 'closeness', 'respect', 'wariness'] as const;
export type RelationshipMetric = typeof relationshipMetrics[number];
export type RelationshipScores = Record<RelationshipMetric, number | null>;
export interface Relationship extends RelationshipScores {
	impression: string;
	evidenceEventIds: string[];
}
export type Relationships = Record<string, Relationship>;
export interface RelationshipUpdate {
	targetId: string;
	changes: { field: RelationshipMetric; value: number | null }[];
	/** null preserves the existing impression. */
	impression: string | null;
	evidenceEventIds: string[];
}
export interface ReflectionContext {
	newEvents: WitnessedEvent[];
	evidenceEvents: WitnessedEvent[];
	targets: { id: string; name: string }[];
}
export interface CharacterReflection {
	relationshipUpdates: RelationshipUpdate[];
	memoUpdate: CharacterMemo | null;
}
export interface WorldDefinition {
	name: string;
	description: string;
	rules: string;
	/** Expression guidance for generated narration and dialogue; does not alter action rules. */
	writingStyle?: string;
	startingSceneId: string;
	scenes: Scene[];
	templates: EntityTemplate[];
	spawns: Spawn[];
	/** Minimum elapsed minutes before a different scene can prompt another outfit choice. */
	appearanceChangeMinutes?: number;
}
export interface EventBody {
	narrative: string | null;
	utterance: string | null;
}
export interface WitnessedEvent {
	eventId: string;
	tick: number;
	sceneId: string;
	kind: EventKind;
	/** Assigned by the host that executed the event, never by a model. */
	actorId: string;
	targetId: string | null;
	body: EventBody;
	interactionId?: string;
	destinationId?: string;
	changes?: Properties;
}
export interface LegacyMemory {
	eventId: string;
	tick: number;
	text: string;
}
export const inactivityModes = ['watch', 'continue', 'idle'] as const;
export type InactivityMode = typeof inactivityModes[number];
export const inactivityLabels: Record<InactivityMode, string> = { watch: '지켜본다', continue: '하던 일을 계속한다', idle: '아무것도 하지 않는다' };
export interface InactivitySelection { mode: InactivityMode; tick: number; model: string }
export type EntityMemory = WitnessedEvent | LegacyMemory;
export interface EntityInstance extends Spawn {
	active: boolean;
	memories: EntityMemory[];
	memo?: CharacterMemo | null;
	relationships: Relationships;
	reflectedThroughEventId: string | null;
	appearanceSelection?: AppearanceSelection;
	/** Latest non-participation choice; silent choices are private state, not witnessed events. */
	inactivity?: InactivitySelection;
}
export interface CharacterMemo {
	summary: string;
	currentIntention: string;
	feelings: string[];
	openThreads: string[];
}
export interface ActorExpression {
	actionId: string;
	targetId: string | null;
	narrative: string | null;
	utterance: string | null;
	memoUpdate: CharacterMemo | null;
}
export interface ActorPerformance extends ActorExpression { model: string }
export interface DecisionTrace {
	model: string;
	choice: string;
	acted?: boolean;
	generationModel?: string;
	/** Optional metadata from previously saved scene records; new decisions do not produce it. */
	reaction?: number;
	intensity?: number;
}
export interface CharacterPresentation { playerContext?: string; appearance?: string }
export interface StageEvent {
	id: string;
	tick: number;
	sceneId: string;
	kind: EventKind;
	actorId: string;
	targetId: string | null;
	text: string;
	interactionId?: string;
	destinationId?: string;
	changes?: Properties;
	decision?: DecisionTrace;
	narrative?: string;
	utterance?: string;
	/** Player-facing introduction captured at this event; excluded from witnessed action memory. */
	presentation?: CharacterPresentation;
}
export interface WorldState {
	tick: number;
	day: number;
	minute: number;
	activeSceneId: string;
	instances: EntityInstance[];
	events: StageEvent[];
}
export interface ModelSelection {
	decisionModel: string;
	textModel: string;
}
export interface World {
	id: string;
	revision: number;
	definition: WorldDefinition;
	state: WorldState;
	models?: ModelSelection | null;
}
export interface WorldSummary { id: string; name: string; revision: number }
export interface StageAction {
	id: string;
	kind: 'wait' | 'speak' | 'interact' | 'move';
	label: string;
	targetId: string | null;
	interactionId?: string;
	destinationId?: string;
}
export type PlayerRequest =
	| { kind: 'speak'; text: string; targetId: string | null }
	| { kind: 'wait' }
	| { kind: 'move'; destinationId: string }
	| { kind: 'interact'; targetId: string; interactionId: string };
export interface TurnProgress {
	pendingActorIds: string[];
	completedDecisions: number;
	consumedInputs: number;
}
export interface GenerationJob {
	id: string;
	worldId: string;
	revision: number;
	status: 'pending' | 'running' | 'completed' | 'failed';
	request: PlayerRequest;
	createdAt: string;
	error: string | null;
	progress: TurnProgress | null;
	models: ModelSelection | null;
}
export interface SaveSlot { slot: number; tick: number; savedAt: string }
export interface StageView {
	world: World;
	worlds: WorldSummary[];
	generation: GenerationJob | null;
	saves: SaveSlot[];
}
