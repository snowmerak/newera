import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// These fixtures answer once per player input, then deliberately choose to listen.
const participation = (state) => state.recentEvents.some((event) => event.tick === state.time.tick && event.actorId === state.self.id && event.kind === 'speak') ? 'wait' : 'act';
function replyPerformanceReview(body, response) {
	if (body.questions?.identity_check) {
		response.end(JSON.stringify({ answers: { identity_check: { type: 'choice', choice: 'consistent' } } }));
		return true;
	}
	if (!body.questions?.performance_check) return false;
	response.end(JSON.stringify({ answers: { performance_check: { type: 'choice', choice: 'accept' } } }));
	return true;
}
function replyReflection(body, response) {
	if (body.response_format?.json_schema?.name !== 'character_reflection') return false;
	response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ relationshipUpdates: [], memoUpdate: null }) } }] }));
	return true;
}
const participationResponse = (choice, inactivity = 'watch') => JSON.stringify({ answers: { participation: { type: 'choice', choice }, inactivity: { type: 'choice', choice: inactivity } } });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const scratchDirectories = [];
function scratch() { const path = mkdtempSync(join(tmpdir(), 'newera-theater-integration-')); scratchDirectories.push(path); return path; }
async function listen(server) { await new Promise((done) => server.listen(0, '127.0.0.1', done)); return server.address().port; }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise((done) => server.close(done)); return port; }
async function app(directory, provider, environment = {}) {
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	let output = '';
	const child = spawn(process.execPath, ['build/index.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: base, NEWERA_DATA_DIR: directory, NEWERA_OEV_BASE_URL: provider, NEWERA_DECISION_MODEL: 'actor-model', NEWERA_TEXT_MODEL: 'actor-model', NEWERA_MAX_RETRIES: '0', NEWERA_MEMORY_ENABLED: 'false', ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
	for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-8000); });
	for (let index = 0; index < 100; index++) {
		if (child.exitCode !== null) throw new Error(`app exited: ${output}`);
		try { const response = await fetch(base); if (response.ok) break; } catch { /* starting */ }
		if (index === 99) { child.kill(); throw new Error(`app failed to start: ${output}`); }
		await pause(50);
	}
	return { base, child, async stop() { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } } };
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
		if (replyPerformanceReview(body, response)) return;
		if (replyReflection(body, response)) return;
		calls.push({ path: request.url, body });
		if (pauseNext) { const hold = pauseNext; pauseNext = null; hold.started(); await hold.wait; }
		if (failNext) { failNext = false; response.statusCode = 503; response.end('{"error":"offline"}'); return; }
		if (request.url === '/v1/systemone') {
			response.end(participationResponse(participation(body.state)));
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
		assert.deepEqual(calls.filter((call) => call.body.questions?.participation).map((call) => call.body.state.self.id), ['seoyeon', 'harin', 'seoyeon', 'harin']);
		assert.ok(calls.filter((call) => call.path.endsWith('systemone'))[1].body.state.recentEvents.some((event) => event.actorId === 'seoyeon' && event.body.utterance === '서연의 대답입니다.'));
		assert.equal(snapshot().state.events.filter((entry) => entry.kind === 'speak').length, 3);
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon만의 메모');
		assert.deepEqual(Object.keys(calls[0].body.questions), ['participation']);
		const generation = calls.find((call) => call.path.endsWith('chat/completions'));
		assert.equal(generation.body.response_format.json_schema.strict, true);
		assert.equal(JSON.parse(generation.body.messages[1].content).availableActions.some((action) => action.kind === 'wait'), false);
		assert.ok(!JSON.stringify(calls.filter((call) => call.path.endsWith('systemone'))[1].body).includes('seoyeon만의 메모'));
		const firstObservation = calls.find((call) => call.path.endsWith('systemone')).body.state;
		assert.ok(!Object.hasOwn(firstObservation.self, 'memories'));
		assert.ok(firstObservation.recentEvents.every((memory) => memory.actorId && memory.body && !Object.hasOwn(memory, 'text')));
		assert.equal(firstObservation.recentEvents.at(-1).actorId, 'player');
		assert.equal(firstObservation.recentEvents.at(-1).targetId, 'seoyeon');
		assert.equal(firstObservation.recentEvents.at(-1).body.utterance, '함께 준비할까요?');
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
		const lastDecisions = calls.filter((call) => call.path.endsWith('systemone') && call.body.state.time.tick === 3).slice(0, 2);
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
		assert.deepEqual(snapshot().definition.scenes[0].exits, [], 'a new scene must not add an unselected reverse edge');
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
		page = await (await fetch(`${base}/lores?tab=instances`)).text();
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
	let retryHold = null;
	let release;
	const hold = new Promise((done) => { release = done; });
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }, { id: 'other-model', task: 'generation' }] })); return; }
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response)) return;
		if (replyReflection(body, response)) return;
		if (request.url === '/v1/systemone') { response.end(participationResponse(participation(body.state))); return; }
		const state = JSON.parse(body.messages[1].content);
		calls.push(state.self.id);
		callModels.push(body.model);
		if (state.self.id === 'harin' && !held) { held = true; await hold; }
		if (state.self.id === 'harin' && failHarin) { response.statusCode = 503; response.end('{"error":"offline"}'); return; }
		if (state.self.id === 'harin' && retryHold) { retryHold.started(); await retryHold.wait; }
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
		assert.deepEqual(pending.progress, { pendingActorIds: ['harin', 'seoyeon'], completedDecisions: 1, consumedInputs: 0 });
		const partial = snapshot();
		assert.equal(partial.revision, pending.revision);
		assert.deepEqual(partial.state.events.map((event) => event.actorId), ['player', 'seoyeon']);
		assert.equal(partial.state.instances.find((entry) => entry.id === 'seoyeon').memo.summary, 'seoyeon 메모');
		const page = await (await fetch(running.base)).text();
		assert.match(page, /서연의 확정된 대사/);
		assert.ok(!page.includes('하린의 확정된 대사'));
		assert.match(page, /판단 1회 · 대기 2명/);
		await post(running.base, 'models', { worldId, decisionModel: 'other-model', textModel: 'other-model' });

		await running.stop();
		// Simulate a job persisted by the old one-pass release at this same durable boundary.
		db.prepare('UPDATE theater_jobs SET progress_json = ? WHERE id = ?').run(JSON.stringify({ actorIds: ['seoyeon', 'harin'], nextActorIndex: 1 }), pending.id);
		db.prepare("UPDATE theater_jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(pending.id);
		running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
		release();
		await waitJob(running.base, db, worldId);
		const resumed = snapshot();
		assert.equal(resumed.state.tick, 1, 'the original input must not be replayed');
		assert.equal(calls.filter((id) => id === 'seoyeon').length, 1, 'the committed actor must not be inferred again');
		assert.ok(callModels.every((model) => model === 'actor-model'), 'resuming a job must retain its original models after the session preference changes');
		assert.deepEqual(resumed.state.events.slice(0, partial.state.events.length), partial.state.events);
		assert.deepEqual(resumed.state.events.map((event) => event.actorId), ['player', 'seoyeon', 'harin', 'seoyeon', 'harin']);

		failHarin = true;
		await post(running.base, 'turn', { worldId, revision: String(resumed.revision), kind: 'wait' });
		const failedJob = await waitJob(running.base, db, worldId, true);
		const failed = snapshot();
		assert.equal(failed.state.tick, 2);
		assert.deepEqual(failed.state.events.slice(resumed.state.events.length).map((event) => event.actorId), ['player', 'seoyeon'], 'failure of a later actor must retain earlier results');
		const failedPage = await (await fetch(running.base)).text();
		assert.match(failedPage, /이미 확정된 말과 행동은 유지됩니다/);
		assert.match(failedPage, /이어서 재시도/);
		await post(running.base, 'models', { worldId, decisionModel: 'actor-model', textModel: 'actor-model' });
		failHarin = false;
		let retryStarted;
		let releaseRetry;
		const retryStart = new Promise((done) => { retryStarted = done; });
		retryHold = { started: retryStarted, wait: new Promise((done) => { releaseRetry = done; }) };
		const retryFields = { worldId, revision: String(failed.revision), jobId: failedJob.id };
		try {
			await post(running.base, 'retry', { ...retryFields, jobId: pending.id }, '/', true);
			await post(running.base, 'retry', { ...retryFields, revision: String(failed.revision - 1) }, '/', true);
			await post(running.base, 'retry', retryFields);
			await retryStart;
			const retrying = await latestJob(running.base, db, worldId);
			assert.equal(retrying.id, failedJob.id, 'manual retry must resume the same durable job');
			assert.equal(retrying.status, 'running');
			assert.equal(retrying.error, null);
			assert.deepEqual(retrying.progress, failedJob.progress);
			assert.deepEqual(snapshot(), failed, 'retry must preserve committed state, memories, clock and revision until new output');
			assert.deepEqual(retrying.models, { decisionModel: 'actor-model', textModel: 'actor-model' });
			assert.equal(callModels.at(-1), 'actor-model', 'manual retry adopts the current session model after preferences change');
			await post(running.base, 'retry', retryFields, '/', true);
		} finally { releaseRetry(); }
		const completedJob = await waitJob(running.base, db, worldId);
		const completed = snapshot();
		assert.equal(completedJob.id, failedJob.id);
		assert.equal(completed.state.tick, failed.state.tick, 'retry must not advance the input tick again');
		assert.equal(completed.state.minute, failed.state.minute, 'retry must not advance time again');
		assert.deepEqual(completed.state.events.slice(0, failed.state.events.length), failed.state.events);
		assert.equal(completed.state.events.filter((event) => event.actorId === 'player').length, 2);
		assert.deepEqual(completed.state.events.slice(failed.state.events.length).filter((event) => event.kind === 'speak').map((event) => event.actorId), ['harin']);
		await post(running.base, 'retry', { ...retryFields, revision: String(completed.revision) }, '/', true);
		assert.deepEqual(snapshot(), completed, 'a completed job cannot be replayed');

		failHarin = true;
		await post(running.base, 'turn', { worldId, revision: String(completed.revision), kind: 'wait' });
		const staleJob = await waitJob(running.base, db, worldId, true);
		await post(running.base, 'reset', { worldId, revision: String(snapshot().revision) });
		await post(running.base, 'retry', { worldId, revision: String(snapshot().revision), jobId: staleJob.id }, '/', true);
		assert.equal(snapshot().state.events.length, 0, 'retry must not restore a job invalidated by reset');
		const stalePage = await (await fetch(running.base)).text();
		assert.match(stalePage, /실패 이후 장면이 변경되어 재시도할 수 없습니다/);
		assert.ok(!stalePage.includes('action="?/retry"'));
	} finally {
		release(); await running.stop(); db.close(); model.closeAllConnections(); await new Promise((done) => model.close(done));
	}
});

