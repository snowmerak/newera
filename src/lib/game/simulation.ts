import { clampBase, clampCount, clampPercent, relationTo, type BaseStats, type Character, type CustomState } from './types.ts';

export type SimulationActionId = 'conversation';
export type Outcome = 'negative' | 'neutral' | 'positive';

export interface Situation {
	id: string;
	location: string;
	participants: string[];
	activeCharacterId: string | null;
	availableActionIds: SimulationActionId[];
}

export interface SourceEffect {
	energy: number;
	rapport: number;
	comfort: number;
	tension: number;
	trust: number;
	affection: number;
}

export interface SemanticEvent {
	type: SimulationActionId;
	actorId: 'player';
	targetId: string;
	outcome: Outcome;
	effects: SourceEffect;
	acquiredMarks: string[];
}

export interface StateChange {
	path: string;
	before: number | string[];
	after: number | string[];
}

export interface SimulationLogEntry {
	id: number;
	actionId: SimulationActionId;
	actorId: 'player';
	targetId: string;
	source: SourceEffect;
	event: SemanticEvent;
	changes: StateChange[];
	renderedText: string | null;
}

export interface SimulationState {
	player: BaseStats;
	characters: Character[];
	situation: Situation;
	cflag: CustomState;
	eventLog: SimulationLogEntry[];
}

export interface ActionContext {
	state: SimulationState;
	actorId: 'player';
	target: Character;
}

export interface ActionDefinition {
	id: SimulationActionId;
	label: string;
	description: string;
	preconditions: (context: ActionContext) => string | null;
	costs: (context: ActionContext) => Pick<SourceEffect, 'energy'>;
	resolve: (context: ActionContext) => Omit<SourceEffect, 'energy'>;
}

export interface ActionResult {
	state: SimulationState;
	source: SourceEffect;
	event: SemanticEvent;
	changes: StateChange[];
}

export const SIMULATION_ACTIONS: Record<SimulationActionId, ActionDefinition> = {
	conversation: {
		id: 'conversation',
		label: '대화한다',
		description: '상대와 이야기를 나누며 관계를 쌓는다. 체력 2 소모.',
		preconditions: ({ state }) => state.player.energy < 2 ? '기력이 부족합니다.' : null,
		costs: () => ({ energy: -2 }),
		resolve: ({ target }) => {
			const relation = relationTo(target);
			const pridePenalty = target.talent.pride >= 75 && relation.trust < 25 ? 2 : 0;
			const rapport = Math.max(-3, 2 + Math.floor(target.abl.conversation / 2)
				+ Math.floor(target.talent.openness / 30) + Math.floor(relation.affection / 25)
				+ Math.floor(target.palam.comfort / 25) - Math.floor(target.palam.tension / 25) - pridePenalty);
			const comfort = 1 + Math.floor(target.abl.empathy / 2) + Math.floor(relation.trust / 30)
				- Math.floor(target.palam.tension / 30);
			return {
				rapport, comfort,
				tension: pridePenalty ? 2 : comfort > 1 ? -1 : 0,
				trust: rapport >= 2 ? 1 : 0,
				affection: rapport >= 5 ? 1 : 0
			};
		}
	}
};

export function createSimulation(player: BaseStats, characters: Character[], location: string): SimulationState {
	return {
		player: { ...player },
		characters: structuredClone(characters),
		situation: {
			id: 'current-scene', location,
			participants: ['player', ...characters.map((character) => character.id)],
			activeCharacterId: characters[0]?.id ?? null,
			availableActionIds: ['conversation']
		},
		cflag: {}, eventLog: []
	};
}

export function selectActiveCharacter(state: SimulationState, id: string): SimulationState {
	if (!state.characters.some((character) => character.id === id) || !state.situation.participants.includes(id)) {
		throw new Error('현재 상황에 참여한 인물을 선택해 주세요.');
	}
	return { ...state, situation: { ...state.situation, activeCharacterId: id } };
}

