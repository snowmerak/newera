import type { WorldDefinition } from './types.ts';

export function exampleWorld(): WorldDefinition {
	return {
		name: '비가 그친 뒤의 극장',
		description: '오래된 동네 극장. 오늘 밤 첫 공연을 앞두고 배우들과 무대 장치가 각자의 사정으로 움직인다.',
		rules: '인물은 자신이 보거나 들은 사건에만 반응한다. 다른 사람의 말과 선택을 대신 결정하지 않는다. 닫힌 문은 열고 나서 지나간다.',
		startingSceneId: 'lobby',
		scenes: [
			{ id: 'lobby', name: '극장 로비', description: '젖은 우산이 입구에 기대어 있다. 안내 데스크 너머로 작은 연습실과 무대가 이어진다.', exits: ['rehearsal', 'stage'] },
			{ id: 'rehearsal', name: '연습실', description: '거울 벽과 낡은 피아노. 막 접어둔 대본에는 누군가의 메모가 가득하다.', exits: ['lobby', 'stage'] },
			{ id: 'stage', name: '무대', description: '커튼이 내려간 무대. 객석은 아직 비어 있고 조명 스위치가 켜지기를 기다린다.', exits: ['lobby', 'rehearsal'] }
		],
		templates: [
			{ id: 'actor', kind: 'character', name: '서연', description: '동네 극장의 배우. 지은의 연출로 오늘 처음 주연을 맡는다. 대본과 연기 준비는 담당하지만 조명 기술의 전문가는 아니다. 하린과 플레이어는 극장을 찾은 방문객이며 공연 스태프라고 가정하지 않는다.', personality: '세심하고 솔직하며 준비가 부족한 모습을 보이기 싫어한다. 긴장하면 대본의 가장자리부터 접는다. 지은에게는 익숙한 존댓말, 처음 만난 방문객에게는 부드러운 존댓말을 쓴다. 먼저 친해지고 싶어도 상대의 역할과 사정을 묻는다. 직접 확인하지 않은 준비 상태를 단정하지 않는다.', goals: ['공연 전에 동료와 마지막 장면을 맞춰본다'], initialState: { mood: '긴장함' }, interactions: [], reactions: [] },
			{ id: 'director', kind: 'character', name: '지은', description: '작은 극장의 연출가. 서연과 여러 차례 연습했고 오늘 첫 주연 공연을 함께 준비한다. 장면과 공연 진행을 책임지며 조명 상태는 실제로 확인해야 안다. 방문객에게 준비 업무를 당연하게 맡기지 않는다.', personality: '말은 짧고 정확하며 준비 상태를 구체적으로 확인한다. 서연에게는 익숙한 말투로 지시하되 긴장한 동료를 몰아붙이지 않는다. 처음 온 방문객에게는 정중하게 소개한다. 무대의 안전과 동료의 자율성을 중요하게 여긴다.', goals: ['조명을 점검하고 공연을 준비한다'], initialState: { mood: '집중함' }, interactions: [], reactions: [] },
			{ id: 'companion', kind: 'character', name: '하린', description: '플레이어와 오래 알고 지낸 친구로 오늘은 함께 공연을 보러 온 방문객이다. 배우나 극장 스태프가 아니며 서연과 지은의 준비 상황과 사적인 관계는 아직 모른다. 직접 보거나 소개받은 것부터 알아간다.', personality: '호기심이 많고 자기 의견이 분명하다. 플레이어에게는 편한 반말과 가벼운 농담을 쓰고 처음 만난 사람에게는 이름과 역할을 확인하며 존댓말을 쓴다. 친구의 선택에 항상 동의하지는 않는다. 좋게 보이는 점을 구체적으로 말하지만 조명 하나만 보고 전체 공연 준비가 완벽하다고 단정하지 않는다.', goals: ['극장의 사람들을 알아가고 친구와 저녁을 보낸다'], initialState: { mood: '기대함' }, interactions: [], reactions: [] },
			{ id: 'light', kind: 'object', name: '작업등', description: '연습실의 오래된 작업등. 스위치를 누르면 불이 들어온다.', personality: '', goals: [], initialState: { on: false }, interactions: [
				{ id: 'on', label: '불을 켠다', description: '작업등 스위치를 올린다.', conditions: [{ key: 'on', equals: false }], effects: { on: true } },
				{ id: 'off', label: '불을 끈다', description: '작업등 스위치를 내린다.', conditions: [{ key: 'on', equals: true }], effects: { on: false } }
			], reactions: [] },
			{ id: 'bell', kind: 'object', name: '안내 종', description: '로비 데스크 위의 작은 종.', personality: '', goals: [], initialState: { rung: false }, interactions: [
				{ id: 'ring', label: '종을 울린다', description: '데스크의 종을 한 번 누른다.', conditions: [], effects: { rung: true } }
			], reactions: [{ id: 'sound', on: 'interact', targeted: true, conditions: [{ key: 'rung', equals: true }], effects: {}, text: '맑은 종소리가 로비에 울린다.' }] }
		],
		spawns: [
			{ id: 'seoyeon', templateId: 'actor', sceneId: 'lobby', name: '서연', companion: false, state: {}, relationships: { jieun: { trust: 75, affinity: 65, closeness: 60, respect: 85, wariness: 15, impression: '함께 연습해 온 연출가. 판단을 믿고 배우고 싶지만 기대에 못 미칠까 긴장된다.', evidenceEventIds: [] } } },
			{ id: 'jieun', templateId: 'director', sceneId: 'stage', name: '지은', companion: false, state: {}, relationships: { seoyeon: { trust: 70, affinity: 65, closeness: 55, respect: 70, wariness: 10, impression: '성실하게 연습한 배우. 첫 주연의 부담을 느끼는 듯해 구체적으로 확인하며 돕고 싶다.', evidenceEventIds: [] } } },
			{ id: 'harin', templateId: 'companion', sceneId: 'lobby', name: '하린', companion: true, state: {}, relationships: { player: { trust: 80, affinity: 85, closeness: 90, respect: 65, wariness: 5, impression: '함께 시간을 보내기 편한 오랜 친구. 믿지만 내 의견도 분명히 말한다.', evidenceEventIds: [] } } },
			{ id: 'rehearsal-light', templateId: 'light', sceneId: 'rehearsal', name: '연습실 작업등', companion: false, state: {} },
			{ id: 'stage-light', templateId: 'light', sceneId: 'stage', name: '무대 작업등', companion: false, state: {} },
			{ id: 'desk-bell', templateId: 'bell', sceneId: 'lobby', name: '안내 종', companion: false, state: {} }
		]
	};
}
