import { initialState } from '../../../src/lib/theater/runtime.ts';
import { record, validateDefinition, validateState } from '../../../src/lib/theater/validation.ts';

export function validateSource(value) {
	const source = record(value, '작성 원본');
	if (source.format !== 'newera-theater-source' || source.version !== 2) throw new Error('작성 원본은 newera-theater-source version 2여야 합니다.');
	return validateDefinition(source.definition);
}

export function buildBundle(value) {
	const definition = validateSource(value);
	return { format: 'newera-theater', version: 2, world: { definition, state: initialState(definition) }, saves: [] };
}

export function validateBundle(value) {
	const bundle = record(value, '세계관 파일');
	if (bundle.format !== 'newera-theater' || bundle.version !== 2) throw new Error('지원하지 않는 세계관 파일입니다.');
	const world = record(bundle.world, 'world');
	const definition = validateDefinition(world.definition);
	const state = world.state === undefined ? initialState(definition) : validateState(world.state, definition);
	if (!Array.isArray(bundle.saves) || bundle.saves.length > 3) throw new Error('저장 슬롯은 최대 3개입니다.');
	const slots = new Set();
	for (const value of bundle.saves) {
		const save = record(value, '슬롯');
		if (!Number.isInteger(save.slot) || save.slot < 1 || save.slot > 3 || slots.has(save.slot) || typeof save.savedAt !== 'string') throw new Error('저장 슬롯 정보가 올바르지 않습니다.');
		slots.add(save.slot);
		const saved = record(save.world, '슬롯 세계관');
		validateState(saved.state, validateDefinition(saved.definition));
	}
	return { title: definition.name, sceneCount: definition.scenes.length, instanceCount: state.instances.length, tick: state.tick };
}
