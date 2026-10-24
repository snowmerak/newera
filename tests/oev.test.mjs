import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDirector, getModelCatalog, modelSettings } from '../src/lib/server/oev.ts';
import { inactivityContext, outfitContext, participationContext, performanceContext, reflectionInput } from '../src/lib/theater/inference-context.ts';

const originalFetch = globalThis.fetch;
const originalRetries = process.env.NEWERA_MAX_RETRIES;
const originalProviders = process.env.NEWERA_PROVIDER_CONFIG;
const providerDirectory = mkdtempSync(join(tmpdir(), 'newera-oev-unit-'));
process.env.NEWERA_PROVIDER_CONFIG = join(providerDirectory, 'providers.json');
process.env.NEWERA_MAX_RETRIES = '0';
test.after(() => {
	if (originalRetries === undefined) delete process.env.NEWERA_MAX_RETRIES; else process.env.NEWERA_MAX_RETRIES = originalRetries;
	if (originalProviders === undefined) delete process.env.NEWERA_PROVIDER_CONFIG; else process.env.NEWERA_PROVIDER_CONFIG = originalProviders;
	rmSync(providerDirectory, { recursive: true, force: true });
});
const actions = [
	{ id: 'speak:player', kind: 'speak', targetId: 'player', label: 'speak to player' }
];
const state = { scene: 'room', self: { id: 'actor' } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function provider(options = {}) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), body, signal: init.signal });
		if (String(url).endsWith('/models')) return json({ data: [{ id: 'embed', task: 'embedding' }, { id: 'actor-model', task: 'generation' }, { id: 'gemma4-26b', task: 'generation' }] });
		if (String(url).endsWith('/systemone')) {
			const key = Object.keys(body.questions)[0];
			return json({ answers: { [key]: { type: key === 'inactivity' ? options.inactivityType ?? 'choice' : options.type ?? 'choice', choice: key === 'identity_check' ? 'consistent' : key === 'performance_check' ? options.reviewChoice ?? 'accept' : key === 'inactivity' ? options.inactivity ?? 'watch' : options.choice ?? 'act' } } });
		}
		if (body.response_format?.json_schema?.name === 'character_reflection') {
			return json({ choices: [{ finish_reason: options.reflectionFinishReason ?? 'stop', message: { content: JSON.stringify(options.reflectionOutput ?? { relationshipUpdates: [], memoUpdate: null }) } }] });
		}
		const output = { actionId: 'speak:player', targetId: 'player', narrative: null, utterance: '반가워요. 같이 준비할까요?', memoUpdate: null, ...options.output };
		return json({ choices: [{ finish_reason: options.finishReason ?? 'stop', message: { content: options.content ?? JSON.stringify(output) } }] });
	};
	return calls;
}

test('a structurally valid exact repeat skips model reviews and regeneration for the host to choose silent idle', async () => {
	const calls = provider({ reviewChoice: 'revise' });
	const previous = { eventId: 'old', tick: 1, actorId: 'actor', targetId: 'player', sceneId: 'room', kind: 'speak', body: { narrative: null, utterance: '반가워요. 같이 준비할까요?' } };
	try {
		const director = await createDirector(new AbortController().signal);
		const output = await director.perform({ ...state, scene: { id: 'room' } }, actions, '', previous);
		assert.equal(output.utterance, previous.body.utterance);
		assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['models', 'completions']);
	} finally { globalThis.fetch = originalFetch; }
});

