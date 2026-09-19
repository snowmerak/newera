import type { ActionId, Character, EventRecord, MemoryRecord, ScenarioConfig, WorldState } from '$lib/game/types';

const baseUrl = (process.env.NEWERA_LLM_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
export const llmModel = process.env.NEWERA_LLM_MODEL || 'gemma4-26b-a4b-qat-uncensored-hauhaucs-balanced-mtp';
export const embeddingModel = process.env.NEWERA_EMBEDDING_MODEL || 'text-embedding-qwen3-embedding-0.6b';

export interface WorldBeat {
	scene: string;
	situation: string;
	location: string;
	focusCharacterId: string | null;
	minutes: number;
	worldMemory: string;
	sceneNote: string;
}

export interface CharacterTurn {
	narrative: string;
	accepted: boolean;
	proposal: { actionId: Exclude<ActionId, 'rest'>; text: string } | null;
	memory: string | null;
	sceneNote: string;
}

type JsonSchema = Record<string, unknown>;
type CharacterTurnMode = 'idle' | 'player-action' | 'accept-proposal' | 'decline-proposal';

interface StructuredOutput {
	name: string;
	schema: JsonSchema;
}

const actionIds: ActionId[] = ['talk', 'listen', 'flirt', 'kiss', 'intimacy', 'rest'];
const proposalActionIds: Array<Exclude<ActionId, 'rest'>> = ['talk', 'listen', 'flirt', 'kiss', 'intimacy'];

const playerSuggestionsOutput: StructuredOutput = {
	name: 'player_action_suggestions',
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			suggestions: {
				type: 'array',
				items: { type: 'string', minLength: 1 },
				minItems: 2,
				maxItems: 3
			}
		},
		required: ['suggestions']
	}
};

function playerActionOutput(characterIds: string[]): StructuredOutput {
	return {
		name: 'player_action_interpretation',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				actionId: { type: ['string', 'null'], enum: [...actionIds, null] },
				targetId: { type: ['string', 'null'], enum: [...characterIds, null] }
			},
			required: ['actionId', 'targetId']
		}
	};
}

function worldBeatOutput(characterIds: string[]): StructuredOutput {
	return {
		name: 'world_beat',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				scene: { type: 'string', minLength: 1 },
				situation: { type: 'string', minLength: 1 },
				location: { type: 'string', minLength: 1 },
				focusCharacterId: { type: ['string', 'null'], enum: [...characterIds, null] },
				minutes: { type: 'integer', minimum: 5, maximum: 120 },
				worldMemory: { type: 'string' },
				sceneNote: { type: 'string', minLength: 1 }
			},
			required: ['scene', 'situation', 'location', 'focusCharacterId', 'minutes', 'worldMemory', 'sceneNote']
		}
	};
}

function characterTurnOutput(mode: CharacterTurnMode, availableActions: ActionId[]): StructuredOutput {
	const availableProposals = proposalActionIds.filter((actionId) => availableActions.includes(actionId));
	const proposal: JsonSchema = mode === 'idle' && availableProposals.length
		? {
			anyOf: [
				{
					type: 'object',
					additionalProperties: false,
					properties: {
						actionId: { type: 'string', enum: availableProposals },
						text: { type: 'string', minLength: 1 }
					},
					required: ['actionId', 'text']
				},
				{ type: 'null' }
			]
		}
		: { type: 'null' };
	return {
		name: 'character_turn',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				narrative: { type: 'string', minLength: 1 },
				accepted: { type: 'boolean' },
				proposal,
				memory: { type: ['string', 'null'] },
				sceneNote: { type: 'string', minLength: 1 }
			},
			required: ['narrative', 'accepted', 'proposal', 'memory', 'sceneNote']
		}
	};
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

