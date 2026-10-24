import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comfyPresets } from '../src/lib/images/comfyui.ts';
import { checkedComfySettings, defaultComfySettings, getComfySettings, saveComfySettings } from '../src/lib/server/images/comfy-settings.ts';
import { prepareComfyWorkflow, requiredComfyNodes, checkComfyModels } from '../src/lib/server/images/comfy-workflows.ts';
import { createComfyImageClient } from '../src/lib/server/images/comfyui.ts';
import { getComfyCatalog } from '../src/lib/server/images/comfy-api.ts';

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function settings() {
	const config = defaultComfySettings();
	config.profiles['zit-moody'].models = { checkpoint: '', diffusion: 'diffusion.safetensors', textEncoder: 'encoder.safetensors', vae: 'vae.safetensors', lora: 'style.safetensors' };
	config.profiles['sdxl-simple'].models.checkpoint = 'checkpoint.safetensors';
	config.profiles['anima-preview'].models = { checkpoint: '', diffusion: 'diffusion.safetensors', textEncoder: 'encoder.safetensors', vae: 'vae.safetensors', lora: '' };
	return config;
}
const modelDefinitions = {
	CheckpointLoaderSimple: { input: { required: { ckpt_name: [['checkpoint.safetensors']] } } },
	UNETLoader: { input: { required: { unet_name: [['diffusion.safetensors']] } } },
	CLIPLoader: { input: { required: { clip_name: [['encoder.safetensors']] } } },
	VAELoader: { input: { required: { vae_name: [['vae.safetensors']] } } }
};
const catalogNodes = () => ({ ...Object.fromEntries([...new Set(comfyPresets.flatMap((preset) => requiredComfyNodes(preset.id)))].map((name) => [name, {}])), ...modelDefinitions });
const code = (value) => (error) => { assert.equal(error.code, value); return true; };

function transport(mode = 'success') {
	const calls = [];
	let socket;
	class FakeSocket extends EventTarget {
		constructor(url) { super(); this.url = url; socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
		close() { this.dispatchEvent(new Event('close')); }
		json(type, data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, data }) })); }
		image(bytes = png) {
			const header = Buffer.alloc(8); header.writeUInt32BE(1); header.writeUInt32BE(2, 4);
			const frame = Buffer.concat([header, bytes]);
			this.dispatchEvent(new MessageEvent('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) }));
		}
	}
	globalThis.WebSocket = FakeSocket;
	globalThis.fetch = async (url, init) => {
		const path = new URL(url).pathname;
		const body = init?.body ? JSON.parse(init.body) : undefined;
		calls.push({ path, body });
		if (path === '/object_info') return Response.json(catalogNodes());
		if (path === '/models/loras') return Response.json(['style.safetensors']);
		if (path === '/queue') return Response.json({});
		assert.equal(path, '/prompt');
		const id = body.prompt_id;
		const outputId = Object.keys(body.prompt).find((key) => body.prompt[key].class_type === 'SaveImageWebsocket');
		if (mode === 'http') return new Response('private upstream details', { status: 503 });
		if (mode === 'close') { socket.close(); return Response.json({ prompt_id: id }); }
		if (mode === 'pending') return Response.json({ prompt_id: id });
		// Events can arrive before the HTTP acknowledgment. Ignore peers and sampler previews.
		socket.json('executing', { prompt_id: 'other-job', node: outputId }); socket.image();
		socket.json('executing', { prompt_id: id, node: 'sampler' }); socket.image();
		socket.json('executing', { prompt_id: id, node: outputId });
		if (mode !== 'empty') socket.image(mode === 'bad-image' ? Buffer.from('not-an-image') : png);
		if (mode === 'error') socket.json('execution_error', { prompt_id: id, node_id: outputId, exception_message: 'sensitive path' });
		else if (mode === 'interrupted') socket.json('execution_interrupted', { prompt_id: id });
		else socket.json('execution_success', { prompt_id: id });
		return Response.json({ prompt_id: id });
	};
	return calls;
}

