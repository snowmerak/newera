import { randomUUID } from 'node:crypto';
import type { ImagePresetConfig } from '$lib/images/presets';
import { checkedImageTriggers, defaultImageTriggers, imageSceneSnapshot, imageTriggerCursor, type ImageSceneSnapshot, type ImageTriggerCursor, type ImageTriggerSettings, type ImageTriggerView, type Illustration } from '$lib/images/triggers';
import type { ModelSelection } from '$lib/theater/types';
import { getWorld, store, transaction } from '$lib/server/stage-store';
import { modelSettings } from '$lib/server/oev';
import { getImagePreset } from './presets';

type Row = Record<string, unknown>;
export interface ImageCheckInput {
	scene: ImageSceneSnapshot; rules: ImageTriggerSettings['rules']; manual: boolean;
	presetId: string; presetRevision: number; config: ImagePresetConfig; models: ModelSelection | null;
}
export interface ImageCheckJob { id: string; worldId: string; settingsRevision: number; input: ImageCheckInput }
export const maxIllustrations = 100;

export function getImageTriggers(worldId: string): ImageTriggerView {
	getWorld(worldId);
	const row = store().prepare('SELECT * FROM theater_image_settings WHERE world_id = ?').get(worldId) as Row | undefined;
	return row ? { revision: Number(row.revision), config: checkedImageTriggers(JSON.parse(String(row.config_json))) } : { revision: 0, config: defaultImageTriggers() };
}
export function getImageCursor(worldId: string): ImageTriggerCursor {
	const row = store().prepare('SELECT cursor_json FROM theater_image_settings WHERE world_id = ?').get(worldId) as Row | undefined;
	return row ? JSON.parse(String(row.cursor_json)) : imageTriggerCursor(getWorld(worldId));
}
export function saveImageTriggers(worldId: string, revision: number, input: unknown): ImageTriggerView {
	return transaction(() => {
		const world = getWorld(worldId);
		const config = checkedImageTriggers(input, world);
		if (!Number.isSafeInteger(revision) || getImageTriggers(worldId).revision !== revision) throw new Error('이미지 생성 조건이 변경되었습니다. 새로고침 후 다시 저장해 주세요.');
		if (config.enabled && !world.imagePresetId) throw new Error('이 세션의 이미지 프리셋을 먼저 적용해 주세요.');
		store().prepare('INSERT INTO theater_image_settings VALUES (?, ?, ?, ?) ON CONFLICT(world_id) DO UPDATE SET revision = excluded.revision, config_json = excluded.config_json, cursor_json = excluded.cursor_json')
			.run(worldId, revision + 1, JSON.stringify(config), JSON.stringify(imageTriggerCursor(world)));
		store().prepare("UPDATE theater_illustrations SET status = 'skipped' WHERE world_id = ? AND status IN ('pending', 'checking') AND source_key NOT LIKE 'manual:%'").run(worldId);
		return { revision: revision + 1, config };
	});
}