test('role-confused proposals never publish and an operator stop fences off an in-flight review', async () => {
	let generated = 0, reviews = 0, holdReview = false, held = false, release;
	const gate = new Promise(done => { release = done; });
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const payload = JSON.parse(Buffer.concat(chunks).toString());
		if (replyReflection(payload, response)) return;
		if (payload.questions?.identity_check) { response.end(JSON.stringify({ answers: { identity_check: { type: 'choice', choice: generated === 1 ? 'contradiction' : 'consistent' } } })); return; }
		if (payload.questions?.performance_check) {
			reviews++;
			if (holdReview) { held = true; await gate; }
			response.end(JSON.stringify({ answers: { performance_check: { type: 'choice', choice: 'accept' } } })); return;
		}
		if (payload.questions) {
			const act = payload.state.self.id === 'seoyeon' && participation(payload.state) === 'act';
			response.end(participationResponse(act ? 'act' : 'wait', 'idle')); return;
		}
		generated++;
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: null, utterance: generated === 1 ? '저는 오늘 전학 온 학생이에요.' : '나는 서연이야. 준비를 확인하고 올게.', memoUpdate: generated === 1 ? { summary: '나는 전학생이다.', currentIntention: '', feelings: [], openThreads: [] } : null }) } }] }));
	});
	const port = await listen(model), directory = scratch();
	const running = await app(directory, `http://127.0.0.1:${port}/v1`, { NEWERA_MAX_RETRIES: '1', NEWERA_RETRY_BASE_MS: '1' });
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key='active'").get().value;
	const snapshot = () => { const row = db.prepare('SELECT revision,state_json FROM theater_worlds WHERE id=?').get(worldId); return { revision: row.revision, state: JSON.parse(row.state_json) }; };
	try {
		await post(running.base, 'turn', { worldId, revision: '0', kind: 'wait' });
		const firstJob = await waitJob(running.base, db, worldId);
		assert.equal(generated, 2); assert.equal(reviews, 1);
		assert.ok(!JSON.stringify(snapshot()).includes('전학생'), 'rejected speech and its memo must never enter the authoritative scene');
		assert.equal(snapshot().state.events.filter(e => e.utterance).length, 1);
		holdReview = true;
		await post(running.base, 'turn', { worldId, revision: String(snapshot().revision), kind: 'wait' });
		for (let i = 0; i < 300 && !held; i++) await pause(20);
		assert.ok(held);
		const active = await latestJob(running.base, db, worldId), beforeStop = snapshot();
		assert.match(await (await fetch(running.base)).text(), /생성 중단/);
		await post(running.base, 'stop', { worldId, jobId: firstJob.id }, '/', true);
		await post(running.base, 'stop', { worldId, jobId: active.id });
		const stopped = await waitJob(running.base, db, worldId, true);
		assert.match(stopped.error, /사용자가 자동 생성을 중단/);
		release(); await pause(100);
		assert.deepEqual(snapshot(), beforeStop, 'a late accepted review cannot commit after operator stop');
		assert.equal((await latestJob(running.base, db, worldId)).status, 'failed');
	} finally { release(); await running.stop(); db.close(); model.closeAllConnections(); await new Promise(done => model.close(done)); }
});

