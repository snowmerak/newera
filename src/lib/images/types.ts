export type HostedImageProvider = 'openai' | 'xai' | 'openrouter';
export type ImageProvider = HostedImageProvider | 'comfyui';
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface OpenAIImageOptions {
	size?: string;
	quality?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	outputFormat?: ImageFormat;
	outputCompression?: number;
	background?: 'auto' | 'opaque' | 'transparent';
}
export interface XaiImageOptions {
	aspectRatio?: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3' | '2:1' | '1:2' | '19.5:9' | '9:19.5' | '20:9' | '9:20' | '21:9' | '5:2';
	resolution?: '1k' | '2k';
	quality?: 'auto' | 'low' | 'medium';
}
export interface OpenRouterImageOptions {
	size?: string;
	aspectRatio?: string;
	resolution?: '512' | '768' | '1K' | '1.5K' | '2K' | '4K';
	quality?: 'auto' | 'low' | 'medium' | 'high';
	outputFormat?: ImageFormat;
	outputCompression?: number;
	background?: 'auto' | 'opaque' | 'transparent';
}
export interface ImageOptions {
	openai: OpenAIImageOptions;
	xai: XaiImageOptions;
	openrouter: OpenRouterImageOptions;
	comfyui: { seed?: number; width?: number; height?: number; negativePrompt?: string };
}
export interface ImageGenerationRequest<P extends ImageProvider = ImageProvider> {
	/** Explicit model ID; availability and supported options depend on the chosen model. */
	model: string;
	prompt: string;
	count?: number;
	options?: ImageOptions[P];
}
export interface GeneratedImage {
	bytes: Uint8Array;
	mediaType: ImageMediaType;
	revisedPrompt?: string;
}
export interface ImageGenerationResult {
	provider: ImageProvider;
	model: string;
	images: GeneratedImage[];
	created?: number;
	jobId?: string;
	seed?: number;
	/** Provider-specific billing fields; absent values are not zero usage. */
	usage?: Record<string, unknown>;
}
export interface ImageClient<P extends ImageProvider = ImageProvider> {
	generate(request: ImageGenerationRequest<P>, signal?: AbortSignal): Promise<ImageGenerationResult>;
}
