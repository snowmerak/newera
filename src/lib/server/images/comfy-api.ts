import type { ComfyCatalog } from '$lib/images/comfyui';
import { ImageGenerationError } from './common';
import { checkedComfyUrl, comfyError } from './comfy-workflows';

export async function comfyJson(baseUrl: string, path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown> | unknown[]> {
	try {
		const response = await fetch(baseUrl + path, { signal, redirect: 'error', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new ImageGenerationError('comfyui', 'http', `ComfyUI 요청이 실패했습니다 (HTTP ${response.status}).`, response.status);
		}
		const reader = response.body?.getReader();
		if (!reader) throw comfyError('invalid_response', 'ComfyUI 응답이 비어 있습니다.');
		const parts: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.byteLength;
				if (length > 16 * 1024 * 1024) throw comfyError('invalid_response', 'ComfyUI JSON 응답 한도를 초과했습니다.');
				parts.push(part.value);
			}
		} finally { try { await reader.cancel(); } catch { /* Already aborted. */ } reader.releaseLock(); }
		signal.throwIfAborted();
		let value: unknown;
		try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw comfyError('invalid_response', 'ComfyUI JSON 응답이 올바르지 않습니다.'); }
		if (!value || typeof value !== 'object') throw comfyError('invalid_response', 'ComfyUI 응답이 올바르지 않습니다.');
		return value as Record<string, unknown> | unknown[];
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof ImageGenerationError) throw error;
		throw comfyError('network', 'ComfyUI 서버에 연결하지 못했습니다. 주소와 실행 상태를 확인해 주세요.');
	}
}
export async function getComfyCatalog(address: string, signal?: AbortSignal): Promise<ComfyCatalog> {
	const baseUrl = checkedComfyUrl(address);
	const deadline = AbortSignal.timeout(15000);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		const [nodes, loras] = await Promise.all([comfyJson(baseUrl, '/object_info', combined), comfyJson(baseUrl, '/models/loras', combined)]);
		if (Array.isArray(nodes) || !Array.isArray(loras)) throw comfyError('invalid_response', 'ComfyUI 모델 목록 형식이 올바르지 않습니다.');
		const modelNames = (classType: string, field: string): string[] => {
			const node = nodes[classType] as { input?: { required?: Record<string, unknown[]> } } | undefined;
			const values = node?.input?.required?.[field]?.[0];
			return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
		};
		return { nodeTypes: Object.keys(nodes), models: {
			checkpoint: modelNames('CheckpointLoaderSimple', 'ckpt_name'), diffusion: modelNames('UNETLoader', 'unet_name'),
			textEncoder: modelNames('CLIPLoader', 'clip_name'), vae: modelNames('VAELoader', 'vae_name'),
			lora: Array.isArray(loras) ? loras.filter((value): value is string => typeof value === 'string') : []
		} };
	} catch (error) {
		signal?.throwIfAborted();
		if (deadline.aborted) throw comfyError('timeout', 'ComfyUI 모델 목록 조회 시간이 초과되었습니다.');
		throw error;
	}
}
