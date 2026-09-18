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
	const manageActions = new Set(['createLore', 'renameLore', 'scenario', 'character', 'installModule', 'toggleModule', 'selectWorld', 'importLore', 'deleteLore']);
	const post = async (action, fields = {}, expectFailure = false) => {
		const path = manageActions.has(action) ? '/lores' : '/';
		const response = await fetch(`${base}${path}?/${action}`, { method: 'POST', headers: { Origin: base }, body: new URLSearchParams(fields) });
		const body = await response.text();
		assert.equal(response.status, 200, `${action}: ${body}`);
		assert.equal(body.includes('"type":"failure"'), expectFailure, `${action}: ${body}`);
	};
	const postModule = async (name, contents, expectFailure = false) => {
		const form = new FormData();
		form.append('moduleFile', new Blob([contents], { type: 'application/json' }), name);
		const response = await fetch(`${base}/lores?/installModule`, { method: 'POST', headers: { Origin: base }, body: form });
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
		const firstPage = await (await fetch(base)).text();
		assert.ok(firstPage.includes('aria-label="로어 목록"'));
		assert.ok(firstPage.includes('>망원동</button>'));
		assert.ok(!firstPage.includes('data-lore-id='));
		const sidebar = firstPage.split('<aside class="lore-sidebar"')[1].split('</aside>')[0];
		assert.ok(!sidebar.includes('로어 관리'));
		assert.ok(sidebar.includes('aria-label="저장 슬롯"'));
		assert.ok(!firstPage.split('<main class="reader">')[1].split('</main>')[0].includes('aria-label="저장 슬롯"'));
		assert.ok(firstPage.includes('현재 세션'));
		assert.ok(firstPage.includes('저장 슬롯'));
		assert.ok(!firstPage.includes('new-lore-world'));
		const managementPage = await (await fetch(`${base}/lores`)).text();
		assert.ok(managementPage.includes('새 로어 만들기'));
		assert.ok(managementPage.includes('로어 가져오기'));
		assert.ok(managementPage.includes('로어 삭제'));
		assert.ok(managementPage.includes('내보내기'));
		await post('scenario', { worldSetting: '비가 잦은 망원동', eraRules: '대화는 신뢰를 쌓는다' });
		await post('character', { name: '하린', age: '28', profile: '하린은 동네의 작가다.' });
		await post('advance');
		const db = new DatabaseSync(join(dataDirectory, 'newera.sqlite'));
		try {
			const originalLoreId = db.prepare('SELECT active_lore_id FROM lore_meta WHERE id = 1').get().active_lore_id;
			assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 3);
			const harinId = db.prepare("SELECT id FROM characters WHERE name = '하린'").get().id;
			db.prepare('UPDATE characters SET trait_json = ?, mark_json = ? WHERE id = ?').run('["작가"]', '["첫 만남"]', harinId);
			const fixedFields = {
				'base.energy': '17', 'base.maxEnergy': '24',
				'talent.pride': '61', 'talent.openness': '73', 'talent.empathy': '82', 'talent.assertiveness': '45',
				'abl.conversation': '4', 'abl.empathy': '3', 'abl.seduction': '2',
				'exp.conversation': '9', 'exp.empathy': '8', 'exp.seduction': '7',
				'relation.affection': '12', 'relation.trust': '11', 'relation.desire': '4',
				'palam.rapport': '6', 'palam.trust': '5', 'palam.arousal': '3', 'palam.pleasure': '2'
			};
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields });
			const harinStats = db.prepare('SELECT base_json, trait_json, talent_json, abl_json, exp_json, mark_json, relation_json, palam_json FROM characters WHERE id = ?').get(harinId);
			assert.deepEqual(JSON.parse(harinStats.base_json), { energy: 17, maxEnergy: 24 });
			assert.deepEqual(JSON.parse(harinStats.talent_json), { pride: 61, openness: 73, empathy: 82, assertiveness: 45 });
			assert.deepEqual(JSON.parse(harinStats.abl_json), { conversation: 4, empathy: 3, seduction: 2 });
			assert.deepEqual(JSON.parse(harinStats.exp_json), { conversation: 9, empathy: 8, seduction: 7 });
			assert.deepEqual(JSON.parse(harinStats.relation_json), { affection: 12, trust: 11, desire: 4 });
			assert.deepEqual(JSON.parse(harinStats.palam_json), { rapport: 6, trust: 5, arousal: 3, pleasure: 2 });
			assert.deepEqual(JSON.parse(harinStats.trait_json), ['작가']);
			assert.deepEqual(JSON.parse(harinStats.mark_json), ['첫 만남']);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'base.energy': '25' }, true);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'abl.conversation': '' }, true);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'talent.pride': '101' }, true);
			assert.deepEqual(JSON.parse(db.prepare('SELECT base_json FROM characters WHERE id = ?').get(harinId).base_json), { energy: 17, maxEnergy: 24 });
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
			assert.deepEqual(JSON.parse(db.prepare('SELECT talent_json FROM characters WHERE id = ?').get(harinId).talent_json), { pride: 61, openness: 73, empathy: 82, assertiveness: 45 });
			assert.ok(modelCalls.filter((call) => call.kind === 'world').length >= 3);
			assert.ok(modelCalls.filter((call) => call.kind === 'character').length >= 3);
			assert.ok(modelCalls.some((call) => call.kind === 'suggest'));
			assert.ok(modelCalls.some((call) => call.kind === 'interpret'));
			assert.equal(modelCalls[0].input.worldSetting, '비가 잦은 망원동');
			assert.equal(modelCalls[1].input.character.name, '서연');
			const characterModule = readFileSync(join(process.cwd(), 'static/modules/example-character.json'), 'utf8');
			const worldModule = readFileSync(join(process.cwd(), 'static/modules/example-world.json'), 'utf8');
			await postModule('underage.json', JSON.stringify({ schemaVersion: 1, id: 'invalid.age', name: 'invalid', version: '1', characters: [{ id: 'a', name: 'a', age: 19, profile: 'profile' }] }), true);
			const invalidTalentModule = JSON.parse(characterModule);
			invalidTalentModule.characters[0].talent.pride = 101;
			await postModule('invalid-talent.json', JSON.stringify(invalidTalentModule), true);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 0);
			await postModule('character.json', characterModule);
			await postModule('world.json', worldModule);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules WHERE enabled = 1').get().n, 2);
			assert.equal(db.prepare("SELECT module_id FROM characters WHERE id = 'mod:example.harin:harin'").get().module_id, 'example.harin');
			assert.equal(JSON.parse(db.prepare("SELECT talent_json FROM characters WHERE id = 'mod:example.harin:harin'").get().talent_json).pride, 72);
			const modulePage = await (await fetch(`${base}/lores`)).text();
			assert.ok(modulePage.includes('value="mod:example.harin:harin"'));
			assert.ok(modulePage.includes('세계관·인물 모듈'));
			assert.ok(!modulePage.includes('data-lore-id='));
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
			await post('selectWorld', { id: '' });
			assert.equal(db.prepare("SELECT enabled FROM modules WHERE id = 'example.other-world'").get().enabled, 0);
			assert.equal(db.prepare("SELECT enabled FROM modules WHERE id = 'example.harin'").get().enabled, 1);
			await post('selectWorld', { id: 'example.rainy-mangwon' });
			assert.equal(db.prepare("SELECT enabled FROM modules WHERE id = 'example.rainy-mangwon'").get().enabled, 1);
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
			assert.equal(db.prepare('SELECT count(*) AS n FROM lore_save_slots WHERE lore_id = ?').get(originalLoreId).n, 2);

			await post('createLore', { title: '비밀의 저택', worldSetting: '외딴 저택의 밤', eraRules: '방을 탐색하고 인물의 의지를 존중한다' });
			const secondLoreId = db.prepare('SELECT active_lore_id FROM lore_meta WHERE id = 1').get().active_lore_id;
			assert.notEqual(secondLoreId, originalLoreId);
			assert.equal(db.prepare('SELECT count(*) AS n FROM lores').get().n, 2);
			assert.equal(db.prepare('SELECT turn FROM world_state').get().turn, 0);
			assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 0);
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 0);
			assert.equal(db.prepare('SELECT world_setting FROM scenario_config').get().world_setting, '외딴 저택의 밤');
			assert.equal(db.prepare('SELECT count(*) AS n FROM lore_save_slots WHERE lore_id = ?').get(secondLoreId).n, 0);
			const secondPage = await (await fetch(base)).text();
			assert.ok(secondPage.includes('>망원동</button>'));
			assert.ok(secondPage.includes('>비밀의 저택</button>'));
			assert.ok(secondPage.includes('0/3 사용 중'));
			await post('load', { slot: '2' }, true);
			await post('character', { name: '도희', age: '30', profile: '저택의 관리인이다.' });
			await post('save', { slot: '1' });
			await post('switchLore', { id: originalLoreId });
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 6);
			assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 3);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 3);
			assert.equal(db.prepare('SELECT world_setting FROM scenario_config').get().world_setting, '비가 잦은 망원동');
			assert.ok((await (await fetch(base)).text()).includes('2/3 사용 중'));
			await post('load', { slot: '2' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules WHERE enabled = 1').get().n, 2);
			await post('switchLore', { id: secondLoreId });
			assert.equal(db.prepare('SELECT name FROM characters').get().name, '도희');
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 0);
			assert.ok((await (await fetch(base)).text()).includes('1/3 사용 중'));
			await post('renameLore', { title: '저택의 밤' });
			assert.equal(db.prepare('SELECT title FROM lores WHERE id = ?').get(secondLoreId).title, '저택의 밤');
			await post('switchLore', { id: 'missing-lore' }, true);
			assert.equal(db.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id, secondLoreId);
			const exportResponse = await fetch(`${base}/lores/export/${secondLoreId}`);
			assert.equal(exportResponse.status, 200);
			assert.ok(exportResponse.headers.get('content-disposition').includes('.json'));
			const exported = await exportResponse.text();
			const bundle = JSON.parse(exported);
			assert.equal(bundle.title, '저택의 밤');
			assert.equal(bundle.saves.length, 1);
			const loreFile = new FormData();
			loreFile.append('loreFile', new Blob([exported], { type: 'application/json' }), 'lore.json');
			const importResponse = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: loreFile });
			assert.equal(importResponse.status, 200);
			assert.ok(!(await importResponse.text()).includes('"type":"failure"'));
			const importedLoreId = db.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id;
			assert.notEqual(importedLoreId, secondLoreId);
			assert.equal(db.prepare('SELECT count(*) AS n FROM lores').get().n, 3);
			assert.equal(db.prepare('SELECT name FROM characters').get().name, '도희');
			assert.equal(db.prepare('SELECT count(*) AS n FROM lore_save_slots WHERE lore_id = ?').get(importedLoreId).n, 1);
			await post('deleteLore', { id: importedLoreId, confirmation: '다른 제목' }, true);
			assert.equal(db.prepare('SELECT count(*) AS n FROM lores').get().n, 3);
			await post('deleteLore', { id: importedLoreId, confirmation: '저택의 밤' });
			assert.equal(db.prepare('SELECT count(*) AS n FROM lores').get().n, 2);
			assert.equal(db.prepare('SELECT count(*) AS n FROM lore_save_slots WHERE lore_id = ?').get(importedLoreId).n, 0);
			assert.equal(db.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id, originalLoreId);
			const originalBundle = await (await fetch(`${base}/lores/export/${originalLoreId}`)).text();
			assert.equal(JSON.parse(originalBundle).state.modules.length, 3);
			const legacyTalentBundle = JSON.parse(originalBundle);
			for (const character of legacyTalentBundle.state.characters) delete character.talent_json;
			for (const save of legacyTalentBundle.saves) {
				for (const character of save.state.characters) delete character.talent_json;
			}
			const originalFile = new FormData();
			originalFile.append('loreFile', new Blob([JSON.stringify(legacyTalentBundle)], { type: 'application/json' }), 'original.json');
			const originalImport = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: originalFile });
			assert.equal(originalImport.status, 200);
			assert.ok(!(await originalImport.text()).includes('"type":"failure"'));
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, JSON.parse(originalBundle).state.events.length);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 3);
			assert.deepEqual(JSON.parse(db.prepare('SELECT talent_json FROM characters WHERE id = ?').get(harinId).talent_json), { pride: 50, openness: 50, empathy: 50, assertiveness: 50 });
			const importedOriginalId = db.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id;
			assert.equal(db.prepare('SELECT count(*) AS n FROM lore_save_slots WHERE lore_id = ?').get(importedOriginalId).n, 2);
			const badBundle = JSON.parse(originalBundle);
			badBundle.state.characters[0].age = 19;
			const invalidFile = new FormData();
			invalidFile.append('loreFile', new Blob([JSON.stringify(badBundle)], { type: 'application/json' }), 'invalid.json');
			const invalidImport = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: invalidFile });
			assert.ok((await invalidImport.text()).includes('"type":"failure"'));
			assert.equal(db.prepare('SELECT count(*) AS n FROM lores').get().n, 3);
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

