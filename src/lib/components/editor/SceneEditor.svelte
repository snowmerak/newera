<script lang="ts">
	import { enhance } from '$app/forms';
	import type { Scene, World } from '$lib/theater/types';
	import SceneNeighbors from './SceneNeighbors.svelte';
	let { world, scene }: { world: World; scene?: Scene } = $props();
</script>

<form method="POST" action="?/scene" use:enhance={() => async ({ update }) => { await update({ reset: !scene }); }} class="settings-form" aria-label={scene ? `${scene.name} 편집` : '새 씬 만들기'}>
	<input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} />
	{#if scene}<input type="hidden" name="sceneId" value={scene.id} />{/if}
	<label>씬 이름<input name="name" value={scene?.name ?? ''} placeholder="예: 극장 로비, 무대로 이어지는 복도" maxlength="200" required /></label>
	<label>어떤 장소인가요?<textarea name="description" rows="4" value={scene?.description ?? ''} placeholder="분위기, 눈에 들어오는 것, 여기서 일어날 수 있는 일…" required></textarea></label>
	<p class="field-hint">복도와 계단도 인물·사물을 배치하고 사건이 일어나는 독립된 씬으로 만들 수 있어요. 한 번의 이동으로 닿는 장소만 연결해 주세요.</p>
	<SceneNeighbors scenes={world.definition.scenes} sceneId={scene?.id} exits={scene?.exits ?? []} />
	<p class="field-hint">이 씬의 목록만 저장합니다. 서로 오가려면 반대편 씬의 목록에도 이곳을 선택해 주세요.</p>
	<button class="primary">{scene ? '씬 저장' : '씬 만들기'}</button>
</form>
