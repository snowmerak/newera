<script lang="ts">
	import { onMount } from 'svelte';
	import type { ModelAlias, ProviderKind, ProviderView, PublicProvider } from '$lib/providers/types';
	let { onsaved }: { onsaved: () => Promise<void> } = $props();
	let registry = $state<ProviderView | null>(null);
	let selected = $state('');
	let id = $state('');
	let label = $state('');
	let kind = $state<ProviderKind>('oev');
	let baseUrl = $state('');
	let apiKey = $state('');
	let apiKeyEnv = $state('');
	let clearApiKey = $state(false);
	let keyConfigured = $state(false);
	let models = $state<ModelAlias[]>([]);
	let outputTokenParameter = $state<PublicProvider['outputTokenParameter']>('max_completion_tokens');
	let structuredOutput = $state<PublicProvider['structuredOutput']>('json_schema');
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	function choose(value: string) {
		const provider = registry?.providers.find((entry) => entry.id === value);
		selected = value;
		id = provider?.id ?? crypto.randomUUID();
		label = provider?.label ?? '';
		kind = provider?.kind ?? 'oev';
		baseUrl = provider?.baseUrl ?? '';
		apiKey = ''; apiKeyEnv = provider?.apiKeyEnv ?? ''; clearApiKey = false;
		keyConfigured = provider?.apiKeyConfigured ?? false;
		models = (provider?.models ?? []).map((model) => ({ ...model }));
		outputTokenParameter = provider?.outputTokenParameter ?? 'max_completion_tokens';
		structuredOutput = provider?.structuredOutput ?? 'json_schema';
		error = ''; notice = '';
	}
	async function reload() {
		busy = true; error = '';
		try {
			const response = await fetch('/api/providers', { cache: 'no-store' });
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			registry = result;
			choose(registry!.providers.some((entry) => entry.id === selected) ? selected : '');
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Provider 목록을 불러오지 못했습니다.'; }
		finally { busy = false; }
	}
	onMount(() => { void reload(); });
	async function discover() {
		if (busy || !selected) return;
		busy = true; error = ''; notice = '';
		try {
			const response = await fetch(`/api/providers?models=${encodeURIComponent(selected)}`, { cache: 'no-store' });
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			const fresh = (result.models as { id: string; task: ModelAlias['task'] }[]).filter((model) => !models.some((alias) => alias.modelId === model.id && alias.task === model.task));
			models = [...models, ...fresh.map((model) => ({ id: crypto.randomUUID(), label: model.id, modelId: model.id, task: model.task }))].slice(0, 100);
			notice = '조회한 모델을 추가했습니다. 별칭과 용도를 확인한 뒤 Provider 저장을 눌러 주세요.';
		} catch (cause) { error = cause instanceof Error ? cause.message : '서버 모델을 조회하지 못했습니다.'; }
		finally { busy = false; }
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !registry) return;
		busy = true; error = ''; notice = '';
		try {
			const response = await fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: registry.revision, provider: { id, label, kind, baseUrl, apiKey, apiKeyEnv, models, outputTokenParameter, structuredOutput }, clearApiKey }) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			registry = result; choose(id); notice = 'Provider와 모델 별칭을 저장했습니다. 세션에서 사용할 모델을 선택해 적용해 주세요.';
			await onsaved();
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Provider를 저장하지 못했습니다.'; }
		finally { busy = false; }
	}
	async function remove() {
		if (busy || !registry || !selected || selected === 'default') return;
		busy = true; error = ''; notice = '';
		try {
			const response = await fetch('/api/providers', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: registry.revision, id: selected }) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			registry = result; choose(''); notice = 'Provider를 삭제했습니다.';
			await onsaved();
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Provider를 삭제하지 못했습니다.'; }
		finally { busy = false; }
	}
</script>

