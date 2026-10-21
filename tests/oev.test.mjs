import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDirector, modelSettings } from '../src/lib/server/oev.ts';

const originalFetch = globalThis.fetch;
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
			return json({ answers: { participation: { type: options.type ?? 'choice', choice: options.choice ?? 'act' } } });
		}
		const output = { actionId: 'speak:player', narrative: null, utterance: '반가워요. 같이 준비할까요?', memoUpdate: null, ...options.output };
		return json({ choices: [{ finish_reason: options.finishReason ?? 'stop', message: { content: options.content ?? JSON.stringify(output) } }] });
	};
	return calls;
}

test('binary participation precedes structured action inference with Gemma4 26B', async () => {
	const calls = provider();
	try {
		const director = await createDirector(new AbortController().signal);
		assert.deepEqual(await director.decide(state), { act: true, model: 'gemma4-26b' });
		assert.match((await director.perform(state, actions)).utterance, /반가워요/);
		assert.deepEqual(Object.keys(calls[1].body.questions), ['participation']);
		assert.deepEqual(Object.keys(calls[1].body.questions.participation.criteria), ['act', 'wait']);
		assert.deepEqual(calls[1].body.state, state);
		assert.equal(calls[1].body.model, 'gemma4-26b');
		assert.equal(calls[2].body.model, 'gemma4-26b');
		assert.equal(calls[2].body.reasoning_effort, 'none');
		assert.equal(calls[2].body.max_completion_tokens, 512);
		assert.equal(calls[2].body.response_format.type, 'json_schema');
		assert.equal(calls[2].body.response_format.json_schema.strict, true);
		assert.deepEqual(JSON.parse(calls[2].body.messages[1].content).availableActions, actions);
		assert.deepEqual(calls[2].body.response_format.json_schema.schema.properties.actionId.enum, ['speak:player']);
	} finally { globalThis.fetch = originalFetch; }
});

test('participation accepts only the two typed choices', async () => {
	try {
		provider({ choice: 'wait' });
		let director = await createDirector(new AbortController().signal);
		assert.equal((await director.decide(state)).act, false);
		provider({ choice: 'not-a-candidate' });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.decide(state), /act 또는 wait/);
		provider({ type: 'noul' });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.decide(state), /타입/);
	} finally { globalThis.fetch = originalFetch; }
});

test('generation selects detailed actions beyond the typed endpoint choice limit', async () => {
	const many = Array.from({ length: 91 }, (_, index) => ({ id: `speak:${index}`, kind: 'speak', targetId: `${index}`, label: `target ${index}` }));
	const calls = provider({ output: { actionId: 'speak:90' } });
	try {
		const director = await createDirector(new AbortController().signal);
		await director.decide(state);
		assert.equal((await director.perform(state, many)).actionId, 'speak:90');
		const decisions = calls.filter((call) => call.url.endsWith('/systemone'));
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
			[{ output: { utterance: null } }, /대사가 필요/],
			[{ output: { effects: { open: true } } }, /허용되지 않거나 누락/],
			[{ output: { memoUpdate: { summary: 'only summary' } } }, /개인 메모/]
		]) {
			provider(options);
			const director = await createDirector(new AbortController().signal);
			await assert.rejects(director.perform(state, actions), pattern);
		}
		const interact = [{ id: 'interact:light:on', kind: 'interact', targetId: 'light', interactionId: 'on', label: 'turn on' }];
		provider({ output: { actionId: interact[0].id, narrative: null, utterance: null } });
		let director = await createDirector(new AbortController().signal);
		await assert.rejects(director.perform(state, interact), /묘사가 필요/);
		provider({ output: { actionId: interact[0].id, narrative: '스위치를 누른다.' } });
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
		writeFileSync(process.env.NEWERA_MODEL_CONFIG, JSON.stringify({ textModel: 'broken', maxOutputTokens: -1 }));
		assert.equal(modelSettings().textModel, 'two');
	} finally {
		if (originalPath === undefined) delete process.env.NEWERA_MODEL_CONFIG; else process.env.NEWERA_MODEL_CONFIG = originalPath;
		if (resolve(scratch).startsWith(resolve(tmpdir()) + '\\') && scratch.includes('newera-model-config-')) rmSync(scratch, { recursive: true, force: true });
	}
});