test('each inference receives only its own context and keeps witnessed actions with their actual authors', () => {
	const events = Array.from({ length: 20 }, (_, index) => ({ eventId: `event-${index}`, tick: index, actorId: index === 12 ? 'player' : index === 13 ? 'actor' : 'peer', targetId: 'light', kind: 'interact', body: { narrative: `실제 행동 ${index}`, utterance: null }, changes: { on: false } }));
	const input = {
		world: { rules: 'detailed-world-rules' }, scene: { id: 'room', name: '연습실', description: '조용한 방', exits: ['hall'] }, time: { tick: 20 }, player: { id: 'player', present: true },
		self: { id: 'actor', name: '서연', personality: '조심스럽다.', goals: ['불을 확인한다.'], state: { knownFacts: '내가 끈 것이 아니다.' }, appearance: '회색 교복', appearanceSelection: { day: 1 }, clothingPreferences: '편한 옷', foodPreferences: '귤', memories: events, memo: { summary: '과거 요약', currentIntention: '잠시 쉬기', feelings: ['걱정'], openThreads: [] }, relationships: { peer: { trust: 30, impression: '관찰 중', evidenceEventIds: ['old'] }, absent: { trust: 50, impression: 'off-scene-private-impression' } }, reflectedThroughEventId: 'cursor' },
		present: [{ id: 'peer', name: '하린', kind: 'character', appearance: '파란 셔츠' }, { id: 'light', name: '조명', kind: 'object', state: { on: false } }], recentEvents: events.slice(-12)
	};
	const before = structuredClone(input);
	const participation = participationContext(input);
	assert.ok(!('world' in participation));
	assert.ok(!('memories' in participation.self));
	assert.ok(!('appearanceSelection' in participation.self));
	assert.ok(!('clothingPreferences' in participation.self));
	assert.ok(!('foodPreferences' in participation.self));
	assert.ok(!('reflectedThroughEventId' in participation.self));
	assert.deepEqual(Object.keys(participation.self.relationships), ['peer']);
	assert.ok(!('evidenceEventIds' in participation.self.relationships.peer));
	assert.equal(participation.recentEvents.length, 8, 'six recent events plus the latest player and own records');
	assert.equal(new Set(participation.recentEvents.map(event => event.eventId)).size, 8);
	assert.deepEqual(participation.recentEvents[0], { ...events[12], actorName: '플레이어', targetName: '조명', addressedToSelf: false }, 'preserve authorship, exact body and object effects');
	assert.deepEqual(participation.present.find(actor => actor.id === 'light').state, { on: false });
	const inactivity = inactivityContext(input);
	assert.ok(!('relationships' in inactivity.self));
	assert.ok(!('goals' in inactivity.self));
	assert.ok(!('summary' in inactivity.self.memo));
	assert.equal(inactivity.self.memo.currentIntention, '잠시 쉬기');
	assert.equal(inactivity.recentEvents.length, 5);
	const outfit = outfitContext(input);
	assert.equal(outfit.self.clothingPreferences, '편한 옷');
	assert.ok(!('state' in outfit.self));
	assert.ok(!('recentEvents' in outfit));
	assert.ok(!('relationships' in outfit.self));
	assert.ok(!('present' in outfit));
	const performance = performanceContext(input);
	assert.deepEqual(performance.world, input.world, 'world rules remain available for detailed generation');
	assert.equal(performance.self.foodPreferences, '귤');
	assert.equal(performance.present[0].appearance, '파란 셔츠');
	assert.ok(!('memories' in performance.self));
	const reflection = reflectionInput(input, { newEvents: events.slice(-2), evidenceEvents: events.slice(-4), targets: [{ id: 'peer', name: '하린' }] });
	assert.deepEqual(reflection.newEvents.map(event => event.eventId), ['event-18', 'event-19']);
	assert.deepEqual(reflection.pastEvents.map(event => event.eventId), ['event-16', 'event-17']);
	assert.ok(!('recentEvents' in reflection));
	assert.ok(!('memories' in reflection.self));
	assert.deepEqual(input, before, 'projection never mutates saved character data');
});

test('retrying an inactivity failure does not infer successful participation again', async () => {
	await retrySettings(async () => {
		const calls = provider({ choice: 'wait', inactivity: 'continue' });
		const success = globalThis.fetch;
		let inactivityAttempts = 0;
		globalThis.fetch = async (url, init) => {
			const body = init.body && JSON.parse(init.body);
			if (body?.questions?.inactivity && ++inactivityAttempts === 1) return json({ error: 'temporary' }, 503);
			return success(url, init);
		};
		const result = await (await createDirector(new AbortController().signal)).decide(state);
		assert.deepEqual(result, { act: false, inactivity: 'continue', model: 'gemma4-26b' });
		assert.equal(calls.filter(call => call.body?.questions?.participation).length, 1);
		assert.equal(inactivityAttempts, 2);
		assert.equal(calls.filter(call => call.url.endsWith('/chat/completions')).length, 0);
	});
});

