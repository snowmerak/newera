<script lang="ts">
	import { sceneGraph } from '$lib/theater/scene-graph';
	import type { World } from '$lib/theater/types';
	let { world }: { world: World } = $props();
	const markerId = $props.id();
	let scenes = $derived(world.definition.scenes);
	let graph = $derived(sceneGraph(scenes, world.definition.startingSceneId));
</script>

<section class="workshop-card scene-graph" aria-labelledby="scene-graph-title" data-testid="scene-graph">
	<div class="graph-heading"><div><h3 id="scene-graph-title">씬 연결 지도</h3><p>각 씬에 저장한 인접 목록을 그린 지도예요. 화살표 하나가 한 번의 이동입니다.</p></div><span>{scenes.length}개의 장소</span></div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable map needs keyboard access.) -->
	<div class="graph-scroll" role="region" aria-label="씬 연결 그래프, 넓은 지도는 좌우로 스크롤하세요" tabindex="0">
		<div class="graph-canvas" style:width={`${graph.width}px`} style:height={`${graph.height}px`}>
			<svg width={graph.width} height={graph.height} aria-hidden="true">
				<defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
				{#each graph.edges as edge}
					<line data-from={edge.fromId} data-to={edge.toId} data-bidirectional={edge.both} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} marker-end={`url(#${markerId})`} marker-start={edge.both ? `url(#${markerId})` : undefined} class:related={edge.fromId === world.state.activeSceneId || edge.toId === world.state.activeSceneId} />
				{/each}
			</svg>
			{#each graph.nodes as node (node.id)}
				<div class="graph-node" class:current={node.id === world.state.activeSceneId} style:left={`${node.x}px`} style:top={`${node.y}px`} title={node.name}>
					<strong>{node.name}</strong><small>{node.id === world.state.activeSceneId ? '지금 있는 곳' : node.id === world.definition.startingSceneId ? '시작하는 곳' : '씬'}</small>
				</div>
			{/each}
		</div>
	</div>
	<p class="graph-legend field-hint">아래 씬 카드에서 인접 씬 목록을 저장하면 지도에 반영됩니다. ↔ 양쪽 목록에 등록 · → 한쪽 목록에만 등록. 연결되지 않은 씬도 표시합니다.</p>
</section>
