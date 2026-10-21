import { actionForRequest, applyAction, availableActions, beginTurn, observation, residents, templateFor } from './runtime.ts';
import { checkedExpression } from './performance.ts';
import type { ActorPerformance, PlayerRequest, StageAction, World } from './types.ts';

export interface ActorDecision { act: boolean; model: string }
export interface Director {
	decide(state: Record<string, unknown>): Promise<ActorDecision>;
	perform(state: Record<string, unknown>, actions: StageAction[]): Promise<ActorPerformance>;
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
		const decision = await director.decide(state);
		checkpoint();
		if (typeof decision.act !== 'boolean') throw new Error('행동 여부 판단이 올바르지 않습니다.');
		if (!decision.act) {
			const wait = actions.find((action) => action.kind === 'wait')!;
			applyAction(draft, actor.id, wait, wait.label, { model: decision.model, choice: 'wait', acted: false });
			continue;
		}
		const candidates = actions.filter((action) => action.kind !== 'wait');
		const { model, ...output } = await director.perform(state, candidates);
		checkpoint();
		const expression = checkedExpression(output, candidates);
		const action = candidates.find((candidate) => candidate.id === expression.actionId)!;
		const text = [expression.narrative, expression.utterance].filter(Boolean).join('\n') || action.label;
		const resolved = applyAction(draft, actor.id, action, text, { model: decision.model, choice: action.id, acted: true, generationModel: model });
		if (expression.narrative) resolved.narrative = expression.narrative;
		if (expression.utterance) resolved.utterance = expression.utterance;
		if (expression.memoUpdate) actor.memo = expression.memoUpdate;
	}
	return draft;
}
