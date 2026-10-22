import { memoryForEvent } from './memory.ts';
import type { World, WitnessedEvent } from './types.ts';

export const defaultGenerationHistoryTokens = 32768;
const encoder = new TextEncoder();

/** A model-independent estimate, not an exact tokenizer or a whole-prompt context guarantee. */
export function estimatedHistoryTokens(value: unknown): number {
	return Math.ceil(encoder.encode(JSON.stringify(value)).byteLength / 3);
}

/** Keep a chronological suffix of complete events. Never edit a quote to fit the budget. */
export function limitGenerationHistory<T>(events: readonly T[], tokenLimit = defaultGenerationHistoryTokens) {
	if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1) throw new Error('생성 히스토리 토큰 한도가 올바르지 않습니다.');
	let bytes = 2; // The serialized array brackets are part of the history budget.
	let start = events.length;
	for (let index = events.length - 1; index >= 0; index--) {
		const nextBytes = bytes + encoder.encode(JSON.stringify(events[index])).byteLength + (start === events.length ? 0 : 1);
		if (Math.ceil(nextBytes / 3) > tokenLimit) {
			if (start === events.length) throw new Error(`생성 히스토리의 최신 사건 하나가 ${tokenLimit} 추정 토큰 한도를 초과했습니다. 히스토리 한도를 늘려 주세요.`);
			break;
		}
		bytes = nextBytes;
		start = index;
	}
	return {
		events: events.slice(start),
		window: { tokenLimit, estimatedTokens: Math.ceil(bytes / 3), omittedEvents: start, truncated: start > 0, estimator: 'utf8-bytes-div-3' }
	};
}

export interface GenerationHistoryEvent extends WitnessedEvent {
	actorName: string;
	targetName: string | null;
	sceneName: string;
}

/** Replay only canonical events witnessed by this actor, including scene departures and arrivals. */
export function generationHistoryEvents(world: World, actorId: string): GenerationHistoryEvent[] {
	const actor = world.state.instances.find((instance) => instance.id === actorId);
	if (!actor) throw new Error('생성 히스토리의 인물을 찾을 수 없습니다.');
	const witnessed = new Set(actor.memories.map((memory) => memory.eventId));
	const names = new Map([['player', '플레이어'], ...world.state.instances.map((instance): [string, string] => [instance.id, instance.name])]);
	const scenes = new Map(world.definition.scenes.map((scene) => [scene.id, scene.name]));
	return world.state.events.filter((event) => witnessed.has(event.id)).map((event) => ({
		...memoryForEvent(event),
		actorName: names.get(event.actorId) ?? event.actorId,
		targetName: event.targetId === null ? null : names.get(event.targetId) ?? event.targetId,
		sceneName: scenes.get(event.sceneId) ?? event.sceneId
	}));
}
