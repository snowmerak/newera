import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleWorld } from '../src/lib/theater/fixtures.ts';
import { initialState, beginTurn, observation } from '../src/lib/theater/runtime.ts';
import { resolveTurn } from '../src/lib/theater/ensemble.ts';
import { applyReflection, reflectionContext, unknownRelationship } from '../src/lib/theater/reflection.ts';
import { checkedReflection, validateDefinition, validateState } from '../src/lib/theater/validation.ts';

function world() { const definition = validateDefinition(exampleWorld()); return { id: 'relations', revision: 0, definition, state: initialState(definition) }; }
const actor = (world, id) => world.state.instances.find((entry) => entry.id === id);
const noop = { relationshipUpdates: [], memoUpdate: null };
const update = (context, targetId = 'player') => ({ relationshipUpdates: [{ targetId, changes: [{ field: 'trust', value: 35 }], impression: '이번 약속은 확인해 보고 싶다.', evidenceEventIds: [context.newEvents[0].eventId] }], memoUpdate: null });

test('initial relationships are directional instance state; old saves default to unknown without losing memories', () => {
	const stage = world();
	assert.equal(actor(stage, 'seoyeon').relationships.jieun.trust, 75);
	assert.equal(actor(stage, 'jieun').relationships.seoyeon.trust, 70);
	actor(stage, 'seoyeon').relationships.jieun.trust = 5;
	assert.equal(stage.definition.spawns.find((spawn) => spawn.id === 'seoyeon').relationships.jieun.trust, 75);
	assert.equal(actor(stage, 'jieun').relationships.seoyeon.trust, 70);
	assert.equal(unknownRelationship().trust, null);
	beginTurn(stage, { kind: 'wait' });
	const before = JSON.parse(JSON.stringify(stage.state.events));
	for (const instance of stage.state.instances) { delete instance.relationships; delete instance.reflectedThroughEventId; }
	const restored = validateState(stage.state, stage.definition);
	assert.ok(restored.instances.every((instance) => Object.keys(instance.relationships).length === 0 && instance.reflectedThroughEventId === null));
	assert.deepEqual(restored.events, before);
});

test('silent observers update relationships and memo before the binary decision, without public events or private leaks', async () => {
	const stage = world();
	const reflections = [];
	const result = await resolveTurn(stage, { kind: 'speak', text: '준비됐다고 약속했잖아.', targetId: 'harin' }, {
		async reflect(state, context) {
			reflections.push(state.self.id);
			if (state.self.id !== 'harin') { assert.ok(!JSON.stringify(state).includes('이번 약속은 확인')); return noop; }
			return { ...update(context), memoUpdate: { summary: '플레이어의 말을 들었다.', currentIntention: '조용히 확인한다.', feelings: ['플레이어의 약속이 걱정된다.'], openThreads: [] } };
		},
		async decide(state) {
			if (state.self.id === 'harin') { assert.equal(state.self.relationships.player.trust, 35); assert.equal(state.self.relationships.player.affinity, 85); assert.equal(state.self.memo.currentIntention, '조용히 확인한다.'); }
			assert.ok(!state.present.some((entry) => 'relationships' in entry || 'memo' in entry));
			return { act: false, model: 'fake' };
		},
		async perform() { assert.fail('a silent observer must not generate an action'); }
	});
	assert.deepEqual(reflections, ['harin', 'seoyeon']);
	assert.deepEqual(result.state.events.map((event) => event.kind), ['speak', 'wait', 'wait']);
	assert.equal(actor(result, 'harin').reflectedThroughEventId, result.state.events[0].id);
	assert.equal(actor(stage, 'harin').relationships.player.trust, 80);
	validateState(result.state, result.definition);
});

test('new events are batched in order and persisted cursors prevent reinterpreting the same event', () => {
	const stage = world();
	for (let index = 0; index < 35; index++) beginTurn(stage, { kind: 'speak', text: `사건 ${index}`, targetId: null });
	const harin = actor(stage, 'harin');
	const batches = [];
	let context;
	while ((context = reflectionContext(stage, harin))) {
		batches.push(context.newEvents.length);
		assert.ok(context.newEvents.every((event) => context.evidenceEvents.some((evidence) => evidence.eventId === event.eventId)));
		applyReflection(harin, noop, context);
	}
	assert.deepEqual(batches, [16, 16, 3]);
	const restored = validateState(stage.state, stage.definition);
	const reloaded = { ...stage, state: restored };
	assert.equal(reflectionContext(reloaded, actor(reloaded, 'harin')), null);
	const newEvent = beginTurn(reloaded, { kind: 'speak', text: '새로운 말', targetId: null });
	assert.deepEqual(reflectionContext(reloaded, actor(reloaded, 'harin')).newEvents.map((event) => event.eventId), [newEvent.id]);
	actor(reloaded, 'harin').memories.push(structuredClone(actor(reloaded, 'harin').memories[0]));
	assert.deepEqual(reflectionContext(reloaded, actor(reloaded, 'harin')).newEvents.map((event) => event.eventId), [newEvent.id], 'duplicate imported memories must not reintroduce processed events');
});

test('backlog reflections receive only evidence through their current batch before deciding', async () => {
	const stage = world();
	for (let index = 0; index < 35; index++) beginTurn(stage, { kind: 'speak', text: `사건 ${index}`, targetId: null });
	const batches = [];
	await resolveTurn(stage, { kind: 'wait' }, {
		async reflect(state, context) {
			batches.push(context.newEvents.length);
			const allowed = new Set(context.evidenceEvents.map((event) => event.eventId));
			assert.ok(state.self.memories.every((event) => allowed.has(event.eventId)));
			assert.ok(state.recentEvents.every((event) => allowed.has(event.eventId)));
			return noop;
		},
		async decide(state) { assert.ok(state.self.reflectedThroughEventId); return { act: false, model: 'fake' }; }
	});
	assert.deepEqual(batches, [16, 16, 3, 16, 16, 3]);
});

