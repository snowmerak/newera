import type { Value, World } from '$lib/theater/types';

export interface ImageTriggerRule {
	id: string;
	name: string;
	enabled: boolean;
	when: 'scene' | 'interval' | 'condition';
	minutes: number;
	cooldownMinutes: number;
	sceneId: string;
	entityId: string;
	state: { entityId: string; key: string; equals: Value } | null;
	naturalLanguage: string;
	prompt: string;
}
export interface ImageTriggerSettings { enabled: boolean; rules: ImageTriggerRule[] }
export interface ImageTriggerView { revision: number; config: ImageTriggerSettings }
export interface ImageTriggerCursor {
	revision: number; minute: number; sceneId: string;
	matched: Record<string, boolean>; lastFired: Record<string, number>;
}
export interface ImageSceneSnapshot {
	revision: number; tick: number; minute: number; sceneId: string; eventId: string | null;
	guards: Record<string, boolean>; context: string;
}
export interface Illustration {
	id: string; worldId: string; eventId: string | null; tick: number; sceneId: string;
	status: 'pending' | 'checking' | 'generating' | 'completed' | 'failed' | 'skipped';
	reason: string; error: string | null; createdAt: string;
}
export const defaultImageTriggers = (): ImageTriggerSettings => ({ enabled: false, rules: [] });
export const newImageRule = (): ImageTriggerRule => ({ id: globalThis.crypto.randomUUID(), name: '새 삽화 조건', enabled: true, when: 'scene', minutes: 30, cooldownMinutes: 0, sceneId: '', entityId: '', state: null, naturalLanguage: '', prompt: '' });
export const storyMinute = (world: World) => world.state.day * 1440 + world.state.minute;
export function imageTriggerCursor(world: World): ImageTriggerCursor {
	return { revision: world.revision, minute: storyMinute(world), sceneId: world.state.activeSceneId, matched: {}, lastFired: {} };
}

export function checkedImageTriggers(input: unknown, world?: World): ImageTriggerSettings {
	const row = input as ImageTriggerSettings;
	if (!row || typeof row !== 'object' || typeof row.enabled !== 'boolean' || !Array.isArray(row.rules) || row.rules.length > 10 || Object.keys(row).some((key) => !['enabled', 'rules'].includes(key))) throw new Error('이미지 생성 조건은 최대 10개까지 설정할 수 있습니다.');
	const short = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
	const rules = row.rules.map((rule) => {
		if (!rule || typeof rule !== 'object' || Object.keys(rule).some((key) => !['id', 'name', 'enabled', 'when', 'minutes', 'cooldownMinutes', 'sceneId', 'entityId', 'state', 'naturalLanguage', 'prompt'].includes(key)) || !short(rule.id, 100) || !/^[a-zA-Z0-9_-]+$/.test(rule.id) || Object.hasOwn(Object.prototype, rule.id) || !short(rule.name, 100) || !rule.name.trim() || typeof rule.enabled !== 'boolean' || !['scene', 'interval', 'condition'].includes(rule.when) || !Number.isSafeInteger(rule.minutes) || rule.minutes < 1 || rule.minutes > 10080 || !Number.isSafeInteger(rule.cooldownMinutes) || rule.cooldownMinutes < 0 || rule.cooldownMinutes > 10080 || !short(rule.sceneId, 100) || !short(rule.entityId, 100) || !short(rule.naturalLanguage, 2000) || !short(rule.prompt, 2000)) throw new Error('이미지 생성 조건의 이름·유형·시간·입력 길이를 확인해 주세요.');
		if (rule.state !== null) {
			const state = rule.state;
			if (!state || typeof state !== 'object' || Object.keys(state).some((key) => !['entityId', 'key', 'equals'].includes(key)) || !short(state.entityId, 100) || !state.entityId || !short(state.key, 100) || !state.key || !Object.hasOwn(state, 'equals') || !(state.equals === null || ['string', 'boolean'].includes(typeof state.equals) || typeof state.equals === 'number' && Number.isFinite(state.equals)) || typeof state.equals === 'string' && state.equals.length > 2000) throw new Error('상태 조건에는 대상·속성 이름과 JSON 기본값을 지정해 주세요.');
		}
		if (rule.when === 'condition' && !rule.sceneId && !rule.entityId && !rule.state && !rule.naturalLanguage.trim()) throw new Error('조건 충족 유형에는 장소·인물·상태·자연어 조건 중 하나 이상을 지정해 주세요.');
		if (world) {
			if (rule.sceneId && !world.definition.scenes.some((scene) => scene.id === rule.sceneId)) throw new Error('조건에 지정한 장소가 없습니다.');
			for (const id of [rule.entityId, rule.state?.entityId]) if (id && !world.state.instances.some((entity) => entity.id === id)) throw new Error('조건에 지정한 인물·사물이 없습니다.');
		}
		return structuredClone(rule);
	});
	if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error('이미지 생성 조건 ID가 중복되었습니다.');
	return { enabled: row.enabled, rules };
}

