import type { EventRecord } from './types';

export function eventRequestText(event: Pick<EventRecord, 'actionId' | 'characterId' | 'summary'>): string {
	if (event.actionId === 'advance') return '다음 장면을 기다린다.';
	if (event.summary.startsWith('플레이어 시도: ')) {
		const request = event.summary.slice('플레이어 시도: '.length);
		const separator = request.lastIndexOf(' — ');
		return event.characterId && separator !== -1 && / (응함|거절함)$/.test(request.slice(separator + 3))
			? request.slice(0, separator)
			: request;
	}
	return event.summary;
}
