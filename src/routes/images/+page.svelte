<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';
	import type { ComfyCatalog, ComfySettings } from '$lib/images/comfyui';
	let { data, form }: PageProps = $props();
	let settings = $state<ComfySettings>();
	$effect(() => { settings = structuredClone(data.settings); });
	let current = $derived(settings ?? data.settings);
	let preset = $derived(data.presets.find((entry) => entry.id === current.presetId)!);
	let profile = $derived(current.profiles[current.presetId]);
	let catalog = $state<ComfyCatalog | null>(null);
	let catalogAddress = $state('');
	let loadingModels = $state(false);
	let saving = $state(false);
	let generating = $state(false);
	let error = $state('');
	let connectionError = $state('');
	let prompt = $state('A watercolor illustration of a quiet theater entrance after rain, warm amber light, a closed red umbrella by the door. No people, no text.');
	let seed = $state<number | undefined>();
	let imageUrl = $state('');
	let imageType = $state('image/png');
	let generatedSeed = $state('');
	let generatedWorkflow = $state('');
	let elapsed = $state(0);
	let controller: AbortController | undefined;
	let catalogController: AbortController | undefined;
	const connected = $derived(!!catalog && catalogAddress === current.baseUrl);
	const missingNodes = $derived(connected ? preset.requiredNodeTypes.filter((name) => !catalog!.nodeTypes.includes(name)) : []);
	async function loadCatalog() {
		if (loadingModels) return;
		loadingModels = true; connectionError = '';
		const address = current.baseUrl;
		catalogController = new AbortController();
		try {
			const response = await fetch(`/api/images/comfyui?baseUrl=${encodeURIComponent(address)}`, { signal: catalogController.signal, cache: 'no-store' });
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			catalog = result; catalogAddress = address;
		} catch (cause) {
			if (!catalogController.signal.aborted) { connectionError = cause instanceof Error ? cause.message : '모델 목록을 불러오지 못했습니다.'; catalog = null; }
		} finally { loadingModels = false; }
	}
	onMount(() => { void loadCatalog(); });
	onDestroy(() => { controller?.abort(); catalogController?.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl); });
	const save: SubmitFunction = () => {
		saving = true;
		return async ({ update }) => { try { await update({ reset: false }); } finally { saving = false; } };
	};
	async function generate(event: SubmitEvent) {
		event.preventDefault();
		if (generating) return;
		generating = true; error = '';
		controller = new AbortController();
		const started = performance.now();
		const workflowName = preset.name;
		try {
			const response = await fetch('/api/images/comfyui', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: current, prompt, ...(seed === undefined ? {} : { seed }) }) });
			if (!response.ok) throw new Error((await response.json()).message);
			const image = await response.blob();
			if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type) || !image.size) throw new Error('이미지 응답 형식이 올바르지 않습니다.');
			if (imageUrl) URL.revokeObjectURL(imageUrl);
			imageUrl = URL.createObjectURL(image); imageType = image.type;
			generatedSeed = response.headers.get('x-image-seed') ?? '';
			generatedWorkflow = workflowName;
			elapsed = Math.round((performance.now() - started) / 100) / 10;
		} catch (cause) { error = controller.signal.aborted ? '이미지 수신을 중단했습니다. 이미 실행 중인 ComfyUI 작업은 계속 진행될 수 있습니다.' : cause instanceof Error ? cause.message : '이미지를 생성하지 못했습니다.'; }
		finally { generating = false; }
	}
</script>

