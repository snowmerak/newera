import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleWorld } from '../src/lib/theater/fixtures.ts';
import { initialState, beginTurn, availableActions, applyAction, observation } from '../src/lib/theater/runtime.ts';
import { resolveTurn as executeTurn, restoredProgress } from '../src/lib/theater/ensemble.ts';
import { eventContent } from '../src/lib/theater/event-content.ts';
import { memoryForEvent } from '../src/lib/theater/memory.ts';
import { sceneGraph } from '../src/lib/theater/scene-graph.ts';
import { validateDefinition, validateState } from '../src/lib/theater/validation.ts';
import { buildBundle, validateBundle } from '../skills/newera-lore-authoring/scripts/lore-format.mjs';

// These tests focus on scheduling and actions; relationship-specific tests supply their own reflection.
const resolveTurn = (world, request, director, ...rest) => executeTurn(world, request, {
	async reflect() { return { relationshipUpdates: [], memoUpdate: null }; }, ...director
}, ...rest);

function world() { const definition = exampleWorld(); return { id: 'test-world', revision: 0, definition, state: initialState(definition) }; }
const instance = (world, id) => world.state.instances.find((entry) => entry.id === id);

test('event display separates structured actions and speech with a fallback for older records', () => {
	const stage = world();
	const speech = beginTurn(stage, { kind: 'speak', text: '안녕하세요.', targetId: 'seoyeon' });
	assert.deepEqual(eventContent(speech), { narrative: null, utterance: '안녕하세요.' });
	assert.deepEqual(eventContent({ ...speech, text: '고개를 끄덕인다.\n같이 준비해요.', narrative: '고개를 끄덕인다.', utterance: '같이 준비해요.' }), { narrative: '고개를 끄덕인다.', utterance: '같이 준비해요.' });
	const action = beginTurn(stage, { kind: 'interact', targetId: 'desk-bell', interactionId: 'ring' });
	assert.deepEqual(eventContent(action), { narrative: '데스크의 종을 한 번 누른다.', utterance: null });
});

test('witness memories keep the player as subject of switching off a light', () => {
	const stage = world();
	beginTurn(stage, { kind: 'move', destinationId: 'stage' });
	beginTurn(stage, { kind: 'interact', targetId: 'stage-light', interactionId: 'on' });
	const off = beginTurn(stage, { kind: 'interact', targetId: 'stage-light', interactionId: 'off' });
	for (const id of ['jieun', 'harin']) {
		const actor = instance(stage, id);
		const seen = observation(stage, actor);
		const memory = seen.self.memories.find((memory) => memory.eventId === off.id);
		assert.equal(memory.actorId, 'player');
		assert.equal(memory.targetId, 'stage-light');
		assert.equal(memory.kind, 'interact');
		assert.equal(memory.interactionId, 'off');
		assert.deepEqual(memory.changes, { on: false });
		assert.deepEqual(memory.body, { narrative: '작업등 스위치를 내린다.', utterance: null });
		assert.equal(Object.hasOwn(memory, 'text'), false);
		assert.ok(!JSON.stringify(seen).includes('나:'));
		assert.deepEqual(seen.recentEvents.at(-1), memory);
	}
	assert.equal(instance(stage, 'seoyeon').memories.some((memory) => memory.eventId === off.id), false);
});

