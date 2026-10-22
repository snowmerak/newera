<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { actorName, residents, templateFor, interactionsFor } from '$lib/theater/runtime';
	import { eventContent } from '$lib/theater/event-content';
	import { relationshipMetrics } from '$lib/theater/types';
	import { relationshipLabels } from '$lib/theater/reflection';
	import { memoryForEvent } from '$lib/theater/memory';
	import type { ModelSelection } from '$lib/theater/types';
	import type { PageProps } from './$types';
	import CharacterIntroduction from '$lib/components/CharacterIntroduction.svelte';
	let { data, form }: PageProps = $props();
	let submitting = $state(false);
	let targetId = $state('');
	let world = $derived(data.world);
	let scene = $derived(world.definition.scenes.find((entry) => entry.id === world.state.activeSceneId)!);
	let present = $derived(residents(world));
	let characters = $derived(present.filter((instance) => templateFor(world, instance).kind === 'character'));
	let objects = $derived(present.filter((instance) => templateFor(world, instance).kind === 'object'));
	let companions = $derived(world.state.instances.filter((instance) => instance.active && instance.companion));
	let generating = $derived(data.generation?.status === 'pending' || data.generation?.status === 'running');
	let busy = $derived(submitting || generating);
	let events = $derived(world.state.events.slice(-100));
	let eventsById = $derived(new Map(world.state.events.map((event) => [event.id, event])));
	let firstAppearance = $derived.by(() => {
		const first = new Map<string, string>();
		for (const event of events) if (!first.has(event.actorId)) first.set(event.actorId, event.id);
		return first;
	});
	let modelCatalog = $state<{ models: string[]; defaults: ModelSelection } | null>(null);
	let modelsLoading = $state(false);
	let modelsSaving = $state(false);
	let modelsError = $state('');
	let decisionModel = $state('');
	let textModel = $state('');
	let modelContext = $derived(JSON.stringify([world.id, world.models?.decisionModel ?? null, world.models?.textModel ?? null]));
	$effect(() => {
		const [, savedDecision, savedText] = JSON.parse(modelContext) as [string, string | null, string | null];
		decisionModel = savedDecision ?? modelCatalog?.defaults.decisionModel ?? '';
		textModel = savedText ?? modelCatalog?.defaults.textModel ?? '';
	});
	async function loadModels() {
		if (modelsLoading) return;
		modelsLoading = true;
		modelsError = '';
		try {
			const response = await fetch('/api/models', { cache: 'no-store' });
			const catalog = await response.json();
			if (!response.ok) throw new Error(catalog.message || '모델 목록을 불러오지 못했습니다.');
			modelCatalog = catalog;
		} catch (error) { modelsError = error instanceof Error ? error.message : '모델 목록을 불러오지 못했습니다.'; }
		finally { modelsLoading = false; }
	}
	const submitModels: SubmitFunction = () => {
		modelsSaving = true;
		return async ({ update, result }) => {
			try {
				await update({ reset: false });
				if (result.type === 'success') {
					const saved = result.data?.models as ModelSelection | null;
					decisionModel = saved?.decisionModel ?? modelCatalog?.defaults.decisionModel ?? '';
					textModel = saved?.textModel ?? modelCatalog?.defaults.textModel ?? '';
				}
			} finally { modelsSaving = false; }
		};
	};
	const submitTurn: SubmitFunction = () => {
		submitting = true;
		return async ({ update }) => { try { await update(); } finally { submitting = false; } };
	};
	$effect(() => {
		if (targetId && !characters.some((instance) => instance.id === targetId)) targetId = '';
	});
	$effect(() => {
		const generation = data.generation;
		const revision = data.world.revision;
		if (!generation || !['pending', 'running'].includes(generation.status)) return;
		const controller = new AbortController();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const response = await fetch(`/api/generation?id=${encodeURIComponent(generation!.id)}`, { signal: controller.signal, cache: 'no-store' });
				if (!response.ok) throw new Error('생성 상태를 확인하지 못했습니다.');
				const result = await response.json();
				if (!result.generation || result.generation.revision > revision || !['pending', 'running'].includes(result.generation.status)) {
					if (!stopped) await invalidateAll();
					return;
				}
			} catch { if (stopped) return; }
			if (!stopped) timer = setTimeout(poll, 250);
		}
		timer = setTimeout(poll, 300);
		return () => { stopped = true; controller.abort(); clearTimeout(timer); };
	});
	const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
