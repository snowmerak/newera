import type { ImagePresetConfig } from '$lib/images/presets';
import type { ImageGenerationResult } from '$lib/images/types';
import { getWorld } from '$lib/server/stage-store';
import { createImageClient } from './client';
import { createComfyImageClient } from './comfyui';
import { defaultComfySettings } from './comfy-settings';
import { ImageGenerationError } from './common';
import { checkedImagePresetConfig, getImagePreset } from './presets';

export async function generateWithImageConfig(input: ImagePresetConfig, prompt: unknown, signal?: AbortSignal, seed?: unknown): Promise<ImageGenerationResult> {
	const config = checkedImagePresetConfig(structuredClone(input));
	if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('그릴 장면을 1~32000자로 입력해 주세요.');
	const styledPrompt = [config.stylePrompt, prompt].filter(Boolean).join('\n\n');
	if (styledPrompt.length > 32000) throw new Error('화풍 지침과 장면 프롬프트의 합은 32000자 이하여야 합니다.');
	if (config.provider === 'comfyui') {
		const settings = defaultComfySettings(config.baseUrl);
		settings.presetId = config.workflowId;
		settings.profiles[config.workflowId] = config.profile;
		return createComfyImageClient(settings).generate({ model: config.workflowId, prompt: styledPrompt, count: 1, options: seed === undefined ? {} : { seed: seed as number } }, signal);
	}
	if (seed !== undefined) throw new Error('Seed 지정은 ComfyUI 프리셋에서만 지원합니다.');
	return createImageClient({ provider: config.provider, baseUrl: config.baseUrl, apiKeyEnv: config.apiKeyEnv }).generate({ model: config.model, prompt: styledPrompt, count: 1, options: config.options }, signal);
}

/** Resolve once; changes to this session or the shared preset affect only later requests. */
export async function generateWorldImage(worldId: string, prompt: unknown, signal?: AbortSignal, seed?: unknown) {
	const id = getWorld(worldId).imagePresetId;
	if (!id) throw new Error('이 세션에서 사용할 이미지 프리셋을 먼저 선택해 주세요.');
	const preset = getImagePreset(id);
	const result = await generateWithImageConfig(preset.config, prompt, signal, seed);
	return { ...result, presetId: preset.id, presetRevision: preset.revision };
}

let generating = false;
export class ImageGenerationBusy extends Error {}
export async function withImageGeneration<T>(operation: () => Promise<T>): Promise<T> {
	if (generating) throw new ImageGenerationBusy('다른 이미지 생성 요청을 처리 중입니다. 완료 후 다시 시도해 주세요.');
	generating = true;
	try { return await operation(); } finally { generating = false; }
}
export function imageErrorMessage(error: unknown): string {
	return error instanceof ImageGenerationError || error instanceof ImageGenerationBusy || error instanceof Error && !(error instanceof SyntaxError) ? error.message : '이미지 생성 요청을 처리하지 못했습니다.';
}
