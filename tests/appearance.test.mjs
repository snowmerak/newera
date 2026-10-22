import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleWorld } from '../src/lib/theater/fixtures.ts';
import { applyAction, beginTurn, initialState, observation } from '../src/lib/theater/runtime.ts';
import { applyAppearance, needsAppearance } from '../src/lib/theater/appearance.ts';
import { eventPresentations } from '../src/lib/theater/presentation.ts';
import { resolveTurn } from '../src/lib/theater/ensemble.ts';
import { validateDefinition, validateState } from '../src/lib/theater/validation.ts';

function world() {
	const definition = exampleWorld();
	for (const template of definition.templates.filter(t => t.kind === 'character')) Object.assign(template, {
		baseAppearance: '검은 단발.', clothingPreferences: '편한 옷.', foodPreferences: '귤을 좋아한다.',
		wardrobe: [{ id: 'uniform', name: '교복', appearance: '회색 교복을 입었다.', context: '학교 수업.' }, { id: 'casual', name: '사복', appearance: '파란 셔츠를 입었다.', context: '휴일.' }]
	});
	const stage = { id: 'test', revision: 0, definition, state: initialState(definition) };
	stage.state.instances.find(a => a.id === 'harin').playerContext = '오늘 처음 만났다.';
	return stage;
}
const actor = stage => stage.state.instances.find(a => a.id === 'harin');
const template = stage => stage.definition.templates.find(t => t.id === actor(stage).templateId);
const request = { kind: 'speak', text: '안녕', targetId: null };
const say = stage => applyAction(stage, 'harin', { id: 'speak:player', kind: 'speak', targetId: 'player', label: '말한다' }, '안녕', undefined, { narrative: null, utterance: '안녕' });
const director = overrides => ({
	async chooseAppearance() { return { outfitId: 'uniform', model: 'decision-model' }; },
	async reflect() { return { relationshipUpdates: [], memoUpdate: null }; },
	async decide() { return { act: false, model: 'decision-model' }; },
	async perform() { throw Error('wait does not generate'); }, ...overrides
});

test('appearance refresh requires another scene and elapsed threshold, or a new day', () => {
	const stage = world(), a = actor(stage);
	assert.equal(needsAppearance(stage, a), true);
	applyAppearance(a, template(stage), stage, 'uniform', 'decision-model');
	stage.state.minute += 180;
	assert.equal(needsAppearance(stage, a), false, 'same scene keeps outfit even after the gap');
	a.sceneId = 'stage';
	stage.state.minute--;
	assert.equal(needsAppearance(stage, a), false, '179 minutes does not trigger refresh');
	stage.state.minute++;
	assert.equal(needsAppearance(stage, a), true, '180 minutes in another scene triggers choice');
	stage.definition.appearanceChangeMinutes = 200;
	assert.equal(needsAppearance(stage, a), false, 'world threshold is honored');
	a.sceneId = a.appearanceSelection.sceneId;
	stage.state.day++;
	stage.state.minute = 5;
	assert.equal(needsAppearance(stage, a), true, 'next day refreshes even in same scene');
	assert.throws(() => applyAppearance(a, template(stage), stage, 'invented', 'model'), /候補|후보/);
});

test('first relationship and changed outfits are captured once without changing past descriptions', () => {
	const stage = world(), a = actor(stage);
	a.appearance = '노란 가디건.';
	const first = say(stage);
	assert.deepEqual(first.presentation, { playerContext: '오늘 처음 만났다.', appearance: '노란 가디건.' });
	const repeated = say(stage);
	assert.equal(repeated.presentation, undefined);
	// Selecting the same visible outfit on another day must not repeat its description.
	stage.state.day++;
	a.appearanceSelection = { day: stage.state.day, outfitId: 'uniform', model: 'another-model' };
	assert.equal(say(stage).presentation, undefined);
	a.appearance = '파란 재킷.';
	const changed = say(stage);
	assert.deepEqual(changed.presentation, { appearance: '파란 재킷.' });
	a.appearance = '노란 가디건.';
	const returned = say(stage);
	assert.deepEqual(returned.presentation, { appearance: '노란 가디건.' });
	a.playerContext = '나중에 편집한 초기 설정.';
	const presented = eventPresentations(stage);
	assert.deepEqual(presented.get(first.id), { playerContext: '오늘 처음 만났다.', appearance: '노란 가디건.' });
	assert.equal(presented.has(repeated.id), false);
	assert.deepEqual(presented.get(changed.id), { appearance: '파란 재킷.' });
	assert.deepEqual(presented.get(returned.id), { appearance: '노란 가디건.' });
	assert.equal(Object.hasOwn(a.memories[0], 'presentation'), false, 'player-facing introductions do not leak into character memories');
	assert.deepEqual(validateState(stage.state, stage.definition).events.map(e => e.presentation), stage.state.events.map(e => e.presentation));
});

test('introductions are not repeated when the original appearance leaves the recent 100-event window', () => {
	const stage = world();
	actor(stage).appearance = '회색 교복.';
	const first = say(stage);
	for (let i = 0; i < 101; i++) beginTurn(stage, { kind: 'wait' });
	const latest = say(stage);
	assert.ok(!stage.state.events.slice(-100).some(e => e.id === first.id));
	const presented = eventPresentations(stage);
	assert.equal(presented.has(first.id), true);
	assert.equal(presented.has(latest.id), false);
	assert.equal(stage.state.events.slice(-100).filter(e => presented.has(e.id)).length, 0);
});

