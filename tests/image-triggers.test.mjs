import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleWorld } from '../src/lib/theater/fixtures.ts';
import { initialState } from '../src/lib/theater/runtime.ts';
import { checkedImageTriggers, eligibleImageRule, evaluateImageRules, imageSceneSnapshot, imageTriggerCursor, newImageRule } from '../src/lib/images/triggers.ts';

const directory = mkdtempSync(join(tmpdir(), 'newera-image-triggers-'));
process.env.NEWERA_DATA_DIR = directory;
process.env.NEWERA_IMAGE_TRIGGER_TEST_KEY = 'private-image-trigger-key';
const stage = await import('../src/lib/server/stage-store.ts');
const presets = await import('../src/lib/server/images/presets.ts');
const triggers = await import('../src/lib/server/images/trigger-store.ts');
const { processImageCheck } = await import('../src/lib/server/images/trigger-worker.ts');
const { judgeImageConditions } = await import('../src/lib/server/oev.ts');
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
test.after(() => { stage.store().close(); rmSync(directory, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const config = { provider: 'openai', baseUrl: 'https://images.example.test/v1', apiKeyEnv: 'NEWERA_IMAGE_TRIGGER_TEST_KEY', model: 'first-image-model', options: {}, stylePrompt: 'Watercolor.' };
const preset = presets.saveImagePreset({ revision: 0, name: 'Trigger style', config });
const rule = (extra = {}) => ({ ...newImageRule(), ...extra });
const pureWorld = () => { const definition = exampleWorld(); return { id: 'world', revision: 0, definition, state: initialState(definition) }; };
const createWorld = (rules, enabled = true) => {
	const id = stage.importWorld(JSON.stringify({ format: 'newera-theater', version: 2, world: { definition: exampleWorld() }, saves: [] }));
	stage.setWorldImagePreset(id, preset.id);
	triggers.saveImageTriggers(id, 0, { enabled, rules });
	return id;
};
const advance = (id, minutes = 1, mutate = () => {}) => stage.editWorld(id, stage.getWorld(id).revision, (world) => {
	world.state.minute += minutes; world.state.day += Math.floor(world.state.minute / 1440); world.state.minute %= 1440; world.state.tick++; mutate(world);
});
const queuedJob = (id, manual = false) => {
	const jobId = triggers.queueImageCheck(id, manual); assert.ok(jobId);
	const row = stage.store().prepare('SELECT * FROM theater_illustrations WHERE id = ?').get(jobId);
	return { id: jobId, worldId: id, settingsRevision: row.settings_revision, input: JSON.parse(row.input_json) };
};
const finish = async (id, manual = false) => { const job = queuedJob(id, manual); await processImageCheck(job); return triggers.listIllustrations(id).find((entry) => entry.id === job.id); };

test('story minutes cross midnight; scene and interval rules coalesce; cooldown does not delay a first condition', () => {
	const world = pureWorld(); world.state.minute = 1435;
	const cursor = imageTriggerCursor(world);
	const rules = [rule({ when: 'interval', minutes: 10 }), rule({ when: 'scene' })];
	world.state.day++; world.state.minute = 5; world.state.activeSceneId = 'stage'; world.revision++;
	const result = evaluateImageRules(rules, imageSceneSnapshot(world, rules), cursor, {});
	assert.equal(result.fired.length, 2);
	assert.equal(evaluateImageRules(rules, imageSceneSnapshot(world, rules), result.cursor, {}).fired.length, 0);
	const first = rule({ when: 'condition', sceneId: 'stage', cooldownMinutes: 30 });
	assert.equal(eligibleImageRule(first, imageSceneSnapshot(world, [first]), cursor), true);
});

test('explicit conditions are ANDed, preserve JSON value types and require targets in the current scene', () => {
	const world = pureWorld(); const entity = world.state.instances[0]; entity.state.lit = true;
	const rules = [rule({ when: 'condition', sceneId: entity.sceneId, entityId: entity.id, state: { entityId: entity.id, key: 'lit', equals: true } })];
	world.state.activeSceneId = entity.sceneId;
	assert.equal(imageSceneSnapshot(world, rules).guards[rules[0].id], true);
	rules[0].state.equals = 'true'; assert.equal(imageSceneSnapshot(world, rules).guards[rules[0].id], false);
	rules[0].state.equals = true; entity.active = false; assert.equal(imageSceneSnapshot(world, rules).guards[rules[0].id], false);
});

test('condition rules fire only on false to true, including a semantic condition', () => {
	const world = pureWorld(); const entry = rule({ when: 'condition', naturalLanguage: '두 사람이 우산을 함께 든다.' });
	const scene = imageSceneSnapshot(world, [entry]); let cursor = imageTriggerCursor(world);
	let result = evaluateImageRules([entry], scene, cursor, { [entry.id]: true }); assert.equal(result.fired.length, 1); cursor = result.cursor;
	result = evaluateImageRules([entry], scene, cursor, { [entry.id]: true }); assert.equal(result.fired.length, 0); cursor = result.cursor;
	result = evaluateImageRules([entry], scene, cursor, { [entry.id]: false }); assert.equal(result.fired.length, 0); cursor = result.cursor;
	assert.equal(evaluateImageRules([entry], scene, cursor, { [entry.id]: true }).fired.length, 1);
});

test('scene snapshots exclude private state, memories, goals, personality and relationship impressions', () => {
	const world = pureWorld(); world.state.instances[0].state.secret = 'private-state'; world.state.instances[0].memo = { summary: 'private-memo' }; world.state.instances[0].memories = [{ text: 'private-memory' }];
	world.definition.rules = 'private-rules'; world.definition.templates[0].personality = 'private-personality';
	const snapshot = JSON.stringify(imageSceneSnapshot(world, []));
	for (const marker of ['private-state', 'private-memo', 'private-memory', 'private-rules', 'private-personality']) assert.ok(!snapshot.includes(marker));
});

test('rule validation rejects unbounded, malformed, duplicate and unknown entity conditions', () => {
	for (const entry of [rule({ minutes: 0 }), rule({ cooldownMinutes: -1 }), rule({ when: 'condition' }), rule({ id: '__proto__' }), rule({ state: { entityId: 'x', key: 'x', equals: {} } }), rule({ sceneId: 'missing' })]) assert.throws(() => checkedImageTriggers({ enabled: true, rules: [entry] }, pureWorld()));
	const duplicate = rule(); assert.throws(() => checkedImageTriggers({ enabled: true, rules: [duplicate, duplicate] }));
	assert.throws(() => checkedImageTriggers({ enabled: true, rules: Array.from({ length: 11 }, () => rule()) }));
});

test('settings are isolated, revision guarded, disabled by default and retained across reset/slots but excluded from exports', () => {
	const id = createWorld([rule({ when: 'interval' })]); const other = stage.createWorld('No automatic images', 'No image settings yet.');
	assert.deepEqual(triggers.getImageTriggers(other), { revision: 0, config: { enabled: false, rules: [] } });
	assert.throws(() => triggers.saveImageTriggers(other, 0, { enabled: true, rules: [] }), /프리셋/);
	assert.equal(triggers.queueImageCheck(other), null);
	assert.throws(() => triggers.saveImageTriggers(id, 0, { enabled: false, rules: [] }), /변경/);
	stage.saveWorld(id, 1); stage.resetWorld(id, stage.getWorld(id).revision); stage.loadWorld(id, stage.getWorld(id).revision, 1);
	assert.equal(triggers.getImageTriggers(id).config.rules.length, 1);
	assert.ok(!stage.exportWorld(id).includes('cooldownMinutes'));
	assert.equal(triggers.queueImageCheck(id), null, 'reset establishes a new time baseline');
	const invalidModel = createWorld([rule({ when: 'condition', naturalLanguage: '장면이 조용하다.' })]);
	const previousTimeout = process.env.NEWERA_LLM_TIMEOUT_MS;
	process.env.NEWERA_LLM_TIMEOUT_MS = '0';
	try {
		advance(invalidModel); assert.ok(triggers.queueImageCheck(invalidModel), 'invalid image judgment config must not break scene requests');
		assert.equal(triggers.listIllustrations(invalidModel)[0].status, 'failed');
	} finally { if (previousTimeout === undefined) delete process.env.NEWERA_LLM_TIMEOUT_MS; else process.env.NEWERA_LLM_TIMEOUT_MS = previousTimeout; }
});

test('automatic interval work captures the preset, consumes the trigger and stores bytes without exposing config', async () => {
	const calls = []; globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ data: [{ b64_json: png.toString('base64') }] }); };
	const id = createWorld([rule({ when: 'interval', minutes: 10, prompt: 'Emphasize the umbrella.' })]);
	advance(id, 10); const job = queuedJob(id);
	presets.saveImagePreset({ ...preset, name: preset.name, config: { ...config, model: 'later-image-model' } });
	await processImageCheck(job);
	assert.equal(calls[0].model, 'first-image-model'); assert.ok(calls[0].prompt.startsWith('Watercolor.')); assert.ok(calls[0].prompt.includes('Emphasize the umbrella.'));
	assert.equal(triggers.queueImageCheck(id), null);
	const images = triggers.listIllustrations(id); assert.equal(images[0].status, 'completed'); assert.ok(!JSON.stringify(images).includes('private-image-trigger-key')); assert.ok(!JSON.stringify(images).includes('apiKeyEnv'));
	const row = stage.store().prepare('SELECT bytes,media_type,input_json FROM theater_illustrations WHERE id = ?').get(job.id); assert.deepEqual(Buffer.from(row.bytes), png); assert.equal(row.media_type, 'image/png'); assert.ok(!row.input_json.includes('private-image-trigger-key'));
	advance(id, 1); await finish(id); assert.equal(calls.length, 1, 'interval cursor prevents a call on every turn');
});