test('outfit selection uses the session decision model and exact authored finite choices', async () => {
	const outfits = [{ id: 'uniform', name: '교복', appearance: '회색 교복', context: '수업' }, { id: 'casual', name: '사복', appearance: '파란 셔츠', context: '휴일' }];
	const calls = provider({ choice: 'uniform' });
	try {
		const director = await createDirector(new AbortController().signal, { decisionModel: 'actor-model', textModel: 'gemma4-26b' });
		assert.deepEqual(await director.chooseAppearance(state, outfits), { outfitId: 'uniform', model: 'actor-model' });
		assert.equal(calls[1].body.model, 'actor-model');
		assert.deepEqual(Object.keys(calls[1].body.questions), ['outfit']);
		assert.deepEqual(calls[1].body.questions.outfit.criteria, Object.fromEntries(outfits.map(({ id, ...rest }) => [id, rest])));
		for (const options of [{ choice: 'invented' }, { choice: 'uniform', type: 'text' }]) {
			provider(options);
			await assert.rejects((await createDirector(new AbortController().signal)).chooseAppearance(state, outfits));
		}
	} finally { globalThis.fetch = originalFetch; }
});

test('binary participation precedes structured action inference with Gemma4 26B', async () => {
	const calls = provider();
	try {
		const director = await createDirector(new AbortController().signal);
		assert.deepEqual(await director.decide(state), { act: true, model: 'gemma4-26b' });
		assert.match((await director.perform(state, actions)).utterance, /반가워요/);
		assert.deepEqual(Object.keys(calls[1].body.questions), ['participation']);
		assert.deepEqual(Object.keys(calls[1].body.questions.participation.criteria), ['act', 'wait']);
		assert.equal(calls[1].body.state.self.id, state.self.id);
		assert.ok(!Object.hasOwn(calls[1].body.state, 'world'));
		assert.equal(calls[1].body.model, 'gemma4-26b');
		assert.equal(calls[2].body.model, 'gemma4-26b');
		assert.equal(calls[2].body.reasoning_effort, 'none');
		assert.equal(calls[2].body.max_completion_tokens, 512);
		assert.equal(calls[2].body.response_format.type, 'json_schema');
		assert.equal(calls[2].body.response_format.json_schema.strict, true);
		assert.deepEqual(JSON.parse(calls[2].body.messages[1].content).availableActions, actions);
		assert.deepEqual(calls[2].body.response_format.json_schema.schema.properties.actionId.enum, ['speak:player']);
		assert.deepEqual(calls[2].body.response_format.json_schema.schema.properties.targetId.enum, ['player']);
		assert.equal(calls[2].body.response_format.json_schema.schema.properties.actorId, undefined);
	} finally { globalThis.fetch = originalFetch; }
});

test('writing style reaches only performance generation and keeps the strict action schema', async () => {
	const calls = provider();
	const style = '담백한 현재형. 과한 비유 없이 구체적인 동작을 쓴다.';
	try {
		const director = await createDirector(new AbortController().signal);
		await director.decide(state);
		const output = await director.perform(state, actions, `  ${style}\n`);
		assert.equal(output.targetId, 'player');
		assert.ok(!JSON.stringify(calls[1].body).includes(style));
		const generation = calls[2].body;
		assert.equal(generation.messages.length, 2);
		assert.equal(generation.messages[0].role, 'system');
		assert.ok(generation.messages[0].content.includes(style));
		assert.match(generation.messages[0].content, /표현 방식에만/);
		assert.match(generation.messages[0].content, /narrative와 utterance의 분리/);
		assert.equal(generation.response_format.json_schema.strict, true);
		assert.deepEqual(JSON.parse(generation.messages[1].content).availableActions, actions);
		await director.perform(state, actions, ' \n ');
		assert.equal(calls[5].body.messages.length, 2, 'empty guidance retains the original default prompt');
		assert.ok(!calls[5].body.messages[0].content.includes(style));
	} finally { globalThis.fetch = originalFetch; }
});

