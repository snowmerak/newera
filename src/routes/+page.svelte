<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let selectedId = $state('');
	let loreOpen = $state(false);
	let busy = $state(false);
	let targetId = $derived(data.characters.some((character) => character.id === selectedId) ? selectedId : '');
	let selected = $derived(data.characters.find((character) => character.id === targetId) ?? null);
	let proposalCharacter = $derived(data.characters.find((character) => character.id === data.config.pendingProposal?.characterId));
	let suggestions = $derived(data.config.playerSuggestions?.turn === data.world.turn && data.config.playerSuggestions.targetId === (targetId || null)
		? data.config.playerSuggestions.options : []);
	let visibleMemories = $derived.by(() => {
		const seen = new Set<string>();
		return data.memories.filter((memory) => {
			if (memory.characterId !== selected?.id || !memory.isDetail || seen.has(memory.summary)) return false;
			seen.add(memory.summary);
			return true;
		}).slice(0, 6);
	});

	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			try { await update(); } finally { busy = false; }
		};
	};

	function afterLoreSwitch(): void {
		selectedId = '';
		loreOpen = false;
	}

	function timeLabel(minute: number): string {
		return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
	}

</script>

<svelte:head>
	<title>{data.lore.title} · newera</title>
	<meta name="description" content="세계와 인물이 스스로 움직이는 성인 era 텍스트 게임" />
</svelte:head>

