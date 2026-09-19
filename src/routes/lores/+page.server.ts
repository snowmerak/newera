import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createLore, deleteLore, getGameView, importLoreJson, installModule, renameLore, selectWorldModule, setModuleEnabled, switchLore } from '$lib/server/db';
import { mutateGameState, saveCharacterSettings, saveScenarioSettings } from '$lib/server/game';
import { characterActionRequirements, characterMarks, characterStats } from '$lib/server/character-form';

export const load: PageServerLoad = () => getGameView();

function errorResult(error: unknown, fallback: string) {
	return fail(400, { message: error instanceof Error ? error.message : fallback, level: 'error' as const });
}

export const actions: Actions = {
	createLore: async ({ request }) => {
		const body = await request.formData();
		try {
			mutateGameState(() => createLore(
				String(body.get('title') ?? ''), String(body.get('worldSetting') ?? ''), String(body.get('eraRules') ?? ''),
				body.get('narrativeMode')
			));
			return { message: '새 로어를 만들고 열었습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 만들지 못했습니다.'); }
	},
	switchLore: async ({ request }) => {
		const body = await request.formData();
		try {
			mutateGameState(() => switchLore(String(body.get('id') ?? '')));
			return { message: '관리할 로어를 열었습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 열지 못했습니다.'); }
	},
	renameLore: async ({ request }) => {
		const body = await request.formData();
		try {
			renameLore(String(body.get('title') ?? ''));
			return { message: '로어 제목을 저장했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '제목을 저장하지 못했습니다.'); }
	},
	scenario: async ({ request }) => {
		const body = await request.formData();
		try {
			await saveScenarioSettings(
				String(body.get('worldSetting') ?? ''), String(body.get('eraRules') ?? ''),
				String(body.get('narrativeMode') ?? '') as import('$lib/game/types').NarrativeMode
			);
			return { message: '세계관과 묘사 설정을 저장했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '설정을 저장하지 못했습니다.'); }
	},
	character: async ({ request }) => {
		const body = await request.formData();
		try {
			await saveCharacterSettings({
				id: String(body.get('id') ?? ''), name: String(body.get('name') ?? ''),
				age: Number(body.get('age')), profile: String(body.get('profile') ?? ''),
				stats: characterStats(body), marks: characterMarks(body),
				actionRequirements: characterActionRequirements(body)
			});
			return { message: '인물 설정을 저장했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '인물 설정을 저장하지 못했습니다.'); }
	},
	installModule: async ({ request }) => {
		const body = await request.formData();
		try {
			const file = body.get('moduleFile');
			if (!file || typeof file === 'string' || !file.name.toLowerCase().endsWith('.json')) {
				throw new Error('JSON 모듈 파일을 선택해 주세요.');
			}
			if (file.size > 2_000_000) throw new Error('모듈 파일은 2MB 이하여야 합니다.');
			const raw = await file.text();
			const name = mutateGameState(() => installModule(raw));
			return { message: `${name} 모듈을 설치하고 적용했습니다.`, level: 'success' as const };
		} catch (error) { return errorResult(error, '모듈을 설치하지 못했습니다.'); }
	},
	toggleModule: async ({ request }) => {
		const body = await request.formData();
		try {
			const enabled = String(body.get('enabled'));
			if (enabled !== '0' && enabled !== '1') throw new Error('모듈 상태가 올바르지 않습니다.');
			mutateGameState(() => setModuleEnabled(String(body.get('id') ?? ''), enabled === '1'));
			return { message: enabled === '1' ? '모듈을 적용했습니다.' : '모듈을 껐습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '모듈 상태를 바꾸지 못했습니다.'); }
	},
	selectWorld: async ({ request }) => {
		const body = await request.formData();
		try {
			mutateGameState(() => selectWorldModule(String(body.get('id') ?? '') || null));
			return { message: '세계관을 적용했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '세계관을 적용하지 못했습니다.'); }
	},
	importLore: async ({ request }) => {
		const body = await request.formData();
		try {
			const file = body.get('loreFile');
			if (!file || typeof file === 'string' || !file.name.toLowerCase().endsWith('.json')) {
				throw new Error('로어 JSON 파일을 선택해 주세요.');
			}
			if (file.size > 100_000_000) throw new Error('로어 파일은 100MB 이하여야 합니다.');
			const raw = await file.text();
			mutateGameState(() => importLoreJson(raw));
			return { message: '로어와 저장 슬롯을 가져왔습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 가져오지 못했습니다.'); }
	},
	deleteLore: async ({ request }) => {
		const body = await request.formData();
		try {
			mutateGameState(() => deleteLore(String(body.get('id') ?? ''), String(body.get('confirmation') ?? '')));
			return { message: '로어를 삭제했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 삭제하지 못했습니다.'); }
	}
};
