import { json } from '@sveltejs/kit';
import { getActiveLoreId, getGenerationJob, getLatestGenerationJob } from '$lib/server/db';
import { ensureGenerationWorker } from '$lib/server/game';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	ensureGenerationWorker();
	const requestedId = url.searchParams.get('id');
	const loreId = getActiveLoreId();
	const generation = requestedId ? getGenerationJob(requestedId) : getLatestGenerationJob(loreId);
	if (generation && generation.loreId !== loreId) {
		return json({ generation: null }, { headers: { 'cache-control': 'no-store' } });
	}
	return json({ generation }, { headers: { 'cache-control': 'no-store' } });
};
