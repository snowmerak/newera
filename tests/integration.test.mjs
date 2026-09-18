import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const dataDirectory = mkdtempSync(join(tmpdir(), 'newera-integration-'));
const modelCalls = [];
let refuseNextAction = false;
let failNextWorld = false;
const modelServer = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const body = JSON.parse(Buffer.concat(chunks).toString());
	response.setHeader('content-type', 'application/json');
	if (request.url === '/v1/embeddings') {
		response.end(JSON.stringify({ data: [{ embedding: [1, body.input.length % 7, 0.5] }] }));
		return;
	}
	if (request.url !== '/v1/chat/completions') {
		response.statusCode = 404;
		response.end('{}');
		return;
	}
	const system = body.messages[0].content;
	const input = JSON.parse(body.messages[1].content);
	const kind = system.includes('세계 진행 담당 세션') ? 'world'
		: system.includes('플레이어가 먼저 할 행동을 제안한다') ? 'suggest'
		: system.includes('COMMAND에 연결하는 해석기') ? 'interpret'
		: 'character';
	modelCalls.push({ kind, input });
	const world = kind === 'world';
	if (world && failNextWorld) {
		failNextWorld = false;
		response.statusCode = 503;
		response.end('{}');
		return;
	}
	const accepted = input.mode === 'player-action' && refuseNextAction ? false : true;
	if (input.mode === 'player-action') refuseNextAction = false;
	const output = kind === 'suggest'
		? { suggestions: ['서연에게 책을 추천한다', '지은과 함께 서연에게 말을 건다', '서연과 대화한다', '잠시 쉰다'] }
		: kind === 'interpret'
			? { actionId: input.playerText.includes('입맞춤') ? 'kiss' : input.playerText.includes('대화') ? 'talk' : null,
				targetId: input.playerText.includes('서연') ? 'seoyeon' : null }
		: world
		? { scene: '저녁 거리에 비가 내린다.', situation: '서연이 서점 문을 닫을 시간이다.', location: '망원동 서점 앞', focusCharacterId: 'seoyeon', minutes: 10, worldMemory: '망원동에 비가 내린다.' }
		: { narrative: input.mode === 'idle' ? '서연이 다가와 대화를 제안했다.' : accepted ? '서연이 고개를 끄덕이며 이야기를 나눴다.' : '서연이 고개를 저으며 거절했다.', accepted,
			memory: input.mode === 'idle' ? '서연이 서점 앞에서 대화를 제안했다.' : null,
			proposal: input.mode === 'idle' ? { actionId: 'talk', text: '잠깐 이야기할래요?' } : null };
	response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
});

async function freePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