test('reflection proposals cannot forge subjects, targets, scores, fields or unobserved and old-only evidence', () => {
	const stage = world();
	beginTurn(stage, { kind: 'speak', text: '첫 사건', targetId: null });
	const harin = actor(stage, 'harin');
	const first = reflectionContext(stage, harin);
	applyReflection(harin, update(first), first);
	beginTurn(stage, { kind: 'speak', text: '두 번째 사건', targetId: null });
	const context = reflectionContext(stage, harin);
	const mutations = [
		(output) => { output.actorId = 'seoyeon'; },
		(output) => { output.relationshipUpdates[0].targetId = 'harin'; },
		(output) => { output.relationshipUpdates[0].targetId = 'jieun'; },
		(output) => { output.relationshipUpdates[0].targetId = 'desk-bell'; },
		(output) => { output.relationshipUpdates[0].changes[0].value = 101; },
		(output) => { output.relationshipUpdates[0].changes[0].value = -1; },
		(output) => { output.relationshipUpdates[0].changes[0].value = 1.5; },
		(output) => { output.relationshipUpdates[0].changes[0].field = 'companion'; },
		(output) => { output.relationshipUpdates[0].changes.push(output.relationshipUpdates[0].changes[0]); },
		(output) => { output.relationshipUpdates.push(output.relationshipUpdates[0]); },
		(output) => { output.relationshipUpdates[0].evidenceEventIds = ['unseen']; },
		(output) => { output.relationshipUpdates[0].evidenceEventIds = [first.newEvents[0].eventId]; },
		(output) => { output.relationshipUpdates[0].evidenceEventIds = []; }
	];
	for (const mutate of mutations) {
		const value = structuredClone(update(context)); mutate(value);
		const before = structuredClone(harin);
		assert.throws(() => applyReflection(harin, value, context));
		assert.deepEqual(harin, before);
	}
	const nullable = update(context); nullable.relationshipUpdates[0].changes[0].value = null;
	assert.equal(checkedReflection(nullable, context).relationshipUpdates[0].changes[0].value, null);
});

test('reflection persists independently of a later decision failure and is not replayed on resume', async () => {
	let saved;
	let progress;
	await assert.rejects(resolveTurn(world(), { kind: 'speak', text: '약속할게.', targetId: 'harin' }, {
		async reflect(_, context) { return update(context); },
		async decide() { throw new Error('restart after reflection'); }
	}, () => {}, { onProgress: (world, position) => { saved = structuredClone(world); progress = structuredClone(position); } }), /restart/);
	assert.equal(actor(saved, 'harin').relationships.player.trust, 35);
	const cursor = actor(saved, 'harin').reflectedThroughEventId;
	let reflectedHarin = false;
	const result = await resolveTurn(saved, { kind: 'speak', text: '약속할게.', targetId: 'harin' }, {
		async reflect(state) { if (state.self.id === 'harin') reflectedHarin = true; return noop; },
		async decide() { return { act: false, model: 'fake' }; }
	}, () => {}, { progress });
	assert.equal(reflectedHarin, false);
	assert.equal(actor(result, 'harin').reflectedThroughEventId, cursor);
	assert.equal(result.state.tick, 1);
	assert.equal(actor(result, 'harin').relationships.player.trust, 35);
});

test('new chat discards a stale reflection; private changes never wake other actors', async () => {
	const inputs = [];
	let injected = false;
	let calls = 0;
	const result = await resolveTurn(world(), { kind: 'speak', text: '먼저 말할게.', targetId: null }, {
		async reflect(state, context) {
			calls++;
			if (!injected) { injected = true; inputs.push({ kind: 'speak', text: '잠깐, 내 말을 먼저 들어줘.', targetId: null }); return update(context); }
			return noop;
		},
		async decide() { return { act: false, model: 'fake' }; }
	}, () => {}, { nextInput: (index) => inputs[index] ?? null });
	assert.equal(calls, 3);
	assert.equal(result.state.tick, 2);
	assert.equal(actor(result, 'harin').relationships.player.trust, 80);
	assert.equal(actor(result, 'seoyeon').relationships.player, undefined);
	assert.equal(result.state.events.filter((event) => event.kind === 'wait' && event.actorId !== 'player').length, 2);
});

test('snapshot validation checks relation references, evidence ownership and cursors; saves preserve private state', () => {
	const stage = world();
	beginTurn(stage, { kind: 'speak', text: '확인해 볼게.', targetId: null });
	const harin = actor(stage, 'harin');
	applyReflection(harin, update(reflectionContext(stage, harin)), reflectionContext(stage, harin));
	assert.deepEqual(validateState(JSON.parse(JSON.stringify(stage.state)), stage.definition), JSON.parse(JSON.stringify(stage.state)));
	const bad = structuredClone(stage.state);
	bad.instances.find((entry) => entry.id === 'jieun').relationships.player = structuredClone(harin.relationships.player);
	assert.throws(() => validateState(bad, stage.definition), /목격하지/);
	const badCursor = structuredClone(stage.state); badCursor.instances[0].reflectedThroughEventId = 'unknown';
	assert.throws(() => validateState(badCursor, stage.definition), /관찰 해석 위치/);
	const definition = exampleWorld(); definition.spawns[0].relationships.seoyeon = unknownRelationship();
	assert.throws(() => validateDefinition(definition), /다른 캐릭터/);
});
