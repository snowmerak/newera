export type ComfyPresetId = 'zit-moody' | 'sdxl-simple' | 'anima-preview';
export type ComfyModelField = 'checkpoint' | 'diffusion' | 'textEncoder' | 'vae' | 'lora';
export interface ComfyBinding { nodeId: string; input: string; property?: string }
export interface ComfyPreset {
	id: ComfyPresetId;
	name: string;
	description: string;
	width: number;
	height: number;
	outputScale: number;
	negativePrompt: string;
	bindings: { prompt: ComfyBinding; seed: ComfyBinding; width: ComfyBinding; height: ComfyBinding; count: ComfyBinding; negativePrompt?: ComfyBinding };
	models: { field: ComfyModelField; label: string; binding: ComfyBinding; required: boolean }[];
	outputNodeId: string;
}
export const comfyPresets: ComfyPreset[] = [
	{
		id: 'zit-moody', name: 'ZIT · Moody Minimal', description: '두 단계 샘플링과 잠재 이미지 1.8배 확대. rgthree 노드가 필요합니다.',
		width: 640, height: 960, outputScale: 1.8, negativePrompt: '', outputNodeId: '732',
		bindings: { prompt: { nodeId: '627', input: 'text' }, seed: { nodeId: '649', input: 'seed' }, width: { nodeId: '698', input: 'width' }, height: { nodeId: '698', input: 'height' }, count: { nodeId: '698', input: 'batch_size' } },
		models: [
			{ field: 'diffusion', label: '확산 모델', required: true, binding: { nodeId: '761', input: 'unet_name' } },
			{ field: 'textEncoder', label: '텍스트 인코더', required: true, binding: { nodeId: '755', input: 'clip_name' } },
			{ field: 'vae', label: 'VAE', required: true, binding: { nodeId: '757', input: 'vae_name' } },
			{ field: 'lora', label: 'LoRA', required: false, binding: { nodeId: '822', input: 'lora_1', property: 'lora' } }
		]
	},
	{
		id: 'sdxl-simple', name: 'SDXL · Simple', description: '체크포인트 하나로 실행하는 기본 SDXL 워크플로우.',
		width: 1024, height: 1024, outputScale: 1,
		negativePrompt: 'color, colored, lowres, blurry, out of focus, deformed, bad anatomy, extra limbs, mutated, watermark, text, logo, signature', outputNodeId: '7',
		bindings: { prompt: { nodeId: '10', input: 'text' }, negativePrompt: { nodeId: '11', input: 'text' }, seed: { nodeId: '12', input: 'seed' }, width: { nodeId: '13', input: 'width' }, height: { nodeId: '13', input: 'height' }, count: { nodeId: '13', input: 'batch_size' } },
		models: [{ field: 'checkpoint', label: '체크포인트', required: true, binding: { nodeId: '15', input: 'ckpt_name' } }]
	},
	{
		id: 'anima-preview', name: 'Anima · Preview', description: '확산 모델·텍스트 인코더·VAE를 따로 선택하는 Anima 워크플로우. 30스텝, CFG 4.',
		width: 1024, height: 1024, outputScale: 1,
		negativePrompt: 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia', outputNodeId: '46',
		bindings: { prompt: { nodeId: '60:11', input: 'text' }, negativePrompt: { nodeId: '60:12', input: 'text' }, seed: { nodeId: '60:19', input: 'seed' }, width: { nodeId: '60:28', input: 'width' }, height: { nodeId: '60:28', input: 'height' }, count: { nodeId: '60:28', input: 'batch_size' } },
		models: [
			{ field: 'diffusion', label: '확산 모델', required: true, binding: { nodeId: '60:44', input: 'unet_name' } },
			{ field: 'textEncoder', label: '텍스트 인코더', required: true, binding: { nodeId: '60:45', input: 'clip_name' } },
			{ field: 'vae', label: 'VAE', required: true, binding: { nodeId: '60:15', input: 'vae_name' } }
		]
	}
];
export interface ComfyProfile {
	models: Record<ComfyModelField, string>;
	width: number;
	height: number;
	negativePrompt: string;
	loraStrength: number;
}
export interface ComfySettings {
	version: 1;
	revision: number;
	baseUrl: string;
	presetId: ComfyPresetId;
	profiles: Record<ComfyPresetId, ComfyProfile>;
}
export interface ComfyCatalog {
	models: Record<ComfyModelField, string[]>;
	nodeTypes: string[];
}
