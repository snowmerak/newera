import { witnessedMemories } from './memory.ts';
import { memoUpdateSchema } from './performance.ts';
import { checkedReflection } from './validation.ts';
import { relationshipMetrics } from './types.ts';
import type { CharacterReflection, EntityInstance, ReflectionContext, Relationship, World } from './types.ts';

export const relationshipLabels = { trust: '신뢰도', affinity: '호감도', closeness: '친밀도', respect: '존중도', wariness: '경계도' };

export function unknownRelationship(): Relationship {
	return { trust: null, affinity: null, closeness: null, respect: null, wariness: null, impression: '', evidenceEventIds: [] };
}

/** Batch new witnessed events in order. Own actions and passive waits cannot inflate relationships. */
export function reflectionContext(world: World, actor: EntityInstance): ReflectionContext | null {
	const memories = [...new Map(witnessedMemories(world.state.events, actor.memories, actor.memories.length).map((memory) => [memory.eventId, memory])).values()];
	const events = memories.filter((memory) => memory.kind !== 'wait' && memory.actorId !== actor.id);
	const cursor = actor.reflectedThroughEventId ?? null;
	const position = cursor === null ? -1 : events.findIndex((event) => event.eventId === cursor);
	if (cursor !== null && position < 0) throw new Error('관찰 해석 위치를 찾을 수 없습니다.');
	const newEvents = events.slice(position + 1, position + 5);
	if (!newEvents.length) return null;
	const lastIndex = memories.findIndex((memory) => memory.eventId === newEvents.at(-1)!.eventId);
	const recent = memories.slice(Math.max(0, lastIndex - 7), lastIndex + 1).filter((event) => event.kind !== 'wait');
	const evidenceEvents = [...new Map([...newEvents, ...recent].map((event) => [event.eventId, event])).values()];
	const knownIds = new Set([
		...Object.keys(actor.relationships ?? {}),
		...evidenceEvents.flatMap((event) => [event.actorId, event.targetId]),
		...world.state.instances.filter((other) => other.active && other.sceneId === actor.sceneId).map((other) => other.id)
	]);
	const targets = [
		...(knownIds.has('player') || actor.sceneId === world.state.activeSceneId ? [{ id: 'player', name: '플레이어' }] : []),
		...world.state.instances.filter((other) => other.id !== actor.id && knownIds.has(other.id) && world.definition.templates.find((template) => template.id === other.templateId)?.kind === 'character').map((other) => ({ id: other.id, name: other.name }))
	];
	return { newEvents, evidenceEvents, targets };
}

export function reflectionSchema(context: ReflectionContext): Record<string, unknown> {
	return {
		type: 'object', additionalProperties: false,
		properties: {
			relationshipUpdates: { type: 'array', maxItems: 8, items: {
				type: 'object', additionalProperties: false,
				properties: {
					targetId: { type: 'string', enum: context.targets.map((target) => target.id) },
					changes: { type: 'array', maxItems: 5, items: {
						type: 'object', additionalProperties: false,
						properties: { field: { type: 'string', enum: [...relationshipMetrics] }, value: { type: ['integer', 'null'], minimum: 0, maximum: 100 } }, required: ['field', 'value']
					} },
					impression: { type: ['string', 'null'], maxLength: 600 },
					evidenceEventIds: {
						type: 'array', minItems: 1, maxItems: 8, uniqueItems: true,
						items: { type: 'string', enum: context.evidenceEvents.map((event) => event.eventId) },
						contains: { type: 'string', enum: context.newEvents.map((event) => event.eventId) }, minContains: 1
					}
				}, required: ['targetId', 'changes', 'impression', 'evidenceEventIds']
			} },
			memoUpdate: memoUpdateSchema
		}, required: ['relationshipUpdates', 'memoUpdate']
	};
}

/** Validate all proposals before mutating. The host assigns the subject and processed cursor. */
export function applyReflection(actor: EntityInstance, value: CharacterReflection, context: ReflectionContext): void {
	const reflection = checkedReflection(value, context);
	actor.relationships ??= {};
	for (const update of reflection.relationshipUpdates) {
		const relation = { ...(actor.relationships[update.targetId] ?? unknownRelationship()) };
		for (const change of update.changes) relation[change.field] = change.value;
		if (update.impression !== null) relation.impression = update.impression;
		relation.evidenceEventIds = [...update.evidenceEventIds];
		actor.relationships[update.targetId] = relation;
	}
	if (reflection.memoUpdate) actor.memo = reflection.memoUpdate;
	actor.reflectedThroughEventId = context.newEvents.at(-1)!.eventId;
}