test('reactive dialogue repeats actors and queued stop chat survives restart without stale output or replay', async () => {
	let generated = 0;
	let held = false;
	let release;
	const hold = new Promise((done) => { release = done; });
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response)) return;
		if (replyReflection(body, response)) return;
		if (request.url === '/v1/systemone') {
			const stopped = body.state.recentEvents.some((event) => event.actorId === 'player' && event.body.utterance === '이제 그만해.');
			response.end(participationResponse(stopped ? 'wait' : 'act')); return;
		}
		const state = JSON.parse(body.messages[1].content);
		const line = ['어서 와.', '서연아, 공연 준비는 잘 되어가?', '응, 이제 거의 다 준비됐어.', '확정되면 안 되는 대사'][generated++];
		if (generated === 4) { held = true; await hold; }
		const targetId = state.self.id === 'seoyeon' ? 'harin' : 'seoyeon';
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: `speak:${targetId}`, targetId, narrative: null, utterance: line, memoUpdate: null }) } }] }));
	});
	const modelPort = await listen(model);
	const directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
	const snapshot = () => JSON.parse(db.prepare('SELECT state_json FROM theater_worlds WHERE id = ?').get(worldId).state_json);
	try {
		await post(running.base, 'turn', { worldId, revision: '0', kind: 'wait' });
		for (let index = 0; index < 300 && !held; index++) await pause(20);
		assert.ok(held);
		const pending = await latestJob(running.base, db, worldId);
		assert.deepEqual(pending.progress, { pendingActorIds: ['harin', 'seoyeon'], completedDecisions: 3, consumedInputs: 0 });
		const committed = snapshot();
		assert.deepEqual(committed.events.filter((event) => event.kind === 'speak').map((event) => event.actorId), ['seoyeon', 'harin', 'seoyeon']);
		const page = await (await fetch(running.base)).text();
		assert.match(page, /응, 이제 거의 다 준비됐어\./);
		assert.ok(!/<textarea\b[^>]*disabled/.test(page), 'chat must remain enabled while characters are reacting');
		await post(running.base, 'turn', { worldId, revision: '0', kind: 'speak', text: '이제 그만해.', targetId: '' });
		assert.equal(db.prepare('SELECT count(*) AS n FROM theater_jobs WHERE world_id = ?').get(worldId).n, 1, 'chat joins the active job');
		assert.equal(JSON.parse(db.prepare('SELECT inputs_json FROM theater_jobs WHERE id = ?').get(pending.id).inputs_json).length, 1);
		await running.stop();
		db.prepare("UPDATE theater_jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(pending.id);
		running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
		release();
		const completed = await waitJob(running.base, db, worldId);
		assert.equal(completed.id, pending.id);
		assert.equal(completed.progress.consumedInputs, 1);
		assert.deepEqual(completed.progress.pendingActorIds, []);
		const state = snapshot();
		assert.equal(state.tick, 2);
		assert.deepEqual(state.events.slice(0, committed.events.length), committed.events);
		assert.equal(state.events.filter((event) => event.actorId === 'player' && event.text === '이제 그만해.').length, 1);
		assert.ok(!state.events.some((event) => event.utterance === '확정되면 안 되는 대사'));
		assert.equal(generated, 4, 'stop is read before any new detailed generation');
	} finally { release(); await running.stop(); db.close(); model.closeAllConnections(); await new Promise((done) => model.close(done)); }
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
		if (replyPerformanceReview(body, response)) return;
		if (replyReflection(body, response)) return;
		const state = request.url === '/v1/systemone' ? body.state : JSON.parse(body.messages[1].content);
		calls.push({ path: request.url, model: body.model, actor: state.self.id, question: body.questions && Object.keys(body.questions)[0] });
		if (request.url === '/v1/systemone') { response.end(participationResponse(participation(body.state))); return; }
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
		assert.deepEqual(completed.state.events.map((event) => event.actorId), ['player', 'seoyeon', 'harin', 'seoyeon', 'harin']);
		assert.equal(calls.filter((call) => call.question === 'participation' && call.actor === 'seoyeon').length, 2);
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

test('private relationships persist before a wait decision, survive restart and round-trip through slots and exports', async () => {
	const reflections = [];
	let held = false;
	let invalid = false;
	let release;
	const hold = new Promise((done) => { release = done; });
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response)) return;
		if (request.url === '/v1/systemone') {
			if (body.questions.participation && body.state.self.id === 'harin') {
				assert.equal(body.state.self.relationships.player.trust, 45);
				if (!held) { held = true; await hold; }
			}
			assert.ok(!body.state.present.some((entry) => entry.relationships || entry.memo));
			response.end(participationResponse('wait')); return;
		}
		assert.equal(body.response_format.json_schema.name, 'character_reflection');
		const state = JSON.parse(body.messages[1].content);
		reflections.push({ actor: state.self.id, ids: state.newEvents.map((event) => event.eventId), model: body.model });
		const output = { relationshipUpdates: [], memoUpdate: null };
		if (state.self.id === 'harin') {
			output.relationshipUpdates.push({ targetId: 'player', changes: [{ field: 'trust', value: 45 }], impression: '플레이어의 약속을 직접 확인하고 싶다.', evidenceEventIds: [invalid ? 'unseen-event' : state.newEvents.at(-1).eventId] });
			output.memoUpdate = { summary: '플레이어의 말을 들었다.', currentIntention: '우선 조용히 확인한다.', feelings: ['플레이어의 약속이 걱정됨'], openThreads: [] };
		} else assert.ok(!JSON.stringify(state).includes('약속을 직접 확인하고 싶다'), 'another character must not receive private impressions');
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
	});
	const modelPort = await listen(model);
	const directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const activeId = () => db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
	const snapshot = (id = activeId()) => { const row = db.prepare('SELECT revision, state_json FROM theater_worlds WHERE id = ?').get(id); return { revision: row.revision, state: JSON.parse(row.state_json) }; };
	try {
		const worldId = activeId();
		await post(running.base, 'turn', { worldId, revision: '0', kind: 'speak', text: '준비는 확실히 잘 되어 있어.', targetId: 'harin' });
		for (let index = 0; index < 300 && !held; index++) await pause(20);
		assert.ok(held);
		const pending = await latestJob(running.base, db, worldId);
		const partial = snapshot();
		const harin = partial.state.instances.find((entry) => entry.id === 'harin');
		assert.equal(harin.relationships.player.trust, 45);
		assert.equal(harin.relationships.player.affinity, 85, 'unchanged scores must survive a partial update');
		assert.equal(harin.reflectedThroughEventId, partial.state.events[0].id);
		assert.deepEqual(partial.state.events.map((event) => event.actorId), ['player'], 'private reflection must not create a public scene event');
		const page = await (await fetch(running.base)).text();
		assert.match(page, /상대별 관계/);
		assert.match(page, /플레이어의 약속을 직접 확인하고 싶다/);
		const editor = await (await fetch(`${running.base}/lores?tab=instances`)).text();
		assert.match(editor, /name="trustKnown"/);
		await running.stop();
		db.prepare("UPDATE theater_jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(pending.id);
		running = await app(directory, `http://127.0.0.1:${modelPort}/v1`);
		release();
		await waitJob(running.base, db, worldId);
		assert.equal(reflections.filter((call) => call.actor === 'harin').length, 1, 'a committed reflection must not be called again after restart');
		assert.ok(reflections.every((call) => call.model === 'actor-model'));
		const persisted = snapshot();
		assert.deepEqual(persisted.state.instances.find((entry) => entry.id === 'harin').relationships, harin.relationships);
		await post(running.base, 'save', { worldId, slot: '1' });
		await post(running.base, 'relationship', { worldId, revision: String(persisted.revision), instanceId: 'harin', scope: 'current', targetId: 'player', trustKnown: 'on', trust: '10', affinityKnown: 'on', affinity: '85', closenessKnown: 'on', closeness: '90', respectKnown: 'on', respect: '65', warinessKnown: 'on', wariness: '5', impression: harin.relationships.player.impression }, '/lores');
		assert.deepEqual(snapshot().state.instances.find((entry) => entry.id === 'harin').relationships.player.evidenceEventIds, harin.relationships.player.evidenceEventIds);
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'harin').reflectedThroughEventId, harin.reflectedThroughEventId);
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'harin').relationships.player.trust, 10);
		await post(running.base, 'load', { worldId, revision: String(snapshot().revision), slot: '1' });
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'harin').relationships.player.trust, 45);
		await post(running.base, 'turn', { worldId, revision: String(snapshot().revision), kind: 'wait' });
		await waitJob(running.base, db, worldId);
		assert.equal(reflections.filter((call) => call.actor === 'harin').length, 1, 'passive wait and a restored cursor must not inflate relations');
		const bundle = await exported(running.base, worldId);
		assert.equal(bundle.world.state.instances.find((entry) => entry.id === 'harin').reflectedThroughEventId, harin.reflectedThroughEventId);
		assert.deepEqual(bundle.saves[0].world.state.instances.find((entry) => entry.id === 'harin').relationships, harin.relationships);
		const file = new FormData(); file.append('file', new Blob([JSON.stringify(bundle)]), 'relationships.json');
		assert.equal((await (await fetch(`${running.base}/lores?/importWorld`, { method: 'POST', headers: { origin: running.base }, body: file })).json()).type, 'success');
		assert.notEqual(activeId(), worldId);
		assert.deepEqual(snapshot().state.instances.find((entry) => entry.id === 'harin').relationships, harin.relationships);
		await post(running.base, 'selectWorld', { worldId });
		invalid = true;
		await post(running.base, 'turn', { worldId, revision: String(snapshot().revision), kind: 'speak', text: '약속할게.', targetId: 'harin' });
		const failed = await waitJob(running.base, db, worldId, true);
		assert.match(failed.error, /목격한 사건/);
		assert.deepEqual(snapshot().state.instances.find((entry) => entry.id === 'harin').relationships, harin.relationships);
		assert.equal(snapshot().state.instances.find((entry) => entry.id === 'harin').reflectedThroughEventId, harin.reflectedThroughEventId);
	} finally { release(); await running.stop(); db.close(); model.closeAllConnections(); await new Promise((done) => model.close(done)); }
});

