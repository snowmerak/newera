import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getStageView, loadWorld, resetWorld, saveWorld, selectWorld, setWorldModels, setWorldImagePreset, stopJob } from '$lib/server/stage-store';
import { listImagePresets } from '$lib/server/images/presets';
import { ensureStageWorker, queueStageTurn, retryStageTurn } from '$lib/server/stage';
import { getModelCatalog, modelSettings } from '$lib/server/oev';
import { checkedModelSelection } from '$lib/theater/validation';
import { resolveProviderSnapshot } from '$lib/server/providers';

export const load: PageServerLoad = () => { ensureStageWorker(); return { ...getStageView(), imagePresets: listImagePresets().map(({ id, name, revision, provider }) => ({ id, name, revision, provider })) }; };

function failed(error: unknown) {
	return fail(400, { message: error instanceof Error ? error.message : '요청을 처리하지 못했습니다.' });
}
export const actions: Actions = {
	imagePreset: async ({ request }) => {
		try {
			const body = await request.formData();
			setWorldImagePreset(String(body.get('worldId')), String(body.get('imagePresetId') ?? '') || null);
			return { message: '이 세션의 이미지 프리셋을 적용했습니다.' };
		} catch (error) { return failed(error); }
	},
	stop: async ({ request }) => {
		try {
			const body = await request.formData();
			stopJob(String(body.get('worldId')), String(body.get('jobId')));
			return { message: '' };
		} catch (error) { return failed(error); }
	},
	retry: async ({ request }) => {
		try {
			const body = await request.formData();
			retryStageTurn(String(body.get('worldId')), Number(body.get('revision')), String(body.get('jobId')));
			return { message: '' };
		} catch (error) { return failed(error); }
	},
	models: async ({ request }) => {
		try {
			const body = await request.formData();
			const worldId = String(body.get('worldId'));
			if (body.get('mode') === 'defaults') {
				setWorldModels(worldId, null);
				return { message: '이 세션은 다음 새 진행 또는 이어서 재시도부터 기본 모델을 사용합니다.', models: null };
			}
			const selection = checkedModelSelection({ decisionModel: body.get('decisionModel'), textModel: body.get('textModel') });
			const catalog = await getModelCatalog(request.signal);
			if (!catalog.models.includes(selection.decisionModel) || !catalog.models.includes(selection.textModel)) throw new Error('등록된 Provider에서 사용할 수 있는 모델을 선택해 주세요.');
			resolveProviderSnapshot(modelSettings(), selection);
			setWorldModels(worldId, selection);
			return { message: '이 세션의 판단·생성 모델을 저장했습니다. 다음 새 진행 또는 이어서 재시도부터 적용됩니다.', models: selection };
		} catch (error) { return failed(error); }
	},
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
