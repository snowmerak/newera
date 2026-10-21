import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { actorName } from '$lib/theater/runtime';
import { getWorld } from '$lib/server/stage-store';

export const GET: RequestHandler = ({ url }) => {
	try {
		const world = url.searchParams.has('worldId') ? getWorld(url.searchParams.get('worldId')!) : getWorld();
		const markdown = [`# ${world.definition.name}`, '', world.definition.description, '', ...world.state.events.flatMap((event) => [
			`## ${event.tick} · ${world.definition.scenes.find((scene) => scene.id === event.sceneId)?.name} · ${actorName(world, event.actorId)}`, '', event.text, ''
		])].join('\n');
		return new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="newera-theater-${encodeURIComponent(world.id)}.md"`, 'cache-control': 'no-store' } });
	} catch { error(404, '세계관을 찾을 수 없습니다.'); }
};
