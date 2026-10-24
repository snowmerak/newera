import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { HostedImageProvider } from '$lib/images/types';
import { ImageGenerationError } from '$lib/server/images/common';
import { getHostedImageCatalog } from '$lib/server/images/models';

const headers = { 'cache-control': 'no-store' };
// Same-origin POST prevents cross-site GETs from choosing a destination for server credentials.
export const POST: RequestHandler = async ({ url, request }) => {
	if (request.headers.get('origin') !== url.origin) return json({ message: '같은 앱에서 모델 목록을 조회해 주세요.' }, { status: 403, headers });
	try {
		const body = await request.json();
		if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['provider', 'baseUrl', 'apiKeyEnv'].includes(key)) || !['openai', 'xai', 'openrouter'].includes(body.provider) || typeof body.baseUrl !== 'string' || body.baseUrl.length > 2000 || typeof body.apiKeyEnv !== 'string' || body.apiKeyEnv.length > 200) {
			return json({ message: '모델 목록 조회 설정이 올바르지 않습니다.' }, { status: 400, headers });
		}
		return json(await getHostedImageCatalog({ provider: body.provider as HostedImageProvider, baseUrl: body.baseUrl, apiKeyEnv: body.apiKeyEnv }, request.signal), { headers });
	} catch (error) {
		return json({ message: error instanceof ImageGenerationError ? error.message : '모델 목록을 조회하지 못했습니다.' }, { status: 400, headers });
	}
};
