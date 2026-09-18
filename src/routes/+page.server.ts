import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getGameView, loadGame, saveGame } from '$lib/server/db';
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