test('reflection uses the selected generation model and strict schema before binary participation', async () => {
	const event = { eventId: 'witnessed-1', actorId: 'player', targetId: null, kind: 'speak', body: { narrative: null, utterance: '약속할게.' } };
	const context = { targets: [{ id: 'player', name: '플레이어' }], newEvents: [event], evidenceEvents: [event] };
	const output = { relationshipUpdates: [{ targetId: 'player', changes: [{ field: 'trust', value: 45 }], impression: '직접 확인하고 싶다.', evidenceEventIds: ['witnessed-1'] }], memoUpdate: null };
	const calls = provider({ reflectionOutput: output, choice: 'wait' });
	try {
		const director = await createDirector(new AbortController().signal, { decisionModel: 'actor-model', textModel: 'gemma4-26b' });
		assert.deepEqual(await director.reflect(state, context), output);
		assert.equal((await director.decide(state)).act, false);
		const body = calls[1].body;
		assert.equal(body.model, 'gemma4-26b');
		assert.equal(body.max_completion_tokens, 1024);
		assert.equal(body.response_format.json_schema.name, 'character_reflection');
		assert.equal(body.response_format.json_schema.strict, true);
		assert.deepEqual(JSON.parse(body.messages[1].content).newEvents, [event]);
		assert.deepEqual(Object.keys(calls[2].body.questions), ['participation']);
		assert.deepEqual(Object.keys(calls[3].body.questions), ['inactivity']);
		assert.equal(calls[2].body.model, 'actor-model');
		for (const invalid of [{ ...output, actorId: 'other' }, { relationshipUpdates: [{ ...output.relationshipUpdates[0], evidenceEventIds: ['unseen'] }], memoUpdate: null }]) {
			provider({ reflectionOutput: invalid });
			const director = await createDirector(new AbortController().signal);
			await assert.rejects(director.reflect(state, context));
		}
		provider({ reflectionFinishReason: 'length' });
		await assert.rejects((await createDirector(new AbortController().signal)).reflect(state, context), /정상적으로 완료/);
	} finally { globalThis.fetch = originalFetch; }
});

test('reflection retries only the failed interpretation without invoking participation', async () => {
	await retrySettings(async () => {
		const event = { eventId: 'new-1', actorId: 'player', targetId: null, kind: 'speak', body: { narrative: null, utterance: '안녕' } };
		const context = { targets: [{ id: 'player', name: '플레이어' }], newEvents: [event], evidenceEvents: [event] };
		const calls = provider(); const success = globalThis.fetch; let attempts = 0;
		globalThis.fetch = async (url, init) => {
			if (String(url).endsWith('chat/completions') && ++attempts === 1) return json({ error: 'temporary' }, 502);
			return success(url, init);
		};
		const director = await createDirector(new AbortController().signal);
		assert.deepEqual(await director.reflect(state, context), { relationshipUpdates: [], memoUpdate: null });
		assert.equal(attempts, 2);
		assert.equal(calls.filter((call) => call.url.endsWith('systemone')).length, 0);
	});
});

test('old-only relationship evidence is forbidden in the schema and retries receive corrective guidance', async () => {
	await retrySettings(async () => {
		const event = (eventId) => ({ eventId, actorId: 'player', targetId: null, kind: 'speak', body: { narrative: null, utterance: eventId } });
		const old = event('already-processed'), fresh = event('new-greeting');
		const context = { targets: [{ id: 'player', name: '플레이어' }], newEvents: [fresh], evidenceEvents: [old, fresh] };
		const oldOnly = { relationshipUpdates: [{ targetId: 'player', changes: [{ field: 'trust', value: 70 }], impression: null, evidenceEventIds: [old.eventId] }], memoUpdate: null };
		for (const serverRejects of [false, true]) {
			const requests = [];
			provider(); const success = globalThis.fetch;
			globalThis.fetch = async (url, init) => {
				if (!String(url).endsWith('/chat/completions')) return success(url, init);
				const body = JSON.parse(init.body); requests.push(body);
				if (requests.length === 1) {
					if (serverRejects) return json({ error: { code: 'invalid_model_output', message: 'schema validation failed' } }, 502);
					return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(oldOnly) } }] });
				}
				assert.match(body.messages.at(-1).content, /수정 요청 1/);
				assert.ok(body.messages.at(-1).content.includes(fresh.eventId));
				return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ relationshipUpdates: [], memoUpdate: null }) } }] });
			};
			assert.deepEqual(await (await createDirector(new AbortController().signal)).reflect(state, context), { relationshipUpdates: [], memoUpdate: null });
			assert.equal(requests.length, 2);
			const evidenceSchema = requests[0].response_format.json_schema.schema.properties.relationshipUpdates.items.properties.evidenceEventIds;
			assert.deepEqual(evidenceSchema.items.enum, [old.eventId, fresh.eventId]);
			assert.deepEqual(evidenceSchema.contains.enum, [fresh.eventId]);
			assert.equal(evidenceSchema.minContains, 1);
			const input = JSON.parse(requests[0].messages[1].content);
			assert.deepEqual(input.newEvents, [fresh]);
			assert.deepEqual(input.pastEvents, [old]);
			assert.ok(!Object.hasOwn(input, 'evidenceEvents'));
			assert.deepEqual(context.newEvents, [fresh], 'a rejected proposal cannot rewrite evidence');
		}
	});
});

