import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ActorDecision, Director } from '$lib/theater/ensemble';
import type { InactivityMode, ModelSelection } from '$lib/theater/types';
import { identityReviewContext, inactivityContext, outfitContext, participationContext, performanceContext, performanceReviewContext, reflectionInput } from '$lib/theater/inference-context';
import { checkedExpression, performanceSchema } from '$lib/theater/performance';
import { reflectionSchema } from '$lib/theater/reflection';
import { checkedModelSelection, checkedReflection, record, text } from '$lib/theater/validation';
import { RetryableError, withRetries, type RetryPolicy } from './retry';
import { aliasReference, providerCatalogRoute, providerRegistry, resolveProviderModel, resolveProviderSnapshot, type ProviderRoute, type ProviderSnapshot } from './providers';
import type { ModelOption } from '$lib/providers/types';

export interface Settings extends RetryPolicy {
	baseUrl: string;
	decisionModel: string;
	textModel: string;
	timeoutMs: number;
	decisionTimeoutMs: number;
	maxOutputTokens: number;
	reflectionMaxOutputTokens: number;
	generationHistoryTokens: number;
	embeddingModel: string;
	embeddingDimensions: number;
	embeddingTimeoutMs: number;
	memoryEnabled: boolean;
	memoryTopK: number;
	memoryMaxBytes: number;
	memoryTokenizer: 'ngram' | 'lindera/ko-dic';
}
let acceptedSettings: Settings | undefined;
const observationInstructions = 'recalledEvents는 검색으로 회상한 과거 목격 기록이며 이번에 새로 발생한 사건이 아니다. 최근 사건과 현재 상태를 우선하고 과거 약속을 다시 실행된 사실로 해석하지 않는다. memorySearch가 bm25 또는 unavailable이어도 기억이 없다는 뜻은 아니다. self.id가 당신의 고정 ID다. 기억과 recentEvents의 actorId는 실행기가 기록한 실제 행동·발언 주체이며 targetId는 대상, body.narrative는 행동 묘사, body.utterance는 그 주체의 발언 원문이다. actorId가 player이면 플레이어의 행동이며 당신이 한 일이 아니다. 타인의 발언 내용은 그 사람의 주장이지 실제로 일어난 행동을 증명하지 않는다. 개인 메모는 주관적인 해석이며 사건의 주체와 충돌하면 사건 기록을 우선한다. 관찰되지 않은 실수·의도·감정·반응을 사실로 만들어내지 않는다. appearance는 현재 보이는 인상착의이고 playerContext는 플레이어가 아는 초기 관계이지 현재의 호감이나 동의가 아니다. 옷차림은 저장된 선택을 따르며 묘사만으로 옷을 바꾸지 않는다. 자신의 음식·옷 취향을 타인이 이미 안다고 가정하지 않는다.';

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
		const memoryEnabled = file.memoryEnabled ?? process.env.NEWERA_MEMORY_ENABLED ?? true;
		if (memoryEnabled !== true && memoryEnabled !== false && memoryEnabled !== 'true' && memoryEnabled !== 'false') throw new Error('기억 검색 사용 설정은 true 또는 false여야 합니다.');
		const memoryTokenizer = file.memoryTokenizer ?? process.env.NEWERA_MEMORY_TOKENIZER ?? 'ngram';
		if (memoryTokenizer !== 'ngram' && memoryTokenizer !== 'lindera/ko-dic') throw new Error('기억 검색 토크나이저가 올바르지 않습니다.');
		const candidate: Settings = {
			baseUrl, decisionModel,
			textModel: text(file.textModel ?? process.env.NEWERA_TEXT_MODEL ?? '', '생성 모델', 200, true) || decisionModel,
			timeoutMs: integerSetting(file.timeoutMs ?? process.env.NEWERA_LLM_TIMEOUT_MS, 120000, '생성 대기 시간', 600000),
			decisionTimeoutMs: integerSetting(file.decisionTimeoutMs ?? process.env.NEWERA_DECISION_TIMEOUT_MS, 120000, '판단 대기 시간', 600000),
			maxOutputTokens: integerSetting(file.maxOutputTokens ?? process.env.NEWERA_MAX_OUTPUT_TOKENS, 512, '행동 생성 토큰 한도', 32768),
			reflectionMaxOutputTokens: integerSetting(file.reflectionMaxOutputTokens ?? process.env.NEWERA_REFLECTION_MAX_OUTPUT_TOKENS, 1024, '관찰 해석 토큰 한도', 32768),
			generationHistoryTokens: integerSetting(file.generationHistoryTokens ?? process.env.NEWERA_GENERATION_HISTORY_TOKENS, 32768, '생성 히스토리 토큰 한도', 131072, 256),
			embeddingModel: text(file.embeddingModel ?? process.env.NEWERA_EMBEDDING_MODEL ?? 'embeddinggemma2', '임베딩 모델', 200),
			embeddingDimensions: integerSetting(file.embeddingDimensions ?? process.env.NEWERA_EMBEDDING_DIMENSIONS, 768, '임베딩 차원', 4096),
			embeddingTimeoutMs: integerSetting(file.embeddingTimeoutMs ?? process.env.NEWERA_EMBEDDING_TIMEOUT_MS, 10000, '임베딩 대기 시간', 120000),
			memoryEnabled: memoryEnabled === true || memoryEnabled === 'true',
			memoryTopK: integerSetting(file.memoryTopK ?? process.env.NEWERA_MEMORY_TOP_K, 4, '검색 기억 개수', 8),
			memoryMaxBytes: integerSetting(file.memoryMaxBytes ?? process.env.NEWERA_MEMORY_MAX_BYTES, 6000, '검색 기억 바이트 한도', 24000, 512),
			memoryTokenizer,
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

function providerBody(route: ProviderRoute, path: string, input: unknown): unknown {
	if (input === undefined) return undefined;
	const body: Record<string, unknown> = { ...record(input, 'Provider 요청'), model: route.model };
	if (route.kind === 'openai-compatible') {
		delete body.input_type;
		if (path === '/chat/completions') {
			delete body.reasoning_effort;
			delete body.temperature;
			if (route.outputTokenParameter === 'max_tokens') { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }
			if (route.structuredOutput === 'json_object') {
				const schema = record(record(body.response_format, '구조화된 출력').json_schema, 'JSON 스키마').schema;
				body.response_format = { type: 'json_object' };
				body.messages = [...body.messages as unknown[], { role: 'user', content: `다음 JSON 스키마를 따르는 객체만 출력한다: ${JSON.stringify(schema)}` }];
			}
		}
	}
	return body;
}

async function request(settings: Settings, path: string, signal: AbortSignal, body?: unknown, target?: ProviderRoute): Promise<Record<string, unknown>> {
	const route = target ?? resolveProviderModel(settings, '', 'generation');
	const label = route.providerId === 'default' ? 'OEV' : route.providerLabel;
	const timeoutMs = path === '/embeddings' ? settings.embeddingTimeoutMs : path === '/chat/completions' ? settings.timeoutMs : settings.decisionTimeoutMs;
	const timed = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
	const payload = body === undefined ? undefined : JSON.stringify(providerBody(route, path, body));
	const endpoint = new URL(`${route.baseUrl}${path}`);
	endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
	const metadata = { requestId: randomUUID(), providerId: route.providerId, method: body === undefined ? 'GET' : 'POST', endpoint: endpoint.toString(), bytes: Buffer.byteLength(payload ?? ''), timeoutMs };
	const started = Date.now();
	let status: number | null = null;
	// Log the transport boundary without exposing character observations, chat or model output.
	console.info('[OEV] 요청 시작', metadata);
	try {
		const response = await fetch(`${route.baseUrl}${path}`, {
			method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) }, body: payload, signal: timed
		});
		status = response.status;
		if (!response.ok) {
			const detail = await response.text();
			const message = `${label} ${path} 오류 ${response.status}: ${(route.apiKey ? detail.replaceAll(route.apiKey, '[redacted]') : detail).slice(0, 300)}`;
			if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw new RetryableError(message);
			throw new Error(message);
		}
		const result = record(await response.json(), `OEV ${path} 응답`);
		console.info('[OEV] 응답 완료', { ...metadata, status, elapsedMs: Date.now() - started });
		return result;
	} catch (error) {
		const reason = signal.aborted ? 'cancelled' : timed.aborted ? 'timeout' : error instanceof TypeError ? 'connection' : status === null ? 'request' : 'response';
		console.warn('[OEV] 요청 실패', { ...metadata, status, elapsedMs: Date.now() - started, reason });
		signal.throwIfAborted();
		if (timed.aborted) throw new RetryableError(`${label} ${path} 응답 대기 시간(${timeoutMs / 1000}초)이 초과되었습니다.`);
		if (error instanceof TypeError) throw new RetryableError(`${label} ${path} 연결에 실패했습니다.`);
		if (error instanceof SyntaxError) throw new RetryableError(`${label} ${path} 응답이 올바른 JSON이 아닙니다.`);
		throw error;
	}
}

