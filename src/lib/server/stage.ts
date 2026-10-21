import { randomUUID } from 'node:crypto';
import { resolveTurn, type Director } from '$lib/theater/ensemble';
import type { PlayerRequest } from '$lib/theater/types';
import { createDirector, modelSettings } from './oev';
import { checkJob, claimJob, enqueue, failJob, finishJob, getWorld, heartbeatJob, runnableJobs, saveJobProgress } from './stage-store';

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
		const connection = () => connected ??= createDirector(controller.signal, job.models, checkpoint);
		const director: Director = {
			decide: async (state) => (await connection()).decide(state),
			perform: async (state, actions) => (await connection()).perform(state, actions)
		};
		await resolveTurn(getWorld(job.worldId), job.request, director, checkpoint, {
			progress: job.progress,
			onProgress: (world, progress) => saveJobProgress(job, workerId, world, progress)
		});
		finishJob(job, workerId);
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
	const settings = modelSettings();
	const job = enqueue(worldId, revision, request, { decisionModel: settings.decisionModel, textModel: settings.textModel });
	schedule(job.id);
}
