import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionUnavailableReason, attachRenderedText, createSimulation, resolveAction } from '../src/lib/game/simulation.ts';
import { renderSemanticEvent } from '../src/lib/game/simulation-renderer.ts';
import { actionReason, applyEffects, applyPalamSource, calculateSource } from '../src/lib/game/actions.ts';
import { DEFAULT_TALENT, DEFAULT_ACTION_REQUIREMENTS, DEFAULT_ABL, DEFAULT_EXP, DEFAULT_RELATION, DEFAULT_PALAM,
	clampBase, normalizeTalent, normalizeExp, normalizeMarks, normalizeRelations, normalizePalam } from '../src/lib/game/types.ts';

function initialState() {
	return createSimulation([{
		id: 'character-1', name: '서연', age: 27, portrait: '', introduction: '', profile: '',
		base: { energy: 20, maxEnergy: 20 }, trait: [],
		talent: { ...DEFAULT_TALENT, pride: 40, openness: 80 },
		abl: { ...DEFAULT_ABL, conversation: 2, empathy: 3 },
		exp: { ...DEFAULT_EXP }, mark: [],
		relations: { player: { ...DEFAULT_RELATION } }, palam: { ...DEFAULT_PALAM },
		actionRequirements: DEFAULT_ACTION_REQUIREMENTS.map((requirement) => ({ ...requirement }))
	}], 'room');
}

test('conversation has no player stamina requirement', () => {
	const state = initialState();
	assert.equal(actionUnavailableReason(state, 'conversation'), null);
	const result = resolveAction(state, 'conversation');
	assert.ok(!('player' in result.state));
	assert.ok(!('energy' in result.source));
	assert.ok(result.changes.every((change) => change.path !== 'player.BASE.energy'));
	assert.equal(state.eventLog.length, 0);
});

test('each character owns editable numeric action requirements without a fixed kiss mark', () => {
	const character = initialState().characters[0];
	assert.equal(actionReason('flirt', character), '신뢰 2 필요');
	character.actionRequirements = [];
	character.age = 19;
	assert.equal(actionReason('intimacy', character), null);
	assert.ok(!character.mark.includes('firstKiss'));
	character.actionRequirements = [
		{ actionId: 'kiss', stat: 'talent.openness', minimum: 90 },
		{ actionId: 'kiss', stat: 'relation.desire', minimum: 10 }
	];
	assert.equal(actionReason('kiss', character), 'TALENT 개방성 90 · 욕망 10 필요');
	character.talent.openness = 90;
	character.relations.player.desire = 10;
	assert.equal(actionReason('kiss', character), null);
});

test('same state and action produce identical result and leave input untouched', () => {
	const state = initialState();
	const snapshot = structuredClone(state);
	assert.deepEqual(resolveAction(state, 'conversation'), resolveAction(state, 'conversation'));
	assert.deepEqual(state, snapshot);
});

test('conversation applies transient SOURCE to PALAM, EXP and directed RELATION', () => {
	const result = resolveAction(initialState(), 'conversation');
	const target = result.state.characters[0];
	assert.deepEqual(target.base, { energy: 20, maxEnergy: 20 });
	assert.equal(target.palam.rapport, result.source.rapport);
	assert.equal(target.palam.comfort, result.source.comfort);
	assert.equal(target.exp.social, 1);
	assert.equal(target.relations.player.trust, 1);
	assert.equal(target.relations.player.affection, 1);
	assert.ok(target.mark.includes('firstConversation'));
	assert.deepEqual(result.changes.find((change) => change.path === '서연.EXP.social'), { path: '서연.EXP.social', before: 0, after: 1 });
	assert.equal(result.state.eventLog[0].id, 1);
});

test('semantic event renderer does not alter game state', () => {
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
	assert.deepEqual(rendered.characters, result.state.characters);
	assert.equal(result.state.eventLog[0].renderedText, null);
});

test('SOURCE is recalculated per action and pride affects rapport through trust', () => {
	const state = initialState();
	const first = resolveAction(state, 'conversation');
	const second = resolveAction(first.state, 'conversation');
	assert.ok(!('energy' in second.source));
	assert.equal(second.state.eventLog.length, 2);
	assert.equal(second.state.eventLog[1].id, 2);
	const proud = initialState();
	proud.characters[0].talent.pride = 90;
	proud.characters[0].talent.openness = 10;
	assert.ok(resolveAction(proud, 'conversation').source.rapport < first.source.rapport);
	proud.characters[0].relations.player.trust = 50;
	assert.ok(resolveAction(proud, 'conversation').source.rapport > resolveAction(initialStateWithPride(), 'conversation').source.rapport);
});

