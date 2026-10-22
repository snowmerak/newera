import type { DecisionTrace, EntityInstance, EntityTemplate, EventBody, Interaction, PlayerRequest, Properties, StageAction, StageEvent, World, WorldDefinition, WorldState } from './types.ts';
import { memoryForEvent, witnessedMemories } from './memory.ts';
import { nextPresentation } from './presentation.ts';

export function initialState(definition: WorldDefinition): WorldState {
	return {
		tick: 0, day: 1, minute: 18 * 60, activeSceneId: definition.startingSceneId, events: [],
		instances: definition.spawns.map((spawn) => ({
			...structuredClone(spawn), active: true, memories: [], memo: null, relationships: structuredClone(spawn.relationships ?? {}), reflectedThroughEventId: null,
			state: { ...definition.templates.find((template) => template.id === spawn.templateId)!.initialState, ...spawn.state }
		}))
	};
}

export function templateFor(world: World, instance: EntityInstance): EntityTemplate {
	const template = world.definition.templates.find((candidate) => candidate.id === instance.templateId);
	if (!template) throw new Error('인스턴스의 원형을 찾을 수 없습니다.');
	return template;
}

export function residents(world: World, sceneId = world.state.activeSceneId): EntityInstance[] {
	return world.state.instances.filter((instance) => instance.active && instance.sceneId === sceneId);
}

export function interactionsFor(world: World, instance: EntityInstance): Interaction[] {
	return templateFor(world, instance).interactions.filter((interaction) =>
		interaction.conditions.every((condition) => instance.state[condition.key] === condition.equals));
}

function instanceInScene(world: World, id: string, sceneId: string): EntityInstance {
	const instance = world.state.instances.find((candidate) => candidate.id === id && candidate.active && candidate.sceneId === sceneId);
	if (!instance) throw new Error('대상이 현재 씬에 없습니다.');
	return instance;
}

function event(world: World, input: Omit<StageEvent, 'id' | 'tick'>): StageEvent {
	const presentation = nextPresentation(world, input.actorId);
	const result = { ...input, ...(presentation ? { presentation } : {}), tick: world.state.tick, id: globalThis.crypto.randomUUID() };
	world.state.events.push(result);
	// A private memory records only events witnessed in this scene. No world-wide transcript is leaked to actors.
	for (const instance of residents(world, input.sceneId)) {
		if (templateFor(world, instance).kind !== 'character') continue;
		instance.memories.push(memoryForEvent(result));
	}
	return result;
}

export function actorName(world: World, actorId: string): string {
	return actorId === 'player' ? '나' : world.state.instances.find((instance) => instance.id === actorId)?.name ?? '무대';
}

function reactObjects(world: World, trigger: StageEvent): void {
	// Object components see this event once; their emitted changes do not recursively re-trigger themselves.
	for (const instance of residents(world, trigger.sceneId)) {
		const template = templateFor(world, instance);
		if (template.kind !== 'object') continue;
		for (const reaction of template.reactions) {
			if (reaction.on !== trigger.kind || (reaction.targeted && trigger.targetId !== instance.id)) continue;
			if (!reaction.conditions.every((condition) => instance.state[condition.key] === condition.equals)) continue;
			Object.assign(instance.state, reaction.effects);
			event(world, { sceneId: instance.sceneId, kind: 'change', actorId: instance.id, targetId: null, text: reaction.text, changes: { ...reaction.effects } });
		}
	}
}

function move(world: World, actorId: string, destinationId: string, text: string, body?: EventBody): StageEvent {
	const actor = actorId === 'player' ? null : world.state.instances.find((instance) => instance.id === actorId && instance.active);
	const originId = actor ? actor.sceneId : world.state.activeSceneId;
	const scene = world.definition.scenes.find((candidate) => candidate.id === originId);
	if (!scene?.exits.includes(destinationId)) throw new Error('현재 씬에서 이동할 수 없는 곳입니다.');
	const destination = world.definition.scenes.find((candidate) => candidate.id === destinationId)!;
	const departing = event(world, { sceneId: originId, kind: 'leave', actorId, targetId: null, destinationId, text, narrative: body?.narrative ?? undefined, utterance: body?.utterance ?? undefined });
	reactObjects(world, departing);
	const followers = actorId === 'player'
		? residents(world, originId).filter((instance) => instance.companion)
		: [];
	for (const follower of followers) {
		event(world, { sceneId: originId, kind: 'leave', actorId: follower.id, targetId: null, destinationId, text: `${destination.name}(으)로 동행한다.` });
	}
	if (actor) actor.sceneId = destinationId;
	else world.state.activeSceneId = destinationId;
	for (const follower of followers) follower.sceneId = destinationId;
	const arrival = event(world, { sceneId: destinationId, kind: 'enter', actorId, targetId: null, destinationId, text: `${destination.name}에 들어왔다.` });
	reactObjects(world, arrival);
	for (const follower of followers) {
		const entered = event(world, { sceneId: destinationId, kind: 'enter', actorId: follower.id, targetId: null, text: '함께 도착했다.' });
		reactObjects(world, entered);
	}
	// The generated description belongs to the departure; arrival has its own scene event.
	return departing;
}

