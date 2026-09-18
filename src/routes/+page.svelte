<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { Character, CharacterLore } from '$lib/game/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let selectedId = $state('');
	let loreKey = $state<string | null>(null);
	let loreOpen = $state(false);
	let busy = $state(false);
	let slot = $state(1);
	let targetId = $derived(data.characters.some((character) => character.id === selectedId) ? selectedId : '');
	let selected = $derived(data.characters.find((character) => character.id === targetId) ?? null);
	let activeWorld = $derived(data.worldLore.find((world) => world.active) ?? data.worldLore[0]);
	let currentLoreKey = $derived(loreKey ?? `world:${activeWorld?.id ?? 'base'}`);
	let loreWorld = $derived(data.worldLore.find((world) => `world:${world.id ?? 'base'}` === currentLoreKey));
	let loreCharacter = $derived(data.characterLore.find((entry) => `character:${entry.character.id}` === currentLoreKey));
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

	function timeLabel(minute: number): string {
		return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
	}

	function statsJson(character: Character): string {
		return JSON.stringify({
			base: character.base,
			trait: character.trait,
			abl: character.abl,
			exp: character.exp,
			mark: character.mark,
			relation: character.relation,
			palam: character.palam
		}, null, 2);
	}

	function chooseWorld(id: string | null): void {
		loreKey = `world:${id ?? 'base'}`;
		selectedId = '';
	}

	function chooseCharacter(entry: CharacterLore): void {
		loreKey = `character:${entry.character.id}`;
		selectedId = entry.active ? entry.character.id : '';
	}
</script>

<svelte:head>
	<title>newera</title>
	<meta name="description" content="세계와 인물이 스스로 움직이는 성인 era 텍스트 게임" />
</svelte:head>

