<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { Scene } from '$lib/theater/types';
	let { scenes, sceneId, exits = [] }: { scenes: Scene[]; sceneId?: string; exits?: string[] } = $props();
	const id = $props.id();
	let selected = $state(untrack(() => [...exits]));
	let query = $state('');
	let pendingId = $state('');
	let expanded = $state(false);
	let active = $state(0);
	let candidates = $derived(scenes.filter((scene) => scene.id !== sceneId && !selected.includes(scene.id) && `${scene.name} ${scene.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
	let pending = $derived(scenes.find((scene) => scene.id === pendingId && !selected.includes(scene.id)));

	function choose(scene: Scene) {
		pendingId = scene.id;
		query = scene.name;
		expanded = false;
	}
	function add() {
		if (!pending) return;
		selected = [...selected, pending.id];
		query = '';
		pendingId = '';
		expanded = false;
		active = 0;
	}
	async function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') { expanded = false; return; }
		if (event.key === 'Enter') {
			event.preventDefault();
			if (expanded && candidates[active]) choose(candidates[active]);
			else if (!expanded) add();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		if (!expanded) { expanded = true; active = 0; }
		else active = (active + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % Math.max(1, candidates.length);
		await tick();
		if (candidates[active]) document.getElementById(`${id}-${candidates[active].id}`)?.scrollIntoView({ block: 'nearest' });
	}
</script>

<fieldset class="scene-neighbors"><legend>인접 씬 목록 · 여기서 바로 이동할 수 있는 곳</legend>
	<div class="neighbor-tags" aria-label="선택한 인접 씬">
		{#each selected as selectedId (selectedId)}
			{@const scene = scenes.find((scene) => scene.id === selectedId)}
			<input type="hidden" name="exits" value={selectedId} />
			<span class="neighbor-tag"><span title={scene?.name}>{scene?.name ?? selectedId}</span><button type="button" aria-label={`${scene?.name ?? selectedId} 인접 씬 제거`} onclick={() => { selected = selected.filter((value) => value !== selectedId); }}>×</button></span>
		{:else}<p class="field-hint">아직 연결한 씬이 없어요.</p>{/each}
	</div>
	<label for={id}>추가할 인접 씬 검색</label>
	<div class="neighbor-add-row">
		<div class="neighbor-combobox">
			<div class="neighbor-search">
				<input {id} type="text" role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? `${id}-results` : undefined} aria-activedescendant={expanded && candidates[active] ? `${id}-${candidates[active].id}` : undefined} autocomplete="off" placeholder="씬 이름으로 검색…" bind:value={query} onfocus={() => { expanded = true; active = 0; }} oninput={() => { pendingId = ''; expanded = true; active = 0; }} onblur={() => { expanded = false; }} onkeydown={keydown} />
				<button type="button" aria-label="인접 씬 목록 펼치기" aria-expanded={expanded} onpointerdown={(event) => { event.preventDefault(); }} onclick={() => { expanded = !expanded; active = 0; }}>▾</button>
			</div>
			{#if expanded}
				<div class="neighbor-options" id={`${id}-results`} role="listbox" aria-label="추가할 수 있는 인접 씬">
					{#each candidates as scene, index (scene.id)}
						<button type="button" role="option" tabindex="-1" id={`${id}-${scene.id}`} aria-selected={active === index} class:highlighted={active === index} onpointerdown={(event) => { event.preventDefault(); }} onclick={() => choose(scene)}><span>{scene.name}</span><small>{scene.id}</small></button>
					{:else}<p class="field-hint">{query.trim() ? '검색 결과가 없어요.' : '추가할 수 있는 씬을 모두 연결했어요.'}</p>{/each}
				</div>
			{/if}
		</div>
		<button type="button" class="soft-button" disabled={!pending} onclick={add}>추가</button>
	</div>
	<p class="field-hint">검색 목록에서 고른 뒤 추가하세요. 태그의 ×로 제거하고, 씬 저장을 누르면 적용됩니다.</p>
</fieldset>
