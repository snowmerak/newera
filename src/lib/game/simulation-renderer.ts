import type { SemanticEvent } from './simulation';

export function renderSemanticEvent(event: SemanticEvent): string {
	if (event.type === 'conversation') {
		switch (event.outcome) {
			case 'positive': return '대화가 제법 잘 통했다.';
			case 'neutral': return '잠시 이야기를 나누었다.';
			case 'negative': return '대화는 어색하게 끝났다.';
		}
	}
	throw new Error('알 수 없는 시뮬레이션 사건입니다.');
}
