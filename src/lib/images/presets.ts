import type { ComfyPresetId, ComfyProfile } from './comfyui';
import type { HostedImageProvider, ImageOptions, ImageProvider } from './types';

interface PresetBase { baseUrl: string; stylePrompt: string }
export type HostedImagePresetConfig = {
	[P in HostedImageProvider]: PresetBase & { provider: P; apiKeyEnv: string; model: string; options: ImageOptions[P] }
}[HostedImageProvider];
export type ImagePresetConfig = HostedImagePresetConfig | (PresetBase & { provider: 'comfyui'; workflowId: ComfyPresetId; profile: ComfyProfile });
export interface ImagePresetSummary { id: string; name: string; revision: number; provider: ImageProvider }
export interface ImagePreset extends ImagePresetSummary { config: ImagePresetConfig; usedBy: number }
export const imageProviderNames: Record<ImageProvider, string> = { openai: 'OpenAI', xai: 'Grok · xAI', openrouter: 'OpenRouter', comfyui: 'ComfyUI' };
