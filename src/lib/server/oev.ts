import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActorDecision, Director } from '$lib/theater/ensemble';
import type { ModelSelection } from '$lib/theater/types';
import { checkedExpression, performanceSchema } from '$lib/theater/performance';
import { reflectionSchema } from '$lib/theater/reflection';
import { checkedModelSelection, checkedReflection, record, text } from '$lib/theater/validation';
import { RetryableError, withRetries, type RetryPolicy } from './retry';

interface Settings extends RetryPolicy {
	baseUrl: string;
	decisionModel: string;
	textModel: string;
	timeoutMs: number;
	decisionTimeoutMs: number;
	maxOutputTokens: number;
	reflectionMaxOutputTokens: number;
}
let acceptedSettings: Settings | undefined;
const observationInstructions = 'self.id가 당신의 고정 ID다. 기억과 recentEvents의 actorId는 실행기가 기록한 실제 행동·발언 주체이며 targetId는 대상, body.narrative는 행동 묘사, body.utterance는 그 주체의 발언 원문이다. actorId가 player이면 플레이어의 행동이며 당신이 한 일이 아니다. 타인의 발언 내용은 그 사람의 주장이지 실제로 일어난 행동을 증명하지 않는다. 개인 메모는 주관적인 해석이며 사건의 주체와 충돌하면 사건 기록을 우선한다. 관찰되지 않은 실수·의도·감정·반응을 사실로 만들어내지 않는다.';

