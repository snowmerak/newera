import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aliasReference, getProviders, saveProvider, deleteProvider, resolveProviderModel, resolveProviderSnapshot } from '../src/lib/server/providers.ts';
import { createDirector, createEmbedder, discoverProviderModels, getModelCatalog, modelSettings } from '../src/lib/server/oev.ts';

const defaults = { baseUrl: 'http://legacy.test/v1' };
function environment(t) {
	const directory = mkdtempSync(join(tmpdir(), 'newera-providers-'));
	const old = process.env.NEWERA_PROVIDER_CONFIG;
	const originalFetch = globalThis.fetch;
	process.env.NEWERA_PROVIDER_CONFIG = join(directory, 'providers.json');
	t.after(() => { globalThis.fetch = originalFetch; if (old === undefined) delete process.env.NEWERA_PROVIDER_CONFIG; else process.env.NEWERA_PROVIDER_CONFIG = old; rmSync(directory, { recursive: true, force: true }); });
	return directory;
}
const config = (id, kind = 'oev', extras = {}) => ({ id, label: id, kind, baseUrl: `http://${id}.test/v1`, apiKey: '', apiKeyEnv: '', models: [{ id: 'fast', label: '알아보기 쉬운 별칭', modelId: 'same-model', task: 'generation' }], ...extras });
function add(entry) { return saveProvider(defaults, getProviders(defaults).revision, entry); }
const selection = { decisionModel: 'one::fast', textModel: 'two::fast' };
function fakeProvider() {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ url: String(url), body, headers: init.headers });
		const json = value => new Response(JSON.stringify(value));
		if (String(url).endsWith('/models')) return json({ data: [{ id: 'gemma4-26b', task: 'generation' }, { id: 'embeddinggemma2', task: 'embedding' }] });
		if (String(url).endsWith('/embeddings')) return json({ model: body.model, data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
		if (body.questions) {
			const key = Object.keys(body.questions)[0];
			return json({ answers: { [key]: { type: 'choice', choice: key === 'identity_check' ? 'consistent' : key === 'performance_check' ? 'accept' : 'act' } } });
		}
		const output = body.response_format?.json_schema?.name === 'character_reflection' ? { relationshipUpdates: [], memoUpdate: null } : { actionId: 'speak:player', targetId: 'player', narrative: null, utterance: '안녕.', memoUpdate: null };
		return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
	};
	return calls;
}
const state = { self: { id: 'seo', name: '서우' }, present: [], recentEvents: [] };
const actions = [{ id: 'speak:player', targetId: 'player', kind: 'speak', label: '말한다' }];

test('legacy model IDs resolve to the existing default OEV and aliases disambiguate identical upstream IDs', (t) => {
	environment(t);
	assert.equal(getProviders(defaults).revision, 0);
	assert.equal(resolveProviderModel(defaults, 'gemma4-26b', 'decision').baseUrl, defaults.baseUrl);
	add(config('one')); add(config('two', 'openai-compatible'));
	const routes = resolveProviderSnapshot(defaults, selection);
	assert.equal(routes.decision.model, routes.text.model);
	assert.notEqual(routes.decision.baseUrl, routes.text.baseUrl);
	assert.throws(() => resolveProviderModel(defaults, 'two::fast', 'decision'), /OEV/);
	assert.throws(() => resolveProviderModel(defaults, 'one::missing', 'generation'), /별칭/);
	assert.throws(() => resolveProviderModel(defaults, 'missing::fast', 'generation'), /Provider/);
});

test('credentials stay server-only, blank edits retain keys, clear removes them, and stale saves are rejected', (t) => {
	const directory = environment(t);
	const view = add(config('one', 'oev', { apiKey: 'secret-one' }));
	assert.ok(!JSON.stringify(view).includes('secret-one'));
	assert.equal(view.providers.find(p => p.id === 'one').apiKeyConfigured, true);
	assert.ok(readFileSync(join(directory, 'providers.json'), 'utf8').includes('secret-one'));
	const publicProvider = view.providers.find(p => p.id === 'one');
	saveProvider(defaults, view.revision, { ...publicProvider, apiKey: '' });
	assert.equal(resolveProviderModel(defaults, 'one::fast', 'decision').apiKey, 'secret-one');
	assert.throws(() => saveProvider(defaults, view.revision, config('one')), /변경/);
	saveProvider(defaults, getProviders(defaults).revision, publicProvider, true);
	assert.equal(resolveProviderModel(defaults, 'one::fast', 'decision').apiKey, '');
});

test('validation and invalid reload preserve a working registry without returning malformed secret content', (t) => {
	const directory = environment(t);
	add(config('one'));
	for (const invalid of [
		{ baseUrl: 'https://username:password@example.com/v1' }, { baseUrl: 'https://example.com/v1?api_key=secret' },
		{ baseUrl: 'file:///etc/passwd' }, { models: [config('one').models[0], config('one').models[0]] },
		{ apiKeyEnv: 'BAD KEY' }, { apiKey: 'invalid\nheader' }
	]) assert.throws(() => add(config('bad', 'oev', invalid)));
	assert.equal(getProviders(defaults).providers.length, 2);
	writeFileSync(join(directory, 'providers.json'), '{"secret":"do-not-return-this');
	assert.equal(getProviders(defaults).providers.length, 2, 'bad file retains last working snapshot');
	assert.ok(!JSON.stringify(getProviders(defaults)).includes('do-not-return-this'));
});

