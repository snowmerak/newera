import type { RequestHandler } from './$types';
import { exportSessionMarkdown } from '$lib/server/db';

export const GET: RequestHandler = () => {
	const { loreId, markdown } = exportSessionMarkdown();
	return new Response(markdown, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="newera-session-${loreId}.md"`,
			'cache-control': 'no-store'
		}
	});
};
