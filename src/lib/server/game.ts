import { randomUUID } from 'node:crypto';
import { ACTIONS, actionReason, applyEffects, applyPalamSource, calculateSource, eventSummary } from '$lib/game/actions';
import { DEFAULT_ABL, DEFAULT_ACTION_REQUIREMENTS, DEFAULT_EXP, DEFAULT_PALAM, DEFAULT_RELATION, DEFAULT_TALENT, normalizeNarrativeMode, type ActionId, type ActionRequirement, type Character, type CharacterStatsInput, type EventRecord, type GameView, type GenerationJob, type MemoryRecord, type NarrativeMode, type Proposal, type ScenarioConfig, type Source, type WorldState } from '$lib/game/types';
import {
	claimGenerationJob,
	completeGenerationJob,
	createGenerationJob,
	failGenerationJob,
	getCharacter,
	getCharacterTemplates,
	getEffectiveScenarioConfig,
	getGameView,
	getLatestGenerationJob,
	getMemories,
	getRecentCharacterEvents,
	getRunnableGenerationJobIds,
	insertEvent,
	insertMemory,
	searchMemoryIds,
	touchGenerationJob,
	updateCharacter,
	updateCharacterTemplate,
	updateMemoryEmbedding,
	updateScenarioConfig,
	updateWorld,
	withTransaction
} from './db';
import { embed, embeddingModel, generateCharacterTurn, generatePlayerSuggestions, generateWorldBeat, interpretPlayerAction } from './llm';

let turnTail: Promise<void> = Promise.resolve();
let gameplayEpoch = 0;
const suggestionJobs = new Map<string, Promise<string[]>>();
const scheduledGenerationJobs = new Set<string>();
const generationWorkerId = randomUUID();
const GENERATION_LEASE_MS = 15_000;
const GENERATION_HEARTBEAT_MS = 5_000;

async function runTurnExclusive<T>(operation: () => Promise<T>): Promise<T> {
	const previous = turnTail;
	let release!: () => void;
	turnTail = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

export function mutateGameState<T>(operation: () => T): T {
	const result = operation();
	gameplayEpoch += 1;
	return result;
}

export function advanceTime(world: WorldState, minutes: number, location: string): WorldState {
	const total = world.minute + minutes;
	return {
		turn: world.turn + 1,
		day: world.day + Math.floor(total / 1440),
		minute: total % 1440,
		location
	};
}

function cosine(left: number[], right: number[]): number {
	if (left.length !== right.length) return 0;
	let dot = 0;
	let leftLength = 0;
	let rightLength = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index] * right[index];
		leftLength += left[index] ** 2;
		rightLength += right[index] ** 2;
	}
	return leftLength && rightLength ? dot / Math.sqrt(leftLength * rightLength) : 0;
}

function relevantMemories(characterId: string, query: string, queryVector: number[] | null): MemoryRecord[] {
	const memories = getMemories(characterId, 100);
	if (!memories.length) return [];
	const lexicalIds = searchMemoryIds(characterId, query);
	const semanticIds = queryVector
		? memories
			.filter((memory) => memory.embedding && memory.embeddingModel === embeddingModel)
			.sort((left, right) => cosine(right.embedding!, queryVector) - cosine(left.embedding!, queryVector))
			.slice(0, 12)
			.map((memory) => memory.id)
		: [];
	const score = new Map<number, number>();
	for (const [rank, id] of lexicalIds.entries()) score.set(id, (score.get(id) ?? 0) + 1 / (rank + 2));
	for (const [rank, id] of semanticIds.entries()) score.set(id, (score.get(id) ?? 0) + 1 / (rank + 2));
	for (const [rank, memory] of memories.slice(0, 3).entries()) {
		score.set(memory.id, (score.get(memory.id) ?? 0) + 0.15 / (rank + 1));
	}
	const seen = new Set<string>();
	return memories
		.sort((left, right) => (score.get(right.id) ?? 0) - (score.get(left.id) ?? 0))
		.filter((memory) => {
			if (seen.has(memory.summary)) return false;
			seen.add(memory.summary);
			return true;
		})
		.slice(0, 5);
}

