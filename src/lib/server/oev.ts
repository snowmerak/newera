import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActorDecision, Director } from '$lib/theater/ensemble';
import { checkedExpression, performanceSchema } from '$lib/theater/performance';
import { record, text } from '$lib/theater/validation';

interface Settings {
	baseUrl: string;
	decisionModel: string;
	textModel: string;
	timeoutMs: number;
	decisionTimeoutMs: number;
	maxOutputTokens: number;
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
		const decisionModel = text(file.decisionModel ?? process.env.NEWERA_DECISION_MODEL ?? '', '판단 모델', 200, true) || 'gemma4-26b';
		const candidate: Settings = {
			baseUrl, decisionModel,
			textModel: text(file.textModel ?? process.env.NEWERA_TEXT_MODEL ?? '', '대사 모델', 200, true) || decisionModel,
			timeoutMs: positive(file.timeoutMs ?? process.env.NEWERA_LLM_TIMEOUT_MS, 120000, '대사 대기 시간', 600000),
			decisionTimeoutMs: positive(file.decisionTimeoutMs ?? process.env.NEWERA_DECISION_TIMEOUT_MS, 30000, '판단 대기 시간', 600000),
			maxOutputTokens: positive(file.maxOutputTokens ?? process.env.NEWERA_MAX_OUTPUT_TOKENS, 512, '행동 생성 토큰 한도', 32768)
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

export async function createDirector(signal: AbortSignal): Promise<Director> {
	const settings = modelSettings();
	const catalog = await request(settings, '/models', signal);
	if (!Array.isArray(catalog.data)) throw new Error('OEV 모델 목록이 올바르지 않습니다.');
	const generation = catalog.data.map((entry) => record(entry, '모델')).filter((entry) => entry.task === 'generation');
	const decisionModel = settings.decisionModel;
	const textModel = settings.textModel;
	if (!generation.some((entry) => entry.id === decisionModel) || !generation.some((entry) => entry.id === textModel)) throw new Error('설정한 판단·대사 모델이 OEV generation 모델 목록에 없습니다.');

	return {
		async decide(state): Promise<ActorDecision> {
			const response = await request(settings, '/systemone', signal, {
				model: decisionModel, state, questions: {
					participation: { type: 'choice', instructions: 'self 인물이 지금 관찰한 사건과 자신의 목표에 따라 말하거나 행동할지, 아무 행동 없이 지켜볼지만 판단한다. 구체적인 행동이나 대사는 정하지 않는다.', criteria: { act: '지금 말하거나 행동한다.', wait: '아무 행동 없이 지켜본다.' } }
				}
			});
			const choice = answer(response, 'participation', 'choice').choice;
			if (choice !== 'act' && choice !== 'wait') throw new Error('OEV 행동 여부는 act 또는 wait여야 합니다.');
			return { act: choice === 'act', model: decisionModel };
		},
		async perform(state, actions) {
			const response = await request(settings, '/chat/completions', signal, {
				model: textModel, temperature: 0.8, stream: false, reasoning_effort: 'none', max_completion_tokens: settings.maxOutputTokens,
				response_format: { type: 'json_schema', json_schema: { name: 'actor_performance', strict: true, schema: performanceSchema(actions) } },
				messages: [
					{ role: 'system', content: '당신은 장면 안의 self 인물 한 명이다. 관찰·성격·목표·개인 메모에 따라 availableActions에서 구체적인 행동 하나를 추론하고 JSON으로만 출력한다. actionId는 실행할 후보 ID다. narrative는 자신이 하는 행동의 짧은 한국어 묘사이며 이동·상호작용에는 필수다. utterance는 speak 행동에서만 필수이며 다른 행동에서는 null이다. 대사는 한국어 1~3문장으로 쓴다. 다른 인물이나 플레이어의 말·선택·반응·행동 결과를 대신 확정하지 않는다. 숨겨진 정보나 관찰하지 않은 사건을 알지 못한다. 상태 효과는 실행기가 처리한다. memoUpdate는 자신의 짧은 비공개 메모 전체(summary, currentIntention, feelings, openThreads) 또는 변경하지 않을 때 null이다. 메모에는 관찰과 자신의 해석을 구분하고 타인의 속마음을 사실로 쓰지 않는다. 네 필드 외에는 출력하지 않는다.' },
					{ role: 'user', content: JSON.stringify({ ...state, availableActions: actions }) }
				]
			});
			if (!Array.isArray(response.choices) || !response.choices.length) throw new Error('OEV 행동 생성 응답이 비어 있습니다.');
			const choice = record(response.choices[0], '행동 생성 응답');
			if (choice.finish_reason !== 'stop') throw new Error('OEV 행동 생성이 정상적으로 완료되지 않았습니다.');
			const content = text(record(choice.message, '행동 메시지').content, '구조화된 출력', 20000);
			let output: unknown;
			try { output = JSON.parse(content); } catch { throw new Error('OEV 행동 생성 결과가 올바른 JSON이 아닙니다.'); }
			return { ...checkedExpression(output, actions), model: textModel };
		}
	};
}