<svelte:head><title>이미지 설정 · newera</title><meta name="description" content="ComfyUI 워크플로우와 모델을 선택하고 삽화를 테스트합니다." /></svelte:head>
<header class="topbar"><a class="brand" href="/">newera<span>THEATER</span></a><a class="top-link" href="/">공연으로 돌아가기 ↗</a></header>
<main class="image-settings">
	<div class="intro"><p class="eyebrow">ILLUSTRATIONS</p><h1>이미지 설정</h1><p>ComfyUI 워크플로우와 모델을 선택하고, 이야기의 분위기를 한 장으로 확인해 보세요.</p></div>
	<div class="columns">
		<section class="configuration" aria-labelledby="settings-heading">
			<h2 id="settings-heading">ComfyUI 연결과 워크플로우</h2>
			<form method="POST" action="?/save" use:enhance={save} class="settings-form">
				<input type="hidden" name="settings" value={JSON.stringify(current)} />
				<label>ComfyUI 서버 주소<input type="url" bind:value={current.baseUrl} required disabled={generating || saving} /></label>
				<button type="button" onclick={loadCatalog} disabled={loadingModels || generating}>{loadingModels ? '모델 조회 중…' : '서버 모델 불러오기'}</button>
				{#if connectionError}<p class="feedback error" role="alert">{connectionError}</p>{:else if connected}<p class="connection" role="status">서버 연결됨 · 모델 목록을 불러왔습니다.</p>{/if}
				<label>기본 워크플로우<select bind:value={current.presetId} disabled={generating || saving}>{#each data.presets as entry}<option value={entry.id}>{entry.name}</option>{/each}</select></label>
				<p class="field-hint">{preset.description}</p>
				{#if missingNodes.length}<p class="feedback error" role="alert">서버에 필요한 노드가 없습니다: {missingNodes.join(', ')}</p>{/if}
				{#each preset.models as model (`${preset.id}-${model.field}`)}
					<label>{model.label}<select bind:value={profile.models[model.field]} required={model.required} disabled={!connected || generating || saving}>
						<option value="">{model.required ? '모델을 선택하세요' : '사용 안 함'}</option>
						{#if profile.models[model.field] && !catalog?.models[model.field].includes(profile.models[model.field])}<option value={profile.models[model.field]}>{profile.models[model.field]} (현재 목록에 없음)</option>{/if}
						{#each catalog?.models[model.field] ?? [] as name}<option value={name}>{name}</option>{/each}
					</select></label>
				{/each}
				{#if preset.id === 'zit-moody' && profile.models.lora}<label>LoRA 강도<input type="number" bind:value={profile.loraStrength} step="0.05" min="-2" max="2" required disabled={generating || saving} /></label>{/if}
				<div class="dimensions"><label>기본 가로 (px)<input type="number" bind:value={profile.width} min="64" max="4096" step="8" required disabled={generating || saving} /></label><label>기본 세로 (px)<input type="number" bind:value={profile.height} min="64" max="4096" step="8" required disabled={generating || saving} /></label></div>
				<p class="field-hint">{#if preset.outputScale !== 1}ZIT는 기본 크기를 1.8배 확대한 뒤 세부 묘사를 생성합니다.{:else}기본 크기가 최종 이미지 크기입니다.{/if}</p>
				{#if preset.bindings.negativePrompt}<label>네거티브 프롬프트<textarea bind:value={profile.negativePrompt} rows="4" maxlength="32000" disabled={generating || saving}></textarea></label>{/if}
				<button class="primary" disabled={saving || generating}>{saving ? '저장 중…' : '이미지 설정 저장'}</button>
				{#if form?.message}<p class="feedback" class:error={form.error} role={form.error ? 'alert' : 'status'}>{form.message}</p>{/if}
			</form>
		</section>
		<section class="generation" aria-labelledby="test-heading">
			<h2 id="test-heading">삽화 테스트</h2>
			<p class="field-hint">화면에 입력한 설정으로 한 장을 생성합니다. 모델과 크기는 워크플로우별로 저장됩니다.</p>
			<form onsubmit={generate} class="settings-form">
				<label>그릴 장면<textarea bind:value={prompt} rows="5" maxlength="32000" required disabled={generating}></textarea></label>
				<label>Seed · 비워두면 무작위<input type="number" bind:value={seed} min="0" max="281474976710655" step="1" placeholder="무작위" disabled={generating} /></label>
				<div class="buttons"><button class="primary" disabled={generating || !connected || !!missingNodes.length || preset.models.some((model) => model.required && !profile.models[model.field])}>{generating ? '이미지 생성 중…' : '테스트 이미지 생성'}</button>{#if generating}<button type="button" onclick={() => controller?.abort()}>생성 수신 중단</button>{/if}</div>
			</form>
			{#if generating}<p class="connection" role="status">ComfyUI에서 이미지를 생성하고 있습니다. 완료되면 여기에 표시됩니다.</p>{/if}
			{#if error}<p class="feedback error" role="alert">{error}</p>{/if}
			<div class="preview" aria-busy={generating}>
				{#if imageUrl}<img src={imageUrl} alt={`${generatedWorkflow}로 생성한 테스트 삽화`} /><div class="image-details"><span>{generatedWorkflow} · {elapsed}초 · Seed {generatedSeed}</span><a href={imageUrl} download={`newera-${generatedSeed}.${imageType === 'image/jpeg' ? 'jpg' : imageType === 'image/webp' ? 'webp' : 'png'}`}>이미지 내려받기 ↓</a></div>{:else}<div class="empty-preview"><span>장면을 그려보세요</span><p>생성한 이미지는 이곳에 표시됩니다.</p></div>{/if}
			</div>
			<p class="field-hint">이미지는 ComfyUI에서 직접 받아 브라우저에 표시합니다. 내려받기를 누르기 전에는 앱과 ComfyUI에 이미지 파일을 저장하지 않습니다. 공연 중 자동 삽화는 아직 연결하지 않았습니다.</p>
		</section>
	</div>
</main>

<style>
	.image-settings { max-width: 1240px; margin: auto; padding: 36px 28px 64px; }
	.intro { margin-bottom: 30px; }
	h1 { font-size: 30px; font-weight: 500; margin: 0 0 14px; }
	h2 { font-size: 18px; font-weight: 500; margin: 0 0 20px; }
	.intro > p:last-child { color: var(--muted); line-height: 1.8; }
	.columns { display: grid; grid-template-columns: minmax(300px, 440px) minmax(0, 1fr); gap: 32px; align-items: start; }
	.configuration, .generation { min-width: 0; border: 1px solid var(--line); background: #202024; padding: 24px; border-radius: 5px; }
	.dimensions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.connection { color: #b7c5a9; font-size: 12px; line-height: 1.8; }
	.buttons { display: flex; gap: 10px; flex-wrap: wrap; }
	.preview { margin-top: 24px; border: 1px solid var(--line); background: #19191c; }
	.preview img { display: block; width: 100%; max-height: 720px; object-fit: contain; }
	.empty-preview { min-height: 300px; display: flex; flex-direction: column; justify-content: center; align-items: center; color: #a99981; padding: 20px; text-align: center; }
	.empty-preview span { font-family: Georgia, serif; font-size: 23px; }
	.empty-preview p { color: var(--muted); font-size: 12px; }
	.image-details { padding: 14px; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
	@media (max-width: 760px) { .columns { grid-template-columns: 1fr; gap: 20px; } .image-settings { padding: 28px 16px; } .configuration, .generation { padding: 18px; } }
</style>
