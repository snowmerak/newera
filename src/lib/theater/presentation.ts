import type { CharacterPresentation, World } from './types.ts';

function presentationHistory(world: World) {
	const characterTemplates = new Set(world.definition.templates.filter((template) => template.kind === 'character').map((template) => template.id));
	const characters = new Map(world.state.instances.filter((actor) => characterTemplates.has(actor.templateId)).map((actor) => [actor.id, actor]));
	const spawns = new Map(world.definition.spawns.map((spawn) => [spawn.id, spawn]));
	const seen = new Set<string>();
	const appearances = new Map<string, string>();
	const presentations = new Map<string, CharacterPresentation>();
	for (const event of world.state.events) {
		const actor = characters.get(event.actorId);
		if (!actor) continue;
		const first = !seen.has(actor.id);
		const snapshot = event.presentation;
		const presentation: CharacterPresentation = {};
		// Older records have no snapshots. Use the authored starting look once, without rewriting later events.
		if (first) {
			const context = snapshot ? snapshot.playerContext : actor.playerContext ?? spawns.get(actor.id)?.playerContext;
			if (context) presentation.playerContext = context;
		}
		const appearance = snapshot ? snapshot.appearance : first ? spawns.get(actor.id)?.appearance ?? actor.appearance ?? '' : undefined;
		if (appearance !== undefined) {
			if (appearance && appearance !== appearances.get(actor.id)) presentation.appearance = appearance;
			appearances.set(actor.id, appearance);
		}
		seen.add(actor.id);
		if (presentation.playerContext || presentation.appearance) presentations.set(event.id, presentation);
	}
	return { seen, appearances, presentations };
}

/** Deduplicate against the full history, before applying the reader's recent-event window. */
export function eventPresentations(world: World): Map<string, CharacterPresentation> {
	return presentationHistory(world).presentations;
}

/** Snapshot only a first introduction or a changed visible appearance; this creates no separate action. */
export function nextPresentation(world: World, actorId: string): CharacterPresentation | undefined {
	const actor = world.state.instances.find((instance) => instance.id === actorId);
	if (!actor || world.definition.templates.find((template) => template.id === actor.templateId)?.kind !== 'character') return undefined;
	const history = presentationHistory(world);
	const appearance = actor.appearance ?? '';
	if (!history.seen.has(actorId)) return { playerContext: actor.playerContext ?? '', appearance };
	return appearance !== (history.appearances.get(actorId) ?? '') ? { appearance } : undefined;
}