export function applyAction(world: World, actorId: string, action: StageAction, text: string, decision?: DecisionTrace, body?: EventBody): StageEvent {
	const actor = actorId === 'player' ? null : instanceInScene(world, actorId, world.state.activeSceneId);
	if (actor && templateFor(world, actor).kind !== 'character') throw new Error('오브젝트는 자율 행동을 선택할 수 없습니다.');
	if (action.kind === 'move') {
		if (!action.destinationId) throw new Error('이동할 씬이 필요합니다.');
		const result = move(world, actorId, action.destinationId, text, body);
		result.decision = decision;
		return result;
	}
	if (action.targetId && action.targetId !== 'player') instanceInScene(world, action.targetId, world.state.activeSceneId);
	if (action.targetId === actorId) throw new Error('자기 자신을 대상으로 할 수 없습니다.');
	let changes: Properties | undefined;
	let narrative = body?.narrative ?? undefined;
	if (action.kind === 'interact') {
		const target = instanceInScene(world, action.targetId ?? '', world.state.activeSceneId);
		const interaction = interactionsFor(world, target).find((candidate) => candidate.id === action.interactionId);
		if (!interaction) throw new Error('현재 상태에서 사용할 수 없는 상호작용입니다.');
		changes = { ...interaction.effects };
		if (!body) narrative = interaction.description || interaction.label;
		Object.assign(target.state, changes);
	}
	const result = event(world, { sceneId: world.state.activeSceneId, kind: action.kind, actorId, targetId: action.targetId, text, interactionId: action.interactionId, changes, decision, narrative, utterance: body?.utterance ?? undefined });
	reactObjects(world, result);
	return result;
}

export function availableActions(world: World, actorId: string): StageAction[] {
	const actions: StageAction[] = [{ id: 'wait', kind: 'wait', label: '잠시 지켜본다', targetId: null }];
	if (actorId !== 'player') actions.push({ id: 'speak:player', kind: 'speak', label: '플레이어에게 말한다', targetId: 'player' });
	for (const instance of residents(world)) {
		if (instance.id === actorId) continue;
		if (templateFor(world, instance).kind === 'character') {
			actions.push({ id: `speak:${instance.id}`, kind: 'speak', label: `${instance.name}에게 말한다`, targetId: instance.id });
		}
		for (const interaction of interactionsFor(world, instance)) {
			actions.push({ id: `interact:${instance.id}:${interaction.id}`, kind: 'interact', label: `${instance.name}: ${interaction.label}`, targetId: instance.id, interactionId: interaction.id });
		}
	}
	const actor = world.state.instances.find((instance) => instance.id === actorId);
	// Following belongs to the party lifecycle. A companion can still choose its own speech and interactions.
	if (!actor?.companion) {
		const scene = world.definition.scenes.find((candidate) => candidate.id === world.state.activeSceneId)!;
		for (const destinationId of scene.exits) {
			actions.push({ id: `move:${destinationId}`, kind: 'move', label: `${world.definition.scenes.find((candidate) => candidate.id === destinationId)!.name}(으)로 이동한다`, targetId: null, destinationId });
		}
	}
	return actions;
}

export function actionForRequest(world: World, request: PlayerRequest): StageAction {
	if (request.kind === 'speak') {
		if (!request.text.trim() || request.text.length > 4000) throw new Error('말할 내용을 1~4000자로 입력해 주세요.');
		if (request.targetId) {
			const target = instanceInScene(world, request.targetId, world.state.activeSceneId);
			if (templateFor(world, target).kind !== 'character') throw new Error('대화 상대는 등장인물이어야 합니다.');
		}
		return { id: 'speak', kind: 'speak', label: request.text.trim(), targetId: request.targetId };
	}
	const result = availableActions(world, 'player').find((action) => action.kind === request.kind &&
		(request.kind !== 'move' || action.destinationId === request.destinationId) &&
		(request.kind !== 'interact' || (action.targetId === request.targetId && action.interactionId === request.interactionId)));
	if (!result) throw new Error('현재 씬에서 할 수 없는 행동입니다.');
	return result;
}

export function beginTurn(world: World, request: PlayerRequest): StageEvent {
	const action = actionForRequest(world, request);
	world.state.tick += 1;
	const minute = world.state.minute + (request.kind === 'wait' ? 5 : 1);
	world.state.day += Math.floor(minute / 1440);
	world.state.minute = minute % 1440;
	return applyAction(world, 'player', action, action.label);
}

export function observation(world: World, actor: EntityInstance): Record<string, unknown> {
	const template = templateFor(world, actor);
	const memories = witnessedMemories(world.state.events, actor.memories, 16);
	return {
		world: { name: world.definition.name, description: world.definition.description, rules: world.definition.rules },
		scene: world.definition.scenes.find((scene) => scene.id === actor.sceneId),
		time: { tick: world.state.tick, day: world.state.day, minute: world.state.minute },
		self: { ...actor, relationships: actor.relationships ?? {}, memories, description: template.description, personality: template.personality, goals: template.goals, clothingPreferences: template.clothingPreferences ?? '', foodPreferences: template.foodPreferences ?? '' },
		player: { id: 'player', name: '플레이어', present: actor.sceneId === world.state.activeSceneId },
		present: residents(world, actor.sceneId).filter((other) => other.id !== actor.id).map((other) => ({
			id: other.id, name: other.name, kind: templateFor(world, other).kind, description: templateFor(world, other).description,
			appearance: other.appearance ?? '',
			state: templateFor(world, other).kind === 'object' ? other.state : undefined
		})),
		playerPresent: actor.sceneId === world.state.activeSceneId,
		// Restrict even recent events to what this instance actually witnessed.
		recentEvents: witnessedMemories(world.state.events, actor.memories, 12)
	};
}
