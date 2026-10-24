import { randomBytes } from 'node:crypto';
import zit from './workflows/zit-moody.json' with { type: 'json' };
import sdxl from './workflows/sdxl-simple.json' with { type: 'json' };
import anima from './workflows/anima-preview.json' with { type: 'json' };
import { comfyPresets } from '$lib/images/comfyui';
import type { ComfyBinding, ComfyCatalog, ComfyPresetId, ComfyProfile } from '$lib/images/comfyui';
import type { ImageGenerationRequest } from '$lib/images/types';
import { ImageGenerationError } from './common';

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const workflows: Record<ComfyPresetId, ComfyGraph> = { 'zit-moody': zit, 'sdxl-simple': sdxl, 'anima-preview': anima };
export const comfyError = (code: 'configuration' | 'invalid_request' | 'invalid_response' | 'network' | 'execution' | 'timeout', message: string) => new ImageGenerationError('comfyui', code, message);
export function checkedComfyUrl(input: unknown): string {
	let url: URL;
	try { url = new URL(String(input)); } catch { throw comfyError('configuration', 'ComfyUI 서버 주소가 올바르지 않습니다.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw comfyError('configuration', '인증 정보·쿼리·해시가 없는 HTTP(S) 서버 주소가 필요합니다.');
	return url.toString().replace(/\/+$/, '');
}
export function comfyPreset(id: unknown) {
	const preset = comfyPresets.find((entry) => entry.id === id);
	if (!preset) throw comfyError('invalid_request', '지원하지 않는 ComfyUI 워크플로우입니다.');
	return preset;
}
export function checkedDimension(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 64 || value > 4096 || value % 8) throw comfyError('invalid_request', '기본 크기는 64~4096 사이의 8의 배수여야 합니다.');
	return value;
}
export function defaultComfyProfile(id: ComfyPresetId): ComfyProfile {
	const preset = comfyPreset(id);
	return { models: { checkpoint: '', diffusion: '', textEncoder: '', vae: '', lora: '' }, width: preset.width, height: preset.height, negativePrompt: preset.negativePrompt, loraStrength: 1 };
}
export function checkedComfyProfile(id: ComfyPresetId, input: unknown): ComfyProfile {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw comfyError('configuration', '워크플로우 설정은 객체여야 합니다.');
	const row = input as Record<string, unknown>;
	if (!row.models || typeof row.models !== 'object' || Array.isArray(row.models)) throw comfyError('configuration', '모델 설정이 필요합니다.');
	const models = defaultComfyProfile(id).models;
	for (const field of Object.keys(models) as (keyof typeof models)[]) {
		const value = (row.models as Record<string, unknown>)[field];
		if (typeof value !== 'string' || value.length > 500 || /[\r\n\0]/.test(value)) throw comfyError('configuration', '모델 파일 이름이 올바르지 않습니다.');
		models[field] = value;
	}
	if (typeof row.negativePrompt !== 'string' || row.negativePrompt.length > 32000) throw comfyError('configuration', '네거티브 프롬프트는 32000자 이하여야 합니다.');
	if (typeof row.loraStrength !== 'number' || !Number.isFinite(row.loraStrength) || row.loraStrength < -2 || row.loraStrength > 2) throw comfyError('configuration', 'LoRA 강도는 -2~2여야 합니다.');
	return { models, width: checkedDimension(row.width), height: checkedDimension(row.height), negativePrompt: row.negativePrompt, loraStrength: row.loraStrength };
}
export function requiredComfyNodes(id: ComfyPresetId): string[] {
	return [...new Set(Object.values(workflows[id]).map((node) => node.class_type))];
}
export function checkComfyModels(id: ComfyPresetId, profile: ComfyProfile, catalog: ComfyCatalog): void {
	const missing = requiredComfyNodes(id).filter((node) => !catalog.nodeTypes.includes(node));
	if (missing.length) throw comfyError('configuration', `ComfyUI에 필요한 노드가 없습니다: ${missing.join(', ')}`);
	for (const model of comfyPreset(id).models) {
		const selected = profile.models[model.field];
		if (!selected && model.required) throw comfyError('configuration', `${model.label}을 선택해 주세요.`);
		if (selected && !catalog.models[model.field].includes(selected)) throw comfyError('configuration', `${model.label} 파일을 서버에서 찾을 수 없습니다. 목록을 새로 불러와 주세요.`);
	}
}
export function prepareComfyWorkflow(id: ComfyPresetId, profileInput: ComfyProfile, request: ImageGenerationRequest<'comfyui'>) {
	const preset = comfyPreset(id);
	const profile = checkedComfyProfile(id, profileInput);
	if (request.model !== id || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 32000) throw comfyError('invalid_request', '워크플로우 ID와 1~32000자 프롬프트가 필요합니다.');
	if (Object.keys(request).some((key) => !['model', 'prompt', 'count', 'options'].includes(key))) throw comfyError('invalid_request', '알 수 없는 ComfyUI 요청 필드입니다.');
	const count = request.count ?? 1;
	if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw comfyError('invalid_request', 'ComfyUI 생성 수는 1~4여야 합니다.');
	const options = request.options ?? {};
	if (typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !['seed', 'width', 'height', 'negativePrompt'].includes(key))) throw comfyError('invalid_request', '지원하지 않는 ComfyUI 옵션입니다.');
	const seed = options.seed ?? randomBytes(6).readUIntBE(0, 6);
	if (!Number.isSafeInteger(seed) || seed < 0 || seed >= 2 ** 48) throw comfyError('invalid_request', 'seed는 0 이상 2^48 미만의 정수여야 합니다.');
	if (options.negativePrompt !== undefined && (!preset.bindings.negativePrompt || typeof options.negativePrompt !== 'string' || options.negativePrompt.length > 32000)) throw comfyError('invalid_request', '이 워크플로우에서 사용할 수 없는 네거티브 프롬프트입니다.');
	const graph = structuredClone(workflows[id]);
	const put = (binding: ComfyBinding, value: unknown) => {
		const node = graph[binding.nodeId];
		if (!node || !Object.hasOwn(node.inputs, binding.input)) throw comfyError('configuration', '워크플로우 입력 매핑이 올바르지 않습니다.');
		if (binding.property) (node.inputs[binding.input] as Record<string, unknown>)[binding.property] = value;
		else node.inputs[binding.input] = value;
	};
	put(preset.bindings.prompt, request.prompt);
	put(preset.bindings.seed, seed);
	put(preset.bindings.width, checkedDimension(options.width ?? profile.width));
	put(preset.bindings.height, checkedDimension(options.height ?? profile.height));
	put(preset.bindings.count, count);
	if (preset.bindings.negativePrompt) put(preset.bindings.negativePrompt, options.negativePrompt ?? profile.negativePrompt);
	for (const model of preset.models) {
		const value = profile.models[model.field];
		if (!value && model.required) throw comfyError('configuration', `${model.label}을 선택해 주세요.`);
		put(model.binding, value || 'None');
	}
	if (id === 'zit-moody') {
		const lora = graph['822'].inputs.lora_1 as Record<string, unknown>;
		lora.on = !!profile.models.lora;
		lora.strength = profile.loraStrength;
	}
	return { graph, outputNodeId: preset.outputNodeId, count, seed };
}
