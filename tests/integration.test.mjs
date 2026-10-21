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
async function app(directory, provider, environment = {}) {
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	let output = '';
	const child = spawn(process.execPath, ['build/index.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: base, NEWERA_DATA_DIR: directory, NEWERA_OEV_BASE_URL: provider, NEWERA_DECISION_MODEL: 'actor-model', NEWERA_TEXT_MODEL: 'actor-model', NEWERA_MAX_RETRIES: '0', ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
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
	let invalidNextGeneration = false;
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
			response.end(JSON.stringify({ answers: { participation: { type: 'choice', choice: 'act' } } }));
		} else if (request.url === '/v1/chat/completions') {
			const state = JSON.parse(body.messages[1].content);
			const output = { actionId: 'speak:player', targetId: 'player', narrative: `${state.self.name}은 고개를 끄덕인다.`, utterance: `${state.self.name}의 대답입니다.`, memoUpdate: { summary: `${state.self.id}만의 메모`, currentIntention: '준비를 계속한다.', feelings: ['기대'], openThreads: [] } };
			if (invalidNextGeneration) { invalidNextGeneration = false; output.actionId = 'interact:offstage:forged'; }
			response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
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
		assert.ok(calls.filter((call) => call.path.endsWith('systemone'))[1].body.state.recentEvents.some((event) => event.actorId === 'seoyeon' && event.body.utterance === '서연의 대답입니다.'));
		assert.equal(snapshot().state.events.filter((entry) => entry.kind === 'speak').length, 3);
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon만의 메모');
		assert.deepEqual(Object.keys(calls[0].body.questions), ['participation']);
		const generation = calls.find((call) => call.path.endsWith('chat/completions'));
		assert.equal(generation.body.response_format.json_schema.strict, true);
		assert.equal(JSON.parse(generation.body.messages[1].content).availableActions.some((action) => action.kind === 'wait'), false);
		assert.ok(!JSON.stringify(calls.filter((call) => call.path.endsWith('systemone'))[1].body).includes('seoyeon만의 메모'));
		const firstObservation = calls.find((call) => call.path.endsWith('systemone')).body.state;
		assert.ok(firstObservation.self.memories.every((memory) => memory.actorId && memory.body && !Object.hasOwn(memory, 'text')));
		assert.equal(firstObservation.self.memories.at(-1).actorId, 'player');
		assert.equal(firstObservation.self.memories.at(-1).targetId, 'seoyeon');
		assert.equal(firstObservation.self.memories.at(-1).body.utterance, '함께 준비할까요?');
		page = await (await fetch(base)).text();
		const seoyeonArticle = page.match(/<article\b[^>]*class="stage-event[^>]*>[\s\S]*?<\/article>/g).find((article) => article.includes('서연의 대답입니다.'));
		assert.match(seoyeonArticle, /class="event-action"[\s\S]*?<p>서연은 고개를 끄덕인다\.<\/p>/);
		assert.match(seoyeonArticle, /class="event-speech"[\s\S]*?<blockquote>서연의 대답입니다\.<\/blockquote>/);
		assert.ok(!seoyeonArticle.includes('<p>서연은 고개를 끄덕인다.\n서연의 대답입니다.</p>'));
		const transcript = await (await fetch(`${base}/session/export?worldId=${originalId}`)).text();
		assert.match(transcript, /\*\*행동\*\*: 서연은 고개를 끄덕인다\./);
		assert.match(transcript, /\*\*대사\*\*\n\n> 서연의 대답입니다\./);
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
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon만의 메모');
		const beforeInvalidGeneration = snapshot();
		invalidNextGeneration = true;
		await post(base, 'turn', { ...fields(), kind: 'wait' });
		await waitJob(base, db, originalId, true);
		assert.equal(snapshot().state.tick, beforeInvalidGeneration.state.tick + 1);
		assert.deepEqual(snapshot().state.events.slice(beforeInvalidGeneration.state.events.length).map((event) => event.actorId), ['player'], 'a rejected generation must preserve the input without publishing an invalid character action');
		for (const previous of beforeInvalidGeneration.state.instances) {
			const current = snapshot().state.instances.find((entry) => entry.id === previous.id);
			assert.deepEqual(current.memo, previous.memo, 'a rejected generation must not change a memo');
			assert.deepEqual(current.state, previous.state, 'a rejected generation must not change object state');
		}
		failNext = true;
		await post(base, 'turn', { ...fields(), kind: 'wait' });
		await waitJob(base, db, originalId, true);
		assert.equal(snapshot().state.tick, 4);

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
		assert.equal(snapshot(originalId).state.tick, 5);
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
		assert.equal(exportedWorld.saves[0].world.state.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon만의 메모');
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

test('individual results are visible while the next inference is pending and resume without replay after restart', async () => {
	const calls = [];
	const callModels = [];
	let held = false;
	let failHarin = false;
	let release;
	const hold = new Promise((done) => { release = done; });
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }, { id: 'other-model', task: 'generation' }] })); return; }
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (request.url === '/v1/systemone') { response.end(JSON.stringify({ answers: { participation: { type: 'choice', choice: 'act' } } })); return; }
		const state = JSON.parse(body.messages[1].content);
		calls.push(state.self.id);
		callModels.push(body.model);
		if (state.self.id === 'harin' && !held) { held = true; await hold; }
		if (state.self.id === 'harin' && failHarin) { response.statusCode = 503; response.end('{"error":"offline"}'); return; }
		const output = { actionId: 'speak:player', targetId: 'player', narrative: `${state.self.name}은 고개를 끄덕인다.`, utterance: `${state.self.name}의 확정된 대사`, memoUpdate: { summary: `${state.self.id} 메모`, currentIntention: '', feelings: [], openThreads: [] } };
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
	});
	const modelPort = await listen(model);
	const directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
	const snapshot = () => { const row = db.prepare('SELECT revision, state_json FROM theater_worlds WHERE id = ?').get(worldId); return { revision: row.revision, state: JSON.parse(row.state_json) }; };
	try {
		await post(running.base, 'turn', { worldId, revision: String(snapshot().revision), kind: 'speak', text: '앞선 답부터 보여줘.', targetId: 'seoyeon' });
		for (let index = 0; index < 300 && !held; index++) await pause(20);
		assert.ok(held, 'the next actor must be waiting for generation');
		const pending = await latestJob(running.base, db, worldId);
		assert.equal(pending.status, 'running');
		assert.deepEqual(pending.progress, { actorIds: ['seoyeon', 'harin'], nextActorIndex: 1 });
		const partial = snapshot();
		assert.equal(partial.revision, pending.revision);
		assert.deepEqual(partial.state.events.map((event) => event.actorId), ['player', 'seoyeon']);
		assert.equal(partial.state.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon 메모');
		const page = await (await fetch(running.base)).text();
		assert.match(page, /서연의 확정된 대사/);
		assert.ok(!page.includes('하린의 확정된 대사'));
		assert.match(page, /\(1\/2\)/);
		await post(running.base, 'models', { worldId, decisionModel: 'other-model', textModel: 'other-model' });

		await running.stop();
		db.prepare("UPDATE theater_jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(pending.id);
		running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
		release();
		await waitJob(running.base, db, worldId);
		const resumed = snapshot();
		assert.equal(resumed.state.tick, 1, 'the original input must not be replayed');
		assert.equal(calls.filter((id) => id === 'seoyeon').length, 1, 'the committed actor must not be inferred again');
		assert.ok(callModels.every((model) => model === 'actor-model'), 'resuming a job must retain its original models after the session preference changes');
		assert.deepEqual(resumed.state.events.slice(0, partial.state.events.length), partial.state.events);
		assert.deepEqual(resumed.state.events.map((event) => event.actorId), ['player', 'seoyeon', 'harin']);

		failHarin = true;
		await post(running.base, 'turn', { worldId, revision: String(resumed.revision), kind: 'wait' });
		await waitJob(running.base, db, worldId, true);
		const failed = snapshot();
		assert.equal(failed.state.tick, 2);
		assert.deepEqual(failed.state.events.slice(resumed.state.events.length).map((event) => event.actorId), ['player', 'seoyeon'], 'failure of a later actor must retain earlier results');
		const failedPage = await (await fetch(running.base)).text();
		assert.match(failedPage, /이미 확정된 말과 행동은 유지됩니다/);
	} finally {
		release(); await running.stop(); db.close(); model.closeAllConnections(); await new Promise((done) => model.close(done));
	}
});