async function completion(system: string, input: unknown, output: StructuredOutput, temperature = 0.85): Promise<Record<string, unknown>> {
	const response = await postJson('/chat/completions', {
		model: llmModel,
		temperature,
		stream: false,
		response_format: {
			type: 'json_schema',
			json_schema: { name: output.name, strict: true, schema: output.schema }
		},
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: JSON.stringify(input) }
		]
	});
	const choices = response.choices as Array<{ message?: { content?: unknown } }> | undefined;
	const content = choices?.[0]?.message?.content;
	if (typeof content !== 'string') throw new Error('모델 응답이 비어 있습니다.');
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error('모델이 구조화된 JSON 응답을 주지 않았습니다.');
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

const singleCharacterAttempts = 2;

function mentionedCharacterNames(values: unknown[], names: string[]): string[] {
	const text = values.filter((value): value is string => typeof value === 'string').join('\n');
	return names.filter((name) => text.includes(name));
}

function recentTurnContext(events: EventRecord[], limit: number): Array<{
	turn: number;
	day: number;
	minute: number;
	location: string;
	action: string;
	characterId: string | null;
	summary: string;
	narrative: string;
}> {
	return events.slice(0, limit).reverse().map((event) => ({
		turn: event.turn,
		day: event.day,
		minute: event.minute,
		location: event.location,
		action: event.actionId,
		characterId: event.characterId,
		summary: event.summary,
		narrative: event.narrative
	}));
}