/** Image prompts and semantic checks never receive private memories, goals, relationships or character state. */
export function imageSceneSnapshot(world: World, rules: ImageTriggerRule[]): ImageSceneSnapshot {
	const sceneId = world.state.activeSceneId;
	const residents = world.state.instances.filter((entity) => entity.active && entity.sceneId === sceneId);
	const guards = Object.fromEntries(rules.map((rule) => {
		const target = rule.state && world.state.instances.find((entity) => entity.active && entity.id === rule.state!.entityId && entity.sceneId === sceneId);
		return [rule.id, (!rule.sceneId || rule.sceneId === sceneId) && (!rule.entityId || residents.some((entity) => entity.id === rule.entityId)) && (!rule.state || !!target && Object.hasOwn(target.state, rule.state.key) && target.state[rule.state.key] === rule.state.equals)];
	}));
	const context = JSON.stringify({
		scene: world.definition.scenes.find((scene) => scene.id === sceneId), day: world.state.day, minute: world.state.minute, tick: world.state.tick,
		cast: residents.map((entity) => ({ id: entity.id, name: entity.name, appearance: entity.appearance ?? '' })),
		recentEvents: world.state.events.filter((event) => event.sceneId === sceneId).slice(-8).map((event) => ({ tick: event.tick, actor: event.actorId === 'player' ? '플레이어' : world.state.instances.find((entity) => entity.id === event.actorId)?.name ?? '무대', kind: event.kind, narrative: event.narrative ?? event.text, utterance: event.utterance ?? null }))
	}).slice(0, 16000);
	return { revision: world.revision, tick: world.state.tick, minute: storyMinute(world), sceneId, eventId: world.state.events.at(-1)?.id ?? null, guards, context };
}

export function eligibleImageRule(rule: ImageTriggerRule, scene: ImageSceneSnapshot, cursor: ImageTriggerCursor): boolean {
	const last = cursor.lastFired[rule.id] ?? cursor.minute;
	if (!rule.enabled || !scene.guards[rule.id] || cursor.lastFired[rule.id] !== undefined && scene.minute - last < rule.cooldownMinutes) return false;
	if (rule.when === 'scene') return scene.sceneId !== cursor.sceneId;
	if (rule.when === 'interval') return scene.minute - last >= rule.minutes;
	return true;
}

/** Multiple matching rules coalesce into one image. A condition fires on false → true, then must become false again. */
export function evaluateImageRules(rules: ImageTriggerRule[], scene: ImageSceneSnapshot, cursor: ImageTriggerCursor, semantic: Record<string, boolean>) {
	const next = structuredClone(cursor);
	const fired: ImageTriggerRule[] = [];
	for (const rule of rules) {
		const eligible = eligibleImageRule(rule, scene, cursor);
		const match = eligible && (!rule.naturalLanguage.trim() || semantic[rule.id] === true);
		if (match && (rule.when !== 'condition' || !cursor.matched[rule.id])) {
			fired.push(rule); next.lastFired[rule.id] = scene.minute;
		}
		if (!scene.guards[rule.id]) next.matched[rule.id] = false;
		else if (eligible) next.matched[rule.id] = match;
	}
	next.revision = scene.revision; next.sceneId = scene.sceneId;
	return { fired, cursor: next };
}
