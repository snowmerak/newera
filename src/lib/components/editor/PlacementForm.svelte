<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { Spawn, World } from '$lib/theater/types';
	import PropertiesEditor from './PropertiesEditor.svelte';
	let { world, source, scope, character }: { world: World; source: Spawn; scope: 'current' | 'initial'; character: boolean } = $props();
	let sceneId = $state(untrack(() => source.sceneId));
	let companion = $state(untrack(() => source.companion));
	let followingScene = $derived(scope === 'current' ? world.state.activeSceneId : world.definition.startingSceneId);
</script>

<form method="POST" action={scope === 'current' ? '?/instance' : '?/initialInstance'} use:enhance class="settings-form" aria-label={`${source.name} ${scope === 'current' ? '현재 배치' : '처음 배치'}`}>
	<input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><input type="hidden" name="instanceId" value={source.id} />
	<label>이름<input name="name" value={source.name} maxlength="200" required /></label>
	{#if character}
		<label>겉모습과 옷차림<textarea name="appearance" rows="3" maxlength="1200" value={source.appearance ?? ''} placeholder="눈에 보이는 머리 모양, 옷차림, 소지품 등을 적어 주세요."></textarea></label>
		<label>플레이어와의 처음 설정<textarea name="playerContext" rows="3" maxlength="1200" value={source.playerContext ?? ''} placeholder="예: 오늘 처음 만난, 학교 안내를 맡은 같은 반 학생."></textarea></label>
		<p class="field-hint">플레이어가 아는 소개입니다. 상대의 비공개 속마음과 관계 수치는 아래 관계 편집에서 따로 다뤄요.</p>
	{/if}
	{#if character}<label class="choice-chip"><input type="checkbox" name="companion" bind:checked={companion} onchange={(event) => { if (event.currentTarget.checked) sceneId = followingScene; }} />플레이어와 동행</label>{/if}
	<label>어느 씬에 있나요?<select name="sceneId" bind:value={sceneId} disabled={companion}>{#each world.definition.scenes as scene}<option value={scene.id}>{scene.name}</option>{/each}</select></label>
	{#if companion}<input type="hidden" name="sceneId" value={followingScene} /><p class="field-hint">동행은 플레이어와 같은 곳에서 함께 움직여요.</p>{/if}
	<PropertiesEditor name="state" value={source.state} title={scope === 'current' ? '지금 상태' : '처음 상태'} />
	<button class="primary">{scope === 'current' ? '현재 배치 저장' : '처음 배치 저장'}</button>
</form>
