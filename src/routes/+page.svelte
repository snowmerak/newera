<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { EventRecord } from '$lib/game/types';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { tick } from 'svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let loreOpen = $state(false);
	let sidebarHidden = $state(false);
	let busy = $state(false);
	let chatThread: HTMLDivElement;
	let targetId = $derived(data.selectedTargetId);
	let selected = $derived(data.characters.find((character) => character.id === targetId) ?? null);
	let proposalCharacter = $derived(data.characters.find((character) => character.id === data.config.pendingProposal?.characterId));
	let suggestions = $derived(data.config.playerSuggestions?.turn === data.world.turn && data.config.playerSuggestions.targetId === (targetId || null)
		? data.config.playerSuggestions.options : []);
	let conversationEvents = $derived([...data.events.slice(0, 12)].reverse());
	$effect(() => {
		data.world.turn;
		data.config.pendingProposal;
		void tick().then(() => {
			if (chatThread) chatThread.scrollTop = chatThread.scrollHeight;
		});
	});
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
		loreOpen = false;
	}

	async function changeTarget(event: Event & { currentTarget: HTMLSelectElement }): Promise<void> {
		const id = event.currentTarget.value;
		busy = true;
		try {
			await goto(`/?target=${encodeURIComponent(id || 'none')}`, { replaceState: true, keepFocus: true, noScroll: true });
		} finally {
			busy = false;
		}
	}

	function timeLabel(minute: number): string {
		return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
	}

	function characterName(id: string | null): string {
		return data.characters.find((character) => character.id === id)?.name ?? '세계';
	}

	function requestText(event: EventRecord): string {
		if (event.actionId === 'advance') return '다음 장면을 기다린다.';
		if (event.summary.startsWith('플레이어 시도: ')) return event.summary.slice('플레이어 시도: '.length).split(' — ')[0];
		return event.summary;
	}

	function confirmSaveReset(event: SubmitEvent, slot: number): void {
		if (!window.confirm(`슬롯 ${slot}의 저장 데이터를 초기화할까요?\n현재 플레이 중인 진행에는 영향을 주지 않습니다.`)) {
			event.preventDefault();
		}
	}

</script>

<svelte:head>
	<title>{data.lore.title} · newera</title>
	<meta name="description" content="세계와 인물이 스스로 움직이는 성인 era 텍스트 게임" />
</svelte:head>

