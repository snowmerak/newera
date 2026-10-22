import type { EntityInstance, EntityTemplate, World } from './types';

export function needsAppearance(world: World, actor: EntityInstance): boolean {
	const selection = actor.appearanceSelection;
	if (!selection || selection.day !== world.state.day) return true;
	if (!selection.sceneId || selection.minute === undefined || selection.sceneId === actor.sceneId) return false;
	return world.state.minute - selection.minute >= (world.definition.appearanceChangeMinutes ?? 180);
}

/** Commit the selected authored appearance before any later inference can fail. */
export function applyAppearance(actor: EntityInstance, template: EntityTemplate, world: World, outfitId: string, model: string): void {
	const outfit = template.wardrobe?.find((candidate) => candidate.id === outfitId);
	if (!outfit || !model) throw new Error('오늘의 옷차림 후보가 올바르지 않습니다.');
	const appearance = [template.baseAppearance, outfit.appearance].filter(Boolean).join(' ');
	if (appearance.length > 1200) throw new Error('오늘의 인상착의가 너무 깁니다.');
	actor.appearance = appearance;
	actor.appearanceSelection = { day: world.state.day, minute: world.state.minute, sceneId: actor.sceneId, outfitId, model };
}
