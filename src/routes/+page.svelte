<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { Character } from '$lib/game/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let selectedId = $state<string | null>(null);
	let busy = $state(false);
	let slot = $state(1);
	let targetId = $derived(selectedId ?? data.characters[0]?.id ?? '');
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
</script>

<svelte:head>
	<title>newera</title>
	<meta name="description" content="세계와 인물이 스스로 움직이는 성인 era 텍스트 게임" />
</svelte:head>

<div class="page">
	<header class="topbar">
		<div><a class="brand" href="/">newera</a><span class="adult-label">성인용 텍스트 게임</span></div>
		<div class="save-group">
			<select bind:value={slot} aria-label="저장 슬롯"><option value={1}>슬롯 1</option><option value={2}>슬롯 2</option><option value={3}>슬롯 3</option></select>
			<form method="POST" action="?/save" use:enhance={submit}><input type="hidden" name="slot" value={slot} /><button disabled={busy}>저장</button></form>
			<form method="POST" action="?/load" use:enhance={submit}><input type="hidden" name="slot" value={slot} /><button disabled={busy || !data.saves.some((save) => save.slot === slot)}>불러오기</button></form>
		</div>
	</header>

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
			<details>
				<summary>모듈 · 세계관과 등장인물</summary>
				<p class="minor">JSON 파일을 설치하면 즉시 적용됩니다. 세계관 모듈은 한 번에 하나, 인물 모듈은 여러 개를 켤 수 있습니다. 끈 인물의 진행과 기억은 보존됩니다.</p>
				<form method="POST" action="?/installModule" enctype="multipart/form-data" use:enhance={submit} class="settings-form">
					<label for="module-file">모듈 파일</label>
					<input id="module-file" type="file" name="moduleFile" accept=".json,application/json" required />
					<button disabled={busy}>설치하고 적용</button>
				</form>
				<p class="minor"><a href="/modules/example-world.json" download>세계관 예시</a> · <a href="/modules/example-character.json" download>인물 예시</a> · <a href="/modules/README.md" target="_blank" rel="noreferrer">파일 형식</a></p>
				{#if data.modules.length}
					<ul class="module-list">
						{#each data.modules as module}
							<li>
								<div><strong>{module.name}</strong> <span>v{module.version} · {module.hasWorld ? '세계관' : ''}{module.hasWorld && module.characterCount ? ' · ' : ''}{module.characterCount ? `인물 ${module.characterCount}명` : ''}</span>{#if module.description}<p>{module.description}</p>{/if}</div>
								<form method="POST" action="?/toggleModule" use:enhance={submit}>
									<input type="hidden" name="id" value={module.id} />
									<button name="enabled" value={module.enabled ? '0' : '1'} disabled={busy}>{module.enabled ? '끄기' : '적용'}</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}
			</details>
			<details>
				<summary>세계관과 era 규칙</summary>
				{#if data.modules.some((module) => module.enabled && module.hasWorld)}<p class="minor">모듈 세계관이 적용 중입니다. 아래 기본 설정은 모듈을 끄면 다시 사용됩니다. era 규칙은 모듈 규칙과 함께 적용됩니다.</p>{/if}
				<form method="POST" action="?/scenario" use:enhance={submit} class="settings-form">
					<label for="world-setting">세계관 설정</label>
					<textarea id="world-setting" name="worldSetting" rows="6" required value={data.config.worldSetting}></textarea>
					<label for="era-rules">era 규칙과 진행 방향</label>
					<textarea id="era-rules" name="eraRules" rows="5" required value={data.config.eraRules}></textarea>
					<button disabled={busy}>설정 저장</button>
				</form>
			</details>
			<details>
				<summary>등장인물 설정</summary>
				{#if selected}
					{#key selected.id}
						<form method="POST" action="?/character" use:enhance={submit} class="settings-form">
							<input type="hidden" name="id" value={selected.id} />
							<div class="form-pair"><label>이름<input name="name" required value={selected.name} /></label><label>나이<input name="age" type="number" min="20" required value={selected.age} /></label></div>
							<label for="character-profile">{selected.name}의 설정</label>
							<textarea id="character-profile" name="profile" rows="6" required value={selected.profile}></textarea>
							<details class="nested"><summary>BASE · TRAIT · ABL · EXP · MARK · RELATION · PALAM</summary><textarea name="statsJson" rows="18" spellcheck="false" value={statsJson(selected)}></textarea></details>
							<button disabled={busy}>인물 저장</button>
						</form>
					{/key}
				{/if}
				<details class="nested"><summary>새 인물 추가</summary>
					<form method="POST" action="?/character" use:enhance={submit} class="settings-form">
						<div class="form-pair"><label>이름<input name="name" required /></label><label>나이<input name="age" type="number" min="20" value="25" required /></label></div>
						<label for="new-profile">인물 설정</label><textarea id="new-profile" name="profile" rows="5" required></textarea>
						<button disabled={busy}>인물 추가</button>
					</form>
				</details>
			</details>
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
