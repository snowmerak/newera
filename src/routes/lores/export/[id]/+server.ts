import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exportLoreJson } from '$lib/server/db';

export const GET: RequestHandler = ({ params }) => {
	try {
		return new Response(exportLoreJson(params.id), {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': `attachment; filename="newera-lore-${params.id}.json"`,
				'cache-control': 'no-store'
			}
		});
	} catch {
		error(404, '로어를 찾을 수 없습니다.');
	}
};
