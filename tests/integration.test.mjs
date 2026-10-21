import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const scratchDirectories = [];
function scratch() { const path = mkdtempSync(join(tmpdir(), 'newera-theater-integration-')); scratchDirectories.push(path); return path; }
async function listen(server) { await new Promise((done) => server.listen(0, '127.0.0.1', done)); return server.address().port; }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise((done) => server.close(done)); return port; }
async function app(directory, provider) {
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	let output = '';
	const child = spawn(process.execPath, ['build/index.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: base, NEWERA_DATA_DIR: directory, NEWERA_OEV_BASE_URL: provider, NEWERA_DECISION_MODEL: 'actor-model', NEWERA_TEXT_MODEL: 'actor-model' }, stdio: ['ignore', 'pipe', 'pipe'] });
	for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-8000); });
	for (let index = 0; index < 100; index++) {
		if (child.exitCode !== null) throw new Error(`app exited: ${output}`);
		try { const response = await fetch(base); if (response.ok) break; } catch { /* starting */ }
		if (index === 99) { child.kill(); throw new Error(`app failed to start: ${output}`); }
		await pause(50);
	}
	return { base, child, async stop() { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } } };
}
async function post(base, action, fields, path = '/', failure = false) {
	const response = await fetch(`${base}${path}?/${action}`, { method: 'POST', headers: { origin: base }, body: new URLSearchParams(fields) });
	const result = await response.text();
	assert.equal(response.status, 200, result);
	assert.equal(JSON.parse(result).type === 'failure', failure, result);
}
async function exported(base, worldId) { return (await fetch(`${base}/lores/export/${encodeURIComponent(worldId)}`)).json(); }
async function current(base) {
	const html = await (await fetch(base)).text();
	const worldId = /name="worldId" value="([^"]+)"/.exec(html)?.[1];
	assert.ok(worldId, 'world id not found in page');
	return (await exported(base, worldId)).world;
}
async function latestJob(base, db, worldId) {
	const row = db.prepare('SELECT id FROM theater_jobs WHERE world_id = ? ORDER BY rowid DESC LIMIT 1').get(worldId);
	return row ? (await (await fetch(`${base}/api/generation?id=${row.id}`)).json()).generation : null;
}
async function waitJob(base, db, worldId, failure = false) {
	for (let index = 0; index < 300; index++) {
		const job = await latestJob(base, db, worldId);
		if (job && ['completed', 'failed'].includes(job.status)) { assert.equal(job.status, failure ? 'failed' : 'completed', job.error || 'job status'); return job; }
		await pause(20);
	}
	assert.fail('job did not finish');
}

