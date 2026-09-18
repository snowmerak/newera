import { clampBase, clampCount, clampPercent, relationTo, type ActionId, type BaseStats, type Character, type Source } from './types.ts';

export const PLAYER_AGE = 25;

type ActionDefinition = {
	title: string;
	detail: string;
	category: 'adult' | 'social' | 'rest';
	duration: number;
	energyCost: number;
	needsTarget: boolean;
};

export const ACTIONS: Record<ActionId, ActionDefinition> = {
	flirt: {
		title: '호감을 드러낸다',
		detail: '상대의 반응을 살피며 유혹한다.',
		category: 'adult',
		duration: 20,
		energyCost: 3,
		needsTarget: true
	},
	kiss: {
		title: '입맞춤을 제안한다',
		detail: '서로 원할 때 한 걸음 더 가까워진다.',
		category: 'adult',
		duration: 15,
		energyCost: 3,
		needsTarget: true
	},
	intimacy: {
		title: '함께 밤을 보내자고 제안한다',
		detail: '서로 동의한 성인 관계로 이어진다.',
		category: 'adult',
		duration: 90,
		energyCost: 7,
		needsTarget: true
	},
	talk: {
		title: '오늘 하루에 대해 이야기한다',
		detail: '대화를 나누며 서로를 조금 더 알아간다.',
		category: 'social',
		duration: 20,
		energyCost: 3,
		needsTarget: true
	},
	listen: {
		title: '상대의 이야기를 듣는다',
		detail: '서두르지 않고 상대의 말을 듣는다.',
		category: 'social',
		duration: 25,
		energyCost: 2,
		needsTarget: true
	},
	rest: {
		title: '잠시 쉰다',
		detail: '호흡을 고르고 체력을 회복한다.',
		category: 'rest',
		duration: 45,
		energyCost: 0,
		needsTarget: false
	}
};

export function actionReason(
	actionId: ActionId,
	player: BaseStats,
	character: Character | null
): string | null {
	const action = ACTIONS[actionId];
	if (player.energy < action.energyCost) return '체력이 부족합니다';
	if (!action.needsTarget) return null;
	if (!character) return '상대를 선택해 주세요';
	if (action.category === 'adult' && (PLAYER_AGE < 20 || character.age < 20)) {
		return '성인 인물에게만 가능한 행동입니다';
	}
	const relation = relationTo(character);
	if (actionId === 'flirt' && relation.trust < 2) return '신뢰 2 필요';
	if (
		actionId === 'kiss' &&
		(relation.affection < 5 || relation.trust < 4 || relation.desire < 3)
	) return '호감 5 · 신뢰 4 · 욕망 3 필요';
	if (actionId === 'intimacy') {
		if (!character.mark.includes('firstKiss') && !character.mark.includes('서로 원한 입맞춤')) return '먼저 입맞춤이 필요합니다';
		if (
			relation.affection < 8 ||
			relation.trust < 7 ||
			relation.desire < 9
		) return '호감 8 · 신뢰 7 · 욕망 9 필요';
	}
	return null;
}

export function canPerform(actionId: ActionId, player: BaseStats, character: Character | null): boolean {
	return actionReason(actionId, player, character) === null;
}

export function calculateSource(actionId: ActionId, character: Character | null): Source {
	if (actionId === 'rest') return { energy: 12, recovery: 12 };
	if (!character) throw new Error('상대를 선택해 주세요.');
	const relation = relationTo(character);
	const energy = -ACTIONS[actionId].energyCost;
	switch (actionId) {
		case 'talk':
			return {
				energy,
				rapport: Math.max(-2, 2 + character.abl.conversation + Math.floor(character.talent.openness / 30)
					+ Math.floor(relation.affection / 25) + Math.floor(character.palam.comfort / 25)
					- Math.floor(character.palam.tension / 25) - (character.talent.pride >= 75 && relation.trust < 25 ? 2 : 0)),
				comfort: 1 + Math.floor(character.abl.empathy / 2), trust: 1
			};
		case 'listen':
			return {
				energy,
				rapport: 1 + Math.floor(character.talent.receptiveness / 50),
				comfort: 2 + character.abl.empathy, trust: 2
			};
		case 'flirt':
			return { energy, rapport: 1, desire: 3 + character.abl.seduction, arousal: 2 };
		case 'kiss':
			return { energy, rapport: 2, trust: 1, desire: 4, arousal: 4, pleasure: 2 };
		case 'intimacy':
			return { energy, rapport: 3, trust: 2, desire: 6, arousal: 6, pleasure: 8 };
	}
}

