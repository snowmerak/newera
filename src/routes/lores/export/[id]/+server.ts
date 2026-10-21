import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exportWorld } from '$lib/server/stage-store';

export const GET: RequestHandler = ({ params }) => {
	try {
		return new Response(exportWorld(params.id), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="newera-world-${encodeURIComponent(params.id)}.json"`, 'cache-control': 'no-store' } });
	} catch { error(404, '세계관을 찾을 수 없습니다.'); }
};