async function memoryContext(character: Character, query: string): Promise<MemoryRecord[]> {
	let vector: number[] | null = null;
	try {
		vector = await embed(query);
	} catch (error) {
		console.warn('기억 검색용 임베딩을 건너뜁니다:', error);
	}
	return relevantMemories(character.id, query, vector);
}

type TurnRequest =
	| { kind: 'advance' }
	| { kind: 'act'; actionId: ActionId; targetId: string }
	| { kind: 'free'; text: string; targetId: string }
	| { kind: 'accept' | 'decline' };

type QueuedTurn = {
	request: TurnRequest;
	stateKey: string;
};

function checkedQueuedTurn(value: unknown): QueuedTurn {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('저장된 생성 요청이 올바르지 않습니다.');
	const payload = value as Record<string, unknown>;
	if (typeof payload.stateKey !== 'string' || !payload.request || typeof payload.request !== 'object' || Array.isArray(payload.request)) {
		throw new Error('저장된 생성 요청이 올바르지 않습니다.');
	}
	const request = payload.request as Record<string, unknown>;
	if (request.kind === 'advance' || request.kind === 'accept' || request.kind === 'decline') {
		return { stateKey: payload.stateKey, request: { kind: request.kind } };
	}
	if (request.kind === 'act' && typeof request.actionId === 'string' && Object.hasOwn(ACTIONS, request.actionId) && typeof request.targetId === 'string') {
		return { stateKey: payload.stateKey, request: { kind: 'act', actionId: request.actionId as ActionId, targetId: request.targetId } };
	}
	if (request.kind === 'free' && typeof request.text === 'string' && typeof request.targetId === 'string') {
		return { stateKey: payload.stateKey, request: { kind: 'free', text: request.text, targetId: request.targetId } };
	}
	throw new Error('저장된 생성 요청이 올바르지 않습니다.');
}

function combineSources(...sources: Source[]): Source {
	const combined: Source = {};
	for (const source of sources) {
		for (const [key, value] of Object.entries(source) as Array<[keyof Source, number | undefined]>) {
			if (typeof value !== 'number' || value === 0) continue;
			combined[key] = (combined[key] ?? 0) + value;
		}
	}
	return combined;
}

function gameStateKey(view: GameView, effectiveConfig: ScenarioConfig): string {
	return JSON.stringify({
		loreId: view.lore.id,
		world: view.world,
		config: {
			worldSetting: view.config.worldSetting,
			eraRules: view.config.eraRules,
			worldMemory: view.config.worldMemory,
			sceneNote: view.config.sceneNote,
			pendingProposal: view.config.pendingProposal
		},
		effectiveWorldSetting: effectiveConfig.worldSetting,
		effectiveEraRules: effectiveConfig.eraRules,
		characters: view.characters,
		latestEventId: view.events[0]?.id ?? null
	});
}

function currentGameStateKey(): string {
	return gameStateKey(getGameView(), getEffectiveScenarioConfig());
}

function assertGameStateCurrent(epoch: number, stateKey: string): void {
	if (gameplayEpoch !== epoch || currentGameStateKey() !== stateKey) {
		throw new Error('생성 중 게임 상태가 변경되어 이전 결과를 폐기했습니다. 다시 시도해 주세요.');
	}
}