<section class="provider-manager" aria-label="Provider 관리">
	<h3>Provider와 모델 별칭</h3>
	<p class="field-hint">등록은 앱 전체에서 공유합니다. 판단은 OEV의 typed decision을 사용하며 생성은 OpenAI 호환 API도 선택할 수 있습니다.</p>
	<label>편집할 Provider<select value={selected} onchange={(event) => choose(event.currentTarget.value)} disabled={busy || !registry}>
		<option value="">새 Provider 추가</option>
		{#each registry?.providers ?? [] as provider}<option value={provider.id}>{provider.label}</option>{/each}
	</select></label>
	<form onsubmit={save} class="provider-form">
		<label>Provider 이름<input bind:value={label} placeholder="예: Mac Studio · 집 서버" maxlength="100" required disabled={busy} /></label>
		<label>API 유형<select bind:value={kind} disabled={busy || selected === 'default'}><option value="oev">OEV · 판단/생성/임베딩</option><option value="openai-compatible">OpenAI 호환 · 생성/임베딩</option></select></label>
		<label>API 기본 주소<input type="url" bind:value={baseUrl} placeholder="http://macstudio:12821/v1" required disabled={busy} /></label>
		<label>API 키<input type="password" bind:value={apiKey} autocomplete="new-password" placeholder={keyConfigured ? '등록된 키 유지 · 바꿀 때만 입력' : '인증이 필요할 때 입력'} disabled={busy} /></label>
		{#if keyConfigured}<label class="provider-key-clear"><input type="checkbox" bind:checked={clearApiKey} disabled={busy} />저장된 API 키 지우기</label>{/if}
		<div class="provider-aliases">
			<h4>모델 별칭</h4>
			<p class="field-hint">서버의 실제 모델 ID에 알아보기 쉬운 이름을 붙입니다. 기본 OEV의 자동 조회 목록도 함께 유지됩니다.</p>
			<button type="button" onclick={discover} disabled={busy || !selected}>서버 모델 목록 가져오기</button>
			{#if !selected}<p class="field-hint">Provider를 먼저 저장하면 서버 모델 목록을 가져올 수 있습니다.</p>{/if}
			{#each models as model, index (model.id)}
				<fieldset><legend>모델 {index + 1}</legend>
					<label>표시 별칭<input bind:value={model.label} placeholder="빠른 판단 · 이야기 생성" maxlength="100" required disabled={busy} /></label>
					<label>실제 모델 ID<input bind:value={model.modelId} placeholder="gemma4-26b" maxlength="200" required disabled={busy} /></label>
					<label>용도<select bind:value={model.task} disabled={busy}><option value="generation">판단·생성용 모델</option><option value="embedding">임베딩용 모델</option></select></label>
					<button type="button" onclick={() => { models = models.filter((_, row) => row !== index); }} disabled={busy}>별칭 제거</button>
				</fieldset>
			{/each}
			<button type="button" onclick={() => { models = [...models, { id: crypto.randomUUID(), label: '', modelId: '', task: 'generation' }]; }} disabled={busy || models.length >= 100}>모델 별칭 추가</button>
		</div>
		<details><summary>API 세부 옵션</summary>
			<label>API 키 환경 변수<input bind:value={apiKeyEnv} placeholder="예: MY_PROVIDER_API_KEY" disabled={busy} /></label>
			<p class="field-hint">서버 환경 변수의 키를 쓸 때 지정합니다. 직접 입력한 키보다 우선합니다.</p>
			<label>출력 토큰 옵션<select bind:value={outputTokenParameter} disabled={busy}><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens</option></select></label>
			<label>구조화된 출력<select bind:value={structuredOutput} disabled={busy}><option value="json_schema">JSON Schema</option><option value="json_object">JSON 객체 · 앱에서 스키마 검증</option></select></label>
		</details>
		<div class="model-buttons"><button disabled={busy || !registry}>{busy ? '처리 중…' : 'Provider 저장'}</button><button type="button" onclick={reload} disabled={busy}>등록 목록 새로고침</button>{#if selected && selected !== 'default'}<button type="button" class="danger-button" onclick={remove} disabled={busy}>Provider 삭제</button>{/if}</div>
	</form>
	{#if error}<p class="feedback error" role="alert">{error}</p>{/if}
	{#if notice}<p class="feedback" role="status">{notice}</p>{/if}
</section>
