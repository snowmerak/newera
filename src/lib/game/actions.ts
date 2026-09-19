import { ACTION_REQUIREMENT_LABELS, clampCount, clampPercent, relationTo, type ActionId, type ActionRequirementStat, type Character, type Source } from './types.ts';

type ActionDefinition = {
	title: string;
	detail: string;
	category: 'adult' | 'social' | 'rest';
	duration: number;
	needsTarget: boolean;
};

export const ACTIONS: Record<ActionId, ActionDefinition> = {
	flirt: {
		title: '호감을 드러낸다',
		detail: '상대의 반응을 살피며 유혹한다.',
		category: 'adult',
		duration: 20,
		needsTarget: true
	},
	kiss: {
		title: '입맞춤을 제안한다',
		detail: '서로 원할 때 한 걸음 더 가까워진다.',
		category: 'adult',
		duration: 15,
		needsTarget: true
	},
	intimacy: {
		title: '함께 밤을 보내자고 제안한다',
		detail: '서로 동의한 성인 관계로 이어진다.',
		category: 'adult',
		duration: 90,
		needsTarget: true
	},
	talk: {
		title: '오늘 하루에 대해 이야기한다',
		detail: '대화를 나누며 서로를 조금 더 알아간다.',
		category: 'social',
		duration: 20,
		needsTarget: true
	},
	listen: {
		title: '상대의 이야기를 듣는다',
		detail: '서두르지 않고 상대의 말을 듣는다.',
		category: 'social',
		duration: 25,
		needsTarget: true
	},
	rest: {
		title: '잠시 쉰다',
		detail: '잠시 쉬며 시간을 보낸다.',
		category: 'rest',
		duration: 45,
		needsTarget: false
	}
};

export function actionReason(
	actionId: ActionId,
	character: Character | null
): string | null {
	const action = ACTIONS[actionId];
	if (!action.needsTarget) return null;
	if (!character) return '상대를 선택해 주세요';
	const unmet = character.actionRequirements
		.filter((requirement) => requirement.actionId === actionId && requirementValue(character, requirement.stat) < requirement.minimum)
		.map((requirement) => `${ACTION_REQUIREMENT_LABELS[requirement.stat]} ${requirement.minimum}`);
	if (unmet.length) return `${unmet.join(' · ')} 필요`;
	return null;
}

function requirementValue(character: Character, stat: ActionRequirementStat): number {
	const [group, key] = stat.split('.') as [string, string];
	if (group === 'base') return character.base[key as keyof Character['base']];
	if (group === 'talent') return character.talent[key as keyof Character['talent']];
	if (group === 'abl') return character.abl[key as keyof Character['abl']];
	if (group === 'exp') return character.exp[key as keyof Character['exp']];
	if (group === 'relation') return relationTo(character)[key as keyof ReturnType<typeof relationTo>];
	return character.palam[key as keyof Character['palam']];
}

export function canPerform(actionId: ActionId, character: Character | null): boolean {
	return actionReason(actionId, character) === null;
}

export function calculateSource(actionId: ActionId, character: Character | null): Source {
	if (actionId === 'rest') return {};
	if (!character) throw new Error('상대를 선택해 주세요.');
	const relation = relationTo(character);
	switch (actionId) {
		case 'talk':
			return {
				rapport: Math.max(-2, 2 + character.abl.conversation + Math.floor(character.talent.openness / 30)
					+ Math.floor(relation.affection / 25) + Math.floor(character.palam.comfort / 25)
					- Math.floor(character.palam.tension / 25) - (character.talent.pride >= 75 && relation.trust < 25 ? 2 : 0)),
				comfort: 1 + Math.floor(character.abl.empathy / 2), trust: 1
			};
		case 'listen':
			return {
				rapport: 1 + Math.floor(character.talent.receptiveness / 50),
				comfort: 2 + character.abl.empathy, trust: 2
			};
		case 'flirt':
			return { rapport: 1, desire: 3 + character.abl.seduction, arousal: 2 };
		case 'kiss':
			return { rapport: 2, trust: 1, desire: 4, arousal: 4, pleasure: 2 };
		case 'intimacy':
			return { rapport: 3, trust: 2, desire: 6, arousal: 6, pleasure: 8 };
	}
}

const PALAM_SOURCE_KEYS = ['rapport', 'comfort', 'arousal', 'pleasure', 'embarrassment', 'tension', 'frustration', 'satisfaction'] as const;

export function applyPalamSource(
	character: Character,
	source: Source
): { character: Character; changes: Record<string, number> } {
	const palam = { ...character.palam };
	const changes: Record<string, number> = {};
	for (const key of PALAM_SOURCE_KEYS) {
		const requested = source[key] ?? 0;
		if (!requested) continue;
		const before = palam[key];
		const after = clampPercent(before + requested);
		palam[key] = after;
		if (after !== before) changes[key] = after - before;
	}
	return { character: { ...character, palam }, changes };
}

export function applyEffects(
	actionId: ActionId,
	character: Character | null,
	source: Source
): { character: Character | null; changes: Record<string, number> } {
	if (actionId === 'rest') {
		return { character, changes: {} };
	}
	if (!character) throw new Error('상대를 선택해 주세요.');
	const currentReaction = applyPalamSource(character, source);
	character = currentReaction.character;
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
		character: {
			...character,
			exp: { ...character.exp, [expKey]: nextExp },
			relations: { ...character.relations, player: {
				...relation,
				affection: clampPercent(relation.affection + affectionGain),
				trust: clampPercent(relation.trust + trustGain),
				desire: clampPercent(relation.desire + desireGain)
			} },
			mark: nextMark
		},
		changes: {
			...currentReaction.changes,
			...(source.trust ? { trust: source.trust } : {}),
			...(source.desire ? { desire: source.desire } : {}),
			[`${expKey}Exp`]: expGain
		}
	};
}

export function eventSummary(actionId: ActionId, character: Character | null): string {
	if (actionId === 'rest') return '플레이어가 잠시 쉬며 시간을 보냈다.';
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
