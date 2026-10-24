import { randomUUID } from 'node:crypto';
import type { ComfySettings } from '$lib/images/comfyui';
import type { GeneratedImage, ImageClient, ImageGenerationResult } from '$lib/images/types';
import { ImageGenerationError, imageMediaType, maxImageBytes } from './common';
import { comfyJson, getComfyCatalog } from './comfy-api';
import { checkComfyModels, comfyError, comfyPreset, prepareComfyWorkflow } from './comfy-workflows';
import { checkedComfySettings } from './comfy-settings';

export interface ComfyClientOptions {
	timeoutMs?: number;
	/** Called after the queue acknowledges this exact prompt ID. */
	onQueued?: (promptId: string) => void;
}

/** Receives only the selected output node, directly over WebSocket, with no server image files. */
export function createComfyImageClient(input: ComfySettings, options: ComfyClientOptions = {}): ImageClient<'comfyui'> {
	const settings = checkedComfySettings(structuredClone(input));
	const timeoutMs = options.timeoutMs ?? 600000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) throw comfyError('configuration', 'ComfyUI 대기 시간은 1~1800000ms여야 합니다.');
	return {
		async generate(request, signal) {
			signal?.throwIfAborted();
			const preset = comfyPreset(request.model);
			const profile = settings.profiles[preset.id];
			const prepared = prepareComfyWorkflow(preset.id, profile, request);
			const deadline = new AbortController();
			const timer = setTimeout(() => deadline.abort(), timeoutMs);
			const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
			let socket: WebSocket | undefined;
			let submitted = false;
			let abortListener: (() => void) | undefined;
			const promptId = randomUUID();
			try {
				checkComfyModels(preset.id, profile, await getComfyCatalog(settings.baseUrl, combined));
				combined.throwIfAborted();
				const address = new URL(settings.baseUrl + '/ws');
				address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
				const clientId = randomUUID();
				address.searchParams.set('clientId', clientId);
				socket = new WebSocket(address);
				socket.binaryType = 'arraybuffer';
				let readyResolve!: () => void;
				let readyReject!: (error: unknown) => void;
				const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
				let completeResolve!: (images: GeneratedImage[]) => void;
				let completeReject!: (error: unknown) => void;
				const complete = new Promise<GeneratedImage[]>((resolve, reject) => { completeResolve = resolve; completeReject = reject; });
				// Completion can fail before the POST response has arrived.
				void complete.catch(() => {});
				let settled = false;
				let currentNode: string | null = null;
				const images: GeneratedImage[] = [];
				let totalBytes = 0;
				const fail = (error: unknown) => {
					if (settled) return;
					settled = true;
					readyReject(error);
					completeReject(error);
				};
				socket.addEventListener('open', () => readyResolve());
				socket.addEventListener('error', () => fail(comfyError('network', 'ComfyUI 이미지 연결에 실패했습니다.')));
				socket.addEventListener('close', () => fail(comfyError('network', '완성된 이미지를 받기 전에 ComfyUI 연결이 종료되었습니다.')));
				abortListener = () => fail(combined.reason);
				combined.addEventListener('abort', abortListener, { once: true });
				socket.addEventListener('message', (event: MessageEvent) => {
					if (settled || combined.aborted) return;
					try {
						if (typeof event.data === 'string') {
							const message = JSON.parse(event.data);
							const data = message.data;
							if (message.type === 'executing') currentNode = data?.prompt_id === promptId && typeof data.node === 'string' ? data.node : null;
							if (data?.prompt_id !== promptId) return;
							if (message.type === 'execution_error' || message.type === 'execution_interrupted') {
								fail(comfyError('execution', `ComfyUI 워크플로우 실행이 ${message.type === 'execution_interrupted' ? '중단' : '실패'}되었습니다. 서버의 실행 기록을 확인해 주세요.`));
							} else if (message.type === 'execution_success') {
								if (images.length !== prepared.count) { fail(comfyError('invalid_response', '지정한 출력 노드에서 요청 수만큼의 이미지를 받지 못했습니다.')); return; }
								settled = true;
								completeResolve(images);
							}
							return;
						}
						if (currentNode !== prepared.outputNodeId || !(event.data instanceof ArrayBuffer)) return;
						const frame = Buffer.from(event.data);
						if (frame.length < 8) throw comfyError('invalid_response', 'ComfyUI 이미지 프레임이 잘렸습니다.');
						const eventType = frame.readUInt32BE(0);
						let bytes: Buffer;
						if (eventType === 1) {
							const format = frame.readUInt32BE(4);
							bytes = frame.subarray(8);
							const expected = format === 1 ? 'image/jpeg' : format === 2 ? 'image/png' : null;
							if (!expected || imageMediaType(bytes) !== expected) throw comfyError('invalid_response', 'ComfyUI 이미지 형식이 일치하지 않습니다.');
						} else if (eventType === 4) {
							const metadataLength = frame.readUInt32BE(4);
							if (metadataLength > 65536 || frame.length <= 8 + metadataLength) throw comfyError('invalid_response', 'ComfyUI 이미지 메타데이터가 올바르지 않습니다.');
							const metadata = JSON.parse(frame.toString('utf8', 8, 8 + metadataLength));
							if ((metadata.prompt_id && metadata.prompt_id !== promptId) || (metadata.node_id && metadata.node_id !== prepared.outputNodeId)) return;
							bytes = frame.subarray(8 + metadataLength);
							if (metadata.image_type !== imageMediaType(bytes)) throw comfyError('invalid_response', 'ComfyUI 이미지 형식이 일치하지 않습니다.');
						} else { return; }
						const mediaType = imageMediaType(bytes);
						totalBytes += bytes.length;
						if (!mediaType || bytes.length > maxImageBytes || totalBytes > 64 * 1024 * 1024 || images.length >= prepared.count) throw comfyError('invalid_response', 'ComfyUI 이미지 수 또는 크기 한도를 초과했습니다.');
						images.push({ bytes, mediaType });
					} catch (error) { fail(error instanceof ImageGenerationError ? error : comfyError('invalid_response', 'ComfyUI 실행 메시지가 올바르지 않습니다.')); }
				});
				await ready;
				combined.throwIfAborted();
				submitted = true;
				const queued = await comfyJson(settings.baseUrl, '/prompt', combined, { prompt: prepared.graph, client_id: clientId, prompt_id: promptId });
				if (Array.isArray(queued) || queued.prompt_id !== promptId || queued.error) throw comfyError('invalid_response', 'ComfyUI가 워크플로우 제출을 확인하지 못했습니다.');
				options.onQueued?.(promptId);
				const received = await complete;
				combined.throwIfAborted();
				return { provider: 'comfyui', model: preset.id, jobId: promptId, seed: prepared.seed, images: received } satisfies ImageGenerationResult;
			} catch (error) {
				signal?.throwIfAborted();
				if (deadline.signal.aborted) throw comfyError('timeout', 'ComfyUI 이미지 생성 대기 시간이 초과되었습니다.');
				if (error instanceof ImageGenerationError) throw error;
				throw comfyError('network', 'ComfyUI 이미지 생성 연결에 실패했습니다.');
			} finally {
				clearTimeout(timer);
				if (abortListener) combined.removeEventListener('abort', abortListener);
				socket?.close();
				if (submitted && combined.aborted) {
					// Only delete our pending job. /interrupt would also stop somebody else's active workflow.
					try { await comfyJson(settings.baseUrl, '/queue', AbortSignal.timeout(2000), { delete: [promptId] }); } catch { /* Running jobs may continue after the receiver closes. */ }
				}
			}
		}
	};
}