function integerSetting(value: unknown, fallback: number, name: string, maximum: number, minimum = 1): number {
	const parsed = value === undefined || value === '' ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} 설정 범위가 올바르지 않습니다.`);
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
			textModel: text(file.textModel ?? process.env.NEWERA_TEXT_MODEL ?? '', '생성 모델', 200, true) || decisionModel,
			timeoutMs: integerSetting(file.timeoutMs ?? process.env.NEWERA_LLM_TIMEOUT_MS, 120000, '생성 대기 시간', 600000),
			decisionTimeoutMs: integerSetting(file.decisionTimeoutMs ?? process.env.NEWERA_DECISION_TIMEOUT_MS, 30000, '판단 대기 시간', 600000),
			maxOutputTokens: integerSetting(file.maxOutputTokens ?? process.env.NEWERA_MAX_OUTPUT_TOKENS, 512, '행동 생성 토큰 한도', 32768),
			reflectionMaxOutputTokens: integerSetting(file.reflectionMaxOutputTokens ?? process.env.NEWERA_REFLECTION_MAX_OUTPUT_TOKENS, 1024, '관찰 해석 토큰 한도', 32768),
			maxRetries: integerSetting(file.maxRetries ?? process.env.NEWERA_MAX_RETRIES, 2, '최대 재시도 횟수', 5, 0),
			retryBaseMs: integerSetting(file.retryBaseMs ?? process.env.NEWERA_RETRY_BASE_MS, 1000, '재시도 기본 간격', 60000),
			retryMaxMs: integerSetting(file.retryMaxMs ?? process.env.NEWERA_RETRY_MAX_MS, 8000, '재시도 최대 간격', 60000)
		};
		if (candidate.retryMaxMs < candidate.retryBaseMs) throw new Error('재시도 최대 간격은 기본 간격 이상이어야 합니다.');
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
	const payload = body === undefined ? undefined : JSON.stringify(body);
	try {
		const response = await fetch(`${settings.baseUrl}${path}`, {
			method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: timed
		});
		if (!response.ok) {
			const message = `OEV ${path} 오류 ${response.status}: ${(await response.text()).slice(0, 300)}`;
			if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw new RetryableError(message);
			throw new Error(message);
		}
		return record(await response.json(), `OEV ${path} 응답`);
	} catch (error) {
		signal.throwIfAborted();
		if (timed.aborted) throw new RetryableError(`OEV ${path} 응답 대기 시간이 초과되었습니다.`);
		if (error instanceof TypeError) throw new RetryableError(`OEV ${path} 연결에 실패했습니다.`);
		if (error instanceof SyntaxError) throw new RetryableError(`OEV ${path} 응답이 올바른 JSON이 아닙니다.`);
		throw error;
	}
}

function generatedOutput<T>(parse: () => T): T {
	try { return parse(); }
	catch (error) { throw new RetryableError(error instanceof Error ? error.message : '모델 출력 형식이 올바르지 않습니다.'); }
}

function structuredResponse(response: Record<string, unknown>): unknown {
	if (!Array.isArray(response.choices) || !response.choices.length) throw new Error('OEV 구조화된 생성 응답이 비어 있습니다.');
	const choice = record(response.choices[0], '구조화된 생성 응답');
	if (choice.finish_reason !== 'stop') throw new Error('OEV 구조화된 생성이 정상적으로 완료되지 않았습니다.');
	const content = text(record(choice.message, '생성 메시지').content, '구조화된 출력', 20000);
	let output: unknown;
	try { output = JSON.parse(content); } catch { throw new Error('OEV 생성 결과가 올바른 JSON이 아닙니다.'); }
	return output;
}

function answer(response: Record<string, unknown>, key: string, type: string): Record<string, unknown> {
	const entry = record(record(response.answers, 'answers')[key], `answers.${key}`);
	if (entry.type !== type) throw new Error(`OEV ${key} 응답의 타입이 올바르지 않습니다.`);
	return entry;
}

async function generationModels(settings: Settings, signal: AbortSignal, checkpoint: () => void = () => {}): Promise<string[]> {
	const catalog = await withRetries('모델 목록 조회', settings, signal, () => { checkpoint(); return request(settings, '/models', signal); });
	if (!Array.isArray(catalog.data)) throw new Error('OEV 모델 목록이 올바르지 않습니다.');
	return [...new Set(catalog.data.map((entry) => record(entry, '모델')).filter((entry) => entry.task === 'generation').map((entry) => text(entry.id, '모델 ID', 200)))].sort();
}

export async function getModelCatalog(signal: AbortSignal): Promise<{ models: string[]; defaults: ModelSelection }> {
	const settings = modelSettings();
	return { models: await generationModels(settings, signal), defaults: { decisionModel: settings.decisionModel, textModel: settings.textModel } };
}

export async function createDirector(signal: AbortSignal, models?: ModelSelection | null, checkpoint: () => void = () => {}): Promise<Director> {
	const settings = modelSettings();
	const { decisionModel, textModel } = checkedModelSelection(models ?? settings);
	const generation = await generationModels(settings, signal, checkpoint);
	if (!generation.includes(decisionModel) || !generation.includes(textModel)) throw new Error('설정한 판단·생성 모델이 OEV generation 모델 목록에 없습니다.');

	return {
		async reflect(state, context) {
			return withRetries('관찰·관계 해석', settings, signal, async () => {
				checkpoint();
				const response = await request(settings, '/chat/completions', signal, {
					model: textModel, temperature: 0.3, stream: false, reasoning_effort: 'none', max_completion_tokens: settings.reflectionMaxOutputTokens,
					response_format: { type: 'json_schema', json_schema: { name: 'character_reflection', strict: true, schema: reflectionSchema(context) } },
					messages: [
						{ role: 'system', content: `당신은 장면 안의 self 인물이다. 새로 목격한 newEvents 묶음을 해석해 자신의 비공개 관계와 개인 메모 변경만 JSON으로 제안한다. 행동·대사·외부 사건을 생성하지 않는다. self.relationships는 당신이 상대를 어떻게 보는지이며 상대의 속마음이 아니다. trust는 말·약속에 대한 신뢰, affinity는 호감, closeness는 가까움·편안함, respect는 능력·판단·가치에 대한 존중, wariness는 위협을 느끼거나 조심하는 정도다. 각 항목은 독립적인 0~100 정수이며 null은 아직 판단하지 못함이다. 모르는 상대를 자동으로 50점이나 극단값으로 정하지 않는다. 숫자는 성격·목표와 함께 판단할 자료이며 복종·동행·동의를 강제하지 않는다. 단순 인사나 같은 이야기의 반복만으로 관계를 계속 높이지 말고 의미 있는 근거가 있을 때만 변경한다. relationshipUpdates에는 변경할 상대만 넣고 없으면 빈 배열이다. targetId는 targets에서 고르며 changes는 변경할 field와 변경 후 절대값 value만 담는다. impression은 상대에 대한 짧은 주관적 인식이며 변경하지 않으면 null이다. evidenceEventIds는 evidenceEvents에서 실제 목격한 ID만 사용하며 변경마다 newEvents의 사건을 하나 이상 포함한다. actorId나 자신 이외 주체의 관계는 출력하지 않는다. memoUpdate는 summary/currentIntention/feelings/openThreads 전체 또는 유지할 때 null이다. 화남·질투·서운함·고마움 같은 현재 감정은 메모에 상대와 원인을 적고 장기 관계와 구분한다. 다른 인물의 숨은 의도·지식·감정을 사실로 확정하지 않는다. 관계 초기 설정과 과거 사건을 새 사실처럼 중복 평가하지 않는다. ${observationInstructions}` },
						{ role: 'user', content: JSON.stringify({ ...state, ...context }) }
					]
				});
				return generatedOutput(() => checkedReflection(structuredResponse(response), context));
			});
		},
		async decide(state): Promise<ActorDecision> {
			return withRetries('행동 여부 판단', settings, signal, async () => {
				checkpoint();
				const response = await request(settings, '/systemone', signal, {
					model: decisionModel, state, questions: {
						participation: { type: 'choice', instructions: `self 인물이 지금 관찰한 사건과 자신의 목표·상대별 관계·개인 메모에 따라 말하거나 행동할지, 아무 행동 없이 지켜볼지만 판단한다. 구체적인 행동이나 대사는 정하지 않는다. 다른 인물이 새로 말하거나 행동하면 이미 한 번 반응했어도 다시 답하거나 행동할 수 있다. 자신의 최근 발언을 반복하거나 새 의도 없이 끼어들 필요는 없으며, 플레이어의 답이나 새로운 사건을 기다리는 편이 자연스러우면 wait를 선택한다. 플레이어의 중단 요청도 성격·감정·현재 의도에 따라 수용하거나 계속할 수 있다. ${observationInstructions}`, criteria: { act: '지금 말하거나 행동한다.', wait: '아무 행동 없이 지켜본다.' } }
					}
				});
				return generatedOutput(() => {
					const choice = answer(response, 'participation', 'choice').choice;
					if (choice !== 'act' && choice !== 'wait') throw new Error('OEV 행동 여부는 act 또는 wait여야 합니다.');
					return { act: choice === 'act', model: decisionModel };
				});
			});
		},
		async perform(state, actions) {
			const schema = performanceSchema(actions);
			return withRetries('행동·대사 생성', settings, signal, async () => {
				checkpoint();
				const response = await request(settings, '/chat/completions', signal, {
					model: textModel, temperature: 0.8, stream: false, reasoning_effort: 'none', max_completion_tokens: settings.maxOutputTokens,
					response_format: { type: 'json_schema', json_schema: { name: 'actor_performance', strict: true, schema } },
					messages: [
						{ role: 'system', content: `당신은 장면 안의 self 인물 한 명이다. 관찰·성격·목표·자신의 상대별 관계·개인 메모에 따라 availableActions에서 구체적인 행동 하나를 추론하고 JSON으로만 출력한다. actionId와 targetId는 실행할 후보의 ID와 대상 ID를 그대로 쓴다. 행동 주체는 실행기가 self.id로 붙이므로 출력하지 않는다. narrative는 자신이 하는 몸짓·행동만 주어를 생략한 짧은 한국어 동사구로 쓰며 이동·상호작용에는 필수다. utterance는 speak 행동에서만 필수이며 다른 행동에서는 null이다. 대사는 한국어 1~3문장의 실제 발언만 쓰고 내레이션·화자 이름·몸짓을 섞지 않는다. 다른 인물이나 플레이어의 말·선택·반응·행동 결과를 대신 확정하지 않는다. 숨겨진 정보나 관찰하지 않은 사건을 알지 못한다. 상태 효과는 실행기가 처리한다. memoUpdate는 자신의 짧은 비공개 메모 전체(summary, currentIntention, feelings, openThreads) 또는 변경하지 않을 때 null이다. 메모에는 관찰과 자신의 해석을 구분하고 타인의 속마음을 사실로 쓰지 않는다. actionId, targetId, narrative, utterance, memoUpdate 외에는 출력하지 않는다. ${observationInstructions}` },
						{ role: 'user', content: JSON.stringify({ ...state, availableActions: actions }) }
					]
				});
				return generatedOutput(() => {
					return { ...checkedExpression(structuredResponse(response), actions), model: textModel };
				});
			});
		}
	};
}
