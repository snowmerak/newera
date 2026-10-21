import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { addScene, addTemplate, createWorld, editInstance, editWorld, getStageView, importWorld, saveDefinition, selectWorld, spawnInstance } from '$lib/server/stage-store';

export const load: PageServerLoad = () => getStageView();
function json(body: FormData, name: string, fallback: unknown = {}): unknown { const value = String(body.get(name) || ''); return value ? JSON.parse(value) : fallback; }
function failed(error: unknown) { return fail(400, { message: error instanceof Error ? error.message : '편집 내용을 저장하지 못했습니다.' }); }
export const actions: Actions = {
	settings: async ({ request }) => {
		try {
			const body = await request.formData();
			editWorld(String(body.get('worldId')), Number(body.get('revision')), (world) => {
				Object.assign(world.definition, { name: String(body.get('name')), description: String(body.get('description')), rules: String(body.get('rules') || '') });
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
	definition: async ({ request }) => {
		try { const body = await request.formData(); saveDefinition(String(body.get('worldId')), Number(body.get('revision')), json(body, 'definition')); return { message: '세계관·씬·원형과 초기 배치를 저장했습니다. 현재 인스턴스의 진행 상태는 유지됩니다.' }; }
		catch (error) { return failed(error); }
	},
	scene: async ({ request }) => {
		try { const body = await request.formData(); addScene(String(body.get('worldId')), Number(body.get('revision')), String(body.get('name')), String(body.get('description')), body.getAll('exits').map(String)); return { message: '씬을 추가했습니다.' }; }
		catch (error) { return failed(error); }
	},
	template: async ({ request }) => {
		try {
			const body = await request.formData();
			addTemplate(String(body.get('worldId')), Number(body.get('revision')), {
				kind: String(body.get('kind')), name: String(body.get('name')), description: String(body.get('description')), personality: String(body.get('personality') || ''),
				goals: String(body.get('goals') || '').split('\n').map((goal) => goal.trim()).filter(Boolean), initialState: json(body, 'initialState'), interactions: json(body, 'interactions', []), reactions: json(body, 'reactions', [])
			});
			return { message: '원형을 만들었습니다. 씬에 인스턴스를 배치해 주세요.' };
		} catch (error) { return failed(error); }
	},
	spawn: async ({ request }) => {
		try { const body = await request.formData(); spawnInstance(String(body.get('worldId')), Number(body.get('revision')), String(body.get('templateId')), String(body.get('sceneId')), String(body.get('name') || ''), body.get('companion') === 'on'); return { message: '씬에 인스턴스를 배치했습니다.' }; }
		catch (error) { return failed(error); }
	},
	instance: async ({ request }) => {
		try { const body = await request.formData(); editInstance(String(body.get('worldId')), Number(body.get('revision')), String(body.get('instanceId')), { name: String(body.get('name')), sceneId: String(body.get('sceneId')), companion: body.get('companion') === 'on', state: json(body, 'state') }); return { message: '인스턴스 상태를 저장했습니다.' }; }
		catch (error) { return failed(error); }
	},
	importWorld: async ({ request }) => {
		try {
			const file = (await request.formData()).get('file');
			if (!file || typeof file === 'string' || file.size > 100000000) throw new Error('100MB 이하의 세계관 JSON 파일을 선택해 주세요.');
			importWorld(await file.text());
			return { message: '세계관과 저장 슬롯을 가져왔습니다.' };
		} catch (error) { return failed(error); }
	}
};