test('session model selection is isolated, active jobs retain their snapshot and retries do not duplicate actions', async () => {
	const calls = [];
	let started = false;
	let release;
	let failFirst = true;
	let failHarin = false;
	const hold = new Promise((done) => { release = done; });
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }, { id: 'other-model', task: 'generation' }, { id: 'embed', task: 'embedding' }] })); return; }
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		const state = request.url === '/v1/systemone' ? body.state : JSON.parse(body.messages[1].content);
		calls.push({ path: request.url, model: body.model, actor: state.self.id });
		if (request.url === '/v1/systemone') { response.end(JSON.stringify({ answers: { participation: { type: 'choice', choice: 'act' } } })); return; }
		if (failFirst) {
			failFirst = false; started = true; await hold;
			response.statusCode = 502; response.end('{"error":{"code":"invalid_model_output","message":"Expecting value"}}'); return;
		}
		if (failHarin && state.self.id === 'harin') { response.statusCode = 503; response.end('{"error":"offline"}'); return; }
		const output = { actionId: 'speak:player', targetId: 'player', narrative: '고개를 끄덕인다.', utterance: `${state.self.name}의 대사`, memoUpdate: null };
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
	});
	const modelPort = await listen(model);
	const directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${modelPort}/v1`, { NEWERA_MAX_RETRIES: '2', NEWERA_RETRY_BASE_MS: '5', NEWERA_RETRY_MAX_MS: '10' });
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const activeId = () => db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
	const snapshot = (id) => { const row = db.prepare('SELECT revision, state_json, model_settings_json FROM theater_worlds WHERE id = ?').get(id); return { revision: row.revision, state: JSON.parse(row.state_json), models: row.model_settings_json ? JSON.parse(row.model_settings_json) : null }; };
	try {
		const first = activeId();
		const catalog = await (await fetch(`${running.base}/api/models`)).json();
		assert.deepEqual(catalog.models, ['actor-model', 'other-model']);
		const untouched = snapshot(first);
		await post(running.base, 'models', { worldId: first, decisionModel: 'embed', textModel: 'actor-model' }, '/', true);
		assert.deepEqual(snapshot(first), untouched);
		const originalModels = { decisionModel: 'other-model', textModel: 'actor-model' };
		await post(running.base, 'models', { worldId: first, ...originalModels });
		assert.equal(snapshot(first).revision, untouched.revision);
		assert.deepEqual(snapshot(first).state, untouched.state);
		await post(running.base, 'createWorld', { name: '독립 모델 세션', description: '다른 세계관.' }, '/lores');
		const second = activeId();
		assert.equal(snapshot(second).models, null);
		const nextModels = { decisionModel: 'actor-model', textModel: 'other-model' };
		await post(running.base, 'models', { worldId: second, ...nextModels });
		await post(running.base, 'selectWorld', { worldId: first });
		await post(running.base, 'turn', { worldId: first, revision: String(snapshot(first).revision), kind: 'speak', text: '모델을 바꿔도 지금 답은 이어가 줘.', targetId: 'seoyeon' });
		for (let index = 0; index < 300 && !started; index++) await pause(20);
		assert.ok(started);
		const pending = await latestJob(running.base, db, first);
		assert.deepEqual(pending.models, originalModels);
		const activeRevision = snapshot(first).revision;
		await post(running.base, 'models', { worldId: first, ...nextModels });
		assert.equal(snapshot(first).revision, activeRevision, 'changing the next model must not invalidate the active scene');
		assert.deepEqual((await latestJob(running.base, db, first)).models, originalModels);
		release();
		await waitJob(running.base, db, first);
		const completed = snapshot(first);
		assert.deepEqual(completed.state.events.map((event) => event.actorId), ['player', 'seoyeon', 'harin']);
		assert.equal(calls.filter((call) => call.path.endsWith('systemone') && call.actor === 'seoyeon').length, 1);
		assert.equal(calls.filter((call) => call.path.endsWith('chat/completions') && call.actor === 'seoyeon').length, 2);
		assert.ok(calls.filter((call) => call.path.endsWith('systemone')).every((call) => call.model === originalModels.decisionModel));
		assert.ok(calls.filter((call) => call.path.endsWith('chat/completions')).every((call) => call.model === originalModels.textModel));
		assert.equal(completed.state.events.find((event) => event.actorId === 'seoyeon').decision.generationModel, originalModels.textModel);
		const boundary = calls.length;
		failHarin = true;
		await post(running.base, 'turn', { worldId: first, revision: String(completed.revision), kind: 'wait' });
		const failed = await waitJob(running.base, db, first, true);
		assert.deepEqual(failed.models, nextModels);
		assert.match(failed.error, /3회 시도 후 실패/);
		assert.deepEqual(snapshot(first).state.events.slice(completed.state.events.length).map((event) => event.actorId), ['player', 'seoyeon']);
		const later = calls.slice(boundary);
		assert.equal(later.filter((call) => call.path.endsWith('chat/completions') && call.actor === 'harin').length, 3);
		assert.ok(later.filter((call) => call.path.endsWith('systemone')).every((call) => call.model === nextModels.decisionModel));
		assert.ok(later.filter((call) => call.path.endsWith('chat/completions')).every((call) => call.model === nextModels.textModel));
		await running.stop();
		running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
		assert.deepEqual(snapshot(first).models, nextModels);
		assert.deepEqual(snapshot(second).models, nextModels);
		await post(running.base, 'models', { worldId: first, mode: 'defaults' });
		assert.equal(snapshot(first).models, null);
		assert.deepEqual(snapshot(second).models, nextModels);
	} finally { release(); await running.stop(); db.close(); model.closeAllConnections(); await new Promise((done) => model.close(done)); }
});

test('fresh storage contains only scene-based data and rejects unsupported imports', async () => {
	const directory = scratch();
	let running = await app(directory, 'http://127.0.0.1:1/v1');
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	try {
		assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ['theater_jobs', 'theater_meta', 'theater_saves', 'theater_worlds']);
		assert.deepEqual(db.prepare('PRAGMA table_info(theater_worlds)').all().map((row) => row.name), ['id', 'revision', 'definition_json', 'state_json', 'created_at', 'model_settings_json']);
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
		const beforeMigration = db.prepare('SELECT definition_json, state_json FROM theater_worlds WHERE id = ?').get(id);
		await running.stop();
		db.exec('ALTER TABLE theater_jobs DROP COLUMN progress_json');
		db.exec('ALTER TABLE theater_jobs DROP COLUMN models_json');
		db.exec('ALTER TABLE theater_worlds DROP COLUMN model_settings_json');
		running = await app(directory, 'http://127.0.0.1:1/v1');
		assert.ok(db.prepare('PRAGMA table_info(theater_jobs)').all().some((column) => column.name === 'progress_json'));
		assert.ok(db.prepare('PRAGMA table_info(theater_jobs)').all().some((column) => column.name === 'models_json'));
		assert.ok(db.prepare('PRAGMA table_info(theater_worlds)').all().some((column) => column.name === 'model_settings_json'));
		assert.deepEqual(db.prepare('SELECT definition_json, state_json FROM theater_worlds WHERE id = ?').get(id), beforeMigration, 'adding the progress cursor must preserve existing world data');
	} finally { await running.stop(); db.close(); }
});

test.after(() => {
	for (const directory of scratchDirectories) {
		if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') && directory.includes('newera-theater-integration-')) rmSync(directory, { recursive: true, force: true });
	}
});