test('casual editor saves scenes, profiles, typed properties and directional current and initial relationships', async () => {
	const directory = scratch();
	const running = await app(directory, 'http://127.0.0.1:9/v1');
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
	const snapshot = () => { const row = db.prepare('SELECT * FROM theater_worlds WHERE id = ?').get(worldId); return { revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) }; };
	const fields = () => ({ worldId, revision: String(snapshot().revision) });
	const current = (id) => snapshot().state.instances.find((instance) => instance.id === id);
	const initial = (id) => snapshot().definition.spawns.find((instance) => instance.id === id);
	try {
		const page = await (await fetch(`${running.base}/lores`)).text();
		assert.match(page, /편집 항목/);
		assert.match(page, /data-testid="scene-lobby"/);
		assert.ok(!page.includes('name="definition"'), 'raw definitions must not be the primary editing surface');
		const before = snapshot();
		await post(running.base, 'scene', { ...fields(), sceneId: 'lobby', name: '입구 로비', description: '손님을 맞이하는 따뜻한 로비.', exits: 'stage' }, '/lores');
		assert.deepEqual(snapshot().definition.scenes[0], { id: 'lobby', name: '입구 로비', description: '손님을 맞이하는 따뜻한 로비.', exits: ['stage'] });
		assert.deepEqual(snapshot().definition.scenes[2].exits, before.definition.scenes[2].exits, 'editing outgoing exits must preserve other scenes');
		assert.deepEqual(snapshot().state, before.state, 'scene descriptions must not reset the performance');
		const unchanged = snapshot();
		await post(running.base, 'scene', { ...fields(), sceneId: 'lobby', name: '잘못된 씬', description: '자기 연결', exits: 'lobby' }, '/lores', true);
		assert.deepEqual(snapshot(), unchanged);
		const stateRows = JSON.stringify([{ key: 'mood', type: 'text', value: '차분함' }, { key: 'ready', type: 'boolean', value: 'true' }, { key: 'rehearsals', type: 'number', value: '3.5' }, { key: 'note', type: 'null', value: '' }]);
		await post(running.base, 'template', { ...fields(), templateId: 'actor', name: '서연 기본 설정', description: '신중하게 준비하는 배우.', personality: '차분한 존댓말을 쓴다.', goals: '공연을 준비한다.\n동료의 의견을 듣는다.', initialStateRows: stateRows }, '/lores');
		const template = snapshot().definition.templates.find((template) => template.id === 'actor');
		assert.equal(template.kind, 'character');
		assert.deepEqual(template.goals, ['공연을 준비한다.', '동료의 의견을 듣는다.']);
		assert.deepEqual(template.initialState, { mood: '차분함', ready: true, rehearsals: 3.5, note: null });
		assert.equal(current('seoyeon').name, '서연');
		assert.equal(current('seoyeon').state.mood, '긴장함');
		const lightBefore = snapshot().definition.templates.find((template) => template.id === 'light');
		await post(running.base, 'template', { ...fields(), templateId: 'light', name: '작업등', description: '오래된 전등.', initialStateRows: JSON.stringify([{ key: 'on', type: 'boolean', value: 'false' }]) }, '/lores');
		assert.deepEqual(snapshot().definition.templates.find((template) => template.id === 'light').interactions, lightBefore.interactions, 'basic edits must preserve advanced interactions');
		await post(running.base, 'initialInstance', { ...fields(), instanceId: 'harin', name: '동행 하린', sceneId: 'lobby', companion: 'on', stateRows: JSON.stringify([{ key: 'mood', type: 'text', value: '편안함' }]) }, '/lores');
		assert.equal(initial('harin').name, '동행 하린');
		assert.equal(current('harin').name, '하린');
		await post(running.base, 'relationship', { ...fields(), instanceId: 'harin', scope: 'initial', targetId: 'player', trustKnown: 'on', trust: '73', impression: '오래 아는 친구.' }, '/lores');
		assert.equal(initial('harin').relationships.player.trust, 73);
		assert.equal(initial('harin').relationships.player.affinity, null);
		assert.equal(current('harin').relationships.player.trust, 80);
		await post(running.base, 'relationship', { ...fields(), instanceId: 'harin', scope: 'current', targetId: 'player', trustKnown: 'on', trust: '28', affinityKnown: 'on', affinity: '70', impression: '좋아하지만 아직 확인하고 싶다.' }, '/lores');
		assert.equal(current('harin').relationships.player.trust, 28);
		assert.equal(current('harin').relationships.player.affinity, 70);
		assert.equal(current('harin').relationships.player.respect, null);
		assert.equal(initial('harin').relationships.player.trust, 73);
		const relations = structuredClone(current('harin').relationships);
		await post(running.base, 'instance', { ...fields(), instanceId: 'harin', name: '하린 친구', sceneId: 'lobby', companion: 'on', stateRows: JSON.stringify([{ key: 'mood', type: 'text', value: '평온함' }]) }, '/lores');
		assert.equal(current('harin').name, '하린 친구');
		assert.deepEqual(current('harin').relationships, relations, 'placement edits must preserve private relationships');
		for (const bad of [
			{ instanceId: 'harin', scope: 'current', targetId: 'harin' },
			{ instanceId: 'harin', scope: 'current', targetId: 'desk-bell' },
			{ instanceId: 'harin', scope: 'current', targetId: 'player', trustKnown: 'on', trust: '101' },
			{ instanceId: 'harin', scope: 'neither', targetId: 'player' }
		]) {
			const unchanged = snapshot();
			await post(running.base, 'relationship', { ...fields(), ...bad }, '/lores', true);
			assert.deepEqual(snapshot(), unchanged);
		}
		const duplicates = snapshot();
		await post(running.base, 'instance', { ...fields(), instanceId: 'harin', name: '하린', sceneId: 'lobby', companion: 'on', stateRows: JSON.stringify([{ key: 'same', type: 'text', value: 'a' }, { key: 'same', type: 'text', value: 'b' }]) }, '/lores', true);
		assert.deepEqual(snapshot(), duplicates);
		const worldSettings = snapshot().definition;
		await post(running.base, 'settings', { ...fields(), name: worldSettings.name, description: worldSettings.description, rules: worldSettings.rules, startingSceneId: 'stage' }, '/lores');
		assert.equal(snapshot().definition.startingSceneId, 'stage');
		assert.equal(initial('harin').sceneId, 'stage');
		assert.equal(snapshot().state.activeSceneId, 'lobby', 'changing the starting scene must not move the current performance');
		await post(running.base, 'save', { worldId, slot: '1' });
		await post(running.base, 'reset', fields());
		assert.equal(current('harin').name, '동행 하린');
		assert.equal(current('harin').relationships.player.trust, 73);
		assert.equal(current('seoyeon').state.ready, true);
		await post(running.base, 'load', { ...fields(), slot: '1' });
		assert.equal(current('harin').relationships.player.trust, 28);
		await post(running.base, 'relationship', { ...fields(), instanceId: 'harin', scope: 'current', targetId: 'player', intent: 'remove' }, '/lores');
		assert.equal(current('harin').relationships.player, undefined);
		assert.equal(initial('harin').relationships.player.trust, 73);
		const reverse = current('jieun').relationships.seoyeon;
		assert.equal(reverse.trust, 70, 'editing another relationship must preserve unrelated directed relationships');
		const templatePage = await (await fetch(`${running.base}/lores?tab=templates`)).text();
		assert.match(templatePage, /name="initialStateRows"/);
		const relationPage = await (await fetch(`${running.base}/lores?tab=instances`)).text();
		assert.match(relationPage, /type="range"/);
		assert.match(relationPage, /name="trustKnown"/);
	} finally { await running.stop(); db.close(); }
});

test('scene adjacency lists drive the graph and persist without changing other scenes or progress', async () => {
	const directory = scratch();
	const running = await app(directory, 'http://127.0.0.1:9/v1');
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
	const snapshot = () => {
		const row = db.prepare('SELECT * FROM theater_worlds WHERE id = ?').get(worldId);
		return { id: worldId, revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) };
	};
	try {
		let world = snapshot();
		const fields = () => ({ worldId: world.id, revision: String(world.revision) });
		const initialState = structuredClone(world.state);
		const initialScenes = structuredClone(world.definition.scenes);
		// Creating a corridor uses the same scene editor as any other place.
		await post(running.base, 'scene', { ...fields(), name: '무대 복도', description: '로비에서 무대로 이어지는 복도.', exits: 'lobby' }, '/lores');
		world = snapshot();
		const corridor = world.definition.scenes.find((scene) => scene.name === '무대 복도');
		assert.ok(corridor);
		assert.deepEqual(world.definition.scenes.slice(0, initialScenes.length), initialScenes, 'creating a scene must not edit other adjacency lists');
		const scene = (id) => world.definition.scenes.find((scene) => scene.id === id);
		const saveNeighbors = async (sceneId, exits, failure = false, revision = world.revision) => {
			const { name, description } = scene(sceneId);
			const body = new URLSearchParams({ worldId: world.id, revision: String(revision), sceneId, name, description });
			for (const id of exits) body.append('exits', id);
			await post(running.base, 'scene', body, '/lores', failure);
			world = snapshot();
		};
		await saveNeighbors('lobby', [corridor.id]);
		await saveNeighbors(corridor.id, ['lobby', 'stage']);
		await saveNeighbors('stage', []);
		assert.deepEqual(scene('lobby').exits, [corridor.id]);
		assert.deepEqual(scene(corridor.id).exits, ['lobby', 'stage']);
		assert.ok(!scene('stage').exits.includes(corridor.id), 'one-way connection must not add a reverse path');
		assert.deepEqual(world.state, initialState, 'editing the graph must preserve all running scene state');
		const page = await (await fetch(`${running.base}/lores?tab=scenes`)).text();
		assert.match(page, /data-testid="scene-graph"/);
		assert.match(page, /로비에서 무대로 이어지는 복도/);
		assert.match(page, /인접 씬 목록/);
		assert.match(page, new RegExp(`data-from="${corridor.id}" data-to="stage" data-bidirectional="false"`));
		assert.ok(!page.includes('name="direction"') && !page.includes('?/connection'), 'the graph must only display adjacency lists');
		await saveNeighbors('stage', [corridor.id]);
		assert.ok(scene('stage').exits.includes(corridor.id));
		const stable = structuredClone(world);
		for (const [exits, revision] of [
			[['lobby'], world.revision],
			[['missing'], world.revision],
			[['stage'], world.revision - 1]
		]) {
			await saveNeighbors('lobby', exits, true, revision);
			assert.deepEqual(world, stable);
		}
		await running.stop();
		const restarted = await app(directory, 'http://127.0.0.1:9/v1');
		try { assert.deepEqual(await current(restarted.base), { definition: stable.definition, state: stable.state }, 'connections must survive a server restart'); }
		finally { await restarted.stop(); }
	} finally { await running.stop(); db.close(); }
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
		db.exec('ALTER TABLE theater_jobs DROP COLUMN inputs_json');
		db.exec('ALTER TABLE theater_jobs DROP COLUMN models_json');
		db.exec('ALTER TABLE theater_worlds DROP COLUMN model_settings_json');
		running = await app(directory, 'http://127.0.0.1:1/v1');
		assert.ok(db.prepare('PRAGMA table_info(theater_jobs)').all().some((column) => column.name === 'progress_json'));
		assert.ok(db.prepare('PRAGMA table_info(theater_jobs)').all().some((column) => column.name === 'models_json'));
		assert.ok(db.prepare('PRAGMA table_info(theater_worlds)').all().some((column) => column.name === 'model_settings_json'));
		assert.deepEqual(db.prepare('SELECT definition_json, state_json FROM theater_worlds WHERE id = ?').get(id), beforeMigration, 'adding the progress cursor must preserve existing world data');
	} finally { await running.stop(); db.close(); }
});