<div class="page">
	<header class="topbar">
		<div class="brand-group"><a class="brand" href="/">newera</a><span class="adult-label">성인용 텍스트 게임</span><button type="button" class="lore-toggle" aria-expanded={loreOpen} onclick={() => (loreOpen = !loreOpen)}>로어 {loreOpen ? '닫기' : '보기'}</button></div>
		<div class="save-group">
			<select bind:value={slot} aria-label="저장 슬롯"><option value={1}>슬롯 1</option><option value={2}>슬롯 2</option><option value={3}>슬롯 3</option></select>
			<form method="POST" action="?/save" use:enhance={submit}><input type="hidden" name="slot" value={slot} /><button disabled={busy}>저장</button></form>
			<form method="POST" action="?/load" use:enhance={submit}><input type="hidden" name="slot" value={slot} /><button disabled={busy || !data.saves.some((save) => save.slot === slot)}>불러오기</button></form>
		</div>
	</header>

	<div class="game-layout">
	<aside class="lore-sidebar" class:open={loreOpen} aria-label="세계관과 등장인물 로어">
		<div class="lore-sidebar-inner">
			<div class="lore-title"><h1>로어</h1><p>세계와 인물의 설정을 고릅니다.</p></div>
			<details class="lore-import"><summary>로어 가져오기 · JSON</summary>
				<form method="POST" action="?/installModule" enctype="multipart/form-data" use:enhance={submit} class="settings-form">
					<label for="module-file">세계관·인물 모듈 파일</label><input id="module-file" type="file" name="moduleFile" accept=".json,application/json" required />
					<button disabled={busy}>설치하고 적용</button>
				</form>
				<p class="minor"><a href="/modules/example-world.json" download>세계관 예시</a> · <a href="/modules/example-character.json" download>인물 예시</a> · <a href="/modules/README.md" target="_blank" rel="noreferrer">파일 형식</a></p>
			</details>
			<section class="lore-section" aria-label="세계관 로어 목록">
				<h2>세계관</h2>
				<div class="lore-items">
					{#each data.worldLore as world}
						<button type="button" class="lore-item" class:active={world.active} class:selected={currentLoreKey === `world:${world.id ?? 'base'}`} data-lore-id={`world:${world.id ?? 'base'}`} onclick={() => chooseWorld(world.id)}>
							<span class="lore-item-name">{world.name}</span><span class="lore-item-state">{world.active ? '적용 중' : '선택'}</span>
						</button>
					{/each}
				</div>
			</section>
			<section class="lore-section" aria-label="등장인물 로어 목록">
				<h2>등장인물</h2>
				<div class="lore-items">
					{#each data.characterLore as entry}
						<button type="button" class="lore-item" class:active={entry.active} class:selected={currentLoreKey === `character:${entry.character.id}`} data-lore-id={`character:${entry.character.id}`} onclick={() => chooseCharacter(entry)}>
							<span class="lore-item-name">{entry.character.name}</span><span class="lore-item-state">{entry.active ? (targetId === entry.character.id ? '행동 대상' : '등장 중') : '미적용'}</span>
						</button>
					{/each}
				</div>
			</section>
			<section class="lore-inspector" aria-label="선택한 로어">
				{#if loreWorld}
					<div class="lore-inspector-heading"><h2>{loreWorld.name}</h2><span>{loreWorld.active ? '적용 중' : '미적용'}</span></div>
					{#if loreWorld.description}<p class="lore-description">{loreWorld.description}</p>{/if}
					<p class="lore-copy">{loreWorld.setting}</p>
					{#if loreWorld.eraRules}<h3>era 규칙</h3><p class="lore-copy">{loreWorld.eraRules}</p>{/if}
					{#if !loreWorld.active}
						<form method="POST" action="?/selectWorld" use:enhance={submit} class="lore-action"><input type="hidden" name="id" value={loreWorld.id ?? ''} /><button disabled={busy}>이 세계관 적용</button></form>
					{/if}
					{#if loreWorld.id === null}
						<details class="lore-edit"><summary>기본 세계관 편집</summary>
							<form method="POST" action="?/scenario" use:enhance={submit} class="settings-form">
								<label for="world-setting">세계관 설정</label><textarea id="world-setting" name="worldSetting" rows="6" required value={data.config.worldSetting}></textarea>
								<label for="era-rules">era 규칙과 진행 방향</label><textarea id="era-rules" name="eraRules" rows="5" required value={data.config.eraRules}></textarea>
								<button disabled={busy}>설정 저장</button>
							</form>
						</details>
					{/if}
				{:else if loreCharacter}
					{@const character = loreCharacter.character}
					<div class="lore-inspector-heading"><h2>{character.name}</h2><span>{loreCharacter.active ? '등장 중' : '미적용'}</span></div>
					<p class="lore-description">{character.age}세{character.moduleId ? ` · ${data.modules.find((module) => module.id === character.moduleId)?.name ?? character.moduleId}` : ' · 직접 설정'}</p>
					<p class="lore-copy">{character.profile}</p>
					{#if character.trait.length}<p class="lore-traits">{character.trait.join(' · ')}</p>{/if}
					{#if loreCharacter.active}
						<p class="lore-description">호감 {character.relation.affection} · 신뢰 {character.relation.trust} · 욕망 {character.relation.desire}</p>
						{#key character.id}
							<details class="lore-edit"><summary>인물 설정 편집</summary>
								<form method="POST" action="?/character" use:enhance={submit} class="settings-form">
									<input type="hidden" name="id" value={character.id} />
									<div class="form-pair"><label>이름<input name="name" required value={character.name} /></label><label>나이<input name="age" type="number" min="20" required value={character.age} /></label></div>
									<label for="character-profile">인물 설정</label><textarea id="character-profile" name="profile" rows="6" required value={character.profile}></textarea>
									<details class="nested"><summary>era 스탯</summary><textarea name="statsJson" rows="18" spellcheck="false" value={statsJson(character)}></textarea></details>
									<button disabled={busy}>인물 저장</button>
								</form>
							</details>
						{/key}
					{/if}
					{#if character.moduleId}
						<form method="POST" action="?/toggleModule" use:enhance={submit} class="lore-action">
							<input type="hidden" name="id" value={character.moduleId} />
							<button name="enabled" value={loreCharacter.active ? '0' : '1'} disabled={busy} onclick={() => (selectedId = loreCharacter.active ? '' : character.id)}>{loreCharacter.active ? '모듈 끄기' : '이 인물 적용'}</button>
						</form>
					{/if}
				{/if}
			</section>
			<div class="lore-tools">
				<details><summary>새 인물 추가</summary>
					<form method="POST" action="?/character" use:enhance={submit} class="settings-form">
						<div class="form-pair"><label>이름<input name="name" required /></label><label>나이<input name="age" type="number" min="20" value="25" required /></label></div>
						<label for="new-profile">인물 설정</label><textarea id="new-profile" name="profile" rows="5" required></textarea>
						<button disabled={busy}>인물 추가</button>
					</form>
				</details>
			</div>
		</div>
	</aside>
	<main class="reader">
		<div class="scene-meta"><span>TURN {data.world.turn}</span><span>{data.world.day}일차 · {timeLabel(data.world.minute)}</span><span>{data.world.location}</span></div>
		<article class="scene" aria-label="현재 장면">
			{#each data.latestNarrative.split('\n\n') as paragraph}
				<p>{paragraph}</p>
			{/each}
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
				<select id="target" value={targetId} onchange={(event) => {
					selectedId = event.currentTarget.value;
					loreKey = selectedId ? `character:${selectedId}` : `world:${activeWorld?.id ?? 'base'}`;
				}}>
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
			<details>
				<summary>상태와 기억</summary>
				<p class="minor">플레이어 체력 {data.player.energy}/{data.player.maxEnergy}</p>
				{#if selected}
					<h3>{selected.name}</h3>
					<p class="minor">{selected.trait.join(' · ')} · 호감 {selected.relation.affection} · 신뢰 {selected.relation.trust} · 욕망 {selected.relation.desire}</p>
					{#if visibleMemories.length}
						<ul class="memory-list">{#each visibleMemories as memory}<li>{memory.summary}</li>{/each}</ul>
					{:else}<p class="minor">기록된 구체적 기억은 아직 없습니다. 이전 행동은 아래 기록에서 볼 수 있습니다.</p>{/if}
				{/if}
			</details>
			<details>
				<summary>행동 기록 · 최근 8턴</summary>
				<ol class="event-list">{#each data.events.slice(0, 8) as event}<li><span>{event.day}일차 {timeLabel(event.minute)}</span> {event.summary}</li>{/each}</ol>
			</details>
		</div>
	</main>
	</div>
</div>
