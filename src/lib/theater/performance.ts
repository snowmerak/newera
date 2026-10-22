import type { ActorExpression, StageAction } from './types.ts';
import { checkedMemo, record, text } from './validation.ts';

function exactKeys(source: Record<string, unknown>, keys: string[], label: string): void {
	if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) throw new Error(`${label}: 허용되지 않거나 누락된 항목이 있습니다.`);
}

export const memoUpdateSchema = { anyOf: [
	{ type: 'null' },
	{ type: 'object', additionalProperties: false, properties: {
		summary: { type: 'string', maxLength: 1200 }, currentIntention: { type: 'string', maxLength: 600 },
		feelings: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 } },
		openThreads: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 } }
	}, required: ['summary', 'currentIntention', 'feelings', 'openThreads'] }
] };

export function performanceSchema(actions: StageAction[]): Record<string, unknown> {
	if (!actions.length) throw new Error('실행할 행동이 없습니다.');
	return {
		type: 'object', additionalProperties: false,
		properties: {
			actionId: { type: 'string', enum: actions.map((action) => action.id) },
			targetId: { type: ['string', 'null'], enum: [...new Set(actions.map((action) => action.targetId))] },
			narrative: { type: ['string', 'null'], minLength: 1, maxLength: 2000 },
			utterance: { type: ['string', 'null'], minLength: 1, maxLength: 4000 },
			memoUpdate: memoUpdateSchema
		}, required: ['actionId', 'targetId', 'narrative', 'utterance', 'memoUpdate']
	};
}

/** Validate again on the client: provider-side JSON validation does not authorize an action. */
export function checkedExpression(value: unknown, actions: StageAction[]): ActorExpression {
	const source = record(value, '구조화된 행동');
	exactKeys(source, ['actionId', 'targetId', 'narrative', 'utterance', 'memoUpdate'], '구조화된 행동');
	const action = actions.find((candidate) => candidate.id === source.actionId);
	if (!action) throw new Error('생성 결과에 실행할 수 없는 행동이 포함되었습니다.');
	if (source.targetId !== action.targetId) throw new Error('생성 결과의 대상이 선택한 행동의 대상과 다릅니다.');
	const narrative = source.narrative === null ? null : text(source.narrative, '행동 묘사', 2000);
	const utterance = source.utterance === null ? null : text(source.utterance, '대사', 4000);
	if (utterance && /\[(?:플레이어|사용자|주인공|player)(?:의|의\s*)?\s*(?:이름|name)\]|\{\{?\s*(?:player[_ .]?name|플레이어\s*이름)\s*\}?\}/i.test(utterance)) throw new Error('대사에 미완성 플레이어 이름 자리표시자가 포함되었습니다. 플레이어를 대신해 말할 수 없습니다.');
	if (action.kind === 'speak' && !utterance) throw new Error('말하기 행동에는 대사가 필요합니다.');
	if (action.kind !== 'speak' && utterance !== null) throw new Error('대사는 말하기 행동에서만 실행할 수 있습니다.');
	if (action.kind !== 'speak' && action.kind !== 'wait' && !narrative) throw new Error('선택한 행동의 구체적인 묘사가 필요합니다.');
	return { actionId: action.id, targetId: action.targetId, narrative, utterance, memoUpdate: source.memoUpdate === null ? null : checkedMemo(source.memoUpdate) };
}