test('existing progress and legacy save slots become the first lore', async () => {
	const legacyDirectory = mkdtempSync(join(tmpdir(), 'newera-migration-'));
	const path = join(legacyDirectory, 'newera.sqlite');
	const oldSnapshot = {
		world: [{ id: 1, turn: 4, day: 1, minute: 900, location: '예전 저장 장소' }],
		player: [{ id: 1, energy: 17, max_energy: 24 }],
		characters: [], events: [], memories: []
	};
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE world_state (id INTEGER PRIMARY KEY, turn INTEGER, day INTEGER, minute INTEGER, location TEXT);
		CREATE TABLE player_state (id INTEGER PRIMARY KEY, energy INTEGER, max_energy INTEGER);
		CREATE TABLE save_slots (slot INTEGER PRIMARY KEY, saved_at TEXT, turn INTEGER, snapshot_json TEXT);`);
	db.prepare('INSERT INTO world_state VALUES (1, 9, 2, 1080, ?)').run('현재 진행 장소');
	db.prepare('INSERT INTO player_state VALUES (1, 12, 24)').run();
	db.prepare('INSERT INTO save_slots VALUES (2, ?, 4, ?)').run('2026-09-19T00:00:00.000Z', JSON.stringify(oldSnapshot));
	db.close();
	const appPort = await freePort();
	const base = `http://127.0.0.1:${appPort}`;
	const app = spawn(process.execPath, ['build/index.js'], {
		cwd: process.cwd(),
		env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', ORIGIN: base, NEWERA_DATA_DIR: legacyDirectory },
		stdio: 'pipe'
	});
	try {
		let ready = false;
		for (let attempt = 0; attempt < 60; attempt += 1) {
			if (app.exitCode !== null) throw new Error(`서버가 종료됐습니다: ${app.exitCode}`);
			try { ready = (await fetch(base)).ok; } catch { /* starting */ }
			if (ready) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(ready, 'app did not start');
		const migrated = new DatabaseSync(path);
		try {
			assert.equal(migrated.prepare('SELECT title FROM lores').get().title, '기존 로어');
			assert.equal(migrated.prepare('SELECT turn FROM world_state').get().turn, 9);
			assert.equal(migrated.prepare('SELECT energy FROM player_state').get().energy, 12);
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM lore_save_slots').get().n, 1);
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM save_slots').get().n, 1);
			const response = await fetch(`${base}/?/load`, { method: 'POST', headers: { Origin: base }, body: new URLSearchParams({ slot: '2' }) });
			assert.equal(response.status, 200);
			assert.ok(!(await response.text()).includes('"type":"failure"'));
			assert.equal(migrated.prepare('SELECT turn FROM world_state').get().turn, 4);
			assert.equal(migrated.prepare('SELECT energy FROM player_state').get().energy, 17);
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM lores').get().n, 1);
			const firstLoreId = migrated.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id;
			const exported = await (await fetch(`${base}/lores/export/${firstLoreId}`)).text();
			const form = new FormData();
			form.append('loreFile', new Blob([exported], { type: 'application/json' }), 'legacy-lore.json');
			const imported = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: form });
			assert.equal(imported.status, 200);
			assert.ok(!(await imported.text()).includes('"type":"failure"'));
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM lores').get().n, 2);
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM lore_save_slots').get().n, 2);
		} finally {
			migrated.close();
		}
	} finally {
		if (app.exitCode === null) {
			app.kill();
			await once(app, 'exit');
		}
		if (legacyDirectory.startsWith(`${tmpdir()}${process.platform === 'win32' ? '\\' : '/'}`)) {
			rmSync(legacyDirectory, { recursive: true, force: true });
		}
	}
});
