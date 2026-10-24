import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';
import { createImageClient, ImageGenerationError } from '../src/lib/server/images/client.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
const request = { model: 'chosen-image-model', prompt: '비가 그친 극장 앞, 두 사람이 우산을 접는다.' };
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
const payload = (bytes = png, extra = {}) => ({ created: 1792800000, data: [{ b64_json: bytes.toString('base64'), ...extra }] });
const client = (provider = 'openai', extra = {}) => createImageClient({ provider, apiKey: 'private-api-key', ...extra });
const errorCode = (code, status) => (error) => {
	assert.ok(error instanceof ImageGenerationError);
	assert.equal(error.code, code);
	if (status !== undefined) assert.equal(error.status, status);
	assert.ok(!error.message.includes('private-api-key'));
	return true;
};
function respond(t, response = payload()) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, ...init, body: JSON.parse(init.body) });
		return Response.json(response);
	};
	return calls;
}

test('OpenAI uses the Images API and GPT Image options without legacy response_format', async (t) => {
	const calls = respond(t, { ...payload(), usage: { total_tokens: 123 } });
	const result = await client().generate({ ...request, options: { size: '1536x1024', quality: 'high', outputFormat: 'png', background: 'opaque' } });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
	assert.equal(calls[0].headers.authorization, 'Bearer private-api-key');
	assert.equal(calls[0].redirect, 'error');
	assert.deepEqual(calls[0].body, { model: request.model, prompt: request.prompt, n: 1, size: '1536x1024', quality: 'high', output_format: 'png', background: 'opaque' });
	assert.equal(result.provider, 'openai');
	assert.equal(result.model, request.model);
	assert.deepEqual(result.images[0].bytes, png);
	assert.equal(result.images[0].mediaType, 'image/png');
	assert.equal(result.created, 1792800000);
	assert.deepEqual(result.usage, { total_tokens: 123 });
});

test('xAI requests base64 and maps Grok aspect ratio, resolution and quality', async (t) => {
	const calls = respond(t, { ...payload(jpeg), model: 'actual-grok-model' });
	const result = await client('xai').generate({ ...request, options: { aspectRatio: '16:9', resolution: '2k', quality: 'medium' } });
	assert.equal(calls[0].url, 'https://api.x.ai/v1/images/generations');
	assert.deepEqual(calls[0].body, { model: request.model, prompt: request.prompt, n: 1, response_format: 'b64_json', aspect_ratio: '16:9', resolution: '2k', quality: 'medium' });
	assert.equal(result.images[0].mediaType, 'image/jpeg');
	assert.equal(result.model, 'actual-grok-model');
	assert.equal(result.usage, undefined);
});

test('OpenRouter uses its dedicated Image API and normalizes media_type and cost', async (t) => {
	const calls = respond(t, { ...payload(png, { media_type: 'image/png' }), usage: { cost: 0.04, completion_tokens: 50 } });
	const result = await client('openrouter').generate({ ...request, options: { aspectRatio: '16:9', resolution: '2K', outputFormat: 'png', quality: 'high' } });
	assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
	assert.deepEqual(calls[0].body, { model: request.model, prompt: request.prompt, n: 1, aspect_ratio: '16:9', resolution: '2K', output_format: 'png', quality: 'high' });
	assert.equal(result.images[0].mediaType, 'image/png');
	assert.equal(result.usage.cost, 0.04);
});

test('multiple images preserve order, bytes and revised prompts', async (t) => {
	respond(t, { data: [...payload().data, ...payload(jpeg, { revised_prompt: 'Provider가 수정한 프롬프트' }).data] });
	const result = await client().generate({ ...request, count: 2 });
	assert.deepEqual(result.images.map((image) => image.mediaType), ['image/png', 'image/jpeg']);
	assert.equal(result.images[1].revisedPrompt, 'Provider가 수정한 프롬프트');
});

test('WebP detection uses the returned bytes when a MIME field is absent', async (t) => {
	respond(t, payload(Buffer.from('RIFF1234WEBPVP8 ')));
	assert.equal((await client('openrouter').generate(request)).images[0].mediaType, 'image/webp');
});

