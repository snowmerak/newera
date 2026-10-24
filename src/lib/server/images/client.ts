import { Buffer } from 'node:buffer';
import type { GeneratedImage, HostedImageProvider, ImageClient, ImageGenerationRequest, ImageGenerationResult } from '$lib/images/types';
import { ImageGenerationError, imageMediaType, maxImageBytes } from './common';
import { resolveImageConnection, type ImageClientConfig } from './hosted';
export type { ImageClientConfig } from './hosted';
export { ImageGenerationError } from './common';
export type { ImageErrorCode } from './common';

const maxResponseBytes = 64 * 1024 * 1024;
type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

function requestBody(provider: HostedImageProvider, request: ImageGenerationRequest): Fields {
	const invalid = (message: string): never => { throw new ImageGenerationError(provider, 'invalid_request', message); };
	if (!isRecord(request)) invalid('이미지 생성 요청이 올바르지 않습니다.');
	if (Object.keys(request).some((key) => !['model', 'prompt', 'count', 'options'].includes(key))) invalid('알 수 없는 이미지 생성 요청 필드입니다.');
	for (const [key, limit] of [['model', 200], ['prompt', 32000]] as const) {
		if (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > limit) invalid(`${key}는 1~${limit}자 문자열이어야 합니다.`);
	}
	const count = request.count ?? 1;
	if (!Number.isSafeInteger(count) || count < 1 || count > 10) invalid('이미지 수는 1~10이어야 합니다.');
	const options = request.options ?? {};
	if (!isRecord(options)) invalid('이미지 옵션은 객체여야 합니다.');
	const body: Fields = { model: request.model, prompt: request.prompt, n: count };
	const fields: Record<string, string> = provider === 'xai'
		? { aspectRatio: 'aspect_ratio', resolution: 'resolution', quality: 'quality' }
		: { size: 'size', quality: 'quality', outputFormat: 'output_format', outputCompression: 'output_compression', background: 'background', ...(provider === 'openrouter' ? { aspectRatio: 'aspect_ratio', resolution: 'resolution' } : {}) };
	const choices: Record<string, readonly unknown[]> = {
		quality: provider === 'xai' ? ['auto', 'low', 'medium'] : provider === 'openai' ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto', 'low', 'medium', 'high'],
		outputFormat: ['png', 'jpeg', 'webp'], background: ['auto', 'opaque', 'transparent'],
		resolution: provider === 'xai' ? ['1k', '2k'] : ['512', '768', '1K', '1.5K', '2K', '4K']
	};
	for (const [key, value] of Object.entries(options)) {
		if (!Object.hasOwn(fields, key)) invalid('선택한 Provider에서 지원하지 않는 이미지 옵션입니다.');
		if (value === undefined) continue;
		if (choices[key] && !choices[key].includes(value)) invalid(`${key} 옵션이 올바르지 않습니다.`);
		if (key === 'size') {
			const size = provider === 'openai' ? /^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/ : /^(512|768|1K|1\.5K|2K|4K|[1-9]\d{0,4}x[1-9]\d{0,4})$/;
			if (typeof value !== 'string' || !size.test(value)) invalid('size 옵션이 올바르지 않습니다.');
		}
		if (key === 'aspectRatio') {
			const valid = typeof value === 'string' && (provider === 'xai'
				? ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2'].includes(value)
				: /^(auto|[1-9]\d{0,2}:[1-9]\d{0,2})$/.test(value));
			if (!valid) invalid('aspectRatio 옵션이 올바르지 않습니다.');
		}
		if (key === 'outputCompression' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100)) invalid('압축률은 0~100이어야 합니다.');
		body[fields[key]] = value;
	}
	if (body.output_compression !== undefined && body.output_format !== 'jpeg' && body.output_format !== 'webp') invalid('압축률에는 jpeg 또는 webp 형식을 지정해 주세요.');
	if (body.background === 'transparent' && body.output_format === 'jpeg') invalid('투명 배경에는 png 또는 webp 형식이 필요합니다.');
	// GPT Image rejects response_format; xAI defaults to expiring URLs unless explicitly asked for bytes.
	if (provider === 'xai') body.response_format = 'b64_json';
	return body;
}

/** Validate saved options without resolving credentials or making a billable request. */
export function validateHostedImageRequest(provider: HostedImageProvider, request: ImageGenerationRequest): void { requestBody(provider, request); }