async function runTurn(
	request: TurnRequest,
	execution?: { jobId: string; workerId: string }
): Promise<EventRecord> {
	const view = getGameView();
	const { world, characters, config } = view;
	const llmConfig = getEffectiveScenarioConfig();
	const startingEpoch = gameplayEpoch;
	const startingStateKey = gameStateKey(view, llmConfig);
	let actionId: ActionId | null = null;
	let targetId: string | null = null;
	let intent: string | null = null;
	if (request.kind === 'free') {
		intent = request.text.trim();
		if (!intent) throw new Error('행동을 입력해 주세요.');
		if (request.targetId && !characters.some((character) => character.id === request.targetId)) {
			throw new Error('선택한 인물을 찾을 수 없습니다.');
		}
		const interpreted = await interpretPlayerAction({
			text: intent,
			selectedTargetId: request.targetId || null,
			characters
		});
		actionId = interpreted.actionId;
		// The selected UI target is authoritative when the interpreter recognizes a
		// targeted command but omits its target. Small local models occasionally
		// return this otherwise contradictory pair (for example, talk + null).
		targetId = interpreted.targetId ?? (
			actionId && ACTIONS[actionId].needsTarget ? request.targetId || null : null
		);
		assertGameStateCurrent(startingEpoch, startingStateKey);
		if (actionId) {
			const reason = actionReason(actionId, targetId ? getCharacter(targetId) : null);
			if (reason) throw new Error(reason);
		}
	}
	if (request.kind === 'act') {
		actionId = request.actionId;
		targetId = ACTIONS[actionId].needsTarget ? request.targetId : null;
		const reason = actionReason(actionId, targetId ? getCharacter(targetId) : null);
		if (reason) throw new Error(reason);
		intent = ACTIONS[actionId].title;
	} else if (request.kind === 'accept' || request.kind === 'decline') {
		if (!config.pendingProposal) throw new Error('응답할 제안이 없습니다.');
		targetId = config.pendingProposal.characterId;
		intent = `${config.pendingProposal.text} — 플레이어가 ${request.kind === 'accept' ? '수락' : '거절'}함`;
		if (request.kind === 'accept') {
			actionId = config.pendingProposal.actionId;
			const reason = actionReason(actionId, getCharacter(targetId));
			if (reason) throw new Error(reason);
		}
	}

	const beat = await generateWorldBeat({ world, config: llmConfig, characters, recentEvents: view.events, intent, targetId });
	assertGameStateCurrent(startingEpoch, startingStateKey);
	// An idle world beat, rest, a long gap or a move begins a fresh scene.
	const sceneChanged = beat.location !== world.location || request.kind === 'advance' || actionId === 'rest'
		|| beat.minutes >= 60 || world.minute + beat.minutes >= 1440;
	const focus = beat.focusCharacterId ? characters.find((character) => character.id === beat.focusCharacterId) ?? null : null;
	const sceneFocus = focus && sceneChanged ? { ...focus, palam: { ...DEFAULT_PALAM } } : focus;
	const mode = request.kind === 'advance' || ((request.kind === 'act' || request.kind === 'free') && actionId === 'rest')
		? 'idle' as const
		: request.kind === 'accept' ? 'accept-proposal' as const
		: request.kind === 'decline' ? 'decline-proposal' as const
		: 'player-action' as const;
	const response = sceneFocus
		? await generateCharacterTurn({
			character: sceneFocus,
			memories: await memoryContext(sceneFocus, `${beat.situation} ${intent ?? ''}`),
			config: llmConfig,
			beat,
			intent,
			mode,
			recentInteractions: getRecentCharacterEvents(sceneFocus.id, 5),
			availableActions: (Object.keys(ACTIONS) as ActionId[]).filter((id) => id !== 'rest' && !actionReason(id, sceneFocus)),
			otherCharacterNames: characters
				.filter((character) => character.id !== sceneFocus.id && character.name !== sceneFocus.name)
				.map((character) => character.name)
		})
		: null;
	const accepted = request.kind === 'accept' || actionId === 'rest' ||
		((request.kind === 'act' || request.kind === 'free') && (focus ? response?.accepted === true : request.kind === 'free'));
	const actionSource: Source = actionId && accepted ? calculateSource(actionId, sceneFocus) : {};
	const reactionSource: Source = response?.palamDelta ?? {};
	const source = combineSources(actionSource, reactionSource);
	const effects = actionId && accepted && actionId !== 'rest'
		? applyEffects(actionId, sceneFocus, source)
		: sceneFocus && response
			? applyPalamSource(sceneFocus, reactionSource)
			: { character: sceneFocus, changes: {} as Record<string, number> };
	const minutes = actionId && accepted ? Math.max(ACTIONS[actionId].duration, beat.minutes) : beat.minutes;
	const nextWorld = advanceTime(world, minutes, beat.location);
	let proposal: Proposal | null = null;
	if (mode === 'idle' && focus && response?.proposal && !actionReason(response.proposal.actionId, effects.character)) {
		proposal = { characterId: focus.id, ...response.proposal };
	}
	const summary = request.kind === 'free' && intent
		? `플레이어 시도: ${intent}${focus ? ` — ${focus.name} ${accepted ? '응함' : '거절함'}` : ''}`
		: actionId && accepted
		? request.kind === 'accept' && focus && config.pendingProposal
			? `${focus.name}의 제안을 플레이어가 받아들였다. ${eventSummary(actionId, focus)}`
			: eventSummary(actionId, focus)
		: request.kind === 'decline' && focus
			? `플레이어가 ${focus.name}의 제안을 거절했다.`
			: request.kind === 'act' && focus
				? `${focus.name}이 플레이어의 ${ACTIONS[request.actionId].title} 제안을 거절했다.`
				: beat.situation;
	const narrative = [beat.scene, response?.narrative].filter(Boolean).join('\n\n');
	const event: Omit<EventRecord, 'id'> = {
		turn: nextWorld.turn,
		day: nextWorld.day,
		minute: nextWorld.minute,
		location: nextWorld.location,
		actionId: request.kind === 'decline' ? 'decline' : request.kind === 'free' ? actionId ?? 'custom' : actionId ?? 'advance',
		characterId: focus?.id ?? null,
		summary,
		source,
		changes: effects.changes,
		narrative,
		renderer: 'llm'
	};
	const memorySummary = focus
		? response?.memory ?? (accepted && (actionId === 'kiss' || actionId === 'intimacy') ? summary : null)
		: null;
	const committed = withTransaction(() => {
		assertGameStateCurrent(startingEpoch, startingStateKey);
		updateWorld(nextWorld);
		if (sceneChanged) for (const character of characters) updateCharacter({ ...character, palam: { ...DEFAULT_PALAM } });
		if (effects.character && response) updateCharacter(effects.character);
		updateScenarioConfig({
			...config,
			worldMemory: beat.worldMemory,
			sceneNote: response?.sceneNote ?? beat.sceneNote,
			pendingProposal: proposal,
			playerSuggestions: null
		});
		const eventId = insertEvent(event);
		const memoryId = focus && memorySummary ? insertMemory(eventId, focus.id, memorySummary, nextWorld.turn) : null;
		if (execution) completeGenerationJob(execution.jobId, execution.workerId, eventId);
		gameplayEpoch += 1;
		return { eventId, memoryId };
	});
	if (committed.memoryId && memorySummary) {
		void embed(memorySummary)
			.then((embedding) => updateMemoryEmbedding(committed.memoryId!, embedding, embeddingModel))
			.catch((error) => console.warn('기억 임베딩을 건너뜁니다:', error));
	}
	return { id: committed.eventId, ...event };
}