function initialStateWithPride() {
	const state = initialState();
	state.characters[0].talent.pride = 90;
	state.characters[0].talent.openness = 10;
	return state;
}

test('talent and bounded states clamp independently', () => {
	const talent = normalizeTalent({ libido: 120, modesty: 90, assertiveness: 90, receptiveness: 20, openness: -5 });
	assert.equal(talent.libido, 100);
	assert.equal(talent.modesty, 90);
	assert.equal(talent.openness, 0);
	assert.equal(talent.assertiveness, 90);
	assert.equal(talent.receptiveness, 20);
	assert.deepEqual(clampBase({ energy: 30, maxEnergy: 20 }), { energy: 20, maxEnergy: 20 });
	const state = initialState();
	state.characters[0].palam.rapport = 99;
	assert.equal(resolveAction(state, 'conversation').state.characters[0].palam.rapport, 100);
});

test('libido, directed desire, arousal and pleasure retain distinct values', () => {
	const state = initialState();
	const target = state.characters[0];
	target.talent.libido = 90;
	target.relations.player.desire = 75;
	target.palam.arousal = 3;
	target.palam.pleasure = 2;
	const result = resolveAction(state, 'conversation').state.characters[0];
	assert.equal(result.talent.libido, 90);
	assert.equal(result.relations.player.desire, 75);
	assert.equal(result.palam.arousal, 3);
	assert.equal(result.palam.pleasure, 2);
});

test('affection and resentment, comfort and tension can coexist', () => {
	const relations = normalizeRelations({ player: { affection: 80, trust: 20, desire: 90, resentment: 55 } });
	const palam = normalizePalam({ comfort: 90, tension: 80 });
	assert.equal(relations.player.affection, 80);
	assert.equal(relations.player.resentment, 55);
	assert.equal(palam.comfort, 90);
	assert.equal(palam.tension, 80);
});

test('legacy milestone marks retain meaning and custom marks remain extensible', () => {
	assert.deepEqual(normalizeMarks(['서로 원한 입맞춤', '서로 동의한 밤', '나만의 사건', 'firstKiss']),
		['firstKiss', 'firstIntimacy', '나만의 사건']);
});

test('ABL and EXP remain independent; conversation responds to ability, openness and current tension', () => {
	const state = initialState();
	state.characters[0].abl.conversation = 8;
	state.characters[0].exp.social = 3;
	const resolved = resolveAction(state, 'conversation');
	assert.equal(resolved.state.characters[0].abl.conversation, 8);
	assert.equal(resolved.state.characters[0].exp.social, 4);
	const low = initialState();
	low.characters[0].abl.conversation = 1;
	low.characters[0].talent.openness = 10;
	low.characters[0].palam.tension = 80;
	assert.ok(resolved.source.rapport > resolveAction(low, 'conversation').source.rapport);
	assert.deepEqual(normalizeExp({ conversation: 4, empathy: 3, seduction: 2 }), { social: 7, romantic: 0, seduction: 2, intimacy: 0 });
});

test('main game action resolves SOURCE before state update without automatic ability growth', () => {
	const character = initialState().characters[0];
	character.exp.social = 29;
	const source = calculateSource('talk', character);
	assert.ok(!('energy' in source));
	const result = applyEffects('talk', character, source);
	assert.equal(result.character.abl.conversation, character.abl.conversation);
	assert.equal(result.character.exp.social, 32);
	assert.equal(result.character.palam.comfort, source.comfort);
	assert.equal(result.character.relations.player.trust, 1);
	const rest = applyEffects('rest', null, calculateSource('rest', null));
	assert.deepEqual(rest, { character: null, changes: {} });
});

test('all current-scene PALAM fields accept signed reaction deltas', () => {
	const character = initialState().characters[0];
	character.palam = { rapport: 5, comfort: 5, arousal: 5, pleasure: 5, embarrassment: 5, tension: 5, frustration: 5, satisfaction: 5 };
	const result = applyPalamSource(character, {
		rapport: 2, comfort: -3, arousal: 4, pleasure: 1,
		embarrassment: 6, tension: 7, frustration: -9, satisfaction: 8
	});
	assert.deepEqual(result.character.palam, {
		rapport: 7, comfort: 2, arousal: 9, pleasure: 6,
		embarrassment: 11, tension: 12, frustration: 0, satisfaction: 13
	});
	assert.deepEqual(result.changes, {
		rapport: 2, comfort: -3, arousal: 4, pleasure: 1,
		embarrassment: 6, tension: 7, frustration: -5, satisfaction: 8
	});
	assert.deepEqual(character.palam, { rapport: 5, comfort: 5, arousal: 5, pleasure: 5, embarrassment: 5, tension: 5, frustration: 5, satisfaction: 5 });
});
