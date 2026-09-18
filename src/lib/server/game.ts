import { randomUUID } from 'node:crypto';
import { ACTIONS, actionReason, applyEffects, calculateSource, eventSummary } from '$lib/game/actions';
import { DEFAULT_ABL, DEFAULT_EXP, DEFAULT_PALAM, DEFAULT_RELATION, DEFAULT_TALENT, type ActionId, type Character, type CharacterStatsInput, type EventRecord, type MemoryRecord, type Proposal, type Source, type WorldState } from '$lib/game/types';
import {
	getCharacter,
	getEffectiveScenarioConfig,
	getGameView,
	getMemories,
	insertEvent,
	insertMemory,
	searchMemoryIds,
	updateCharacter,
	updateMemoryEmbedding,
	updateScenarioConfig,
	updateWorld,
	withTransaction
} from './db';
import { embed, embeddingModel, generateCharacterTurn, generatePlayerSuggestions, generateWorldBeat, interpretPlayerAction } from './llm';

let tail: Promise<void> = Promise.resolve();

export async function runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
	const previous = tail;
	let release!: () => void;
	tail = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
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

async function runTurn(request: TurnRequest): Promise<EventRecord> {
	const view = getGameView();
	const { world, characters, config } = view;
	const llmConfig = getEffectiveScenarioConfig();
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
		targetId = interpreted.targetId;
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
			recentInteractions: view.events.filter((event) => event.characterId === sceneFocus.id).slice(0, 5),
			availableActions: (Object.keys(ACTIONS) as ActionId[]).filter((id) => id !== 'rest' && !actionReason(id, sceneFocus))
		})
		: null;
	const accepted = request.kind === 'accept' || actionId === 'rest' ||
		((request.kind === 'act' || request.kind === 'free') && (focus ? response?.accepted === true : request.kind === 'free'));
	const source: Source = actionId && accepted ? calculateSource(actionId, sceneFocus) : {};
	const effects = actionId && accepted
		? applyEffects(actionId, sceneFocus, source)
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
	const memorySummary = focus ? response?.memory ?? null : null;
	const committed = withTransaction(() => {
		updateWorld(nextWorld);
		if (sceneChanged) for (const character of characters) updateCharacter({ ...character, palam: { ...DEFAULT_PALAM } });
		if (effects.character && accepted && actionId !== 'rest') updateCharacter(effects.character);
		updateScenarioConfig({ ...config, worldMemory: beat.worldMemory, pendingProposal: proposal, playerSuggestions: null });
		const eventId = insertEvent(event);
		const memoryId = focus && memorySummary ? insertMemory(eventId, focus.id, memorySummary, nextWorld.turn) : null;
		return { eventId, memoryId };
	});
	if (committed.memoryId && memorySummary) {
		try {
			updateMemoryEmbedding(committed.memoryId, await embed(memorySummary), embeddingModel);
		} catch (error) {
			console.warn('기억 임베딩을 건너뜁니다:', error);
		}
	}
	return { id: committed.eventId, ...event };
}

export function advanceWorld(): Promise<EventRecord> {
	return runExclusive(() => runTurn({ kind: 'advance' }));
}

export function performAction(rawActionId: string, targetId: string): Promise<EventRecord> {
	if (!Object.hasOwn(ACTIONS, rawActionId)) throw new Error('알 수 없는 행동입니다.');
	return runExclusive(() => runTurn({ kind: 'act', actionId: rawActionId as ActionId, targetId }));
}

export function performFreeAction(text: string, targetId: string): Promise<EventRecord> {
	return runExclusive(() => runTurn({ kind: 'free', text, targetId }));
}

export function suggestPlayerActions(targetId: string): Promise<string[]> {
	return runExclusive(async () => {
		const view = getGameView();
		const character = targetId ? view.characters.find((candidate) => candidate.id === targetId) ?? null : null;
		if (targetId && !character) throw new Error('선택한 인물을 찾을 수 없습니다.');
		const availableActions = (Object.keys(ACTIONS) as ActionId[])
			.filter((id) => !actionReason(id, character))
			.map((id) => ({ id, title: ACTIONS[id].title }));
		const options = await generatePlayerSuggestions({
			world: view.world,
			config: getEffectiveScenarioConfig(),
			character,
			characters: view.characters,
			currentScene: view.latestNarrative,
			recentEvents: view.events,
			availableActions
		});
		updateScenarioConfig({
			...view.config,
			playerSuggestions: { turn: view.world.turn, targetId: character?.id ?? null, options }
		});
		return options;
	});
}

export function respondToProposal(answer: 'accept' | 'decline'): Promise<EventRecord> {
	return runExclusive(() => runTurn({ kind: answer }));
}

export function saveScenarioSettings(worldSetting: string, eraRules: string): Promise<void> {
	return runExclusive(() => {
		if (!worldSetting.trim() || !eraRules.trim()) throw new Error('세계관과 era 규칙을 모두 입력해 주세요.');
		const config = getGameView().config;
		updateScenarioConfig({
			...config,
			worldSetting: worldSetting.trim(),
			eraRules: eraRules.trim(),
			worldMemory: config.worldSetting === worldSetting.trim() ? config.worldMemory : '',
			pendingProposal: null,
			playerSuggestions: null
		});
	});
}

export function saveCharacterSettings(input: { id: string; name: string; age: number; profile: string; stats?: CharacterStatsInput; marks?: string[] }): Promise<string> {
	return runExclusive(() => {
		const name = input.name.trim();
		const profile = input.profile.trim();
		if (!name || !profile) throw new Error('인물 이름과 설정을 입력해 주세요.');
		if (!Number.isInteger(input.age) || input.age < 20) throw new Error('등장인물은 성인이어야 합니다.');
		const existing = input.id ? getCharacter(input.id) : null;
		if (input.id && !existing) throw new Error('인물을 찾을 수 없습니다.');
		const character: Character = existing ?? {
			id: randomUUID(), name, age: input.age, portrait: '', introduction: '', profile,
			base: { energy: 20, maxEnergy: 20 }, trait: [],
			talent: { ...DEFAULT_TALENT },
			abl: { ...DEFAULT_ABL },
			exp: { ...DEFAULT_EXP },
			mark: [], relations: { player: { ...DEFAULT_RELATION } },
			palam: { ...DEFAULT_PALAM }
		};
		const stats = input.stats ? {
			base: input.stats.base, talent: input.stats.talent ?? character.talent,
			abl: input.stats.abl, exp: input.stats.exp, palam: input.stats.palam,
			relations: { ...character.relations, player: input.stats.relation }
		} : character;
		if (stats.base.maxEnergy < 1 || stats.base.energy > stats.base.maxEnergy) {
			throw new Error('BASE 체력 값을 확인해 주세요.');
		}
		updateCharacter({ ...character, ...stats, mark: input.marks ?? character.mark, name, age: input.age, profile, introduction: profile.split('\n')[0] });
		const config = getGameView().config;
		if (config.playerSuggestions) updateScenarioConfig({ ...config, playerSuggestions: null });
		return character.id;
	});
}
