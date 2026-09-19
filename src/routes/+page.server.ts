import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getGameView, loadGame, resetCurrentSession, saveGame, switchLore } from '$lib/server/db';
import { advanceWorld, ensurePlayerSuggestions, performAction, performFreeAction, respondToProposal, runExclusive } from '$lib/server/game';

export const load: PageServerLoad = async ({ url }) => {
	const view = getGameView();
	const requestedTarget = url.searchParams.get('target');
	const selectedTargetId = requestedTarget === null
		? view.characters[0]?.id ?? ''
		: requestedTarget === 'none'
			? ''
			: view.characters.some((character) => character.id === requestedTarget) ? requestedTarget : '';
	try {
		await ensurePlayerSuggestions(selectedTargetId);
	} catch (error) {
		console.warn('기본 행동 선택지를 생성하지 못했습니다:', error);
	}
	return { ...getGameView(), selectedTargetId };
};

export const actions: Actions = {
	switchLore: async ({ request }) => {
		const body = await request.formData();
		try {
			await runExclusive(() => switchLore(String(body.get('id') ?? '')));
			return { message: '로어를 전환했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '로어를 전환하지 못했습니다.', level: 'error' as const });
		}
	},
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
	},
	resetSession: async () => {
		try {
			await runExclusive(() => resetCurrentSession());
			return { message: '현재 세션을 처음 상태로 초기화했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, {
				message: error instanceof Error ? error.message : '현재 세션을 초기화하지 못했습니다.',
				level: 'error' as const
			});
		}
	}
};
