<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import type { PageProps } from './$types';
	import type { ComfyCatalog } from '$lib/images/comfyui';
	import type { HostedImageCatalog } from '$lib/images/models';
	import type { ImageProvider } from '$lib/images/types';
	import { imageProviderNames } from '$lib/images/presets';
	import type { ImagePreset, ImagePresetConfig } from '$lib/images/presets';
	let { data }: PageProps = $props();
	let registry = $state<ImagePreset[]>(untrack(() => structuredClone(data.imagePresets)));
	let current = $state(untrack(() => structuredClone(data.settings)));
	let selected = $state('');
	let revision = $state(0);
	let name = $state('');
	let provider = $state<ImageProvider>('comfyui');
	let baseUrl = $state(untrack(() => data.settings.baseUrl));
	let stylePrompt = $state('');
	let apiKeyEnv = $state('');
	let model = $state('');
	let size = $state('');
	let quality = $state('');
	let outputFormat = $state('');
	let outputCompression = $state<number | undefined>();
	let background = $state('');
	let aspectRatio = $state('');
	let resolution = $state('');
	let catalog = $state<ComfyCatalog | null>(null);
	let hostedCatalog = $state<HostedImageCatalog | null>(null);
	let catalogKey = $state('');
	let modelSearch = $state('');
	let loadingModels = $state(false);
	let saving = $state(false);
	let generating = $state(false);
	let error = $state('');
	let notice = $state('');
	let connectionError = $state('');
	let prompt = $state('A watercolor illustration of a quiet theater entrance after rain, warm amber light, a closed red umbrella by the door. No people, no text.');
	let seed = $state<number | undefined>();
	let imageUrl = $state('');
	let imageType = $state('image/png');
	let generatedSeed = $state('');
	let generatedName = $state('');
	let elapsed = $state(0);
	let controller: AbortController | undefined;
	let catalogController: AbortController | undefined;
	let workflow = $derived(data.presets.find((entry) => entry.id === current.presetId)!);
	let profile = $derived(current.profiles[current.presetId]);
	let connectionKey = $derived(JSON.stringify([provider, baseUrl, provider === 'comfyui' ? '' : apiKeyEnv]));
	let connected = $derived(!!catalog && provider === 'comfyui' && catalogKey === connectionKey);
	let hostedConnected = $derived(!!hostedCatalog && provider !== 'comfyui' && catalogKey === connectionKey);
	let filteredModels = $derived(hostedConnected ? hostedCatalog!.models.filter((entry) => `${entry.id} ${entry.name}`.toLowerCase().includes(modelSearch.trim().toLowerCase())) : []);
	let missingNodes = $derived(connected ? workflow.requiredNodeTypes.filter((node) => !catalog!.nodeTypes.includes(node)) : []);
	let usedBy = $derived(registry.find((entry) => entry.id === selected)?.usedBy ?? 0);
	let config = $derived.by(() => {
		if (provider === 'comfyui') return { provider, baseUrl, stylePrompt, workflowId: current.presetId, profile } satisfies ImagePresetConfig;
		const entries: [string, unknown][] = provider === 'xai' ? [['aspectRatio', aspectRatio], ['resolution', resolution], ['quality', quality]]
			: [['size', size], ['quality', quality], ['outputFormat', outputFormat], ['outputCompression', outputFormat === 'jpeg' || outputFormat === 'webp' ? outputCompression : undefined], ['background', background], ...(provider === 'openrouter' ? [['aspectRatio', aspectRatio], ['resolution', resolution]] as [string, unknown][] : [])];
		return { provider, baseUrl, stylePrompt, apiKeyEnv, model, options: Object.fromEntries(entries.filter(([, value]) => value !== '' && value !== undefined)) } as ImagePresetConfig;
	});
	function choose(id: string) {
		resetCatalog();
		const saved = registry.find((entry) => entry.id === id);
		selected = saved?.id ?? ''; revision = saved?.revision ?? 0; name = saved?.name ?? '';
		current = structuredClone(data.settings);
		const value = saved?.config;
		provider = value?.provider ?? 'comfyui'; baseUrl = value?.baseUrl ?? current.baseUrl; stylePrompt = value?.stylePrompt ?? '';
		apiKeyEnv = ''; model = ''; size = ''; quality = ''; outputFormat = ''; outputCompression = undefined; background = ''; aspectRatio = ''; resolution = '';
		if (value?.provider === 'comfyui') { current.presetId = value.workflowId; current.profiles[value.workflowId] = structuredClone(value.profile); }
		else if (value) {
			apiKeyEnv = value.apiKeyEnv; model = value.model;
			const options = value.options as Record<string, unknown>;
			size = String(options.size ?? ''); quality = String(options.quality ?? ''); outputFormat = String(options.outputFormat ?? '');
			outputCompression = options.outputCompression as number | undefined; background = String(options.background ?? ''); aspectRatio = String(options.aspectRatio ?? ''); resolution = String(options.resolution ?? '');
		}
		error = ''; notice = '';
		void loadCatalog();
	}
	function changeProvider(next: ImageProvider) {
		resetCatalog();
		provider = next; error = ''; notice = ''; seed = undefined;
		if (next === 'comfyui') { baseUrl = current.baseUrl; void loadCatalog(); return; }
		baseUrl = next === 'openai' ? 'https://api.openai.com/v1' : next === 'xai' ? 'https://api.x.ai/v1' : 'https://openrouter.ai/api/v1';
		model = next === 'openai' ? 'gpt-image-1.5' : next === 'xai' ? 'grok-imagine-image-2.0' : 'openai/gpt-image-2';
		const candidates = next === 'openai' ? ['OPENAI_API_KEY', 'NEWERA_OPENAI_API_KEY'] : next === 'xai' ? ['X_AI_API_KEY', 'XAI_API_KEY', 'NEWERA_XAI_API_KEY'] : ['OPENROUTER_API_KEY', 'NEWERA_OPENROUTER_API_KEY'];
		apiKeyEnv = candidates.find((key) => data.availableKeyNames.includes(key)) ?? candidates[0];
		size = next === 'xai' ? '' : '1024x1024'; quality = 'low'; outputFormat = next === 'xai' ? '' : 'png'; outputCompression = undefined; background = ''; aspectRatio = next === 'xai' ? '16:9' : ''; resolution = next === 'xai' ? '1k' : '';
		void loadCatalog();
	}
	function resetCatalog() {
		catalogController?.abort(); catalogController = undefined; loadingModels = false;
		catalog = null; hostedCatalog = null; catalogKey = ''; modelSearch = ''; connectionError = '';
	}
	async function loadCatalog() {
		catalogController?.abort();
		const pending = new AbortController(); catalogController = pending;
		loadingModels = true; connectionError = ''; const key = connectionKey;
		const connection = { provider, baseUrl, apiKeyEnv };
		try {
			const response = connection.provider === 'comfyui'
				? await fetch(`/api/images/comfyui?baseUrl=${encodeURIComponent(connection.baseUrl)}`, { signal: pending.signal, cache: 'no-store' })
				: await fetch('/api/images/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(connection), signal: pending.signal, cache: 'no-store' });
			const result = await response.json(); if (!response.ok) throw new Error(result.message);
			if (pending.signal.aborted || key !== connectionKey) return;
			if (connection.provider === 'comfyui') catalog = result; else hostedCatalog = result;
			catalogKey = key;
		} catch (cause) {
			if (!pending.signal.aborted && key === connectionKey) { connectionError = cause instanceof Error ? cause.message : '모델 목록을 불러오지 못했습니다.'; catalog = null; hostedCatalog = null; }
		} finally { if (catalogController === pending) loadingModels = false; }
	}
	async function save(event: SubmitEvent) {
		event.preventDefault(); if (saving) return; saving = true; error = ''; notice = '';
		try {
			const response = await fetch('/api/image-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: selected, revision, name, config }) });
			const result = await response.json(); if (!response.ok) throw new Error(result.message);
			registry = result.presets; choose(result.savedId); notice = '이미지 프리셋을 저장했습니다. 세션의 이미지 설정에서 선택할 수 있습니다.';
		} catch (cause) { error = cause instanceof Error ? cause.message : '프리셋을 저장하지 못했습니다.'; } finally { saving = false; }
	}
	async function remove() {
		if (saving || !selected) return; saving = true; error = ''; notice = '';
		try {
			const response = await fetch('/api/image-presets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: selected, revision }) });
			const result = await response.json(); if (!response.ok) throw new Error(result.message);
			registry = result.presets; choose(''); notice = '이미지 프리셋을 삭제했습니다.';
		} catch (cause) { error = cause instanceof Error ? cause.message : '프리셋을 삭제하지 못했습니다.'; } finally { saving = false; }
	}
	async function generate(event: SubmitEvent) {
		event.preventDefault(); if (generating) return; generating = true; error = ''; controller = new AbortController();
		const started = performance.now(); const label = name || imageProviderNames[provider];
		try {
			const response = await fetch('/api/images/generate', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, prompt, ...(provider === 'comfyui' && seed !== undefined ? { seed } : {}) }) });
			if (!response.ok) throw new Error((await response.json()).message);
			const image = await response.blob(); if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type) || !image.size) throw new Error('이미지 응답이 올바르지 않습니다.');
			if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = URL.createObjectURL(image); imageType = image.type;
			generatedSeed = response.headers.get('x-image-seed') ?? ''; generatedName = label; elapsed = Math.round((performance.now() - started) / 100) / 10;
		} catch (cause) { error = controller.signal.aborted ? '이미지 수신을 중단했습니다. 이미 실행 중인 원격 작업은 계속될 수 있습니다.' : cause instanceof Error ? cause.message : '이미지를 생성하지 못했습니다.'; }
		finally { generating = false; }
	}
	onMount(() => choose(registry[0]?.id ?? ''));
	onDestroy(() => { controller?.abort(); catalogController?.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl); });
