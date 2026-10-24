import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { comfyPresets } from '$lib/images/comfyui';
import { getComfySettings, saveComfySettings } from '$lib/server/images/comfy-settings';
import { requiredComfyNodes } from '$lib/server/images/comfy-workflows';

export const load: PageServerLoad = () => ({ settings: getComfySettings(), presets: comfyPresets.map((preset) => ({ ...preset, requiredNodeTypes: requiredComfyNodes(preset.id) })) });
export const actions: Actions = {
	save: async ({ request }) => {
		try {
			const form = await request.formData();
			saveComfySettings(JSON.parse(String(form.get('settings'))));
			return { message: 'ComfyUI 주소와 워크플로우별 설정을 저장했습니다.', error: false };
		} catch (error) {
			return fail(400, { message: error instanceof SyntaxError ? '설정 JSON이 올바르지 않습니다.' : error instanceof Error ? error.message : '이미지 설정을 저장하지 못했습니다.', error: true });
		}
	}
};
