import { createSimulation, resolveAction, selectActiveCharacter } from '$lib/game/simulation';
import { renderSemanticEvent } from '$lib/game/simulation-renderer';
import type { Character, CharacterStatsInput, EventRecord } from '$lib/game/types';
import { getGameView, insertEvent, updateCharacter, updatePlayer, updateScenarioConfig, updateWorld, withTransaction } from './db';
import { advanceTime, runExclusive } from './game';

export function performConversation(targetId: string): Promise<EventRecord> {
	return runExclusive(() => {
		const view = getGameView();
		const initial = selectActiveCharacter(createSimulation(view.player, view.characters, view.world.location), targetId);
		const result = resolveAction(initial, 'conversation');
		const target = result.state.characters.find((character) => character.id === targetId)!;
		const nextWorld = advanceTime(view.world, 20, view.world.location);
		const narrative = renderSemanticEvent(result.event);
		const event: Omit<EventRecord, 'id'> = {
			turn: nextWorld.turn, day: nextWorld.day, minute: nextWorld.minute, location: nextWorld.location,
			actionId: 'conversation', characterId: targetId,
			summary: `플레이어가 ${target.name}에게 말을 걸고 대화했다.`,
			source: result.source,
			changes: Object.fromEntries(result.changes.filter((change) => typeof change.before === 'number' && typeof change.after === 'number')
				.map((change) => [change.path, (change.after as number) - (change.before as number)])),
			narrative, renderer: 'template', semanticEvent: result.event, stateChanges: result.changes
		};
		const id = withTransaction(() => {
			updateWorld(nextWorld);
			updatePlayer(result.state.player);
			updateCharacter(target);
			updateScenarioConfig({ ...view.config, pendingProposal: null, playerSuggestions: null });
			return insertEvent(event);
		});
		return { id, ...event };
	});
}

export function editSimulationCharacter(input: {
	id: string;
	stats: CharacterStatsInput;
	playerEnergy: number;
	marks?: string[];
}): Promise<void> {
	return runExclusive(() => {
		const view = getGameView();
		const character = view.characters.find((candidate) => candidate.id === input.id);
		if (!character) throw new Error('인물을 찾을 수 없습니다.');
		if (input.stats.base.maxEnergy < 1 || input.stats.base.energy > input.stats.base.maxEnergy) throw new Error('BASE 체력 값을 확인해 주세요.');
		if (!Number.isSafeInteger(input.playerEnergy) || input.playerEnergy < 0 || input.playerEnergy > view.player.maxEnergy) {
			throw new Error('플레이어 체력 값을 확인해 주세요.');
		}
		withTransaction(() => {
			updateCharacter({ ...character,
				base: input.stats.base, talent: input.stats.talent ?? character.talent,
				abl: input.stats.abl, exp: input.stats.exp, palam: input.stats.palam,
				relations: { ...character.relations, player: input.stats.relation },
				mark: input.marks ?? character.mark
			});
			updatePlayer({ ...view.player, energy: input.playerEnergy });
			updateScenarioConfig({ ...view.config, pendingProposal: null, playerSuggestions: null });
		});
	});
}
