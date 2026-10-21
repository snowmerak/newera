import { randomUUID } from 'node:crypto';
import { resolveTurn, type Director } from '$lib/theater/ensemble';
import type { PlayerRequest } from '$lib/theater/types';
import { createDirector } from './oev';
import { checkJob, claimJob, enqueue, failJob, finishJob, getWorld, heartbeatJob, runnableJobs } from './stage-store';

const workerId = randomUUID();
const scheduled = new Set<string>();
const leaseMs = 15000;

async function processJob(id: string): Promise<void> {
	const job = claimJob(id, workerId, new Date(Date.now() - leaseMs).toISOString());
	if (!job) return;
	const controller = new AbortController();
	const checkpoint = () => { controller.signal.throwIfAborted(); checkJob(job, workerId); };
	const timer = setInterval(() => {
		try { checkpoint(); heartbeatJob(id, workerId); }
		catch (error) { controller.abort(error); }
	}, 3000);
	try {
		checkpoint();
		// Empty scenes and object-only turns do not need a model connection.
		let connected: Promise<Director> | undefined;
		const connection = () => connected ??= createDirector(controller.signal);
		const director: Director = {
			decide: async (state, actions) => (await connection()).decide(state, actions),
			speak: async (state, decision) => (await connection()).speak(state, decision)
		};
		const result = await resolveTurn(getWorld(job.worldId), job.request, director, checkpoint);
		finishJob(job, workerId, result);
	} catch (error) {
		failJob(id, workerId, error instanceof Error ? error.message : '장면 진행에 실패했습니다.');
	} finally { clearInterval(timer); }
}
function schedule(id: string): void {
	if (scheduled.has(id)) return;
	scheduled.add(id);
	setTimeout(() => {
		void processJob(id).catch((error) => console.error('장면 작업을 실행하지 못했습니다:', error)).finally(() => scheduled.delete(id));
	}, 0);
}
export function ensureStageWorker(): void {
	for (const id of runnableJobs(new Date(Date.now() - leaseMs).toISOString())) schedule(id);
}
export function queueStageTurn(worldId: string, revision: number, request: PlayerRequest): void {
	const job = enqueue(worldId, revision, request);
	schedule(job.id);
}
