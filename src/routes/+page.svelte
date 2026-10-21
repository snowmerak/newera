<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { actorName, residents, templateFor, interactionsFor } from '$lib/theater/runtime';
	import type { PageProps } from './$types';
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
	const submitTurn: SubmitFunction = () => {
		submitting = true;
		return async ({ update }) => { try { await update(); } finally { submitting = false; } };
	};
	$effect(() => {
		if (targetId && !characters.some((instance) => instance.id === targetId)) targetId = '';
	});
	$effect(() => {
		const generation = data.generation;
		if (!generation || !['pending', 'running'].includes(generation.status)) return;
		const controller = new AbortController();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const response = await fetch(`/api/generation?id=${encodeURIComponent(generation!.id)}`, { signal: controller.signal, cache: 'no-store' });
				if (!response.ok) throw new Error('생성 상태를 확인하지 못했습니다.');
				const result = await response.json();
				if (!result.generation || !['pending', 'running'].includes(result.generation.status)) {
					if (!stopped) await invalidateAll();
					return;
				}
			} catch { if (stopped) return; }
			if (!stopped) timer = setTimeout(poll, 1000);
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
		<div class="event-thread" aria-live="polite">
			{#each events as event (event.id)}
				{@const eventScene = world.definition.scenes.find((entry) => entry.id === event.sceneId)}
				<article class="stage-event" class:player={event.actorId === 'player'} class:dialogue={event.kind === 'speak'}>
					<div class="event-byline"><strong>{actorName(world, event.actorId)}</strong><span>{eventScene?.name} · {event.tick}</span>{#if event.targetId}<span>→ {actorName(world, event.targetId)}</span>{/if}</div>
					<p>{event.text}</p>
					{#if event.changes && Object.keys(event.changes).length}<small class="state-change">{Object.entries(event.changes).map(([key, value]) => `${key}: ${value}`).join(' · ')}</small>{/if}
					{#if event.decision}<details class="decision-detail"><summary>선택 기록</summary><small>{event.decision.acted === undefined ? '이전 판단' : event.decision.acted ? '행동한다' : '지켜본다'} · {event.decision.choice} · 판단 {event.decision.model}{#if event.decision.generationModel} · 생성 {event.decision.generationModel}{/if}</small></details>{/if}
				</article>
			{:else}<div class="empty-stage"><p>아직 아무도 말을 꺼내지 않았다.</p><span>말을 걸거나, 주변 사물을 살피거나, 잠시 기다려 보세요.</span></div>{/each}
		</div>
		{#if generating}<p class="generation-status" role="status">현장의 인물들이 각자의 다음 행동을 고르고 있습니다…</p>{/if}
		{#if data.generation?.status === 'failed'}<p class="feedback error" role="alert">{data.generation.error}</p>{/if}
		{#if form?.message}<p class="feedback" role="status">{form.message}</p>{/if}
		<section class="player-console"><p class="eyebrow">YOUR NEXT LINE</p>
			<form method="POST" action="?/turn" use:enhance={submitTurn} class="speech-form">
				<input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><input type="hidden" name="kind" value="speak" />
				<label>누구에게<select name="targetId" bind:value={targetId} disabled={busy}><option value="">현장에 있는 모두에게</option>{#each characters as instance}<option value={instance.id}>{instance.name}</option>{/each}</select></label>
				<label class="speech-input">나의 말<textarea name="text" rows="3" placeholder="지금 하고 싶은 말을 적어 주세요." maxlength="4000" required disabled={busy}></textarea></label>
				<button class="primary" disabled={busy}>말하기</button>
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
		<details class="world-notes"><summary>세계관과 현재 인물의 기억</summary><p>{world.definition.description}</p><p>{world.definition.rules}</p>{#each characters as instance}<h3>{instance.name}</h3>{#if instance.memo}<p>메모: {instance.memo.summary}</p><p>현재 의도: {instance.memo.currentIntention}</p><p>감정: {instance.memo.feelings.join(', ') || '없음'}</p><p>미해결 문제: {instance.memo.openThreads.join(', ') || '없음'}</p>{/if}<ul>{#each instance.memories.slice(-8) as memory}<li>{memory.text}</li>{:else}<li>아직 기억한 사건이 없습니다.</li>{/each}</ul>{/each}</details>
		<footer class="reader-footer"><a href={`/session/export?worldId=${encodeURIComponent(world.id)}`}>공연 기록 내려받기</a><details><summary>처음부터 다시</summary><p>현재 진행을 초기 배치로 되돌립니다. 저장 슬롯은 유지됩니다.</p><form method="POST" action="?/reset" use:enhance><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><button disabled={busy}>현재 진행 초기화</button></form></details></footer>
	</main>
</div>
