import type { ActionId, Character, EventRecord, MemoryRecord, ScenarioConfig, WorldState } from '$lib/game/types';

const baseUrl = (process.env.NEWERA_LLM_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
export const llmModel = process.env.NEWERA_LLM_MODEL || 'gemma4-31b-qat-uncensored-hauhaucs-balanced-mtp';
export const embeddingModel = process.env.NEWERA_EMBEDDING_MODEL || 'text-embedding-qwen3-embedding-0.6b';

export interface WorldBeat {
	scene: string;
	situation: string;
	location: string;
	focusCharacterId: string | null;
	minutes: number;
	worldMemory: string;
}

export interface CharacterTurn {
	narrative: string;
	accepted: boolean;
	proposal: { actionId: Exclude<ActionId, 'rest'>; text: string } | null;
	memory: string | null;
}

function timeout(): number {
	const configured = Number(process.env.NEWERA_LLM_TIMEOUT_MS);
	return Number.isFinite(configured) && configured > 0 ? configured : 180_000;
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
	const response = await fetch(`${baseUrl}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeout())
	});
	if (!response.ok) {
		throw new Error(`모델 서버 오류 ${response.status}: ${(await response.text()).slice(0, 250)}`);
	}
	return (await response.json()) as Record<string, unknown>;
}

async function completion(system: string, input: unknown, temperature = 0.85): Promise<Record<string, unknown>> {
	const response = await postJson('/chat/completions', {
		model: llmModel,
		temperature,
		stream: false,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: JSON.stringify(input) }
		]
	});
	const choices = response.choices as Array<{ message?: { content?: unknown } }> | undefined;
	const content = choices?.[0]?.message?.content;
	if (typeof content !== 'string') throw new Error('모델 응답이 비어 있습니다.');
	const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	let parsed: unknown;
	try {
		parsed = JSON.parse(clean);
	} catch {
		const start = clean.indexOf('{');
		const end = clean.lastIndexOf('}');
		if (start < 0 || end <= start) throw new Error('모델이 JSON 응답을 주지 않았습니다.');
		parsed = JSON.parse(clean.slice(start, end + 1));
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('모델 응답 형식이 올바르지 않습니다.');
	}
	return parsed as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`모델 응답의 ${label} 항목이 비어 있습니다.`);
	return value.trim();
}

export async function embed(text: string): Promise<number[]> {
	const response = await postJson('/embeddings', { model: embeddingModel, input: text });
	const data = response.data as Array<{ embedding?: unknown }> | undefined;
	const vector = data?.[0]?.embedding;
	if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
		throw new Error('임베딩 응답이 올바르지 않습니다.');
	}
	return vector as number[];
}

export async function generatePlayerSuggestions(input: {
	world: WorldState;
	config: ScenarioConfig;
	character: Character | null;
	characters: Character[];
	currentScene: string;
	recentEvents: EventRecord[];
	availableActions: Array<{ id: ActionId; title: string }>;
}): Promise<string[]> {
	const result = await completion(
		[
			'당신은 한국어 era 텍스트 게임에서 플레이어가 먼저 할 행동을 제안한다.',
			'현재 세계, 최근 사건, 선택한 상대의 성격과 관계를 보고 서로 다른 구체적인 선택지 3개를 만든다. 반복적인 잡담과 막연한 감정 표현은 피한다.',
			'상대가 없으면 장소 탐색, 이동, 준비, 휴식처럼 세계에 직접 작용하는 행동을 제안한다.',
			'상대가 선택되어 있으면 그 인물 한 명에게 하는 행동만 제안한다. 다른 등장인물을 함께 행동 대상으로 넣지 않는다. 현재 장면에서 확인되지 않은 접촉이나 약속을 이미 일어난 일처럼 전제하지 않는다.',
			'제안은 플레이어가 시도할 행동이며 결과를 미리 확정하지 않는다. 상대의 승낙을 전제로 쓰지 않는다.',
			'기존 COMMAND에 해당하는 제안은 availableActions에 있는 행동만 사용한다. 조건이 잠긴 신체·성인 행동을 다른 말로 제안하지 않는다.',
			'JSON 객체만 반환한다: {"suggestions":["플레이어가 시도할 구체적 행동", "...", "..."]}.'
		].join(' '),
		{
			world: input.world,
			worldSetting: input.config.worldSetting,
			eraRules: input.config.eraRules,
			worldMemory: input.config.worldMemory,
			character: input.character,
			currentScene: input.currentScene,
			recentEvents: input.recentEvents.slice(0, 8).map((event) => event.summary),
			availableActions: input.availableActions
		}
	);
	if (!Array.isArray(result.suggestions)) throw new Error('행동 제안 형식이 올바르지 않습니다.');
	const otherNames = input.character
		? input.characters.filter((character) => character.id !== input.character?.id).map((character) => character.name)
		: [];
	const suggestions = [...new Set(result.suggestions
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim())
		.filter((value) => value && !otherNames.some((name) => value.includes(name))))].slice(0, 4);
	if (!suggestions.length) throw new Error('생성된 행동 제안이 없습니다.');
	return suggestions;
}

export async function interpretPlayerAction(input: {
	text: string;
	selectedTargetId: string | null;
	characters: Character[];
}): Promise<{ actionId: ActionId | null; targetId: string | null }> {
	const result = await completion(
		[
			'당신은 플레이어가 직접 쓴 행동을 era COMMAND에 연결하는 해석기다. 이야기나 결과를 쓰지 않는다.',
			'의도가 대화면 talk, 이야기를 들어주면 listen, 유혹/호감 표현이면 flirt, 입맞춤이면 kiss, 성관계 제안이면 intimacy, 휴식이면 rest다.',
			'이 밖의 이동·탐색·물건 사용·일상 행동은 actionId를 null로 둔다. kiss나 intimacy 같은 행동을 조건 검사를 피하려고 null로 분류하지 않는다.',
			'문장에 명시된 인물이 있으면 그 ID를 targetId로 쓰고, 없지만 선택된 상대에게 하는 행동이면 selectedTargetId를 쓴다. 특정 인물이 관계없는 행동이면 null이다.',
			'JSON 객체만 반환한다: {"actionId":"talk|listen|flirt|kiss|intimacy|rest" 또는 null,"targetId":"기존 인물 ID" 또는 null}.'
		].join(' '),
		{
			playerText: input.text,
			selectedTargetId: input.selectedTargetId,
			characters: input.characters.map((character) => ({ id: character.id, name: character.name }))
		},
		0
	);
	if (result.actionId !== null && (typeof result.actionId !== 'string' || !['talk', 'listen', 'flirt', 'kiss', 'intimacy', 'rest'].includes(result.actionId))) {
		throw new Error('행동 해석 결과가 올바르지 않습니다.');
	}
	if (result.targetId !== null && (typeof result.targetId !== 'string' || !input.characters.some((character) => character.id === result.targetId))) {
		throw new Error('행동 대상 해석 결과가 올바르지 않습니다.');
	}
	const actionId = result.actionId as ActionId | null;
	const targetId = result.targetId as string | null;
	return { actionId, targetId: actionId === 'rest' ? null : targetId };
}

export async function generateWorldBeat(input: {
	world: WorldState;
	config: ScenarioConfig;
	characters: Character[];
	recentEvents: EventRecord[];
	intent: string | null;
	targetId: string | null;
}): Promise<WorldBeat> {
	const result = await completion(
		[
			'당신은 한국어 성인 era 텍스트 게임의 세계 진행 담당 세션이다.',
			'세계의 시간, 장소, 외부 사건과 장면의 출발 상황만 결정한다. 인물의 대사·속마음·승낙·거절은 인물 세션에 맡긴다.',
			'scene은 새로운 상황을 보여주는 간결한 1~2문장으로 쓴다. 직전 사건을 다시 설명하거나 분위기만 길게 수식하지 않는다.',
			'플레이어가 행동을 정했다면 그 행동의 결과를 미리 확정하지 않는다. 세계관 설정과 확정 사건을 지키며, 세계는 플레이어가 기다려도 움직인다.',
			'최근 사건을 보고 같은 인물과 같은 상황만 연속해서 반복하지 않는다. 시간의 흐름에 맞는 일정, 장소, 외부 사건의 변화를 만든다.',
			'JSON 객체만 반환한다: {"scene":"세계 상황 서술","situation":"인물이 반응할 구체적 상황","location":"현재 또는 새 장소","focusCharacterId":"기존 인물 ID 또는 null","minutes":경과 분,"worldMemory":"다음 턴까지 유지할 중요한 세계 사실의 갱신된 요약"}.',
			'worldMemory에는 이전 요약에서 여전히 유효한 사실과 이번 세계 변화만 간결하게 남긴다. 아직 인물이 결정하지 않은 행동 결과는 넣지 않는다.',
			'인물이 지정된 행동이면 focusCharacterId는 그 인물로 한다. scene에는 인물의 행동, 대사, 결정이나 확정되지 않은 성적 접촉을 쓰지 않는다.'
		].join(' '),
		{
			worldSetting: input.config.worldSetting,
			eraRules: input.config.eraRules,
			worldMemory: input.config.worldMemory,
			world: input.world,
			cast: input.characters.map((character) => ({
				id: character.id,
				name: character.name,
				age: character.age,
				profile: character.profile,
				trait: character.trait,
				relation: character.relation,
				mark: character.mark
			})),
			recentEvents: input.recentEvents.slice(0, 8).map((event) => event.summary),
			playerIntent: input.intent,
			targetCharacterId: input.targetId
		}
	);
	const location = requiredText(result.location, 'location');
	const focusCharacterId = input.targetId ?? (
		typeof result.focusCharacterId === 'string' && input.characters.some((character) => character.id === result.focusCharacterId)
			? result.focusCharacterId
			: null
	);
	const minutes = Number(result.minutes);
	return {
		scene: requiredText(result.scene, 'scene'),
		situation: requiredText(result.situation, 'situation'),
		location,
		focusCharacterId,
		minutes: Number.isFinite(minutes) ? Math.max(5, Math.min(120, Math.round(minutes))) : 20,
		worldMemory: typeof result.worldMemory === 'string' ? result.worldMemory.trim() : input.config.worldMemory
	};
}

export async function generateCharacterTurn(input: {
	character: Character;
	memories: MemoryRecord[];
	config: ScenarioConfig;
	beat: WorldBeat;
	intent: string | null;
	mode: 'idle' | 'player-action' | 'accept-proposal' | 'decline-proposal';
	availableActions: ActionId[];
	recentInteractions: EventRecord[];
}): Promise<CharacterTurn> {
	const result = await completion(
		[
			`당신은 era 텍스트 게임 등장인물 '${input.character.name}' 한 명만 맡는 독립 세션이다. 모든 등장인물은 성인이다.`,
			'인물 설정, 현재 스탯, 관계, 경험, 마크, 인물 자신의 기억에 따라 자율적으로 행동한다. 다른 인물이나 플레이어의 의사·대사를 대신 결정하지 않는다.',
			'player-action이면 제안에 승낙 또는 거절할 수 있다. accept-proposal이면 자신이 직전 장면에서 먼저 제안한 행동을 플레이어가 수락한 것이다. decline-proposal이면 플레이어가 제안을 거절한 것이다.',
			'idle이면 availableActions에 포함된 행동만 필요에 따라 먼저 제안할 수 있다. 제안은 아직 실행된 사건이 아니다. 성인 행동도 제안과 실제 실행을 구분한다.',
			'최근 같은 행동을 반복했다면 이번에는 대화의 주제나 인물의 목적이 실제로 달라질 때만 다시 제안한다. 제안할 이유가 없으면 proposal은 null이다.',
			'한국어 텍스트 미연시 장면을 쓰되 짧고 구체적으로 쓴다. 장면마다 인물의 선택이나 대화 내용이 한 가지는 달라져야 한다. 평범한 대화와 호감 표현마다 큰 감정의 결론을 내리지 않는다.',
			'뺨이 붉어짐, 고개를 끄덕임, 다정한 눈빛, 마음이 편안해짐 같은 상투적인 반응과 감정 수식어를 반복하지 않는다. 같은 말을 되풀이하지 말고 인물의 실제 관심사와 현재 상황을 대사에 반영한다.',
			'JSON 객체만 반환한다: {"narrative":"인물의 행동과 대사를 포함한 간결한 장면","accepted":true 또는 false,"proposal":{"actionId":"talk|listen|flirt|kiss|intimacy","text":"플레이어에게 보여줄 제안"} 또는 null,"memory":"나중에 행동을 바꿀 만한 구체적 발언·약속·갈등·사실 한 문장, 없으면 null"}.',
			'memory는 장면 문장을 복사하거나 일반적인 감정 평가를 쓰지 않는다. 실제로 일어난 일만 3인칭 사실 문장으로 쓴다. 중요한 새 사실이 없으면 반드시 null을 반환한다.',
			'idle 외의 모드에서는 proposal을 null로 한다.'
		].join(' '),
		{
			worldSetting: input.config.worldSetting,
			eraRules: input.config.eraRules,
			worldScene: input.beat.scene,
			situation: input.beat.situation,
			location: input.beat.location,
			mode: input.mode,
			availableActions: input.availableActions,
			playerIntent: input.intent,
			character: input.character,
			personalMemories: input.memories.map((memory) => memory.summary),
			recentInteractions: input.recentInteractions.map((event) => ({ turn: event.turn, action: event.actionId, summary: event.summary }))
		}
	);
	let proposal: CharacterTurn['proposal'] = null;
	if (input.mode === 'idle' && result.proposal && typeof result.proposal === 'object') {
		const candidate = result.proposal as Record<string, unknown>;
		if (
			typeof candidate.actionId === 'string' &&
			['talk', 'listen', 'flirt', 'kiss', 'intimacy'].includes(candidate.actionId) &&
			typeof candidate.text === 'string' && candidate.text.trim()
		) {
			proposal = { actionId: candidate.actionId as Exclude<ActionId, 'rest'>, text: candidate.text.trim() };
		}
	}
	return {
		narrative: requiredText(result.narrative, 'narrative'),
		accepted: result.accepted === true,
		proposal,
		memory: typeof result.memory === 'string' && result.memory.trim() ? result.memory.trim() : null
	};
}
