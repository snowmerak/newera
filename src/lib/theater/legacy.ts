import { initialState } from './runtime.ts';
import type { EntityTemplate, WorldDefinition, WorldState } from './types.ts';
import { record, text, validateDefinition, validateState } from './validation.ts';

function rows(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map((entry) => record(entry, '이전 저장 행')) : [];
}

/** Read the old snapshot as narrative content. Its numeric simulation is preserved only in the source archive. */
export function convertLegacy(title: string, value: unknown): { definition: WorldDefinition; state: WorldState } {
	const snapshot = record(value, '이전 저장');
	const config = rows(snapshot.config)[0] ?? {};
	const oldWorld = rows(snapshot.world)[0] ?? {};
	const characters = rows(snapshot.characters);
	const templateRows = rows(snapshot.characterTemplates).map((row) => record(JSON.parse(String(row.character_json)), '이전 원형'));
	const toId = (id: unknown) => `legacy-${String(id).replace(/[^a-zA-Z0-9._:-]/g, '-')}`;
	const templates = characters.map((character): EntityTemplate => {
		const original = templateRows.find((template) => template.id === character.id) ?? character;
		return {
			id: toId(character.id), kind: 'character', name: text(character.name, '인물 이름', 200),
			description: String(original.profile || original.introduction || character.profile || character.introduction || character.name),
			personality: '', goals: [], initialState: {}, interactions: [], reactions: []
		};
	});
	const definition = validateDefinition({
		name: title, description: String(config.world_setting || title),
		rules: '현장에 있는 인물과 오브젝트가 자신이 관찰한 사건에 반응한다. 타인의 행동이나 말을 대신 결정하지 않는다.',
		startingSceneId: 'opening',
		scenes: [{ id: 'opening', name: String(oldWorld.location || '첫 장면'), description: String(config.scene_note || config.world_memory || '이곳에서 이야기를 이어간다.'), exits: [] }],
		templates, spawns: templates.map((template) => ({ id: template.id, templateId: template.id, sceneId: 'opening', name: template.name, companion: false, state: {} }))
	});
	const state = initialState(definition);
	state.tick = Number(oldWorld.turn ?? 0);
	state.day = Number(oldWorld.day ?? 1);
	state.minute = Number(oldWorld.minute ?? 1080);
	state.events = rows(snapshot.events).map((entry) => ({
		id: `legacy-event-${entry.id}`, tick: Number(entry.turn), sceneId: 'opening', kind: 'change', actorId: 'stage', targetId: null,
		text: String(entry.narrative || entry.summary)
	}));
	for (const instance of state.instances) {
		instance.memories = rows(snapshot.memories).filter((memory) => toId(memory.character_id) === instance.id).map((memory) => ({
			eventId: `legacy-event-${memory.event_id}`, tick: Number(memory.created_turn), text: String(memory.summary)
		}));
	}
	return { definition, state: validateState(state, definition) };
}
