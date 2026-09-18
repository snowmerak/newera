<script lang="ts">
	import CharacterStatsFields from '$lib/components/CharacterStatsFields.svelte';
	import { actionUnavailableReason, attachRenderedText, createSimulation, resolveAction, selectActiveCharacter, SIMULATION_ACTIONS } from '$lib/game/simulation';
	import { renderSemanticEvent } from '$lib/game/simulation-renderer';
	import type { Character } from '$lib/game/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	// svelte-ignore state_referenced_locally
	let simulation = $state(createSimulation(data.player, data.characters, data.world.location));
	let active = $derived(simulation.characters.find((character) => character.id === simulation.situation.activeCharacterId) ?? null);
	let last = $derived(simulation.eventLog.at(-1) ?? null);
	let error = $state('');

	function perform(): void {
		try {
			const result = resolveAction(simulation, 'conversation');
			simulation = attachRenderedText(result.state, renderSemanticEvent(result.event));
			error = '';
		} catch (cause) { error = cause instanceof Error ? cause.message : '행동을 처리하지 못했습니다.'; }
	}

	function editCharacter(event: SubmitEvent): void {
		event.preventDefault();
		if (!active) return;
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const num = (key: string) => Number(form.get(key));
		const base = { energy: num('base.energy'), maxEnergy: num('base.maxEnergy') };
		const playerEnergy = num('player.energy');
		if (base.energy > base.maxEnergy || playerEnergy > simulation.player.maxEnergy) {
			error = '현재 체력은 최대 체력을 넘을 수 없습니다.';
			return;
		}
		const knownMarks = ['firstConversation', 'becameFriend'];
		const edited: Character = {
			...active, base,
			talent: { pride: num('talent.pride'), openness: num('talent.openness'), empathy: num('talent.empathy'), assertiveness: num('talent.assertiveness') },
			abl: { conversation: num('abl.conversation'), empathy: num('abl.empathy'), seduction: num('abl.seduction') },
			exp: { conversation: num('exp.conversation'), empathy: num('exp.empathy'), seduction: num('exp.seduction') },
			relation: { affection: num('relation.affection'), trust: num('relation.trust'), desire: num('relation.desire') },
			palam: { rapport: num('palam.rapport'), trust: num('palam.trust'), arousal: num('palam.arousal'), pleasure: num('palam.pleasure') },
			mark: [...active.mark.filter((mark) => !knownMarks.includes(mark)), ...knownMarks.filter((mark) => form.has(`mark.${mark}`))]
		};
		simulation = { ...simulation, player: { ...simulation.player, energy: playerEnergy },
			characters: simulation.characters.map((character) => character.id === active?.id ? edited : character) };
		error = '';
	}
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
		<div class="manage-intro"><p class="eyebrow">SIMULATION VERTICAL SLICE</p><h1>캐릭터 시뮬레이터</h1><p>현재 로어 「{data.lore.title}」의 수치로 시작합니다. 이 화면의 실행과 편집은 현재 화면 세션에서만 적용됩니다.</p></div>
		<div class="sim-layout">
			<section class="sim-main">
				<section class="sim-card" aria-label="현재 상황">
					<h2>현재 상황</h2>
					<p>장소: {simulation.situation.location}</p>
					<p>참여: 플레이어{#each simulation.characters as character}, {character.name}{/each}</p>
					<label for="sim-target">활성 캐릭터</label>
					<select id="sim-target" value={simulation.situation.activeCharacterId ?? ''} onchange={(event) => (simulation = selectActiveCharacter(simulation, event.currentTarget.value))}>
						{#if !simulation.characters.length}<option value="">등장인물 없음</option>{/if}
						{#each simulation.characters as character}<option value={character.id}>{character.name}</option>{/each}
					</select>
				</section>
				<section class="sim-card" aria-label="가능한 행동">
					<h2>가능한 행동</h2>
					{#each simulation.situation.availableActionIds as actionId}
						<button class="sim-action" disabled={Boolean(actionUnavailableReason(simulation, actionId))} onclick={perform}>{SIMULATION_ACTIONS[actionId].label}</button>
						<p class="minor">{actionUnavailableReason(simulation, actionId) ?? SIMULATION_ACTIONS[actionId].description}</p>
					{/each}
					{#if error}<p class="feedback error" role="alert">{error}</p>{/if}
				</section>
				<section class="sim-card" aria-label="출력 결과">
					<h2>출력 결과</h2><p class="sim-result">{last?.renderedText ?? '아직 실행한 행동이 없습니다.'}</p>
				</section>
				<section class="sim-card" aria-label="직전 처리 결과">
					<h2>직전 처리 결과</h2>
					{#if last}
						<p class="minor">SemanticEvent · {last.event.type} / {last.event.outcome} / {last.event.actorId} → {last.event.targetId}</p>
						<h3>SOURCE · 이번 행동</h3>
						<dl class="sim-effects"><dt>energy</dt><dd>{last.source.energy > 0 ? '+' : ''}{last.source.energy}</dd><dt>rapport</dt><dd>+{last.source.rapport}</dd><dt>trust</dt><dd>+{last.source.trust}</dd></dl>
						<h3>State Changes</h3>
						<ul class="sim-changes">{#each last.changes as change}<li><code>{change.path}</code><span>{Array.isArray(change.before) ? change.before.join(', ') || '없음' : change.before} → {Array.isArray(change.after) ? change.after.join(', ') || '없음' : change.after}</span></li>{/each}</ul>
					{:else}<p class="minor">행동을 실행하면 SOURCE와 실제 상태 변화를 볼 수 있습니다.</p>{/if}
				</section>
				<section class="sim-card" aria-label="이벤트 기록">
					<h2>Event Log</h2>
						{#if simulation.eventLog.length}<ol class="sim-log">{#each simulation.eventLog as entry}<li>
							<strong>#{entry.id} · {SIMULATION_ACTIONS[entry.actionId].label}</strong>
							<span>{entry.actorId} → {entry.targetId} · {entry.event.type} / {entry.event.outcome}</span>
							<p>{entry.renderedText}</p>
							<small>SOURCE energy {entry.source.energy}, rapport +{entry.source.rapport}, trust +{entry.source.trust}</small>
							<details><summary>상태 변화 {entry.changes.length}개</summary><ul class="sim-changes">{#each entry.changes as change}<li><code>{change.path}</code><span>{Array.isArray(change.before) ? change.before.join(', ') || '없음' : change.before} → {Array.isArray(change.after) ? change.after.join(', ') || '없음' : change.after}</span></li>{/each}</ul></details>
						</li>{/each}</ol>
					{:else}<p class="minor">아직 기록이 없습니다.</p>{/if}
				</section>
			</section>
			<aside class="sim-inspector" aria-label="캐릭터 에디터와 인스펙터">
				<details open><summary>Character Editor / Inspector</summary>
					{#if active}
						<h2>{active.name}</h2><p class="minor">플레이어 BASE: 체력 {simulation.player.energy}/{simulation.player.maxEnergy}</p>
						{#key active.id}<form class="settings-form" onsubmit={editCharacter}>
							<label>플레이어 체력<input name="player.energy" type="number" min="0" max={simulation.player.maxEnergy} required value={simulation.player.energy} /></label>
							<CharacterStatsFields stats={active} />
							<fieldset class="sim-marks"><legend>MARK · 지속 상태</legend>
								<label><input name="mark.firstConversation" type="checkbox" checked={active.mark.includes('firstConversation')} /> 첫 대화</label>
								<label><input name="mark.becameFriend" type="checkbox" checked={active.mark.includes('becameFriend')} /> 친구가 됨</label>
								{#if active.mark.some((mark) => !['firstConversation', 'becameFriend'].includes(mark))}<p class="minor">기존 MARK: {active.mark.filter((mark) => !['firstConversation', 'becameFriend'].includes(mark)).join(' · ')}</p>{/if}
							</fieldset>
							<p class="minor">TRAIT: {active.trait.join(' · ') || '없음'}</p>
							<button>수치 적용</button>
						</form>{/key}
					{:else}<p class="minor">인물이 없습니다. <a href="/lores">로어 관리</a>에서 인물을 추가하세요.</p>{/if}
				</details>
			</aside>
		</div>
	</main>
</div>