</script>

<svelte:head><title>{world.definition.name} · newera</title><meta name="description" content="씬과 인물의 선택으로 이어지는 이야기" /></svelte:head>
<header class="topbar"><a class="brand" href="/">newera<span>THEATER</span></a><a class="top-link" href="/lores">세계관과 무대 편집 ↗</a></header>
<div class="theater-layout">
	<aside class="catalog">
		<p class="eyebrow">WORLDS</p>
		{#each data.worlds as entry}
			<form method="POST" action="?/selectWorld" use:enhance>
				<input type="hidden" name="worldId" value={entry.id} />
				<button class:current={entry.id === world.id} class="world-link" disabled={entry.id === world.id}>{entry.name}</button>
			</form>
		{/each}
		<div class="sidebar-section"><p class="eyebrow">COMPANIONS</p>
			{#each companions as instance}<p class="companion-name">{instance.name}<small>함께 이동하는 동행</small></p>{:else}<p class="muted">아직 동행이 없습니다.</p>{/each}
		</div>
		<div class="sidebar-section"><p class="eyebrow">SAVE SLOTS</p>
			{#each [1, 2, 3] as slot}
				{@const save = data.saves.find((entry) => entry.slot === slot)}
				<div class="save-slot"><span>{slot} · {save ? `${save.tick}회 진행` : '비어 있음'}</span><div class="button-row">
					<form method="POST" action="?/save" use:enhance><input type="hidden" name="worldId" value={world.id} /><button name="slot" value={slot}>저장</button></form>
					<form method="POST" action="?/load" use:enhance><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><button name="slot" value={slot} disabled={!save || submitting}>불러오기</button></form>
				</div></div>
			{/each}
		</div>
	</aside>
	<main class="stage-reader">
		<div class="scene-heading"><div><p class="eyebrow">SCENE / {world.state.tick}</p><h1>{scene.name}</h1></div><span>{world.state.day}일차 · {clock(world.state.minute)}</span></div>
		<p class="scene-description">{scene.description}</p>
		<div class="cast-strip" aria-label="현재 씬의 등장인물">
			{#each characters as instance}<span class:companion={instance.companion}>{instance.name}{instance.companion ? ' · 동행' : ''}</span>{:else}<span>지금 이곳에는 나 혼자 있다.</span>{/each}
		</div>
		{#if characters.length}<section class="cast-introductions" aria-label="현재 등장인물 소개">
			{#each characters as instance (instance.id)}<details class="cast-introduction"><summary>{instance.name}{#if instance.companion}<small>동행</small>{/if}<span>인물 소개</span></summary><CharacterIntroduction {instance} /></details>{/each}
		</section>{/if}
		<details class="model-settings" ontoggle={(event) => { if (event.currentTarget.open && !modelCatalog) void loadModels(); }}>
			<summary>이 세션의 모델 설정</summary>
			<small>판단: {world.models?.decisionModel ?? modelCatalog?.defaults.decisionModel ?? '기본 설정'} · 생성: {world.models?.textModel ?? modelCatalog?.defaults.textModel ?? '기본 설정'}</small>
			<p>현재 세계관의 다음 진행부터 적용됩니다. 진행 중인 작업은 시작할 때 선택한 모델을 유지합니다.</p>
			<form method="POST" action="?/models" use:enhance={submitModels} class="model-form">
				<input type="hidden" name="worldId" value={world.id} />
				<label>판단 모델<select name="decisionModel" bind:value={decisionModel} disabled={modelsLoading || modelsSaving || !modelCatalog} required>
					<option value="">{modelsLoading ? '목록을 불러오는 중…' : '모델을 선택하세요'}</option>
					{#if decisionModel && !modelCatalog?.models.includes(decisionModel)}<option value={decisionModel} disabled>{decisionModel} (목록에 없음)</option>{/if}
					{#each modelCatalog?.models ?? [] as model}<option value={model}>{model}</option>{/each}
				</select></label>
				<label>생성 모델<select name="textModel" bind:value={textModel} disabled={modelsLoading || modelsSaving || !modelCatalog} required>
					<option value="">{modelsLoading ? '목록을 불러오는 중…' : '모델을 선택하세요'}</option>
					{#if textModel && !modelCatalog?.models.includes(textModel)}<option value={textModel} disabled>{textModel} (목록에 없음)</option>{/if}
					{#each modelCatalog?.models ?? [] as model}<option value={model}>{model}</option>{/each}
				</select></label>
				<div class="model-buttons"><button disabled={modelsLoading || modelsSaving || !modelCatalog?.models.includes(decisionModel) || !modelCatalog?.models.includes(textModel)}>모델 적용</button><button name="mode" value="defaults" formnovalidate disabled={modelsSaving}>기본 설정 사용</button><button type="button" onclick={loadModels} disabled={modelsLoading || modelsSaving}>목록 새로고침</button></div>
			</form>
			{#if modelsError}<p class="feedback error" role="alert">{modelsError}</p>{/if}
		</details>
		<div class="event-thread" aria-live="polite">
			{#each events as event (event.id)}
				{@const eventScene = world.definition.scenes.find((entry) => entry.id === event.sceneId)}
				{@const content = eventContent(event)}
				{@const speaker = world.state.instances.find((instance) => instance.id === event.actorId)}
				<article class="stage-event" class:player={event.actorId === 'player'} class:dialogue={event.kind === 'speak'}>
					<div class="event-byline"><strong>{actorName(world, event.actorId)}</strong><span>{eventScene?.name} · {event.tick}</span>{#if event.targetId}<span>→ {actorName(world, event.targetId)}</span>{/if}</div>
					{#if speaker && templateFor(world, speaker).kind === 'character' && firstAppearance.get(speaker.id) === event.id}
						<aside class="event-introduction" aria-label={`${speaker.name} 인물 소개`}><CharacterIntroduction instance={speaker} /></aside>
					{/if}
					{#if content.narrative}<div class="event-action"><span class="event-content-label">행동</span><p>{content.narrative}</p></div>{/if}
					{#if content.utterance}<div class="event-speech"><span class="event-content-label">대사</span><blockquote>{content.utterance}</blockquote></div>{/if}
					{#if event.changes && Object.keys(event.changes).length}<small class="state-change">{Object.entries(event.changes).map(([key, value]) => `${key}: ${value}`).join(' · ')}</small>{/if}
					{#if event.decision}<details class="decision-detail"><summary>선택 기록</summary><small>{event.decision.acted === undefined ? '이전 판단' : event.decision.acted ? '행동한다' : '지켜본다'} · {event.decision.choice} · 판단 {event.decision.model}{#if event.decision.generationModel} · 생성 {event.decision.generationModel}{/if}</small></details>{/if}
				</article>
			{:else}<div class="empty-stage"><p>아직 아무도 말을 꺼내지 않았다.</p><span>말을 걸거나, 주변 사물을 살피거나, 잠시 기다려 보세요.</span></div>{/each}
		</div>
		{#if generating}<p class="generation-status" role="status">현장의 인물들이 각자의 다음 행동을 고르고 있습니다…{#if data.generation?.progress} (판단 {data.generation.progress.completedDecisions}회 · 대기 {data.generation.progress.pendingActorIds.length}명){/if}</p>{/if}
		{#if data.generation?.status === 'failed'}<p class="feedback error" role="alert">{data.generation.error} 이미 확정된 말과 행동은 유지됩니다.</p>{/if}
		{#if form?.message}<p class="feedback" role="status">{form.message}</p>{/if}
		<section class="player-console"><p class="eyebrow">YOUR NEXT LINE</p>
			<form method="POST" action="?/turn" use:enhance={submitTurn} class="speech-form">
				<input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><input type="hidden" name="kind" value="speak" />
				<label>누구에게<select name="targetId" bind:value={targetId} disabled={submitting}><option value="">현장에 있는 모두에게</option>{#each characters as instance}<option value={instance.id}>{instance.name}</option>{/each}</select></label>
				<label class="speech-input">나의 말<textarea name="text" rows="3" placeholder="지금 하고 싶은 말을 적어 주세요." maxlength="4000" required disabled={submitting}></textarea></label>
				<button class="primary" disabled={submitting}>말하기</button>
			</form>
			<div class="stage-options">
				<form method="POST" action="?/turn" use:enhance={submitTurn}><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><button name="kind" value="wait" disabled={busy}>잠시 지켜본다</button></form>
				{#each scene.exits as exit}{@const destination = world.definition.scenes.find((entry) => entry.id === exit)!}<form method="POST" action="?/turn" use:enhance={submitTurn}><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><input type="hidden" name="kind" value="move" /><button name="destinationId" value={exit} disabled={busy}>{destination.name}(으)로 →</button></form>{/each}
			</div>
		</section>
		{#if objects.length}<section class="objects-panel"><p class="eyebrow">ON THE SCENE</p><div class="object-grid">
			{#each objects as instance}<article class="object-card"><h3>{instance.name}</h3><p>{templateFor(world, instance).description}</p><small>{Object.entries(instance.state).map(([key, value]) => `${key}: ${value}`).join(' · ')}</small><div class="stage-options">
				{#each interactionsFor(world, instance) as interaction}<form method="POST" action="?/turn" use:enhance={submitTurn}><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><input type="hidden" name="kind" value="interact" /><input type="hidden" name="targetId" value={instance.id} /><button name="interactionId" value={interaction.id} disabled={busy}>{interaction.label}</button></form>{/each}
			</div></article>{/each}
		</div></section>{/if}
		<details class="world-notes"><summary>세계관과 현재 인물의 기억</summary><p>{world.definition.description}</p><p>{world.definition.rules}</p>
			{#each characters as instance}<h3>{instance.name}</h3>
				<details class="relationship-notes"><summary>상대별 관계 · 이 인물의 개인적 인식</summary>
					{#each Object.entries(instance.relationships ?? {}) as [id, relation]}
						<article><h4>{actorName(world, id)}</h4><dl>{#each relationshipMetrics as metric}<div><dt>{relationshipLabels[metric]}</dt><dd>{relation[metric] ?? '미평가'}</dd></div>{/each}</dl>
						<p>{relation.impression || '아직 정리한 인식이 없습니다.'}</p>
						{#if relation.evidenceEventIds.length}<details><summary>인식의 근거 {relation.evidenceEventIds.length}건</summary><ul>{#each relation.evidenceEventIds as eventId}{@const source = eventsById.get(eventId)}<li>{#if source}{actorName(world, source.actorId)} · {source.text}{:else}{eventId}{/if}</li>{/each}</ul></details>{:else}<small>초기 설정 또는 편집한 관계</small>{/if}</article>
					{:else}<p>아직 평가한 상대가 없습니다. 미평가는 중간 점수와 다릅니다.</p>{/each}
				</details>
				{#if instance.memo}<p>메모: {instance.memo.summary}</p><p>현재 의도: {instance.memo.currentIntention}</p><p>감정: {instance.memo.feelings.join(', ') || '없음'}</p><p>미해결 문제: {instance.memo.openThreads.join(', ') || '없음'}</p>{/if}
				<ul>{#each instance.memories.slice(-8) as memory}
					{@const event = eventsById.get(memory.eventId)}
					{@const witnessed = event ? memoryForEvent(event) : 'body' in memory ? memory : null}
					<li>{#if witnessed}
						<strong>{witnessed.actorId === 'player' ? '플레이어' : actorName(world, witnessed.actorId)}</strong>{#if witnessed.targetId} → {actorName(world, witnessed.targetId)}{/if}
						{#if witnessed.body.narrative}<p>행동: {witnessed.body.narrative}</p>{/if}
						{#if witnessed.body.utterance}<p>대사: {witnessed.body.utterance}</p>{/if}
					{:else if 'text' in memory}이전 기록 (주체 미확인): {memory.text}{/if}</li>
				{:else}<li>아직 기억한 사건이 없습니다.</li>{/each}</ul>
			{/each}
		</details>
		<footer class="reader-footer"><a href={`/session/export?worldId=${encodeURIComponent(world.id)}`}>공연 기록 내려받기</a><details><summary>처음부터 다시</summary><p>현재 진행을 초기 배치로 되돌립니다. 저장 슬롯은 유지됩니다.</p><form method="POST" action="?/reset" use:enhance><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><button disabled={busy}>현재 진행 초기화</button></form></details></footer>
	</main>
</div>