function timeContext(world: WorldState): { day: number; clock: string; minuteAfterMidnight: number; period: string } {
	const hour = Math.floor(world.minute / 60);
	const minute = world.minute % 60;
	const period = hour < 6 ? '새벽' : hour < 12 ? '오전' : hour < 17 ? '오후' : hour < 21 ? '저녁' : '밤';
	return {
		day: world.day,
		clock: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
		minuteAfterMidnight: world.minute,
		period
	};
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
			'현재 세계, 최근 사건, 선택한 상대의 성격과 관계를 보고 서로 다른 구체적인 선택지 2~3개를 만든다. 반복적인 잡담과 막연한 감정 표현은 피한다.',
			'인물을 지정하지 않았으면 장소 탐색, 이동, 준비, 휴식처럼 특정 인물을 대상으로 하지 않는 행동을 제안한다.',
			'상대가 선택되어 있으면 그 인물 한 명에게 하는 행동만 제안한다. 다른 등장인물을 함께 행동 대상으로 넣지 않는다. 현재 장면에서 확인되지 않은 접촉이나 약속을 이미 일어난 일처럼 전제하지 않는다.',
			'제안은 플레이어가 시도할 행동이며 결과를 미리 확정하지 않는다. 상대의 승낙을 전제로 쓰지 않는다.',
			'기존 COMMAND에 해당하는 제안은 availableActions에 있는 행동만 사용한다. 조건이 잠긴 신체·성인 행동을 다른 말로 제안하지 않는다.',
			'스키마의 suggestions에는 플레이어가 시도할 구체적인 행동만 넣는다.'
		].join(' '),
		{
			world: input.world,
			worldSetting: input.config.worldSetting,
			eraRules: input.config.eraRules,
			worldMemory: input.config.worldMemory,
			sceneNote: input.config.sceneNote,
			character: input.character,
			currentScene: input.currentScene,
			recentTurns: recentTurnContext(input.recentEvents, 6),
			availableActions: input.availableActions
		},
		playerSuggestionsOutput
	);
	if (!Array.isArray(result.suggestions)) throw new Error('행동 제안 형식이 올바르지 않습니다.');
	const otherNames = input.character
		? input.characters.filter((character) => character.id !== input.character?.id).map((character) => character.name)
		: input.characters.map((character) => character.name);
	const suggestions = [...new Set(result.suggestions
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim())
		.filter((value) => value && !otherNames.some((name) => value.includes(name))))];
	const fallback = input.character
		? [
			`${input.character.name}에게 지금 무슨 생각을 하는지 묻는다`,
			`${input.character.name}의 이야기를 들어준다`,
			`${input.character.name}에게 함께 다른 곳으로 가자고 제안한다`
		]
		: ['주변 상황을 자세히 살핀다', '다른 장소로 이동한다', '잠시 기다리며 상황의 변화를 지켜본다'];
	for (const option of fallback) {
		if (suggestions.length >= 3) break;
		if (!suggestions.includes(option)) suggestions.push(option);
	}
	return suggestions.slice(0, 3);
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
			'스키마의 actionId와 targetId에는 해석 결과만 넣는다.'
		].join(' '),
		{
			playerText: input.text,
			selectedTargetId: input.selectedTargetId,
			characters: input.characters.map((character) => ({ id: character.id, name: character.name }))
		},
		playerActionOutput(input.characters.map((character) => character.id)),
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
	const system = [
			'당신은 한국어 성인 era 텍스트 게임의 세계 진행 담당 세션이다.',
			'세계의 시간, 장소, 외부 사건과 장면의 출발 상황만 결정한다. 인물의 대사·속마음·승낙·거절은 인물 세션에 맡긴다.',
			'currentSceneNote는 직전 턴이 끝난 순간의 위치, 함께 있는 인물, 자세, 진행 중인 행동과 즉각적인 의도를 기록한 현재 상태다. recentResolvedTurns의 실제 서술과 함께 확정 사실로 취급한다.',
			'currentTime은 현재의 정확한 날짜와 시각이다. minutes가 지난 뒤의 시각을 계산해 scene의 햇빛, 노을, 오전, 저녁, 밤 같은 표현과 모순되지 않게 한다.',
			'가장 최근 턴에서 이미 끝난 귀가, 만남, 이동, 착석, 접촉이나 대화를 다시 시작하지 않는다. 명시적인 이동이나 충분한 시간 경과가 없다면 같은 장소와 물리적 연속성을 이어간다.',
			'scene은 새로운 상황을 보여주는 간결한 1~2문장으로 쓴다. 직전 사건을 다시 설명하거나 분위기만 길게 수식하지 않는다.',
			'플레이어가 행동을 정했다면 그 행동의 결과를 미리 확정하지 않는다. 세계관 설정과 확정 사건을 지키며, 세계는 플레이어가 기다려도 움직인다.',
			'한 장면에 등록된 등장인물은 최대 한 명만 출연한다. focusCharacterId는 scene과 situation에 실제로 등장하는 유일한 등록 인물이다. null이면 등록 인물을 아무도 등장시키지 않는다.',
			'다른 등록 인물을 같은 장소에 부르거나, 대사·행동·연락을 추가하거나, 군중 장면으로 합류시키지 않는다. 변화를 만들기 위해 인물 수를 늘리지 않는다.',
			'최근 사건을 보고 내용 없는 상황만 반복하지 않는다. 인물을 추가하는 대신 시간의 흐름에 맞는 일정, 장소, 외부 사건의 변화를 만든다.',
			'스키마의 scene, situation, location, focusCharacterId, minutes, worldMemory, sceneNote에 세계 진행 결과만 넣는다.',
			'worldMemory에는 이전 요약에서 여전히 유효한 사실과 이번 세계 변화만 간결하게 남긴다. 아직 인물이 결정하지 않은 행동 결과는 넣지 않는다.',
			'sceneNote에는 세계 장면을 제시한 직후의 현재 위치, 함께 있는 인물, 자세나 거리, 진행 중인 행동과 미해결 의도를 1~3개의 사실 문장으로 쓴다. 분위기와 감상은 쓰지 않는다.',
			'인물이 지정된 행동이면 focusCharacterId는 그 인물로 한다. scene에는 인물의 행동, 대사, 결정이나 확정되지 않은 성적 접촉을 쓰지 않는다.'
		].join(' ');
	let previousViolation: string[] = [];
	for (let attempt = 0; attempt < singleCharacterAttempts; attempt += 1) {
		const result = await completion(
			system,
			{
				worldSetting: input.config.worldSetting,
				eraRules: input.config.eraRules,
				worldMemory: input.config.worldMemory,
				currentSceneNote: input.config.sceneNote,
				world: input.world,
				currentTime: timeContext(input.world),
				cast: input.characters.map((character) => ({
					id: character.id,
					name: character.name,
					age: character.age,
					profile: character.profile,
					trait: character.trait,
					relationToPlayer: character.relations.player,
					mark: character.mark
				})),
				recentResolvedTurns: recentTurnContext(input.recentEvents, 6),
				playerIntent: input.intent,
				targetCharacterId: input.targetId,
				singleCharacterCorrection: previousViolation.length
					? `이전 출력에 허용되지 않은 인물(${previousViolation.join(', ')})이 함께 등장했다. 한 명만 남겨 다시 작성한다.`
					: null
			},
			worldBeatOutput(input.characters.map((character) => character.id))
		);
		const scene = requiredText(result.scene, 'scene');
		const situation = requiredText(result.situation, 'situation');
		const location = requiredText(result.location, 'location');
		const focusCharacterId = input.targetId ?? (
			typeof result.focusCharacterId === 'string' && input.characters.some((character) => character.id === result.focusCharacterId)
				? result.focusCharacterId
				: null
		);
		const focusCharacterName = input.characters.find((character) => character.id === focusCharacterId)?.name;
		const forbiddenNames = input.characters
			.filter((character) => character.id !== focusCharacterId && character.name !== focusCharacterName)
			.map((character) => character.name);
		previousViolation = mentionedCharacterNames([scene, situation, result.sceneNote], forbiddenNames);
		if (previousViolation.length) continue;
		const minutes = Number(result.minutes);
		return {
			scene,
			situation,
			location,
			focusCharacterId,
			minutes: Number.isFinite(minutes) ? Math.max(5, Math.min(120, Math.round(minutes))) : 20,
			worldMemory: typeof result.worldMemory === 'string' ? result.worldMemory.trim() : input.config.worldMemory,
			sceneNote: requiredText(result.sceneNote, 'sceneNote')
		};
	}
	throw new Error('모델이 한 장면에 여러 등장인물을 함께 배치했습니다. 다시 시도해 주세요.');
}

