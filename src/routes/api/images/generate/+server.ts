import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { record, text } from '$lib/theater/validation';
import { getImagePreset, checkedImagePresetConfig } from '$lib/server/images/presets';
import { generateWithImageConfig, generateWorldImage, ImageGenerationBusy, imageErrorMessage, withImageGeneration } from '$lib/server/images/generate';

const headers = { 'cache-control': 'no-store' };
export const POST: RequestHandler = async ({ request, url }) => {
	if (request.headers.get('origin') !== url.origin) return json({ message: '같은 앱에서 이미지를 생성해 주세요.' }, { status: 403, headers });
	try {
		const body = record(await request.json(), '이미지 생성 요청');
		if (['worldId', 'presetId', 'config'].filter((key) => body[key] !== undefined).length !== 1) throw new Error('세션·저장 프리셋·테스트 설정 중 하나만 지정해 주세요.');
		const result = await withImageGeneration(async () => {
			if (body.worldId !== undefined) return generateWorldImage(text(body.worldId, '세션 ID', 100), body.prompt, request.signal, body.seed);
			if (body.presetId !== undefined) {
				const preset = getImagePreset(text(body.presetId, '프리셋 ID', 100));
				return { ...await generateWithImageConfig(preset.config, body.prompt, request.signal, body.seed), presetId: preset.id, presetRevision: preset.revision };
			}
			return { ...await generateWithImageConfig(checkedImagePresetConfig(body.config), body.prompt, request.signal, body.seed), presetId: '', presetRevision: 0 };
		});
		const image = result.images[0];
		return new Response(new Uint8Array(image.bytes), { headers: { ...headers, 'content-type': image.mediaType, 'x-image-seed': result.seed === undefined ? '' : String(result.seed), 'x-image-preset-id': result.presetId, 'x-image-preset-revision': String(result.presetRevision) } });
	} catch (error) { return json({ message: imageErrorMessage(error) }, { status: error instanceof ImageGenerationBusy ? 429 : 400, headers }); }
};