function validateQueuedRequest(request: TurnRequest, view: GameView): void {
	if (request.kind === 'free') {
		if (!request.text.trim()) throw new Error('행동을 입력해 주세요.');
		if (request.targetId && !view.characters.some((character) => character.id === request.targetId)) {
			throw new Error('선택한 인물을 찾을 수 없습니다.');
		}
		return;
	}
	if (request.kind === 'act') {
		const target = request.targetId ? view.characters.find((character) => character.id === request.targetId) ?? null : null;
		const reason = actionReason(request.actionId, target);
		if (reason) throw new Error(reason);
		return;
	}
	if (request.kind === 'accept' || request.kind === 'decline') {
		if (!view.config.pendingProposal) throw new Error('응답할 제안이 없습니다.');
		if (request.kind === 'accept') {
			const target = view.characters.find((character) => character.id === view.config.pendingProposal?.characterId) ?? null;
			const reason = actionReason(view.config.pendingProposal.actionId, target);
			if (reason) throw new Error(reason);
		}
	}
}

function enqueueTurn(request: TurnRequest): GenerationJob {
	const view = getGameView();
	validateQueuedRequest(request, view);
	const job = createGenerationJob(view.lore.id, request.kind, {
		request,
		stateKey: gameStateKey(view, getEffectiveScenarioConfig())
	});
	scheduleGenerationJob(job.id);
	return job;
}