</script>

<svelte:head><title>이미지 프리셋 · newera</title><meta name="description" content="이미지 생성 설정을 프리셋으로 저장하고 세션마다 선택합니다." /></svelte:head>
<header class="topbar"><a class="brand" href="/">newera<span>THEATER</span></a><a class="top-link" href="/">공연으로 돌아가기 ↗</a></header>
<main class="image-settings">
	<div class="intro"><p class="eyebrow">ILLUSTRATIONS</p><h1>이미지 생성 프리셋</h1><p>서버·모델·화풍을 이름으로 저장하고, 각 세션에서 사용할 프리셋을 선택하세요.</p></div>
	<div class="columns">
		<section class="configuration" aria-labelledby="settings-heading"><h2 id="settings-heading">프리셋 관리</h2>
			<label>저장한 프리셋<select value={selected} onchange={(event) => choose(event.currentTarget.value)} disabled={saving || generating}><option value="">새 프리셋 만들기</option>{#each registry as entry}<option value={entry.id}>{entry.name} · {imageProviderNames[entry.provider]}</option>{/each}</select></label>
			{#if selected}<p class="field-hint">{usedBy}개 세션에서 사용 중입니다. 변경 사항은 다음 이미지 생성부터 적용됩니다.</p>{/if}
			<form onsubmit={save} class="settings-form">
				<label>프리셋 이름<input bind:value={name} maxlength="100" required disabled={saving || generating} placeholder="예: 학원물 삽화 · Anima" /></label>
				<label>이미지 Provider<select value={provider} onchange={(event) => changeProvider(event.currentTarget.value as ImageProvider)} disabled={saving || generating}>{#each Object.entries(imageProviderNames) as [id, label]}<option value={id}>{label}</option>{/each}</select></label>
				<label>이미지 서버 주소<input type="url" bind:value={baseUrl} required disabled={saving || generating} /></label>
				{#if provider === 'comfyui'}
					<button type="button" onclick={loadCatalog} disabled={loadingModels || generating}>{loadingModels ? '모델 조회 중…' : '서버 모델 불러오기'}</button>
					{#if connectionError}<p class="feedback error" role="alert">{connectionError}</p>{:else if connected}<p class="connection" role="status">서버 연결됨 · 모델 목록을 불러왔습니다.</p>{/if}
					<label>워크플로우<select bind:value={current.presetId} disabled={generating || saving}>{#each data.presets as entry}<option value={entry.id}>{entry.name}</option>{/each}</select></label><p class="field-hint">{workflow.description}</p>
					{#if missingNodes.length}<p class="feedback error" role="alert">서버에 필요한 노드가 없습니다: {missingNodes.join(', ')}</p>{/if}
					{#each workflow.models as field (`${workflow.id}-${field.field}`)}<label>{field.label}<select bind:value={profile.models[field.field]} required={field.required} disabled={!connected || generating || saving}><option value="">{field.required ? '모델을 선택하세요' : '사용 안 함'}</option>{#if profile.models[field.field] && !catalog?.models[field.field].includes(profile.models[field.field])}<option value={profile.models[field.field]}>{profile.models[field.field]} (현재 목록에 없음)</option>{/if}{#each catalog?.models[field.field] ?? [] as filename}<option value={filename}>{filename}</option>{/each}</select></label>{/each}
					{#if workflow.id === 'zit-moody' && profile.models.lora}<label>LoRA 강도<input type="number" bind:value={profile.loraStrength} min="-2" max="2" step="0.05" required disabled={generating || saving} /></label>{/if}
					<div class="dimensions"><label>기본 가로 (px)<input type="number" bind:value={profile.width} min="64" max="4096" step="8" required disabled={generating || saving} /></label><label>기본 세로 (px)<input type="number" bind:value={profile.height} min="64" max="4096" step="8" required disabled={generating || saving} /></label></div>
					<p class="field-hint">{workflow.outputScale === 1 ? '기본 크기가 최종 이미지 크기입니다.' : 'ZIT는 기본 크기를 1.8배 확대한 뒤 세부 묘사를 생성합니다.'}</p>
					{#if workflow.bindings.negativePrompt}<label>네거티브 프롬프트<textarea bind:value={profile.negativePrompt} rows="4" maxlength="32000" disabled={generating || saving}></textarea></label>{/if}
				{:else}
					<label>API 키 환경 변수<input bind:value={apiKeyEnv} list="image-key-names" required disabled={saving || generating} /></label><datalist id="image-key-names">{#each data.availableKeyNames as key}<option value={key}></option>{/each}</datalist><p class="field-hint">환경 변수 이름만 저장합니다. API 키 값은 프리셋에 포함하지 않습니다.</p>
					<button type="button" onclick={loadCatalog} disabled={loadingModels || generating || saving}>{loadingModels ? '모델 조회 중…' : '서버 모델 불러오기'}</button>
					{#if connectionError}<p class="feedback error" role="alert">{connectionError} 모델 ID를 직접 입력할 수도 있습니다.</p>{:else if hostedConnected}<p class="connection" role="status">이미지 생성 모델 {hostedCatalog!.models.length}개를 불러왔습니다.{hostedCatalog!.filter === 'model-family' ? ' OpenAI는 기능 정보를 제공하지 않아 GPT Image 계열 ID로 필터링합니다.' : ''}</p>{/if}
					<label>모델 검색<input type="search" bind:value={modelSearch} placeholder="이름이나 ID로 검색" disabled={!hostedConnected || saving || generating} /></label>
					<label>이미지 생성 모델<select value={model} onchange={(event) => { model = event.currentTarget.value; }} disabled={!hostedConnected || saving || generating}><option value="">목록에서 선택하세요</option>{#if model && !filteredModels.some((entry) => entry.id === model)}<option value={model}>{model} (현재 선택)</option>{/if}{#each filteredModels as entry (entry.id)}<option value={entry.id}>{entry.name === entry.id ? entry.id : `${entry.name} · ${entry.id}`}</option>{/each}</select></label>
					{#if hostedConnected && !filteredModels.length}<p class="field-hint">{modelSearch.trim() ? '검색 결과가 없습니다.' : '표시할 이미지 생성 모델이 없습니다.'}</p>{/if}
					<label>모델 ID<input bind:value={model} maxlength="200" required disabled={saving || generating} /></label><p class="field-hint">목록 선택과 직접 입력을 모두 지원합니다. 목록을 다시 불러와도 선택한 모델은 유지됩니다.</p>
					{#if provider !== 'xai'}<label>이미지 크기<input bind:value={size} placeholder="1024x1024 · 비워두면 모델 기본값" disabled={saving || generating} /></label>{/if}
					<label>품질<select bind:value={quality} disabled={saving || generating}><option value="">모델 기본값</option>{#each (provider === 'xai' ? ['auto', 'low', 'medium'] : provider === 'openai' ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto', 'low', 'medium', 'high']) as value}<option value={value}>{value}</option>{/each}</select></label>
					{#if provider !== 'openai'}<label>화면 비율<input bind:value={aspectRatio} placeholder="16:9 · 비워두면 모델 기본값" disabled={saving || generating} /></label><label>해상도<select bind:value={resolution} disabled={saving || generating}><option value="">모델 기본값</option>{#each (provider === 'xai' ? ['1k', '2k'] : ['512', '768', '1K', '1.5K', '2K', '4K']) as value}<option value={value}>{value}</option>{/each}</select></label>{/if}
					{#if provider !== 'xai'}<label>출력 형식<select bind:value={outputFormat} disabled={saving || generating}><option value="">모델 기본값</option>{#each ['png', 'jpeg', 'webp'] as value}<option value={value}>{value}</option>{/each}</select></label><label>배경<select bind:value={background} disabled={saving || generating}><option value="">모델 기본값</option><option value="auto">자동</option><option value="opaque">불투명</option><option value="transparent">투명</option></select></label>{#if outputFormat === 'jpeg' || outputFormat === 'webp'}<label>출력 압축률 · 선택<input type="number" bind:value={outputCompression} min="0" max="100" step="1" disabled={saving || generating} /></label>{/if}{/if}
				{/if}
				<label>화풍 지침 · 선택<textarea bind:value={stylePrompt} rows="3" maxlength="4000" disabled={saving || generating} placeholder="예: 따뜻한 색감의 수채화 삽화. 장면 프롬프트 앞에 적용합니다."></textarea></label>
				<div class="buttons"><button class="primary" disabled={saving || generating}>{saving ? '저장 중…' : '프리셋 저장'}</button>{#if selected}<button type="button" onclick={() => { selected = ''; revision = 0; name += ' 복사'; notice = ''; }} disabled={saving || generating}>복사해서 새로 만들기</button><button type="button" class="danger-button" onclick={remove} disabled={saving || generating || usedBy > 0}>프리셋 삭제</button>{/if}</div>
			</form>
			{#if notice}<p class="feedback" role="status">{notice}</p>{/if}
		</section>
		<section class="generation" aria-labelledby="test-heading"><h2 id="test-heading">삽화 테스트</h2><p class="field-hint">화면의 설정으로 한 장을 생성합니다. OpenAI·xAI·OpenRouter 테스트는 유료 API를 호출합니다.</p>
			<form onsubmit={generate} class="settings-form"><label>그릴 장면<textarea bind:value={prompt} rows="5" maxlength="32000" required disabled={generating}></textarea></label>{#if provider === 'comfyui'}<label>Seed · 비워두면 무작위<input type="number" bind:value={seed} min="0" max="281474976710655" step="1" placeholder="무작위" disabled={generating} /></label>{/if}<div class="buttons"><button class="primary" disabled={generating || saving || (provider === 'comfyui' ? !connected || !!missingNodes.length || workflow.models.some((field) => field.required && !profile.models[field.field]) : !model || !apiKeyEnv)}>테스트 이미지 생성</button>{#if generating}<button type="button" onclick={() => controller?.abort()}>생성 수신 중단</button>{/if}</div></form>
			{#if generating}<p class="connection" role="status">이미지를 생성하고 있습니다. 완료되면 여기에 표시됩니다.</p>{/if}{#if error}<p class="feedback error" role="alert">{error}</p>{/if}
			<div class="preview" aria-busy={generating}>{#if imageUrl}<img src={imageUrl} alt={`${generatedName} 테스트 삽화`} /><div class="image-details"><span>{generatedName} · {elapsed}초{generatedSeed ? ` · Seed ${generatedSeed}` : ''}</span><a href={imageUrl} download={`newera-image.${imageType === 'image/jpeg' ? 'jpg' : imageType === 'image/webp' ? 'webp' : 'png'}`}>이미지 내려받기 ↓</a></div>{:else}<div class="empty-preview"><span>장면을 그려보세요</span><p>생성한 이미지는 이곳에 표시됩니다.</p></div>{/if}</div>
			<p class="field-hint">프리셋을 저장한 뒤 공연 화면의 이미지 설정에서 세션별로 선택하세요. 결과 이미지는 브라우저에 표시하며, 공연 중 자동 삽화는 아직 연결하지 않았습니다.</p>
		</section>
	</div>
</main>

<style>
	.image-settings { max-width: 1240px; margin: auto; padding: 36px 28px 64px; }
	.intro { margin-bottom: 30px; } h1 { font-size: 30px; font-weight: 500; margin: 0 0 14px; } h2 { font-size: 18px; font-weight: 500; margin: 0 0 20px; }
	.intro > p:last-child { color: var(--muted); line-height: 1.8; }
	.columns { display: grid; grid-template-columns: minmax(300px, 440px) minmax(0, 1fr); gap: 32px; align-items: start; }
	.configuration, .generation { min-width: 0; border: 1px solid var(--line); background: #202024; padding: 24px; border-radius: 5px; }
	.dimensions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .connection { color: #b7c5a9; font-size: 12px; line-height: 1.8; }
	.buttons { display: flex; gap: 10px; flex-wrap: wrap; } .preview { margin-top: 24px; border: 1px solid var(--line); background: #19191c; }
	.preview img { display: block; width: 100%; max-height: 720px; object-fit: contain; } .empty-preview { min-height: 300px; display: flex; flex-direction: column; justify-content: center; align-items: center; color: #a99981; padding: 20px; text-align: center; }
	.empty-preview span { font-family: Georgia, serif; font-size: 23px; } .empty-preview p { color: var(--muted); font-size: 12px; }
	.image-details { padding: 14px; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
	@media (max-width: 760px) { .columns { grid-template-columns: 1fr; gap: 20px; } .image-settings { padding: 28px 16px; } .configuration, .generation { padding: 18px; } }
</style>