export function actionUnavailableReason(state: SimulationState, actionId: SimulationActionId): string | null {
	if (!state.situation.availableActionIds.includes(actionId)) return '현재 상황에서 할 수 없는 행동입니다.';
	const id = state.situation.activeCharacterId;
	const target = state.characters.find((character) => character.id === id);
	if (!id || !target || !state.situation.participants.includes(id)) return '대화할 인물을 선택해 주세요.';
	return SIMULATION_ACTIONS[actionId].preconditions({ state, actorId: 'player', target });
}

export function resolveAction(state: SimulationState, actionId: SimulationActionId): ActionResult {
	const reason = actionUnavailableReason(state, actionId);
	if (reason) throw new Error(reason);
	const target = state.characters.find((character) => character.id === state.situation.activeCharacterId)!;
	const definition = SIMULATION_ACTIONS[actionId];
	const context: ActionContext = { state, actorId: 'player', target };
	const source: SourceEffect = { ...definition.costs(context), ...definition.resolve(context) };
	const player = clampBase({ ...state.player, energy: state.player.energy + source.energy });
	const previousRelation = relationTo(target);
	const relation = {
		...previousRelation,
		trust: clampPercent(previousRelation.trust + source.trust),
		affection: clampPercent(previousRelation.affection + source.affection)
	};
	const mark = [...target.mark];
	if (!mark.includes('firstConversation')) mark.push('firstConversation');
	if (relation.trust >= 10 && !mark.includes('becameFriend')) mark.push('becameFriend');
	const acquiredMarks = mark.filter((value) => !target.mark.includes(value));
	const updated: Character = {
		...target,
		palam: { ...target.palam,
			rapport: clampPercent(target.palam.rapport + source.rapport),
			comfort: clampPercent(target.palam.comfort + source.comfort),
			tension: clampPercent(target.palam.tension + source.tension)
		},
		exp: { ...target.exp, social: clampCount(target.exp.social + 1) },
		relations: { ...target.relations, player: relation },
		mark
	};
	const changes: StateChange[] = [
		{ path: 'player.BASE.energy', before: state.player.energy, after: player.energy },
		{ path: `${target.name}.PALAM.rapport`, before: target.palam.rapport, after: updated.palam.rapport },
		{ path: `${target.name}.PALAM.comfort`, before: target.palam.comfort, after: updated.palam.comfort },
		{ path: `${target.name}.PALAM.tension`, before: target.palam.tension, after: updated.palam.tension },
		{ path: `${target.name}.EXP.social`, before: target.exp.social, after: updated.exp.social },
		{ path: `${target.name}.RELATION.player.trust`, before: previousRelation.trust, after: relation.trust },
		{ path: `${target.name}.RELATION.player.affection`, before: previousRelation.affection, after: relation.affection }
	];
	if (acquiredMarks.length) changes.push({ path: `${target.name}.MARK`, before: [...target.mark], after: [...mark] });
	const score = source.rapport + source.comfort - Math.max(0, source.tension);
	const event: SemanticEvent = {
		type: actionId, actorId: 'player', targetId: target.id,
		outcome: score >= 5 ? 'positive' : score >= 2 ? 'neutral' : 'negative',
		effects: { ...source }, acquiredMarks
	};
	const entry: SimulationLogEntry = {
		id: state.eventLog.length + 1, actionId, actorId: 'player', targetId: target.id,
		source: { ...source }, event, changes, renderedText: null
	};
	return {
		state: { ...state, player, characters: state.characters.map((character) => character.id === target.id ? updated : character), eventLog: [...state.eventLog, entry] },
		source, event, changes
	};
}

export function attachRenderedText(state: SimulationState, text: string): SimulationState {
	if (state.eventLog.length === 0) throw new Error('출력을 연결할 사건이 없습니다.');
	return {
		...state,
		eventLog: state.eventLog.map((entry, index) => index === state.eventLog.length - 1 ? { ...entry, renderedText: text } : entry)
	};
}