async function processGenerationJob(id: string): Promise<void> {
	await runTurnExclusive(async () => {
		const staleBefore = new Date(Date.now() - GENERATION_LEASE_MS).toISOString();
		const claimed = claimGenerationJob(id, generationWorkerId, staleBefore);
		if (!claimed) return;
		const heartbeat = setInterval(() => {
			try {
				touchGenerationJob(id, generationWorkerId);
			} catch (error) {
				console.warn('생성 작업 상태 갱신에 실패했습니다:', error);
			}
		}, GENERATION_HEARTBEAT_MS);
		try {
			const queued = checkedQueuedTurn(claimed.request);
			if (claimed.job.loreId !== getGameView().lore.id || queued.stateKey !== currentGameStateKey()) {
				throw new Error('게임 상태가 변경되어 대기 중이던 생성을 취소했습니다.');
			}
			await runTurn(queued.request, { jobId: id, workerId: generationWorkerId });
		} catch (error) {
			failGenerationJob(id, generationWorkerId, error instanceof Error ? error.message : '장면 생성에 실패했습니다.');
		} finally {
			clearInterval(heartbeat);
		}
	});
}

function scheduleGenerationJob(id: string): void {
	if (scheduledGenerationJobs.has(id)) return;
	scheduledGenerationJobs.add(id);
	setTimeout(() => {
		void processGenerationJob(id)
			.catch((error) => console.error('생성 작업 실행에 실패했습니다:', error))
			.finally(() => scheduledGenerationJobs.delete(id));
	}, 0);
}

export function ensureGenerationWorker(): void {
	const staleBefore = new Date(Date.now() - GENERATION_LEASE_MS).toISOString();
	for (const id of getRunnableGenerationJobIds(staleBefore)) scheduleGenerationJob(id);
}

export function queueAdvanceWorld(): GenerationJob {
	return enqueueTurn({ kind: 'advance' });
}

export function queueAction(rawActionId: string, targetId: string): GenerationJob {
	if (!Object.hasOwn(ACTIONS, rawActionId)) throw new Error('알 수 없는 행동입니다.');
	return enqueueTurn({ kind: 'act', actionId: rawActionId as ActionId, targetId });
}

export function queueFreeAction(text: string, targetId: string): GenerationJob {
	return enqueueTurn({ kind: 'free', text, targetId });
}

export function ensurePlayerSuggestions(targetId: string): Promise<string[]> {
	const view = getGameView();
	const generation = getLatestGenerationJob(view.lore.id);
	if (generation?.status === 'pending' || generation?.status === 'running') return Promise.resolve([]);
	const character = targetId ? view.characters.find((candidate) => candidate.id === targetId) ?? null : null;
	if (targetId && !character) return Promise.reject(new Error('선택한 인물을 찾을 수 없습니다.'));
	if (view.config.pendingProposal) return Promise.resolve([]);
	if (view.config.playerSuggestions?.turn === view.world.turn &&
		view.config.playerSuggestions.targetId === (character?.id ?? null) &&
		view.config.playerSuggestions.options.length >= 2) {
		return Promise.resolve(view.config.playerSuggestions.options);
	}
	const effectiveConfig = getEffectiveScenarioConfig();
	const startingEpoch = gameplayEpoch;
	const startingStateKey = gameStateKey(view, effectiveConfig);
	const jobKey = `${startingEpoch}:${startingStateKey}:${character?.id ?? ''}`;
	const existing = suggestionJobs.get(jobKey);
	if (existing) return existing;
	const job = (async () => {
		const availableActions = (Object.keys(ACTIONS) as ActionId[])
			.filter((id) => !actionReason(id, character))
			.map((id) => ({ id, title: ACTIONS[id].title }));
		const options = await generatePlayerSuggestions({
			world: view.world,
			config: effectiveConfig,
			character,
			characters: view.characters,
			currentScene: view.latestNarrative,
			recentEvents: view.events,
			availableActions
		});
		return gameplayEpoch === startingEpoch && currentGameStateKey() === startingStateKey ? options : [];
	})().finally(() => suggestionJobs.delete(jobKey));
	suggestionJobs.set(jobKey, job);
	return job;
}