test('scene play, typed decisions, multiple residents, object state, companions and world isolation', async () => {
	const calls = [];
	let failNext = false;
	let pauseNext = null;
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		calls.push({ path: request.url, body });
		if (pauseNext) { const hold = pauseNext; pauseNext = null; hold.started(); await hold.wait; }
		if (failNext) { failNext = false; response.statusCode = 503; response.end('{"error":"offline"}'); return; }
		if (request.url === '/v1/systemone') {
			const criteria = body.questions.action.criteria;
			const choice = Object.entries(criteria).find(([, label]) => label === '플레이어에게 말한다')?.[0] || Object.keys(criteria)[0];
			response.end(JSON.stringify({ answers: { action: { type: 'choice', choice }, react: { type: 'noul', noul: 0.9 }, intensity: { type: 'score', score: 1.3 } } }));
		} else if (request.url === '/v1/chat/completions') {
			const state = JSON.parse(body.messages[1].content);
			response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `${state.self.name}의 대답입니다.` } }] }));
		} else { response.statusCode = 404; response.end('{}'); }
	});
	const modelPort = await listen(model);
	const directory = scratch();
	const running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const base = running.base;
	const activeId = () => db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
	const snapshot = (id = activeId()) => { const row = db.prepare('SELECT * FROM theater_worlds WHERE id = ?').get(id); return { id, revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) }; };
	const fields = (id = activeId()) => ({ worldId: id, revision: String(snapshot(id).revision) });
	try {
		let page = await (await fetch(base)).text();
		assert.match(page, /극장 로비/);
		assert.ok(!page.includes('PALAM'));
		assert.equal(calls.length, 0);
		const originalId = activeId();
		await post(base, 'turn', { ...fields(), kind: 'speak', text: '함께 준비할까요?', targetId: 'seoyeon' });
		await waitJob(base, db, originalId);
		assert.deepEqual(calls.filter((call) => call.path.endsWith('systemone')).map((call) => call.body.state.self.id), ['seoyeon', 'harin']);
		assert.ok(calls.filter((call) => call.path.endsWith('systemone'))[1].body.state.recentEvents.some((event) => event.text === '서연의 대답입니다.'));
		assert.equal(snapshot().state.events.filter((entry) => entry.kind === 'speak').length, 3);
		await post(base, 'turn', { ...fields(), kind: 'interact', targetId: 'desk-bell', interactionId: 'ring' });
		await waitJob(base, db, originalId);
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'desk-bell').state.rung, true);
		assert.ok(snapshot().state.events.some((entry) => /종소리/.test(entry.text)));
		await post(base, 'save', { worldId: originalId, slot: '1' });
		await post(base, 'turn', { ...fields(), kind: 'move', destinationId: 'stage' });
		await waitJob(base, db, originalId);
		assert.equal(snapshot().state.activeSceneId, 'stage');
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'harin').sceneId, 'stage');
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'seoyeon').sceneId, 'lobby');
		const lastDecisions = calls.filter((call) => call.path.endsWith('systemone')).slice(-2);
		assert.deepEqual(lastDecisions.map((call) => call.body.state.self.id), ['jieun', 'harin']);
		assert.ok(!JSON.stringify(lastDecisions[0].body.state).includes('함께 준비할까요?'));
		await post(base, 'load', { ...fields(), slot: '1' });
		assert.equal(snapshot().state.activeSceneId, 'lobby');
		assert.equal(snapshot().state.tick, 2);
		failNext = true;
		await post(base, 'turn', { ...fields(), kind: 'wait' });
		await waitJob(base, db, originalId, true);
		assert.equal(snapshot().state.tick, 2);

		let signalStarted;
		let release;
		const started = new Promise((done) => { signalStarted = done; });
		pauseNext = { started: signalStarted, wait: new Promise((done) => { release = done; }) };
		await post(base, 'turn', { ...fields(), kind: 'wait' });
		await started;
		await post(base, 'createWorld', { name: '다른 세계', description: '별개의 무대.' }, '/lores');
		const secondId = activeId();
		assert.notEqual(secondId, originalId);
		release();
		await waitJob(base, db, originalId);
		assert.equal(snapshot(originalId).state.tick, 3);
		assert.equal(snapshot(secondId).state.tick, 0);
		const callsBeforeEmpty = calls.length;
		await post(base, 'turn', { ...fields(), kind: 'wait' });
		await waitJob(base, db, secondId);
		assert.equal(calls.length, callsBeforeEmpty, 'empty scenes must not invoke a model');
		assert.equal(snapshot().state.tick, 1);
		await post(base, 'scene', { ...fields(), name: '정원', description: '작은 정원.', exits: 'opening' }, '/lores');
		const garden = snapshot().definition.scenes.find((scene) => scene.name === '정원');
		assert.ok(snapshot().definition.scenes[0].exits.includes(garden.id));
		assert.deepEqual(garden.exits, ['opening']);
		await post(base, 'template', { ...fields(), kind: 'object', name: '문', description: '정원으로 통하는 문.', initialState: '{"open":false}', interactions: JSON.stringify([{ id: 'open', label: '문을 연다', description: '문고리를 돌린다.', conditions: [{ key: 'open', equals: false }], effects: { open: true } }]), reactions: '[]' }, '/lores');
		const doorTemplate = snapshot().definition.templates[0].id;
		for (const name of ['왼쪽 문', '오른쪽 문']) await post(base, 'spawn', { ...fields(), templateId: doorTemplate, sceneId: 'opening', name }, '/lores');
		const doors = snapshot().state.instances;
		await post(base, 'turn', { ...fields(), kind: 'interact', targetId: doors[0].id, interactionId: 'open' });
		await waitJob(base, db, secondId);
		assert.equal(snapshot().state.instances[0].state.open, true);
		assert.equal(snapshot().state.instances[1].state.open, false);
		assert.equal(calls.length, callsBeforeEmpty);
		const beforeInvalid = db.prepare('SELECT count(*) AS n FROM theater_worlds').get().n;
		const invalid = await exported(base, secondId);
		invalid.world.state.activeSceneId = 'missing';
		const invalidFile = new FormData(); invalidFile.append('file', new Blob([JSON.stringify(invalid)]), 'invalid.json');
		const invalidResponse = await fetch(`${base}/lores?/importWorld`, { method: 'POST', headers: { origin: base }, body: invalidFile });
		assert.equal((await invalidResponse.json()).type, 'failure');
		assert.equal(db.prepare('SELECT count(*) AS n FROM theater_worlds').get().n, beforeInvalid);
		const recoverId = 'recover-stale-job';
		db.prepare("INSERT INTO theater_jobs (id, world_id, revision, request_json, status, worker_id, heartbeat_at, created_at) VALUES (?, ?, ?, ?, 'running', 'old-worker', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')")
			.run(recoverId, secondId, snapshot().revision, '{"kind":"wait"}');
		await fetch(`${base}/api/generation?id=${recoverId}`);
		assert.equal((await waitJob(base, db, secondId)).id, recoverId);
		assert.notEqual(db.prepare('SELECT worker_id FROM theater_jobs WHERE id = ?').get(recoverId).worker_id, 'old-worker');

		await post(base, 'selectWorld', { worldId: originalId });
		let staleStarted;
		let staleRelease;
		const staleStart = new Promise((done) => { staleStarted = done; });
		pauseNext = { started: staleStarted, wait: new Promise((done) => { staleRelease = done; }) };
		await post(base, 'turn', { ...fields(), kind: 'wait' });
		await staleStart;
		await post(base, 'reset', fields());
		staleRelease();
		await waitJob(base, db, originalId, true);
		assert.equal(snapshot().state.tick, 0);
		assert.equal(snapshot().state.events.length, 0);
		await post(base, 'turn', { ...fields(), kind: 'move', destinationId: 'missing' }, '/', true);
		const exportedWorld = await exported(base, originalId);
		assert.equal(exportedWorld.version, 2);
		assert.equal(exportedWorld.saves.length, 1);
		const file = new FormData();
		file.append('file', new Blob([JSON.stringify(exportedWorld)], { type: 'application/json' }), 'world.json');
		assert.equal((await fetch(`${base}/lores?/importWorld`, { method: 'POST', headers: { origin: base }, body: file })).status, 200);
		assert.equal(snapshot().definition.name, exportedWorld.world.definition.name);
		assert.notEqual(activeId(), originalId);
		assert.equal(db.prepare('SELECT count(*) AS n FROM theater_saves WHERE world_id = ?').get(activeId()).n, 1);
		page = await (await fetch(`${base}/lores`)).text();
		assert.match(page, /씬의 인스턴스와 동행/);
		assert.ok(!page.includes('era 규칙'));
		assert.equal((await fetch(`${base}/api/suggestions`, { method: 'POST' })).status, 404);
		assert.equal((await fetch(`${base}/simulator`, { redirect: 'manual' })).status, 308);
		assert.match(await (await fetch(`${base}/session/export`)).text(), /비가 그친 뒤의 극장/);
	} finally {
		await running.stop(); db.close(); model.closeAllConnections(); await new Promise((done) => model.close(done));
	}
});