<div class="page">
	<header class="topbar">
		<div class="brand-group"><a class="brand" href="/">newera</a><span class="adult-label">성인용 텍스트 게임</span></div>
		<div class="top-actions"><a class="top-link" href="/lores">로어 관리</a><button type="button" class="lore-toggle" aria-expanded={loreOpen} onclick={() => (loreOpen = !loreOpen)}>로어 {loreOpen ? '닫기' : '목록'}</button></div>
	</header>

	<div class="game-layout">
		<aside class="lore-sidebar" class:open={loreOpen} aria-label="로어 목록">
			<div class="lore-sidebar-inner">
				<h2 class="lore-sidebar-title">로어</h2>
				<nav class="lore-items" aria-label="로어 선택">
					{#each data.lores as lore}
						<form method="POST" action="?/switchLore" use:enhance={submit}>
							<button class="lore-item" class:active={lore.active} name="id" value={lore.id} disabled={busy || lore.active} onclick={afterLoreSwitch}>{lore.title}</button>
						</form>
					{/each}
				</nav>
			</div>
		</aside>

		<main class="reader">
			<div class="lore-heading"><div><p class="eyebrow">PLAYING LORE</p><h1>{data.lore.title}</h1></div><a href="/lores">설정 관리 →</a></div>
			<section class="session-panel" aria-label="현재 세션">
				<div><span class="eyebrow">현재 세션 · 자동 저장</span><strong>{data.world.day}일차 {timeLabel(data.world.minute)}</strong><small>{data.world.location} · {data.world.turn}턴 · 체력 {data.player.energy}/{data.player.maxEnergy}</small></div>
			</section>
			<section class="save-panel" aria-label="저장 슬롯">
				<div class="save-panel-title"><h2>저장 슬롯</h2><span>{data.saves.length}/3 사용 중</span></div>
				<div class="save-slots">{#each [1, 2, 3] as number}
					{@const saved = data.saves.find((save) => save.slot === number)}
					<div class="save-slot"><div><strong>슬롯 {number}</strong><span>{saved ? `${saved.turn}턴 저장 · ${new Date(saved.savedAt).toLocaleString('ko-KR')}` : '비어 있음'}</span></div>
						<div class="save-slot-actions"><form method="POST" action="?/save" use:enhance={submit}><button name="slot" value={number} disabled={busy}>저장</button></form><form method="POST" action="?/load" use:enhance={submit}><button name="slot" value={number} disabled={busy || !saved}>불러오기</button></form></div>
					</div>
				{/each}</div>
			</section>
			<div class="scene-meta"><span>TURN {data.world.turn}</span><span>{data.world.day}일차 · {timeLabel(data.world.minute)}</span><span>{data.world.location}</span></div>
			<article class="scene" aria-label="현재 장면">
				{#each data.latestNarrative.split('\n\n') as paragraph}<p>{paragraph}</p>{/each}
			</article>

			{#if data.config.pendingProposal}
				<section class="proposal" aria-label="등장인물의 제안">
					<div class="eyebrow">{proposalCharacter?.name ?? '등장인물'}의 제안</div>
					<p>{data.config.pendingProposal.text}</p>
					<div class="button-row">
						<form method="POST" action="?/proposal" use:enhance={submit}><button class="accent" name="answer" value="accept" disabled={busy}>수락한다</button></form>
						<form method="POST" action="?/proposal" use:enhance={submit}><button name="answer" value="decline" disabled={busy}>거절한다</button></form>
					</div>
				</section>
			{/if}

			<section class="turn-controls" aria-label="진행과 행동">
				<form method="POST" action="?/advance" use:enhance={submit}>
					<button class="next-button" disabled={busy}>다음 장면으로 진행 <span aria-hidden="true">→</span></button>
				</form>
				<div class="or-label">또는 먼저 행동한다</div>
				<div class="target-row">
					<label for="target">상대</label>
					<select id="target" value={targetId} onchange={(event) => (selectedId = event.currentTarget.value)}>
						<option value="">세계·장소</option>
						{#each data.characters as character}<option value={character.id}>{character.name}</option>{/each}
					</select>
				</div>
				<form method="POST" action="?/suggest" use:enhance={submit}>
					<input type="hidden" name="targetId" value={targetId} />
					<button class="suggest-button" disabled={busy}>LLM에게 행동 제안 받기</button>
				</form>
				{#if suggestions.length}
					<form method="POST" action="?/freeAct" use:enhance={submit} class="suggestion-list">
						<input type="hidden" name="targetId" value={targetId} />
						{#each suggestions as suggestion, index}
							<button name="text" value={suggestion} disabled={busy}><span>{index + 1}.</span>{suggestion}</button>
						{/each}
					</form>
				{/if}
				<form method="POST" action="?/freeAct" use:enhance={submit} class="free-action-form">
					<input type="hidden" name="targetId" value={targetId} />
					<label for="free-action">직접 행동 입력</label>
					<textarea id="free-action" name="text" rows="3" required placeholder={selected ? `${selected.name}에게 하고 싶은 행동을 적어 주세요` : '이 세계에서 하고 싶은 행동을 적어 주세요'}></textarea>
					<button disabled={busy}>행동한다</button>
				</form>
				<p class="action-hint">era 행동에 해당하면 조건과 수치가 적용됩니다. 그 외 행동도 장면으로 진행됩니다.</p>
			</section>
			{#if busy}<p class="feedback">세계와 인물이 다음 장면을 만들고 있어요…</p>{/if}
			{#if form?.message}<p class="feedback" class:error={form.level === 'error'} role="status">{form.message}</p>{/if}

			<div class="details-area">
				<details><summary>상태와 기억</summary>
					<p class="minor">플레이어 체력 {data.player.energy}/{data.player.maxEnergy}</p>
					{#if selected}
						<h3>{selected.name}</h3>
						<p class="minor">{selected.trait.join(' · ')} · 호감 {selected.relation.affection} · 신뢰 {selected.relation.trust} · 욕망 {selected.relation.desire}</p>
						{#if visibleMemories.length}
							<ul class="memory-list">{#each visibleMemories as memory}<li>{memory.summary}</li>{/each}</ul>
						{:else}<p class="minor">기록된 구체적 기억은 아직 없습니다. 이전 행동은 아래 기록에서 볼 수 있습니다.</p>{/if}
					{/if}
				</details>
				<details><summary>행동 기록 · 최근 8턴</summary>
					<ol class="event-list">{#each data.events.slice(0, 8) as event}<li><span>{event.day}일차 {timeLabel(event.minute)}</span> {event.summary}</li>{/each}</ol>
				</details>
			</div>
		</main>
	</div>
</div>