test('appearance choices survive later inference failure, restart and slots; editor keeps current and initial looks separate', async () => {
	let outfitCalls = 0, failReflection = true;
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response)) return;
		if (body.questions?.outfit) {
			outfitCalls++;
			response.end(JSON.stringify({ answers: { outfit: { type: 'choice', choice: 'uniform' } } })); return;
		}
		if (body.response_format?.json_schema?.name === 'character_reflection') {
			if (failReflection) { response.statusCode = 503; response.end('{}'); return; }
			replyReflection(body, response); return;
		}
		response.end(participationResponse('wait'));
	});
	const port = await listen(model), directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${port}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key='active'").get().value;
	const snapshot = () => { const row = db.prepare('SELECT * FROM theater_worlds WHERE id=?').get(worldId); return { revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) }; };
	const fields = () => ({ worldId, revision: String(snapshot().revision) });
	try {
		const initial = snapshot();
		for (const template of initial.definition.templates.filter(t => t.kind === 'character')) Object.assign(template, {
			baseAppearance: '검은 단발.', clothingPreferences: '단정한 교복.', foodPreferences: '귤을 좋아한다.',
			wardrobe: [{ id: 'uniform', name: '교복', appearance: '회색 교복을 입었다.', context: '등교일.' }]
		});
		initial.definition.spawns.find(i => i.id === 'harin').playerContext = '오늘 처음 만났다.';
		await post(running.base, 'definition', { ...fields(), definition: JSON.stringify(initial.definition) }, '/lores');
		await post(running.base, 'turn', { ...fields(), kind: 'speak', text: '안녕' });
		await waitJob(running.base, db, worldId, true);
		const partial = snapshot();
		assert.equal(outfitCalls, 2);
		const harin = partial.state.instances.find(i => i.id === 'harin');
		assert.deepEqual(harin.appearanceSelection, { day: 1, minute: 1081, sceneId: 'lobby', outfitId: 'uniform', model: 'actor-model' });
		assert.equal(partial.state.events.length, 1);
		assert.equal(partial.state.minute, initial.state.minute + 1);
		await running.stop();
		failReflection = false;
		running = await app(directory, `http://127.0.0.1:${port}/v1`);
		assert.deepEqual(snapshot(), partial);
		await post(running.base, 'turn', { ...fields(), kind: 'speak', text: '다시 인사할게' });
		await waitJob(running.base, db, worldId);
		assert.equal(outfitCalls, 2, 'saved outfit must not be rerolled after failure or restart');
		await post(running.base, 'save', { worldId, slot: '1' });
		const beforeEdit = snapshot();
		const instance = beforeEdit.state.instances.find(i => i.id === 'harin');
		await post(running.base, 'instance', { ...fields(), instanceId: instance.id, name: instance.name, sceneId: instance.sceneId, companion: 'on', state: JSON.stringify(instance.state), appearance: '파란 가디건.', playerContext: '오늘 안내를 부탁했다.' }, '/lores');
		assert.equal(snapshot().state.instances.find(i => i.id === 'harin').appearanceSelection.model, 'manual');
		assert.equal(snapshot().definition.spawns.find(i => i.id === 'harin').appearance, undefined);
		const spawn = snapshot().definition.spawns.find(i => i.id === 'harin');
		await post(running.base, 'initialInstance', { ...fields(), instanceId: spawn.id, name: spawn.name, sceneId: spawn.sceneId, companion: 'on', state: JSON.stringify(spawn.state), appearance: '초기 모습.', playerContext: '초기 소개.' }, '/lores');
		assert.equal(snapshot().state.instances.find(i => i.id === 'harin').appearance, '파란 가디건.');
		assert.deepEqual(snapshot().state.events, beforeEdit.state.events);
		const settings = snapshot().definition;
		await post(running.base, 'settings', { ...fields(), name: settings.name, description: settings.description, rules: settings.rules, appearanceChangeMinutes: '90' }, '/lores');
		assert.equal(snapshot().definition.appearanceChangeMinutes, 90);
		const template = snapshot().definition.templates.find(t => t.id === harin.templateId);
		await post(running.base, 'template', { ...fields(), templateId: template.id, kind: 'character', name: template.name, description: template.description, personality: template.personality, goals: template.goals.join('\n'), initialState: JSON.stringify(template.initialState) }, '/lores');
		assert.equal(snapshot().definition.templates.find(t => t.id === template.id).foodPreferences, template.foodPreferences, 'old forms keep optional preferences');
		await post(running.base, 'load', { ...fields(), slot: '1' });
		assert.deepEqual(snapshot().state, beforeEdit.state);
		const bundle = await exported(running.base, worldId);
		assert.deepEqual(bundle.world.state.instances.find(i => i.id === 'harin').appearanceSelection, harin.appearanceSelection);
		assert.equal(bundle.saves.length, 1);
	} finally { await running.stop(); db.close(); await new Promise(done => model.close(done)); }
});

test('world style edits persist and change the next performance prompt without changing decisions or previous events', async () => {
	const calls = [];
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response)) return;
		calls.push(body);
		if (replyReflection(body, response)) return;
		if (body.questions) { response.end(participationResponse(participation(body.state))); return; }
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: '고개를 끄덕인다.', utterance: '반가워.', memoUpdate: null }) } }] }));
	});
	const port = await listen(model), directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${port}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key='active'").get().value;
	const snapshot = () => { const row = db.prepare('SELECT * FROM theater_worlds WHERE id=?').get(worldId); return { revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) }; };
	const fields = () => ({ worldId, revision: String(snapshot().revision) });
	const settings = () => { const d = snapshot().definition; return { ...fields(), name: d.name, description: d.description, rules: d.rules }; };
	const generated = () => calls.filter(body => body.response_format?.json_schema?.name === 'actor_performance');
	try {
		const before = snapshot();
		const style = '담백한 현재형으로 쓰고 과장된 비유를 줄인다.';
		await post(running.base, 'settings', { ...settings(), writingStyle: style }, '/lores');
		assert.equal(snapshot().definition.writingStyle, style);
		assert.deepEqual(snapshot().state, before.state);
		assert.match(await (await fetch(`${running.base}/lores?tab=world`)).text(), /name="writingStyle"/);
		await post(running.base, 'settings', { ...settings(), writingStyle: '가'.repeat(4001) }, '/lores', true);
		assert.equal(snapshot().definition.writingStyle, style, 'invalid guidance must retain the saved value');
		await post(running.base, 'settings', settings(), '/lores');
		assert.equal(snapshot().definition.writingStyle, style, 'legacy forms must preserve new settings');
		await post(running.base, 'turn', { ...fields(), kind: 'speak', text: '안녕' });
		await waitJob(running.base, db, worldId);
		assert.ok(generated().length >= 2);
		assert.ok(generated().every(body => body.messages[0].content.includes(style) && body.response_format.json_schema.strict));
		assert.ok(calls.filter(body => body.questions || body.response_format?.json_schema?.name === 'character_reflection').every(body => !JSON.stringify(body).includes(style)));
		await post(running.base, 'save', { worldId, slot: '1' });
		const priorEvents = snapshot().state.events;
		calls.length = 0;
		const nextStyle = '짧은 문장으로 동작과 소리를 또렷하게 묘사한다.';
		await post(running.base, 'settings', { ...settings(), writingStyle: nextStyle }, '/lores');
		await post(running.base, 'turn', { ...fields(), kind: 'speak', text: '다음은?' });
		await waitJob(running.base, db, worldId);
		assert.ok(generated().length >= 2 && generated().every(body => body.messages[0].content.includes(nextStyle) && !body.messages[0].content.includes(style)));
		assert.deepEqual(snapshot().state.events.slice(0, priorEvents.length), priorEvents);
		await running.stop(); running = await app(directory, `http://127.0.0.1:${port}/v1`);
		assert.equal(snapshot().definition.writingStyle, nextStyle);
		await post(running.base, 'load', { ...fields(), slot: '1' });
		assert.equal(snapshot().definition.writingStyle, style, 'slots restore style with the world definition');
		assert.equal((await exported(running.base, worldId)).world.definition.writingStyle, style);
		calls.length = 0;
		await post(running.base, 'settings', { ...settings(), writingStyle: '' }, '/lores');
		await post(running.base, 'turn', { ...fields(), kind: 'speak', text: '기본 문체로' });
		await waitJob(running.base, db, worldId);
		assert.ok(generated().length >= 2 && generated().every(body => body.messages.length === 2 && !body.messages[0].content.includes('서술 문체 지침')));
	} finally { await running.stop(); db.close(); await new Promise(done => model.close(done)); }
});

