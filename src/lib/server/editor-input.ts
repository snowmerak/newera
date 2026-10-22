import { properties, record } from '$lib/theater/validation';
import { relationshipMetrics } from '$lib/theater/types';
import type { RelationshipScores } from '$lib/theater/types';

export function jsonField(body: FormData, name: string, fallback: unknown = {}): unknown {
	const value = String(body.get(name) || '');
	return value ? JSON.parse(value) : fallback;
}

/** Preserve types and duplicate-key validation when ordinary controls replace JSON textareas. */
export function propertyFields(body: FormData, name: string) {
	if (!body.has(`${name}Rows`)) return jsonField(body, name);
	const rows = jsonField(body, `${name}Rows`, []);
	if (!Array.isArray(rows) || rows.length > 100) throw new Error('상태는 최대 100개까지 추가할 수 있습니다.');
	const entries: [string, string | number | boolean | null][] = [];
	const keys = new Set<string>();
	for (const value of rows) {
		const row = record(value, '상태 항목');
		const key = String(row.key ?? '').trim();
		if (!key || keys.has(key)) throw new Error('상태 이름이 비어 있거나 중복되었습니다.');
		keys.add(key);
		let parsed: string | number | boolean | null;
		if (row.type === 'text') parsed = String(row.value ?? '');
		else if (row.type === 'number' && String(row.value ?? '').trim() && Number.isFinite(Number(row.value))) parsed = Number(row.value);
		else if (row.type === 'boolean' && ['true', 'false'].includes(String(row.value))) parsed = String(row.value) === 'true';
		else if (row.type === 'null') parsed = null;
		else throw new Error(`${key}: 값의 종류와 내용을 확인해 주세요.`);
		entries.push([key, parsed]);
	}
	return properties(Object.fromEntries(entries), '상태');
}

export function relationshipFields(body: FormData): RelationshipScores {
	return Object.fromEntries(relationshipMetrics.map((metric) => {
		if (body.get(`${metric}Known`) !== 'on') return [metric, null];
		const raw = body.get(metric);
		const value = Number(raw);
		if (raw === null || !String(raw).trim() || !Number.isInteger(value) || value < 0 || value > 100) throw new Error('관계 수치는 0~100 사이의 정수로 입력해 주세요.');
		return [metric, value];
	})) as RelationshipScores;
}
