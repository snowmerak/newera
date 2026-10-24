import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'newera-image-presets-'));
process.env.NEWERA_DATA_DIR = directory;
// Exercise the additive migration with an existing world table, not just a fresh database.
const previous = new DatabaseSync(join(directory, 'newera.sqlite'));
previous.exec('CREATE TABLE theater_worlds (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, definition_json TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, model_settings_json TEXT)');
previous.close();
const stage = await import('../src/lib/server/stage-store.ts');
const { checkedImagePresetConfig, saveImagePreset, getImagePreset, listImagePresets, deleteImagePreset } = await import('../src/lib/server/images/presets.ts');
const { defaultComfySettings } = await import('../src/lib/server/images/comfy-settings.ts');
const { generateWorldImage, generateWithImageConfig, withImageGeneration, ImageGenerationBusy } = await import('../src/lib/server/images/generate.ts');
const nativeFetch = globalThis.fetch;
const nativeSocket = globalThis.WebSocket;
afterEach(() => { globalThis.fetch = nativeFetch; globalThis.WebSocket = nativeSocket; });
test.after(() => { stage.store().close(); rmSync(directory, { recursive: true, force: true }); });
const hosted = (provider = 'openai', extra = {}) => ({ provider, baseUrl: 'https://images.example.test/v1', apiKeyEnv: 'NEWERA_TEST_IMAGE_KEY', model: 'image-model', options: {}, stylePrompt: 'Watercolor.', ...extra });
const save = (name, config = hosted()) => saveImagePreset({ name, revision: 0, config });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('existing databases gain a nullable session preference without changing world revision or progress', () => {
	const world = stage.getWorld();
	assert.equal(world.imagePresetId, null);
	const saved = save('Migration preset');
	stage.setWorldImagePreset(world.id, saved.id);
	const updated = stage.getWorld(world.id);
	assert.equal(updated.revision, world.revision);
	assert.deepEqual(updated.state, world.state);
	assert.equal(updated.imagePresetId, saved.id);
});

test('four provider configurations round-trip without persisting credentials', () => {
	process.env.NEWERA_TEST_IMAGE_KEY = 'private-image-key';
	for (const provider of ['openai', 'xai', 'openrouter']) {
		const saved = save(`Provider ${provider}`, hosted(provider));
		assert.equal(getImagePreset(saved.id).provider, provider);
		assert.ok(!JSON.stringify(saved).includes('private-image-key'));
	}
	const profile = defaultComfySettings().profiles['anima-preview'];
	profile.models.diffusion = 'anima.safetensors'; profile.models.textEncoder = 'encoder.safetensors'; profile.models.vae = 'vae.safetensors';
	const config = { provider: 'comfyui', baseUrl: 'http://localhost:22222', stylePrompt: '', workflowId: 'anima-preview', profile };
	assert.deepEqual(getImagePreset(save('Provider comfyui', config).id).config, config);
	assert.ok(!JSON.stringify(stage.store().prepare('SELECT config_json FROM theater_image_presets').all()).includes('private-image-key'));
});

test('preset updates retain stable IDs, require a revision, and reject duplicate names', () => {
	const original = save('Shared style');
	const updated = saveImagePreset({ ...original, name: 'Updated style', config: hosted('openai', { model: 'new-model' }) });
	assert.equal(updated.id, original.id);
	assert.equal(updated.revision, original.revision + 1);
	assert.equal(updated.config.model, 'new-model');
	assert.throws(() => saveImagePreset(original), /변경/);
	assert.throws(() => save('UPDATED STYLE'), /같은 이름/);
	assert.throws(() => deleteImagePreset(updated.id, original.revision), /변경/);
});

test('selections are isolated by session and survive reset, slots, and process-independent SQL reads', () => {
	const first = stage.createWorld('First image session', 'A');
	const second = stage.createWorld('Second image session', 'B');
	const a = save('Session style A'); const b = save('Session style B');
	stage.setWorldImagePreset(first, a.id); stage.setWorldImagePreset(second, b.id);
	stage.saveWorld(first, 1);
	stage.resetWorld(first, stage.getWorld(first).revision);
	stage.loadWorld(first, stage.getWorld(first).revision, 1);
	assert.equal(stage.getWorld(first).imagePresetId, a.id);
	assert.equal(stage.getWorld(second).imagePresetId, b.id);
	const reader = new DatabaseSync(join(directory, 'newera.sqlite'));
	assert.equal(reader.prepare('SELECT image_preset_id FROM theater_worlds WHERE id = ?').get(first).image_preset_id, a.id); reader.close();
	assert.ok(!stage.exportWorld(first).includes(a.id), 'operational preferences do not enter exports');
	assert.throws(() => stage.setWorldImagePreset(first, 'missing-preset'), /프리셋/);
	assert.equal(stage.getWorld(first).imagePresetId, a.id);
	assert.throws(() => deleteImagePreset(a.id, a.revision), /세션/);
	stage.setWorldImagePreset(first, null); deleteImagePreset(a.id, a.revision);
	assert.equal(stage.getWorld(first).imagePresetId, null);
	assert.throws(() => getImagePreset(a.id), /찾을 수/);
});

