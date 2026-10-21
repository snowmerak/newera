import { setTimeout as delay } from 'node:timers/promises';

export interface RetryPolicy {
	maxRetries: number;
	retryBaseMs: number;
	retryMaxMs: number;
}

export class RetryableError extends Error {}

/** Retry one inference, without replaying any already committed scene action. */
export async function withRetries<T>(label: string, policy: RetryPolicy, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		try { return await operation(); }
		catch (error) {
			signal.throwIfAborted();
			if (!(error instanceof RetryableError)) throw error;
			if (attempt >= policy.maxRetries) {
				if (!policy.maxRetries) throw error;
				throw new Error(`${label}: ${attempt + 1}회 시도 후 실패했습니다. ${error.message}`);
			}
			const waitMs = Math.min(policy.retryMaxMs, Math.ceil(policy.retryBaseMs * 2 ** attempt * (0.8 + Math.random() * 0.4)));
			console.warn(`${label}: ${waitMs}ms 후 재시도 (${attempt + 1}/${policy.maxRetries})`);
			try { await delay(waitMs, undefined, { signal }); }
			catch (error) { signal.throwIfAborted(); throw error; }
		}
	}
}
