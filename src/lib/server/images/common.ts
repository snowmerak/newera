import { Buffer } from 'node:buffer';
import type { ImageMediaType, ImageProvider } from '$lib/images/types';

export type ImageErrorCode = 'configuration' | 'invalid_request' | 'http' | 'network' | 'timeout' | 'invalid_response' | 'content_filtered' | 'execution';
export class ImageGenerationError extends Error {
	readonly provider: ImageProvider;
	readonly code: ImageErrorCode;
	readonly status?: number;
	constructor(provider: ImageProvider, code: ImageErrorCode, message: string, status?: number) {
		super(`${provider}: ${message}`);
		this.name = 'ImageGenerationError';
		this.provider = provider;
		this.code = code;
		this.status = status;
	}
}
export const maxImageBytes = 20 * 1024 * 1024;
export function imageMediaType(value: Uint8Array): ImageMediaType | undefined {
	const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
	if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
	return undefined;
}
