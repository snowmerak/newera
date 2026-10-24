import { Buffer } from 'node:buffer';
import type { HostedImageCatalog, HostedImageModel } from '$lib/images/models';
import type { HostedImageProvider } from '$lib/images/types';
import { ImageGenerationError } from './common';
import { resolveImageConnection, type ImageClientConfig } from './hosted';

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const maxBytes = 4 * 1024 * 1024;
const invalid = (provider: HostedImageProvider) => new ImageGenerationError(provider, 'invalid_response', '모델 목록 응답이 올바르지 않거나 허용 크기를 초과했습니다.');

async function readCatalog(response: Response, provider: HostedImageProvider, signal: AbortSignal): Promise<unknown> {
	if (!response.body) throw invalid(provider);
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await response.body.cancel();
		throw invalid(provider);
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
			if (size > maxBytes) throw invalid(provider);
			chunks.push(part.value);
		}
		signal.throwIfAborted();
		try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
		catch { throw invalid(provider); }
	} finally {
		try { await reader.cancel(); } catch { /* Fetch may already be cancelled. */ }
		reader.releaseLock();
	}
}

function normalize(provider: HostedImageProvider, value: unknown): HostedImageCatalog {
	if (!record(value)) throw invalid(provider);
	const entries = provider === 'xai' ? value.models : value.data;
	if (!Array.isArray(entries) || entries.length > 10000) throw invalid(provider);
	const models = new Map<string, HostedImageModel>();
	for (const entry of entries) {
		if (!record(entry) || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 200) throw invalid(provider);
		if (provider === 'openai') {
			// /models has no capabilities. Vision/chat models and legacy DALL-E (different response contract) are excluded.
			if (!/^(gpt-image-|chatgpt-image-)[a-z0-9][a-z0-9.-]*$/.test(entry.id)) continue;
		} else {
			const architecture = provider === 'openrouter' ? entry.architecture : entry;
			if (!record(architecture) || !Array.isArray(architecture.input_modalities) || !Array.isArray(architecture.output_modalities)) throw invalid(provider);
			if (!architecture.input_modalities.includes('text') || !architecture.output_modalities.includes('image')) continue;
		}
		const name = typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 300 ? entry.name : entry.id;
		models.set(entry.id, { id: entry.id, name });
	}
	return { provider, models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), filter: provider === 'openai' ? 'model-family' : 'image-endpoint' };
}

/** Read-only provider discovery. Returns public model names only, never upstream credentials or errors. */
export async function getHostedImageCatalog(config: ImageClientConfig, signal?: AbortSignal): Promise<HostedImageCatalog> {
	signal?.throwIfAborted();
	const provider = config.provider;
	const { apiKey, baseUrl, modelsPath, timeoutMs } = resolveImageConnection({ ...config, timeoutMs: config.timeoutMs ?? 20000 });
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
	try {
		const response = await fetch(baseUrl + modelsPath, { redirect: 'error', signal: combined, headers: { authorization: `Bearer ${apiKey}` } });
		combined.throwIfAborted();
		if (!response.ok) {
			try { await response.body?.cancel(); } catch { /* Do not expose an upstream error body. */ }
			throw new ImageGenerationError(provider, 'http', `모델 목록 요청이 실패했습니다 (HTTP ${response.status}).`, response.status);
		}
		const value = await readCatalog(response, provider, combined);
		combined.throwIfAborted();
		return normalize(provider, value);
	} catch (error) {
		signal?.throwIfAborted();
		if (timeout.signal.aborted) throw new ImageGenerationError(provider, 'timeout', '모델 목록 응답 대기 시간을 초과했습니다.');
		if (error instanceof ImageGenerationError) throw error;
		throw new ImageGenerationError(provider, 'network', '모델 목록 API와 통신하지 못했습니다.');
	} finally { clearTimeout(timer); }
}