test('world replacement replaces progress and slots without duplicates; deletion handles inactive, active and final worlds', async () => {
	const directory = scratch();
	let running = await app(directory, 'http://127.0.0.1:9/v1');
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const activeId = () => db.prepare("SELECT value FROM theater_meta WHERE key='active'").get().value;
	const snapshot = id => { const row = db.prepare('SELECT * FROM theater_worlds WHERE id=?').get(id); return row ? { id, revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) } : null; };
	const count = () => db.prepare('SELECT count(*) AS n FROM theater_worlds').get().n;
	async function replace(id, revision, bundle, failure = false) {
		const body = new FormData();
		body.append('mode', 'replace'); body.append('worldId', id); body.append('revision', String(revision));
		body.append('file', new Blob([JSON.stringify(bundle)]), 'replacement.json');
		const response = await fetch(`${running.base}/lores?/importWorld`, { method: 'POST', headers: { origin: running.base }, body });
		assert.equal((await response.json()).type === 'failure', failure);
	}
	const seedJob = id => db.prepare('INSERT INTO theater_jobs (id,world_id,revision,request_json,status,worker_id,created_at) VALUES (?,?,?,?,?,?,?)').run(`stale-${id}`, id, snapshot(id).revision, '{"kind":"wait"}', 'running', 'old-worker', new Date().toISOString());
	try {
		const keepId = activeId(), keep = snapshot(keepId);
		await post(running.base, 'createWorld', { name: '교체 전 세계', description: '버릴 진행.' }, '/lores');
		const id = activeId();
		await post(running.base, 'turn', { worldId: id, revision: String(snapshot(id).revision), kind: 'wait' });
		await waitJob(running.base, db, id);
		await post(running.base, 'save', { worldId: id, slot: '1' });
		db.prepare('UPDATE theater_worlds SET model_settings_json=? WHERE id=?').run('{"decisionModel":"old","textModel":"old"}', id);
		seedJob(id);
		const before = snapshot(id);
		assert.equal(before.state.events.length, 1);
		const bundle = JSON.parse(readFileSync('static/lore-presets/solbit-high.json', 'utf8'));
		bundle.world.definition.name = '교체 후 세계';
		bundle.saves = [{ slot: 2, savedAt: new Date().toISOString(), world: structuredClone(bundle.world) }];
		const invalid = structuredClone(bundle); invalid.world.state.activeSceneId = 'missing';
		for (const [revision, candidate] of [[before.revision, invalid], [before.revision - 1, bundle]]) {
			await replace(id, revision, candidate, true);
			assert.deepEqual(snapshot(id), before);
			assert.equal(db.prepare('SELECT count(*) AS n FROM theater_saves WHERE world_id=?').get(id).n, 1);
			assert.equal(db.prepare("SELECT count(*) AS n FROM theater_jobs WHERE world_id=? AND status='running'").get(id).n, 1);
		}
		await replace(id, before.revision, bundle);
		assert.equal(count(), 2, 'replacement must not insert another world');
		assert.equal(activeId(), id);
		assert.equal(snapshot(id).definition.name, '교체 후 세계');
		assert.deepEqual(snapshot(id).state, bundle.world.state, 'discard old progress entirely');
		assert.equal(db.prepare('SELECT model_settings_json FROM theater_worlds WHERE id=?').get(id).model_settings_json, null);
		assert.deepEqual(db.prepare('SELECT slot FROM theater_saves WHERE world_id=?').all(id).map(row => row.slot), [2]);
		assert.equal(db.prepare('SELECT count(*) AS n FROM theater_jobs WHERE world_id=?').get(id).n, 0);
		await post(running.base, 'selectWorld', { worldId: keepId }, '/lores');
		seedJob(id);
		await post(running.base, 'deleteWorld', { worldId: id, revision: String(before.revision) }, '/lores', true);
		assert.ok(snapshot(id));
		await post(running.base, 'deleteWorld', { worldId: id, revision: String(snapshot(id).revision) }, '/lores');
		assert.equal(activeId(), keepId, 'deleting inactive world preserves current selection');
		assert.equal(snapshot(id), null);
		assert.equal(db.prepare('SELECT count(*) AS n FROM theater_saves WHERE world_id=?').get(id).n, 0);
		assert.equal(db.prepare('SELECT count(*) AS n FROM theater_jobs WHERE world_id=?').get(id).n, 0);
		assert.deepEqual(snapshot(keepId), keep);
		await post(running.base, 'createWorld', { name: '현재 세계 삭제', description: '현재 항목.' }, '/lores');
		const active = activeId();
		await post(running.base, 'deleteWorld', { worldId: active, revision: String(snapshot(active).revision) }, '/lores');
		assert.equal(activeId(), keepId, 'active deletion selects a remaining world');
		await post(running.base, 'deleteWorld', { worldId: keepId, revision: String(snapshot(keepId).revision) }, '/lores');
		assert.equal(count(), 1);
		assert.equal(snapshot(activeId()).definition.name, '새 이야기');
		assert.equal(snapshot(activeId()).state.instances.length, 0);
		assert.equal(snapshot(activeId()).state.events.length, 0);
		assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
		await running.stop(); running = await app(directory, 'http://127.0.0.1:9/v1');
		assert.equal(count(), 1);
		assert.equal(snapshot(activeId()).definition.name, '새 이야기');
	} finally { await running.stop(); db.close(); }
});

test('silent inactivity persists without public transcript rows across restart, slots and export', async () => {
	let watch = false;
	const questions = [];
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response)) return;
		if (replyReflection(body, response)) return;
		assert.equal(Object.keys(body.questions).length, 1);
		questions.push(Object.keys(body.questions)[0]);
		const mode = watch ? 'watch' : body.state.self.id === 'seoyeon' ? 'continue' : 'idle';
		response.end(participationResponse('wait', mode));
	});
	const port = await listen(model), directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${port}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key='active'").get().value;
	const snapshot = () => { const row = db.prepare('SELECT * FROM theater_worlds WHERE id=?').get(worldId); return { revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) }; };
	const fields = () => ({ worldId, revision: String(snapshot().revision) });
	try {
		await post(running.base, 'turn', { ...fields(), kind: 'speak', text: '안녕' });
		const job = await waitJob(running.base, db, worldId);
		assert.equal(job.progress.completedDecisions, 2);
		assert.deepEqual(questions, ['participation', 'inactivity', 'participation', 'inactivity']);
		const silent = snapshot();
		assert.equal(silent.state.events.length, 1);
		assert.equal(silent.state.instances.find(i => i.id === 'seoyeon').inactivity.mode, 'continue');
		assert.equal(silent.state.instances.find(i => i.id === 'harin').inactivity.mode, 'idle');
		const page = await (await fetch(running.base)).text();
		assert.equal((page.match(/class="stage-event /g) ?? []).length, 1);
		assert.ok(page.includes('최근 비참여 선택: 하던 일을 계속한다') && page.includes('최근 비참여 선택: 아무것도 하지 않는다'));
		const markdown = await (await fetch(`${running.base}/session/export?worldId=${worldId}`)).text();
		assert.ok(!/## .* · (서연|하린)/.test(markdown));
		await post(running.base, 'save', { worldId, slot: '1' });
		await running.stop(); running = await app(directory, `http://127.0.0.1:${port}/v1`);
		assert.deepEqual(snapshot(), silent);
		watch = true;
		await post(running.base, 'turn', { ...fields(), kind: 'wait' });
		await waitJob(running.base, db, worldId);
		assert.equal(snapshot().state.events.filter(e => e.decision?.choice === 'watch').length, 2);
		assert.ok(snapshot().state.events.filter(e => e.actorId !== 'player').every(e => e.text === '주변을 지켜본다.'));
		await post(running.base, 'load', { ...fields(), slot: '1' });
		assert.deepEqual(snapshot().state, silent.state);
		assert.deepEqual((await exported(running.base, worldId)).world.state, silent.state);
	} finally { await running.stop(); db.close(); await new Promise(done => model.close(done)); }
});

test('presentation snapshots keep the first relationship and each outfit change through restart and exports', async () => {
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response)) return;
		if (replyReflection(body, response)) return;
		if (body.questions) { response.end(participationResponse(participation(body.state), 'idle')); return; }
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: '고개를 끄덕인다.', utterance: '반가워.', memoUpdate: null }) } }] }));
	});
	const port = await listen(model), directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${port}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const worldId = db.prepare("SELECT value FROM theater_meta WHERE key='active'").get().value;
	const snapshot = () => { const row = db.prepare('SELECT * FROM theater_worlds WHERE id=?').get(worldId); return { revision: row.revision, definition: JSON.parse(row.definition_json), state: JSON.parse(row.state_json) }; };
	const fields = () => ({ worldId, revision: String(snapshot().revision) });
	const speeches = () => snapshot().state.events.filter(e => e.actorId === 'harin' && e.kind === 'speak');
	async function setAppearance(appearance) {
		const a = snapshot().state.instances.find(i => i.id === 'harin');
		await post(running.base, 'instance', { ...fields(), instanceId: a.id, name: a.name, sceneId: a.sceneId, companion: 'on', state: JSON.stringify(a.state), appearance, playerContext: '오늘 처음 만난 안내 담당이다.' }, '/lores');
	}
	async function turn() { await post(running.base, 'turn', { ...fields(), kind: 'speak', text: '안녕' }); await waitJob(running.base, db, worldId); }
	try {
		await setAppearance('노란 가디건을 걸쳤다.');
		await turn();
		assert.deepEqual(speeches()[0].presentation, { playerContext: '오늘 처음 만난 안내 담당이다.', appearance: '노란 가디건을 걸쳤다.' });
		await post(running.base, 'save', { worldId, slot: '1' });
		await setAppearance('파란 재킷을 걸쳤다.');
		await turn();
		assert.deepEqual(speeches()[1].presentation, { appearance: '파란 재킷을 걸쳤다.' });
		await turn();
		assert.equal(speeches()[2].presentation, undefined);
		const stable = snapshot();
		await running.stop(); running = await app(directory, `http://127.0.0.1:${port}/v1`);
		assert.deepEqual(snapshot(), stable);
		assert.deepEqual((await exported(running.base, worldId)).world.state.events, stable.state.events);
		const markdown = await (await fetch(`${running.base}/session/export?worldId=${worldId}`)).text();
		assert.equal(markdown.split('오늘 처음 만난 안내 담당이다.').length - 1, 1);
		assert.equal(markdown.split('노란 가디건을 걸쳤다.').length - 1, 1);
		assert.equal(markdown.split('파란 재킷을 걸쳤다.').length - 1, 1);
		const page = await (await fetch(running.base)).text();
		assert.ok(!page.includes('나와의 처음 설정') && !page.includes('현재 인상착의') && !page.includes('cast-introductions'));
		await post(running.base, 'load', { ...fields(), slot: '1' });
		assert.equal(speeches().length, 1);
		assert.deepEqual(speeches()[0].presentation, { playerContext: '오늘 처음 만난 안내 담당이다.', appearance: '노란 가디건을 걸쳤다.' });
	} finally { await running.stop(); db.close(); await new Promise(done => model.close(done)); }
});

