import { actionForRequest, applyAction, availableActions, beginTurn, observation, residents, templateFor } from './runtime.ts';
import type { DecisionTrace, PlayerRequest, StageAction, World } from './types.ts';

export interface ActorDecision extends DecisionTrace { action: StageAction }
export interface Director {
	decide(state: Record<string, unknown>, actions: StageAction[]): Promise<ActorDecision>;
	speak(state: Record<string, unknown>, decision: ActorDecision): Promise<string>;
}

/** Resolve one bounded reaction round against a private draft. The caller commits it atomically. */
export async function resolveTurn(original: World, request: PlayerRequest, director: Director, checkpoint: () => void = () => {}): Promise<World> {
	actionForRequest(original, request);
	const draft = structuredClone(original);
	beginTurn(draft, request);
	const cast = residents(draft).filter((actor) => templateFor(draft, actor).kind === 'character');
	// The addressee responds first. Each other resident then observes the events already resolved in this round.
	const targetId = request.kind === 'speak' || request.kind === 'interact' ? request.targetId : null;
	cast.sort((left, right) => Number(right.id === targetId) - Number(left.id === targetId));
	for (const actor of cast) {
		checkpoint();
		if (!actor.active || actor.sceneId !== draft.state.activeSceneId) continue;
		const state = observation(draft, actor);
		const actions = availableActions(draft, actor.id);
		const decision = await director.decide(state, actions);
		checkpoint();
		const action = actions.find((candidate) => candidate.id === decision.action.id);
		if (!action) throw new Error('판단 결과에 실행할 수 없는 행동이 포함되었습니다.');
		const text = action.kind === 'speak' ? await director.speak(state, decision) : action.label;
		checkpoint();
		applyAction(draft, actor.id, action, text, { model: decision.model, choice: action.id, reaction: decision.reaction, intensity: decision.intensity });
	}
	return draft;
}