test('semantic checks are batched, use the text model and fail closed on malformed replies', async () => {
	const requests = [];
	globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); requests.push(body); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ matches: [{ id: 'a', matched: true }, { id: 'b', matched: false }] }) } }] }); };
	const previousTimeout = process.env.NEWERA_LLM_TIMEOUT_MS;
	process.env.NEWERA_LLM_TIMEOUT_MS = '1800000';
	try { assert.deepEqual(await judgeImageConditions([{ id: 'a', condition: 'rain' }, { id: 'b', condition: 'sun' }], 'visible-scene-only', { textModel: 'custom-text-model', decisionModel: 'decision' }, new AbortController().signal), { a: true, b: false }); }
	finally { if (previousTimeout === undefined) delete process.env.NEWERA_LLM_TIMEOUT_MS; else process.env.NEWERA_LLM_TIMEOUT_MS = previousTimeout; }
	assert.equal(requests[0].model, 'custom-text-model'); assert.equal(requests[0].response_format.json_schema.name, 'image_conditions');
	const badRules = [rule({ when: 'condition', naturalLanguage: '공연이 시작된다.' })]; const id = createWorld(badRules); advance(id);
	const failed = await finish(id); assert.equal(failed.status, 'failed'); assert.equal(requests.length, 2, 'only one judgment call, no image call or automatic retries');
});