test('built worker retrieves witnessed long-term memory through LanceDB and OEV into participation and expression', async () => {
	const calls = [];
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }, { id: 'embeddinggemma2', task: 'embedding' }] })); return; }
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		calls.push({ path: request.url, body });
		if (request.url === '/v1/embeddings') {
			response.end(JSON.stringify({ model: body.model, data: body.input.map((_, index) => ({ index, embedding: [1, ...new Array(body.dimensions - 1).fill(0)] })) }));
			return;
		}
		if (replyReflection(body, response) || replyPerformanceReview(body, response)) return;
		if (request.url === '/v1/systemone') { response.end(participationResponse(participation(body.state))); return; }
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: '안내 데스크를 가리킨다.', utterance: '아까 맡긴 파란 우산은 안내 데스크에 있어요.', memoUpdate: null }) } }] }));
	});
	const port = await listen(model), directory = scratch();
	const running = await app(directory, `http://127.0.0.1:${port}/v1`, { NEWERA_MEMORY_ENABLED: 'true', NEWERA_EMBEDDING_MODEL: 'embeddinggemma2', NEWERA_EMBEDDING_DIMENSIONS: '768', NEWERA_MEMORY_DIR: join(directory, 'memory-lance') });
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	try {
		const worldId = db.prepare("SELECT value FROM theater_meta WHERE key = 'active'").get().value;
		const row = db.prepare('SELECT * FROM theater_worlds WHERE id = ?').get(worldId);
		const state = JSON.parse(row.state_json);
		for (const actor of state.instances) { if (actor.id !== 'seoyeon') actor.active = false; }
		const old = { id: 'old-umbrella', actorId: 'player', targetId: 'seoyeon', sceneId: 'lobby', tick: 0, kind: 'speak', text: '파란 우산을 안내 데스크에 맡겼어.' };
		const waits = Array.from({ length: 20 }, (_, index) => ({ id: `wait-${index}`, actorId: 'seoyeon', targetId: null, sceneId: 'lobby', tick: 0, kind: 'wait', text: '주변을 지켜본다.' }));
		state.events = [old, ...waits];
		const observer = state.instances.find(actor => actor.id === 'seoyeon');
		observer.memories = state.events.map(event => ({ eventId: event.id, actorId: event.actorId, targetId: event.targetId, sceneId: event.sceneId, tick: event.tick, kind: event.kind, body: { narrative: event.kind === 'speak' ? null : event.text, utterance: event.kind === 'speak' ? event.text : null } }));
		observer.reflectedThroughEventId = old.id;
		db.prepare('UPDATE theater_worlds SET state_json = ? WHERE id = ?').run(JSON.stringify(state), worldId);
		await post(running.base, 'turn', { worldId, revision: String(row.revision), kind: 'speak', text: '내 파란 우산을 어디에 맡겼더라?', targetId: 'seoyeon' });
		await waitJob(running.base, db, worldId);
		const participation = calls.find(call => call.body.questions?.participation).body.state;
		assert.equal(participation.memorySearch.status, 'hybrid');
		assert.equal(participation.recalledEvents[0].eventId, old.id);
		assert.equal(participation.recalledEvents[0].actorId, 'player');
		assert.ok(!participation.recentEvents.some(event => event.eventId === old.id));
		const performance = calls.find(call => call.body.response_format?.json_schema?.name === 'actor_performance');
		const generated = JSON.parse(performance.body.messages[1].content);
		assert.equal(generated.history[0].eventId, old.id);
		assert.equal(generated.historyWindow.tokenLimit, 32768);
		assert.ok(generated.history.length > 16, 'generation sees history beyond the short decision window');
		assert.ok(!('recentEvents' in generated) && !('recalledEvents' in generated), 'the same transcript is not sent twice');
		assert.deepEqual(new Set(calls.filter(call => call.path === '/v1/embeddings').map(call => call.body.input_type)), new Set(['query', 'document']));
		const saved = JSON.parse(db.prepare('SELECT state_json FROM theater_worlds WHERE id = ?').get(worldId).state_json);
		assert.equal(saved.events.filter(event => event.id === old.id).length, 1, 'recall does not replay or duplicate historical facts');
	} finally { await running.stop(); db.close(); await new Promise(done => model.close(done)); }
});

