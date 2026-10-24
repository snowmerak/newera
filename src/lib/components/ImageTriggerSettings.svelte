<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { newImageRule, type ImageTriggerView } from '$lib/images/triggers';
	import type { World } from '$lib/theater/types';
	let { world, settings, count }: { world: World; settings: ImageTriggerView; count: number } = $props();
	let config = $state(untrack(() => structuredClone(settings.config)));
	let revision = $state(untrack(() => settings.revision));
	let busy = $state(false);
	let notice = $state('');
	let error = $state('');
	// Updating story/poll data must not replace an unsaved rule draft.
	const savedKey = $derived(settings.revision);
	$effect(() => { if (savedKey !== revision) { config = structuredClone(settings.config); revision = savedKey; } });
	async function submit(operation: 'save' | 'request' | 'clear', event?: SubmitEvent) {
		event?.preventDefault(); if (busy) return; busy = true; error = ''; notice = '';
		try {
			const response = await fetch('/api/images/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: world.id, operation, ...(operation === 'save' ? { revision, config } : {}) }) });
			const result = await response.json(); if (!response.ok) throw new Error(result.message);
			await invalidateAll();
			if (operation === 'save') { revision = result.settings.revision; config = structuredClone(result.settings.config); }
			notice = operation === 'save' ? '이미지 생성 조건을 저장했습니다. 다음 진행부터 확인합니다.' : operation === 'request' ? '현재 장면의 삽화를 요청했습니다. 대화 기록에 표시됩니다.' : '삽화 기록을 비웠습니다.';
		} catch (cause) { error = cause instanceof Error ? cause.message : '이미지 생성 조건을 저장하지 못했습니다.'; }
		finally { busy = false; }
	}
</script>

<section class="image-triggers" aria-label="이미지 생성 조건">
	<h3>이미지 생성 조건</h3>
	<p class="field-hint">규칙 중 하나라도 충족되면 한 장을 생성합니다. 규칙 안의 장소·등장 대상·상태·자연어 조건은 모두 만족해야 합니다. 시간은 게임 내 시간입니다.</p>
	<form onsubmit={(event) => submit('save', event)} class="settings-form">
		<label class="toggle"><input type="checkbox" bind:checked={config.enabled} disabled={busy} /> 이 세션의 자동 삽화 사용</label>
		{#each config.rules as rule, index (rule.id)}
			<fieldset class="rule"><legend>삽화 조건 {index + 1}</legend>
				<label class="toggle"><input type="checkbox" bind:checked={rule.enabled} disabled={busy} /> 이 조건 사용</label>
				<label>조건 이름<input bind:value={rule.name} maxlength="100" required disabled={busy} /></label>
				<label>발동 시점<select bind:value={rule.when} disabled={busy}><option value="scene">현재 장소가 바뀌었을 때</option><option value="interval">게임 내 시간이 지났을 때</option><option value="condition">조건이 새로 충족됐을 때</option></select></label>
				{#if rule.when === 'interval'}<label>생성 간격 (게임 내 분)<input type="number" bind:value={rule.minutes} min="1" max="10080" required disabled={busy} /></label>{/if}
				<label>최소 재생성 간격 (게임 내 분)<input type="number" bind:value={rule.cooldownMinutes} min="0" max="10080" required disabled={busy} /></label>
				<label>장소 조건<select bind:value={rule.sceneId} disabled={busy}><option value="">모든 장소</option>{#each world.definition.scenes as scene}<option value={scene.id}>{scene.name}</option>{/each}</select></label>
				<label>함께 있어야 하는 인물·사물<select bind:value={rule.entityId} disabled={busy}><option value="">지정 안 함</option>{#each world.state.instances as entity}<option value={entity.id}>{entity.name}</option>{/each}</select></label>
				<label class="toggle"><input type="checkbox" checked={!!rule.state} onchange={(event) => { rule.state = event.currentTarget.checked ? { entityId: world.state.instances[0]?.id ?? '', key: '', equals: true } : null; }} disabled={busy || !world.state.instances.length} /> 인물·사물 속성값 조건 추가</label>
				{#if rule.state}
					<label>상태 대상<select bind:value={rule.state.entityId} required disabled={busy}>{#each world.state.instances as entity}<option value={entity.id}>{entity.name}</option>{/each}</select></label>
					<label>상태 속성 이름<input bind:value={rule.state.key} maxlength="100" required disabled={busy} placeholder="예: lightOn" /></label>
					<label>비교값 (JSON)<input value={JSON.stringify(rule.state.equals)} required disabled={busy} onchange={(event) => { try { rule.state!.equals = JSON.parse(event.currentTarget.value); event.currentTarget.setCustomValidity(''); } catch { event.currentTarget.setCustomValidity('true, false, 숫자, null, 또는 큰따옴표로 감싼 문자열을 입력해 주세요.'); event.currentTarget.reportValidity(); } }} /></label>
				{/if}
				<label>자연어 조건 · 선택<textarea bind:value={rule.naturalLanguage} rows="3" maxlength="2000" disabled={busy} placeholder="예: 두 인물이 서로 인사를 마치고 함께 우산을 펼친 순간"></textarea></label>
				{#if rule.naturalLanguage.trim()}<p class="field-hint">세션의 생성 모델이 현재 장면과 최근 공개 사건으로 판단합니다. 판단 실패 시 이미지를 생성하지 않습니다.</p>{/if}
				<label>이 조건의 그림 지침 · 선택<textarea bind:value={rule.prompt} rows="2" maxlength="2000" disabled={busy} placeholder="예: 두 사람의 표정과 젖은 우산을 중심으로 그린다."></textarea></label>
				<button type="button" onclick={() => { config.rules = config.rules.filter((entry) => entry.id !== rule.id); }} disabled={busy}>이 조건 삭제</button>
			</fieldset>
		{/each}
		<div class="buttons"><button type="button" onclick={() => { config.rules = [...config.rules, newImageRule()]; }} disabled={busy || config.rules.length >= 10}>삽화 조건 추가</button><button class="primary" disabled={busy}>{busy ? '처리 중…' : '이미지 생성 조건 저장'}</button></div>
	</form>
	<p class="field-hint">‘조건이 새로 충족’은 첫 확인에서 참이거나 거짓에서 참으로 바뀔 때 한 번 생성하며, 다시 거짓이 돼야 재발동합니다. 여러 규칙이 동시에 맞으면 한 장으로 합칩니다. 설정 저장 시 시간 기준과 이전 판정을 새로 잡습니다.</p>
	<div class="buttons"><button type="button" onclick={() => submit('request')} disabled={busy || !world.imagePresetId || count >= 100}>현재 장면 삽화 추가</button><button type="button" onclick={() => submit('clear')} disabled={busy || !count}>삽화 기록 비우기 ({count}/100)</button></div>
	<p class="field-hint">그림은 세션 기록에 저장됩니다. 진행 초기화·저장 슬롯 불러오기는 삽화를 비우고 조건 설정은 유지합니다. 외부 API 생성과 자연어 판단에는 요금이 발생할 수 있습니다.</p>
	{#if notice}<p class="feedback" role="status">{notice}</p>{/if}{#if error}<p class="feedback error" role="alert">{error}</p>{/if}
</section>

<style>
	.image-triggers { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 12px; }
	.settings-form > .rule { display: grid; gap: 14px; min-width: 0; }
	.toggle { display: flex; align-items: center; gap: 9px; } .toggle input { width: auto; }
	.buttons { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
