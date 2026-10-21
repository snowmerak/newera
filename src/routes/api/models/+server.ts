import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getModelCatalog } from '$lib/server/oev';

export const GET: RequestHandler = async ({ request }) => {
	try { return json(await getModelCatalog(request.signal), { headers: { 'cache-control': 'no-store' } }); }
	catch (error) { return json({ message: error instanceof Error ? error.message : '모델 목록을 불러오지 못했습니다.' }, { status: 502, headers: { 'cache-control': 'no-store' } }); }
};
