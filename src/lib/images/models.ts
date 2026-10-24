import type { HostedImageProvider } from './types';

export interface HostedImageModel { id: string; name: string }
export interface HostedImageCatalog {
	provider: HostedImageProvider;
	models: HostedImageModel[];
	/** OpenAI's model list has no capability metadata; only known GPT Image families are included. */
	filter: 'model-family' | 'image-endpoint';
}
