<script lang="ts">
	import { enhance } from '$app/forms';
	import type { Scene, World } from '$lib/theater/types';
	let { world, scene }: { world: World; scene?: Scene } = $props();
</script>

<form method="POST" action="?/scene" use:enhance class="settings-form" aria-label={scene ? `${scene.name} 편집` : '새 씬 만들기'}>
	<input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} />
	{#if scene}<input type="hidden" name="sceneId" value={scene.id} />{/if}
	<label>씬 이름<input name="name" value={scene?.name ?? ''} placeholder="예: 비 오는 극장 로비" maxlength="200" required /></label>
	<label>어떤 장소인가요?<textarea name="description" rows="4" value={scene?.description ?? ''} placeholder="분위기, 눈에 들어오는 것, 여기서 일어날 수 있는 일…" required></textarea></label>
	<fieldset class="choice-field"><legend>{scene ? '이곳에서 갈 수 있는 씬' : '서로 오갈 수 있게 연결할 씬'}</legend>
		{#each world.definition.scenes.filter((other) => other.id !== scene?.id) as other}<label class="choice-chip"><input type="checkbox" name="exits" value={other.id} checked={scene?.exits.includes(other.id) ?? false} />{other.name}</label>{:else}<p class="empty-hint">다른 씬을 만든 뒤 연결할 수 있어요.</p>{/each}
	</fieldset>
	{#if scene}<p class="field-hint">나가는 길만 바꿉니다. 반대편 길은 그 씬에서 따로 편집할 수 있어요.</p>{/if}
	<button class="primary">{scene ? '씬 저장' : '씬 만들기'}</button>
</form>
