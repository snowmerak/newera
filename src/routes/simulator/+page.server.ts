import type { PageServerLoad } from './$types';
import { getGameView } from '$lib/server/db';

export const load: PageServerLoad = () => {
	const { lore, world, player, characters } = getGameView();
	return { lore, world, player, characters };
};