test('fresh storage contains only scene-based data and rejects unsupported imports', async () => {
	const directory = scratch();
	const running = await app(directory, 'http://127.0.0.1:1/v1');
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	try {
		assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ['theater_jobs', 'theater_meta', 'theater_saves', 'theater_worlds']);
		assert.deepEqual(db.prepare('PRAGMA table_info(theater_worlds)').all().map((row) => row.name), ['id', 'revision', 'definition_json', 'state_json', 'created_at']);
		const unsupported = { format: 'newera-lore', version: 1, title: 'Unsupported', state: {}, saves: [] };
		const file = new FormData(); file.append('file', new Blob([JSON.stringify(unsupported)]), 'unsupported.json');
		const response = await fetch(`${running.base}/lores?/importWorld`, { method: 'POST', headers: { origin: running.base }, body: file });
		assert.equal((await response.json()).type, 'failure');
		assert.equal(db.prepare('SELECT count(*) AS n FROM theater_worlds').get().n, 1);
		const id = db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
		const bundle = await exported(running.base, id);
		assert.deepEqual(Object.keys(bundle).sort(), ['format', 'saves', 'version', 'world']);
		assert.equal(bundle.world.definition.name, '비가 그친 뒤의 극장');
		assert.equal(bundle.world.state.tick, 0);
		assert.deepEqual(bundle.world.state.instances.filter((instance) => instance.companion).map((instance) => instance.name), ['하린']);
		assert.equal(JSON.parse(readFileSync('static/lore-presets/theater-opening.json', 'utf8')).version, 2);
	} finally { await running.stop(); db.close(); }
});

test.after(() => {
	for (const directory of scratchDirectories) {
		if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') && directory.includes('newera-theater-integration-')) rmSync(directory, { recursive: true, force: true });
	}
});
