import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getGameView, installModule, loadGame, saveGame, selectWorldModule, setModuleEnabled } from '$lib/server/db';
import { advanceWorld, performAction, performFreeAction, respondToProposal, runExclusive, saveCharacterSettings, saveScenarioSettings, suggestPlayerActions } from '$lib/server/game';

export const load: PageServerLoad = () => getGameView();

export const actions: Actions = {
	advance: async () => {
		try {
			await advanceWorld();
			return { message: '세계가 다음 장면으로 진행됐습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '장면을 진행하지 못했습니다.', level: 'error' as const });
		}
	},
	act: async ({ request }) => {
		const body = await request.formData();
		try {
			await performAction(String(body.get('actionId') ?? ''), String(body.get('targetId') ?? ''));
			return { message: '새로운 사건이 기록됐습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, {
				message: error instanceof Error ? error.message : '행동을 처리하지 못했습니다.',
				level: 'error' as const
			});
		}
	},
	suggest: async ({ request }) => {
		const body = await request.formData();
		try {
			await suggestPlayerActions(String(body.get('targetId') ?? ''));
			return { message: '지금 할 수 있는 행동을 제안받았습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '행동을 제안받지 못했습니다.', level: 'error' as const });
		}
	},
	freeAct: async ({ request }) => {
		const body = await request.formData();
		try {
			await performFreeAction(String(body.get('text') ?? ''), String(body.get('targetId') ?? ''));
			return { message: '행동을 진행했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '행동을 진행하지 못했습니다.', level: 'error' as const });
		}
	},
	proposal: async ({ request }) => {
		const body = await request.formData();
		const answer = String(body.get('answer') ?? '');
		if (answer !== 'accept' && answer !== 'decline') return fail(400, { message: '응답이 올바르지 않습니다.', level: 'error' as const });
		try {
			await respondToProposal(answer);
			return { message: '제안에 응답했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '제안에 응답하지 못했습니다.', level: 'error' as const });
		}
	},
	scenario: async ({ request }) => {
		const body = await request.formData();
		try {
			await saveScenarioSettings(String(body.get('worldSetting') ?? ''), String(body.get('eraRules') ?? ''));
			return { message: '세계관과 규칙을 저장했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '설정을 저장하지 못했습니다.', level: 'error' as const });
		}
	},
	character: async ({ request }) => {
		const body = await request.formData();
		try {
			await saveCharacterSettings({
				id: String(body.get('id') ?? ''),
				name: String(body.get('name') ?? ''),
				age: Number(body.get('age')),
				profile: String(body.get('profile') ?? ''),
				statsJson: String(body.get('statsJson') ?? '')
			});
			return { message: '인물 설정을 저장했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '인물 설정을 저장하지 못했습니다.', level: 'error' as const });
		}
	},
	installModule: async ({ request }) => {
		const body = await request.formData();
		const file = body.get('moduleFile');
		try {
			if (!file || typeof file === 'string' || !file.name.toLowerCase().endsWith('.json')) {
				throw new Error('JSON 모듈 파일을 선택해 주세요.');
			}
			if (file.size > 2_000_000) throw new Error('모듈 파일은 2MB 이하여야 합니다.');
			const raw = await file.text();
			const name = await runExclusive(() => installModule(raw));
			return { message: `${name} 모듈을 설치하고 적용했습니다.`, level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '모듈을 설치하지 못했습니다.', level: 'error' as const });
		}
	},
	toggleModule: async ({ request }) => {
		const body = await request.formData();
		try {
			const enabled = String(body.get('enabled'));
			if (enabled !== '0' && enabled !== '1') throw new Error('모듈 상태가 올바르지 않습니다.');
			await runExclusive(() => setModuleEnabled(String(body.get('id') ?? ''), enabled === '1'));
			return { message: enabled === '1' ? '모듈을 적용했습니다.' : '모듈을 껐습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '모듈 상태를 바꾸지 못했습니다.', level: 'error' as const });
		}
	},
	selectWorld: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => selectWorldModule(String(body.get('id') ?? '') || null));
			return { message: '세계관을 적용했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '세계관을 적용하지 못했습니다.', level: 'error' as const });
		}
	},
	save: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => saveGame(Number(body.get('slot'))));
			return { message: '현재 진행을 저장했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, {
				message: error instanceof Error ? error.message : '저장하지 못했습니다.',
				level: 'error' as const
			});
		}
	},
	load: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => loadGame(Number(body.get('slot'))));
			return { message: '저장된 진행을 불러왔습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, {
				message: error instanceof Error ? error.message : '불러오지 못했습니다.',
				level: 'error' as const
			});
		}
	}
};
