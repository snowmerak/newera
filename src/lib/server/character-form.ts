import type { Character } from '$lib/game/types';

export function nonnegativeInteger(body: FormData, key: string): number {
	const raw = body.get(key);
	if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
		throw new Error(`${key}는 0 이상의 정수여야 합니다.`);
	}
	return Number(raw);
}

export function characterStats(body: FormData): (Pick<Character, 'base' | 'abl' | 'exp' | 'relation' | 'palam'> & Partial<Pick<Character, 'talent'>>) | undefined {
	// Older callers can still create a character with the default stats.
	if (![...body.keys()].some((key) => /^(base|talent|abl|exp|relation|palam)\./.test(key))) return undefined;
	const number = (key: string) => nonnegativeInteger(body, key);
	const talent = [...body.keys()].some((key) => key.startsWith('talent.')) ? {
		pride: number('talent.pride'), openness: number('talent.openness'),
		empathy: number('talent.empathy'), assertiveness: number('talent.assertiveness')
	} : undefined;
	if (talent && Object.values(talent).some((value) => value > 100)) throw new Error('TALENT는 0~100으로 입력해 주세요.');
	return {
		base: { energy: number('base.energy'), maxEnergy: number('base.maxEnergy') },
		...(talent ? { talent } : {}),
		abl: { conversation: number('abl.conversation'), empathy: number('abl.empathy'), seduction: number('abl.seduction') },
		exp: { conversation: number('exp.conversation'), empathy: number('exp.empathy'), seduction: number('exp.seduction') },
		relation: { affection: number('relation.affection'), trust: number('relation.trust'), desire: number('relation.desire') },
		palam: { rapport: number('palam.rapport'), trust: number('palam.trust'), arousal: number('palam.arousal'), pleasure: number('palam.pleasure') }
	};
}
