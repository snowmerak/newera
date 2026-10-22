import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimatedHistoryTokens, generationHistoryEvents, limitGenerationHistory } from '../src/lib/theater/generation-history.ts';
import { inactivityContext, outfitContext, participationContext, performanceContext, performanceReviewContext, reflectionInput } from '../src/lib/theater/inference-context.ts';
import { createDirector, modelSettings } from '../src/lib/server/oev.ts';

const event = (id, text = '교실로 같이 가자.', kind = 'speak', sceneId = 'gate') => ({ id, tick: 1, sceneId, kind, actorId: 'seo', targetId: 'player', text });
function fixture() {
	const events = [event('greet'), event('unseen', '들으면 안 되는 비밀'), { ...event('depart', '정문을 떠난다.', 'leave'), destinationId: 'room' }, event('arrive', '교실에 들어왔다.', 'enter', 'room')];
	return { id: 'world', definition: { scenes: [{ id: 'gate', name: '정문' }, { id: 'room', name: '교실' }] }, state: { events, instances: [{ id: 'seo', name: '서우', memories: ['greet', 'depart', 'arrive', 'orphan'].map(eventId => ({ eventId })) }] } };
}

test('generation history follows witnessed canonical event order across scenes without private or orphan records', () => {
	const world = fixture();
	const before = structuredClone(world);
	const history = generationHistoryEvents(world, 'seo');
	assert.deepEqual(history.map(event => event.eventId), ['greet', 'depart', 'arrive']);
	assert.equal(history[1].destinationId, 'room');
	assert.equal(history[2].sceneName, '교실');
	assert.equal(history[0].actorName, '서우');
	assert.equal(history[0].targetName, '플레이어');
	assert.deepEqual(world, before);
});

test('history retains the largest recent suffix that fits and counts UTF-8 JSON, names and metadata', () => {
	const events = Array.from({ length: 120 }, (_, index) => ({ eventId: String(index), actorId: 'seo', actorName: '서우', body: { narrative: null, utterance: '가나다😀abc'.repeat(20) } }));
	const budget = estimatedHistoryTokens(events.slice(-4));
	const result = limitGenerationHistory(events, budget);
	assert.deepEqual(result.events, events.slice(-4));
	assert.equal(result.window.omittedEvents, 116);
	assert.equal(result.window.estimatedTokens, estimatedHistoryTokens(result.events));
	assert.ok(result.window.estimatedTokens <= budget);
	assert.ok(estimatedHistoryTokens(events.slice(-5)) > budget);
	assert.equal(events.length, 120, 'trimming does not delete the durable transcript');
	assert.equal(limitGenerationHistory(events).window.tokenLimit, 32768);
	const large = Array.from({ length: 1000 }, (_, index) => ({ ...events[0], eventId: String(index) }));
	const standard = limitGenerationHistory(large);
	assert.equal(standard.window.truncated, true);
	assert.ok(standard.window.estimatedTokens <= 32768);
	assert.equal(standard.events.at(-1).eventId, '999');
	assert.equal(limitGenerationHistory([]).window.truncated, false);
});

test('a single oversized latest event is reported rather than silently losing the current request', () => {
	assert.throws(() => limitGenerationHistory([{ body: '가'.repeat(1000) }], 256), /최신 사건 하나/);
	assert.throws(() => limitGenerationHistory([], 0), /한도/);
});

test('only performance receives long history; every typed projection and fresh reflection stays unchanged', () => {
	const state = { self: { id: 'seo', name: '서우', memories: [] }, recentEvents: [], present: [] };
	const generationEvents = generationHistoryEvents(fixture(), 'seo');
	const enriched = { ...state, generationEvents };
	assert.deepEqual(participationContext(enriched), participationContext(state));
	assert.deepEqual(inactivityContext(enriched), inactivityContext(state));
	assert.deepEqual(outfitContext(enriched), outfitContext(state));
	assert.deepEqual(performanceReviewContext(enriched, {}), performanceReviewContext(state, {}));
	const reflection = { newEvents: [], evidenceEvents: [], targets: [] };
	assert.deepEqual(reflectionInput(enriched, reflection), reflectionInput(state, reflection));
	assert.deepEqual(performanceContext(enriched).history, generationEvents);
	assert.ok(!('generationEvents' in performanceContext(enriched)));
	assert.ok(!('recentEvents' in performanceContext(enriched)));
});

test('the next loop observation includes confirmed new actions while restores remove discarded history', () => {
	const world = fixture();
	const saved = structuredClone(world);
	world.state.events.push(event('next', '이제 대본을 꺼낸다.', 'interact', 'room'));
	world.state.instances[0].memories.push({ eventId: 'next' });
	assert.equal(generationHistoryEvents(world, 'seo').at(-1).eventId, 'next');
	assert.ok(!generationHistoryEvents(saved, 'seo').some(event => event.eventId === 'next'));
});

test('generation budget reload affects the next director, and the actual request trims history without enlarging decisions', async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'newera-generation-history-'));
	const configPath = join(directory, 'models.json');
	const oldConfig = process.env.NEWERA_MODEL_CONFIG;
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
		if (oldConfig === undefined) delete process.env.NEWERA_MODEL_CONFIG; else process.env.NEWERA_MODEL_CONFIG = oldConfig;
		rmSync(directory, { recursive: true, force: true });
	});
	process.env.NEWERA_MODEL_CONFIG = configPath;
	writeFileSync(configPath, JSON.stringify({ generationHistoryTokens: 256, maxRetries: 0 }));
	const calls = [];
	globalThis.fetch = async (url, init) => {
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), body });
		const json = data => new Response(JSON.stringify(data));
		if (String(url).endsWith('/models')) return json({ data: [{ id: 'gemma4-26b', task: 'generation' }] });
		if (body.questions) {
			const key = Object.keys(body.questions)[0];
			return json({ answers: { [key]: { type: 'choice', choice: key === 'identity_check' ? 'consistent' : key === 'performance_check' ? 'accept' : 'act' } } });
		}
		return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: null, utterance: '같이 가자.', memoUpdate: null }) } }] });
	};
	const first = await createDirector(new AbortController().signal);
	writeFileSync(configPath, JSON.stringify({ generationHistoryTokens: 32768, maxRetries: 0 }));
	const next = await createDirector(new AbortController().signal);
	const state = { self: { id: 'seo', name: '서우' }, present: [], recentEvents: [], generationEvents: Array.from({ length: 20 }, (_, i) => ({ eventId: `event-${i}`, body: { utterance: '안녕. '.repeat(40), narrative: null }, actorId: 'player', targetId: 'seo' })) };
	const actions = [{ id: 'speak:player', targetId: 'player', kind: 'speak', label: '말한다' }];
	await first.decide(state);
	await first.perform(state, actions);
	await next.perform(state, actions);
	const requests = calls.filter(call => call.body?.response_format).map(call => JSON.parse(call.body.messages[1].content));
	assert.equal(requests[0].historyWindow.tokenLimit, 256);
	assert.equal(requests[0].historyWindow.truncated, true);
	assert.equal(requests[0].history.at(-1).eventId, 'event-19');
	assert.ok(requests[0].historyWindow.estimatedTokens <= 256);
	assert.equal(requests[1].history.length, 20);
	const decisions = calls.filter(call => call.body?.questions);
	assert.ok(decisions.every(call => !('history' in call.body.state) && !('generationEvents' in call.body.state)));
	writeFileSync(configPath, JSON.stringify({ generationHistoryTokens: -1 }));
	assert.equal(modelSettings().generationHistoryTokens, 32768, 'invalid reload retains the last accepted configuration');
});