test('all bundled workflows contain only one WebSocket output and valid references', () => {
	const config = settings();
	for (const preset of comfyPresets) {
		const { graph, outputNodeId } = prepareComfyWorkflow(preset.id, config.profiles[preset.id], { model: preset.id, prompt: '극장 앞', options: { seed: 5 } });
		assert.equal(graph[outputNodeId].class_type, 'SaveImageWebsocket');
		assert.equal(Object.values(graph).filter((node) => node.class_type === 'SaveImageWebsocket').length, 1);
		assert.ok(!Object.values(graph).some((node) => ['SaveImage', 'PreviewImage'].includes(node.class_type)));
		for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
			if (Array.isArray(value)) assert.ok(graph[value[0]], `missing reference ${value[0]}`);
		}
	}
});

test('ZIT binds the shared seed, dimensions, optional LoRA and model files without changing sampler links', () => {
	const profile = settings().profiles['zit-moody'];
	const result = prepareComfyWorkflow('zit-moody', profile, { model: 'zit-moody', prompt: '비 오는 극장', count: 2, options: { seed: 42, width: 512, height: 768 } });
	assert.equal(result.graph['627'].inputs.text, '비 오는 극장');
	assert.equal(result.graph['649'].inputs.seed, 42);
	assert.deepEqual(result.graph['599'].inputs.noise_seed, ['649', 0]);
	assert.deepEqual(result.graph['638'].inputs.noise_seed, ['649', 0]);
	assert.deepEqual(result.graph['698'].inputs, { width: 512, height: 768, batch_size: 2 });
	assert.equal(result.graph['761'].inputs.unet_name, profile.models.diffusion);
	assert.equal(result.graph['755'].inputs.clip_name, profile.models.textEncoder);
	assert.equal(result.graph['757'].inputs.vae_name, profile.models.vae);
	assert.deepEqual(result.graph['822'].inputs.lora_1, { on: true, lora: 'style.safetensors', strength: 1 });
	const without = structuredClone(profile); without.models.lora = '';
	assert.equal(prepareComfyWorkflow('zit-moody', without, { model: 'zit-moody', prompt: '새 장면' }).graph['822'].inputs.lora_1.on, false);
	assert.equal(profile.width, 640);
});

test('SDXL binds positive, negative, checkpoint and seed while retaining the original sampler settings', () => {
	const profile = settings().profiles['sdxl-simple'];
	const { graph } = prepareComfyWorkflow('sdxl-simple', profile, { model: 'sdxl-simple', prompt: '새 장면', options: { seed: 7, negativePrompt: 'text, logo' } });
	assert.equal(graph['10'].inputs.text, '새 장면');
	assert.equal(graph['11'].inputs.text, 'text, logo');
	assert.equal(graph['15'].inputs.ckpt_name, 'checkpoint.safetensors');
	assert.equal(graph['12'].inputs.seed, 7);
	assert.equal(graph['12'].inputs.steps, 20);
	assert.equal(graph['12'].inputs.cfg, 5.5);
	const next = prepareComfyWorkflow('sdxl-simple', profile, { model: 'sdxl-simple', prompt: '다음 장면', options: { seed: 8 } });
	assert.equal(next.graph['11'].inputs.text, profile.negativePrompt);
	assert.equal(graph['12'].inputs.seed, 7);
});

