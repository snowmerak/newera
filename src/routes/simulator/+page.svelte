<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CharacterStatsFields from '$lib/components/CharacterStatsFields.svelte';
	import CharacterMarksFields from '$lib/components/CharacterMarksFields.svelte';
	import { actionUnavailableReason, createSimulation, selectActiveCharacter, SIMULATION_ACTIONS } from '$lib/game/simulation';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let selectedId = $state('');
	let busy = $state(false);
	let activeId = $derived(data.characters.some((character) => character.id === selectedId) ? selectedId : (data.characters[0]?.id ?? ''));
	let simulation = $derived.by(() => {
		const state = createSimulation(data.player, data.characters, data.world.location);
		return activeId ? selectActiveCharacter(state, activeId) : state;
	});
	let active = $derived(data.characters.find((character) => character.id === activeId) ?? null);
	let last = $derived(data.simulationEvents.at(-1) ?? null);
	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			try { await update(); } finally { busy = false; }
		};
	};
</script>

<svelte:head>
	<title>결정적 시뮬레이터 · newera</title>
	<meta name="description" content="대화 행동의 SOURCE와 상태 변화를 확인하는 시뮬레이터" />
</svelte:head>

<div class="page">
	<header class="topbar">
		<div class="brand-group"><a class="brand" href="/">newera</a><span class="adult-label">결정적 시뮬레이터</span></div>
		<div class="top-actions"><a class="top-link" href="/">플레이</a><a class="top-link" href="/lores">로어 관리</a></div>
	</header>
	<main class="sim-shell">
		<div class="manage-intro"><p class="eyebrow">SIMULATION VERTICAL SLICE</p><h1>캐릭터 시뮬레이터</h1><p>현재 로어 「{data.lore.title}」의 실제 진행을 사용합니다. 행동과 수치 편집은 자동 저장되며 저장 슬롯에도 포함됩니다.</p></div>
		<div class="sim-layout">
			<section class="sim-main">
				<section class="sim-card" aria-label="현재 상황">
					<h2>현재 상황</h2>
					<p>장소: {simulation.situation.location}</p>
					<p>참여: 플레이어{#each simulation.characters as character}, {character.name}{/each}</p>
					<label for="sim-target">활성 캐릭터</label>
					<select id="sim-target" value={activeId} onchange={(event) => (selectedId = event.currentTarget.value)}>
						{#if !simulation.characters.length}<option value="">등장인물 없음</option>{/if}
						{#each simulation.characters as character}<option value={character.id}>{character.name}</option>{/each}
					</select>
				</section>
				<section class="sim-card" aria-label="가능한 행동">
					<h2>가능한 행동</h2>
					{#each simulation.situation.availableActionIds as actionId}
						<form method="POST" action="?/conversation" use:enhance={submit}><input type="hidden" name="targetId" value={activeId} /><button class="sim-action" disabled={busy || Boolean(actionUnavailableReason(simulation, actionId))}>{SIMULATION_ACTIONS[actionId].label}</button></form>
						<p class="minor">{actionUnavailableReason(simulation, actionId) ?? SIMULATION_ACTIONS[actionId].description}</p>
					{/each}
					{#if form?.message}<p class="feedback" class:error={form.level === 'error'} role="status">{form.message}</p>{/if}
				</section>
				<section class="sim-card" aria-label="출력 결과">
					<h2>출력 결과</h2><p class="sim-result">{last?.narrative ?? '아직 실행한 행동이 없습니다.'}</p>
				</section>
				<section class="sim-card" aria-label="직전 처리 결과">
					<h2>직전 처리 결과</h2>
					{#if last}
						<p class="minor">SemanticEvent · {last.semanticEvent?.type} / {last.semanticEvent?.outcome} / {last.semanticEvent?.actorId} → {last.semanticEvent?.targetId}</p>
						{#if last.source.comfort === undefined}<p class="minor">이 사건은 이전 수치 규칙으로 기록되었습니다.</p>{/if}
						<h3>SOURCE · 이번 행동</h3>
						<dl class="sim-effects"><dt>energy</dt><dd>{last.source.energy ?? '—'}</dd><dt>rapport</dt><dd>{last.source.rapport ?? '—'}</dd><dt>comfort</dt><dd>{last.source.comfort ?? '—'}</dd><dt>tension</dt><dd>{last.source.tension ?? '—'}</dd><dt>trust</dt><dd>{last.source.trust ?? '—'}</dd><dt>affection</dt><dd>{last.source.affection ?? '—'}</dd></dl>
						<h3>State Changes</h3>
						<ul class="sim-changes">{#each last.stateChanges ?? [] as change}<li><code>{change.path}</code><span>{Array.isArray(change.before) ? change.before.join(', ') || '없음' : change.before} → {Array.isArray(change.after) ? change.after.join(', ') || '없음' : change.after}</span></li>{/each}</ul>
					{:else}<p class="minor">행동을 실행하면 SOURCE와 실제 상태 변화를 볼 수 있습니다.</p>{/if}
				</section>
				<section class="sim-card" aria-label="이벤트 기록">
					<h2>Event Log</h2>
						{#if data.simulationEvents.length}<ol class="sim-log">{#each data.simulationEvents as entry}<li>
							<strong>#{entry.id} · 대화한다</strong>
							<span>{entry.semanticEvent?.actorId} → {entry.characterId} · {entry.semanticEvent?.type} / {entry.semanticEvent?.outcome}</span>
							<p>{entry.narrative}</p>
							<small>SOURCE energy {entry.source.energy ?? '—'}, rapport {entry.source.rapport ?? '—'}, comfort {entry.source.comfort ?? '—'}, tension {entry.source.tension ?? '—'}, trust {entry.source.trust ?? '—'}</small>
							<details><summary>상태 변화 {entry.stateChanges?.length ?? 0}개</summary><ul class="sim-changes">{#each entry.stateChanges ?? [] as change}<li><code>{change.path}</code><span>{Array.isArray(change.before) ? change.before.join(', ') || '없음' : change.before} → {Array.isArray(change.after) ? change.after.join(', ') || '없음' : change.after}</span></li>{/each}</ul></details>
						</li>{/each}</ol>
					{:else}<p class="minor">아직 기록이 없습니다.</p>{/if}
				</section>
			</section>
			<aside class="sim-inspector" aria-label="캐릭터 에디터와 인스펙터">
				<details open><summary>Character Editor / Inspector</summary>
					{#if active}
						<h2>{active.name}</h2><p class="minor">플레이어 BASE: 체력 {data.player.energy}/{data.player.maxEnergy}</p>
						{#key active.id}<form method="POST" action="?/edit" use:enhance={submit} class="settings-form">
							<input type="hidden" name="id" value={active.id} />
							<label>플레이어 체력<input name="player.energy" type="number" min="0" max={data.player.maxEnergy} required value={data.player.energy} /></label>
							<CharacterStatsFields stats={active} />
							<CharacterMarksFields marks={active.mark} />
							<p class="minor">TRAIT: {active.trait.join(' · ') || '없음'}</p>
							<button disabled={busy}>수치 저장</button>
						</form>{/key}
					{:else}<p class="minor">인물이 없습니다. <a href="/lores">로어 관리</a>에서 인물을 추가하세요.</p>{/if}
				</details>
			</aside>
		</div>
	</main>
</div>