async function readJson(response: Response, provider: HostedImageProvider, signal: AbortSignal): Promise<unknown> {
	const invalid = () => new ImageGenerationError(provider, 'invalid_response', '이미지 응답 형식이 잘못되었거나 64MiB 한도를 초과했습니다.');
	if (!response.body) throw invalid();
	if (Number(response.headers.get('content-length')) > maxResponseBytes) {
		await response.body.cancel();
		throw invalid();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maxResponseBytes) throw invalid();
			chunks.push(part.value);
		}
		signal.throwIfAborted();
		try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
		catch { throw invalid(); }
	} finally {
		try { await reader.cancel(); } catch { /* The fetch may already have aborted. */ }
		reader.releaseLock();
	}
}

function result(provider: HostedImageProvider, request: Pick<ImageGenerationRequest, 'model' | 'count'>, value: unknown): ImageGenerationResult {
	const invalid = (): never => { throw new ImageGenerationError(provider, 'invalid_response', '유효한 PNG·JPEG·WebP 이미지 응답이 필요합니다.'); };
	if (!isRecord(value)) return invalid();
	if (!Array.isArray(value.data) || !value.data.length || value.data.length > (request.count ?? 1)) return invalid();
	const images: GeneratedImage[] = value.data.map((entry: unknown) => {
		if (!isRecord(entry)) return invalid();
		if (entry.respect_moderation === false) throw new ImageGenerationError(provider, 'content_filtered', '이미지 생성이 Provider의 콘텐츠 검사를 통과하지 못했습니다.');
		const encoded = entry.b64_json;
		// Buffer.from tolerates malformed base64, so validate before decoding and allocation.
		if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(maxImageBytes / 3) * 4 || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(encoded.replace(/={1,2}$/, ''))) return invalid();
		const bytes = Buffer.from(encoded, 'base64');
		if (bytes.length > maxImageBytes || bytes.toString('base64') !== encoded) return invalid();
		const detected = imageMediaType(bytes);
		if (!detected) return invalid();
		for (const declared of [entry.media_type, entry.mime_type]) {
			if (declared !== undefined && declared !== detected) return invalid();
		}
		if (entry.revised_prompt !== undefined && typeof entry.revised_prompt !== 'string') return invalid();
		return { bytes, mediaType: detected, ...(typeof entry.revised_prompt === 'string' ? { revisedPrompt: entry.revised_prompt } : {}) };
	});
	if (value.created !== undefined && (typeof value.created !== 'number' || !Number.isSafeInteger(value.created) || value.created < 0)) return invalid();
	if (value.usage !== undefined && !isRecord(value.usage)) return invalid();
	return { provider, model: typeof value.model === 'string' && value.model.trim() ? value.model : request.model, images,
		...(typeof value.created === 'number' ? { created: value.created } : {}), ...(isRecord(value.usage) ? { usage: value.usage } : {}) };
}

/** A single non-streaming generation. Never retries a potentially billable request automatically. */
export function createImageClient<P extends HostedImageProvider>(config: ImageClientConfig<P>): ImageClient<P> {
	const provider = config.provider;
	const { apiKey, baseUrl, generationPath, timeoutMs } = resolveImageConnection(config);
	const endpoint = baseUrl + generationPath;
	return {
		async generate(request, signal) {
			signal?.throwIfAborted();
			const body = requestBody(provider, request);
			// Snapshot caller-owned input before awaiting network I/O.
			const accepted = { model: request.model, count: request.count };
			const timeout = new AbortController();
			const timer = setTimeout(() => timeout.abort(), timeoutMs);
			const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
			try {
				const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: combined,
					headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
				combined.throwIfAborted();
				if (!response.ok) {
					try { await response.body?.cancel(); } catch { /* Do not expose an upstream error body. */ }
					throw new ImageGenerationError(provider, 'http', `이미지 API 요청이 실패했습니다 (HTTP ${response.status}).`, response.status);
				}
				const value = await readJson(response, provider, combined);
				combined.throwIfAborted();
				return result(provider, accepted, value);
			} catch (error) {
				signal?.throwIfAborted();
				if (timeout.signal.aborted) throw new ImageGenerationError(provider, 'timeout', '이미지 생성 응답 대기 시간을 초과했습니다.');
				if (error instanceof ImageGenerationError) throw error;
				// Transport exceptions may contain headers or request URLs. Keep them out of user-visible errors.
				throw new ImageGenerationError(provider, 'network', '이미지 API와 통신하지 못했습니다.');
			} finally { clearTimeout(timer); }
		}
	};
}
