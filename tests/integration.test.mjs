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
	modelCalls.push({ kind, input, responseFormat: body.response_format });
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
	const simulatorActions = new Set(['conversation', 'edit']);
	const post = async (action, fields = {}, expectFailure = false) => {
		const path = manageActions.has(action) ? '/lores' : simulatorActions.has(action) ? '/simulator' : '/';
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
		assert.ok(firstPage.includes('>망원동의 세 사람</button>'));
		assert.ok(!firstPage.includes('data-lore-id='));
		const sidebar = firstPage.split('<aside id="lore-sidebar"')[1].split('</aside>')[0];
		assert.ok(!sidebar.includes('로어 관리'));
		assert.ok(sidebar.includes('aria-label="저장 슬롯"'));
		assert.ok(!firstPage.split('<main class="reader">')[1].split('</main>')[0].includes('aria-label="저장 슬롯"'));
		assert.ok(firstPage.includes('현재 세션'));
		assert.ok(firstPage.includes('저장 슬롯'));
		assert.ok(firstPage.includes('aria-label="대화와 장면"'));
		assert.ok(firstPage.includes('aria-label="행동 요청"'));
		assert.ok(firstPage.includes('aria-label="추천 행동"'));
		assert.ok(firstPage.includes('사이드바 숨기기'));
		assert.ok(!firstPage.includes('LLM에게 행동 제안 받기'));
		assert.ok(!firstPage.includes('플레이어 체력'));
		assert.ok(!firstPage.includes('new-lore-world'));
		assert.ok(!firstPage.includes('href="/simulator"'));
		const managementPage = await (await fetch(`${base}/lores`)).text();
		assert.ok(managementPage.includes('새 로어 만들기'));
		assert.ok(managementPage.includes('로어 가져오기'));
		assert.ok(managementPage.includes('로어 삭제'));
		assert.ok(managementPage.includes('내보내기'));
		assert.ok(managementPage.includes('name="talent.libido"'));
		assert.ok(managementPage.includes('name="relation.resentment"'));
		assert.ok(managementPage.includes('name="mark.firstKiss"'));
		assert.ok(managementPage.includes('name="requirement.0.actionId"'));
		assert.ok(managementPage.includes('＋ 조건 추가'));
		assert.ok(!managementPage.includes('href="/simulator"'));
		await post('scenario', { worldSetting: '비가 잦은 망원동', eraRules: '대화는 신뢰를 쌓는다' });
		await post('character', { name: '하린', age: '28', profile: '하린은 동네의 작가다.' });
		await post('advance');
		const db = new DatabaseSync(join(dataDirectory, 'newera.sqlite'));
		try {
			assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'player_state'").get().n, 0);
			const originalLoreId = db.prepare('SELECT active_lore_id FROM lore_meta WHERE id = 1').get().active_lore_id;
			assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 3);
			const harinId = db.prepare("SELECT id FROM characters WHERE name = '하린'").get().id;
			db.prepare('UPDATE characters SET trait_json = ?, mark_json = ? WHERE id = ?').run('["작가"]', '["첫 만남"]', harinId);
			const rawHarinTemplate = JSON.parse(db.prepare('SELECT character_json FROM character_templates WHERE id = ?').get(harinId).character_json);
			rawHarinTemplate.trait = ['작가'];
			rawHarinTemplate.mark = ['첫 만남'];
			db.prepare('UPDATE character_templates SET character_json = ? WHERE id = ?').run(JSON.stringify(rawHarinTemplate), harinId);
			const fixedFields = {
				'base.energy': '17', 'base.maxEnergy': '24',
				'talent.pride': '61', 'talent.openness': '73', 'talent.libido': '90', 'talent.modesty': '90',
				'talent.assertiveness': '90', 'talent.receptiveness': '20', 'talent.curiosity': '82',
				'abl.conversation': '4', 'abl.empathy': '3', 'abl.seduction': '2', 'abl.intimacy': '8',
				'exp.social': '17', 'exp.romantic': '3', 'exp.seduction': '7', 'exp.intimacy': '1',
				'relation.affection': '80', 'relation.trust': '11', 'relation.desire': '90',
				'relation.attachment': '12', 'relation.jealousy': '14', 'relation.resentment': '55',
				'palam.rapport': '6', 'palam.comfort': '5', 'palam.arousal': '3', 'palam.pleasure': '2',
				'palam.embarrassment': '4', 'palam.tension': '9', 'palam.frustration': '1', 'palam.satisfaction': '8'
			};
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields });
			const harinTemplate = JSON.parse(db.prepare('SELECT character_json FROM character_templates WHERE id = ?').get(harinId).character_json);
			assert.deepEqual(harinTemplate.base, { energy: 17, maxEnergy: 24 });
			assert.deepEqual(harinTemplate.talent, { pride: 61, openness: 73, libido: 90, modesty: 90, assertiveness: 90, receptiveness: 20, curiosity: 82 });
			const harinStats = db.prepare('SELECT base_json, trait_json, talent_json, abl_json, exp_json, mark_json, relation_json, palam_json FROM characters WHERE id = ?').get(harinId);
			assert.deepEqual(JSON.parse(harinStats.base_json), { energy: 20, maxEnergy: 20 });
			assert.deepEqual(JSON.parse(harinStats.talent_json), { pride: 50, openness: 50, libido: 50, modesty: 50, assertiveness: 50, receptiveness: 50, curiosity: 50 });
			assert.deepEqual(JSON.parse(harinStats.trait_json), ['작가']);
			assert.deepEqual(JSON.parse(harinStats.mark_json), ['첫 만남']);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields,
				'mark.present': '1', 'mark.firstDate': 'on', 'mark.custom': '첫 만남, 독자 만남',
				'requirements.present': '1',
				'requirement.0.actionId': 'kiss', 'requirement.0.stat': 'relation.desire', 'requirement.0.minimum': '12',
				'requirement.1.actionId': 'intimacy', 'requirement.1.stat': 'talent.libido', 'requirement.1.minimum': '90' });
			const revisedTemplate = JSON.parse(db.prepare('SELECT character_json FROM character_templates WHERE id = ?').get(harinId).character_json);
			assert.deepEqual(revisedTemplate.mark, ['firstDate', '첫 만남', '독자 만남']);
			assert.deepEqual(revisedTemplate.actionRequirements, [
				{ actionId: 'kiss', stat: 'relation.desire', minimum: 12 },
				{ actionId: 'intimacy', stat: 'talent.libido', minimum: 90 }
			]);
			assert.deepEqual(JSON.parse(db.prepare('SELECT mark_json FROM characters WHERE id = ?').get(harinId).mark_json), ['첫 만남']);
			assert.deepEqual(JSON.parse(db.prepare('SELECT action_requirements_json FROM characters WHERE id = ?').get(harinId).action_requirements_json), revisedTemplate.actionRequirements);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'base.energy': '25' }, true);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'abl.conversation': '' }, true);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'talent.pride': '101' }, true);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'relation.resentment': '101' }, true);
			await post('character', { id: harinId, name: '하린', age: '28', profile: '하린은 동네의 작가다.', ...fixedFields, 'palam.tension': '101' }, true);
			assert.deepEqual(JSON.parse(db.prepare('SELECT base_json FROM characters WHERE id = ?').get(harinId).base_json), { energy: 20, maxEnergy: 20 });
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
			await post('edit', { id: harinId, ...fixedFields });
			const liveHarinStats = db.prepare('SELECT base_json, trait_json, talent_json, abl_json, exp_json, mark_json, relation_json, palam_json FROM characters WHERE id = ?').get(harinId);
			assert.deepEqual(JSON.parse(liveHarinStats.base_json), { energy: 17, maxEnergy: 24 });
			assert.deepEqual(JSON.parse(liveHarinStats.talent_json), { pride: 61, openness: 73, libido: 90, modesty: 90, assertiveness: 90, receptiveness: 20, curiosity: 82 });
			assert.deepEqual(JSON.parse(liveHarinStats.abl_json), { conversation: 4, empathy: 3, seduction: 2, intimacy: 8 });
			assert.deepEqual(JSON.parse(liveHarinStats.exp_json), { social: 17, romantic: 3, seduction: 7, intimacy: 1 });
			assert.deepEqual(JSON.parse(liveHarinStats.relation_json).player, { affection: 80, trust: 11, desire: 90, attachment: 12, jealousy: 14, resentment: 55 });
			assert.deepEqual(JSON.parse(liveHarinStats.palam_json), { rapport: 6, comfort: 5, arousal: 3, pleasure: 2, embarrassment: 4, tension: 9, frustration: 1, satisfaction: 8 });
			const suggestedPage = await (await fetch(`${base}/?target=seoyeon`)).text();
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
			assert.equal(JSON.parse(db.prepare('SELECT player_suggestions_json FROM scenario_config').get().player_suggestions_json).options.length, 3);
			assert.ok(suggestedPage.includes('서연에게 책을 추천한다'));
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
			assert.deepEqual(JSON.parse(db.prepare('SELECT talent_json FROM characters WHERE id = ?').get(harinId).talent_json), { pride: 61, openness: 73, libido: 90, modesty: 90, assertiveness: 90, receptiveness: 20, curiosity: 82 });
			assert.ok(modelCalls.filter((call) => call.kind === 'world').length >= 3);
			assert.ok(modelCalls.filter((call) => call.kind === 'character').length >= 3);
			assert.ok(modelCalls.some((call) => call.kind === 'suggest'));
			assert.ok(modelCalls.some((call) => call.kind === 'interpret'));
			for (const call of modelCalls) {
				assert.equal(call.responseFormat?.type, 'json_schema');
				assert.equal(call.responseFormat.json_schema?.strict, true);
				assert.equal(call.responseFormat.json_schema?.schema?.additionalProperties, false);
			}
			assert.deepEqual(new Set(modelCalls.map((call) => call.responseFormat.json_schema.name)),
				new Set(['player_action_suggestions', 'player_action_interpretation', 'world_beat', 'character_turn']));
			const playerActionCharacterCall = modelCalls.find((call) => call.kind === 'character' && call.input.mode === 'player-action');
			assert.equal(playerActionCharacterCall.responseFormat.json_schema.schema.properties.proposal.type, 'null');
			const idleCharacterCall = modelCalls.find((call) => call.kind === 'character' && call.input.mode === 'idle');
			assert.ok(Array.isArray(idleCharacterCall.responseFormat.json_schema.schema.properties.proposal.anyOf));
			assert.equal(modelCalls.find((call) => call.kind === 'world').input.worldSetting, '비가 잦은 망원동');
			assert.equal(modelCalls.find((call) => call.kind === 'character').input.character.name, '서연');
			const characterModule = readFileSync(join(process.cwd(), 'static/modules/example-character.json'), 'utf8');
			const worldModule = readFileSync(join(process.cwd(), 'static/modules/example-world.json'), 'utf8');
			await postModule('underage.json', JSON.stringify({ schemaVersion: 1, id: 'invalid.age', name: 'invalid', version: '1', characters: [{ id: 'a', name: 'a', age: 19, profile: 'profile' }] }), true);
			const invalidTalentModule = JSON.parse(characterModule);
			invalidTalentModule.characters[0].talent.pride = 101;
			await postModule('invalid-talent.json', JSON.stringify(invalidTalentModule), true);
			const invalidRelationModule = JSON.parse(characterModule);
			invalidRelationModule.characters[0].relations.player.resentment = 101;
			await postModule('invalid-relation.json', JSON.stringify(invalidRelationModule), true);
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
			assert.ok(secondPage.includes('>망원동의 세 사람</button>'));
			assert.ok(secondPage.includes('>비밀의 저택</button>'));
			assert.ok(secondPage.includes('0/3 사용 중'));
			await post('load', { slot: '2' }, true);
			await post('character', { name: '도희', age: '30', profile: '저택의 관리인이다.' });
			const doheeId = db.prepare("SELECT id FROM characters WHERE name = '도희'").get().id;
			await post('edit', { id: doheeId, ...fixedFields });
			const simulatorBefore = await (await fetch(`${base}/simulator`)).text();
			assert.ok(!simulatorBefore.includes('name="player.energy"'));
			assert.ok(!simulatorBefore.includes('플레이어 체력'));
			assert.equal(JSON.parse(db.prepare('SELECT talent_json FROM characters WHERE id = ?').get(doheeId).talent_json).openness, 73);
			const modelCallsBeforeSimulation = modelCalls.length;
			await post('conversation', { targetId: doheeId });
			assert.equal(modelCalls.length, modelCallsBeforeSimulation);
			assert.equal(db.prepare('SELECT turn FROM world_state').get().turn, 1);
			assert.equal(JSON.parse(db.prepare('SELECT exp_json FROM characters WHERE id = ?').get(doheeId).exp_json).social, 18);
			assert.ok(JSON.parse(db.prepare('SELECT mark_json FROM characters WHERE id = ?').get(doheeId).mark_json).includes('firstConversation'));
			const simulatedEvent = db.prepare('SELECT action_id, renderer, semantic_json, state_changes_json, narrative FROM events ORDER BY id DESC LIMIT 1').get();
			assert.equal(simulatedEvent.action_id, 'conversation');
			assert.equal(simulatedEvent.renderer, 'template');
			assert.equal(JSON.parse(simulatedEvent.semantic_json).targetId, doheeId);
			assert.ok(!('energy' in JSON.parse(simulatedEvent.semantic_json).effects));
			assert.ok(JSON.parse(simulatedEvent.state_changes_json).every((change) => change.path !== 'player.BASE.energy'));
			assert.ok((await (await fetch(`${base}/simulator`)).text()).includes(simulatedEvent.narrative));
			assert.ok((await (await fetch(base)).text()).includes(simulatedEvent.narrative));
			await post('save', { slot: '1' });
			const savedSession = JSON.parse(db.prepare('SELECT snapshot_json FROM lore_save_slots WHERE lore_id = ? AND slot = 1').get(secondLoreId).snapshot_json);
			assert.ok(!('player' in savedSession));
			assert.ok(!('characterTemplates' in savedSession));
			await post('character', { id: doheeId, name: '도희', age: '30', profile: '저택의 관리인이다.', ...fixedFields,
				'requirements.present': '1',
				'requirement.0.actionId': 'kiss', 'requirement.0.stat': 'relation.trust', 'requirement.0.minimum': '70' });
			await post('conversation', { targetId: doheeId });
			assert.equal(JSON.parse(db.prepare('SELECT exp_json FROM characters WHERE id = ?').get(doheeId).exp_json).social, 19);
			await post('load', { slot: '1' });
			assert.equal(JSON.parse(db.prepare('SELECT exp_json FROM characters WHERE id = ?').get(doheeId).exp_json).social, 18);
			assert.deepEqual(JSON.parse(db.prepare('SELECT action_requirements_json FROM characters WHERE id = ?').get(doheeId).action_requirements_json),
				[{ actionId: 'kiss', stat: 'relation.trust', minimum: 70 }]);
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
			assert.equal(db.prepare('SELECT semantic_json FROM events').get().semantic_json, simulatedEvent.semantic_json);
			const sceneRapport = JSON.parse(db.prepare('SELECT palam_json FROM characters WHERE id = ?').get(doheeId).palam_json).rapport;
			assert.ok(sceneRapport > 0);
			await post('advance');
			assert.equal(JSON.parse(db.prepare('SELECT palam_json FROM characters WHERE id = ?').get(doheeId).palam_json).rapport, 0);
			await post('load', { slot: '1' });
			assert.equal(JSON.parse(db.prepare('SELECT palam_json FROM characters WHERE id = ?').get(doheeId).palam_json).rapport, sceneRapport);
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
			assert.equal(bundle.state.characterTemplates.length, 1);
			assert.ok(bundle.saves.every((save) => !('characterTemplates' in save.state)));
			const loreFile = new FormData();
			loreFile.append('loreFile', new Blob([exported], { type: 'application/json' }), 'lore.json');
			const importResponse = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: loreFile });
			assert.equal(importResponse.status, 200);
			assert.ok(!(await importResponse.text()).includes('"type":"failure"'));
			const importedLoreId = db.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id;
			assert.notEqual(importedLoreId, secondLoreId);
			assert.equal(db.prepare('SELECT count(*) AS n FROM lores').get().n, 3);
			assert.equal(db.prepare('SELECT name FROM characters').get().name, '도희');
			assert.deepEqual(JSON.parse(db.prepare('SELECT character_json FROM character_templates').get().character_json).actionRequirements,
				[{ actionId: 'kiss', stat: 'relation.trust', minimum: 70 }]);
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
			const makeLegacy = (character) => {
				delete character.talent_json;
				if (character.id === harinId) {
					character.abl_json = JSON.stringify({ conversation: 4, empathy: 3, seduction: 2 });
					character.exp_json = JSON.stringify({ conversation: 9, empathy: 8, seduction: 7 });
					character.relation_json = JSON.stringify({ affection: 80, trust: 11, desire: 90 });
					character.palam_json = JSON.stringify({ rapport: 6, trust: 5, arousal: 3, pleasure: 2 });
				}
			};
			for (const character of legacyTalentBundle.state.characters) makeLegacy(character);
			for (const save of legacyTalentBundle.saves) {
				for (const character of save.state.characters) makeLegacy(character);
			}
			const makeLegacyManifest = (module) => {
				if (module.id !== 'example.harin') return;
				const manifest = JSON.parse(module.manifest_json);
				const character = manifest.characters[0];
				character.talent = { pride: 72, openness: 58, empathy: 55, assertiveness: 64 };
				character.abl = { conversation: 2, empathy: 1, seduction: 1 };
				character.exp = { conversation: 4, empathy: 3, seduction: 2 };
				character.relation = { affection: 8, trust: 7, desire: 3 };
				delete character.relations;
				character.palam = { rapport: 1, trust: 2, arousal: 0, pleasure: 0 };
				module.manifest_json = JSON.stringify(manifest);
			};
			legacyTalentBundle.state.modules.forEach(makeLegacyManifest);
			for (const save of legacyTalentBundle.saves) save.state.modules?.forEach(makeLegacyManifest);
			const originalFile = new FormData();
			originalFile.append('loreFile', new Blob([JSON.stringify(legacyTalentBundle)], { type: 'application/json' }), 'original.json');
			const originalImport = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: originalFile });
			assert.equal(originalImport.status, 200);
			assert.ok(!(await originalImport.text()).includes('"type":"failure"'));
			assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, JSON.parse(originalBundle).state.events.length);
			assert.equal(db.prepare('SELECT count(*) AS n FROM modules').get().n, 3);
			assert.deepEqual(JSON.parse(db.prepare('SELECT talent_json FROM characters WHERE id = ?').get(harinId).talent_json), { pride: 50, openness: 50, libido: 50, modesty: 50, assertiveness: 50, receptiveness: 50, curiosity: 50 });
			assert.deepEqual(JSON.parse(db.prepare('SELECT exp_json FROM characters WHERE id = ?').get(harinId).exp_json), { social: 17, romantic: 0, seduction: 7, intimacy: 0 });
			assert.equal(JSON.parse(db.prepare('SELECT relation_json FROM characters WHERE id = ?').get(harinId).relation_json).player.resentment, 0);
			assert.equal(JSON.parse(db.prepare('SELECT palam_json FROM characters WHERE id = ?').get(harinId).palam_json).comfort, 5);
			assert.equal(JSON.parse(db.prepare('SELECT abl_json FROM characters WHERE id = ?').get(harinId).abl_json).intimacy, 1);
			const migratedManifest = JSON.parse(db.prepare("SELECT manifest_json FROM modules WHERE id = 'example.harin'").get().manifest_json);
			assert.equal(migratedManifest.characters[0].exp.social, 7);
			assert.equal(migratedManifest.characters[0].relations.player.trust, 7);
			const importedOriginalId = db.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id;
			assert.equal(db.prepare('SELECT count(*) AS n FROM lore_save_slots WHERE lore_id = ?').get(importedOriginalId).n, 2);
			const migratedSave = JSON.parse(db.prepare('SELECT snapshot_json FROM lore_save_slots WHERE lore_id = ? AND slot = 1').get(importedOriginalId).snapshot_json);
			assert.equal(JSON.parse(migratedSave.characters.find((character) => character.id === harinId).exp_json).social, 17);
			const badBundle = JSON.parse(originalBundle);
			badBundle.state.characters[0].age = 19;
			const invalidFile = new FormData();
			invalidFile.append('loreFile', new Blob([JSON.stringify(badBundle)], { type: 'application/json' }), 'invalid.json');
			const invalidImport = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: invalidFile });
			assert.ok((await invalidImport.text()).includes('"type":"failure"'));
			assert.equal(db.prepare('SELECT count(*) AS n FROM lores').get().n, 3);
			const legacyModule = JSON.parse(characterModule);
			legacyModule.id = 'example.legacy-character';
			legacyModule.characters[0].id = 'legacy';
			legacyModule.characters[0].abl = { conversation: 3, empathy: 2, seduction: 1 };
			legacyModule.characters[0].exp = { conversation: 4, empathy: 3, seduction: 2 };
			legacyModule.characters[0].relation = { affection: 80, trust: 20, desire: 90 };
			delete legacyModule.characters[0].relations;
			legacyModule.characters[0].palam = { rapport: 4, trust: 6, arousal: 2, pleasure: 1 };
			await postModule('legacy-character.json', JSON.stringify(legacyModule));
			const legacyRow = db.prepare("SELECT abl_json, exp_json, relation_json, palam_json FROM characters WHERE id = 'mod:example.legacy-character:legacy'").get();
			assert.equal(JSON.parse(legacyRow.abl_json).intimacy, 1);
			assert.equal(JSON.parse(legacyRow.exp_json).social, 7);
			assert.equal(JSON.parse(legacyRow.relation_json).player.affection, 80);
			assert.equal(JSON.parse(legacyRow.palam_json).comfort, 6);

			const songSoiPreset = readFileSync(join(process.cwd(), 'static/lore-presets/song-soi.json'), 'utf8');
			const songSoiFile = new FormData();
			songSoiFile.append('loreFile', new Blob([songSoiPreset], { type: 'application/json' }), 'song-soi.json');
			const songSoiImport = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: songSoiFile });
			assert.equal(songSoiImport.status, 200);
			assert.ok(!(await songSoiImport.text()).includes('"type":"failure"'));
			assert.equal(db.prepare('SELECT title FROM lores WHERE id = (SELECT active_lore_id FROM lore_meta)').get().title, '송소이와 함께 사는 날들');
			assert.equal(db.prepare('SELECT name FROM characters').get().name, '송소이');
			assert.equal(JSON.parse(db.prepare('SELECT relation_json FROM characters').get().relation_json).player.attachment, 86);

			const genrePresets = [
				['midnight-haeundae-guesthouse.json', '심야의 해운대 게스트하우스', '윤하늘'],
				['ninety-days-before-christmas.json', '크리스마스 전의 90일', '서도현'],
				['blue-moon-anomaly-unit.json', '청연시 이상현상 전담반', '김무진']
			];
			for (const [fileName, title, firstCharacter] of genrePresets) {
				const preset = readFileSync(join(process.cwd(), 'static/lore-presets', fileName), 'utf8');
				const presetFile = new FormData();
				presetFile.append('loreFile', new Blob([preset], { type: 'application/json' }), fileName);
				const presetImport = await fetch(`${base}/lores?/importLore`, { method: 'POST', headers: { Origin: base }, body: presetFile });
				assert.equal(presetImport.status, 200);
				assert.ok(!(await presetImport.text()).includes('"type":"failure"'));
				assert.equal(db.prepare('SELECT title FROM lores WHERE id = (SELECT active_lore_id FROM lore_meta)').get().title, title);
				assert.equal(db.prepare('SELECT name FROM characters ORDER BY sort_order LIMIT 1').get().name, firstCharacter);
				assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 3);
				assert.equal(db.prepare('SELECT count(*) AS n FROM characters WHERE age < 20').get().n, 0);
				assert.ok(JSON.parse(db.prepare('SELECT action_requirements_json FROM characters ORDER BY sort_order LIMIT 1').get().action_requirements_json).length >= 7);
			}
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
		env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', ORIGIN: base, NEWERA_DATA_DIR: legacyDirectory,
			NEWERA_LLM_BASE_URL: 'http://127.0.0.1:1/v1' },
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
			assert.equal(migrated.prepare('SELECT title FROM lores').get().title, '망원동의 세 사람');
			assert.equal(migrated.prepare('SELECT turn FROM world_state').get().turn, 9);
			assert.equal(migrated.prepare('SELECT energy FROM player_state').get().energy, 12);
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM lore_save_slots').get().n, 1);
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM save_slots').get().n, 1);
			const response = await fetch(`${base}/?/load`, { method: 'POST', headers: { Origin: base }, body: new URLSearchParams({ slot: '2' }) });
			assert.equal(response.status, 200);
			assert.ok(!(await response.text()).includes('"type":"failure"'));
			assert.equal(migrated.prepare('SELECT turn FROM world_state').get().turn, 4);
			assert.equal(migrated.prepare('SELECT energy FROM player_state').get().energy, 12);
			assert.equal(migrated.prepare('SELECT count(*) AS n FROM lores').get().n, 1);
			const firstLoreId = migrated.prepare('SELECT active_lore_id FROM lore_meta').get().active_lore_id;
			const exported = await (await fetch(`${base}/lores/export/${firstLoreId}`)).text();
			const exportedLore = JSON.parse(exported);
			assert.ok(!('player' in exportedLore.state));
			assert.ok(exportedLore.saves.every((save) => !('player' in save.state)));
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