<div class="page">
	<header class="topbar">
		<div class="brand-group"><a class="brand" href="/">newera</a><span class="adult-label">성인용 텍스트 게임</span></div>
		<div class="top-actions">
			<button type="button" class="sidebar-toggle" aria-controls="lore-sidebar" aria-expanded={!sidebarHidden} onclick={() => (sidebarHidden = !sidebarHidden)}>{sidebarHidden ? '사이드바 열기' : '사이드바 숨기기'}</button>
			<a class="top-link" href="/lores">로어 관리</a>
			<button type="button" class="lore-toggle" aria-controls="lore-sidebar" aria-expanded={loreOpen} onclick={() => { sidebarHidden = false; loreOpen = !loreOpen; }}>로어 {loreOpen ? '닫기' : '목록'}</button>
		</div>
	</header>

	<div class="game-layout" class:sidebar-hidden={sidebarHidden}>
		<aside id="lore-sidebar" class="lore-sidebar" class:open={loreOpen} class:hidden={sidebarHidden} aria-label="로어 목록">
			<div class="lore-sidebar-inner">
				<h2 class="lore-sidebar-title">로어</h2>
				<nav class="lore-items" aria-label="로어 선택">
					{#each data.lores as lore}
						<form method="POST" action="?/switchLore" use:enhance={submit}>
							<button class="lore-item" class:active={lore.active} name="id" value={lore.id} disabled={busy || lore.active} onclick={afterLoreSwitch}>{lore.title}</button>
						</form>
					{/each}
				</nav>
				<section class="save-panel sidebar-saves" aria-label="저장 슬롯">
					<div class="save-panel-title"><h2>저장 슬롯</h2><span>{data.saves.length}/3 사용 중</span></div>
					<div class="save-slots">{#each [1, 2, 3] as number}
						{@const saved = data.saves.find((save) => save.slot === number)}
						<div class="save-slot"><div><strong>슬롯 {number}</strong><span>{saved ? `${saved.turn}턴 저장 · ${new Date(saved.savedAt).toLocaleString('ko-KR')}` : '비어 있음'}</span></div>
							<div class="save-slot-actions">
								<form method="POST" action="?/save" use:enhance={submit}><button name="slot" value={number} disabled={busy}>저장</button></form>
								<form method="POST" action="?/load" use:enhance={submit}><button name="slot" value={number} disabled={busy || !saved}>불러오기</button></form>
								<form method="POST" action="?/resetSave" use:enhance={submit} onsubmit={(event) => confirmSaveReset(event, number)}><button class="reset-save" name="slot" value={number} disabled={busy || !saved}>초기화</button></form>
							</div>
						</div>
					{/each}</div>
				</section>
			</div>
		</aside>

		<main class="reader">
			<div class="lore-heading"><div><p class="eyebrow">PLAYING LORE</p><h1>{data.lore.title}</h1></div><a href="/lores">설정 관리 →</a></div>
			<section class="session-panel" aria-label="현재 세션">
				<div><span class="eyebrow">현재 세션 · 자동 저장</span><strong>{data.world.day}일차 {timeLabel(data.world.minute)}</strong><small>{data.world.location} · {data.world.turn}턴</small></div>
			</section>

			<section class="conversation-panel" aria-label="대화와 장면">
				<div class="scene-meta"><span>TURN {data.world.turn}</span><span>{data.world.day}일차 · {timeLabel(data.world.minute)}</span><span>{data.world.location}</span></div>
				<div class="chat-thread" role="log" bind:this={chatThread}>
					{#if conversationEvents.length}
						{#each conversationEvents as event}
							<div class="chat-turn">
								<article class="chat-message player-message">
									<div class="chat-message-meta"><strong>나</strong><span>{event.day}일차 {timeLabel(event.minute)}</span></div>
									<p>{requestText(event)}</p>
								</article>
								<article class="chat-message story-message">
									<div class="chat-message-meta"><strong>{characterName(event.characterId)}</strong><span>{event.location}</span></div>
									{#each event.narrative.split('\n\n') as paragraph}<p>{paragraph}</p>{/each}
								</article>
							</div>
						{/each}
					{:else}
						<article class="chat-message story-message initial-message">
							<div class="chat-message-meta"><strong>세계</strong><span>{data.world.location}</span></div>
							{#each data.latestNarrative.split('\n\n') as paragraph}<p>{paragraph}</p>{/each}
						</article>
					{/if}
					{#if data.config.pendingProposal}
						<article class="chat-message story-message proposal-message" aria-label="등장인물의 제안">
							<div class="chat-message-meta"><strong>{proposalCharacter?.name ?? '등장인물'}</strong><span>제안</span></div>
							<p>{data.config.pendingProposal.text}</p>
						</article>
					{/if}
				</div>
			</section>

			<section class="request-panel" aria-label="행동 요청">
				<div class="request-panel-head">
					<div><h2>무엇을 할까요?</h2><p>{selected ? `${selected.name}에게 할 행동을 선택하거나 직접 입력하세요.` : '행동을 선택하거나 직접 입력하세요.'}</p></div>
					<div class="target-row">
						<label for="target">대상</label>
						<select id="target" value={targetId} onchange={changeTarget} disabled={busy}>
							<option value="">지정 안 함</option>
							{#each data.characters as character}<option value={character.id}>{character.name}</option>{/each}
						</select>
					</div>
				</div>

				{#if data.config.pendingProposal}
					<div class="quick-replies proposal-replies" aria-label="제안에 답하기">
						<form method="POST" action="?/proposal" use:enhance={submit}><button class="accent" name="answer" value="accept" disabled={busy}>수락한다</button></form>
						<form method="POST" action="?/proposal" use:enhance={submit}><button name="answer" value="decline" disabled={busy}>거절한다</button></form>
					</div>
				{:else if suggestions.length}
					<form method="POST" action="?/freeAct" use:enhance={submit} class="quick-replies" aria-label="추천 행동">
						<input type="hidden" name="targetId" value={targetId} />
						{#each suggestions as suggestion, index}
							<button name="text" value={suggestion} disabled={busy}><span>{index + 1}</span>{suggestion}</button>
						{/each}
					</form>
				{/if}

				<form method="POST" action="?/freeAct" use:enhance={submit} class="composer-form">
					<input type="hidden" name="targetId" value={targetId} />
					<label class="sr-only" for="free-action">직접 행동 입력</label>
					<textarea id="free-action" name="text" rows="2" required placeholder={selected ? `${selected.name}에게 하고 싶은 행동을 적어 주세요` : '주변을 살피거나 이동하는 등 원하는 행동을 적어 주세요'}></textarea>
					<button disabled={busy}>보내기</button>
				</form>

				<div class="request-footer">
					<form method="POST" action="?/advance" use:enhance={submit}><button class="continue-button" disabled={busy}>아무 행동 없이 다음 장면으로 <span aria-hidden="true">→</span></button></form>
					<p>인물을 지정하지 않으면 이동·탐색·휴식 같은 행동을 할 수 있습니다.</p>
				</div>
			</section>

			{#if busy}<p class="feedback" role="status">세계와 인물이 다음 장면을 만들고 있어요…</p>{/if}
			{#if form?.message}<p class="feedback" class:error={form.level === 'error'} role="status">{form.message}</p>{/if}

			<div class="details-area">
				<details><summary>상태와 기억</summary>
					{#if selected}
						<h3>{selected.name}</h3>
						<p class="minor">{selected.trait.join(' · ')} · 호감 {selected.relations.player.affection} · 신뢰 {selected.relations.player.trust} · 욕망 {selected.relations.player.desire}</p>
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