test('a single resident continues through speech, object use and speech, publishing each result before choosing idle', async () => {
	let generated = 0, held = false, release;
	const hold = new Promise(done => { release = done; });
	const decisions = [];
	const model = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (replyPerformanceReview(body, response) || replyReflection(body, response)) return;
		if (body.questions) {
			if (body.questions.participation) {
				decisions.push(body.state);
				const actions = body.state.recentEvents.filter(event => event.actorId === 'seoyeon' && event.kind !== 'wait');
				response.end(participationResponse(actions.length < 3 ? 'act' : 'wait', 'idle'));
			} else response.end(participationResponse('wait', 'idle'));
			return;
		}
		generated++;
		if (generated === 2) { held = true; await hold; }
		const output = generated === 2
			? { actionId: 'interact:desk-bell:ring', targetId: 'desk-bell', narrative: '탁상 종을 눌러 확인한다.', utterance: null, memoUpdate: null }
			: { actionId: 'speak:player', targetId: 'player', narrative: null, utterance: generated === 1 ? '종을 한번 확인해볼게.' : '종은 잘 울려. 이제 시작할까?', memoUpdate: null };
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
	});
	const port = await listen(model), directory = scratch();
	const running = await app(directory, `http://127.0.0.1:${port}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	try {
		const row = db.prepare('SELECT * FROM theater_worlds LIMIT 1').get();
		const state = JSON.parse(row.state_json);
		state.instances.find(actor => actor.id === 'harin').active = false;
		db.prepare('UPDATE theater_worlds SET state_json=? WHERE id=?').run(JSON.stringify(state), row.id);
		await post(running.base, 'turn', { worldId: row.id, revision: String(row.revision), kind: 'speak', text: '준비해줘.', targetId: 'seoyeon' });
		for (let i = 0; i < 300 && !held; i++) await pause(20);
		assert.ok(held, 'a lone resident reaches a second performance without another player input');
		const pending = await latestJob(running.base, db, row.id);
		assert.deepEqual(pending.progress.pendingActorIds, ['seoyeon']);
		assert.equal(pending.progress.completedDecisions, 1);
		assert.match(await (await fetch(running.base)).text(), /종을 한번 확인해볼게\./);
		release();
		const finished = await waitJob(running.base, db, row.id);
		assert.equal(finished.progress.completedDecisions, 4);
		assert.deepEqual(finished.progress.pendingActorIds, []);
		assert.equal(generated, 3);
		assert.equal(decisions.length, 4);
		assert.ok(decisions[1].recentEvents.some(event => event.actorId === 'seoyeon' && event.body.utterance === '종을 한번 확인해볼게.'));
		const saved = JSON.parse(db.prepare('SELECT state_json FROM theater_worlds WHERE id=?').get(row.id).state_json);
		assert.deepEqual(saved.events.filter(event => event.actorId === 'seoyeon').map(event => event.kind), ['speak', 'interact', 'speak']);
		assert.equal(saved.instances.find(actor => actor.id === 'desk-bell').state.rung, true);
		assert.equal(saved.instances.find(actor => actor.id === 'seoyeon').inactivity.mode, 'idle');
		assert.equal(saved.tick, 1);
		assert.equal(saved.events.filter(event => event.actorId === 'player').length, 1);
	} finally { release(); await running.stop(); db.close(); model.closeAllConnections(); await new Promise(done => model.close(done)); }
});

test('manual retry adopts current aliases, provider routes and defaults after restart while preserving committed progress', async () => {
	const decisionCalls = [], textCalls = [], recoveryCalls = [];
	let failRecovery = false;
	let started = false, failFirst = true, release;
	const hold = new Promise(done => { release = done; });
	const decisionServer = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		decisionCalls.push({ path: request.url, body, auth: request.headers.authorization });
		if (replyPerformanceReview(body, response)) return;
		response.end(participationResponse(participation(body.state)));
	});
	const textServer = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		textCalls.push({ path: request.url, body, auth: request.headers.authorization });
		if (replyReflection(body, response)) return;
		if (failFirst) { failFirst = false; started = true; await hold; response.statusCode = 503; response.end('{"error":"temporary"}'); return; }
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: null, utterance: '다른 Provider에서 생성한 대사입니다.', memoUpdate: null }) } }] }));
	});
	const recoveryServer = createServer(async (request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'actor-model', task: 'generation' }] })); return; }
		const chunks = []; for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		recoveryCalls.push({ path: request.url, body, auth: request.headers.authorization });
		if (replyReflection(body, response) || replyPerformanceReview(body, response)) return;
		if (request.url === '/v1/systemone') { response.end(participationResponse(participation(body.state), 'idle')); return; }
		if (failRecovery) { response.statusCode = 503; response.end('{"error":"recovery unavailable"}'); return; }
		response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ actionId: 'speak:player', targetId: 'player', narrative: null, utterance: '현재 선택한 서버로 이어서 말할게.', memoUpdate: null }) } }] }));
	});
	const decisionPort = await listen(decisionServer), textPort = await listen(textServer), recoveryPort = await listen(recoveryServer), directory = scratch();
	let running = await app(directory, `http://127.0.0.1:${decisionPort}/v1`);
	const db = new DatabaseSync(join(directory, 'newera.sqlite'));
	const providerRequest = async (method, body, expected = 200, origin = running.base) => {
		const response = await fetch(`${running.base}/api/providers`, { method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const raw = await response.text();
		assert.equal(response.status, expected, raw);
		assert.ok(!['private-decision-key', 'private-text-key', 'private-recovery-key', 'private-default-key'].some(key => raw.includes(key)));
		return JSON.parse(raw);
	};
	const entry = (id, kind, port, key) => ({ id, label: id, kind, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, models: [{ id: 'main', label: '같은 모델의 별칭', modelId: 'actor-model', task: 'generation' }] });
	try {
		const worldId = db.prepare("SELECT value FROM theater_meta WHERE key='active'").get().value;
		let registry = await (await fetch(`${running.base}/api/providers`)).json();
		await providerRequest('POST', { revision: registry.revision, provider: entry('invalid-origin', 'oev', decisionPort, '') }, 403, 'http://untrusted.example');
		registry = await providerRequest('POST', { revision: registry.revision, provider: entry('judge', 'oev', decisionPort, 'private-decision-key') });
		registry = await providerRequest('POST', { revision: registry.revision, provider: entry('writer', 'openai-compatible', textPort, 'private-text-key') });
		const discovered = await (await fetch(`${running.base}/api/providers?models=writer`)).json();
		assert.deepEqual(discovered.models, [{ id: 'actor-model', task: 'generation' }]);
		const models = { decisionModel: 'judge::main', textModel: 'writer::main' };
		await post(running.base, 'models', { worldId, ...models });
		await providerRequest('POST', { revision: registry.revision, provider: { ...entry('writer', 'openai-compatible', textPort, ''), models: [] } }, 400);
		await providerRequest('POST', { revision: registry.revision, provider: { ...entry('judge', 'oev', decisionPort, ''), kind: 'openai-compatible' } }, 400);
		await providerRequest('POST', { revision: registry.revision, provider: { ...entry('writer', 'openai-compatible', textPort, ''), models: [{ id: 'main', label: '임베딩', modelId: 'actor-model', task: 'embedding' }] } }, 400);
		await post(running.base, 'models', { worldId, decisionModel: 'writer::main', textModel: 'judge::main' }, '/', true);
		await post(running.base, 'turn', { worldId, revision: '0', kind: 'speak', text: '서로 다른 서버로 진행해줘.', targetId: 'seoyeon' });
		for (let i = 0; i < 300 && !started; i++) await pause(20);
		assert.ok(started);
		const job = await latestJob(running.base, db, worldId);
		const privateRoutes = JSON.parse(db.prepare('SELECT providers_json FROM theater_jobs WHERE id=?').get(job.id).providers_json);
		assert.equal(privateRoutes.text.apiKey, 'private-text-key');
		assert.ok(!JSON.stringify(job).includes('private-text-key') && !JSON.stringify(job).includes('providers_json'));
		registry = await providerRequest('POST', { revision: registry.revision, provider: { ...entry('writer', 'openai-compatible', 9, 'changed-private-key'), models: [{ id: 'main', label: '변경한 별칭', modelId: 'changed-model', task: 'generation' }] } });
		release();
		await waitJob(running.base, db, worldId, true);
		await running.stop();
		running = await app(directory, `http://127.0.0.1:${decisionPort}/v1`);
		await providerRequest('DELETE', { revision: registry.revision, id: 'writer' }, 400);
		const recovery = { ...entry('recovery', 'oev', recoveryPort, 'private-recovery-key'), models: [{ id: 'judge', label: '새 판단', modelId: 'retry-judge', task: 'generation' }, { id: 'writer', label: '새 생성', modelId: 'retry-writer', task: 'generation' }] };
		registry = await providerRequest('POST', { revision: registry.revision, provider: recovery });
		const currentModels = { decisionModel: 'recovery::judge', textModel: 'recovery::writer' };
		await post(running.base, 'models', { worldId, ...currentModels });
		registry = await providerRequest('POST', { revision: registry.revision, provider: { ...recovery, apiKeyEnv: 'NEWERA_UNSET_RETRY_KEY_FOR_TEST' } });
		const storedJob = () => db.prepare('SELECT * FROM theater_jobs WHERE id=?').get(job.id);
		const beforeInvalidRetry = storedJob();
		const failure = await latestJob(running.base, db, worldId);
		await post(running.base, 'retry', { worldId, revision: String(failure.revision), jobId: failure.id }, '/', true);
		assert.deepEqual(storedJob(), beforeInvalidRetry, 'invalid current settings must preserve failure, cursor, inputs and old private snapshot');
		// Keep the same selected alias IDs while changing their real model targets before retry.
		registry = await providerRequest('POST', { revision: registry.revision, provider: { ...recovery, models: recovery.models.map(model => ({ ...model, modelId: `${model.modelId}-v2` })) } });
		registry = await providerRequest('DELETE', { revision: registry.revision, id: 'writer' });
		const oldDecisionCount = decisionCalls.length, oldTextCount = textCalls.length;
		await post(running.base, 'retry', { worldId, revision: String(failure.revision), jobId: failure.id });
		const completed = await waitJob(running.base, db, worldId);
		assert.equal(completed.id, job.id);
		assert.deepEqual(completed.models, currentModels);
		const updatedRoutes = JSON.parse(storedJob().providers_json);
		assert.equal(updatedRoutes.text.baseUrl, `http://127.0.0.1:${recoveryPort}/v1`);
		assert.equal(updatedRoutes.text.model, 'retry-writer-v2');
		assert.equal(updatedRoutes.text.apiKey, 'private-recovery-key');
		assert.equal(decisionCalls.length, oldDecisionCount);
		assert.equal(textCalls.length, oldTextCount);
		assert.ok(decisionCalls.every(c => c.path === '/v1/systemone' && c.auth === 'Bearer private-decision-key' && c.body.model === 'actor-model'));
		assert.ok(textCalls.every(c => c.path === '/v1/chat/completions' && c.auth === 'Bearer private-text-key' && c.body.model === 'actor-model' && !('reasoning_effort' in c.body)));
		assert.ok(recoveryCalls.some(c => c.path === '/v1/systemone') && recoveryCalls.some(c => c.path === '/v1/chat/completions'));
		assert.ok(recoveryCalls.every(c => c.auth === 'Bearer private-recovery-key' && c.body.model === (c.path === '/v1/systemone' ? 'retry-judge-v2' : 'retry-writer-v2')));
		const exportedWorld = await exported(running.base, worldId);
		assert.equal(exportedWorld.world.state.events.filter(e => e.actorId === 'player').length, 1);
		assert.ok(!JSON.stringify(exportedWorld).includes('private-recovery-key'));

		failRecovery = true;
		await post(running.base, 'turn', { worldId, revision: String(completed.revision), kind: 'speak', text: '다음 질문이야.', targetId: 'seoyeon' });
		const nextFailure = await waitJob(running.base, db, worldId, true);
		const committedState = JSON.parse(db.prepare('SELECT state_json FROM theater_worlds WHERE id=?').get(worldId).state_json);
		await post(running.base, 'models', { worldId, mode: 'defaults' });
		registry = await providerRequest('POST', { revision: registry.revision, provider: entry('default', 'oev', recoveryPort, 'private-default-key') });
		registry = await providerRequest('DELETE', { revision: registry.revision, id: 'recovery' });
		failRecovery = false;
		const recoveryBoundary = recoveryCalls.length;
		await post(running.base, 'retry', { worldId, revision: String(nextFailure.revision), jobId: nextFailure.id });
		const defaultRetry = await waitJob(running.base, db, worldId);
		assert.deepEqual(defaultRetry.models, { decisionModel: 'actor-model', textModel: 'actor-model' });
		assert.ok(recoveryCalls.slice(recoveryBoundary).every(c => c.auth === 'Bearer private-default-key' && c.body.model === 'actor-model'));
		const finalState = JSON.parse(db.prepare('SELECT state_json FROM theater_worlds WHERE id=?').get(worldId).state_json);
		assert.deepEqual(finalState.events.slice(0, committedState.events.length), committedState.events);
		assert.equal(finalState.tick, committedState.tick);
		assert.equal(finalState.minute, committedState.minute);
		assert.equal(finalState.events.filter(event => event.actorId === 'player').length, 2);
	} finally { release(); await running.stop(); db.close(); for (const server of [decisionServer, textServer, recoveryServer]) server.closeAllConnections(); await Promise.all([decisionServer, textServer, recoveryServer].map(server => new Promise(done => server.close(done)))); }
});

test.after(() => {
	for (const directory of scratchDirectories) {
		if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') && directory.includes('newera-theater-integration-')) rmSync(directory, { recursive: true, force: true });
	}
});
