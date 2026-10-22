import type { Scene } from './types';

/** A deterministic spring layout changes presentation only; exits remain authoritative. */
export function sceneGraph(scenes: Scene[], startingSceneId: string) {
	const ordered = [...scenes.filter((scene) => scene.id === startingSceneId), ...scenes.filter((scene) => scene.id !== startingSceneId)];
	const nodes = ordered.map((scene, index) => {
		const angle = index * Math.PI * (3 - Math.sqrt(5));
		const radius = Math.sqrt(index) * 110;
		return { id: scene.id, name: scene.name, x: Math.cos(angle) * radius * 1.3, y: Math.sin(angle) * radius };
	});
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	const indices = new Map(nodes.map((node, index) => [node.id, index]));
	const links: { from: number; to: number; both: boolean }[] = [];
	for (const scene of scenes) for (const id of scene.exits) {
		if (!indices.has(id) || id === scene.id) continue;
		const both = byId.get(id)!.exits.includes(scene.id);
		if (both && scene.id > id) continue;
		links.push({ from: indices.get(scene.id)!, to: indices.get(id)!, both });
	}

	// Fixed iterations and a spiral seed keep SSR and client positions identical.
	for (let iteration = 0; iteration < 220; iteration++) {
		const forces = nodes.map(() => ({ x: 0, y: 0 }));
		for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
			const dx = nodes[i].x - nodes[j].x;
			const dy = nodes[i].y - nodes[j].y;
			const distance = Math.max(1, Math.hypot(dx, dy));
			const repulsion = 190 * 190 / (distance * distance);
			forces[i].x += dx * repulsion; forces[i].y += dy * repulsion;
			forces[j].x -= dx * repulsion; forces[j].y -= dy * repulsion;
		}
		for (const link of links) {
			const dx = nodes[link.to].x - nodes[link.from].x;
			const dy = nodes[link.to].y - nodes[link.from].y;
			const attraction = Math.hypot(dx, dy) / 190;
			forces[link.from].x += dx * attraction; forces[link.from].y += dy * attraction;
			forces[link.to].x -= dx * attraction; forces[link.to].y -= dy * attraction;
		}
		const temperature = 24 * (1 - iteration / 220) + 0.2;
		const gravity = Math.sqrt(nodes.length) * 0.6;
		for (let i = 0; i < nodes.length; i++) {
			const dx = forces[i].x - nodes[i].x * gravity;
			const dy = forces[i].y - nodes[i].y * gravity;
			const distance = Math.max(1, Math.hypot(dx, dy));
			const step = Math.min(temperature, distance) / distance;
			nodes[i].x += dx * step;
			nodes[i].y += dy * step;
		}
	}

	// Resolve the actual rectangular label bounds after the point-based simulation.
	for (let pass = 0; pass < 120; pass++) {
		let overlap = false;
		for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
			const dx = nodes[j].x - nodes[i].x;
			const dy = nodes[j].y - nodes[i].y;
			const width = 190 - Math.abs(dx);
			const height = 92 - Math.abs(dy);
			if (width <= 0 || height <= 0) continue;
			overlap = true;
			if (width < height) {
				const push = (width / 2 + 0.1) * (dx < 0 ? -1 : 1);
				nodes[i].x -= push; nodes[j].x += push;
			} else {
				const push = (height / 2 + 0.1) * (dy < 0 ? -1 : 1);
				nodes[i].y -= push; nodes[j].y += push;
			}
		}
		if (!overlap) break;
	}
	const minX = Math.min(0, ...nodes.map((node) => node.x));
	const minY = Math.min(0, ...nodes.map((node) => node.y));
	for (const node of nodes) { node.x += 110 - minX; node.y += 65 - minY; }
	const edges = links.map((link) => {
		const from = nodes[link.from];
		const to = nodes[link.to];
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const scale = Math.max(Math.abs(dx) / 88, Math.abs(dy) / 34);
		return { fromId: from.id, toId: to.id, both: link.both, x1: from.x + dx / scale, y1: from.y + dy / scale, x2: to.x - dx / scale, y2: to.y - dy / scale };
	});
	return { nodes, edges, width: Math.max(640, ...nodes.map((node) => node.x + 110)), height: Math.max(200, ...nodes.map((node) => node.y + 65)) };
}
