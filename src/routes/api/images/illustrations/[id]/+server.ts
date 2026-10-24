import type { RequestHandler } from './$types';
import { store } from '$lib/server/stage-store';
export const GET: RequestHandler = ({ params }) => {
	const row = store().prepare("SELECT bytes, media_type FROM theater_illustrations WHERE id = ? AND status = 'completed'").get(params.id);
	if (!row || !(row.bytes instanceof Uint8Array) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(row.media_type))) return new Response('삽화를 찾을 수 없습니다.', { status: 404 });
	return new Response(new Uint8Array(row.bytes), { headers: { 'content-type': String(row.media_type), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
};
