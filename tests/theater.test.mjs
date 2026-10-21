import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleWorld } from '../src/lib/theater/fixtures.ts';
import { initialState, beginTurn, availableActions, applyAction, observation } from '../src/lib/theater/runtime.ts';
import { resolveTurn } from '../src/lib/theater/ensemble.ts';
import { validateDefinition, validateState } from '../src/lib/theater/validation.ts';
import { convertLegacy } from '../src/lib/theater/legacy.ts';

function world() { const definition = exampleWorld(); return { id: 'test-world', revision: 0, definition, state: initialState(definition) }; }
const instance = (world, id) => world.state.instances.find((entry) => entry.id === id);

test('prefab instances keep separate state and conditional interactions', () => {
	const stage = world();
	beginTurn(stage, { kind: 'move', destinationId: 'rehearsal' });
	beginTurn(stage, { kind: 'interact', targetId: 'rehearsal-light', interactionId: 'on' });
	assert.equal(instance(stage, 'rehearsal-light').state.on, true);
	assert.equal(instance(stage, 'stage-light').state.on, false);
	assert.throws(() => beginTurn(stage, { kind: 'interact', targetId: 'rehearsal-light', interactionId: 'on' }), /할 수 없는 행동/);
	assert.equal(stage.state.tick, 2);
	assert.throws(() => beginTurn(stage, { kind: 'interact', targetId: 'stage-light', interactionId: 'on' }), /할 수 없는 행동/);
	validateState(stage.state, stage.definition);
});

test('objects react once to targeted events and apply declared effects', () => {
	const stage = world();
	beginTurn(stage, { kind: 'interact', targetId: 'desk-bell', interactionId: 'ring' });
	assert.equal(instance(stage, 'desk-bell').state.rung, true);
	assert.equal(stage.state.events.filter((entry) => entry.actorId === 'desk-bell').length, 1);
	assert.match(stage.state.events.at(-1).text, /종소리/);
	assert.equal(instance(stage, 'seoyeon').memories.length, 2);
	assert.equal(instance(stage, 'jieun').memories.length, 0);
});

test('companions retain identity, private state and memories across scene transitions', () => {
	const stage = world();
	instance(stage, 'harin').state.secret = 'a personal fact';
	beginTurn(stage, { kind: 'speak', text: 'Only the lobby can hear this.', targetId: 'seoyeon' });
	beginTurn(stage, { kind: 'move', destinationId: 'stage' });
	assert.equal(instance(stage, 'harin').sceneId, 'stage');
	assert.equal(instance(stage, 'harin').state.secret, 'a personal fact');
	assert.ok(instance(stage, 'harin').memories.some((memory) => memory.text.includes('Only the lobby')));
	assert.equal(instance(stage, 'seoyeon').sceneId, 'lobby');
	assert.equal(instance(stage, 'jieun').memories.some((memory) => memory.text.includes('Only the lobby')), false);
	const seen = observation(stage, instance(stage, 'jieun'));
	assert.ok(!JSON.stringify(seen).includes('Only the lobby'));
	assert.ok(!JSON.stringify(seen).includes('a personal fact'));
	assert.equal(seen.present.some((entry) => entry.id === 'seoyeon'), false);
	validateState(stage.state, stage.definition);
});

test('ensemble makes one decision per resident, and later actors observe resolved speech', async () => {
	const stage = world();
	const calls = [];
	const director = {
		async decide(state, actions) {
			calls.push(structuredClone(state));
			const action = actions.find((entry) => entry.id === 'speak:player');
			return { action, model: 'fake', choice: action.id, reaction: 0.9, intensity: 1.2 };
		},
		async speak(state) { return `${state.self.name} answers.`; }
	};
	const result = await resolveTurn(stage, { kind: 'speak', text: 'Hello.', targetId: 'seoyeon' }, director);
	assert.deepEqual(calls.map((state) => state.self.id), ['seoyeon', 'harin']);
	assert.ok(calls[1].recentEvents.some((entry) => entry.text === '서연 answers.'));
	assert.equal(result.state.events.filter((entry) => entry.kind === 'speak').length, 3);
	assert.equal(stage.state.tick, 0);
	assert.equal(stage.state.events.length, 0);
	validateState(result.state, result.definition);
});

test('failed or forged decisions cannot mutate the authoritative input', async () => {
	const stage = world();
	const request = { kind: 'wait' };
	await assert.rejects(resolveTurn(stage, request, { async decide() { throw new Error('offline'); } }), /offline/);
	assert.equal(stage.state.tick, 0);
	await assert.rejects(resolveTurn(stage, request, { async decide() { return { action: { id: 'speak:offstage' } }; } }), /실행할 수 없는 행동/);
	assert.equal(stage.state.events.length, 0);
});

test('actor movement respects exits; companions follow the player rather than moving independently', () => {
	const stage = world();
	assert.equal(availableActions(stage, 'harin').some((action) => action.kind === 'move'), false);
	const move = availableActions(stage, 'seoyeon').find((action) => action.destinationId === 'stage');
	applyAction(stage, 'seoyeon', move, move.label);
	assert.equal(instance(stage, 'seoyeon').sceneId, 'stage');
	assert.equal(stage.state.activeSceneId, 'lobby');
	assert.ok(!observation(stage, instance(stage, 'harin')).present.some((entry) => entry.id === 'seoyeon'));
	assert.throws(() => beginTurn(stage, { kind: 'move', destinationId: 'unknown' }), /할 수 없는 행동/);
});

test('definition and snapshot validation reject broken references, duplicate IDs and invalid state', () => {
	const definition = exampleWorld();
	definition.scenes[0].exits.push('missing');
	assert.throws(() => validateDefinition(definition), /출구/);
	const duplicate = exampleWorld();
	duplicate.spawns.push(duplicate.spawns[0]);
	assert.throws(() => validateDefinition(duplicate), /중복/);
	const stage = world();
	instance(stage, 'harin').sceneId = 'stage';
	assert.throws(() => validateState(stage.state, stage.definition), /동행/);
});

test('legacy story content and personal memories convert without bringing numeric mechanics into the runtime', () => {
	const converted = convertLegacy('Old story', {
		world: [{ turn: 4, day: 2, minute: 1200, location: 'Old room' }], config: [{ world_setting: 'A city', era_rules: 'PALAM increases' }],
		characters: [{ id: 'a', name: 'Actor A', profile: 'A remembered person', palam_json: '{"rapport":90}' }],
		events: [{ id: 1, turn: 3, narrative: 'An old conversation.' }], memories: [{ event_id: 1, character_id: 'a', created_turn: 3, summary: 'A personal memory.' }]
	});
	assert.equal(converted.state.tick, 4);
	assert.equal(converted.state.instances[0].memories[0].text, 'A personal memory.');
	assert.equal(converted.state.events[0].text, 'An old conversation.');
	assert.ok(!JSON.stringify(converted).includes('PALAM'));
	assert.ok(!JSON.stringify(converted).includes('palam_json'));
});