test('Anima preserves colon node IDs, sampler settings and model bindings with independent negative text', () => {
	const profile = settings().profiles['anima-preview'];
	const { graph, outputNodeId } = prepareComfyWorkflow('anima-preview', profile, { model: 'anima-preview', prompt: '극장 입구', count: 2, options: { seed: 24, width: 768, height: 1024, negativePrompt: 'text, logo' } });
	assert.equal(graph['60:11'].inputs.text, '극장 입구');
	assert.equal(graph['60:12'].inputs.text, 'text, logo');
	assert.equal(graph['60:19'].inputs.seed, 24);
	assert.equal(graph['60:19'].inputs.steps, 30);
	assert.equal(graph['60:19'].inputs.cfg, 4);
	assert.equal(graph['60:19'].inputs.sampler_name, 'er_sde');
	assert.equal(graph['60:19'].inputs.scheduler, 'simple');
	assert.deepEqual(graph['60:28'].inputs, { width: 768, height: 1024, batch_size: 2 });
	assert.equal(graph['60:44'].inputs.unet_name, profile.models.diffusion);
	assert.equal(graph['60:45'].inputs.clip_name, profile.models.textEncoder);
	assert.equal(graph['60:45'].inputs.type, 'stable_diffusion');
	assert.equal(graph['60:15'].inputs.vae_name, profile.models.vae);
	assert.deepEqual(graph[outputNodeId].inputs.images, ['60:8', 0]);
	assert.equal(profile.width, 1024);
});

test('old two-profile version 1 settings gain Anima defaults without losing selections or revisions', () => {
	const old = settings();
	delete old.profiles['anima-preview'];
	old.revision = 7;
	old.presetId = 'sdxl-simple';
	const restored = checkedComfySettings(old);
	assert.deepEqual(restored.profiles['zit-moody'], old.profiles['zit-moody']);
	assert.deepEqual(restored.profiles['sdxl-simple'], old.profiles['sdxl-simple']);
	assert.equal(restored.revision, 7);
	assert.equal(restored.presetId, 'sdxl-simple');
	assert.equal(restored.profiles['anima-preview'].models.diffusion, '');
	assert.equal(restored.profiles['anima-preview'].width, 1024);
	assert.throws(() => checkedComfySettings({ ...old, profiles: { ...old.profiles, 'anima-preview': null } }), code('configuration'));
});

test('unsupported workflows, missing models, wrong dimensions and unusable options fail before queueing', () => {
	const profile = settings().profiles['zit-moody'];
	assert.throws(() => prepareComfyWorkflow('unknown', profile, { model: 'unknown', prompt: '장면' }), code('invalid_request'));
	for (const request of [
		{ model: 'zit-moody', prompt: '' }, { model: 'sdxl-simple', prompt: '장면' },
		{ model: 'zit-moody', prompt: '장면', count: 5 },
		{ model: 'zit-moody', prompt: '장면', options: { width: 65 } },
		{ model: 'zit-moody', prompt: '장면', options: { seed: -1 } },
		{ model: 'zit-moody', prompt: '장면', options: { seed: 2 ** 48 } },
		{ model: 'zit-moody', prompt: '장면', options: { negativePrompt: 'unsupported' } },
		{ model: 'zit-moody', prompt: '장면', options: { quality: 'high' } }
	]) assert.throws(() => prepareComfyWorkflow('zit-moody', profile, request), code('invalid_request'));
	assert.throws(() => prepareComfyWorkflow('sdxl-simple', { ...profile, models: { ...profile.models, checkpoint: '' } }, { model: 'sdxl-simple', prompt: '장면' }), code('configuration'));
});

test('catalog discovers actual model names and validation checks the chosen workflow requirements', async () => {
	transport();
	const catalog = await getComfyCatalog('http://localhost:22222');
	assert.deepEqual(catalog.models.checkpoint, ['checkpoint.safetensors']);
	assert.deepEqual(catalog.models.lora, ['style.safetensors']);
	checkComfyModels('zit-moody', settings().profiles['zit-moody'], catalog);
	assert.throws(() => checkComfyModels('zit-moody', settings().profiles['zit-moody'], { ...catalog, nodeTypes: [] }), code('configuration'));
	assert.throws(() => checkComfyModels('sdxl-simple', settings().profiles['sdxl-simple'], { ...catalog, models: { ...catalog.models, checkpoint: [] } }), code('configuration'));
});

