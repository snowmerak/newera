import { STANDARD_MARKS, type CharacterStatsInput } from '$lib/game/types';

const EDITABLE_MARKS = ['firstConversation', 'becameFriend', ...STANDARD_MARKS];

export function characterMarks(body: FormData): string[] | undefined {
	if (!body.has('mark.present')) return undefined;
	const selected = EDITABLE_MARKS.filter((mark) => body.has(`mark.${mark}`));
	const raw = String(body.get('mark.custom') ?? '');
	const custom = raw.split(/[\n,]/).map((mark) => mark.trim()).filter(Boolean);
	if (custom.some((mark) => mark.length > 100) || selected.length + custom.length > 30) {
		throw new Error('MARK는 최대 30개, 각 100자 이하여야 합니다.');
	}
	return [...new Set([...selected, ...custom])];
}

export function nonnegativeInteger(body: FormData, key: string): number {
	const raw = body.get(key);
	if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
		throw new Error(`${key}는 0 이상의 정수여야 합니다.`);
	}
	return Number(raw);
}

export function characterStats(body: FormData): CharacterStatsInput | undefined {
	// Older callers can still create a character with the default stats.
	if (![...body.keys()].some((key) => /^(base|talent|abl|exp|relation|palam)\./.test(key))) return undefined;
	const number = (key: string) => nonnegativeInteger(body, key);
	const percent = (key: string) => {
		const value = number(key);
		if (value > 100) throw new Error(`${key}는 0~100으로 입력해 주세요.`);
		return value;
	};
	const talent = [...body.keys()].some((key) => key.startsWith('talent.')) ? {
		pride: percent('talent.pride'), openness: percent('talent.openness'),
		libido: percent('talent.libido'), modesty: percent('talent.modesty'),
		assertiveness: percent('talent.assertiveness'), receptiveness: percent('talent.receptiveness'),
		curiosity: percent('talent.curiosity')
	} : undefined;
	const base = { energy: number('base.energy'), maxEnergy: number('base.maxEnergy') };
	if (base.maxEnergy < 1 || base.energy > base.maxEnergy) throw new Error('BASE 체력 값을 확인해 주세요.');
	return {
		base,
		...(talent ? { talent } : {}),
		abl: { conversation: number('abl.conversation'), empathy: number('abl.empathy'), seduction: number('abl.seduction'), intimacy: number('abl.intimacy') },
		exp: { social: number('exp.social'), romantic: number('exp.romantic'), seduction: number('exp.seduction'), intimacy: number('exp.intimacy') },
		relation: { affection: percent('relation.affection'), trust: percent('relation.trust'), desire: percent('relation.desire'),
			attachment: percent('relation.attachment'), jealousy: percent('relation.jealousy'), resentment: percent('relation.resentment') },
		palam: { rapport: percent('palam.rapport'), comfort: percent('palam.comfort'), arousal: percent('palam.arousal'),
			pleasure: percent('palam.pleasure'), embarrassment: percent('palam.embarrassment'), tension: percent('palam.tension'),
			frustration: percent('palam.frustration'), satisfaction: percent('palam.satisfaction') }
	};
}
