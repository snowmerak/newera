import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActorDecision, Director } from '$lib/theater/ensemble';
import type { StageAction } from '$lib/theater/types';
import { record, text } from '$lib/theater/validation';

interface Settings {
	baseUrl: string;
	decisionModel: string;
	textModel: string;
	timeoutMs: number;
	decisionTimeoutMs: number;
	maxOutputTokens: number;
	reactionThreshold: number;
}
let acceptedSettings: Settings | undefined;

function positive(value: unknown, fallback: number, name: string, maximum: number): number {
	const parsed = value === undefined || value === '' ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} 설정 범위가 올바르지 않습니다.`);
	return parsed;
}

/** Reread the optional settings file at each turn; an accepted job retains one immutable snapshot. */
export function modelSettings(): Settings {
	const configPath = process.env.NEWERA_MODEL_CONFIG || resolve(process.env.NEWERA_DATA_DIR || 'data', 'models.json');
	try {
		const file = existsSync(configPath) ? record(JSON.parse(readFileSync(configPath, 'utf8')), '모델 설정') : {};
		const baseUrl = text(file.baseUrl ?? process.env.NEWERA_OEV_BASE_URL ?? 'http://macstudio:12821/v1', 'OEV 주소', 2000).replace(/\/+$/, '');
		const url = new URL(baseUrl);
		if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OEV 주소에는 http 또는 https가 필요합니다.');
		const threshold = Number(file.reactionThreshold ?? process.env.NEWERA_REACTION_THRESHOLD ?? 0.5);
		if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('반응 기준은 0~1 사이여야 합니다.');
		const decisionModel = text(file.decisionModel ?? process.env.NEWERA_DECISION_MODEL ?? '', '판단 모델', 200, true) || 'gemma4-26b';
		const candidate: Settings = {
			baseUrl, decisionModel,
			textModel: text(file.textModel ?? process.env.NEWERA_TEXT_MODEL ?? '', '대사 모델', 200, true) || decisionModel,
			timeoutMs: positive(file.timeoutMs ?? process.env.NEWERA_LLM_TIMEOUT_MS, 120000, '대사 대기 시간', 600000),
			decisionTimeoutMs: positive(file.decisionTimeoutMs ?? process.env.NEWERA_DECISION_TIMEOUT_MS, 30000, '판단 대기 시간', 600000),
			maxOutputTokens: positive(file.maxOutputTokens ?? process.env.NEWERA_MAX_OUTPUT_TOKENS, 512, '대사 토큰 한도', 32768), reactionThreshold: threshold
		};
		acceptedSettings = candidate;
		return { ...candidate };
	} catch (error) {
		if (!acceptedSettings) throw error;
		console.warn('모델 설정을 적용하지 못했습니다. 마지막 유효 설정을 유지합니다:', error instanceof Error ? error.message : '설정 오류');
		return { ...acceptedSettings };
	}
}

async function request(settings: Settings, path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
	const timed = AbortSignal.any([signal, AbortSignal.timeout(path === '/chat/completions' ? settings.timeoutMs : settings.decisionTimeoutMs)]);
	const response = await fetch(`${settings.baseUrl}${path}`, {
		method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body), signal: timed
	});
	if (!response.ok) throw new Error(`OEV ${path} 오류 ${response.status}: ${(await response.text()).slice(0, 300)}`);
	return record(await response.json(), `OEV ${path} 응답`);
}

function answer(response: Record<string, unknown>, key: string, type: string): Record<string, unknown> {
	const entry = record(record(response.answers, 'answers')[key], `answers.${key}`);
	if (entry.type !== type) throw new Error(`OEV ${key} 응답의 타입이 올바르지 않습니다.`);
	return entry;
}
function bounded(value: unknown, maximum: number, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`OEV ${label} 응답 범위가 올바르지 않습니다.`);
	return value;
}

export async function createDirector(signal: AbortSignal): Promise<Director> {
	const settings = modelSettings();
	const catalog = await request(settings, '/models', signal);
	if (!Array.isArray(catalog.data)) throw new Error('OEV 모델 목록이 올바르지 않습니다.');
	const generation = catalog.data.map((entry) => record(entry, '모델')).filter((entry) => entry.task === 'generation');
	const decisionModel = settings.decisionModel;
	const textModel = settings.textModel;
	if (!generation.some((entry) => entry.id === decisionModel) || !generation.some((entry) => entry.id === textModel)) throw new Error('설정한 판단·대사 모델이 OEV generation 모델 목록에 없습니다.');

	async function choose(state: Record<string, unknown>, candidates: StageAction[], includeSignals: boolean): Promise<{ action: StageAction; reaction: number; intensity: number }> {
		// Preserve all legal actions when the scene exceeds the endpoint's 36-choice limit.
		const width = Math.ceil(candidates.length / 36);
		const groups: StageAction[][] = [];
		for (let index = 0; index < candidates.length; index += width) groups.push(candidates.slice(index, index + width));
		const criteria = Object.fromEntries(groups.map((group, index) => [`option_${index}`, group.length === 1 ? group[0].label : group.map((entry) => entry.label)]));
		const questions: Record<string, unknown> = {
			action: { type: 'choice', instructions: '현재 인물이 자신의 목표와 관찰한 사건에 따라 다음으로 할 행동을 고른다. 타인의 선택을 대신 결정하지 않는다. 묶음이면 원하는 행동이 있는 묶음을 고른다.', criteria }
		};
		if (includeSignals) {
			questions.react = { type: 'noul', instructions: '이 인물이 지금 관찰한 사건이나 자기 목표에 따라 반응하거나 먼저 행동할 이유가 있는가?', criteria: { true: '지금 말하거나 상호작용하거나 이동할 구체적인 이유가 있다.', false: '새로 할 말이나 행동 없이 지켜보는 것이 자연스럽다.' } };
			questions.intensity = { type: 'score', instructions: '이 인물이 겉으로 드러내는 반응의 강도를 고른다.', criteria: ['절제된 반응', '분명한 반응', '강한 반응'] };
		}
		const response = await request(settings, '/systemone', signal, { model: decisionModel, state, questions });
		const selection = answer(response, 'action', 'choice').choice;
		if (typeof selection !== 'string' || !Object.hasOwn(criteria, selection)) throw new Error('OEV가 후보에 없는 행동을 선택했습니다.');
		const selected = groups[Number(selection.slice('option_'.length))];
		const reaction = includeSignals ? bounded(answer(response, 'react', 'noul').noul, 1, 'noul') : 1;
		const intensity = includeSignals ? bounded(answer(response, 'intensity', 'score').score, 2, 'score') : 1;
		if (reaction < settings.reactionThreshold) return { action: candidates.find((entry) => entry.kind === 'wait')!, reaction, intensity };
		const action = selected.length === 1 ? selected[0] : (await choose(state, selected, false)).action;
		return { action, reaction, intensity };
	}
	return {
		async decide(state, actions): Promise<ActorDecision> {
			if (!actions.length) throw new Error('선택할 행동이 없습니다.');
			const selected = await choose(state, actions, true);
			return { ...selected, model: decisionModel, choice: selected.action.id };
		},
		async speak(state, decision): Promise<string> {
			const response = await request(settings, '/chat/completions', signal, {
				model: textModel, temperature: 0.8, stream: false, reasoning_effort: 'none', max_completion_tokens: settings.maxOutputTokens,
				messages: [
					{ role: 'system', content: '당신은 장면 안의 self 인물 한 명이다. 주어진 관찰과 이미 선택된 행동에 따라 그 인물이 실제로 하는 한국어 대사만 1~3문장으로 쓴다. 다른 인물이나 플레이어의 말·행동·반응을 대신 쓰지 않는다. 숨겨진 정보나 현장에서 관찰하지 않은 사건을 알지 못한다. 내레이션·화자 이름·JSON·해설 없이 발화만 출력한다. intensity는 0~2의 연속적인 표현 강도다.' },
					{ role: 'user', content: JSON.stringify({ ...state, selectedAction: decision.action, intensity: decision.intensity }) }
				]
			});
			if (!Array.isArray(response.choices) || !response.choices.length) throw new Error('OEV 대사 응답이 비어 있습니다.');
			const choice = record(response.choices[0], '대사 응답');
			if (choice.finish_reason !== 'stop') throw new Error('OEV 대사가 정상적으로 완료되지 않았습니다.');
			return text(record(choice.message, '대사 메시지').content, '대사', 4000);
		}
	};
}
