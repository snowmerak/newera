<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CharacterStatsFields from '$lib/components/CharacterStatsFields.svelte';
	import CharacterMarksFields from '$lib/components/CharacterMarksFields.svelte';
	import ActionRequirementsFields from '$lib/components/ActionRequirementsFields.svelte';
	import { DEFAULT_ABL, DEFAULT_ACTION_REQUIREMENTS, DEFAULT_EXP, DEFAULT_PALAM, DEFAULT_RELATION, DEFAULT_TALENT, NARRATIVE_MODES, type Character } from '$lib/game/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
	let selectedId = $state('');
	let selected = $derived(data.characterTemplates.find((character) => character.id === selectedId) ?? null);
	let activeWorld = $derived(data.worldLore.find((world) => world.active) ?? data.worldLore[0]);

	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			try { await update(); } finally { busy = false; }
		};
	};

	const initialStats: Pick<Character, 'base' | 'talent' | 'abl' | 'exp' | 'relations' | 'palam'> = {
		base: { energy: 20, maxEnergy: 20 },
		talent: { ...DEFAULT_TALENT },
		abl: { ...DEFAULT_ABL },
		exp: { ...DEFAULT_EXP },
		relations: { player: { ...DEFAULT_RELATION } },
		palam: { ...DEFAULT_PALAM }
	};
</script>

<svelte:head>
	<title>로어 관리 · newera</title>
	<meta name="description" content="newera 로어 설정과 가져오기, 내보내기" />
</svelte:head>