test('configuration rejects inline secrets, unsupported options and invalid model mappings before persistence', () => {
	for (const config of [hosted('openai', { apiKey: 'must-not-store' }), hosted('openai', { apiKeyEnv: 'BAD KEY' }), hosted('openai', { baseUrl: 'https://user:secret@example.com' }), hosted('xai', { options: { outputFormat: 'png' } }), hosted('openai', { options: { temperature: 1 } }), hosted('other')]) {
		assert.throws(() => checkedImagePresetConfig(config));
	}
	const empty = { provider: 'comfyui', baseUrl: 'http://localhost:22222', stylePrompt: '', workflowId: 'sdxl-simple', profile: defaultComfySettings().profiles['sdxl-simple'] };
	assert.throws(() => checkedImagePresetConfig(empty), /체크포인트/);
});

test('generation snapshots the selected preset while later edits and switches apply to the next request', async () => {
	const worldId = stage.createWorld('Generation snapshots', 'Scene');
	const first = save('Snapshot style', hosted('openai', { model: 'first-model' }));
	const next = save('Next style', hosted('openrouter', { model: 'next-model' }));
	stage.setWorldImagePreset(worldId, first.id);
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	const calls = [];
	globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); await held; return Response.json({ data: [{ b64_json: png.toString('base64') }] }); };
	const pending = generateWorldImage(worldId, 'A red umbrella.');
	assert.equal(calls.length, 1);
	saveImagePreset({ ...first, config: hosted('openai', { model: 'edited-model' }) });
	stage.setWorldImagePreset(worldId, next.id);
	release();
	const result = await pending;
	assert.equal(result.presetId, first.id);
	assert.equal(result.presetRevision, first.revision);
	assert.equal(result.model, 'first-model');
	assert.equal(calls[0].body.prompt, 'Watercolor.\n\nA red umbrella.');
	assert.equal(calls[0].auth, 'Bearer private-image-key');
	const following = await generateWorldImage(worldId, 'Next scene.');
	assert.equal(following.presetId, next.id);
	assert.ok(calls[1].url.endsWith('/images'));
	assert.equal(calls[1].body.model, 'next-model');
});

test('disabled sessions and hosted seed overrides fail before making an HTTP call', async () => {
	const id = stage.createWorld('Images disabled', 'Scene');
	let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('should not call'); };
	await assert.rejects(generateWorldImage(id, 'Scene'), /먼저 선택/);
	await assert.rejects(generateWithImageConfig(hosted(), 'Scene', undefined, 5), /Seed/);
	await assert.rejects(generateWithImageConfig(hosted(), ''), /장면/);
	assert.equal(calls, 0);
});

test('named ComfyUI presets use their own server and profile even when legacy defaults are invalid', async (t) => {
	const oldAddress = process.env.NEWERA_COMFYUI_BASE_URL;
	process.env.NEWERA_COMFYUI_BASE_URL = 'not-a-url';
	t.after(() => { if (oldAddress === undefined) delete process.env.NEWERA_COMFYUI_BASE_URL; else process.env.NEWERA_COMFYUI_BASE_URL = oldAddress; });
	const preset = listImagePresets().find((entry) => entry.provider === 'comfyui');
	let socket; let submitted;
	globalThis.WebSocket = class extends EventTarget {
		constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
		close() {}
	};
	globalThis.fetch = async (url, init) => {
		const path = new URL(url).pathname;
		assert.equal(new URL(url).origin, 'http://localhost:22222');
		if (path === '/models/loras') return Response.json([]);
		if (path === '/object_info') return Response.json({
			SaveImageWebsocket: {}, VAEDecode: {}, EmptyLatentImage: {}, CLIPTextEncode: {}, KSampler: {},
			UNETLoader: { input: { required: { unet_name: [['anima.safetensors']] } } },
			CLIPLoader: { input: { required: { clip_name: [['encoder.safetensors']] } } },
			VAELoader: { input: { required: { vae_name: [['vae.safetensors']] } } }
		});
		assert.equal(path, '/prompt'); submitted = JSON.parse(init.body);
		const dispatch = (type, data) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, data }) }));
		dispatch('executing', { prompt_id: submitted.prompt_id, node: '46' });
		const header = Buffer.alloc(8); header.writeUInt32BE(1); header.writeUInt32BE(2, 4);
		const frame = Buffer.concat([header, png]);
		socket.dispatchEvent(new MessageEvent('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) }));
		dispatch('execution_success', { prompt_id: submitted.prompt_id });
		return Response.json({ prompt_id: submitted.prompt_id });
	};
	const result = await generateWithImageConfig(preset.config, 'A quiet theater.', undefined, 24);
	assert.equal(result.provider, 'comfyui');
	assert.equal(result.seed, 24);
	assert.equal(submitted.prompt['60:11'].inputs.text, 'A quiet theater.');
	assert.equal(submitted.prompt['60:44'].inputs.unet_name, 'anima.safetensors');
	assert.deepEqual(result.images[0].bytes, png);
});

test('the shared request gate releases after failures and rejects overlapping image work', async () => {
	let release; const waiting = new Promise((resolve) => { release = resolve; });
	const active = withImageGeneration(() => waiting);
	await assert.rejects(withImageGeneration(async () => 'overlap'), (error) => error instanceof ImageGenerationBusy);
	release('done'); assert.equal(await active, 'done');
	await assert.rejects(withImageGeneration(async () => { throw new Error('failed'); }), /failed/);
	assert.equal(await withImageGeneration(async () => 'recovered'), 'recovered');
});
