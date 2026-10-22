<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { EntityTemplate, World } from '$lib/theater/types';
	import PropertiesEditor from './PropertiesEditor.svelte';
	let { world, template }: { world: World; template?: EntityTemplate } = $props();
	let kind = $state(untrack(() => template?.kind ?? 'character'));
</script>

<form method="POST" action="?/template" use:enhance class="settings-form" aria-label={template ? `${template.name} 기본 설정` : '새 캐릭터·사물 만들기'}>
	<input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} />
	{#if template}<input type="hidden" name="templateId" value={template.id} /><input type="hidden" name="kind" value={template.kind} />{:else}<label>무엇을 만들까요?<select name="kind" bind:value={kind}><option value="character">캐릭터</option><option value="object">사물</option></select></label>{/if}
	<label>기본 이름<input name="name" value={template?.name ?? ''} maxlength="200" placeholder={kind === 'character' ? '예: 서연' : '예: 무대 작업등'} required /></label>
	<label>{kind === 'character' ? '어떤 사람인가요?' : '어떤 사물인가요?'}<textarea name="description" rows="4" value={template?.description ?? ''} placeholder={kind === 'character' ? '역할, 배경, 알고 있는 것과 모르는 것…' : '생김새와 쓰임새를 알려 주세요.'} required></textarea></label>
	{#if kind === 'character'}
		<label>성격과 말투<textarea name="personality" rows="5" value={template?.personality ?? ''} placeholder="무엇을 중요하게 여기나요? 낯선 사람과 친구에게는 어떻게 말하나요?" maxlength="12000"></textarea></label>
		<label>바라는 것 · 한 줄에 하나씩<textarea name="goals" rows="3" value={template?.goals.join('\n') ?? ''} placeholder="공연 전에 마지막 장면을 맞춰본다"></textarea></label>
	{/if}
	<PropertiesEditor name="initialState" value={template?.initialState} title="처음 상태" />
	<details class="advanced-editor"><summary>상호작용·자동 반응 · 고급 설정</summary><p class="field-hint">스위치나 조건에 따른 행동을 정의할 때 사용합니다.</p>
		<label>상호작용 목록 · JSON<textarea name="interactions" class="code-input" rows="6" value={JSON.stringify(template?.interactions ?? [], null, 2)}></textarea></label>
		<label>자동 반응 목록 · JSON<textarea name="reactions" class="code-input" rows="5" value={JSON.stringify(template?.reactions ?? [], null, 2)}></textarea></label>
	</details>
	{#if template}<p class="field-hint">소개·성격·목표는 이 설정을 사용하는 모두에게 적용됩니다. 현재 이름·위치·기억·관계는 그대로예요. 처음 상태는 새로 배치하거나 초기화할 때 적용되며, 배치별로 정한 시작 상태가 있으면 그 값을 우선합니다.</p>{/if}
	<button class="primary">{template ? '기본 설정 저장' : kind === 'character' ? '캐릭터 만들기' : '사물 만들기'}</button>
</form>
