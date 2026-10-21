import { applyAction, availableActions, beginTurn, observation, residents, templateFor } from './runtime.ts';
import { checkedExpression } from './performance.ts';
import type { ActorPerformance, PlayerRequest, StageAction, TurnProgress, World } from './types.ts';

export interface ActorDecision { act: boolean; model: string }
export interface Director {
	decide(state: Record<string, unknown>): Promise<ActorDecision>;
	perform(state: Record<string, unknown>, actions: StageAction[]): Promise<ActorPerformance>;
}

interface TurnExecution {
	progress?: TurnProgress | null;
	onProgress?: (world: World, progress: TurnProgress) => void;
}

/** Publish only complete actions and a resume cursor; never publish incomplete model output. */
export async function resolveTurn(original: World, request: PlayerRequest, director: Director, checkpoint: () => void = () => {}, execution: TurnExecution = {}): Promise<World> {
	const draft = structuredClone(original);
	let progress = execution.progress ? structuredClone(execution.progress) : null;
	if (!progress) {
		checkpoint();
		beginTurn(draft, request);
		const cast = residents(draft).filter((actor) => templateFor(draft, actor).kind === 'character');
		// Retain this order on restart, including actors whose completed action moved them out of the scene.
		const targetId = request.kind === 'speak' || request.kind === 'interact' ? request.targetId : null;
		cast.sort((left, right) => Number(right.id === targetId) - Number(left.id === targetId));
		progress = { actorIds: cast.map((actor) => actor.id), nextActorIndex: 0 };
		execution.onProgress?.(draft, progress);
	}
	for (let index = progress.nextActorIndex; index < progress.actorIds.length; index++) {
		checkpoint();
		const actor = draft.state.instances.find((candidate) => candidate.id === progress.actorIds[index]);
		if (actor?.active && actor.sceneId === draft.state.activeSceneId) {
			const state = observation(draft, actor);
			const actions = availableActions(draft, actor.id);
			const decision = await director.decide(state);
			checkpoint();
			if (typeof decision.act !== 'boolean') throw new Error('행동 여부 판단이 올바르지 않습니다.');
			if (!decision.act) {
				const wait = actions.find((action) => action.kind === 'wait')!;
				applyAction(draft, actor.id, wait, wait.label, { model: decision.model, choice: 'wait', acted: false });
			} else {
				const candidates = actions.filter((action) => action.kind !== 'wait');
				const { model, ...output } = await director.perform(state, candidates);
				checkpoint();
				const expression = checkedExpression(output, candidates);
				const action = candidates.find((candidate) => candidate.id === expression.actionId)!;
				const text = [expression.narrative, expression.utterance].filter(Boolean).join('\n') || action.label;
				applyAction(draft, actor.id, action, text, { model: decision.model, choice: action.id, acted: true, generationModel: model }, expression);
				if (expression.memoUpdate) actor.memo = expression.memoUpdate;
			}
		}
		progress.nextActorIndex = index + 1;
		checkpoint();
		execution.onProgress?.(draft, progress);
	}
	return draft;
}
