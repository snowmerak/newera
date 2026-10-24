import { eligibleImageRule, evaluateImageRules, type ImageTriggerRule } from '$lib/images/triggers';
import { judgeImageConditions } from '$lib/server/oev';
import { ImageGenerationError } from './common';
import { generateWithImageConfig, ImageGenerationBusy, withImageGeneration } from './generate';
import { acceptImageCheck, completeImageCheck, getImageCursor, imageCheckValid, pendingImageCheck, queueAutomaticImageChecks, recoverImageChecks, setImageCheckStatus, type ImageCheckJob } from './trigger-store';

let started = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** One process-wide image lane; illustration failures never fail the story turn. */
export async function processImageCheck(job: ImageCheckJob): Promise<void> {
	await withImageGeneration(async () => {
		try {
			if (!imageCheckValid(job)) { setImageCheckStatus(job.id, 'skipped'); return; }
			setImageCheckStatus(job.id, 'checking');
			const { scene, rules, manual } = job.input;
			let cursor = getImageCursor(job.worldId);
			let fired: ImageTriggerRule[] = [];
			if (!manual) {
				// Queued snapshots are processed in order. Rewinds/reset remove the jobs and establish a new baseline.
				if (scene.revision <= cursor.revision) { setImageCheckStatus(job.id, 'skipped'); return; }
				const semantic = rules.filter((rule) => eligibleImageRule(rule, scene, cursor) && rule.naturalLanguage.trim());
				const matches = await judgeImageConditions(semantic.map((rule) => ({ id: rule.id, condition: rule.naturalLanguage })), scene.context, job.input.models, AbortSignal.timeout(120000));
				const evaluated = evaluateImageRules(rules, scene, cursor, matches);
				cursor = evaluated.cursor; fired = evaluated.fired;
			}
			const reason = manual ? '현재 장면 요청' : fired.map((rule) => rule.name).join(' · ');
			if (!acceptImageCheck(job, cursor, reason)) return;
			const instructions = fired.map((rule) => rule.prompt.trim()).filter(Boolean).join('\n').slice(0, 8000);
			const prompt = ['Create one narrative illustration of the current scene. Use only visible appearances and established events. Do not add text or captions.', instructions, `Current scene and recent events:\n${scene.context}`].filter(Boolean).join('\n\n');
			const result = await generateWithImageConfig(job.input.config, prompt);
			completeImageCheck(job.id, result.images[0].bytes, result.images[0].mediaType);
		} catch (error) {
			setImageCheckStatus(job.id, 'failed', undefined, error instanceof ImageGenerationError ? error.message : '삽화 조건 판단 또는 생성에 실패했습니다. 프리셋과 세션의 생성 모델 설정을 확인해 주세요. 자동 재시도하지 않습니다.');
		}
	});
}

async function drain(): Promise<void> {
	if (running) return;
	running = true;
	try {
		let job;
		while ((job = pendingImageCheck())) {
			try { await processImageCheck(job); }
			catch (error) {
				if (error instanceof ImageGenerationBusy) {
					timer = setTimeout(() => { timer = undefined; ensureImageWorker(); }, 1000);
					return;
				}
				throw error;
			}
		}
	} finally { running = false; }
}
export function ensureImageWorker(): void {
	if (!started) { recoverImageChecks(); started = true; }
	queueAutomaticImageChecks();
	if (!running && !timer) void drain().catch(() => console.error('삽화 작업을 처리하지 못했습니다.'));
}
