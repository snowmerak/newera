import { ACTION_REQUIREMENT_ACTIONS, ACTION_REQUIREMENT_STATS, DEFAULT_ABL, DEFAULT_ACTION_REQUIREMENTS, DEFAULT_EXP, DEFAULT_PALAM, DEFAULT_RELATION, DEFAULT_TALENT, actionRequirementMaximum, normalizeExp, normalizeMarks, normalizePalam, type ActionRequirement, type ActionRequirementStat, type Character, type RelationStats, type RequirementActionId } from '$lib/game/types';

export interface ModuleManifest {
	schemaVersion: 1;
	id: string;
	name: string;
	version: string;
	description: string;
	world?: { setting: string; eraRules?: string };
	characters: Character[];
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}은 JSON 객체여야 합니다.`);
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, required = true): string {
	if (value === undefined && !required) return '';
	if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
		throw new Error(`${label} 값을 확인해 주세요 (최대 ${maximum}자).`);
	}
	return value.trim();
}

function numbers<T extends Record<string, number>>(value: unknown, label: string, defaults: T, maximum?: number): T {
	const supplied = value === undefined ? {} : object(value, label);
	const result: Record<string, number> = { ...defaults };
	for (const key of Object.keys(defaults)) {
		if (supplied[key] === undefined) continue;
		const number = supplied[key];
		if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || (maximum !== undefined && number > maximum)) {
			throw new Error(`${label}.${key}는 0${maximum === undefined ? ' 이상의' : `~${maximum} 사이의`} 정수여야 합니다.`);
		}
		result[key] = number;
	}
	return result as T;
}

function strings(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 30 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 100)) {
		throw new Error(`${label}는 100자 이하의 문자열 배열이어야 합니다.`);
	}
	return value.map((item: string) => item.trim());
}

function actionRequirements(value: unknown, label: string): ActionRequirement[] {
	if (value === undefined) return DEFAULT_ACTION_REQUIREMENTS.map((requirement) => ({ ...requirement }));
	if (!Array.isArray(value) || value.length > 50) throw new Error(`${label}는 최대 50개의 배열이어야 합니다.`);
	const actions = new Set<string>(ACTION_REQUIREMENT_ACTIONS);
	const stats = new Set<string>(ACTION_REQUIREMENT_STATS);
	const seen = new Set<string>();
	return value.map((item, index) => {
		const source = object(item, `${label}[${index}]`);
		if (!actions.has(String(source.actionId)) || !stats.has(String(source.stat)) ||
			typeof source.minimum !== 'number' || !Number.isSafeInteger(source.minimum) || source.minimum < 0) {
			throw new Error(`${label}[${index}] 값을 확인해 주세요.`);
		}
		const stat = source.stat as ActionRequirementStat;
		const maximum = actionRequirementMaximum(stat);
		if (maximum !== undefined && source.minimum > maximum) throw new Error(`${label}[${index}].minimum은 0~${maximum}이어야 합니다.`);
		const key = `${source.actionId}:${stat}`;
		if (seen.has(key)) throw new Error(`${label}에 같은 행동과 수치가 중복되었습니다.`);
		seen.add(key);
		return { actionId: source.actionId as RequirementActionId, stat, minimum: source.minimum };
	});
}

export function parseModuleManifest(raw: string): ModuleManifest {
	if (Buffer.byteLength(raw, 'utf8') > 2_000_000) throw new Error('모듈 파일은 2MB 이하여야 합니다.');
	let decoded: unknown;
	try { decoded = JSON.parse(raw); } catch { throw new Error('모듈 JSON 형식을 확인해 주세요.'); }
	const input = object(decoded, '모듈');
	if (input.schemaVersion !== 1) throw new Error('지원하지 않는 모듈 버전입니다. schemaVersion은 1이어야 합니다.');
	const id = text(input.id, '모듈 ID', 80);
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('모듈 ID는 영문 소문자, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.');
	const name = text(input.name, '모듈 이름', 100);
	const version = text(input.version, '모듈 버전', 40);
	const description = text(input.description, '모듈 설명', 500, false);
	let world: ModuleManifest['world'];
	if (input.world !== undefined) {
		const source = object(input.world, 'world');
		world = { setting: text(source.setting, 'world.setting', 20_000) };
		const eraRules = text(source.eraRules, 'world.eraRules', 10_000, false);
		if (eraRules) world.eraRules = eraRules;
	}
	const roster = input.characters === undefined ? [] : input.characters;
	if (!Array.isArray(roster) || roster.length > 50) throw new Error('characters는 최대 50명의 배열이어야 합니다.');
	const localIds = new Set<string>();
	const characters = roster.map((value, index): Character => {
		const source = object(value, `characters[${index}]`);
		const localId = text(source.id, `characters[${index}].id`, 60);
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(localId) || localIds.has(localId)) {
			throw new Error('인물 ID가 중복됐거나 사용할 수 없는 형식입니다.');
		}
		localIds.add(localId);
		const age = source.age;
		if (typeof age !== 'number' || !Number.isSafeInteger(age) || age < 20 || age > 120) {
			throw new Error('모듈 등장인물은 20세 이상의 성인이어야 합니다.');
		}
		const profile = text(source.profile, `characters[${index}].profile`, 20_000);
		const base = numbers(source.base, 'BASE', { energy: 20, maxEnergy: 20 }) as Character['base'];
		if (base.maxEnergy < 1 || base.energy > base.maxEnergy) throw new Error('BASE 체력 값을 확인해 주세요.');
		const talent = numbers(source.talent, 'TALENT', { ...DEFAULT_TALENT }, 100);
		const expInput = source.exp === undefined ? {} : object(source.exp, 'EXP');
		const exp = 'social' in expInput || 'romantic' in expInput || 'intimacy' in expInput
			? numbers(source.exp, 'EXP', { ...DEFAULT_EXP })
			: normalizeExp(numbers(source.exp, 'EXP', { conversation: 0, empathy: 0, seduction: 0 }));
		const palamInput = source.palam === undefined ? {} : object(source.palam, 'PALAM');
		const palam = 'comfort' in palamInput
			? numbers(source.palam, 'PALAM', { ...DEFAULT_PALAM }, 100)
			: normalizePalam(numbers(source.palam, 'PALAM', { rapport: 0, trust: 0, arousal: 0, pleasure: 0 }, 100));
		const relations: Record<string, RelationStats> = {};
		if (source.relations !== undefined) {
			for (const [targetId, value] of Object.entries(object(source.relations, 'RELATION'))) {
				if (!/^[a-z0-9][a-z0-9._:-]*$/.test(targetId)) throw new Error('RELATION 대상 ID를 확인해 주세요.');
				relations[targetId] = numbers(value, `RELATION.${targetId}`, { ...DEFAULT_RELATION }, 100);
			}
		}
		relations.player ??= numbers(source.relation, 'RELATION.player', { ...DEFAULT_RELATION }, 100);
		return {
			id: `mod:${id}:${localId}`, moduleId: id,
			name: text(source.name, `characters[${index}].name`, 100), age,
			portrait: '',
			introduction: text(source.introduction, `characters[${index}].introduction`, 500, false) || profile.split('\n')[0],
			profile, base, talent,
			trait: strings(source.trait, 'TRAIT'),
			abl: numbers(source.abl, 'ABL', { ...DEFAULT_ABL }),
			exp,
			mark: normalizeMarks(strings(source.mark, 'MARK')),
			relations,
			palam,
			actionRequirements: actionRequirements(source.actionRequirements, `characters[${index}].actionRequirements`)
		};
	});
	if (!world && characters.length === 0) throw new Error('세계관이나 등장인물을 하나 이상 넣어 주세요.');
	return { schemaVersion: 1, id, name, version, description, world, characters };
}
