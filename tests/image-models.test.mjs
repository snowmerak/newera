import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';
import { getHostedImageCatalog } from '../src/lib/server/images/models.ts';
import { ImageGenerationError } from '../src/lib/server/images/common.ts';

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
const config = (provider = 'openai', extra = {}) => ({ provider, apiKey: 'private-model-key', ...extra });
const modalities = { input_modalities: ['text', 'image'], output_modalities: ['image'] };
const hasCode = (code, status) => (error) => {
	assert.ok(error instanceof ImageGenerationError);
	assert.equal(error.code, code);
	if (status !== undefined) assert.equal(error.status, status);
	assert.ok(!error.message.includes('private-model-key'));
	return true;
};

test('OpenAI filters model families, preserves snapshots and excludes vision/chat/legacy IDs', async () => {
	globalThis.fetch = async (url, init) => {
		assert.equal(url, 'https://api.openai.com/v1/models');
		assert.equal(init.headers.authorization, 'Bearer private-model-key');
		assert.equal(init.redirect, 'error');
		assert.equal(init.body, undefined);
		return Response.json({ data: ['gpt-4.1', 'dall-e-3', 'gpt-image-1.5', 'gpt-image-2.5-sunburst-2026-09-08', 'chatgpt-image-latest', 'gpt-image-1.5', 'other-gpt-image-1', 'gpt-image-', 'gpt-4o-image-understanding'].map((id) => ({ id, owned_by: 'private-model-key' })) });
	};
	const result = await getHostedImageCatalog(config());
	assert.deepEqual(result, { provider: 'openai', filter: 'model-family', models: ['chatgpt-image-latest', 'gpt-image-1.5', 'gpt-image-2.5-sunburst-2026-09-08'].map((id) => ({ id, name: id })) });
});

test('xAI uses its image-only endpoint and checks text input and image output', async () => {
	globalThis.fetch = async (url) => {
		assert.equal(url, 'https://api.x.ai/v1/image-generation-models');
		return Response.json({ models: [
			{ id: 'grok-imagine-image-2.0', ...modalities, aliases: ['dated-alias'], image_price: 123 },
			{ id: 'vision-only', input_modalities: ['text', 'image'], output_modalities: ['text'] },
			{ id: 'edit-only', input_modalities: ['image'], output_modalities: ['image'] }
		] });
	};
	assert.deepEqual(await getHostedImageCatalog(config('xai')), { provider: 'xai', filter: 'image-endpoint', models: [{ id: 'grok-imagine-image-2.0', name: 'grok-imagine-image-2.0' }] });
});

test('OpenRouter uses dedicated Images API models rather than chat models; custom roots and env references work', async () => {
	process.env.NEWERA_MODEL_CATALOG_TEST = 'private-model-key';
	try {
		globalThis.fetch = async (url, init) => {
			assert.equal(url, 'http://localhost:1234/proxy/api/v1/images/models');
			assert.equal(init.headers.authorization, 'Bearer private-model-key');
			return Response.json({ data: [
				{ id: 'vendor/model', name: 'Vendor: Image Model', architecture: modalities, supported_parameters: { seed: {} } },
				{ id: 'vendor/chat', architecture: { ...modalities, output_modalities: ['text'] } }
			] });
		};
		const result = await getHostedImageCatalog({ provider: 'openrouter', apiKeyEnv: 'NEWERA_MODEL_CATALOG_TEST', baseUrl: 'http://localhost:1234/proxy/api/v1/' });
		assert.deepEqual(result, { provider: 'openrouter', filter: 'image-endpoint', models: [{ id: 'vendor/model', name: 'Vendor: Image Model' }] });
	} finally { delete process.env.NEWERA_MODEL_CATALOG_TEST; }
});

test('empty catalogs are valid; malformed schemas are rejected instead of inventing a fallback list', async () => {
	for (const [provider, body] of [['openai', { data: [] }], ['xai', { models: [] }], ['openrouter', { data: [] }]]) {
		globalThis.fetch = async () => Response.json(body);
		assert.deepEqual((await getHostedImageCatalog(config(provider))).models, []);
	}
	for (const [provider, body] of [['openai', {}], ['openai', { data: [{ id: null }] }], ['openai', { data: [{ id: 'x'.repeat(201) }] }], ['xai', { models: [{ id: 'grok' }] }], ['openrouter', { data: [{ id: 'vendor/model', architecture: {} }] }]]) {
		globalThis.fetch = async () => Response.json(body);
		await assert.rejects(getHostedImageCatalog(config(provider)), hasCode('invalid_response'));
	}
});

test('HTTP and transport failures are sanitized and never retried', async () => {
	let calls = 0;
	globalThis.fetch = async () => { calls++; return new Response('private-model-key', { status: 401 }); };
	await assert.rejects(getHostedImageCatalog(config()), hasCode('http', 401));
	assert.equal(calls, 1);
	globalThis.fetch = async () => { throw new Error('private-model-key'); };
	await assert.rejects(getHostedImageCatalog(config()), hasCode('network'));
});

test('invalid connection settings fail before fetching', async () => {
	globalThis.fetch = async () => assert.fail('must not fetch');
	for (const extra of [{ apiKey: '' }, { apiKeyEnv: 'INVALID-ENV' }, { baseUrl: 'file:///secret' }, { baseUrl: 'https://user:password@example.com/v1' }, { baseUrl: 'https://example.com/v1?key=secret' }, { timeoutMs: 0 }, { provider: 'unknown' }]) {
		await assert.rejects(getHostedImageCatalog(config('openai', extra)), hasCode('configuration'));
	}
});

test('streamed model lists are bounded even without content-length', async () => {
	let cancelled = false;
	globalThis.fetch = async () => new Response(new ReadableStream({
		pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
		cancel() { cancelled = true; }
	}));
	await assert.rejects(getHostedImageCatalog(config()), hasCode('invalid_response'));
	assert.equal(cancelled, true);
	globalThis.fetch = async () => new Response('not json');
	await assert.rejects(getHostedImageCatalog(config()), hasCode('invalid_response'));
});

test('pre-cancelled requests preserve the caller reason without I/O', async () => {
	globalThis.fetch = async () => assert.fail('must not fetch');
	const controller = new AbortController(); const reason = new Error('caller cancelled'); controller.abort(reason);
	await assert.rejects(getHostedImageCatalog(config(), controller.signal), (error) => error === reason);
});

test('timeouts and caller cancellation also interrupt a pending catalog body over HTTP', async (t) => {
	const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"data":['); });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	await assert.rejects(getHostedImageCatalog(config('openai', { baseUrl, timeoutMs: 50 })), hasCode('timeout'));
	const controller = new AbortController(); const reason = new Error('caller cancelled');
	const pending = getHostedImageCatalog(config('openai', { baseUrl }), controller.signal);
	const timer = setTimeout(() => controller.abort(reason), 50);
	try { await assert.rejects(pending, (error) => error === reason); } finally { clearTimeout(timer); }
});