test('world and character turns, proposals, settings, save/load', async () => {
	await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
	const modelPort = modelServer.address().port;
	const appPort = await freePort();
	const app = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', ORIGIN: `http://127.0.0.1:${appPort}`,
			NEWERA_DATA_DIR: dataDirectory, NEWERA_LLM_BASE_URL: `http://127.0.0.1:${modelPort}/v1` },
		stdio: 'pipe'
	});
	const base = `http://127.0.0.1:${appPort}`;
	const post = async (action, fields = {}, expectFailure = false) => {
		const response = await fetch(`${base}/?/${action}`, { method: 'POST', headers: { Origin: base }, body: new URLSearchParams(fields) });
		const body = await response.text();
		assert.equal(response.status, 200, `${action}: ${body}`);
		assert.equal(body.includes('"type":"failure"'), expectFailure, `${action}: ${body}`);
	};
	const postModule = async (name, contents, expectFailure = false) => {
		const form = new FormData();
		form.append('moduleFile', new Blob([contents], { type: 'application/json' }), name);
		const response = await fetch(`${base}/?/installModule`, { method: 'POST', headers: { Origin: base }, body: form });
		const body = await response.text();
		assert.equal(response.status, 200, `installModule: ${body}`);
		assert.equal(body.includes('"type":"failure"'), expectFailure, `installModule: ${body}`);
	};
	try {
		let ready = false;
		for (let attempt = 0; attempt < 60; attempt += 1) {
			if (app.exitCode !== null) throw new Error(`서버가 종료됐습니다: ${app.exitCode}`);
			try { ready = (await fetch(base)).ok; } catch { /* starting */ }
			if (ready) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(ready, 'app did not start');
		await post('scenario', { worldSetting: '비가 잦은 망원동', eraRules: '대화는 신뢰를 쌓는다' });
		await post('character', { name: '하린', age: '28', profile: '하린은 동네의 작가다.' });
		await post('advance');
		const db = new DatabaseSync(join(dataDirectory, 'newera.sqlite'));
		try {
			assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 3);
			assert.equal(db.prepare('SELECT action_id FROM events ORDER BY id DESC LIMIT 1').get().action_id, 'advance');
			assert.equal(db.prepare('SELECT world_memory FROM scenario_config').get().world_memory, '망원동에 비가 내린다.');
			assert.equal(JSON.parse(db.prepare('SELECT pending_proposal_json FROM scenario_config').get().pending_proposal_json).actionId, 'talk');
			assert.equal(db.prepare('SELECT summary FROM memories ORDER BY id DESC LIMIT 1').get().summary, '서연이 서점 앞에서 대화를 제안했다.');
			const firstEvent = db.prepare('SELECT id, turn, summary FROM events ORDER BY id LIMIT 1').get();
			db.prepare('INSERT INTO memories (event_id, character_id, summary, created_turn) VALUES (?, ?, ?, ?)').run(
				firstEvent.id, 'seoyeon', `${firstEvent.summary} 과장된 기억 문장`, firstEvent.turn
			);
			const page = await (await fetch(base)).text();
			assert.ok(page.includes('서연이 서점 앞에서 대화를 제안했다.'));
			assert.ok(!page.includes('과장된 기억 문장'));
			await post('proposal', { answer: 'accept' });
			assert.equal(db.prepare('SELECT action_id FROM events ORDER BY id DESC LIMIT 1').get().action_id, 'talk');
			assert.equal(db.prepare('SELECT pending_proposal_json FROM scenario_config').get().pending_proposal_json, null);
			await post('suggest', { targetId: 'seoyeon' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
			assert.equal(JSON.parse(db.prepare('SELECT player_suggestions_json FROM scenario_config').get().player_suggestions_json).options.length, 3);
			assert.ok((await (await fetch(base)).text()).includes('서연에게 책을 추천한다'));
			await post('freeAct', { text: '서연에게 책을 추천한다', targetId: 'seoyeon' });
			assert.equal(db.prepare('SELECT action_id FROM events ORDER BY id DESC LIMIT 1').get().action_id, 'custom');
			assert.equal(db.prepare('SELECT source_json FROM events ORDER BY id DESC LIMIT 1').get().source_json, '{}');
			assert.equal(db.prepare('SELECT player_suggestions_json FROM scenario_config').get().player_suggestions_json, null);
			await post('freeAct', { text: '서연과 대화한다', targetId: 'seoyeon' });
			assert.equal(db.prepare('SELECT action_id FROM events ORDER BY id DESC LIMIT 1').get().action_id, 'talk');
			assert.notEqual(db.prepare('SELECT source_json FROM events ORDER BY id DESC LIMIT 1').get().source_json, '{}');
			await post('freeAct', { text: '서연에게 입맞춤을 제안한다', targetId: 'seoyeon' }, true);
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 4);
			await post('act', { actionId: 'listen', targetId: 'seoyeon' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 5);
			const relationBeforeRefusal = db.prepare("SELECT relation_json FROM characters WHERE id = 'seoyeon'").get().relation_json;
			refuseNextAction = true;
			await post('act', { actionId: 'flirt', targetId: 'seoyeon' });
			assert.equal(db.prepare('SELECT source_json FROM events ORDER BY id DESC LIMIT 1').get().source_json, '{}');
			assert.equal(db.prepare("SELECT relation_json FROM characters WHERE id = 'seoyeon'").get().relation_json, relationBeforeRefusal);
			failNextWorld = true;
			await post('advance', {}, true);
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 6);
			await post('save', { slot: '1' });
			await post('advance');
			await post('load', { slot: '1' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 6);
			assert.ok(modelCalls.filter((call) => call.kind === 'world').length >= 3);
			assert.ok(modelCalls.filter((call) => call.kind === 'character').length >= 3);
			assert.ok(modelCalls.some((call) => call.kind === 'suggest'));
			assert.ok(modelCalls.some((call) => call.kind === 'interpret'));
			assert.equal(modelCalls[0].input.worldSetting, '비가 잦은 망원동');
			assert.equal(modelCalls[1].input.character.name, '서연');
			const characterModule = readFileSync(join(process.cwd(), 'static/modules/example-character.json'), 'utf8');
			const worldModule = readFileSync(join(process.cwd(), 'static/modules/example-world.json'), 'utf8');
			await postModule('underage.json', JSON.stringify({ schemaVersion: 1, id: 'invalid.age', name: 'invalid', version: '1', characters: [{ id: 'a', name: 'a', age: 19, profile: 'profile' }] }), true);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 0);
			await postModule('character.json', characterModule);
			await postModule('world.json', worldModule);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules WHERE enabled = 1').get().n, 2);
			assert.equal(db.prepare("SELECT module_id FROM characters WHERE id = 'mod:example.harin:harin'").get().module_id, 'example.harin');
			assert.ok((await (await fetch(base)).text()).includes('value="mod:example.harin:harin"'));
			await post('advance');
			assert.ok(modelCalls.findLast((call) => call.kind === 'world').input.worldSetting.includes('며칠째 늦여름 비'));
			await post('act', { actionId: 'talk', targetId: 'mod:example.harin:harin' });
			const moduleRelation = db.prepare("SELECT relation_json FROM characters WHERE id = 'mod:example.harin:harin'").get().relation_json;
			await post('toggleModule', { id: 'example.harin', enabled: '0' });
			assert.ok(!(await (await fetch(base)).text()).includes('value="mod:example.harin:harin"'));
			await post('act', { actionId: 'talk', targetId: 'mod:example.harin:harin' }, true);
			await post('toggleModule', { id: 'example.harin', enabled: '1' });
			assert.equal(db.prepare("SELECT relation_json FROM characters WHERE id = 'mod:example.harin:harin'").get().relation_json, moduleRelation);
			const revisedCharacter = JSON.parse(characterModule);
			revisedCharacter.version = '1.1.0';
			revisedCharacter.characters[0].profile = '하린은 새 작업실로 이사했다.';
			await postModule('character-update.json', JSON.stringify(revisedCharacter));
			assert.equal(db.prepare("SELECT profile FROM characters WHERE id = 'mod:example.harin:harin'").get().profile, '하린은 새 작업실로 이사했다.');
			assert.equal(db.prepare("SELECT relation_json FROM characters WHERE id = 'mod:example.harin:harin'").get().relation_json, moduleRelation);
			await postModule('another-world.json', JSON.stringify({ schemaVersion: 1, id: 'example.other-world', name: '다른 세계', version: '1.0.0', world: { setting: '다른 도시' } }));
			assert.equal(db.prepare("SELECT enabled FROM modules WHERE id = 'example.rainy-mangwon'").get().enabled, 0);
			assert.equal(db.prepare("SELECT enabled FROM modules WHERE id = 'example.harin'").get().enabled, 1);
			await post('toggleModule', { id: 'example.rainy-mangwon', enabled: '1' });
			assert.equal(db.prepare("SELECT enabled FROM modules WHERE id = 'example.other-world'").get().enabled, 0);
			await post('save', { slot: '2' });
			await post('toggleModule', { id: 'example.harin', enabled: '0' });
			await post('toggleModule', { id: 'example.rainy-mangwon', enabled: '0' });
			await post('load', { slot: '2' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules WHERE enabled = 1').get().n, 2);
			assert.equal(db.prepare("SELECT relation_json FROM characters WHERE id = 'mod:example.harin:harin'").get().relation_json, moduleRelation);
			await post('load', { slot: '1' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules WHERE enabled = 1').get().n, 0);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 3);
		} finally {
			db.close();
		}
	} finally {
		if (app.exitCode === null) {
			app.kill();
			await once(app, 'exit');
		}
		await new Promise((resolve) => modelServer.close(resolve));
		if (dataDirectory.startsWith(`${tmpdir()}${process.platform === 'win32' ? '\\' : '/'}`)) {
			rmSync(dataDirectory, { recursive: true, force: true });
		}
	}
});
