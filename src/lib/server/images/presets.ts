import { randomUUID } from 'node:crypto';
import type { ImagePreset, ImagePresetConfig } from '$lib/images/presets';
import { store, transaction } from '$lib/server/stage-store';
import { record, text } from '$lib/theater/validation';
import { validateHostedImageRequest } from './client';
import { checkedComfyProfile, comfyPreset } from './comfy-workflows';

export function checkedImagePresetConfig(input: unknown): ImagePresetConfig {
	const row = record(input, '이미지 프리셋 설정');
	const provider = row.provider;
	if (!['openai', 'xai', 'openrouter', 'comfyui'].includes(String(provider))) throw new Error('이미지 Provider가 올바르지 않습니다.');
	const allowed = provider === 'comfyui' ? ['provider', 'baseUrl', 'stylePrompt', 'workflowId', 'profile'] : ['provider', 'baseUrl', 'stylePrompt', 'apiKeyEnv', 'model', 'options'];
	if (Object.keys(row).some((key) => !allowed.includes(key))) throw new Error('이미지 프리셋에는 지원하는 설정만 저장할 수 있습니다. API 키는 환경 변수로 지정해 주세요.');
	let address: URL;
	try { address = new URL(text(row.baseUrl, '이미지 API 주소', 2000)); } catch { throw new Error('이미지 API 주소가 올바르지 않습니다.'); }
	if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('이미지 API 주소에는 HTTP(S) 주소를 쓰고 인증 정보·쿼리·해시는 제외해 주세요.');
	const baseUrl = address.toString().replace(/\/+$/, '');
	const stylePrompt = text(row.stylePrompt ?? '', '화풍 지침', 4000, true);
	if (provider === 'comfyui') {
		const workflowId = comfyPreset(row.workflowId).id;
		const profile = checkedComfyProfile(workflowId, row.profile);
		for (const model of comfyPreset(workflowId).models) if (model.required && !profile.models[model.field]) throw new Error(`${model.label}을 선택해 주세요.`);
		return { provider, baseUrl, stylePrompt, workflowId, profile };
	}
	const apiKeyEnv = text(row.apiKeyEnv, 'API 키 환경 변수', 200);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error('API 키 환경 변수 이름이 올바르지 않습니다.');
	const model = text(row.model, '이미지 모델 ID', 200);
	const options = structuredClone(record(row.options ?? {}, '이미지 옵션'));
	validateHostedImageRequest(provider as 'openai' | 'xai' | 'openrouter', { model, prompt: 'validate preset', options });
	return { provider, baseUrl, stylePrompt, apiKeyEnv, model, options } as ImagePresetConfig;
}

type Row = Record<string, unknown>;
function fromRow(row: Row): ImagePreset {
	const config = checkedImagePresetConfig(JSON.parse(String(row.config_json)));
	return { id: String(row.id), name: String(row.name), revision: Number(row.revision), provider: config.provider, config, usedBy: Number(row.used_by ?? 0) };
}
export function listImagePresets(): ImagePreset[] {
	return (store().prepare('SELECT p.*, (SELECT COUNT(*) FROM theater_worlds w WHERE w.image_preset_id = p.id) AS used_by FROM theater_image_presets p ORDER BY p.created_at, p.rowid').all() as Row[]).map(fromRow);
}
export function getImagePreset(id: string): ImagePreset {
	const row = store().prepare('SELECT p.*, (SELECT COUNT(*) FROM theater_worlds w WHERE w.image_preset_id = p.id) AS used_by FROM theater_image_presets p WHERE p.id = ?').get(id) as Row | undefined;
	if (!row) throw new Error('이미지 프리셋을 찾을 수 없습니다.');
	return fromRow(row);
}
export function saveImagePreset(input: unknown): ImagePreset {
	const row = record(input, '이미지 프리셋');
	const id = row.id === undefined || row.id === '' ? null : text(row.id, '프리셋 ID', 100);
	const name = text(row.name, '프리셋 이름', 100);
	const config = checkedImagePresetConfig(row.config);
	const revision = row.revision;
	if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('프리셋 리비전이 올바르지 않습니다.');
	return transaction(() => {
		const duplicate = store().prepare('SELECT id FROM theater_image_presets WHERE name = ? COLLATE NOCASE').get(name) as Row | undefined;
		if (duplicate && duplicate.id !== id) throw new Error('같은 이름의 이미지 프리셋이 있습니다. 다른 이름을 사용해 주세요.');
		const now = new Date().toISOString();
		if (id) {
			if (getImagePreset(id).revision !== revision) throw new Error('이미지 프리셋이 변경되었습니다. 목록을 새로 불러와 주세요.');
			store().prepare('UPDATE theater_image_presets SET name = ?, config_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(name, JSON.stringify(config), now, id);
			return getImagePreset(id);
		}
		if (revision !== 0) throw new Error('새 프리셋의 리비전은 0이어야 합니다.');
		if (Number((store().prepare('SELECT COUNT(*) AS count FROM theater_image_presets').get() as Row).count) >= 100) throw new Error('이미지 프리셋은 최대 100개까지 저장할 수 있습니다.');
		const created = randomUUID();
		store().prepare('INSERT INTO theater_image_presets VALUES (?, ?, 1, ?, ?, ?)').run(created, name, JSON.stringify(config), now, now);
		return getImagePreset(created);
	});
}
export function deleteImagePreset(id: string, revision: number): void {
	transaction(() => {
		const preset = getImagePreset(id);
		if (preset.revision !== revision) throw new Error('이미지 프리셋이 변경되었습니다. 목록을 새로 불러와 주세요.');
		if (preset.usedBy) throw new Error('세션에서 사용하는 프리셋입니다. 해당 세션의 선택을 먼저 변경해 주세요.');
		store().prepare('DELETE FROM theater_image_presets WHERE id = ?').run(id);
	});
}
