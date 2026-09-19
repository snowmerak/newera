import { json } from '@sveltejs/kit';
import { ensurePlayerSuggestions } from '$lib/server/game';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const value = await request.json() as { targetId?: unknown };
		if (value.targetId !== undefined && typeof value.targetId !== 'string') {
			return json({ error: '행동 대상이 올바르지 않습니다.' }, { status: 400 });
		}
		return json({ options: await ensurePlayerSuggestions(value.targetId ?? '') });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : '행동 선택지를 만들지 못했습니다.' }, { status: 500 });
	}
};