export async function generateCharacterTurn(input: {
	character: Character;
	memories: MemoryRecord[];
	config: ScenarioConfig;
	beat: WorldBeat;
	intent: string | null;
	mode: CharacterTurnMode;
	availableActions: ActionId[];
	recentInteractions: EventRecord[];
	otherCharacterNames: string[];
}): Promise<CharacterTurn> {
	const system = [
			`당신은 era 텍스트 게임 등장인물 '${input.character.name}' 한 명만 맡는 독립 세션이다. 모든 등장인물은 성인이다.`,
			'인물 설정, 현재 스탯, 관계, 경험, 마크, 인물 자신의 기억에 따라 자율적으로 행동한다. 다른 인물이나 플레이어의 의사·대사를 대신 결정하지 않는다.',
			'현재 장면에 등록된 등장인물은 자신 한 명뿐이다. 다른 등록 인물을 등장시키거나 말하게 하거나 연락시키지 않으며, 함께 있는 것처럼 묘사하지 않는다.',
			'player-action이면 제안에 승낙 또는 거절할 수 있다. accept-proposal이면 자신이 직전 장면에서 먼저 제안한 행동을 플레이어가 수락한 것이다. decline-proposal이면 플레이어가 제안을 거절한 것이다.',
			'idle이면 availableActions에 포함된 행동만 필요에 따라 먼저 제안할 수 있다. 제안은 아직 실행된 사건이 아니다. 성인 행동도 제안과 실제 실행을 구분한다.',
			'최근 같은 행동을 반복했다면 이번에는 대화의 주제나 인물의 목적이 실제로 달라질 때만 다시 제안한다. 제안할 이유가 없으면 proposal은 null이다.',
			'previousSceneNote와 recentResolvedInteractions는 직전까지 실제로 확정된 상태와 장면이다. 이미 끝난 귀가, 만남, 이동, 착석, 접촉이나 대화를 처음부터 다시 쓰지 않는다. worldScene에서 명시적으로 바뀐 부분만 반영하고 나머지 물리 상태는 이어간다.',
			'한국어 텍스트 미연시 장면을 쓰되 짧고 구체적으로 쓴다. 장면마다 인물의 선택이나 대화 내용이 한 가지는 달라져야 한다. 평범한 대화와 호감 표현마다 큰 감정의 결론을 내리지 않는다.',
			'뺨이 붉어짐, 고개를 끄덕임, 다정한 눈빛, 마음이 편안해짐 같은 상투적인 반응과 감정 수식어를 반복하지 않는다. 같은 말을 되풀이하지 말고 인물의 실제 관심사와 현재 상황을 대사에 반영한다.',
			'스키마의 narrative에는 장면, accepted에는 행동의 수락 여부, proposal에는 제안, memory에는 이후 행동을 바꿀 사실, sceneNote에는 응답 직후의 현재 상태를 넣는다.',
			'memory는 장면 문장을 복사하거나 일반적인 감정 평가를 쓰지 않는다. 실제로 일어난 일만 3인칭 사실 문장으로 쓴다. 중요한 새 사실이 없으면 반드시 null을 반환한다.',
			'sceneNote에는 응답이 끝난 뒤의 정확한 위치, 플레이어와의 자세나 거리, 진행 중인 행동과 미해결 의도를 1~3개의 사실 문장으로 쓴다. 다음 턴이 그대로 이어질 수 있어야 하며 분위기와 감상은 쓰지 않는다.',
			'idle 외의 모드에서는 proposal을 null로 한다.'
		].join(' ');
	let previousViolation: string[] = [];
	for (let attempt = 0; attempt < singleCharacterAttempts; attempt += 1) {
		const result = await completion(
			system,
			{
				worldSetting: input.config.worldSetting,
				eraRules: input.config.eraRules,
				previousSceneNote: input.config.sceneNote,
				worldScene: input.beat.scene,
				worldSceneNote: input.beat.sceneNote,
				situation: input.beat.situation,
				location: input.beat.location,
				mode: input.mode,
				availableActions: input.availableActions,
				playerIntent: input.intent,
				character: input.character,
				forbiddenCharacterNames: input.otherCharacterNames,
				singleCharacterCorrection: previousViolation.length
					? `이전 출력에 다른 인물(${previousViolation.join(', ')})이 등장했다. 현재 인물과 플레이어만 남겨 다시 작성한다.`
					: null,
				personalMemories: input.memories.map((memory) => memory.summary),
				recentResolvedInteractions: recentTurnContext(input.recentInteractions, 5)
			},
			characterTurnOutput(input.mode, input.availableActions)
		);
		const narrative = requiredText(result.narrative, 'narrative');
		const rawProposalText = result.proposal && typeof result.proposal === 'object'
			? (result.proposal as Record<string, unknown>).text
			: null;
		previousViolation = mentionedCharacterNames([narrative, rawProposalText, result.memory, result.sceneNote], input.otherCharacterNames);
		if (previousViolation.length) continue;
		let proposal: CharacterTurn['proposal'] = null;
		if (input.mode === 'idle' && result.proposal && typeof result.proposal === 'object') {
			const candidate = result.proposal as Record<string, unknown>;
			if (
				typeof candidate.actionId === 'string' &&
				proposalActionIds.includes(candidate.actionId as Exclude<ActionId, 'rest'>) &&
				input.availableActions.includes(candidate.actionId as ActionId) &&
				typeof candidate.text === 'string' && candidate.text.trim()
			) {
				proposal = { actionId: candidate.actionId as Exclude<ActionId, 'rest'>, text: candidate.text.trim() };
			}
		}
		return {
			narrative,
			accepted: result.accepted === true,
			proposal,
			memory: typeof result.memory === 'string' && result.memory.trim() ? result.memory.trim() : null,
			sceneNote: requiredText(result.sceneNote, 'sceneNote')
		};
	}
	throw new Error('모델이 한 장면에 여러 등장인물을 함께 묘사했습니다. 다시 시도해 주세요.');
}
