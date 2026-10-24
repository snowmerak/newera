import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getComfyCatalog } from '$lib/server/images/comfy-api';
import { checkedComfySettings } from '$lib/server/images/comfy-settings';
import { createComfyImageClient } from '$lib/server/images/comfyui';
import { ImageGenerationError } from '$lib/server/images/common';

const headers = { 'cache-control': 'no-store' };
let generating = false;
export const GET: RequestHandler = async ({ url, request }) => {
	try { return json(await getComfyCatalog(url.searchParams.get('baseUrl') ?? '', request.signal), { headers }); }
	catch (error) { return json({ message: error instanceof ImageGenerationError ? error.message : 'ComfyUI 모델을 조회하지 못했습니다.' }, { status: 400, headers }); }
};
export const POST: RequestHandler = async ({ url, request }) => {
	if (request.headers.get('origin') !== url.origin) return json({ message: '같은 앱에서 이미지를 생성해 주세요.' }, { status: 403, headers });
	if (generating) return json({ message: '다른 이미지 생성 요청을 처리 중입니다. 완료 후 다시 시도해 주세요.' }, { status: 429, headers });
	generating = true;
	try {
		const body = await request.json();
		const settings = checkedComfySettings(body.settings);
		const client = createComfyImageClient(settings);
		const result = await client.generate({ model: settings.presetId, prompt: body.prompt, count: 1, options: body.seed === undefined ? {} : { seed: body.seed } }, request.signal);
		const image = result.images[0];
		return new Response(new Uint8Array(image.bytes), { headers: { ...headers, 'content-type': image.mediaType, 'x-image-job-id': result.jobId!, 'x-image-seed': String(result.seed) } });
	} catch (error) {
		return json({ message: error instanceof ImageGenerationError ? error.message : '이미지 생성 요청을 처리하지 못했습니다.', ...(error instanceof ImageGenerationError ? { code: error.code } : {}) }, { status: 400, headers });
	} finally { generating = false; }
};
