import { applyAction, availableActions, beginTurn, observation, residents, templateFor } from './runtime.ts';
import { checkedExpression } from './performance.ts';
import { applyReflection, reflectionContext } from './reflection.ts';
import { applyAppearance, needsAppearance } from './appearance.ts';
import type { ActorPerformance, CharacterReflection, OutfitOption, PlayerRequest, ReflectionContext, StageAction, TurnProgress, World } from './types.ts';

export interface ActorDecision { act: boolean; model: string }
export interface Director {
	chooseAppearance?(state: Record<string, unknown>, outfits: OutfitOption[]): Promise<{ outfitId: string; model: string }>;
	reflect(state: Record<string, unknown>, context: ReflectionContext): Promise<CharacterReflection>;
	decide(state: Record<string, unknown>): Promise<ActorDecision>;
	perform(state: Record<string, unknown>, actions: StageAction[]): Promise<ActorPerformance>;
}

interface TurnExecution {
	progress?: TurnProgress | null;
	onProgress?: (world: World, progress: TurnProgress) => void;
	nextInput?: (consumedInputs: number) => PlayerRequest | null;
}

/** Old one-pass jobs resume at their remaining actors without replaying committed events. */
export function restoredProgress(raw: unknown): TurnProgress | null {
	if (!raw) return null;
	const saved = raw as TurnProgress & { actorIds?: string[]; nextActorIndex?: number };
	if (saved.pendingActorIds) return structuredClone(saved);
	return { pendingActorIds: saved.actorIds!.slice(saved.nextActorIndex), completedDecisions: saved.nextActorIndex!, consumedInputs: 0 };
}

function castIds(world: World, targetId: string | null = null): string[] {
	const cast = residents(world).filter((actor) => templateFor(world, actor).kind === 'character');
	cast.sort((left, right) => Number(right.id === targetId) - Number(left.id === targetId));
	return cast.map((actor) => actor.id);
}

/** Publish only complete actions and a resume cursor; never publish incomplete model output. */
export async function resolveTurn(original: World, request: PlayerRequest, director: Director, checkpoint: () => void = () => {}, execution: TurnExecution = {}): Promise<World> {
	const draft = structuredClone(original);
	let progress = restoredProgress(execution.progress);
	if (!progress) {
		checkpoint();
		beginTurn(draft, request);
		const targetId = request.kind === 'speak' || request.kind === 'interact' ? request.targetId : null;
		progress = { pendingActorIds: castIds(draft, targetId), completedDecisions: 0, consumedInputs: 0 };
		execution.onProgress?.(draft, progress);
	}
	while (true) {
		checkpoint();
		// Consume chat at action boundaries; its event and consumed cursor commit together.
		const input = execution.nextInput?.(progress.consumedInputs);
		if (input) {
			beginTurn(draft, input);
			progress.consumedInputs++;
			const targetId = input.kind === 'speak' || input.kind === 'interact' ? input.targetId : null;
			progress.pendingActorIds = castIds(draft, targetId);
			execution.onProgress?.(draft, progress);
			continue;
		}
		const actorId = progress.pendingActorIds[0];
		if (!actorId) break;
		// Dress every newly encountered resident before anyone reasons about the scene.
		const dressingActor = residents(draft).find((actor) => templateFor(draft, actor).kind === 'character' && templateFor(draft, actor).wardrobe?.length && needsAppearance(draft, actor));
		if (dressingActor) {
			const template = templateFor(draft, dressingActor);
			if (!director.chooseAppearance) throw new Error('오늘의 옷차림 판단기가 필요합니다.');
			let selected;
			try { selected = await director.chooseAppearance(observation(draft, dressingActor), template.wardrobe!); }
			catch (error) {
				checkpoint();
				if (execution.nextInput?.(progress.consumedInputs)) continue;
				throw error;
			}
			checkpoint();
			if (execution.nextInput?.(progress.consumedInputs)) continue;
			applyAppearance(dressingActor, template, draft, selected.outfitId, selected.model);
			execution.onProgress?.(draft, progress);
			continue;
		}
		const eventStart = draft.state.events.length;
		const actor = draft.state.instances.find((candidate) => candidate.id === actorId);
		if (actor?.active && actor.sceneId === draft.state.activeSceneId) {
			const state = observation(draft, actor);
			const context = reflectionContext(draft, actor);
			if (context) {
				let reflection: CharacterReflection;
				// A backlog batch must not see later memories through the ordinary recent-event window.
				const reflectedState = { ...state, self: { ...(state.self as Record<string, unknown>), memories: context.evidenceEvents }, recentEvents: context.evidenceEvents };
				try { reflection = await director.reflect(reflectedState, context); }
				catch (error) {
					checkpoint();
					if (execution.nextInput?.(progress.consumedInputs)) continue;
					throw error;
				}
				checkpoint();
				if (execution.nextInput?.(progress.consumedInputs)) continue;
				applyReflection(actor, reflection, context);
				// Private state and its event cursor commit before deciding, without consuming the actor's turn.
				execution.onProgress?.(draft, progress);
				continue;
			}
			const actions = availableActions(draft, actor.id);
			let decision: ActorDecision;
			try { decision = await director.decide(state); }
			catch (error) {
				checkpoint();
				if (execution.nextInput?.(progress.consumedInputs)) continue;
				throw error;
			}
			checkpoint();
			if (execution.nextInput?.(progress.consumedInputs)) continue;
			if (typeof decision.act !== 'boolean') throw new Error('행동 여부 판단이 올바르지 않습니다.');
			if (!decision.act) {
				const wait = actions.find((action) => action.kind === 'wait')!;
				applyAction(draft, actor.id, wait, wait.label, { model: decision.model, choice: 'wait', acted: false });
			} else {
				const candidates = actions.filter((action) => action.kind !== 'wait');
				let performance: ActorPerformance;
				try { performance = await director.perform(state, candidates); }
				catch (error) {
					checkpoint();
					if (execution.nextInput?.(progress.consumedInputs)) continue;
					throw error;
				}
				const { model, ...output } = performance;
				checkpoint();
				if (execution.nextInput?.(progress.consumedInputs)) continue;
				const expression = checkedExpression(output, candidates);
				const action = candidates.find((candidate) => candidate.id === expression.actionId)!;
				const text = [expression.narrative, expression.utterance].filter(Boolean).join('\n') || action.label;
				applyAction(draft, actor.id, action, text, { model: decision.model, choice: action.id, acted: true, generationModel: model }, expression);
				if (expression.memoUpdate) actor.memo = expression.memoUpdate;
			}
		}
		progress.pendingActorIds.shift();
		progress.completedDecisions++;
		// Only a new witnessed action wakes another decision. Waiting never wakes itself or its peers.
		const emitted = draft.state.events.slice(eventStart).filter((event) => event.kind !== 'wait');
		for (const id of castIds(draft)) {
			const witness = draft.state.instances.find((candidate) => candidate.id === id)!;
			if (emitted.some((event) => event.actorId !== id && witness.memories.some((memory) => memory.eventId === event.id)) && !progress.pendingActorIds.includes(id)) {
				progress.pendingActorIds.push(id);
			}
		}
		checkpoint();
		execution.onProgress?.(draft, progress);
	}
	return draft;
}
