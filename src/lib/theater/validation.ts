import { relationshipMetrics } from './types.ts';
import type { CharacterReflection, ReflectionContext, Relationships, RelationshipScores, RelationshipMetric, CharacterMemo, Condition, EntityInstance, EntityMemory, EntityTemplate, EventKind, Interaction, ModelSelection, ObjectReaction, Properties, Scene, Spawn, StageEvent, Value, WorldDefinition, WorldState } from './types.ts';
import { memoryForEvent } from './memory.ts';

export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: JSON 객체가 필요합니다.`);
	return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, maximum = 20000, allowEmpty = false): string {
	if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maximum) throw new Error(`${label}: 문자열 길이를 확인해 주세요 (최대 ${maximum}자).`);
	return value.trim();
}
export function identifier(value: unknown, label: string): string {
	const id = text(value, label, 120);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error(`${label}: 사용할 수 없는 ID입니다.`);
	return id;
}
export function checkedMemo(value: unknown): CharacterMemo {
	const source = record(value, '개인 메모');
	const keys = ['summary', 'currentIntention', 'feelings', 'openThreads'];
	if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) throw new Error('개인 메모: 허용되지 않거나 누락된 항목이 있습니다.');
	const notes = (value: unknown, label: string): string[] => list(value, label, 8).map((entry) => text(entry, label, 300));
	return { summary: text(source.summary, '메모 요약', 1200, true), currentIntention: text(source.currentIntention, '현재 의도', 600, true), feelings: notes(source.feelings, '현재 감정'), openThreads: notes(source.openThreads, '미해결 문제') };
}
function exactKeys(source: Record<string, unknown>, keys: string[], label: string): void {
	if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) throw new Error(`${label}: 허용되지 않거나 누락된 항목이 있습니다.`);
}
function relationshipScore(value: unknown): number | null {
	return value === null ? null : integer(value, '관계 수치', 100);
}
export function checkedRelationships(value: unknown): Relationships {
	const source = record(value, '상대별 관계');
	if (Object.keys(source).length > 1001) throw new Error('관계 대상이 너무 많습니다.');
	return Object.fromEntries(Object.entries(source).map(([id, value]) => {
		const targetId = identifier(id, '관계 대상');
		const relation = record(value, '관계');
		exactKeys(relation, [...relationshipMetrics, 'impression', 'evidenceEventIds'], '관계');
		const scores = Object.fromEntries(relationshipMetrics.map((key) => [key, relationshipScore(relation[key])])) as RelationshipScores;
		return [targetId, { ...scores, impression: text(relation.impression, '상대 인식', 600, true), evidenceEventIds: [...new Set(list(relation.evidenceEventIds, '관계 근거', 8).map((id) => text(id, '근거 사건 ID', 160)))] }];
	}));
}
export function checkedReflection(value: unknown, context: ReflectionContext): CharacterReflection {
	const source = record(value, '관찰 해석');
	exactKeys(source, ['relationshipUpdates', 'memoUpdate'], '관찰 해석');
	const targets = new Set(context.targets.map((target) => target.id));
	const evidence = new Set(context.evidenceEvents.map((event) => event.eventId));
	const fresh = new Set(context.newEvents.map((event) => event.eventId));
	const usedTargets = new Set<string>();
	const relationshipUpdates = list(source.relationshipUpdates, '관계 갱신', 8).map((entry) => {
		const update = record(entry, '관계 갱신');
		exactKeys(update, ['targetId', 'changes', 'impression', 'evidenceEventIds'], '관계 갱신');
		const targetId = identifier(update.targetId, '관계 대상');
		if (!targets.has(targetId) || usedTargets.has(targetId)) throw new Error('관계 갱신 대상이 유효하지 않거나 중복됩니다.');
		usedTargets.add(targetId);
		const usedFields = new Set<string>();
		const changes = list(update.changes, '관계 수치 변경', 5).map((entry) => {
			const change = record(entry, '관계 수치 변경');
			exactKeys(change, ['field', 'value'], '관계 수치 변경');
			const field = change.field as RelationshipMetric;
			if (!relationshipMetrics.includes(field) || usedFields.has(field)) throw new Error('관계 수치 항목이 올바르지 않거나 중복됩니다.');
			usedFields.add(field);
			return { field, value: relationshipScore(change.value) };
		});
		const impression = update.impression === null ? null : text(update.impression, '상대 인식', 600, true);
		const evidenceEventIds = list(update.evidenceEventIds, '관계 근거', 8).map((id) => text(id, '근거 사건 ID', 160));
		if (!evidenceEventIds.length || evidenceEventIds.some((id) => !evidence.has(id)) || !evidenceEventIds.some((id) => fresh.has(id))) throw new Error('관계 갱신에는 새로 목격한 사건의 근거가 필요합니다.');
		if (!changes.length && impression === null) throw new Error('관계 갱신에 변경 내용이 없습니다.');
		return { targetId, changes, impression, evidenceEventIds: [...new Set(evidenceEventIds)] };
	});
	return { relationshipUpdates, memoUpdate: source.memoUpdate === null ? null : checkedMemo(source.memoUpdate) };
}
export function checkedModelSelection(value: unknown): ModelSelection {
	const source = record(value, '모델 선택');
	return { decisionModel: text(source.decisionModel, '판단 모델', 200), textModel: text(source.textModel, '생성 모델', 200) };
}
function list(value: unknown, label: string, maximum = 500): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label}: 최대 ${maximum}개의 배열이 필요합니다.`);
	return value;
}
function scalar(value: unknown): value is Value {
	return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 4000);
}
export function properties(value: unknown, label: string): Properties {
	const source = record(value, label);
	if (Object.keys(source).length > 100) throw new Error(`${label}: 상태 항목이 너무 많습니다.`);
	for (const [key, entry] of Object.entries(source)) {
		if (!key.trim() || key.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(key) || !scalar(entry)) throw new Error(`${label}: 상태는 이름과 문자열·숫자·참거짓·null 값으로 구성해야 합니다.`);
	}
	return { ...source } as Properties;
}
function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new Error(`${label}: 정수 범위를 확인해 주세요.`);
	return Number(value);
}
function boolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`${label}: 참거짓 값이 필요합니다.`);
	return value;
}
function unique<T extends { id: string }>(values: T[], label: string): T[] {
	if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error(`${label}: ID가 중복됩니다.`);
	return values;
}
function conditions(value: unknown): Condition[] {
	return list(value, 'conditions', 100).map((entry) => {
		const source = record(entry, 'condition');
		if (!scalar(source.equals)) throw new Error('condition.equals: 상태 값이 필요합니다.');
		return { key: text(source.key, 'condition.key', 100), equals: source.equals };
	});
}
function interaction(value: unknown): Interaction {
	const source = record(value, 'interaction');
	return { id: identifier(source.id, 'interaction.id'), label: text(source.label, 'interaction.label', 200), description: text(source.description, 'interaction.description', 4000, true), conditions: conditions(source.conditions), effects: properties(source.effects, 'interaction.effects') };
}
const eventKinds: EventKind[] = ['speak', 'interact', 'wait', 'move', 'enter', 'leave', 'change'];
function eventKind(value: unknown): EventKind {
	if (!eventKinds.includes(value as EventKind)) throw new Error('이벤트 종류가 올바르지 않습니다.');
	return value as EventKind;
}
function reaction(value: unknown): ObjectReaction {
	const source = record(value, 'reaction');
	return { id: identifier(source.id, 'reaction.id'), on: eventKind(source.on), targeted: boolean(source.targeted, 'reaction.targeted'), conditions: conditions(source.conditions), effects: properties(source.effects, 'reaction.effects'), text: text(source.text, 'reaction.text', 4000) };
}
function spawn(value: unknown): Spawn {
	const source = record(value, 'instance');
	if (source.id === 'player' || source.id === 'stage') throw new Error('player와 stage는 인스턴스 ID로 사용할 수 없습니다.');
	return { id: identifier(source.id, 'instance.id'), templateId: identifier(source.templateId, 'instance.templateId'), sceneId: identifier(source.sceneId, 'instance.sceneId'), name: text(source.name, 'instance.name', 200), companion: boolean(source.companion, 'instance.companion'),
		...(source.appearance !== undefined ? { appearance: text(source.appearance, 'instance.appearance', 1200, true) } : {}),
		...(source.playerContext !== undefined ? { playerContext: text(source.playerContext, 'instance.playerContext', 1200, true) } : {}),
		state: properties(source.state, 'instance.state'), relationships: checkedRelationships(source.relationships ?? {}) };
}
function validateRelationshipTargets(instance: Spawn, instances: Spawn[], templates: EntityTemplate[], initial = false): void {
	const isCharacter = templates.find((template) => template.id === instance.templateId)?.kind === 'character';
	for (const [id, relation] of Object.entries(instance.relationships ?? {})) {
		const target = instances.find((other) => other.id === id);
		if (!isCharacter || id === instance.id || (id !== 'player' && (!target || templates.find((template) => template.id === target.templateId)?.kind !== 'character'))) throw new Error('관계는 다른 캐릭터 또는 플레이어만 대상으로 할 수 있습니다.');
		if (initial && relation.evidenceEventIds.length) throw new Error('초기 관계에는 실행 중 사건의 근거를 지정할 수 없습니다.');
	}
}
export function validateDefinition(value: unknown): WorldDefinition {
	const source = record(value, '세계관');
	const scenes = unique(list(source.scenes, 'scenes', 200).map((entry): Scene => {
		const row = record(entry, 'scene');
		return { id: identifier(row.id, 'scene.id'), name: text(row.name, 'scene.name', 200), description: text(row.description, 'scene.description'), exits: [...new Set(list(row.exits, 'scene.exits', 200).map((exit) => identifier(exit, 'exit')))] };
	}), 'scenes');
	if (!scenes.length) throw new Error('세계관에는 최소 하나의 씬이 필요합니다.');
	const templates = unique(list(source.templates, 'templates').map((entry): EntityTemplate => {
		const row = record(entry, 'template');
		if (row.kind !== 'character' && row.kind !== 'object') throw new Error('원형 종류는 character 또는 object여야 합니다.');
		return {
			id: identifier(row.id, 'template.id'), kind: row.kind, name: text(row.name, 'template.name', 200), description: text(row.description, 'template.description'),
			personality: text(row.personality, 'template.personality', 12000, true), goals: list(row.goals, 'template.goals', 30).map((goal) => text(goal, 'goal', 1000)),
			...(row.baseAppearance !== undefined ? { baseAppearance: text(row.baseAppearance, 'template.baseAppearance', 400, true) } : {}),
			...(row.clothingPreferences !== undefined ? { clothingPreferences: text(row.clothingPreferences, 'template.clothingPreferences', 1200, true) } : {}),
			...(row.foodPreferences !== undefined ? { foodPreferences: text(row.foodPreferences, 'template.foodPreferences', 1200, true) } : {}),
			...(row.wardrobe !== undefined ? { wardrobe: unique(list(row.wardrobe, '옷차림 후보', 36).map((entry) => {
				const outfit = record(entry, '옷차림 후보');
				return { id: identifier(outfit.id, 'outfit.id'), name: text(outfit.name, 'outfit.name', 200), appearance: text(outfit.appearance, 'outfit.appearance', 700), context: text(outfit.context, 'outfit.context', 1200, true) };
			}), '옷차림 후보') } : {}),
			initialState: properties(row.initialState, 'template.initialState'), interactions: unique(list(row.interactions, 'template.interactions', 100).map(interaction), 'interactions'),
			reactions: unique(list(row.reactions, 'template.reactions', 100).map(reaction), 'reactions')
		};
	}), 'templates');
	const spawns = unique(list(source.spawns, 'spawns', 1000).map(spawn), 'spawns');
	const startingSceneId = identifier(source.startingSceneId, 'startingSceneId');
	if (!scenes.some((scene) => scene.id === startingSceneId)) throw new Error('시작 씬이 존재하지 않습니다.');
	for (const scene of scenes) {
		if (scene.exits.some((exit) => exit === scene.id || !scenes.some((candidate) => candidate.id === exit))) throw new Error('씬의 출구가 존재하지 않거나 자기 자신을 가리킵니다.');
	}
	for (const instance of spawns) {
		const template = templates.find((candidate) => candidate.id === instance.templateId);
		if (!template || !scenes.some((scene) => scene.id === instance.sceneId)) throw new Error('인스턴스의 원형 또는 씬이 존재하지 않습니다.');
		validateRelationshipTargets(instance, spawns, templates, true);
		if (instance.companion && (template.kind !== 'character' || instance.sceneId !== startingSceneId)) throw new Error('동행 캐릭터는 시작 씬에 배치해야 합니다.');
	}
	let appearanceChangeMinutes;
	if (source.appearanceChangeMinutes !== undefined) {
		appearanceChangeMinutes = integer(source.appearanceChangeMinutes, '옷차림 재선택 간격', 1440);
		if (appearanceChangeMinutes < 1) throw new Error('옷차림 재선택 간격은 1~1440분이어야 합니다.');
	}
	return { name: text(source.name, '세계관 이름', 200), description: text(source.description, '세계관 설명', 40000), rules: text(source.rules, '세계관 규칙', 20000, true), startingSceneId, scenes, templates, spawns, ...(appearanceChangeMinutes !== undefined ? { appearanceChangeMinutes } : {}) };
}

