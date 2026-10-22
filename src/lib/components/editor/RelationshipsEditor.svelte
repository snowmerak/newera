<script lang="ts">
	import { untrack } from 'svelte';
	import type { Relationships, World } from '$lib/theater/types';
	import RelationshipForm from './RelationshipForm.svelte';
	let { world, instanceId, scope, relationships = {} }: { world: World; instanceId: string; scope: 'current' | 'initial'; relationships?: Relationships } = $props();
	let targetId = $state(untrack(() => Object.keys(relationships)[0] ?? ''));
	let sources = $derived(scope === 'current' ? world.state.instances : world.definition.spawns);
	let targets = $derived([{ id: 'player', name: '플레이어' }, ...sources.filter((instance) => instance.id !== instanceId && world.definition.templates.find((template) => template.id === instance.templateId)?.kind === 'character').map((instance) => ({ id: instance.id, name: instance.name }))]);
</script>

<section class="relationships-editor"><h4>상대별 관계</h4><p class="field-hint">이 인물이 상대를 어떻게 보는지 설정해요. 상대가 느끼는 마음은 따로 편집합니다.</p>
	<div class="relation-chips">{#each targets.filter((target) => target.id in relationships) as target}<button type="button" class:chosen={targetId === target.id} onclick={() => { targetId = target.id; }}>{target.name}</button>{/each}</div>
	<label>누구에 대한 관계인가요?<select bind:value={targetId}><option value="">상대를 골라 주세요</option>{#each targets as target}<option value={target.id}>{target.name}{target.id in relationships ? ' · 설정됨' : ' · 새 관계'}</option>{/each}</select></label>
	{#if targetId}{#key `${scope}:${targetId}:${world.revision}`}<RelationshipForm worldId={world.id} revision={world.revision} {instanceId} {targetId} targetName={targets.find((target) => target.id === targetId)?.name ?? targetId} {scope} relation={relationships[targetId]} />{/key}{:else}<p class="empty-hint">상대를 선택하면 다섯 가지 마음과 인식을 조절할 수 있어요.</p>{/if}
</section>
