import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProviders, saveProvider, deleteProvider } from '$lib/server/providers';
import { discoverProviderModels, modelSettings } from '$lib/server/oev';
import { record } from '$lib/theater/validation';
import { store } from '$lib/server/stage-store';

const headers = { 'cache-control': 'no-store' };
export const GET: RequestHandler = async ({ request, url }) => {
	try { return json(url.searchParams.has('models') ? await discoverProviderModels(url.searchParams.get('models')!, request.signal) : getProviders(modelSettings()), { headers }); }
	catch (error) { return json({ message: error instanceof Error ? error.message : 'Provider 목록을 읽지 못했습니다.' }, { status: 400, headers }); }
};
const mutate: RequestHandler = async ({ request, url }) => {
	if (request.headers.get('origin') !== url.origin) return json({ message: '같은 앱에서 Provider 설정을 변경해 주세요.' }, { status: 403, headers });
	try {
		const body = record(await request.json(), 'Provider 변경');
		const settings = modelSettings();
		const selections = store().prepare('SELECT model_settings_json FROM theater_worlds WHERE model_settings_json IS NOT NULL').all().map((row) => record(JSON.parse(String(row.model_settings_json)), '모델 선택'));
		if (request.method === 'DELETE') {
			const id = String(body.id);
			const inUse = selections.some((selection) => Object.values(selection).some((value) => typeof value === 'string' && value.startsWith(`${id}::`)));
			if (inUse) throw new Error('이 Provider를 선택한 세션이 있습니다. 해당 세션의 모델을 먼저 변경해 주세요.');
			return json(deleteProvider(settings, Number(body.revision), id), { headers });
		}
		const provider = record(body.provider, 'Provider');
		for (const selection of selections) {
			for (const [role, reference] of Object.entries(selection)) {
				if (typeof reference !== 'string' || !reference.startsWith(`${provider.id}::`)) continue;
				const aliases = Array.isArray(provider.models) ? provider.models.map((model) => record(model, '모델 별칭')) : [];
				const alias = aliases.find((model) => model.id === reference.split('::')[1]);
				if (!alias || alias.task !== 'generation' || (role === 'decisionModel' && provider.kind !== 'oev')) throw new Error('세션에서 사용하는 모델 별칭입니다. 세션 모델을 먼저 변경한 뒤 별칭을 제거하거나 용도를 바꿔 주세요.');
			}
		}
		return json(saveProvider(settings, Number(body.revision), body.provider, body.clearApiKey === true), { headers });
	} catch (error) { return json({ message: error instanceof SyntaxError ? 'Provider 요청은 올바른 JSON 객체여야 합니다.' : error instanceof Error ? error.message : 'Provider 설정을 저장하지 못했습니다.' }, { status: 400, headers }); }
};
export const POST = mutate;
export const DELETE = mutate;