test('legacy first-person memories resolve through the original event without prose rewriting', () => {
	const stage = world();
	const event = beginTurn(stage, { kind: 'speak', text: '내가 조명을 확인할게.', targetId: 'harin' });
	const harin = instance(stage, 'harin');
	harin.memories = [{ eventId: event.id, tick: event.tick, text: '나: 내가 조명을 확인할게.' }, { eventId: 'unlinked', tick: event.tick, text: '나: 주체를 확인할 수 없는 옛 기록' }];
	const seen = observation(stage, harin);
	assert.deepEqual(seen.self.memories, [memoryForEvent(event)]);
	assert.equal(seen.self.memories[0].actorId, 'player');
	assert.equal(seen.self.memories[0].body.utterance, '내가 조명을 확인할게.', 'quoted speech must remain unchanged');
	const restored = validateState(stage.state, stage.definition);
	const memories = restored.instances.find((entry) => entry.id === 'harin').memories;
	assert.deepEqual(memories[0], memoryForEvent(event));
	assert.deepEqual(memories[1], harin.memories[1], 'unlinked legacy records must be preserved without guessing their author');
	memories[0].actorId = 'harin';
	assert.throws(() => validateState(restored, stage.definition), /원래 사건과 다릅니다/);
});

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
	assert.ok(instance(stage, 'harin').memories.some((memory) => memory.body.utterance?.includes('Only the lobby')));
	assert.equal(instance(stage, 'seoyeon').sceneId, 'lobby');
	assert.equal(instance(stage, 'jieun').memories.some((memory) => memory.body.utterance?.includes('Only the lobby')), false);
	const seen = observation(stage, instance(stage, 'jieun'));
	assert.ok(!JSON.stringify(seen).includes('Only the lobby'));
	assert.ok(!JSON.stringify(seen).includes('a personal fact'));
	assert.equal(seen.present.some((entry) => entry.id === 'seoyeon'), false);
	validateState(stage.state, stage.definition);
});