<div class="page">
	<header class="topbar">
		<div class="brand-group"><a class="brand" href="/">newera</a><span class="adult-label">로어 관리</span></div>
		<div class="top-actions"><a class="top-link" href="/">플레이 화면으로</a></div>
	</header>
	<main class="manage-shell">
		<div class="manage-intro"><p class="eyebrow">LORE LIBRARY</p><h1>로어 관리</h1><p>제목과 세계관, 등장인물 설정을 관리합니다. 플레이 중인 장면과 저장 슬롯은 플레이 화면에 있습니다.</p></div>
		{#if form?.message}<p class="feedback" class:error={form.level === 'error'} role="status">{form.message}</p>{/if}
		<div class="manage-grid">
			<section class="manage-catalog" aria-label="로어 목록">
				<h2>로어 목록</h2>
				{#each data.lores as lore}
					<div class="manage-lore" class:current={lore.active}>
						<div><strong>{lore.title}</strong>{#if lore.active}<span>현재 플레이 중</span>{/if}</div>
						<div class="manage-lore-actions">
							{#if !lore.active}<form method="POST" action="?/switchLore" use:enhance={submit}><button name="id" value={lore.id} disabled={busy}>이 로어 열기</button></form>{/if}
							<a href={`/lores/export/${lore.id}`} download>내보내기</a>
						</div>
					</div>
				{/each}
				<details class="manage-new"><summary>새 로어 만들기</summary>
					<form method="POST" action="?/createLore" use:enhance={submit} class="settings-form">
						<label for="new-lore-title">제목</label><input id="new-lore-title" name="title" maxlength="80" required />
						<label for="new-lore-world">세계관 설정</label><textarea id="new-lore-world" name="worldSetting" rows="5" required></textarea>
						<label for="new-lore-rules">era 규칙</label><textarea id="new-lore-rules" name="eraRules" rows="4" required value={data.config.eraRules}></textarea>
						<label for="new-narrative-mode">묘사 모드</label><select id="new-narrative-mode" name="narrativeMode">{#each NARRATIVE_MODES as mode}<option value={mode.value} selected={mode.value === 'sensual'}>{mode.label} · {mode.description}</option>{/each}</select>
						<button disabled={busy}>만들고 열기</button>
					</form>
				</details>
				<details class="manage-new"><summary>로어 가져오기 · JSON</summary>
					<form method="POST" action="?/importLore" enctype="multipart/form-data" use:enhance={submit} class="settings-form">
						<label for="lore-file">내보낸 로어 파일</label><input id="lore-file" type="file" name="loreFile" accept=".json,application/json" required />
						<button disabled={busy}>가져오고 열기</button>
					</form>
					<p class="minor">로어 설정, 현재 진행, 저장 슬롯을 함께 가져옵니다. 인물·세계관 모듈 파일은 아래 모듈 영역에서 설치합니다.</p>
				</details>
			</section>

			<section class="manage-editor" aria-label="현재 로어 편집">
				<div class="manage-editor-head"><div><p class="eyebrow">EDITING LORE</p><h2>{data.lore.title}</h2></div><a href="/">플레이하기 →</a></div>
				<div class="manage-section">
					<h3>제목</h3>
					<form method="POST" action="?/renameLore" use:enhance={submit} class="settings-form">
						<label for="lore-title">로어 제목</label><input id="lore-title" name="title" maxlength="80" required value={data.lore.title} />
						<button disabled={busy}>제목 저장</button>
					</form>
				</div>
				<div class="manage-section">
					<h3>세계관과 규칙</h3>
					<p class="minor">현재 적용: {activeWorld?.name}</p>
					<form method="POST" action="?/scenario" use:enhance={submit} class="settings-form">
						<label for="world-setting">기본 세계관</label><textarea id="world-setting" name="worldSetting" rows="6" required value={data.config.worldSetting}></textarea>
						<label for="era-rules">era 규칙과 진행 방향</label><textarea id="era-rules" name="eraRules" rows="5" required value={data.config.eraRules}></textarea>
						<label for="narrative-mode">묘사 모드</label><select id="narrative-mode" name="narrativeMode" value={data.config.narrativeMode}>{#each NARRATIVE_MODES as mode}<option value={mode.value}>{mode.label} · {mode.description}</option>{/each}</select>
						<p class="minor">묘사 모드는 장면의 문체만 바꿉니다. 인물의 성향, 행동 조건, 수락과 거절 판단은 그대로 적용됩니다.</p>
						<button disabled={busy}>설정 저장</button>
					</form>
					{#if data.worldLore.length > 1}
						<div class="module-list">{#each data.worldLore as world}
							<form method="POST" action="?/selectWorld" use:enhance={submit}><button name="id" value={world.id ?? ''} disabled={busy || world.active}>{world.name} · {world.active ? '적용 중' : '적용'}</button></form>
						{/each}</div>
					{/if}
				</div>
				<div class="manage-section">
					<h3>등장인물 원본</h3>
					<p class="minor">여기서 바꾸는 era 수치는 새 세션의 초기값입니다. 현재 플레이 중인 세션 수치는 바뀌지 않습니다. 이름·설정·행동 조건은 현재 세션에도 바로 반영됩니다.</p>
					{#if data.characterTemplates.length}
						<div class="character-chooser"><label for="character-setting">인물 선택</label><select id="character-setting" value={selectedId} onchange={(event) => (selectedId = event.currentTarget.value)}><option value="">선택</option>{#each data.characterTemplates as character}<option value={character.id}>{character.name}</option>{/each}</select></div>
					{/if}
					{#if selected}
						{#key selected.id}<form method="POST" action="?/character" use:enhance={submit} class="settings-form">
							<input type="hidden" name="id" value={selected.id} />
							<div class="form-pair"><label>이름<input name="name" required value={selected.name} /></label><label>나이<input name="age" type="number" required value={selected.age} /></label></div>
							<label for="character-profile">인물 설정</label><textarea id="character-profile" name="profile" rows="6" required value={selected.profile}></textarea>
							<details class="nested"><summary>새 세션의 초기 era 수치</summary><CharacterStatsFields stats={selected} /></details>
							<CharacterMarksFields marks={selected.mark} />
							<ActionRequirementsFields requirements={selected.actionRequirements} />
							<div class="variable-stats"><strong>TRAIT</strong><p>가변 성향 목록: {selected.trait.length ? selected.trait.join(' · ') : '없음'}</p></div>
							<button disabled={busy}>인물 저장</button>
						</form>{/key}
					{/if}
					<details class="nested"><summary>새 인물 추가</summary><form method="POST" action="?/character" use:enhance={submit} class="settings-form">
						<div class="form-pair"><label>이름<input name="name" required /></label><label>나이<input name="age" type="number" value="25" required /></label></div>
						<label for="new-profile">인물 설정</label><textarea id="new-profile" name="profile" rows="5" required></textarea>
						<details class="nested"><summary>초기 era 수치</summary><CharacterStatsFields stats={initialStats} /></details>
						<CharacterMarksFields marks={[]} />
						<ActionRequirementsFields requirements={DEFAULT_ACTION_REQUIREMENTS} />
						<button disabled={busy}>인물 추가</button>
					</form></details>
				</div>
				<div class="manage-section">
					<h3>세계관·인물 모듈</h3>
					<form method="POST" action="?/installModule" enctype="multipart/form-data" use:enhance={submit} class="settings-form">
						<label for="module-file">JSON 모듈 파일</label><input id="module-file" type="file" name="moduleFile" accept=".json,application/json" required />
						<button disabled={busy}>설치하고 적용</button>
					</form>
					<p class="minor"><a href="/modules/example-world.json" download>세계관 예시</a> · <a href="/modules/example-character.json" download>인물 예시</a> · <a href="/modules/README.md" target="_blank" rel="noreferrer">파일 형식</a></p>
					{#if data.modules.length}<div class="module-list">{#each data.modules as module}
						<form method="POST" action="?/toggleModule" use:enhance={submit}><input type="hidden" name="id" value={module.id} /><button name="enabled" value={module.enabled ? '0' : '1'} disabled={busy}>{module.name} · {module.enabled ? '끄기' : '적용'}</button></form>
					{/each}</div>{/if}
				</div>
				<div class="manage-section manage-danger">
					<h3>로어 삭제</h3><p class="minor">이 로어의 현재 진행과 저장 슬롯도 함께 삭제됩니다. 남은 로어가 하나라면 삭제할 수 없습니다.</p>
					<form method="POST" action="?/deleteLore" use:enhance={submit} class="settings-form">
						<input type="hidden" name="id" value={data.lore.id} />
						<label for="delete-confirmation">확인하려면 로어 제목을 입력하세요</label><input id="delete-confirmation" name="confirmation" required autocomplete="off" />
						<button disabled={busy || data.lores.length <= 1}>로어 삭제</button>
					</form>
				</div>
			</section>
		</div>
	</main>
</div>