export function applyEffects(
	actionId: ActionId,
	player: BaseStats,
	character: Character | null,
	source: Source
): { player: BaseStats; character: Character | null; changes: Record<string, number> } {
	if (actionId === 'rest') {
		const updatedPlayer = clampBase({ ...player, energy: player.energy + (source.energy ?? source.recovery ?? 0) });
		return {
			player: updatedPlayer,
			character,
			changes: { energy: updatedPlayer.energy - player.energy }
		};
	}
	if (!character) throw new Error('상대를 선택해 주세요.');
	const expKey = actionId === 'talk' || actionId === 'listen' ? 'social'
		: actionId === 'flirt' ? 'seduction' : actionId === 'kiss' ? 'romantic' : 'intimacy';
	const expGain = actionId === 'intimacy' ? 8 : actionId === 'kiss' ? 5 : 3;
	const nextExp = clampCount(character.exp[expKey] + expGain);
	const affectionGain = (source.rapport ?? 0) > 0 ? Math.max(1, Math.floor(source.rapport! / 2)) : 0;
	const trustGain = source.trust ? Math.max(1, Math.floor(source.trust / 2)) : 0;
	const desireGain = source.desire ? Math.max(1, Math.ceil(source.desire / 2)) : 0;
	const relation = relationTo(character);
	const nextMark = [...character.mark];
	if (actionId === 'kiss' && !nextMark.includes('firstKiss')) nextMark.push('firstKiss');
	if (actionId === 'intimacy' && !nextMark.includes('firstIntimacy')) nextMark.push('firstIntimacy');
	if (relation.trust + trustGain >= 10 && !nextMark.includes('서로에게 익숙해짐')) {
		nextMark.push('서로에게 익숙해짐');
	}
	return {
		player: clampBase({ ...player, energy: player.energy + (source.energy ?? 0) }),
		character: {
			...character,
			exp: { ...character.exp, [expKey]: nextExp },
			relations: { ...character.relations, player: {
				...relation,
				affection: clampPercent(relation.affection + affectionGain),
				trust: clampPercent(relation.trust + trustGain),
				desire: clampPercent(relation.desire + desireGain)
			} },
			palam: {
				...character.palam,
				rapport: clampPercent(character.palam.rapport + (source.rapport ?? 0)),
				comfort: clampPercent(character.palam.comfort + (source.comfort ?? 0)),
				arousal: clampPercent(character.palam.arousal + (source.arousal ?? 0)),
				pleasure: clampPercent(character.palam.pleasure + (source.pleasure ?? 0))
			},
			mark: nextMark
		},
		changes: {
			energy: clampBase({ ...player, energy: player.energy + (source.energy ?? 0) }).energy - player.energy,
			...(source.rapport ? { rapport: source.rapport } : {}),
			...(source.trust ? { trust: source.trust } : {}),
			...(source.desire ? { desire: source.desire } : {}),
			...(source.arousal ? { arousal: source.arousal } : {}),
			...(source.pleasure ? { pleasure: source.pleasure } : {}),
			[`${expKey}Exp`]: expGain
		}
	};
}

export function eventSummary(actionId: ActionId, character: Character | null): string {
	if (actionId === 'rest') return '플레이어가 잠시 쉬며 체력을 회복했다.';
	if (!character) throw new Error('상대를 선택해 주세요.');
	switch (actionId) {
		case 'talk': return `플레이어가 ${character.name}과 오늘 하루에 대해 이야기했다.`;
		case 'listen': return `플레이어가 ${character.name}의 이야기를 차분히 들었다.`;
		case 'flirt': return `플레이어가 ${character.name}에게 호감을 드러냈고, ${character.name}이 그 마음을 받아들였다.`;
		case 'kiss': return `${character.name}이 입맞춤 제안을 받아들였고 두 사람이 입맞췄다.`;
		case 'intimacy': return `${character.name}과 플레이어가 서로 동의해 성인 관계를 가졌다.`;
	}
}

export function templateNarrative(actionId: ActionId, character: Character | null): string {
	if (actionId === 'rest') {
		return '창밖의 불빛이 하나둘 켜지는 동안 잠시 눈을 감았다. 방 안은 조용했고, 숨을 고르자 조금은 가벼워졌다.';
	}
	if (!character) throw new Error('상대를 선택해 주세요.');
	switch (actionId) {
		case 'talk': return `오늘 있었던 일을 꺼내자 ${character.name}이 고개를 돌렸다. 짧은 말들이 오가는 사이, 서로의 하루가 조금 더 또렷해졌다.`;
		case 'listen': return `${character.name}은 잠시 말을 고르더니 자신의 이야기를 이어 갔다. 당신은 끼어들지 않고 끝까지 들었다.`;
		case 'flirt': return `당신이 마음을 내비치자 ${character.name}이 잠시 시선을 맞춘다. 웃음이 번지고 두 사람 사이의 공기가 조금 달라진다.`;
		case 'kiss': return `${character.name}이 당신의 제안에 고개를 끄덕인다. 두 사람은 가까이 다가가 서로 원하는 입맞춤을 나눈다.`;
		case 'intimacy': return `${character.name}과 당신은 서로의 뜻을 확인한 뒤 함께 밤을 보낸다. 오래 남을 친밀한 순간이었다.`;
	}
}
