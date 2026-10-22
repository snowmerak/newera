import type { Scene } from './types';

/** Lay out weakly connected components without changing the actual directed exits. */
export function sceneGraph(scenes: Scene[], startingSceneId: string) {
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	const neighbors = new Map(scenes.map((scene) => [scene.id, new Set<string>()]));
	for (const scene of scenes) for (const id of scene.exits) {
		if (!byId.has(id)) continue;
		neighbors.get(scene.id)!.add(id);
		neighbors.get(id)!.add(scene.id);
	}
	const nodes: { id: string; name: string; x: number; y: number }[] = [];
	const visited = new Set<string>();
	let offset = 0;
	for (const root of [startingSceneId, ...byId.keys()]) {
		if (!byId.has(root) || visited.has(root)) continue;
		const pending = [{ id: root, depth: 0 }];
		const counts: number[] = [];
		visited.add(root);
		for (let index = 0; index < pending.length; index++) {
			const { id, depth } = pending[index];
			const row = counts[depth] ?? 0;
			counts[depth] = row + 1;
			nodes.push({ id, name: byId.get(id)!.name, x: 110 + depth * 240, y: offset + 65 + row * 110 });
			for (const next of neighbors.get(id)!) {
				if (visited.has(next)) continue;
				visited.add(next);
				pending.push({ id: next, depth: depth + 1 });
			}
		}
		offset += Math.max(...counts) * 110 + 30;
	}
	const positions = new Map(nodes.map((node) => [node.id, node]));
	const edges = [];
	for (const scene of scenes) for (const id of scene.exits) {
		if (!positions.has(id)) continue;
		const both = byId.get(id)!.exits.includes(scene.id);
		if (both && scene.id > id) continue;
		const from = positions.get(scene.id)!;
		const to = positions.get(id)!;
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const scale = Math.max(Math.abs(dx) / 88, Math.abs(dy) / 34);
		edges.push({ fromId: scene.id, toId: id, both, x1: from.x + dx / scale, y1: from.y + dy / scale, x2: to.x - dx / scale, y2: to.y - dy / scale });
	}
	return { nodes, edges, width: Math.max(640, ...nodes.map((node) => node.x + 110)), height: Math.max(160, offset) };
}