test('participation accepts only the two typed choices', async () => {
	try {
		provider({ choice: 'wait' });
		let director = await createDirector(new AbortController().signal);
		assert.equal((await director.decide(state)).act, false);
		provider({ choice: 'not-a-candidate' });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.decide(state), /후보/);
		provider({ type: 'noul' });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.decide(state), /타입/);
	} finally { globalThis.fetch = originalFetch; }
});

test('only non-participation requests the separate watch, continue or idle decision', async () => {
	try {
		for (const inactivity of ['watch', 'continue', 'idle']) {
			const calls = provider({ choice: 'wait', inactivity });
			const director = await createDirector(new AbortController().signal);
			assert.deepEqual(await director.decide(state), { act: false, inactivity, model: 'gemma4-26b' });
			assert.equal(calls.length, 3, 'one lookup, participation, then inactivity only when waiting');
			assert.deepEqual(Object.keys(calls[1].body.questions.participation.criteria), ['act', 'wait']);
			assert.deepEqual(Object.keys(calls[2].body.questions), ['inactivity']);
			assert.deepEqual(Object.keys(calls[2].body.questions.inactivity.criteria), ['watch', 'continue', 'idle']);
		}
		for (const options of [{ inactivity: 'invented' }, { inactivityType: 'noul' }]) {
			provider({ choice: 'wait', ...options });
			await assert.rejects((await createDirector(new AbortController().signal)).decide(state));
		}
		const calls = provider({ choice: 'act', inactivity: 'unused' });
		assert.equal((await (await createDirector(new AbortController().signal)).decide(state)).act, true);
		assert.equal(calls.length, 2, 'acting skips the inactivity inference entirely');
	} finally { globalThis.fetch = originalFetch; }
});

test('session models override defaults independently and embedding models cannot be selected', async () => {
	const calls = provider();
	try {
		const catalog = await getModelCatalog(new AbortController().signal);
		assert.deepEqual(catalog.models, ['actor-model', 'gemma4-26b']);
		const director = await createDirector(new AbortController().signal, { decisionModel: 'actor-model', textModel: 'gemma4-26b' });
		await director.decide(state);
		await director.perform(state, actions);
		assert.equal(calls.find((call) => call.url.endsWith('systemone')).body.model, 'actor-model');
		assert.equal(calls.find((call) => call.url.endsWith('chat/completions')).body.model, 'gemma4-26b');
		await assert.rejects(createDirector(new AbortController().signal, { decisionModel: 'embed', textModel: 'gemma4-26b' }), /목록에 없습니다/);
	} finally { globalThis.fetch = originalFetch; }
});

test('a generated role swap is reviewed and regenerated before it can be returned to the scene', async () => {
	await retrySettings(async () => {
		const calls = provider(); const success = globalThis.fetch;
		let generated = 0, reviewed = 0;
		globalThis.fetch = async (url, init) => {
			const body = init.body && JSON.parse(init.body);
			if (body?.questions?.performance_check) {
				reviewed++;
				assert.equal(body.state.identity.speakerName, '양순자');
				return json({ answers: { performance_check: { type: 'choice', choice: reviewed === 1 ? 'revise' : 'accept' } } });
			}
			if (String(url).endsWith('/chat/completions')) {
				generated++;
				if (generated === 2) assert.match(body.messages.at(-1).content, /수정 요청 1/);
				return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: null, utterance: generated === 1 ? '저는 오늘 전학 왔어요.' : '서우야, 색지는 누구에게 전달하면 될까?', memoUpdate: null }) } }] });
			}
			return success(url, init);
		};
		const expression = await (await createDirector(new AbortController().signal)).perform({ ...state, self: { id: 'sun-ja', name: '양순자' } }, actions);
		assert.equal(expression.utterance, '서우야, 색지는 누구에게 전달하면 될까?');
		assert.equal(generated, 2); assert.equal(reviewed, 2);
	});
});

test('unresolved player-name placeholders never become an executable expression', async () => {
	for (const utterance of ['제 이름은 [플레이어의 이름]이에요.', '내 이름은 [플레이어 이름]이야.', '저는 {{player_name}}입니다.']) {
		provider({ output: { utterance } });
		try { await assert.rejects((await createDirector(new AbortController().signal)).perform(state, actions), /자리표시자/); }
		finally { globalThis.fetch = originalFetch; }
	}
});

