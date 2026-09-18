import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionUnavailableReason, attachRenderedText, createSimulation, resolveAction } from '../src/lib/game/simulation.ts';
import { renderSemanticEvent } from '../src/lib/game/simulation-renderer.ts';

function initialState(energy = 20) {
	return createSimulation({ energy, maxEnergy: 20 }, [{
		id: 'character-1', name: '서연', age: 27, portrait: '', introduction: '', profile: '',
		base: { energy: 20, maxEnergy: 20 }, trait: [],
		talent: { pride: 40, openness: 80, empathy: 75, assertiveness: 50 },
		abl: { conversation: 2, empathy: 3, seduction: 1 },
		exp: { conversation: 0, empathy: 0, seduction: 0 },
		mark: [], relation: { affection: 0, trust: 0, desire: 0 },
		palam: { rapport: 0, trust: 0, arousal: 0, pleasure: 0 }
	}], 'room');
}

test('energy precondition rejects conversation without changing state', () => {
	const state = initialState(1);
	assert.equal(actionUnavailableReason(state, 'conversation'), '기력이 부족합니다.');
	assert.throws(() => resolveAction(state, 'conversation'), /기력이 부족/);
	assert.equal(state.player.energy, 1);
	assert.equal(state.eventLog.length, 0);
});

test('same state and action produce identical result and leave input untouched', () => {
	const state = initialState();
	const snapshot = structuredClone(state);
	assert.deepEqual(resolveAction(state, 'conversation'), resolveAction(state, 'conversation'));
	assert.deepEqual(state, snapshot);
});

test('conversation applies SOURCE to player BASE and target PALAM, EXP and RELATION', () => {
	const result = resolveAction(initialState(), 'conversation');
	const target = result.state.characters[0];
	assert.equal(result.source.energy, -2);
	assert.equal(result.state.player.energy, 18);
	assert.equal(target.palam.rapport, result.source.rapport);
	assert.equal(target.palam.trust, result.source.trust);
	assert.equal(target.exp.conversation, 1);
	assert.equal(target.relation.trust, 1);
	assert.ok(target.mark.includes('firstConversation'));
	assert.deepEqual(result.changes.find((change) => change.path === '서연.EXP.conversation'), { path: '서연.EXP.conversation', before: 0, after: 1 });
	assert.equal(result.state.eventLog[0].id, 1);
});

test('semantic event and renderer are deterministic and rendering does not alter game state', () => {
	const result = resolveAction(initialState(), 'conversation');
	assert.deepEqual(result.event, {
		type: 'conversation', actorId: 'player', targetId: 'character-1', outcome: 'positive',
		effects: result.source, acquiredMarks: ['firstConversation']
	});
	const beforeRender = structuredClone(result.state);
	const text = renderSemanticEvent(result.event);
	assert.equal(text, '대화가 제법 잘 통했다.');
	assert.deepEqual(result.state, beforeRender);
	const rendered = attachRenderedText(result.state, text);
	assert.equal(rendered.eventLog[0].renderedText, text);
	assert.deepEqual(rendered.player, result.state.player);
	assert.deepEqual(rendered.characters, result.state.characters);
	assert.equal(result.state.eventLog[0].renderedText, null);
});

test('new SOURCE replaces previous action effect and high pride reduces rapport', () => {
	const state = initialState();
	const first = resolveAction(state, 'conversation');
	const second = resolveAction(first.state, 'conversation');
	assert.equal(second.source.energy, -2);
	assert.equal(second.state.eventLog.length, 2);
	assert.equal(second.state.eventLog[1].id, 2);
	const proud = initialState();
	proud.characters[0].talent.pride = 90;
	proud.characters[0].talent.openness = 10;
	assert.ok(resolveAction(proud, 'conversation').source.rapport < first.source.rapport);
});
