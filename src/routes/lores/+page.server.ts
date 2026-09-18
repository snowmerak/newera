import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createLore, deleteLore, getGameView, importLoreJson, installModule, renameLore, selectWorldModule, setModuleEnabled, switchLore } from '$lib/server/db';
import { runExclusive, saveCharacterSettings, saveScenarioSettings } from '$lib/server/game';
import type { Character } from '$lib/game/types';

export const load: PageServerLoad = () => getGameView();

function errorResult(error: unknown, fallback: string) {
	return fail(400, { message: error instanceof Error ? error.message : fallback, level: 'error' as const });
}

function characterStats(body: FormData): Pick<Character, 'base' | 'abl' | 'exp' | 'relation' | 'palam'> | undefined {
	// Older callers can still create a character with the default stats.
	if (![...body.keys()].some((key) => /^(base|abl|exp|relation|palam)\./.test(key))) return undefined;
	const number = (key: string): number => {
		const raw = body.get(key);
		if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
			throw new Error(`${key}는 0 이상의 정수여야 합니다.`);
		}
		return Number(raw);
	};
	return {
		base: { energy: number('base.energy'), maxEnergy: number('base.maxEnergy') },
		abl: { conversation: number('abl.conversation'), empathy: number('abl.empathy'), seduction: number('abl.seduction') },
		exp: { conversation: number('exp.conversation'), empathy: number('exp.empathy'), seduction: number('exp.seduction') },
		relation: { affection: number('relation.affection'), trust: number('relation.trust'), desire: number('relation.desire') },
		palam: { rapport: number('palam.rapport'), trust: number('palam.trust'), arousal: number('palam.arousal'), pleasure: number('palam.pleasure') }
	};
}

export const actions: Actions = {
	createLore: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => createLore(
				String(body.get('title') ?? ''), String(body.get('worldSetting') ?? ''), String(body.get('eraRules') ?? '')
			));
			return { message: '새 로어를 만들고 열었습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 만들지 못했습니다.'); }
	},
	switchLore: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => switchLore(String(body.get('id') ?? '')));
			return { message: '관리할 로어를 열었습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 열지 못했습니다.'); }
	},
	renameLore: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => renameLore(String(body.get('title') ?? '')));
			return { message: '로어 제목을 저장했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '제목을 저장하지 못했습니다.'); }
	},
	scenario: async ({ request }) => {
		const body = await request.formData();
		try {
			await saveScenarioSettings(String(body.get('worldSetting') ?? ''), String(body.get('eraRules') ?? ''));
			return { message: '세계관과 규칙을 저장했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '설정을 저장하지 못했습니다.'); }
	},
	character: async ({ request }) => {
		const body = await request.formData();
		try {
			await saveCharacterSettings({
				id: String(body.get('id') ?? ''), name: String(body.get('name') ?? ''),
				age: Number(body.get('age')), profile: String(body.get('profile') ?? ''),
				stats: characterStats(body)
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
			const name = await runExclusive(() => installModule(raw));
			return { message: `${name} 모듈을 설치하고 적용했습니다.`, level: 'success' as const };
		} catch (error) { return errorResult(error, '모듈을 설치하지 못했습니다.'); }
	},
	toggleModule: async ({ request }) => {
		const body = await request.formData();
		try {
			const enabled = String(body.get('enabled'));
			if (enabled !== '0' && enabled !== '1') throw new Error('모듈 상태가 올바르지 않습니다.');
			await runExclusive(() => setModuleEnabled(String(body.get('id') ?? ''), enabled === '1'));
			return { message: enabled === '1' ? '모듈을 적용했습니다.' : '모듈을 껐습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '모듈 상태를 바꾸지 못했습니다.'); }
	},
	selectWorld: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => selectWorldModule(String(body.get('id') ?? '') || null));
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
			await runExclusive(() => importLoreJson(raw));
			return { message: '로어와 저장 슬롯을 가져왔습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 가져오지 못했습니다.'); }
	},
	deleteLore: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => deleteLore(String(body.get('id') ?? ''), String(body.get('confirmation') ?? '')));
			return { message: '로어를 삭제했습니다.', level: 'success' as const };
		} catch (error) { return errorResult(error, '로어를 삭제하지 못했습니다.'); }
	}
};