async function retrySettings(operation) {
	const original = Object.fromEntries(['NEWERA_MAX_RETRIES', 'NEWERA_RETRY_BASE_MS', 'NEWERA_RETRY_MAX_MS'].map((key) => [key, process.env[key]]));
	Object.assign(process.env, { NEWERA_MAX_RETRIES: '2', NEWERA_RETRY_BASE_MS: '20', NEWERA_RETRY_MAX_MS: '50' });
	try { await operation(); }
	finally { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } globalThis.fetch = originalFetch; }
}

test('502 and invalid JSON regenerate only the failed call with exponential backoff', async () => {
	await retrySettings(async () => {
		const calls = provider();
		const success = globalThis.fetch;
		const attempts = [];
		globalThis.fetch = async (url, init) => {
			if (String(url).endsWith('chat/completions')) {
				attempts.push({ body: JSON.parse(init.body), time: performance.now() });
				if (attempts.length === 1) return json({ error: { code: 'invalid_model_output', message: 'Expecting value' } }, 502);
				if (attempts.length === 2) return json({ choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] });
			}
			return success(url, init);
		};
		const director = await createDirector(new AbortController().signal);
		await director.decide(state);
		assert.equal((await director.perform(state, actions)).actionId, 'speak:player');
		assert.equal(attempts.length, 3);
		assert.deepEqual(attempts.map((attempt) => attempt.body.response_format), Array(3).fill(attempts[0].body.response_format));
		assert.match(attempts[1].body.messages.at(-1).content, /수정 요청 1/);
		assert.match(attempts[2].body.messages.at(-1).content, /수정 요청 2/);
		assert.ok(attempts[1].time - attempts[0].time >= 14);
		assert.ok(attempts[2].time - attempts[1].time >= 29);
		assert.equal(calls.filter((call) => call.body?.questions?.participation).length, 1);
	});
});

test('retry count is bounded, client errors fail immediately and cancellation interrupts backoff', async () => {
	await retrySettings(async () => {
		for (const status of [502, 400, 401, 403, 404, 422, 501]) {
			provider(); const success = globalThis.fetch; let attempts = 0;
			globalThis.fetch = async (url, init) => {
				if (String(url).endsWith('chat/completions')) { attempts++; return json({ error: 'failed' }, status); }
				return success(url, init);
			};
			const director = await createDirector(new AbortController().signal);
			await assert.rejects(director.perform(state, actions), status === 502 ? /3회 시도 후 실패/ : new RegExp(String(status)));
			assert.equal(attempts, status === 502 ? 3 : 1);
		}
		provider(); const success = globalThis.fetch; let attempts = 0;
		const controller = new AbortController();
		globalThis.fetch = async (url, init) => {
			if (String(url).endsWith('chat/completions')) { attempts++; setTimeout(() => controller.abort(new Error('cancelled')), 5); return json({ error: 'busy' }, 503); }
			return success(url, init);
		};
		const director = await createDirector(controller.signal);
		await assert.rejects(director.perform(state, actions), /cancelled/);
		assert.equal(attempts, 1);
	});
});

test('connection failures, throttling and malformed typed decisions can recover', async () => {
	await retrySettings(async () => {
		provider(); const success = globalThis.fetch;
		let catalogAttempts = 0; let decisionAttempts = 0; let generationAttempts = 0;
		globalThis.fetch = async (url, init) => {
			if (String(url).endsWith('/models') && ++catalogAttempts === 1) return json({ error: 'rate limited' }, 429);
			if (String(url).endsWith('/systemone') && ++decisionAttempts === 1) return json({ answers: { participation: { type: 'choice', choice: 'invalid' } } });
			if (String(url).endsWith('/chat/completions') && ++generationAttempts === 1) throw new TypeError('fetch failed');
			return success(url, init);
		};
		const director = await createDirector(new AbortController().signal);
		assert.equal((await director.decide(state)).act, true);
		await director.perform(state, actions);
		assert.deepEqual([catalogAttempts, decisionAttempts, generationAttempts], [2, 4, 2]);
	});
});