test('ensemble rechecks earlier actors after new speech, without leaking private memos', async () => {
	const stage = world();
	const calls = [];
	const director = {
		async decide(state) {
			calls.push(structuredClone(state));
			return { act: calls.length <= 2, model: 'fake' };
		},
		async perform(state, actions) {
			assert.ok(actions.every((action) => action.kind !== 'wait'));
			return { actionId: 'speak:player', targetId: 'player', narrative: '대본을 접는다.', utterance: `${state.self.name} answers.`, memoUpdate: { summary: `${state.self.id} private thought`, currentIntention: 'Listen.', feelings: ['curious'], openThreads: [] }, model: 'fake-generation' };
		}
	};
	const result = await resolveTurn(stage, { kind: 'speak', text: 'Hello.', targetId: 'seoyeon' }, director);
	assert.deepEqual(calls.map((state) => state.self.id), ['seoyeon', 'harin', 'seoyeon']);
	assert.ok(calls[1].recentEvents.some((entry) => entry.actorId === 'seoyeon' && entry.body.utterance === '서연 answers.'));
	const witnessed = calls[1].self.memories.find((entry) => entry.actorId === 'seoyeon');
	assert.deepEqual(witnessed.body, { narrative: '대본을 접는다.', utterance: '서연 answers.' }, 'both body fields must be recorded before witnesses receive the event');
	assert.equal(witnessed.targetId, 'player');
	assert.equal(result.state.events.filter((entry) => entry.kind === 'speak').length, 3);
	assert.equal(stage.state.tick, 0);
	assert.equal(stage.state.events.length, 0);
	const restored = validateState(result.state, result.definition);
	assert.equal(restored.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon private thought');
	assert.ok(!JSON.stringify(calls[1]).includes('seoyeon private thought'));
	assert.equal(restored.events.filter((event) => event.kind === 'speak').at(-1).utterance, '하린 answers.');
	assert.equal(restored.events.filter((event) => event.kind === 'speak').at(-1).decision.generationModel, 'fake-generation');
});

test('failed or forged decisions cannot mutate the authoritative input', async () => {
	const stage = world();
	const request = { kind: 'wait' };
	await assert.rejects(resolveTurn(stage, request, { async decide() { throw new Error('offline'); } }), /offline/);
	assert.equal(stage.state.tick, 0);
	await assert.rejects(resolveTurn(stage, request, { async decide() { return { act: true, model: 'fake' }; }, async perform() { return { actionId: 'speak:offstage', targetId: 'offstage', narrative: null, utterance: 'forged', memoUpdate: null, model: 'fake' }; } }), /실행할 수 없는 행동/);
	assert.equal(stage.state.events.length, 0);
});

test('a conversation can keep alternating until a participant chooses to wait', async () => {
	const decisions = [];
	const lines = ['왔네.', '서연아, 공연 준비는 잘 되어가?', '응, 대본은 다 외웠어.', '그러면 무대도 확인할까?', '좋아, 같이 가자.'];
	let spoken = 0;
	let finalProgress;
	const result = await resolveTurn(world(), { kind: 'wait' }, {
		async decide(state) {
			decisions.push(state.self.id);
			if (decisions.length === 3) assert.equal(state.recentEvents.at(-1).body.utterance, lines[1]);
			return { act: spoken < lines.length, model: 'fake' };
		},
		async perform(state) {
			const targetId = state.self.id === 'seoyeon' ? 'harin' : 'seoyeon';
			return { actionId: `speak:${targetId}`, targetId, narrative: null, utterance: lines[spoken++], memoUpdate: null, model: 'fake' };
		}
	}, () => {}, { onProgress: (_, progress) => { finalProgress = structuredClone(progress); } });
	assert.deepEqual(decisions, ['seoyeon', 'harin', 'seoyeon', 'harin', 'seoyeon', 'harin']);
	assert.deepEqual(result.state.events.filter((event) => event.kind === 'speak').map((event) => event.utterance), lines);
	assert.deepEqual(finalProgress, { pendingActorIds: [], completedDecisions: 6, consumedInputs: 0 });
	assert.equal(result.state.tick, 1, 'reactive dialogue must not replay or advance player input');
});

test('an actor who waited is awakened by another action; waiting alone does not create a loop', async () => {
	const decisions = [];
	await resolveTurn(world(), { kind: 'wait' }, {
		async decide(state) { decisions.push(state.self.id); return { act: decisions.length === 2, model: 'fake' }; },
		async perform() { return { actionId: 'speak:seoyeon', targetId: 'seoyeon', narrative: null, utterance: '서연아?', memoUpdate: null, model: 'fake' }; }
	});
	assert.deepEqual(decisions, ['seoyeon', 'harin', 'seoyeon']);
});

test('old cursors and a repeated reaction resume without replaying committed speech', async () => {
	assert.deepEqual(restoredProgress({ actorIds: ['seoyeon', 'harin'], nextActorIndex: 1 }), { pendingActorIds: ['harin'], completedDecisions: 1, consumedInputs: 0 });
	let saved;
	let progress;
	let calls = 0;
	await assert.rejects(resolveTurn(world(), { kind: 'wait' }, {
		async decide() { if (++calls === 3) throw new Error('restart'); return { act: true, model: 'fake' }; },
		async perform(state) { return { actionId: 'speak:player', targetId: 'player', narrative: null, utterance: `${state.self.id} 대사`, memoUpdate: null, model: 'fake' }; }
	}, () => {}, { onProgress: (world, position) => { saved = structuredClone(world); progress = structuredClone(position); } }), /restart/);
	assert.deepEqual(progress, { pendingActorIds: ['seoyeon'], completedDecisions: 2, consumedInputs: 0 });
	const previous = structuredClone(saved.state.events);
	const resumed = await resolveTurn(saved, { kind: 'wait' }, {
		async decide(state) { assert.equal(state.self.id, 'seoyeon'); return { act: false, model: 'fake' }; }
	}, () => {}, { progress });
	assert.deepEqual(resumed.state.events.slice(0, previous.length), previous);
	assert.equal(resumed.state.tick, 1);
});

test('chat arriving during generation replaces the stale proposal and can be accepted or refused', async () => {
	for (const continueAfterStop of [false, true]) {
		const inputs = [];
		let injected = false;
		let generatedAfterStop = false;
		let progress;
		const result = await resolveTurn(world(), { kind: 'wait' }, {
			async decide(state) {
				const stopped = state.recentEvents.some((event) => event.actorId === 'player' && event.body.utterance === '이제 그만해.');
				return { act: !stopped || (continueAfterStop && !generatedAfterStop), model: 'fake' };
			},
			async perform() {
				if (!injected) { injected = true; inputs.push({ kind: 'speak', text: '이제 그만해.', targetId: null }); }
				else generatedAfterStop = true;
				return { actionId: 'speak:player', targetId: 'player', narrative: null, utterance: generatedAfterStop ? '잠깐, 이 말은 해야겠어.' : '반영되면 안 되는 옛 응답', memoUpdate: null, model: 'fake' };
			}
		}, () => {}, { nextInput: (index) => inputs[index] ?? null, onProgress: (_, saved) => { progress = structuredClone(saved); } });
		assert.equal(progress.consumedInputs, 1);
		assert.equal(result.state.tick, 2);
		assert.equal(result.state.events.filter((event) => event.actorId === 'player').length, 2);
		assert.ok(!result.state.events.some((event) => event.utterance === '반영되면 안 되는 옛 응답'));
		assert.equal(result.state.events.filter((event) => event.utterance === '잠깐, 이 말은 해야겠어.').length, continueAfterStop ? 1 : 0);
	}
});

test('a failed outdated inference still delivers chat received while it was pending', async () => {
	for (const failedPhase of ['decide', 'perform']) {
		const inputs = [];
		const stopped = (state) => state.recentEvents.some((event) => event.actorId === 'player' && event.body.utterance === '잠깐.');
		const injectAndFail = () => { inputs.push({ kind: 'speak', text: '잠깐.', targetId: null }); throw new Error('old model call failed'); };
		const result = await resolveTurn(world(), { kind: 'wait' }, {
			async decide(state) {
				if (stopped(state)) return { act: false, model: 'fake' };
				if (failedPhase === 'decide') injectAndFail();
				return { act: true, model: 'fake' };
			},
			async perform() { injectAndFail(); }
		}, () => {}, { nextInput: (index) => inputs[index] ?? null });
		assert.equal(result.state.events.filter((event) => event.actorId === 'player' && event.text === '잠깐.').length, 1);
	}
});

test('incremental execution publishes complete actions and resumes from the saved cursor', async () => {
	let saved;
	let progress;
	const checkpoints = [];
	const persist = (world, position) => { saved = structuredClone(world); progress = structuredClone(position); checkpoints.push(saved); };
	await assert.rejects(resolveTurn(world(), { kind: 'speak', text: '먼저 답해 줘.', targetId: 'harin' }, {
		async decide(state) { return { act: true, model: 'fake' }; },
		async perform(state) {
			return { actionId: 'speak:player', targetId: 'player', narrative: '고개를 끄덕인다.', utterance: state.self.id === 'harin' ? '먼저 답할게.' : null, memoUpdate: null, model: 'fake' };
		}
	}, () => {}, { onProgress: persist }), /대사가 필요/);
	assert.equal(checkpoints.length, 4, 'input, private reflections and the complete first action are published');
	assert.deepEqual(progress, { pendingActorIds: ['seoyeon'], completedDecisions: 1, consumedInputs: 0 });
	assert.deepEqual(saved.state.events.map((event) => event.actorId), ['player', 'harin']);
	const ids = saved.state.events.map((event) => event.id);
	const result = await resolveTurn(saved, { kind: 'speak', text: '먼저 답해 줘.', targetId: 'harin' }, {
		async decide(state) { assert.equal(state.self.id, 'seoyeon'); return { act: false, model: 'fake' }; },
		async perform() { assert.fail('waiting must skip generation'); }
	}, () => {}, { progress, onProgress: persist });
	assert.equal(result.state.tick, 1);
	assert.deepEqual(result.state.events.slice(0, 2).map((event) => event.id), ids);
	assert.equal(progress.completedDecisions, 2);
	assert.deepEqual(progress.pendingActorIds, []);
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
			return { actionId: 'speak:player', targetId: 'player', narrative: null, utterance: ++count === 1 ? 'Valid.' : null, memoUpdate: { summary: 'Changed.', currentIntention: '', feelings: [], openThreads: [] }, model: 'fake' };
		}
	}), /대사가 필요/);
	assert.equal(instance(stage, 'seoyeon').memo.summary, 'Remember this.');
	assert.equal(stage.state.tick, 0);
});

