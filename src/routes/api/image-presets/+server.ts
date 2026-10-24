import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listImagePresets, saveImagePreset, deleteImagePreset } from '$lib/server/images/presets';
import { record, text } from '$lib/theater/validation';

const headers = { 'cache-control': 'no-store' };
export const GET: RequestHandler = () => json({ presets: listImagePresets() }, { headers });
const mutate: RequestHandler = async ({ request, url }) => {
	if (request.headers.get('origin') !== url.origin) return json({ message: '같은 앱에서 이미지 프리셋을 변경해 주세요.' }, { status: 403, headers });
	try {
		const body = record(await request.json(), '이미지 프리셋 변경');
		if (request.method === 'DELETE') { deleteImagePreset(text(body.id, '프리셋 ID', 100), Number(body.revision)); return json({ presets: listImagePresets() }, { headers }); }
		const preset = saveImagePreset(body);
		return json({ presets: listImagePresets(), savedId: preset.id }, { headers });
	} catch (error) { return json({ message: error instanceof SyntaxError ? '올바른 JSON 요청이 필요합니다.' : error instanceof Error ? error.message : '이미지 프리셋을 변경하지 못했습니다.' }, { status: 400, headers }); }
};
export const POST = mutate;
export const DELETE = mutate;
