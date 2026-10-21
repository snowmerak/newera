import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleWorld } from '../src/lib/theater/fixtures.ts';
import { initialState, beginTurn, availableActions, applyAction, observation } from '../src/lib/theater/runtime.ts';
import { resolveTurn } from '../src/lib/theater/ensemble.ts';
import { validateDefinition, validateState } from '../src/lib/theater/validation.ts';
import { buildBundle, validateBundle } from '../skills/newera-lore-authoring/scripts/lore-format.mjs';

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
		async decide(state) {
			calls.push(structuredClone(state));
			return { act: true, model: 'fake' };
		},
		async perform(state, actions) {
			assert.ok(actions.every((action) => action.kind !== 'wait'));
			return { actionId: 'speak:player', narrative: null, utterance: `${state.self.name} answers.`, memoUpdate: { summary: `${state.self.id} private thought`, currentIntention: 'Listen.', feelings: ['curious'], openThreads: [] }, model: 'fake-generation' };
		}
	};
	const result = await resolveTurn(stage, { kind: 'speak', text: 'Hello.', targetId: 'seoyeon' }, director);
	assert.deepEqual(calls.map((state) => state.self.id), ['seoyeon', 'harin']);
	assert.ok(calls[1].recentEvents.some((entry) => entry.text === '서연 answers.'));
	assert.equal(result.state.events.filter((entry) => entry.kind === 'speak').length, 3);
	assert.equal(stage.state.tick, 0);
	assert.equal(stage.state.events.length, 0);
	const restored = validateState(result.state, result.definition);
	assert.equal(restored.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon private thought');
	assert.ok(!JSON.stringify(calls[1]).includes('seoyeon private thought'));
	assert.equal(restored.events.at(-1).utterance, '하린 answers.');
	assert.equal(restored.events.at(-1).decision.generationModel, 'fake-generation');
});

test('failed or forged decisions cannot mutate the authoritative input', async () => {
	const stage = world();
	const request = { kind: 'wait' };
	await assert.rejects(resolveTurn(stage, request, { async decide() { throw new Error('offline'); } }), /offline/);
	assert.equal(stage.state.tick, 0);
	await assert.rejects(resolveTurn(stage, request, { async decide() { return { act: true, model: 'fake' }; }, async perform() { return { actionId: 'speak:offstage', narrative: null, utterance: 'forged', memoUpdate: null, model: 'fake' }; } }), /실행할 수 없는 행동/);
	assert.equal(stage.state.events.length, 0);
});

test('waiting skips generation and retains private memo; invalid later generation rolls back the whole round', async () => {
	const stage = world();
	instance(stage, 'seoyeon').memo = { summary: 'Remember this.', currentIntention: '', feelings: [], openThreads: [] };
	const result = await resolveTurn(stage, { kind: 'wait' }, {
		async decide() { return { act: false, model: 'fake' }; },
		async perform() { assert.fail('waiting must not generate'); }
	});
	assert.equal(result.state.events.filter((event) => event.decision?.acted === false).length, 2);
	assert.equal(instance(result, 'seoyeon').memo.summary, 'Remember this.');
	let count = 0;
	await assert.rejects(resolveTurn(stage, { kind: 'wait' }, {
		async decide() { return { act: true, model: 'fake' }; },
		async perform() {
			return { actionId: 'speak:player', narrative: null, utterance: ++count === 1 ? 'Valid.' : null, memoUpdate: { summary: 'Changed.', currentIntention: '', feelings: [], openThreads: [] }, model: 'fake' };
		}
	}), /대사가 필요/);
	assert.equal(instance(stage, 'seoyeon').memo.summary, 'Remember this.');
	assert.equal(stage.state.tick, 0);
});

test('structured physical action runs only declared effects', async () => {
	const stage = world();
	instance(stage, 'seoyeon').memo = { summary: 'Keep my note.', currentIntention: '', feelings: [], openThreads: [] };
	const result = await resolveTurn(stage, { kind: 'wait' }, {
		async decide(state) { return { act: state.self.id === 'seoyeon', model: 'fake' }; },
		async perform() { return { actionId: 'interact:desk-bell:ring', narrative: '손끝으로 종을 누른다.', utterance: null, memoUpdate: null, model: 'fake' }; }
	});
	assert.equal(instance(result, 'desk-bell').state.rung, true);
	assert.equal(instance(stage, 'desk-bell').state.rung, false);
	assert.equal(instance(result, 'seoyeon').memo.summary, 'Keep my note.');
	assert.equal(result.state.events.find((event) => event.actorId === 'seoyeon').narrative, '손끝으로 종을 누른다.');
	validateState(result.state, result.definition);
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

test('authoring builds scene-based bundles and rejects unsupported formats', () => {
	const bundle = buildBundle({ format: 'newera-theater-source', version: 2, definition: exampleWorld() });
	assert.equal(validateBundle(bundle).sceneCount, 3);
	assert.equal(bundle.world.state.instances.length, 6);
	assert.deepEqual(Object.keys(bundle).sort(), ['format', 'saves', 'version', 'world']);
	assert.throws(() => buildBundle({ format: 'newera-theater-source', version: 1 }), /version 2/);
	assert.throws(() => validateBundle({ format: 'newera-theater', version: 1 }), /지원하지 않는/);
});
