import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { addScene, addTemplate, createWorld, deleteWorld, editInstance, editInitialInstance, editRelationship, editScene, editTemplate, editWorld, getStageView, importWorld, saveDefinition, selectWorld, spawnInstance } from '$lib/server/stage-store';

export const load: PageServerLoad = ({ url }) => {
	const tab = url.searchParams.get('tab') ?? 'scenes';
	return { ...getStageView(), editorTab: ['world', 'scenes', 'templates', 'instances', 'advanced'].includes(tab) ? tab : 'scenes' };
};
import { jsonField as json, propertyFields, relationshipFields, presentationFields } from '$lib/server/editor-input';
function failed(error: unknown) { return fail(400, { message: error instanceof Error ? error.message : '편집 내용을 저장하지 못했습니다.', error: true }); }
export const actions: Actions = {
	settings: async ({ request }) => {
		try {
			const body = await request.formData();
			editWorld(String(body.get('worldId')), Number(body.get('revision')), (world) => {
				Object.assign(world.definition, { name: String(body.get('name')), description: String(body.get('description')), rules: String(body.get('rules') || '') });
				if (body.has('writingStyle')) world.definition.writingStyle = String(body.get('writingStyle') ?? '');
				if (body.has('appearanceChangeMinutes')) world.definition.appearanceChangeMinutes = Number(body.get('appearanceChangeMinutes'));
				if (body.has('startingSceneId')) {
					world.definition.startingSceneId = String(body.get('startingSceneId'));
					for (const spawn of world.definition.spawns) if (spawn.companion) spawn.sceneId = world.definition.startingSceneId;
				}
			});
			return { message: '세계관 설정을 저장했습니다.' };
		} catch (error) { return failed(error); }
	},
	createWorld: async ({ request }) => {
		try { const body = await request.formData(); createWorld(String(body.get('name')), String(body.get('description'))); return { message: '세계관을 만들었습니다.' }; }
		catch (error) { return failed(error); }
	},
	selectWorld: async ({ request }) => {
		try { selectWorld(String((await request.formData()).get('worldId'))); return { message: '세계관을 열었습니다.' }; }
		catch (error) { return failed(error); }
	},
	deleteWorld: async ({ request }) => {
		try {
			const body = await request.formData();
			deleteWorld(String(body.get('worldId')), Number(body.get('revision')));
			return { message: '세계관과 진행 기록·저장 슬롯을 삭제했습니다.' };
		} catch (error) { return failed(error); }
	},
	definition: async ({ request }) => {
		try { const body = await request.formData(); saveDefinition(String(body.get('worldId')), Number(body.get('revision')), json(body, 'definition')); return { message: '세계관·씬·원형과 초기 배치를 저장했습니다. 현재 인스턴스의 진행 상태는 유지됩니다.' }; }
		catch (error) { return failed(error); }
	},
	scene: async ({ request }) => {
		try { const body = await request.formData(); if (body.get('sceneId')) editScene(String(body.get('worldId')), Number(body.get('revision')), String(body.get('sceneId')), { name: String(body.get('name')), description: String(body.get('description')), exits: body.getAll('exits').map(String) });
			else addScene(String(body.get('worldId')), Number(body.get('revision')), String(body.get('name')), String(body.get('description')), body.getAll('exits').map(String)); return { message: '씬을 저장했습니다.' }; }
		catch (error) { return failed(error); }
	},
	template: async ({ request }) => {
		try {
			const body = await request.formData();
			const input = {
				kind: String(body.get('kind')), name: String(body.get('name')), description: String(body.get('description')), personality: String(body.get('personality') || ''),
				goals: String(body.get('goals') || '').split('\n').map((goal) => goal.trim()).filter(Boolean), initialState: propertyFields(body, 'initialState'),
				...(body.has('interactions') ? { interactions: json(body, 'interactions', []) } : {}), ...(body.has('reactions') ? { reactions: json(body, 'reactions', []) } : {}),
				...(body.has('baseAppearance') ? { baseAppearance: String(body.get('baseAppearance') ?? '') } : {}), ...(body.has('clothingPreferences') ? { clothingPreferences: String(body.get('clothingPreferences') ?? '') } : {}), ...(body.has('foodPreferences') ? { foodPreferences: String(body.get('foodPreferences') ?? '') } : {}), ...(body.has('wardrobe') ? { wardrobe: json(body, 'wardrobe', []) } : {})
			};
			if (body.get('templateId')) editTemplate(String(body.get('worldId')), Number(body.get('revision')), String(body.get('templateId')), input);
			else addTemplate(String(body.get('worldId')), Number(body.get('revision')), { interactions: [], reactions: [], ...input });
			return { message: '캐릭터·사물 설정을 저장했습니다. 기존 인물의 위치와 기억은 유지됩니다.' };
		} catch (error) { return failed(error); }
	},
	spawn: async ({ request }) => {
		try { const body = await request.formData(); spawnInstance(String(body.get('worldId')), Number(body.get('revision')), String(body.get('templateId')), String(body.get('sceneId')), String(body.get('name') || ''), body.get('companion') === 'on', presentationFields(body)); return { message: '씬에 인스턴스를 배치했습니다.' }; }
		catch (error) { return failed(error); }
	},
	instance: async ({ request }) => {
		try { const body = await request.formData(); editInstance(String(body.get('worldId')), Number(body.get('revision')), String(body.get('instanceId')), { name: String(body.get('name')), sceneId: String(body.get('sceneId')), companion: body.get('companion') === 'on', state: propertyFields(body, 'state'), ...presentationFields(body), ...(body.has('relationships') ? { relationships: json(body, 'relationships') } : {}) }); return { message: '인스턴스 상태를 저장했습니다.' }; }
		catch (error) { return failed(error); }
	},
	initialInstance: async ({ request }) => {
		try {
			const body = await request.formData();
			editInitialInstance(String(body.get('worldId')), Number(body.get('revision')), String(body.get('instanceId')), { name: String(body.get('name')), sceneId: String(body.get('sceneId')), companion: body.get('companion') === 'on', state: propertyFields(body, 'state'), ...presentationFields(body) });
			return { message: '처음 배치 설정을 저장했습니다. 현재 진행은 유지되며 초기화할 때 적용됩니다.' };
		} catch (error) { return failed(error); }
	},
	relationship: async ({ request }) => {
		try {
			const body = await request.formData();
			const scope = String(body.get('scope'));
			if (scope !== 'current' && scope !== 'initial') throw new Error('현재 관계 또는 초기 관계를 선택해 주세요.');
			editRelationship(String(body.get('worldId')), Number(body.get('revision')), String(body.get('instanceId')), scope, String(body.get('targetId')), body.get('intent') === 'remove' ? null : relationshipFields(body), String(body.get('impression') || ''));
			return { message: scope === 'current' ? '현재 관계를 저장했습니다.' : '초기 관계를 저장했습니다. 현재 관계는 유지됩니다.' };
		} catch (error) { return failed(error); }
	},
	importWorld: async ({ request }) => {
		try {
			const body = await request.formData();
			const file = body.get('file');
			if (!file || typeof file === 'string' || file.size > 100000000) throw new Error('100MB 이하의 세계관 JSON 파일을 선택해 주세요.');
			const mode = String(body.get('mode') ?? 'new');
			if (mode !== 'new' && mode !== 'replace') throw new Error('가져오기 방식을 선택해 주세요.');
			importWorld(await file.text(), mode === 'replace' ? { worldId: String(body.get('worldId')), revision: Number(body.get('revision')) } : undefined);
			return { message: mode === 'replace' ? '현재 세계관을 새 파일로 교체했습니다. 이전 진행·슬롯·모델 설정은 지웠습니다.' : '세계관과 저장 슬롯을 가져왔습니다.' };
		} catch (error) { return failed(error); }
	}
};
