import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearIllustrations, getImageTriggers, listIllustrations, queueImageCheck, saveImageTriggers } from '$lib/server/images/trigger-store';
import { ensureImageWorker } from '$lib/server/images/trigger-worker';
const headers = { 'cache-control': 'no-store' };
const view = (id: string) => ({ settings: getImageTriggers(id), illustrations: listIllustrations(id) });
export const GET: RequestHandler = ({ url }) => {
	try { ensureImageWorker(); return json(view(url.searchParams.get('worldId') ?? ''), { headers }); }
	catch { return json({ message: '세션의 삽화 상태를 읽지 못했습니다.' }, { status: 400, headers }); }
};
export const POST: RequestHandler = async ({ url, request }) => {
	if (request.headers.get('origin') !== url.origin) return json({ message: '같은 앱에서 삽화를 설정해 주세요.' }, { status: 403, headers });
	try {
		const body = await request.json();
		if (!body || typeof body.worldId !== 'string' || body.worldId.length > 100 || Object.keys(body).some((key) => !['worldId', 'operation', 'revision', 'config'].includes(key))) throw new Error('이미지 조건 요청이 올바르지 않습니다.');
		if (body.operation === 'save') saveImageTriggers(body.worldId, body.revision, body.config);
		else if (body.operation === 'request') queueImageCheck(body.worldId, true);
		else if (body.operation === 'clear') clearIllustrations(body.worldId);
		else throw new Error('이미지 조건 작업이 올바르지 않습니다.');
		ensureImageWorker();
		return json(view(body.worldId), { headers });
	} catch (error) {
		return json({ message: error instanceof Error && !(error instanceof SyntaxError) ? error.message : '이미지 조건 요청을 처리하지 못했습니다.' }, { status: 400, headers });
	}
};
