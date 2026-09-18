import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getGameView } from '$lib/server/db';
import { characterMarks, characterStats, nonnegativeInteger } from '$lib/server/character-form';
import { editSimulationCharacter, performConversation } from '$lib/server/simulation';

export const load: PageServerLoad = () => {
	const { lore, world, player, characters, events } = getGameView();
	return { lore, world, player, characters, simulationEvents: events.filter((event) => event.semanticEvent?.type === 'conversation').reverse() };
};

export const actions: Actions = {
	conversation: async ({ request }) => {
		const body = await request.formData();
		try {
			await performConversation(String(body.get('targetId') ?? ''));
			return { message: '대화 결과를 현재 로어에 기록했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '대화를 처리하지 못했습니다.', level: 'error' as const });
		}
	},
	edit: async ({ request }) => {
		const body = await request.formData();
		try {
			const stats = characterStats(body);
			if (!stats) throw new Error('인물 수치를 입력해 주세요.');
			await editSimulationCharacter({
				id: String(body.get('id') ?? ''), stats,
				playerEnergy: nonnegativeInteger(body, 'player.energy'),
				marks: characterMarks(body)
			});
			return { message: '인물 수치를 현재 로어에 저장했습니다.', level: 'success' as const };
		} catch (error) {
			return fail(400, { message: error instanceof Error ? error.message : '수치를 저장하지 못했습니다.', level: 'error' as const });
		}
	}
};