test('generation and every typed review use separate configured providers, auth and actual model IDs', async (t) => {
	environment(t); add(config('one', 'oev', { apiKey: 'key-one' })); add(config('two', 'openai-compatible', { apiKey: 'key-two', outputTokenParameter: 'max_tokens' }));
	const calls = fakeProvider();
	const director = await createDirector(new AbortController().signal, selection);
	await director.decide(state); await director.perform(state, actions);
	await director.reflect(state, { newEvents: [{ eventId: 'a', actorId: 'player', body: { narrative: null, utterance: '안녕' } }], evidenceEvents: [], targets: [{ id: 'player', name: '플레이어' }] });
	assert.equal(calls.filter(c => c.url.endsWith('/systemone')).length, 3);
	assert.ok(calls.filter(c => c.body?.questions).every(c => c.url.startsWith('http://one.test/') && c.headers.authorization === 'Bearer key-one' && c.body.model === 'same-model'));
	const generated = calls.filter(c => c.url.endsWith('/chat/completions'));
	assert.equal(generated.length, 2);
	assert.ok(generated.every(c => c.url.startsWith('http://two.test/') && c.headers.authorization === 'Bearer key-two' && c.body.model === 'same-model'));
	assert.ok(generated.every(c => c.body.response_format.type === 'json_schema' && c.body.max_tokens > 0 && !('max_completion_tokens' in c.body) && !('reasoning_effort' in c.body) && !('temperature' in c.body)));
});

test('provider and alias edits affect new directors while pinned routes survive edits and deletion', async (t) => {
	environment(t); add(config('one')); add(config('two', 'openai-compatible', { apiKey: 'old-key' }));
	const pinned = resolveProviderSnapshot(defaults, selection);
	const calls = fakeProvider();
	const first = await createDirector(new AbortController().signal, selection);
	add(config('two', 'openai-compatible', { apiKey: 'new-key', baseUrl: 'http://new.test/v1', models: [{ id: 'fast', label: '이름만 바뀐 별칭', modelId: 'new-model', task: 'generation' }] }));
	const next = await createDirector(new AbortController().signal, selection);
	await first.perform(state, actions); await next.perform(state, actions);
	deleteProvider(defaults, getProviders(defaults).revision, 'two');
	const restarted = await createDirector(new AbortController().signal, selection, () => {}, pinned);
	await restarted.perform(state, actions);
	const generated = calls.filter(c => c.url.endsWith('/chat/completions'));
	assert.deepEqual(generated.map(c => c.body.model), ['same-model', 'new-model', 'same-model']);
	assert.deepEqual(generated.map(c => c.headers.authorization), ['Bearer old-key', 'Bearer new-key', 'Bearer old-key']);
	assert.throws(() => resolveProviderSnapshot(defaults, selection), /Provider/);
});

test('JSON object providers still receive schema guidance and host output validation', async (t) => {
	environment(t); add(config('one')); add(config('two', 'openai-compatible', { structuredOutput: 'json_object' }));
	const calls = fakeProvider(); const director = await createDirector(new AbortController().signal, selection);
	await director.perform(state, actions);
	const generated = calls.find(c => c.url.endsWith('/chat/completions'));
	assert.equal(generated.body.response_format.type, 'json_object');
	assert.match(generated.body.messages.at(-1).content, /actionId/);
	assert.equal(generated.body.max_completion_tokens, 512);
});

test('embedding aliases use the embedding provider and validate its real model ID', async (t) => {
	environment(t); add(config('vectors', 'openai-compatible', { models: [{ id: 'memory', label: '기억 임베딩', modelId: 'actual-embedding', task: 'embedding' }] }));
	const calls = fakeProvider();
	const embed = createEmbedder({ ...modelSettings(), embeddingModel: 'vectors::memory', embeddingDimensions: 2 }, new AbortController().signal);
	assert.deepEqual(await embed(['교실 안내'], 'query'), [[1, 0]]);
	assert.equal(calls[0].body.model, 'actual-embedding');
	assert.ok(calls[0].url.startsWith('http://vectors.test/'));
	assert.ok(!('input_type' in calls[0].body));
	assert.throws(() => resolveProviderModel(defaults, 'vectors::memory', 'generation'), /용도/);
});

test('catalog labels configured aliases, excludes embeddings, and tolerates a failed default when aliases exist', async (t) => {
	environment(t); add(config('one')); add(config('two', 'openai-compatible'));
	add(config('vectors', 'oev', { models: [{ id: 'memory', label: '임베딩', modelId: 'embed', task: 'embedding' }] }));
	fakeProvider();
	const catalog = await getModelCatalog(new AbortController().signal);
	assert.ok(catalog.options.some(c => c.value === aliasReference('two', 'fast') && !c.decision));
	assert.ok(catalog.options.some(c => c.value === 'one::fast' && c.decision));
	assert.ok(!catalog.models.includes('vectors::memory'));
	assert.deepEqual((await discoverProviderModels('one', new AbortController().signal)).models, [{ id: 'gemma4-26b', task: 'generation' }, { id: 'embeddinggemma2', task: 'embedding' }]);
	globalThis.fetch = async () => new Response('{}', { status: 401 });
	const degraded = await getModelCatalog(new AbortController().signal);
	assert.equal(degraded.errors.length, 1);
	assert.ok(degraded.models.includes('two::fast'));
});

test('provider error bodies and logs never disclose the configured credential', async (t) => {
	environment(t); add(config('one', 'oev', { apiKey: 'super-secret' })); add(config('two', 'openai-compatible'));
	globalThis.fetch = async () => new Response('invalid super-secret', { status: 401 });
	const director = await createDirector(new AbortController().signal, selection);
	await assert.rejects(director.decide(state), error => !error.message.includes('super-secret') && error.message.includes('[redacted]'));
});
