<script lang="ts">
	import { onDestroy } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { World } from '$lib/theater/types';
	import type { ImagePresetSummary } from '$lib/images/presets';
	import { imageProviderNames } from '$lib/images/presets';
	let { world, presets }: { world: World; presets: ImagePresetSummary[] } = $props();
	let selected = $state('');
	let saving = $state(false);
	let generating = $state(false);
	let notice = $state('');
	let error = $state('');
	let prompt = $state('');
	let imageUrl = $state('');
	let controller: AbortController | undefined;
	const selectionKey = $derived(JSON.stringify([world.id, world.imagePresetId ?? null]));
	$effect(() => { const [, id] = JSON.parse(selectionKey); selected = id ?? ''; });
	const active = $derived(presets.find((preset) => preset.id === world.imagePresetId));
	const save: SubmitFunction = () => {
		saving = true; notice = ''; error = '';
		return async ({ update, result }) => {
			try {
				await update({ reset: false });
				if (result.type === 'success') notice = '이 세션의 이미지 프리셋을 적용했습니다.';
				else if (result.type === 'failure') error = String(result.data?.message ?? '이미지 프리셋을 적용하지 못했습니다.');
			} finally { saving = false; }
		};
	};
	async function generate(event: SubmitEvent) {
		event.preventDefault(); if (generating) return; generating = true; error = ''; controller = new AbortController();
		try {
			const response = await fetch('/api/images/generate', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: world.id, prompt }) });
			if (!response.ok) throw new Error((await response.json()).message);
			const image = await response.blob();
			if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type) || !image.size) throw new Error('이미지 응답이 올바르지 않습니다.');
			if (imageUrl) URL.revokeObjectURL(imageUrl);
			imageUrl = URL.createObjectURL(image);
		} catch (cause) { error = controller.signal.aborted ? '이미지 수신을 중단했습니다. 원격 생성은 계속될 수 있습니다.' : cause instanceof Error ? cause.message : '이미지를 생성하지 못했습니다.'; }
		finally { generating = false; }
	}
	onDestroy(() => { controller?.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl); });
</script>

<section aria-label="세션 이미지 설정">
	<h2>이 세션의 이미지 설정</h2>
	<p class="field-hint">‘{world.definition.name}’에서 사용할 프리셋을 선택하세요. 진행 초기화와 저장 슬롯을 불러와도 선택은 유지됩니다.</p>
	<form method="POST" action="?/imagePreset" use:enhance={save} class="settings-form">
		<input type="hidden" name="worldId" value={world.id} />
		<label>이미지 프리셋<select name="imagePresetId" bind:value={selected} disabled={saving || generating}><option value="">이미지 사용 안 함</option>{#each presets as preset}<option value={preset.id}>{preset.name} · {imageProviderNames[preset.provider]}</option>{/each}</select></label>
		<div class="button-row"><button class="primary" disabled={saving || generating}>{saving ? '적용 중…' : '이미지 프리셋 적용'}</button><a href="/images">프리셋 만들기·관리 ↗</a></div>
	</form>
	{#if notice}<p class="feedback" role="status">{notice}</p>{/if}
	<p class="field-hint">현재 선택: {active?.name ?? '이미지 사용 안 함'}. 공유 프리셋의 수정은 다음 이미지 생성부터 반영됩니다.</p>
	<details><summary>이 세션의 프리셋으로 삽화 생성</summary>
		<p class="field-hint">입력한 장면을 한 장으로 그립니다. 외부 이미지 API는 요금이 발생할 수 있습니다. 자동 장면 삽화는 아직 연결하지 않았습니다.</p>
		<form onsubmit={generate} class="settings-form"><label>그릴 장면<textarea bind:value={prompt} rows="4" maxlength="32000" required disabled={generating} placeholder="현재 장면에서 그리고 싶은 모습을 적어 주세요."></textarea></label><div class="button-row"><button disabled={!active || selected !== (world.imagePresetId ?? '') || saving || generating}>{generating ? '이미지 생성 중…' : '세션 삽화 생성'}</button>{#if generating}<button type="button" onclick={() => controller?.abort()}>생성 수신 중단</button>{/if}</div></form>
	</details>
	{#if error}<p class="feedback error" role="alert">{error}</p>{/if}
	{#if imageUrl}<img class="session-image" src={imageUrl} alt="세션 프리셋으로 생성한 삽화" /><p class="field-hint">이 이미지는 현재 화면에서만 표시되며 대화 기록에 저장하지 않습니다.</p>{/if}
</section>

<style>
	.button-row { align-items: center; flex-wrap: wrap; } a { font-size: 12px; } .session-image { display: block; width: 100%; height: auto; margin-top: 16px; border-radius: 3px; }
</style>
