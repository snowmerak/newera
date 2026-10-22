import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleWorld } from '../src/lib/theater/fixtures.ts';
import { initialState, observation } from '../src/lib/theater/runtime.ts';
import { applyAppearance, needsAppearance } from '../src/lib/theater/appearance.ts';
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