test('structured physical action runs only declared effects', async () => {
	const stage = world();
	instance(stage, 'seoyeon').memo = { summary: 'Keep my note.', currentIntention: '', feelings: [], openThreads: [] };
	const result = await resolveTurn(stage, { kind: 'wait' }, {
		async decide(state) { return { act: state.self.id === 'seoyeon' && !state.present.find((entry) => entry.id === 'desk-bell')?.state.rung, model: 'fake' }; },
		async perform() { return { actionId: 'interact:desk-bell:ring', targetId: 'desk-bell', narrative: '손끝으로 종을 누른다.', utterance: null, memoUpdate: null, model: 'fake' }; }
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

test('a corridor is a full scene and reachable destinations still require each direct move', () => {
	const stage = world();
	stage.definition.scenes = [
		{ id: 'lobby', name: '로비', description: '입구.', exits: ['corridor'] },
		{ id: 'corridor', name: '복도', description: '사람들이 마주치는 긴 복도.', exits: ['lobby', 'stage'] },
		{ id: 'stage', name: '무대', description: '무대.', exits: ['corridor'] },
		{ id: 'rehearsal', name: '연습실', description: '별도 출입구.', exits: [] }
	];
	validateDefinition(stage.definition);
	assert.equal(availableActions(stage, 'seoyeon').some((action) => action.destinationId === 'stage'), false);
	assert.throws(() => applyAction(stage, 'seoyeon', { kind: 'move', destinationId: 'stage' }, '바로 간다'), /이동할 수 없는/);
	assert.throws(() => beginTurn(stage, { kind: 'move', destinationId: 'stage' }), /할 수 없는 행동/);
	beginTurn(stage, { kind: 'move', destinationId: 'corridor' });
	assert.equal(instance(stage, 'harin').sceneId, 'corridor');
	assert.equal(observation(stage, instance(stage, 'harin')).scene.name, '복도');
	assert.ok(availableActions(stage, 'player').some((action) => action.destinationId === 'stage'));
	beginTurn(stage, { kind: 'move', destinationId: 'stage' });
	assert.deepEqual(stage.state.events.filter((event) => event.actorId === 'player').map((event) => [event.kind, event.sceneId]), [
		['leave', 'lobby'], ['enter', 'corridor'], ['leave', 'corridor'], ['enter', 'stage']
	]);
	validateState(stage.state, stage.definition);
});

test('scene graph draws only saved adjacency lists, including one-way and disconnected scenes', () => {
	const scenes = [
		{ id: 'a', name: '입구', description: '', exits: ['b'] },
		{ id: 'b', name: '복도', description: '', exits: ['c'] },
		{ id: 'c', name: '무대', description: '', exits: ['b'] },
		{ id: 'd', name: '별관', description: '', exits: [] }
	];
	const before = structuredClone(scenes);
	const graph = sceneGraph(scenes, 'a');
	assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ['a', 'b', 'c', 'd']);
	assert.equal(graph.edges.length, 2, 'bidirectional paths must be drawn once');
	assert.equal(graph.edges.find((edge) => edge.fromId === 'a').both, false);
	assert.equal(graph.edges.find((edge) => edge.fromId === 'b').both, true);
	assert.deepEqual(scenes, before, 'drawing must not add reverse or shortcut connections');
	scenes[0].exits = ['d'];
	const edited = sceneGraph(scenes, 'a');
	assert.ok(edited.edges.some((edge) => edge.fromId === 'a' && edge.toId === 'd'));
	assert.ok(!edited.edges.some((edge) => edge.fromId === 'a' && edge.toId === 'b'));
});

test('generated movement description is attached once to the departure, preserving arrival text', async () => {
	const result = await resolveTurn(world(), { kind: 'wait' }, {
		async decide(state) { return { act: state.self.id === 'seoyeon', model: 'fake' }; },
		async perform() { return { actionId: 'move:stage', targetId: null, narrative: '대본을 들고 무대로 향한다.', utterance: null, memoUpdate: null, model: 'fake' }; }
	});
	const movement = result.state.events.filter((event) => event.actorId === 'seoyeon');
	assert.deepEqual(movement.map((event) => event.kind), ['leave', 'enter']);
	assert.equal(movement[0].narrative, '대본을 들고 무대로 향한다.');
	assert.equal(movement[1].narrative, undefined);
	assert.notEqual(eventContent(movement[1]).narrative, movement[0].narrative);
	validateState(result.state, result.definition);
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