test('a changed scene fences off another retry even before the heartbeat cancels the request', async () => {
	await retrySettings(async () => {
		provider(); const success = globalThis.fetch;
		let current = true; let attempts = 0;
		globalThis.fetch = async (url, init) => {
			if (String(url).endsWith('chat/completions')) { attempts++; current = false; return json({ error: 'offline' }, 503); }
			return success(url, init);
		};
		const director = await createDirector(new AbortController().signal, undefined, () => { if (!current) throw new Error('scene changed'); });
		await assert.rejects(director.perform(state, actions), /scene changed/);
		assert.equal(attempts, 1);
	});
});

test('decision requests allow long inference and correlate transport logs without recording private context', async (t) => {
	const previousTimeout = process.env.NEWERA_DECISION_TIMEOUT_MS;
	const previousConfig = process.env.NEWERA_MODEL_CONFIG;
	const deadlines = [];
	const logs = [];
	const originalTimeout = AbortSignal.timeout;
	t.mock.method(AbortSignal, 'timeout', (ms) => { deadlines.push(ms); return originalTimeout(ms); });
	t.mock.method(console, 'info', (...args) => logs.push(args));
	t.mock.method(console, 'warn', (...args) => logs.push(args));
	try {
		delete process.env.NEWERA_DECISION_TIMEOUT_MS;
		process.env.NEWERA_MODEL_CONFIG = join(tmpdir(), `newera-no-config-${crypto.randomUUID()}.json`);
		provider();
		const director = await createDirector(new AbortController().signal);
		await director.decide({ ...state, privateContext: 'do-not-log-this-private-memory' });
		assert.deepEqual(deadlines, [120000, 120000], 'discovery and typed decisions must use the 120-second default');
		const started = logs.find(([label, data]) => label === '[OEV] 요청 시작' && data.method === 'POST')[1];
		const completed = logs.find(([label, data]) => label === '[OEV] 응답 완료' && data.requestId === started.requestId)[1];
		assert.ok(started.endpoint.endsWith('/systemone'));
		assert.ok(started.bytes > 0);
		assert.equal(started.timeoutMs, 120000);
		assert.equal(completed.status, 200);
		assert.ok(completed.elapsedMs >= 0);
		assert.ok(!JSON.stringify(logs).includes('do-not-log-this-private-memory'));

		process.env.NEWERA_DECISION_TIMEOUT_MS = '10';
		provider(); const success = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			if (!String(url).endsWith('/systemone')) return success(url, init);
			return new Promise((resolve, reject) => {
				const keepAlive = setTimeout(() => reject(new Error('timeout was not enforced')), 1000);
				init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
			});
		};
		await assert.rejects((await createDirector(new AbortController().signal)).decide(state), /대기 시간\(0\.01초\)/);
		const failure = logs.findLast(([label]) => label === '[OEV] 요청 실패')[1];
		assert.equal(failure.reason, 'timeout');
		assert.equal(failure.timeoutMs, 10);
		assert.ok(logs.some(([label, data]) => label === '[OEV] 요청 시작' && data.requestId === failure.requestId));
	} finally {
		globalThis.fetch = originalFetch;
		if (previousTimeout === undefined) delete process.env.NEWERA_DECISION_TIMEOUT_MS; else process.env.NEWERA_DECISION_TIMEOUT_MS = previousTimeout;
		if (previousConfig === undefined) delete process.env.NEWERA_MODEL_CONFIG; else process.env.NEWERA_MODEL_CONFIG = previousConfig;
	}
});

test('request timeout can retry while cancellation of the parent remains final', async () => {
	await retrySettings(async () => {
		const previousTimeout = process.env.NEWERA_LLM_TIMEOUT_MS;
		process.env.NEWERA_LLM_TIMEOUT_MS = '10';
		try {
			provider(); const success = globalThis.fetch; let attempts = 0;
			globalThis.fetch = async (url, init) => {
				if (String(url).endsWith('chat/completions') && ++attempts === 1) {
					return new Promise((resolve, reject) => {
						const keepAlive = setTimeout(() => reject(new Error('timeout was not enforced')), 1000);
						init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
					});
				}
				return success(url, init);
			};
			const director = await createDirector(new AbortController().signal);
			assert.equal((await director.perform(state, actions)).actionId, 'speak:player');
			assert.equal(attempts, 2);
		} finally { if (previousTimeout === undefined) delete process.env.NEWERA_LLM_TIMEOUT_MS; else process.env.NEWERA_LLM_TIMEOUT_MS = previousTimeout; }
	});
});

