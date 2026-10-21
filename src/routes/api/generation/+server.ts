import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getJob } from '$lib/server/stage-store';
import { ensureStageWorker } from '$lib/server/stage';

export const GET: RequestHandler = ({ url }) => {
	ensureStageWorker();
	return json({ generation: getJob(url.searchParams.get('id') || '') }, { headers: { 'cache-control': 'no-store' } });
};