export function queueProposalResponse(answer: 'accept' | 'decline'): GenerationJob {
	return enqueueTurn({ kind: answer });
}

export function saveScenarioSettings(worldSetting: string, eraRules: string, narrativeMode: NarrativeMode): void {
	mutateGameState(() => withTransaction(() => {
		if (!worldSetting.trim() || !eraRules.trim()) throw new Error('세계관과 era 규칙을 모두 입력해 주세요.');
		const config = getGameView().config;
		updateScenarioConfig({
			...config,
			worldSetting: worldSetting.trim(),
			eraRules: eraRules.trim(),
			narrativeMode: normalizeNarrativeMode(narrativeMode),
			worldMemory: config.worldSetting === worldSetting.trim() ? config.worldMemory : '',
			sceneNote: config.worldSetting === worldSetting.trim() && config.eraRules === eraRules.trim() ? config.sceneNote : '',
			pendingProposal: null,
			playerSuggestions: null
		});
	}));
}

export function saveCharacterSettings(input: { id: string; name: string; age: number; profile: string; stats?: CharacterStatsInput; marks?: string[]; actionRequirements?: ActionRequirement[] }): string {
	return mutateGameState(() => withTransaction(() => {
		const name = input.name.trim();
		const profile = input.profile.trim();
		if (!name || !profile) throw new Error('인물 이름과 설정을 입력해 주세요.');
		if (!Number.isSafeInteger(input.age)) throw new Error('등장인물의 나이는 정수여야 합니다.');
		const existingTemplate = input.id ? getCharacterTemplates().find((character) => character.id === input.id) ?? null : null;
		if (input.id && !existingTemplate) throw new Error('인물을 찾을 수 없습니다.');
		const character: Character = existingTemplate ?? {
			id: randomUUID(), name, age: input.age, portrait: '', introduction: '', profile,
			base: { energy: 20, maxEnergy: 20 }, trait: [],
			talent: { ...DEFAULT_TALENT },
			abl: { ...DEFAULT_ABL },
			exp: { ...DEFAULT_EXP },
			mark: [], relations: { player: { ...DEFAULT_RELATION } },
			palam: { ...DEFAULT_PALAM },
			actionRequirements: DEFAULT_ACTION_REQUIREMENTS.map((requirement) => ({ ...requirement }))
		};
		const stats = input.stats ? {
			base: input.stats.base, talent: input.stats.talent ?? character.talent,
			abl: input.stats.abl, exp: input.stats.exp, palam: input.stats.palam,
			relations: { ...character.relations, player: input.stats.relation }
		} : character;
		if (stats.base.maxEnergy < 1 || stats.base.energy > stats.base.maxEnergy) {
			throw new Error('BASE 체력 값을 확인해 주세요.');
		}
		const template = {
			...character, ...stats,
			mark: input.marks ?? character.mark,
			actionRequirements: input.actionRequirements ?? character.actionRequirements,
			name, age: input.age, profile, introduction: profile.split('\n')[0]
		};
		updateCharacterTemplate(template);
		const session = existingTemplate ? getCharacter(character.id) : null;
		if (!session) updateCharacter(template);
		else updateCharacter({
			...session,
			name: template.name, age: template.age, portrait: template.portrait,
			introduction: template.introduction, profile: template.profile, trait: [...template.trait],
			actionRequirements: template.actionRequirements.map((requirement) => ({ ...requirement }))
		});
		const config = getGameView().config;
		if (config.playerSuggestions) updateScenarioConfig({ ...config, playerSuggestions: null });
		return character.id;
	}));
}