/** Queue a public scene snapshot, never the private world. Credentials resolve only when executing. */
export function queueImageCheck(worldId: string, manual = false): string | null {
	return transaction(() => {
		const world = getWorld(worldId);
		const settings = getImageTriggers(worldId);
		if (!world.imagePresetId) { if (manual) throw new Error('이미지 프리셋을 먼저 적용해 주세요.'); return null; }
		if (!manual && (!settings.config.enabled || !settings.config.rules.some((rule) => rule.enabled) || getImageCursor(worldId).revision >= world.revision)) return null;
		// Finish a coherent scene before evaluating automatic illustration conditions.
		if (!manual && store().prepare("SELECT id FROM theater_jobs WHERE world_id = ? AND status IN ('pending', 'running')").get(worldId)) return null;
		const sourceKey = manual ? `manual:${randomUUID()}` : `revision:${world.revision}:settings:${settings.revision}`;
		if (!manual && store().prepare('SELECT id FROM theater_illustrations WHERE world_id = ? AND source_key = ?').get(worldId, sourceKey)) return null;
		const count = Number((store().prepare("SELECT COUNT(*) AS count FROM theater_illustrations WHERE world_id = ? AND status != 'skipped'").get(worldId) as Row).count);
		if (count >= maxIllustrations) { if (manual) throw new Error('삽화 기록이 100개입니다. 이미지 설정에서 기록을 비워 주세요.'); return null; }
		const preset = getImagePreset(world.imagePresetId);
		let models = world.models ?? null;
		let admissionError: string | undefined;
		if (!manual && !models && settings.config.rules.some((rule) => rule.enabled && rule.naturalLanguage.trim())) {
			try {
				const defaults = modelSettings();
				models = { decisionModel: defaults.decisionModel, textModel: defaults.textModel };
			} catch { admissionError = '자연어 조건의 기본 생성 모델 설정을 읽지 못했습니다. 모델 설정을 확인해 주세요.'; }
		}
		const input: ImageCheckInput = { scene: imageSceneSnapshot(world, settings.config.rules), rules: settings.config.rules, manual, presetId: preset.id, presetRevision: preset.revision, config: preset.config, models };
		const id = randomUUID();
		store().prepare("INSERT INTO theater_illustrations (id, world_id, source_key, settings_revision, input_json, status, reason, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
			.run(id, worldId, sourceKey, settings.revision, JSON.stringify(input), manual ? '현재 장면 요청' : '자동 생성 조건 확인', new Date().toISOString());
		if (admissionError) setImageCheckStatus(id, 'failed', undefined, admissionError);
		return id;
	});
}
export function queueAutomaticImageChecks(): void {
	for (const row of store().prepare("SELECT s.world_id FROM theater_image_settings s JOIN theater_worlds w ON w.id = s.world_id WHERE json_extract(s.config_json, '$.enabled') = 1 AND w.image_preset_id IS NOT NULL").all() as Row[]) queueImageCheck(String(row.world_id));
}
export function pendingImageCheck(): ImageCheckJob | null {
	const row = store().prepare("SELECT * FROM theater_illustrations WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 1").get() as Row | undefined;
	return row ? { id: String(row.id), worldId: String(row.world_id), settingsRevision: Number(row.settings_revision), input: JSON.parse(String(row.input_json)) } : null;
}
export function imageCheckValid(job: ImageCheckJob): boolean {
	const row = store().prepare('SELECT status FROM theater_illustrations WHERE id = ?').get(job.id) as Row | undefined;
	if (!row || !['pending', 'checking', 'generating'].includes(String(row.status))) return false;
	if (job.input.manual) return true;
	const current = getImageTriggers(job.worldId);
	return current.config.enabled && current.revision === job.settingsRevision && getWorld(job.worldId).imagePresetId === job.input.presetId;
}
export function setImageCheckStatus(id: string, status: Illustration['status'], reason?: string, error?: string): void {
	store().prepare('UPDATE theater_illustrations SET status = ?, reason = COALESCE(?, reason), error = ? WHERE id = ?').run(status, reason ?? null, error?.slice(0, 500) ?? null, id);
}
export function acceptImageCheck(job: ImageCheckJob, cursor: ImageTriggerCursor, reason: string): boolean {
	return transaction(() => {
		if (!imageCheckValid(job)) { setImageCheckStatus(job.id, 'skipped'); return false; }
		if (!job.input.manual) store().prepare('UPDATE theater_image_settings SET cursor_json = ? WHERE world_id = ? AND revision = ?').run(JSON.stringify(cursor), job.worldId, job.settingsRevision);
		setImageCheckStatus(job.id, reason ? 'generating' : 'skipped', reason);
		// Skipped checks are not image history; the durable cursor prevents them from being queued again.
		store().prepare("DELETE FROM theater_illustrations WHERE world_id = ? AND status = 'skipped' AND id != ?").run(job.worldId, job.id);
		return !!reason;
	});
}
export function completeImageCheck(id: string, bytes: Uint8Array, mediaType: string): void {
	store().prepare("UPDATE theater_illustrations SET status = 'completed', bytes = ?, media_type = ? WHERE id = ? AND status = 'generating'").run(bytes, mediaType, id);
}
export function listIllustrations(worldId: string): Illustration[] {
	getWorld(worldId);
	return (store().prepare("SELECT id, world_id, input_json, status, reason, error, created_at FROM theater_illustrations WHERE world_id = ? AND status != 'skipped' ORDER BY created_at, rowid").all(worldId) as Row[]).map((row) => {
		const { scene } = JSON.parse(String(row.input_json)) as ImageCheckInput;
		return { id: String(row.id), worldId, eventId: scene.eventId, tick: scene.tick, sceneId: scene.sceneId, status: row.status as Illustration['status'], reason: String(row.reason), error: row.error ? String(row.error) : null, createdAt: String(row.created_at) };
	});
}
export function clearIllustrations(worldId: string): void {
	transaction(() => {
		const world = getWorld(worldId);
		store().prepare('DELETE FROM theater_illustrations WHERE world_id = ?').run(worldId);
		store().prepare('UPDATE theater_image_settings SET cursor_json = ? WHERE world_id = ?').run(JSON.stringify(imageTriggerCursor(world)), worldId);
	});
}
export function recoverImageChecks(): void {
	// The provider may already have charged a running request. Never replay it after a restart.
	store().prepare("UPDATE theater_illustrations SET status = 'failed', error = '서버가 재시작되어 완료 여부를 확인할 수 없습니다. 자동 재시도하지 않습니다.' WHERE status IN ('checking', 'generating')").run();
}