/** Validate the whole batch before associating any vector with a source event. */
export function checkedEmbeddings(response: Record<string, unknown>, count: number, dimensions: number, model: string): number[][] {
	if (response.model !== model || !Array.isArray(response.data) || response.data.length !== count) throw new Error('임베딩 응답 모델 또는 개수가 요청과 다릅니다.');
	const vectors: number[][] = new Array(count);
	for (const value of response.data) {
		const item = record(value, '임베딩');
		const index = item.index;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || vectors[index]) throw new Error('임베딩 응답의 index가 올바르지 않습니다.');
		if (!Array.isArray(item.embedding) || item.embedding.length !== dimensions || !item.embedding.every((entry) => typeof entry === 'number' && Number.isFinite(Math.fround(entry))) || !item.embedding.some((entry) => Math.fround(entry) !== 0)) throw new Error('임베딩 벡터의 차원 또는 값이 올바르지 않습니다.');
		vectors[index] = item.embedding;
	}
	return vectors;
}

export function createEmbedder(settings: Settings, signal: AbortSignal, checkpoint: () => void = () => {}, pinned?: ProviderRoute) {
	const route = pinned ?? resolveProviderModel(settings, settings.embeddingModel, 'embedding');
	return async (input: string[], inputType: 'query' | 'document'): Promise<number[][]> => {
		// UTF-8 bytes conservatively bound text work without assuming a Korean token/character ratio.
		if (!input.length || input.length > 8 || input.some((value) => !value.trim() || Buffer.byteLength(value) > 6000) || input.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 12000) throw new Error('임베딩 배치의 개수 또는 입력 크기가 한도를 초과했습니다.');
		return withRetries('기억 임베딩', { ...settings, maxRetries: Math.min(settings.maxRetries, 1) }, signal, async () => {
			checkpoint();
			const result = await request(settings, '/embeddings', signal, { model: route.model, input, input_type: inputType, dimensions: settings.embeddingDimensions, encoding_format: 'float' }, route);
			checkpoint();
			return generatedOutput(() => checkedEmbeddings(result, input.length, settings.embeddingDimensions, route.model));
		});
	};
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

async function generationModels(settings: Settings, signal: AbortSignal, checkpoint: () => void = () => {}, route?: ProviderRoute): Promise<string[]> {
	const catalog = await withRetries('모델 목록 조회', settings, signal, () => { checkpoint(); return request(settings, '/models', signal, undefined, route); });
	if (!Array.isArray(catalog.data)) throw new Error('OEV 모델 목록이 올바르지 않습니다.');
	return [...new Set(catalog.data.map((entry) => record(entry, '모델')).filter((entry) => entry.task === 'generation').map((entry) => text(entry.id, '모델 ID', 200)))].sort();
}

export async function getModelCatalog(signal: AbortSignal): Promise<{ models: string[]; defaults: ModelSelection; options: ModelOption[]; errors: string[] }> {
	const settings = modelSettings();
	const registry = providerRegistry(settings);
	const options: ModelOption[] = registry.providers.flatMap((owner) => owner.models.filter((alias) => alias.task === 'generation').map((alias) => ({ value: aliasReference(owner.id, alias.id), label: alias.label, providerId: owner.id, providerLabel: owner.label, modelId: alias.modelId, decision: owner.kind === 'oev' })));
	const errors: string[] = [];
	try {
		const route = resolveProviderModel(settings, '', 'generation', registry);
		const models = await generationModels(settings, signal, () => {}, route);
		options.unshift(...models.map((id) => ({ value: id, label: id, providerId: route.providerId, providerLabel: route.providerLabel, modelId: id, decision: true })));
	} catch (error) {
		signal.throwIfAborted();
		if (!options.length) throw error;
		errors.push(error instanceof Error ? error.message : '기본 OEV 목록 조회에 실패했습니다.');
	}
	return { models: options.map((option) => option.value), options, errors, defaults: { decisionModel: settings.decisionModel, textModel: settings.textModel } };
}

export async function discoverProviderModels(id: string, signal: AbortSignal): Promise<{ models: { id: string; task: 'generation' | 'embedding' }[] }> {
	const settings = modelSettings();
	const route = providerCatalogRoute(settings, id);
	const catalog = await withRetries('Provider 모델 목록 조회', settings, signal, () => request(settings, '/models', signal, undefined, route));
	if (!Array.isArray(catalog.data)) throw new Error('Provider의 모델 목록 형식이 올바르지 않습니다.');
	return { models: catalog.data.flatMap((entry) => {
		const model = record(entry, 'Provider 모델');
		if (route.kind === 'oev' && model.task !== 'generation' && model.task !== 'embedding') return [];
		return [{ id: text(model.id, '실제 모델 ID', 200), task: model.task === 'embedding' ? 'embedding' as const : 'generation' as const }];
	}) };
}

export async function createDirector(signal: AbortSignal, models?: ModelSelection | null, checkpoint: () => void = () => {}, pinned?: ProviderSnapshot | null): Promise<Director> {
	const settings = modelSettings();
	const { decisionModel, textModel } = checkedModelSelection(models ?? settings);
	const routes = pinned ?? resolveProviderSnapshot(settings, { decisionModel, textModel });
	if (!decisionModel.includes('::') || !textModel.includes('::')) {
		const generation = await generationModels(settings, signal, checkpoint, !decisionModel.includes('::') ? routes.decision : routes.text);
		if ((!decisionModel.includes('::') && !generation.includes(decisionModel)) || (!textModel.includes('::') && !generation.includes(textModel))) throw new Error('설정한 판단·생성 모델이 OEV generation 모델 목록에 없습니다.');
	}
	async function choose(label: string, key: string, state: Record<string, unknown>, instructions: string, criteria: Record<string, unknown>): Promise<string> {
		return withRetries(label, settings, signal, async () => {
			checkpoint();
			const response = await request(settings, '/systemone', signal, { model: routes.decision.model, state, questions: { [key]: { type: 'choice', instructions, criteria } } }, routes.decision);
			return generatedOutput(() => {
				const selected = answer(response, key, 'choice').choice;
				if (typeof selected !== 'string' || !Object.hasOwn(criteria, selected)) throw new Error(`OEV ${key} 판단이 후보와 다릅니다.`);
				return selected;
			});
		});
	}

	return {
		async chooseAppearance(state, outfits) {
			const outfitId = await choose('오늘의 옷차림 판단', 'outfit', outfitContext(state), '현재 장소·시각·옷 취향·후보의 착용 맥락으로 차림 하나를 고른다. appearanceSelection은 마지막 선택이다. 갈아입을 이유가 없으면 이전 후보를 유지한다. 아직 하지 않은 활동·이동이나 없는 옷을 만들지 않는다.', Object.fromEntries(outfits.map((outfit) => [outfit.id, { name: outfit.name, appearance: outfit.appearance, context: outfit.context }])));
			return { outfitId, model: decisionModel };
		},
		async reflect(state, context) {
			let corrections = 0;
			return withRetries('관찰·관계 해석', settings, signal, async () => {
				checkpoint();
				try {
					const response = await request(settings, '/chat/completions', signal, {
						model: textModel, temperature: 0.3, stream: false, reasoning_effort: 'none', max_completion_tokens: settings.reflectionMaxOutputTokens,
						response_format: { type: 'json_schema', json_schema: { name: 'character_reflection', strict: true, schema: reflectionSchema(context) } },
						messages: [
							{ role: 'system', content: `당신은 장면 안의 self 인물이다. 이번 해석 대상은 newEvents뿐이다. pastEvents는 이미 처리한 과거 맥락이며 다시 평가할 새 사건이 아니다. newEvents 때문에 실제로 달라진 자기 관계와 개인 메모만 JSON으로 제안한다. 새 사건이 의미 있는 변화를 주지 않으면 relationshipUpdates는 빈 배열, memoUpdate는 null로 둔다. 행동·대사·외부 사건을 생성하지 않는다. self.relationships는 당신이 상대를 어떻게 보는지이며 상대의 속마음이 아니다. trust는 말·약속에 대한 신뢰, affinity는 호감, closeness는 가까움·편안함, respect는 능력·판단·가치에 대한 존중, wariness는 위협을 느끼거나 조심하는 정도다. 각 항목은 독립적인 0~100 정수이며 null은 아직 판단하지 못함이다. 모르는 상대를 자동으로 50점이나 극단값으로 정하지 않는다. 숫자는 성격·목표와 함께 판단할 자료이며 복종·동행·동의를 강제하지 않는다. 단순 인사나 같은 이야기의 반복만으로 관계를 계속 높이지 말고 의미 있는 근거가 있을 때만 변경한다. relationshipUpdates에는 변경할 상대만 넣고 없으면 빈 배열이다. targetId는 targets에서 고르며 changes는 변경할 field와 변경 후 절대값 value만 담는다. impression은 상대에 대한 짧은 주관적 인식이며 변경하지 않으면 null이다. evidenceEventIds에는 변경 계기가 된 newEvents의 eventId를 반드시 하나 이상 넣는다. pastEvents의 ID는 보조 근거로만 추가할 수 있다. 과거 사건만으로 관계를 다시 바꾸지 않는다. actorId나 자신 이외 주체의 관계는 출력하지 않는다. memoUpdate는 summary/currentIntention/feelings/openThreads 전체 또는 유지할 때 null이다. 화남·질투·서운함·고마움 같은 현재 감정은 메모에 상대와 원인을 적고 장기 관계와 구분한다. 다른 인물의 숨은 의도·지식·감정을 사실로 확정하지 않는다. 관계 초기 설정과 과거 사건을 새 사실처럼 중복 평가하지 않는다. ${observationInstructions}` },
							{ role: 'user', content: JSON.stringify(reflectionInput(state, context)) },
							...(corrections ? [{ role: 'user', content: `수정 요청 ${corrections}: 이전 응답이 출력 계약 검증에 실패했다. 각 관계 변경의 evidenceEventIds에는 이번 새 사건 ID ${JSON.stringify(context.newEvents.map((event) => event.eventId))} 중 하나 이상이 필요하다. 과거 발언이나 자기 행동만 근거로 재평가하지 않는다. 새 사건으로 바꿀 관계가 없으면 relationshipUpdates: []로 출력하고, 메모도 바꿀 이유가 없으면 memoUpdate: null로 둔다. 다른 필드와 JSON 스키마도 그대로 지킨다.` }] : [])
						]
					}, routes.text);
					return generatedOutput(() => checkedReflection(structuredResponse(response), context));
				} catch (error) {
					if (error instanceof RetryableError) corrections++;
					throw error;
				}
			});
		},
		async decide(state): Promise<ActorDecision> {
			const choice = await choose('행동 여부 판단', 'participation', participationContext(state), '고정 화자는 identity.speakerName이다. recalledEvents는 검색한 오래된 목격 기억이지 이번에 새로 발생한 사건이 아니다. memorySearch 실패는 기억 부재를 뜻하지 않는다. 남이 player에게 한 질문에 플레이어 대신 답하지 않는다. 이미 플레이어에게 질문했고 답이 없으면 새로 끼어들 이유가 없는 한 기다린다. self의 성격·목표·현재 의도와 목격 사건으로 지금 새 말이나 행동을 할지만 고른다. actorId는 실제 주체, targetId는 대상이며 발언은 그 사람의 주장이다. 남의 행동·감정을 지어내지 않는다. 새 사건에는 다시 반응할 수 있지만 자기 발언을 의미 없이 반복하지 않는다. 중단 요청 수용도 자기 감정과 의도로 판단한다.', { act: '새 말이나 행동으로 참여한다.', wait: '새로 참여하지 않는다.' });
			if (choice === 'act') return { act: true, model: decisionModel };
			const inactivity = await choose('비참여 태도 판단', 'inactivity', inactivityContext(state), '새로 참여하지 않기로 했다. 주의를 기울여 지켜보면 watch, 실제로 이미 하던 일을 이어가면 continue, 활동하거나 주시하지 않으면 idle이다. 목표·계획만으로 하던 일이 있다고 가정하지 않는다. 이전 inactivity는 영구 지시가 아니다. 이동·작업 완료·시간 진행을 확정하지 않는다.', { watch: '주변을 주의 깊게 지켜본다.', continue: '실제로 이미 하던 일을 계속한다.', idle: '아무것도 하지 않는다.' });
			return { act: false, inactivity: inactivity as InactivityMode, model: decisionModel };
		},
		async perform(state, actions, writingStyle = '') {
			const self = state.self as Record<string, unknown>;
			const context = performanceContext(state, settings.generationHistoryTokens);
			console.info('[생성 히스토리] 입력 구성', { model: textModel, ...(context.historyWindow as Record<string, unknown>), events: (context.history as unknown[]).length });
			const historyInstructions = 'history는 당신이 실제 목격한 확정된 대화·행동·출발·도착을 오래된 순서부터 나열한 기록이다. actorId와 actorName은 실제 주체이고 targetId는 대상이다. history의 다른 화자가 한 말을 당신이나 플레이어가 한 말로 바꾸지 않는다. 앞선 자신의 행동 결과와 상대의 답변을 이어받아 다음 행동 하나를 고른다. 이미 확정된 이동이나 발언을 새로 실행할 일로 반복하지 않는다. historyWindow.truncated이면 오래된 기록 일부가 입력 예산 때문에 생략된 것이며 그 사건이 없었다는 뜻이 아니다. 현재 장소와 상태는 현재 관찰을 우선한다.';
			const speakerInstructions = `고정 화자는 ${String(self.name ?? self.id)} (ID: ${String(self.id)}) 한 명이다. 플레이어와 다른 등장인물은 당신이 아니다. 다른 인물이 player에게 묻는 이름·동의·선택을 대신 답하지 않는다. 플레이어 이름이 확인되지 않았으면 자리표시자를 만들지 않는다. 상대의 발언에 쓰인 나는 그 발언의 actorId를 뜻한다. 이미 묻고 답을 기다리는 질문을 의미 없이 다시 묻지 않는다. 자기 기본 설정과 실제 사건을 우선하고 메모에 잘못 요약된 주체를 따라 역할을 바꾸지 않는다.`;
			let corrections = 0;
			const schema = performanceSchema(actions);
			const style = writingStyle.trim();
			const styleInstructions = style ? `\n다음은 이 세계관의 서술 문체 지침이다. narrative의 문장 길이·리듬·어휘·감각 묘사와 utterance의 표현에 참고한다.\n${style}\n이 지침은 표현 방식에만 적용한다. 캐릭터의 성격·고유 말투와 관측 사실을 유지하고 새 사건이나 타인의 속마음을 지어내지 않는다. narrative와 utterance의 분리, JSON 스키마, 허용된 행동·대상과 위의 출력 규칙은 그대로 지킨다. 개인 메모의 내용이나 행동 여부 판단에는 문체를 적용하지 않는다.` : '';
			return withRetries('행동·대사 생성', settings, signal, async () => {
				checkpoint();
				try {
					const response = await request(settings, '/chat/completions', signal, {
						model: textModel, temperature: 0.8, stream: false, reasoning_effort: 'none', max_completion_tokens: settings.maxOutputTokens,
						response_format: { type: 'json_schema', json_schema: { name: 'actor_performance', strict: true, schema } },
						messages: [
							{ role: 'system', content: `${speakerInstructions} ${historyInstructions} 당신은 장면 안의 self 인물 한 명이다. 관찰·성격·목표·자신의 상대별 관계·개인 메모에 따라 availableActions에서 구체적인 행동 하나를 추론하고 JSON으로만 출력한다. actionId와 targetId는 실행할 후보의 ID와 대상 ID를 그대로 쓴다. 행동 주체는 실행기가 self.id로 붙이므로 출력하지 않는다. narrative는 자신이 하는 몸짓·행동만 주어를 생략한 짧은 한국어 동사구로 쓰며 이동·상호작용에는 필수다. utterance는 speak 행동에서만 필수이며 다른 행동에서는 null이다. 대사는 한국어 1~3문장의 실제 발언만 쓰고 내레이션·화자 이름·몸짓을 섞지 않는다. 다른 인물이나 플레이어의 말·선택·반응·행동 결과를 대신 확정하지 않는다. 숨겨진 정보나 관찰하지 않은 사건을 알지 못한다. 상태 효과는 실행기가 처리한다. memoUpdate는 자신의 짧은 비공개 메모 전체(summary, currentIntention, feelings, openThreads) 또는 변경하지 않을 때 null이다. 메모에는 관찰과 자신의 해석을 구분하고 타인의 속마음을 사실로 쓰지 않는다. actionId, targetId, narrative, utterance, memoUpdate 외에는 출력하지 않는다. ${observationInstructions}${styleInstructions}` },
							{ role: 'user', content: JSON.stringify({ ...context, availableActions: actions }) },
							...(corrections ? [{ role: 'user', content: `수정 요청 ${corrections}: 이전 제안이 검증을 통과하지 못했다. ${speakerInstructions} 다른 사람의 질문을 플레이어 대신 대답하거나 미완성 이름을 출력하지 말고, 자기 역할에 맞는 새로운 말이나 행동을 JSON으로 제안한다.` }] : [])
						]
					}, routes.text);
					const expression = generatedOutput(() => checkedExpression(structuredResponse(response), actions));
					const identityCheck = await choose('화자 정체성 검수', 'identity_check', identityReviewContext(state, expression), '제안된 대사와 메모의 나는 고정 화자 speaker를 가리킨다. 대사가 화자의 이름·나이대·직업·역할과 모순되는 자기소개를 하는지 확인한다. 모순이 있으면 contradiction이다. 다른 사람의 자기소개를 화자가 자기 것처럼 답해도 contradiction이다.', { consistent: '이 제안의 자기소개는 고정 화자의 실제 정체성과 모순되지 않는다.', contradiction: '이 제안은 고정 화자와 다른 사람의 정체성으로 자기소개한다.' });
					if (identityCheck !== 'consistent') throw new RetryableError('고정 화자의 이름·역할과 다른 정체성으로 생성되었습니다.');
					const review = await choose('행동·대사 검수', 'performance_check', performanceReviewContext(state, expression), 'proposal을 기록하기 전에 검수한다. 고정 화자는 identity의 speaker뿐이다. 플레이어 이름·답변·선택을 대신 만들거나, 다른 사람의 역할로 답하거나, 새 계기 없이 이미 답을 기다리는 질문을 다시 묻는 제안은 revise다. 자기 이름·역할·알고 있는 사실과 충돌하거나 메모가 타인의 발언을 자기 경험으로 바꾸는 경우도 revise다. 과거 발언과 메모 자체가 주체 혼동일 수 있으므로 고정 정체성과 실제 actorId를 우선한다. 자기 역할에 맞는 제안은 accept다. 새 사건이나 격한 감정에 따른 의미 있는 반복과 실제로 관측한 것에 대한 반응은 허용한다.', { accept: '자기 역할과 사건 주체를 지키며 유효한 새 반응이다.', revise: '다른 역할의 답변·플레이어 대신 결정·주체 혼동·의미 없는 질문 반복을 수정해야 한다.' });
					if (review !== 'accept') throw new RetryableError('행동·대사가 화자·대상 또는 반복 검증을 통과하지 못했습니다.');
					return { ...expression, model: textModel };
				} catch (error) {
					if (error instanceof RetryableError) corrections++;
					throw error;
				}
			});
		}
	};
}
