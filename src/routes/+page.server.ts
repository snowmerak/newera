import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getStageView, loadWorld, resetWorld, saveWorld, selectWorld } from '$lib/server/stage-store';
import { ensureStageWorker, queueStageTurn } from '$lib/server/stage';

export const load: PageServerLoad = () => { ensureStageWorker(); return getStageView(); };

function failed(error: unknown) {
	return fail(400, { message: error instanceof Error ? error.message : '요청을 처리하지 못했습니다.' });
}
export const actions: Actions = {
	turn: async ({ request }) => {
		try {
			const body = await request.formData();
			const kind = String(body.get('kind'));
			const worldId = String(body.get('worldId'));
			const revision = Number(body.get('revision'));
			if (kind === 'speak') queueStageTurn(worldId, revision, { kind, text: String(body.get('text') ?? ''), targetId: String(body.get('targetId') ?? '') || null });
			else if (kind === 'move') queueStageTurn(worldId, revision, { kind, destinationId: String(body.get('destinationId')) });
			else if (kind === 'interact') queueStageTurn(worldId, revision, { kind, targetId: String(body.get('targetId')), interactionId: String(body.get('interactionId')) });
			else if (kind === 'wait') queueStageTurn(worldId, revision, { kind });
			else throw new Error('알 수 없는 행동입니다.');
			return { message: '' };
		} catch (error) { return failed(error); }
	},
	selectWorld: async ({ request }) => {
		try { selectWorld(String((await request.formData()).get('worldId'))); return { message: '세계관을 열었습니다.' }; }
		catch (error) { return failed(error); }
	},
	save: async ({ request }) => {
		try { const body = await request.formData(); saveWorld(String(body.get('worldId')), Number(body.get('slot'))); return { message: '진행을 저장했습니다.' }; }
		catch (error) { return failed(error); }
	},
	load: async ({ request }) => {
		try { const body = await request.formData(); loadWorld(String(body.get('worldId')), Number(body.get('revision')), Number(body.get('slot'))); return { message: '진행을 불러왔습니다.' }; }
		catch (error) { return failed(error); }
	},
	reset: async ({ request }) => {
		try { const body = await request.formData(); resetWorld(String(body.get('worldId')), Number(body.get('revision'))); return { message: '초기 배치로 돌아갔습니다.' }; }
		catch (error) { return failed(error); }
	}
};