test('generation selects detailed actions beyond the typed endpoint choice limit', async () => {
	const many = Array.from({ length: 91 }, (_, index) => ({ id: `speak:${index}`, kind: 'speak', targetId: `${index}`, label: `target ${index}` }));
	const calls = provider({ output: { actionId: 'speak:90', targetId: '90' } });
	try {
		const director = await createDirector(new AbortController().signal);
		await director.decide(state);
		assert.equal((await director.perform(state, many)).actionId, 'speak:90');
		const decisions = calls.filter((call) => call.body?.questions?.participation);
		assert.equal(decisions.length, 1);
		assert.equal(calls[2].body.response_format.json_schema.schema.properties.actionId.enum.length, 91);
	} finally { globalThis.fetch = originalFetch; }
});

test('truncated generation cannot become an executed utterance', async () => {
	provider({ finishReason: 'length' });
	try {
		const director = await createDirector(new AbortController().signal);
		await assert.rejects(director.perform(state, actions), /정상적으로 완료/);
	} finally { globalThis.fetch = originalFetch; }
});

test('malformed JSON, unknown actions and invalid action payloads cannot execute', async () => {
	try {
		for (const [options, pattern] of [
			[{ content: 'plain speech' }, /JSON/],
			[{ output: { actionId: 'speak:offstage' } }, /실행할 수 없는 행동/],
			[{ output: { targetId: 'someone-else' } }, /대상/],
			[{ output: { actorId: 'player' } }, /허용되지 않거나 누락/],
			[{ output: { utterance: null } }, /대사가 필요/],
			[{ output: { effects: { open: true } } }, /허용되지 않거나 누락/],
			[{ output: { memoUpdate: { summary: 'only summary' } } }, /개인 메모/]
		]) {
			provider(options);
			const director = await createDirector(new AbortController().signal);
			await assert.rejects(director.perform(state, actions), pattern);
		}
		const interact = [{ id: 'interact:light:on', kind: 'interact', targetId: 'light', interactionId: 'on', label: 'turn on' }];
		provider({ output: { actionId: interact[0].id, targetId: 'light', narrative: null, utterance: null } });
		let director = await createDirector(new AbortController().signal);
		await assert.rejects(director.perform(state, interact), /묘사가 필요/);
		provider({ output: { actionId: interact[0].id, targetId: 'light', narrative: '스위치를 누른다.' } });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.perform(state, interact), /말하기 행동에서만/);
	} finally { globalThis.fetch = originalFetch; }
});

test('model config reload validates a complete candidate and retains the last valid settings', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'newera-model-config-'));
	const originalPath = process.env.NEWERA_MODEL_CONFIG;
	try {
		process.env.NEWERA_MODEL_CONFIG = join(scratch, 'models.json');
		writeFileSync(process.env.NEWERA_MODEL_CONFIG, JSON.stringify({ baseUrl: 'http://example.test/v1', textModel: 'one', maxOutputTokens: 300 }));
		assert.equal(modelSettings().textModel, 'one');
		writeFileSync(process.env.NEWERA_MODEL_CONFIG, JSON.stringify({ baseUrl: 'http://example.test/v1', textModel: 'two', maxOutputTokens: 600 }));
		assert.equal(modelSettings().maxOutputTokens, 600);
		writeFileSync(process.env.NEWERA_MODEL_CONFIG, JSON.stringify({ textModel: 'two', maxRetries: 1, retryBaseMs: 5, retryMaxMs: 10 }));
		assert.equal(modelSettings().maxRetries, 1);
		writeFileSync(process.env.NEWERA_MODEL_CONFIG, JSON.stringify({ textModel: 'broken', maxRetries: 6 }));
		assert.equal(modelSettings().maxRetries, 1);
		writeFileSync(process.env.NEWERA_MODEL_CONFIG, JSON.stringify({ textModel: 'broken', retryBaseMs: 20, retryMaxMs: 10 }));
		assert.equal(modelSettings().retryBaseMs, 5);
		writeFileSync(process.env.NEWERA_MODEL_CONFIG, JSON.stringify({ textModel: 'broken', maxOutputTokens: -1 }));
		assert.equal(modelSettings().textModel, 'two');
	} finally {
		if (originalPath === undefined) delete process.env.NEWERA_MODEL_CONFIG; else process.env.NEWERA_MODEL_CONFIG = originalPath;
		if (resolve(scratch).startsWith(resolve(tmpdir()) + '\\') && scratch.includes('newera-model-config-')) rmSync(scratch, { recursive: true, force: true });
	}
});
