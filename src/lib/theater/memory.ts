import { eventContent } from './event-content.ts';
import type { EntityMemory, StageEvent, WitnessedEvent } from './types.ts';

/** Keep authorship and targets out of prose. Quoted speech remains a claim by its speaker. */
export function memoryForEvent(event: StageEvent): WitnessedEvent {
	return {
		eventId: event.id, tick: event.tick, sceneId: event.sceneId,
		kind: event.kind, actorId: event.actorId, targetId: event.targetId,
		body: eventContent(event),
		...(event.interactionId !== undefined ? { interactionId: event.interactionId } : {}),
		...(event.destinationId !== undefined ? { destinationId: event.destinationId } : {}),
		...(event.changes !== undefined ? { changes: { ...event.changes } } : {})
	};
}

/** Resolve legacy text through its event ID instead of guessing the meaning of "I". */
export function witnessedMemories(events: StageEvent[], memories: EntityMemory[], limit: number): WitnessedEvent[] {
	const recent = memories.slice(-limit);
	const wanted = new Set(recent.map((memory) => memory.eventId));
	const known = new Map(events.filter((event) => wanted.has(event.id)).map((event) => [event.id, event]));
	return recent.flatMap((memory) => {
		const event = known.get(memory.eventId);
		if (event) return [memoryForEvent(event)];
		return 'body' in memory ? [structuredClone(memory)] : [];
	});
}