test('natural and explicit guards combine; continuous true does not cause repeated images', async () => {
	const semantic = rule({ when: 'condition', sceneId: 'lobby', naturalLanguage: '장면이 조용하다.' }); const id = createWorld([semantic]);
	let matches = true; let imageCalls = 0; let judgmentCalls = 0;
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith('/images/generations')) { imageCalls++; return Response.json({ data: [{ b64_json: png.toString('base64') }] }); }
		judgmentCalls++; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ matches: [{ id: semantic.id, matched: matches }] }) } }] });
	};
	advance(id); await finish(id); assert.equal(imageCalls, 1);
	advance(id); await finish(id); assert.equal(imageCalls, 1);
	matches = false; advance(id); await finish(id); assert.equal(imageCalls, 1);
	matches = true; advance(id); await finish(id); assert.equal(imageCalls, 2);
	advance(id, 1, (world) => { world.state.activeSceneId = 'stage'; for (const entity of world.state.instances) if (entity.companion) entity.sceneId = 'stage'; }); await finish(id); assert.equal(judgmentCalls, 4, 'false explicit guards do not invoke a semantic model');
});

test('failures consume the trigger and interrupted billable requests are not replayed after recovery', async () => {
	let calls = 0; globalThis.fetch = async () => { calls++; return new Response('private-image-trigger-key', { status: 500 }); };
	const id = createWorld([rule({ when: 'interval', minutes: 5 })]); advance(id, 5);
	const image = await finish(id); assert.equal(image.status, 'failed'); assert.equal(calls, 1); assert.ok(!image.error.includes('private-image-trigger-key')); assert.equal(triggers.queueImageCheck(id), null);
	advance(id); await finish(id); assert.equal(calls, 1);
	const manual = queuedJob(id, true); triggers.setImageCheckStatus(manual.id, 'generating'); triggers.recoverImageChecks();
	assert.equal(triggers.listIllustrations(id).find((entry) => entry.id === manual.id).status, 'failed');
	assert.notEqual(triggers.pendingImageCheck()?.id, manual.id);
});

test('disabling settings fences pending semantic work; clearing or resetting discards a late image response', async () => {
	let release; let calls = 0;
	globalThis.fetch = async () => { calls++; return await new Promise((resolve) => { release = () => resolve(Response.json({ data: [{ b64_json: png.toString('base64') }] })); }); };
	const id = createWorld([rule({ when: 'interval', minutes: 1 })]); advance(id); const stale = queuedJob(id);
	triggers.saveImageTriggers(id, 1, { enabled: false, rules: [] }); await processImageCheck(stale); assert.equal(calls, 0);
	const manual = queuedJob(id, true); const pending = processImageCheck(manual); await new Promise(resolve => setTimeout(resolve, 0));
	triggers.clearIllustrations(id); release(); await pending; assert.deepEqual(triggers.listIllustrations(id), []);
	const another = queuedJob(id, true); const resetting = processImageCheck(another); await new Promise(resolve => setTimeout(resolve, 0));
	stage.resetWorld(id, stage.getWorld(id).revision); release(); await resetting; assert.deepEqual(triggers.listIllustrations(id), []);
});