export function validateState(value: unknown, definition: WorldDefinition): WorldState {
	const source = record(value, '진행 상태');
	const tick = integer(source.tick, 'tick');
	const activeSceneId = identifier(source.activeSceneId, 'activeSceneId');
	if (!definition.scenes.some((scene) => scene.id === activeSceneId)) throw new Error('현재 씬이 존재하지 않습니다.');
	const instances = unique(list(source.instances, 'instances', 1000).map((entry): EntityInstance => {
		const row = record(entry, 'instance');
		const instance = spawn(row);
		const template = definition.templates.find((candidate) => candidate.id === instance.templateId);
		if (!template || !definition.scenes.some((scene) => scene.id === instance.sceneId)) throw new Error('인스턴스 참조가 올바르지 않습니다.');
		const active = boolean(row.active, 'instance.active');
		if (instance.companion && (template.kind !== 'character' || (active && instance.sceneId !== activeSceneId))) throw new Error('동행의 위치가 현재 씬과 다릅니다.');
		const memories = list(row.memories, 'memories', 100000).map((item): EntityMemory => {
			const memory = record(item, 'memory');
			const base = { eventId: text(memory.eventId, 'memory.eventId', 160), tick: integer(memory.tick, 'memory.tick', tick) };
			if (memory.body === undefined) return { ...base, text: text(memory.text, 'memory.text', 20000) };
			const body = record(memory.body, 'memory.body');
			return {
				...base, sceneId: identifier(memory.sceneId, 'memory.sceneId'), kind: eventKind(memory.kind),
				actorId: identifier(memory.actorId, 'memory.actorId'), targetId: memory.targetId === null ? null : identifier(memory.targetId, 'memory.targetId'),
				body: { narrative: body.narrative === null ? null : text(body.narrative, 'memory.body.narrative', 20000), utterance: body.utterance === null ? null : text(body.utterance, 'memory.body.utterance', 20000) },
				...(memory.interactionId !== undefined ? { interactionId: identifier(memory.interactionId, 'memory.interactionId') } : {}),
				...(memory.destinationId !== undefined ? { destinationId: identifier(memory.destinationId, 'memory.destinationId') } : {}),
				...(memory.changes !== undefined ? { changes: properties(memory.changes, 'memory.changes') } : {})
			};
		});
		const memo = row.memo === undefined || row.memo === null ? null : checkedMemo(row.memo);
		let appearanceSelection;
		if (row.appearanceSelection !== undefined) {
			const selection = record(row.appearanceSelection, '오늘의 옷차림');
			if (template.kind !== 'character') throw new Error('오늘의 옷차림은 캐릭터만 설정할 수 있습니다.');
			const day = integer(selection.day, '옷차림 선택 일차', integer(source.day, 'day'));
			if (day < 1) throw new Error('옷차림 선택 일차는 1 이상이어야 합니다.');
			if ((selection.minute === undefined) !== (selection.sceneId === undefined)) throw new Error('옷차림 선택 시각과 장소는 함께 지정해야 합니다.');
			const timing = selection.minute === undefined ? {} : { minute: integer(selection.minute, '옷차림 선택 시각', 1439), sceneId: identifier(selection.sceneId, '옷차림 선택 장소') };
			if (day === source.day && timing.minute !== undefined && timing.minute > Number(source.minute)) throw new Error('옷차림 선택 시각이 현재보다 미래입니다.');
			appearanceSelection = { day, ...timing, outfitId: selection.outfitId === null ? null : identifier(selection.outfitId, 'outfit.id'), model: text(selection.model, '옷차림 판단 모델', 200) };
		}
		if (memo && template.kind !== 'character') throw new Error('개인 메모는 캐릭터에만 저장할 수 있습니다.');
		const reflectedThroughEventId = row.reflectedThroughEventId === undefined || row.reflectedThroughEventId === null ? null : text(row.reflectedThroughEventId, '관찰 해석 위치', 160);
		if (reflectedThroughEventId && template.kind !== 'character') throw new Error('관찰 해석 위치는 캐릭터에만 저장할 수 있습니다.');
		return { ...instance, active, memories, memo, relationships: instance.relationships ?? {}, reflectedThroughEventId, ...(appearanceSelection ? { appearanceSelection } : {}) };
	}), 'instances');
	const events = unique(list(source.events, 'events', 100000).map((entry): StageEvent => {
		const row = record(entry, 'event');
		const sceneId = identifier(row.sceneId, 'event.sceneId');
		const actorId = text(row.actorId, 'event.actorId', 120);
		const targetId = row.targetId === null ? null : text(row.targetId, 'event.targetId', 120);
		if (!definition.scenes.some((scene) => scene.id === sceneId) ||
			(!['player', 'stage'].includes(actorId) && !instances.some((instance) => instance.id === actorId)) ||
			(targetId !== null && targetId !== 'player' && !instances.some((instance) => instance.id === targetId))) throw new Error('이벤트 참조가 올바르지 않습니다.');
		const result: StageEvent = { id: text(row.id, 'event.id', 160), tick: integer(row.tick, 'event.tick', tick), sceneId, kind: eventKind(row.kind), actorId, targetId, text: text(row.text, 'event.text', 20000) };
		if (row.interactionId !== undefined) result.interactionId = identifier(row.interactionId, 'event.interactionId');
		if (row.destinationId !== undefined) {
			result.destinationId = identifier(row.destinationId, 'event.destinationId');
			if (!definition.scenes.some((scene) => scene.id === result.destinationId)) throw new Error('이벤트의 목적지가 존재하지 않습니다.');
		}
		if (row.changes !== undefined) result.changes = properties(row.changes, 'event.changes');
		if (row.narrative !== undefined) result.narrative = text(row.narrative, 'event.narrative', 2000);
		if (row.utterance !== undefined) result.utterance = text(row.utterance, 'event.utterance', 4000);
		if (row.decision !== undefined) {
			const trace = record(row.decision, 'decision');
			result.decision = { model: text(trace.model, 'decision.model', 200), choice: text(trace.choice, 'decision.choice', 500) };
			if (trace.acted !== undefined) result.decision.acted = boolean(trace.acted, 'decision.acted');
			if (trace.generationModel !== undefined) result.decision.generationModel = text(trace.generationModel, 'decision.generationModel', 200);
			for (const [key, maximum] of [['reaction', 1], ['intensity', 2]] as const) {
				const value = trace[key];
				if (value === undefined) continue;
				if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error('판단 기록의 수치가 올바르지 않습니다.');
				result.decision[key] = value;
			}
		}
		return result;
	}), 'events');
	const eventsById = new Map(events.map((event) => [event.id, event]));
	for (const instance of instances) {
		validateRelationshipTargets(instance, instances, definition.templates);
		instance.memories = instance.memories.map((memory): EntityMemory => {
			const event = eventsById.get(memory.eventId);
			if ('body' in memory) {
				if (!definition.scenes.some((scene) => scene.id === memory.sceneId) ||
					(!['player', 'stage'].includes(memory.actorId) && !instances.some((entry) => entry.id === memory.actorId)) ||
					(memory.targetId !== null && memory.targetId !== 'player' && !instances.some((entry) => entry.id === memory.targetId)) ||
					(memory.destinationId !== undefined && !definition.scenes.some((scene) => scene.id === memory.destinationId))) throw new Error('기억의 주체 또는 대상 참조가 올바르지 않습니다.');
				if (event && (event.actorId !== memory.actorId || event.targetId !== memory.targetId || event.kind !== memory.kind || event.tick !== memory.tick || event.sceneId !== memory.sceneId || event.interactionId !== memory.interactionId || event.destinationId !== memory.destinationId)) throw new Error('기억의 주체 또는 대상이 원래 사건과 다릅니다.');
			}
			// The referenced event is authoritative, including for old first-person text memories.
			return event ? memoryForEvent(event) : memory;
		});
		const witnessed = new Set(instance.memories.filter((memory) => 'body' in memory).map((memory) => memory.eventId));
		for (const relation of Object.values(instance.relationships)) {
			if (relation.evidenceEventIds.some((id) => !witnessed.has(id))) throw new Error('관계의 근거 사건을 목격하지 않았습니다.');
		}
		if (instance.reflectedThroughEventId && !instance.memories.some((memory) => 'body' in memory && memory.eventId === instance.reflectedThroughEventId && memory.kind !== 'wait' && memory.actorId !== instance.id)) throw new Error('관찰 해석 위치가 목격 사건과 일치하지 않습니다.');
	}
	const day = integer(source.day, 'day');
	if (day < 1) throw new Error('날짜는 1일차부터 시작합니다.');
	return { tick, day, minute: integer(source.minute, 'minute', 1439), activeSceneId, instances, events };
}
