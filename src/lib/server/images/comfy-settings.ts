import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComfySettings } from '$lib/images/comfyui';
import { checkedComfyProfile, checkedComfyUrl, comfyError, comfyPreset, defaultComfyProfile } from './comfy-workflows';

const configPath = () => resolve(process.env.NEWERA_COMFYUI_CONFIG || resolve(process.env.NEWERA_DATA_DIR || 'data', 'comfyui.json'));
export function defaultComfySettings(baseUrl = process.env.NEWERA_COMFYUI_BASE_URL || 'http://localhost:22222'): ComfySettings {
	return { version: 1, revision: 0, baseUrl: checkedComfyUrl(baseUrl), presetId: 'zit-moody', profiles: { 'zit-moody': defaultComfyProfile('zit-moody'), 'sdxl-simple': defaultComfyProfile('sdxl-simple'), 'anima-preview': defaultComfyProfile('anima-preview') } };
}
export function checkedComfySettings(input: unknown): ComfySettings {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw comfyError('configuration', 'ComfyUI 설정이 올바르지 않습니다.');
	const row = input as Record<string, unknown>;
	if (row.version !== 1 || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0 || !row.profiles || typeof row.profiles !== 'object') throw comfyError('configuration', 'ComfyUI 설정 형식이 올바르지 않습니다.');
	const profiles = row.profiles as Record<string, unknown>;
	return { version: 1, revision: row.revision, baseUrl: checkedComfyUrl(row.baseUrl), presetId: comfyPreset(row.presetId).id,
		profiles: {
			'zit-moody': checkedComfyProfile('zit-moody', profiles['zit-moody']),
			'sdxl-simple': checkedComfyProfile('sdxl-simple', profiles['sdxl-simple']),
			// Version 1 files saved before Anima keep their existing settings and gain an empty profile.
			'anima-preview': profiles['anima-preview'] === undefined ? defaultComfyProfile('anima-preview') : checkedComfyProfile('anima-preview', profiles['anima-preview'])
		} };
}
export function getComfySettings(): ComfySettings {
	if (!existsSync(configPath())) return defaultComfySettings();
	try { return checkedComfySettings(JSON.parse(readFileSync(configPath(), 'utf8'))); }
	catch { throw comfyError('configuration', 'ComfyUI 설정 파일을 읽을 수 없습니다. 주소와 설정 형식을 확인해 주세요.'); }
}
export function saveComfySettings(input: unknown): ComfySettings {
	const settings = checkedComfySettings(input);
	if (settings.revision !== getComfySettings().revision) throw comfyError('configuration', '다른 화면에서 ComfyUI 설정을 변경했습니다. 새로고침해 주세요.');
	settings.revision++;
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
	return settings;
}
