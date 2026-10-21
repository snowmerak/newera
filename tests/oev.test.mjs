import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDirector, modelSettings } from '../src/lib/server/oev.ts';

const originalFetch = globalThis.fetch;
const actions = [
	{ id: 'wait', kind: 'wait', targetId: null, label: 'wait' },
	{ id: 'speak:player', kind: 'speak', targetId: 'player', label: 'speak to player' }
];
const state = { scene: 'room', self: { id: 'actor' } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function provider(options = {}) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), body, signal: init.signal });
		if (String(url).endsWith('/models')) return json({ data: [{ id: 'embed', task: 'embedding' }, { id: 'actor-model', task: 'generation' }] });
		if (String(url).endsWith('/systemone')) {
			const criteria = body.questions.action.criteria;
			const keys = Object.keys(criteria);
			const answers = {
				action: { type: 'choice', choice: options.choice ?? keys.at(-1) },
				react: { type: 'noul', noul: options.noul ?? 0.9 }, intensity: { type: 'score', score: options.score ?? 1.6 }
			};
			return json({ answers });
		}
		return json({ choices: [{ finish_reason: options.finishReason ?? 'stop', message: { content: '반가워요. 같이 준비할까요?' } }] });
	};
	return calls;
}

test('discovers generation models, uses typed choice/noul/score, and generates speech separately', async () => {
	const calls = provider();
	try {
		const director = await createDirector(new AbortController().signal);
		const decision = await director.decide(state, actions);
		assert.equal(decision.action.id, 'speak:player');
		assert.equal(decision.intensity, 1.6);
		assert.equal(decision.model, 'actor-model');
		assert.match(await director.speak(state, decision), /반가워요/);
		assert.deepEqual(calls[1].body.questions.react.criteria, { true: '지금 말하거나 상호작용하거나 이동할 구체적인 이유가 있다.', false: '새로 할 말이나 행동 없이 지켜보는 것이 자연스럽다.' });
		assert.equal(calls[1].body.questions.intensity.type, 'score');
		assert.equal(calls[2].body.model, 'actor-model');
		assert.equal(calls[2].body.reasoning_effort, 'none');
		assert.equal(calls[2].body.max_completion_tokens, 512);
		assert.equal(calls[2].body.response_format, undefined);
	} finally { globalThis.fetch = originalFetch; }
});

test('soft reaction signal gates actions; malformed typed outputs fail closed', async () => {
	try {
		provider({ noul: 0.1 });
		let director = await createDirector(new AbortController().signal);
		assert.equal((await director.decide(state, actions)).action.kind, 'wait');
		provider({ choice: 'not-a-candidate' });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.decide(state, actions), /후보에 없는 행동/);
		provider({ noul: 2 });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.decide(state, actions), /noul/);
		provider({ score: 3 });
		director = await createDirector(new AbortController().signal);
		await assert.rejects(director.decide(state, actions), /score/);
	} finally { globalThis.fetch = originalFetch; }
});

test('hierarchical selection preserves actions beyond the 36-choice API limit', async () => {
	const many = [actions[0], ...Array.from({ length: 91 }, (_, index) => ({ id: `speak:${index}`, kind: 'speak', targetId: `${index}`, label: `target ${index}` }))];
	const calls = provider();
	try {
		const director = await createDirector(new AbortController().signal);
		assert.equal((await director.decide(state, many)).action.id, 'speak:90');
		const decisions = calls.filter((call) => call.url.endsWith('/systemone'));
		assert.equal(decisions.length, 2);
		assert.ok(decisions.every((call) => Object.keys(call.body.questions.action.criteria).length <= 36));
		assert.equal(decisions[1].body.questions.react, undefined);
	} finally { globalThis.fetch = originalFetch; }
});

test('truncated generation cannot become an executed utterance', async () => {
	provider({ finishReason: 'length' });
	try {
		const director = await createDirector(new AbortController().signal);
		const decision = await director.decide(state, actions);
		await assert.rejects(director.speak(state, decision), /정상적으로 완료/);
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
