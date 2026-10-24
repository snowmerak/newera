import type { HostedImageProvider } from '$lib/images/types';
import { ImageGenerationError } from './common';

/** Server-only credentials and API root shared by generation and model discovery. */
export interface ImageClientConfig<P extends HostedImageProvider = HostedImageProvider> {
	provider: P;
	apiKey?: string;
	/** Defaults to NEWERA_OPENAI_API_KEY, NEWERA_XAI_API_KEY or NEWERA_OPENROUTER_API_KEY. */
	apiKeyEnv?: string;
	/** API root, including /v1 (OpenRouter: /api/v1). */
	baseUrl?: string;
	timeoutMs?: number;
}

const defaults = {
	openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'NEWERA_OPENAI_API_KEY', generationPath: '/images/generations', modelsPath: '/models' },
	xai: { baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'NEWERA_XAI_API_KEY', generationPath: '/images/generations', modelsPath: '/image-generation-models' },
	openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'NEWERA_OPENROUTER_API_KEY', generationPath: '/images', modelsPath: '/images/models' }
} as const;

export function resolveImageConnection(config: ImageClientConfig) {
	const provider = config.provider;
	const invalid = (message: string): never => { throw new ImageGenerationError(provider, 'configuration', message); };
	if (!Object.hasOwn(defaults, provider)) invalid('지원하지 않는 이미지 Provider입니다.');
	const apiKeyEnv = config.apiKeyEnv ?? defaults[provider].apiKeyEnv;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) invalid('API 키 환경 변수 이름이 올바르지 않습니다.');
	const apiKey = config.apiKey ?? process.env[apiKeyEnv];
	if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) invalid('이미지 API 키를 설정해 주세요.');
	let address: URL;
	try { address = new URL(config.baseUrl ?? defaults[provider].baseUrl); }
	catch { return invalid('이미지 API 주소가 올바르지 않습니다.'); }
	if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) invalid('API 주소는 인증 정보·쿼리·해시가 없는 HTTP(S) 주소여야 합니다.');
	const baseUrl = address.toString().replace(/\/+$/, '');
	const timeoutMs = config.timeoutMs ?? 180000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) invalid('이미지 요청 대기 시간은 1~600000ms여야 합니다.');
	return { apiKey: apiKey!, baseUrl, timeoutMs, generationPath: defaults[provider].generationPath, modelsPath: defaults[provider].modelsPath };
}