test('credentials resolve at client creation and are not exposed as client properties', async (t) => {
	const previous = { NEWERA_XAI_API_KEY: process.env.NEWERA_XAI_API_KEY, CUSTOM_IMAGE_KEY: process.env.CUSTOM_IMAGE_KEY };
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	process.env.NEWERA_XAI_API_KEY = 'original-key';
	process.env.CUSTOM_IMAGE_KEY = 'custom-key';
	const original = createImageClient({ provider: 'xai' });
	const custom = createImageClient({ provider: 'openai', apiKeyEnv: 'CUSTOM_IMAGE_KEY', baseUrl: 'http://proxy.test/custom/v1///' });
	process.env.NEWERA_XAI_API_KEY = 'changed-key';
	const calls = respond(t);
	await original.generate(request);
	await custom.generate(request);
	assert.equal(calls[0].headers.authorization, 'Bearer original-key');
	assert.equal(calls[1].headers.authorization, 'Bearer custom-key');
	assert.equal(calls[1].url, 'http://proxy.test/custom/v1/images/generations');
	assert.deepEqual(Object.keys(original), ['generate']);
	assert.ok(!JSON.stringify(original).includes('original-key'));
});

test('client configuration rejects unsafe addresses, missing keys and invalid timeouts', () => {
	for (const baseUrl of ['file:///tmp', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#fragment', 'not-a-url']) {
		assert.throws(() => client('openai', { baseUrl }), errorCode('configuration'));
	}
	for (const timeoutMs of [0, -1, 600001, NaN, 1.5]) assert.throws(() => client('openai', { timeoutMs }), errorCode('configuration'));
	assert.throws(() => client('other'), errorCode('configuration'));
	assert.throws(() => client('openai', { apiKey: '' }), errorCode('configuration'));
	assert.throws(() => client('openai', { apiKey: 'secret\nheader' }), errorCode('configuration'));
	assert.throws(() => client('openai', { apiKeyEnv: 'INVALID KEY' }), errorCode('configuration'));
});

test('invalid or unsupported request options fail before any billable HTTP call', async (t) => {
	const calls = respond(t);
	for (const input of [
		null, { ...request, model: '' }, { ...request, prompt: ' ' }, { ...request, prompt: 'a'.repeat(32001) },
		{ ...request, count: 0 }, { ...request, count: 11 }, { ...request, count: 1.5 },
		{ ...request, unexpected: true }, { ...request, options: [] },
		{ ...request, options: { aspectRatio: '16:9' } }, { ...request, options: { size: '16:9' } },
		{ ...request, options: { quality: 'invalid' } }, { ...request, options: { outputFormat: 'svg' } },
		{ ...request, options: { outputCompression: 50 } }, { ...request, options: { outputCompression: 101, outputFormat: 'jpeg' } },
		{ ...request, options: { outputFormat: 'jpeg', background: 'transparent' } },
		{ ...request, options: { response_format: 'url' } }, { ...request, options: { toString: 'override' } }
	]) await assert.rejects(client().generate(input), errorCode('invalid_request'));
	await assert.rejects(client('xai').generate({ ...request, options: { quality: 'high' } }), errorCode('invalid_request'));
	await assert.rejects(client('xai').generate({ ...request, options: { resolution: '2K' } }), errorCode('invalid_request'));
	await assert.rejects(client('xai').generate({ ...request, options: { aspectRatio: ['16:9'] } }), errorCode('invalid_request'));
	await assert.rejects(client('openrouter').generate({ ...request, options: { aspectRatio: 'wide' } }), errorCode('invalid_request'));
	assert.equal(calls.length, 0);
});

test('optional undefined values are omitted, JPEG compression is mapped, and prompts are preserved', async (t) => {
	const calls = respond(t, payload(jpeg));
	await client().generate({ ...request, prompt: '  구도를 유지한다.  ', options: { outputFormat: 'jpeg', outputCompression: 80, quality: undefined } });
	assert.equal(calls[0].body.prompt, '  구도를 유지한다.  ');
	assert.equal(calls[0].body.output_compression, 80);
	assert.ok(!('quality' in calls[0].body));
});

test('malformed, missing, URL-only and non-raster output cannot masquerade as generated images', async (t) => {
	for (const response of [null, {}, { error: { message: 'private-api-key' } }, { data: [] }, { data: [null] },
		{ data: [{ url: 'https://example.com/expiring.png' }] }, payload(png, { b64_json: '!!!!' }),
		payload(png, { b64_json: 'aGVsbG8=' }), payload(Buffer.from('<svg></svg>')),
		payload(png, { media_type: 'image/jpeg' }), payload(png, { mime_type: 'image/jpeg' }),
		payload(png, { revised_prompt: 1 }), { ...payload(), created: 'now' }, { ...payload(), usage: [] },
		{ data: [...payload().data, ...payload().data] }
	]) {
		globalThis.fetch = async () => Response.json(response);
		await assert.rejects(client().generate(request), errorCode('invalid_response'));
	}
	globalThis.fetch = async () => new Response('not JSON');
	await assert.rejects(client().generate(request), errorCode('invalid_response'));
});

test('large valid image responses do not overflow a base64 validation regex stack', async (t) => {
	const large = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
	respond(t, payload(large));
	assert.equal((await client().generate(request)).images[0].bytes.length, large.length);
});

test('content filtering and oversized responses have explicit errors', async (t) => {
	const calls = respond(t, payload(png, { respect_moderation: false }));
	await assert.rejects(client('xai').generate(request), errorCode('content_filtered'));
	globalThis.fetch = async () => new Response('{}', { headers: { 'content-length': String(65 * 1024 * 1024) } });
	await assert.rejects(client().generate(request), errorCode('invalid_response'));
	assert.equal(calls.length, 1);
});

test('HTTP and network failures are sanitized and never automatically retried', async (t) => {
	let count = 0;
	globalThis.fetch = async () => { count++; return new Response('private-api-key and private prompt', { status: 429 }); };
	await assert.rejects(client().generate(request), errorCode('http', 429));
	assert.equal(count, 1);
	globalThis.fetch = async () => { throw new Error('private-api-key from a transport'); };
	await assert.rejects(client().generate(request), errorCode('network'));
});

test('already cancelled requests do no I/O and late responses are discarded', async (t) => {
	const calls = respond(t);
	const controller = new AbortController();
	const reason = new Error('cancelled by caller');
	controller.abort(reason);
	await assert.rejects(client().generate(request, controller.signal), (error) => error === reason);
	assert.equal(calls.length, 0);
	const late = new AbortController();
	globalThis.fetch = async () => { late.abort(reason); return Response.json(payload()); };
	await assert.rejects(client().generate(request, late.signal), (error) => error === reason);
});

test('mutating the original request while generating cannot change model or count validation', async (t) => {
	const input = { ...request };
	globalThis.fetch = async () => { input.model = 'changed-model'; input.count = 10; return Response.json(payload()); };
	const result = await client().generate(input);
	assert.equal(result.model, request.model);
});

test('real HTTP transport times out and cancels during response body delivery', { timeout: 5000 }, async (t) => {
	let bodyStarted;
	const started = new Promise((done) => { bodyStarted = done; });
	const server = createServer((incoming, outgoing) => {
		outgoing.writeHead(200, { 'content-type': 'application/json' });
		outgoing.write('{"data":[');
		bodyStarted();
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	await assert.rejects(client('openai', { baseUrl, timeoutMs: 100 }).generate(request), errorCode('timeout'));
	await started;
	const controller = new AbortController();
	const reason = new Error('caller cancelled');
	const pending = client('openai', { baseUrl, timeoutMs: 1000 }).generate(request, controller.signal);
	const rejected = assert.rejects(pending, (error) => error === reason);
	setTimeout(() => controller.abort(reason), 20);
	await rejected;
});
