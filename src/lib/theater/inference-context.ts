import type { ReflectionContext } from './types';
import type { ActorExpression } from './types';
import { defaultGenerationHistoryTokens, limitGenerationHistory } from './generation-history';

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
const list = (value: unknown): Fields[] => Array.isArray(value) ? value.map(fields) : [];
const pick = (value: unknown, keys: string[]): Fields => {
	const source = fields(value);
	return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
};

/** Use witnessed records once. Pin the latest player input and own action so short windows retain both. */
function recentEvents(state: Fields, count: number): Fields[] {
	const self = fields(state.self);
	const events = [...new Map([...list(self.memories), ...list(state.recentEvents)].map((event) => [event.eventId, event])).values()];
	const selected = new Set(events.slice(-count));
	for (const id of ['player', self.id]) {
		const event = events.findLast((event) => event.actorId === id);
		if (event) selected.add(event);
	}
	return events.filter((event) => selected.has(event));
}

function relationships(state: Fields, events: Fields[], targets: string[] = []): Fields {
	const relevant = new Set(['player', ...targets, ...list(state.present).map((actor) => actor.id), ...events.flatMap((event) => [event.actorId, event.targetId])]);
	return Object.fromEntries(Object.entries(fields(fields(state.self).relationships)).filter(([id]) => relevant.has(id)).map(([id, value]) => [id, pick(value, ['trust', 'affinity', 'closeness', 'respect', 'wariness', 'impression'])]));
}

function identity(state: Fields): Fields {
	return { speakerId: fields(state.self).id, speakerName: fields(state.self).name, playerId: 'player', instruction: 'speaker만 연기한다. player는 사용자가 직접 조종하는 별개 인물이다. 플레이어 이름은 사용자 발언으로 확인된 경우에만 알고, 모르면 이름을 만들어 대신 답하지 않는다.' };
}

/** Keep author and addressee names next to quotations; a question to player is not a question to self. */
function labelledEvents(state: Fields, events: Fields[]): Fields[] {
	const self = fields(state.self);
	const names = new Map<unknown, unknown>([...Object.entries(fields(fields(state.memoryRecall).names)), ['player', '플레이어'], [self.id, self.name], ...list(state.present).map((actor): [unknown, unknown] => [actor.id, actor.name])]);
	return events.map((event) => ({ ...event, actorName: names.get(event.actorId) ?? event.actorId, targetName: names.get(event.targetId) ?? event.targetId, addressedToSelf: event.targetId === self.id }));
}

/** Retrieved history is separate from the current stimulus and never replaces recent events. */
function recalledContext(state: Fields, events: Fields[], count: number): Fields {
	if (!state.memoryRecall) return {};
	const recall = fields(state.memoryRecall);
	const recent = new Set(events.map((event) => event.eventId));
	return {
		memorySearch: { status: recall.status },
		recalledEvents: labelledEvents(state, list(recall.events).filter((event) => !recent.has(event.eventId)).slice(0, count))
	};
}

/** Participation needs motives and current events, not world exposition, wardrobe or storage cursors. */
export function participationContext(state: Fields): Fields {
	const events = recentEvents(state, 6);
	const recalled = recalledContext(state, events, 2);
	return {
		identity: identity(state),
		time: state.time,
		scene: pick(state.scene, ['id', 'name', 'description']),
		self: { ...pick(state.self, ['id', 'name', 'description', 'personality', 'goals', 'state', 'companion', 'memo', 'inactivity']), relationships: relationships(state, [...events, ...list(recalled.recalledEvents)]) },
		player: state.player,
		present: list(state.present).map((actor) => pick(actor, ['id', 'name', 'kind', 'state'])),
		recentEvents: labelledEvents(state, events),
		...recalled
	};
}

/** Once wait is chosen, only distinguish attention, existing activity and idleness. */
export function inactivityContext(state: Fields): Fields {
	const self = fields(state.self);
	return {
		time: state.time,
		scene: pick(state.scene, ['id', 'name']),
		self: { ...pick(self, ['id', 'name', 'state', 'inactivity']), memo: pick(self.memo, ['currentIntention', 'feelings']) },
		present: list(state.present).map((actor) => pick(actor, ['id', 'name', 'kind'])),
		recentEvents: recentEvents(state, 3)
	};
}

/** Clothing decisions never need another person's relationships or a transcript. */
export function outfitContext(state: Fields): Fields {
	return {
		time: state.time,
		scene: pick(state.scene, ['id', 'name', 'description']),
		self: pick(state.self, ['id', 'name', 'clothingPreferences', 'appearance', 'appearanceSelection'])
	};
}

/** Only detailed generation receives the rolling history; decision projections remain small. */
export function performanceContext(state: Fields, historyTokenLimit = defaultGenerationHistoryTokens): Fields {
	const events = recentEvents(state, 12);
	const recalled = recalledContext(state, events, 8);
	// Direct callers without a world source still get a bounded, deduplicated observed history.
	const fallback = [...new Map([...list(recalled.recalledEvents), ...labelledEvents(state, events)].map((event) => [event.eventId, event])).values()];
	const history = limitGenerationHistory(Array.isArray(state.generationEvents) ? list(state.generationEvents) : fallback, historyTokenLimit);
	return {
		identity: identity(state),
		world: state.world, scene: state.scene, time: state.time, player: state.player, playerPresent: state.playerPresent,
		self: { ...pick(state.self, ['id', 'name', 'description', 'personality', 'goals', 'state', 'companion', 'appearance', 'playerContext', 'memo', 'inactivity', 'clothingPreferences', 'foodPreferences']), relationships: relationships(state, [...events, ...list(recalled.recalledEvents)]) },
		present: state.present,
		history: history.events,
		historyWindow: history.window
	};
}

export function performanceReviewContext(state: Fields, proposal: ActorExpression): Fields {
	return {
		identity: identity(state),
		self: pick(state.self, ['id', 'name', 'description', 'state']),
		present: list(state.present).map((actor) => pick(actor, ['id', 'name', 'kind'])),
		recentEvents: labelledEvents(state, recentEvents(state, 6)),
		...recalledContext(state, recentEvents(state, 6), 8),
		proposal: pick(proposal, ['actionId', 'targetId', 'narrative', 'utterance', 'memoUpdate'])
	};
}

/** Identity is checked without dialogue history, which may itself contain a role-confused line. */
export function identityReviewContext(state: Fields, proposal: ActorExpression): Fields {
	const self = fields(state.self);
	return {
		speaker: { ...pick(self, ['id', 'name', 'description']), role: fields(self.state).role },
		proposal: pick(proposal, ['narrative', 'utterance', 'memoUpdate'])
	};
}

/** New evidence is sent once; older evidence remains available to justify relationship changes. */
export function reflectionInput(state: Fields, context: ReflectionContext): Fields {
	const ids = new Set(context.newEvents.map((event) => event.eventId));
	return {
		time: state.time, scene: pick(state.scene, ['id', 'name', 'description']),
		self: { ...pick(state.self, ['id', 'name', 'description', 'personality', 'goals', 'state', 'memo']), relationships: relationships(state, context.evidenceEvents.map(fields), context.targets.map((target) => target.id)) },
		newEvents: context.newEvents,
		pastEvents: context.evidenceEvents.filter((event) => !ids.has(event.eventId)),
		targets: context.targets
	};
}
