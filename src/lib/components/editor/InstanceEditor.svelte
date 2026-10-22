<script lang="ts">
	import { templateFor } from '$lib/theater/runtime';
	import type { EntityInstance, World } from '$lib/theater/types';
	import PlacementForm from './PlacementForm.svelte';
	import RelationshipsEditor from './RelationshipsEditor.svelte';
	let { world, instance }: { world: World; instance: EntityInstance } = $props();
	let scope = $state<'current' | 'initial'>('current');
	let template = $derived(templateFor(world, instance));
	let source = $derived(scope === 'current' ? instance : world.definition.spawns.find((spawn) => spawn.id === instance.id));
</script>

<details class="workshop-card instance-editor" data-testid={`instance-${instance.id}`}>
	<summary><span class="card-avatar">{instance.name.slice(0, 1)}</span><span><strong>{instance.name}</strong><small>{world.definition.scenes.find((scene) => scene.id === instance.sceneId)?.name} · {instance.companion ? '동행' : template.kind === 'character' ? '캐릭터' : '사물'}</small></span><span class="card-edit-label">편집</span></summary>
	<div class="card-body"><p class="field-hint">기본 설정: {template.name}</p><div class="scope-switch" aria-label="편집할 시점"><button type="button" class:chosen={scope === 'current'} aria-pressed={scope === 'current'} onclick={() => { scope = 'current'; }}>지금의 모습</button><button type="button" class:chosen={scope === 'initial'} aria-pressed={scope === 'initial'} onclick={() => { scope = 'initial'; }}>이야기 시작 시점</button></div>
		<p class="scope-note">{scope === 'current' ? '저장하면 지금의 위치·상태·관계가 바뀝니다. 기억은 유지돼요.' : '초기화했을 때의 배치와 관계입니다. 현재 진행은 바뀌지 않아요.'}</p>
		{#if source}{#key `${scope}:${world.revision}`}<PlacementForm {world} {source} {scope} character={template.kind === 'character'} />{#if template.kind === 'character'}<RelationshipsEditor {world} instanceId={instance.id} {scope} relationships={source.relationships} />{/if}{/key}{:else}<p class="empty-hint">이 인물의 처음 배치 설정이 없습니다.</p>{/if}
	</div>
</details>