test('WebSocket adapter returns only this job output and tolerates completion before HTTP acknowledgment', async () => {
	const calls = transport();
	const queued = [];
	const client = createComfyImageClient(settings(), { onQueued: (id) => queued.push(id) });
	const result = await client.generate({ model: 'zit-moody', prompt: '빈 극장 입구', options: { seed: 123 } });
	assert.equal(result.provider, 'comfyui');
	assert.equal(result.seed, 123);
	assert.equal(result.model, 'zit-moody');
	assert.deepEqual(result.images[0].bytes, png);
	assert.equal(result.images[0].mediaType, 'image/png');
	assert.deepEqual(queued, [result.jobId]);
	assert.equal(calls.filter((call) => call.path === '/prompt').length, 1);
	assert.ok(!calls.some((call) => ['/view', '/history', '/interrupt'].includes(call.path)));
});

test('workflow errors, interrupted execution, missing images, malformed frames and lost connections fail explicitly', async () => {
	for (const [mode, expected] of [['error', 'execution'], ['interrupted', 'execution'], ['empty', 'invalid_response'], ['bad-image', 'invalid_response'], ['close', 'network'], ['http', 'http']]) {
		transport(mode);
		await assert.rejects(createComfyImageClient(settings()).generate({ model: 'sdxl-simple', prompt: '장면' }), (error) => { assert.equal(error.code, expected, mode); assert.ok(!error.message.includes('sensitive path')); return true; });
	}
});

test('cancellation removes only the accepted pending prompt ID and never globally interrupts ComfyUI', async () => {
	const calls = transport('pending');
	const controller = new AbortController();
	const reason = new Error('user cancelled');
	const client = createComfyImageClient(settings(), { onQueued: () => controller.abort(reason) });
	await assert.rejects(client.generate({ model: 'sdxl-simple', prompt: '장면' }, controller.signal), (error) => error === reason);
	const queued = calls.find((call) => call.path === '/prompt');
	assert.deepEqual(calls.find((call) => call.path === '/queue').body, { delete: [queued.body.prompt_id] });
	assert.ok(!calls.some((call) => call.path === '/interrupt'));
});

test('timeout rejects promptly, pre-cancelled calls do no I/O, and client settings are snapshotted', async () => {
	let calls = transport('pending');
	await assert.rejects(createComfyImageClient(settings(), { timeoutMs: 20 }).generate({ model: 'sdxl-simple', prompt: '장면' }), code('timeout'));
	assert.ok(calls.some((call) => call.path === '/queue'));
	calls = transport();
	const controller = new AbortController(); controller.abort();
	await assert.rejects(createComfyImageClient(settings()).generate({ model: 'sdxl-simple', prompt: '장면' }, controller.signal));
	assert.equal(calls.length, 0);
	const config = settings(); const client = createComfyImageClient(config);
	config.profiles['sdxl-simple'].models.checkpoint = 'changed-after-creation';
	await client.generate({ model: 'sdxl-simple', prompt: '장면' });
	assert.equal(calls.find((call) => call.path === '/prompt').body.prompt['15'].inputs.ckpt_name, 'checkpoint.safetensors');
});

test('settings persist both profiles, reject stale edits and never accept credential-bearing URLs', (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'newera-comfy-settings-'));
	const oldPath = process.env.NEWERA_COMFYUI_CONFIG;
	process.env.NEWERA_COMFYUI_CONFIG = join(directory, 'settings.json');
	t.after(() => { if (oldPath === undefined) delete process.env.NEWERA_COMFYUI_CONFIG; else process.env.NEWERA_COMFYUI_CONFIG = oldPath; rmSync(directory, { recursive: true, force: true }); });
	const config = settings();
	const saved = saveComfySettings(config);
	assert.equal(saved.revision, 1);
	assert.deepEqual(getComfySettings().profiles, config.profiles);
	assert.ok(readFileSync(process.env.NEWERA_COMFYUI_CONFIG, 'utf8').includes('checkpoint.safetensors'));
	assert.throws(() => saveComfySettings(config), /새로고침/);
	for (const baseUrl of ['https://user:secret@example.com', 'file:///tmp', 'http://localhost:22222/?key=secret']) assert.throws(() => saveComfySettings({ ...saved, baseUrl }), code('configuration'));
});