test('legacy records get one initial introduction; missing settings stay blank and malformed snapshots are rejected', () => {
	const stage = world(), a = actor(stage);
	stage.definition.spawns.find(i => i.id === a.id).appearance = '초기의 교복.';
	a.appearance = '초기의 교복.';
	const first = say(stage); delete first.presentation;
	say(stage);
	assert.deepEqual(eventPresentations(stage).get(first.id), { playerContext: '오늘 처음 만났다.', appearance: '초기의 교복.' });
	a.appearance = '바뀐 가디건.';
	const changed = say(stage);
	assert.deepEqual(changed.presentation, { appearance: '바뀐 가디건.' });
	for (const [id, presentation] of [[first.id, { secret: 'hidden' }], [first.id, { appearance: '가'.repeat(1201) }]]) {
		const invalid = structuredClone(stage.state);
		invalid.events.find(e => e.id === id).presentation = presentation;
		assert.throws(() => validateState(invalid, stage.definition));
	}
	const blank = world(); delete actor(blank).playerContext;
	const blankEvent = say(blank);
	assert.deepEqual(blankEvent.presentation, { playerContext: '', appearance: '' });
	assert.equal(eventPresentations(blank).has(blankEvent.id), false);
});

test('appearance, timing, public context and private preferences round trip without changing old records', () => {
	const stage = world(), a = actor(stage);
	applyAppearance(a, template(stage), stage, 'uniform', 'model');
	const definition = validateDefinition({ ...stage.definition, appearanceChangeMinutes: 60 });
	const restored = validateState(stage.state, definition);
	assert.deepEqual(restored.instances.find(i => i.id === a.id).appearanceSelection, a.appearanceSelection);
	assert.equal(restored.instances.find(i => i.id === a.id).playerContext, '오늘 처음 만났다.');
	assert.equal(definition.templates.find(t => t.id === a.templateId).foodPreferences, '귤을 좋아한다.');
	const other = stage.state.instances.find(i => i.id === 'seoyeon');
	const present = observation(stage, other).present.find(i => i.id === a.id);
	assert.equal(present.appearance, a.appearance);
	for (const key of ['playerContext', 'foodPreferences', 'clothingPreferences', 'wardrobe']) assert.equal(Object.hasOwn(present, key), false);
	const old = exampleWorld();
	assert.equal(Object.hasOwn(validateDefinition(old), 'appearanceChangeMinutes'), false);
	assert.equal(Object.hasOwn(validateState(initialState(old), old).instances[0], 'appearanceSelection'), false);
	for (const gap of [0, -1, 1441, 1.5]) assert.throws(() => validateDefinition({ ...old, appearanceChangeMinutes: gap }));
	for (const timing of [{ minute: 0 }, { sceneId: 'lobby' }, { minute: 1440, sceneId: 'lobby' }, { minute: 1200, sceneId: 'lobby' }]) {
		const invalid = structuredClone(stage.state);
		invalid.instances.find(i => i.id === a.id).appearanceSelection = { day: 1, outfitId: 'uniform', model: 'model', ...timing };
		assert.throws(() => validateState(invalid, definition));
	}
	const legacy = { day: 1, outfitId: null, model: 'manual' };
	a.appearanceSelection = legacy;
	assert.deepEqual(validateState(stage.state, definition).instances.find(i => i.id === a.id).appearanceSelection, legacy);
	assert.equal(needsAppearance(stage, a), false);
	const tooMany = structuredClone(definition);
	tooMany.templates[0].wardrobe = Array.from({ length: 37 }, (_, i) => ({ id: `o-${i}`, name: '옷', appearance: '셔츠', context: '' }));
	assert.throws(() => validateDefinition(tooMany), /36/);
});

test('all resident appearances commit before anyone reasons; failed inference resumes without reroll', async () => {
	const stage = world();
	let saved, progress, choices = 0;
	const onProgress = (world, cursor) => { saved = structuredClone(world); progress = structuredClone(cursor); };
	await assert.rejects(resolveTurn(stage, request, director({
		async chooseAppearance() { choices++; return { outfitId: 'uniform', model: 'chosen' }; },
		async reflect(state) {
			assert.ok(state.present.filter(i => i.kind === 'character').every(i => i.appearance.includes('교복')));
			throw Error('generation unavailable');
		}
	}), () => {}, { onProgress }), /generation unavailable/);
	assert.equal(choices, 2);
	assert.equal(saved.state.events.length, 1, 'outfit selection does not fabricate events');
	assert.equal(actor(saved).appearanceSelection.model, 'chosen');
	const resumed = await resolveTurn(saved, request, director({ async chooseAppearance() { throw Error('must not reroll'); } }), () => {}, { progress });
	assert.equal(resumed.state.events.filter(e => e.actorId === 'player').length, 1);
	assert.deepEqual(actor(resumed).appearanceSelection, actor(saved).appearanceSelection);
	assert.equal(resumed.state.minute, stage.state.minute + 1, 'outfit choice never advances time');
});

test('new player input discards a pending appearance choice before committing it', async () => {
	let input = null, choices = 0;
	const next = { kind: 'speak', text: '잠깐, 여기 봐', targetId: null };
	const seen = [];
	await resolveTurn(world(), request, director({
		async chooseAppearance() {
			choices++;
			if (choices === 1) { input = next; return { outfitId: 'casual', model: 'stale' }; }
			return { outfitId: 'uniform', model: 'fresh' };
		}
	}), () => {}, { nextInput: consumed => consumed === 0 ? input : null, onProgress: stage => seen.push(structuredClone(stage)) });
	assert.equal(choices, 3);
	assert.ok(seen.every(stage => stage.state.instances.every(i => i.appearanceSelection?.model !== 'stale')));
});
