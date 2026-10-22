<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import SceneEditor from '$lib/components/editor/SceneEditor.svelte';
	import SceneGraph from '$lib/components/editor/SceneGraph.svelte';
	import TemplateEditor from '$lib/components/editor/TemplateEditor.svelte';
	import InstanceEditor from '$lib/components/editor/InstanceEditor.svelte';
	import type { PageProps } from './$types';
	let { data, form }: PageProps = $props();
	let world = $derived(data.world);
	let section = $state(untrack(() => data.editorTab));
	let filter = $state('all');
	let tabs = $derived([
		{ id: 'world', name: '세계관', count: null },
		{ id: 'scenes', name: '씬', count: world.definition.scenes.length },
		{ id: 'templates', name: '캐릭터·사물', count: world.definition.templates.length },
		{ id: 'instances', name: '배치·관계', count: world.state.instances.length },
		{ id: 'advanced', name: '고급', count: null }
	]);
	let generating = $derived(data.generation?.status === 'running' || data.generation?.status === 'pending');
</script>

<svelte:head><title>세계관과 무대 편집 · newera</title><meta name="description" content="장소와 캐릭터, 서로에 대한 마음을 편하게 다듬는 이야기 작업실" /></svelte:head>
<header class="topbar"><a class="brand" href="/">newera<span>THEATER</span></a><a class="top-link" href="/">공연으로 돌아가기 ↗</a></header>
<main class="editor-shell workshop-shell">
	<div class="editor-intro"><p class="eyebrow">STORY WORKSHOP</p><h1>세계관과 무대 편집</h1><p>장소를 잇고, 인물을 알아가고, 서로에 대한 마음을 다듬어 보세요.</p></div>
	<div class="editor-layout">
		<aside class="editor-catalog"><p class="eyebrow">나의 이야기</p>
			{#each data.worlds as entry}<form method="POST" action="?/selectWorld" use:enhance><button class="world-link" class:current={entry.id === world.id} name="worldId" value={entry.id} disabled={entry.id === world.id}>{entry.name}</button></form>{/each}
			<details class="editor-section"><summary>+ 새 세계관</summary><form method="POST" action="?/createWorld" use:enhance class="settings-form"><label>이름<input name="name" maxlength="200" placeholder="이야기의 이름" required /></label><label>어떤 세계인가요?<textarea name="description" rows="4" maxlength="40000" placeholder="배경과 분위기를 자유롭게 적어 주세요." required></textarea></label><button class="primary">세계관 만들기</button></form></details>
			<details class="editor-section"><summary>저장한 세계관 가져오기</summary><form method="POST" action="?/importWorld" enctype="multipart/form-data" use:enhance class="settings-form"><label>세계관 파일<input name="file" type="file" accept=".json,application/json" required /></label><button>가져오고 열기</button></form></details>
			<a class="export-link" href={`/lores/export/${encodeURIComponent(world.id)}`}>세계관·진행·슬롯 내려받기 ↓</a>
		</aside>
		<section class="editor-main">
			<div class="workshop-heading"><div><span class="workshop-badge">이야기 작업실</span><h2>{world.definition.name}</h2><p>{world.definition.scenes.length}개의 씬 · {world.state.instances.filter((instance) => world.definition.templates.find((template) => template.id === instance.templateId)?.kind === 'character').length}명의 인물</p></div><a href="/" class="preview-link">공연 보기 →</a></div>
			<nav class="editor-tabs" aria-label="편집 항목">{#each tabs as tab}<button type="button" class:chosen={section === tab.id} aria-pressed={section === tab.id} onclick={() => { section = tab.id; }}>{tab.name}{#if tab.count !== null}<span>{tab.count}</span>{/if}</button>{/each}</nav>
			{#if form?.message}<p class="feedback editor-feedback" class:error={form.error} role={form.error ? 'alert' : 'status'}>{form.message}</p>{/if}
			{#if generating}<p class="scope-note">지금 공연이 진행 중입니다. 설정을 저장하면 진행 중인 응답은 멈추고, 이미 확정된 기록은 유지됩니다.</p>{/if}
			{#key world.id}
				{#if section === 'world'}
					<div class="section-intro"><h3>이야기의 큰 배경</h3><p>인물들이 살아가는 세계와 지켜야 할 규칙을 알려 주세요.</p></div>
					<form method="POST" action="?/settings" use:enhance class="settings-form workshop-card padded-card"><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><label>세계관 이름<input name="name" value={world.definition.name} maxlength="200" required /></label><label>배경과 분위기<textarea name="description" rows="6" value={world.definition.description} maxlength="40000" required></textarea></label><label>이 세계의 규칙<textarea name="rules" rows="5" value={world.definition.rules} maxlength="20000" placeholder="예: 인물은 자신이 보거나 들은 일에만 반응한다."></textarea></label><label>이야기가 시작되는 씬<select name="startingSceneId" value={world.definition.startingSceneId}>{#each world.definition.scenes as scene}<option value={scene.id}>{scene.name}</option>{/each}</select></label><p class="field-hint">시작 씬을 바꾸면 처음 동행하는 인물의 시작 위치도 함께 옮겨요. 지금 진행 중인 위치는 유지됩니다.</p><button class="primary">세계관 저장</button></form>
				{:else if section === 'scenes'}
					<div class="section-intro"><h3>어디에서 만날까요?</h3><p>각 씬 카드에서 인접 씬을 선택하세요. 저장한 목록대로 위 지도에 연결을 그려요.</p></div>
					<SceneGraph {world} />
					<div class="workshop-grid">{#each world.definition.scenes as scene (scene.id)}<details class="workshop-card scene-editor" data-testid={`scene-${scene.id}`}><summary><span class="card-avatar scene-avatar">{scene.name.slice(0, 1)}</span><span><strong>{scene.name}</strong><small>{scene.id === world.state.activeSceneId ? '지금 있는 곳' : scene.id === world.definition.startingSceneId ? '시작하는 곳' : '씬'}</small></span><span class="card-edit-label">편집</span></summary><p class="card-description">{scene.description}</p><div class="connection-chips">{#each scene.exits as id}<span>→ {world.definition.scenes.find((other) => other.id === id)?.name}</span>{:else}<span>연결된 길이 없어요</span>{/each}</div><div class="card-body">{#key world.revision}<SceneEditor {world} {scene} />{/key}</div></details>{/each}</div>
					<details class="workshop-card add-card"><summary>+ 새로운 씬 만들기</summary><div class="card-body">{#key world.revision}<SceneEditor {world} />{/key}</div></details>
				{:else if section === 'templates'}
					<div class="section-intro"><h3>어떤 인물이 등장하나요?</h3><p>소개·성격·말투·바라는 것을 적어 주세요. 같은 기본 설정으로 여러 인물을 배치할 수도 있어요.</p></div>
					<div class="scope-switch filter-switch" aria-label="캐릭터·사물 필터">{#each [{ id: 'all', name: '모두' }, { id: 'character', name: '캐릭터' }, { id: 'object', name: '사물' }] as item}<button type="button" class:chosen={filter === item.id} aria-pressed={filter === item.id} onclick={() => { filter = item.id; }}>{item.name}</button>{/each}</div>
					<div class="workshop-stack">{#each world.definition.templates.filter((template) => filter === 'all' || template.kind === filter) as template (template.id)}<details class="workshop-card" data-testid={`template-${template.id}`}><summary><span class="card-avatar" class:object-avatar={template.kind === 'object'}>{template.name.slice(0, 1)}</span><span><strong>{template.name}</strong><small>{template.kind === 'character' ? '캐릭터' : '사물'} · {world.state.instances.filter((instance) => instance.templateId === template.id).length}곳에 배치됨</small></span><span class="card-edit-label">편집</span></summary><div class="card-body">{#key world.revision}<TemplateEditor {world} {template} />{/key}</div></details>{:else}<p class="empty-hint">아직 설정이 없어요. 첫 캐릭터나 사물을 만들어 보세요.</p>{/each}</div>
					<details class="workshop-card add-card"><summary>+ 캐릭터·사물 만들기</summary><div class="card-body">{#key world.revision}<TemplateEditor {world} />{/key}</div></details>
				{:else if section === 'instances'}
					<div class="section-intro"><h3>씬의 인스턴스와 동행</h3><p>배치된 인물과 사물의 이름·위치·상태를 바꾸고, 인물끼리의 마음을 설정해 보세요.</p></div>
					<div class="workshop-stack">{#each world.state.instances as instance (instance.id)}<InstanceEditor {world} {instance} />{:else}<p class="empty-hint">아직 배치된 인물이 없어요. 아래에서 첫 인물이나 사물을 배치해 보세요.</p>{/each}</div>
					<details class="workshop-card add-card"><summary>+ 인물·사물 배치하기</summary><div class="card-body"><form method="POST" action="?/spawn" use:enhance class="settings-form"><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><label>기본 설정<select name="templateId" required>{#each world.definition.templates as template}<option value={template.id}>{template.name} · {template.kind === 'character' ? '캐릭터' : '사물'}</option>{/each}</select></label><label>이름<input name="name" placeholder="비워두면 기본 이름을 사용해요" /></label><label>배치할 씬<select name="sceneId" value={world.state.activeSceneId}>{#each world.definition.scenes as scene}<option value={scene.id}>{scene.name}</option>{/each}</select></label><label class="choice-chip"><input name="companion" type="checkbox" />플레이어와 동행</label><button class="primary" disabled={!world.definition.templates.length}>배치하기</button></form></div></details>
				{:else}
					<div class="section-intro"><h3>세밀한 설정이 필요할 때</h3><p>평소에는 다른 탭의 편집 도구를 사용하고, 전체 내용을 한꺼번에 다룰 때 이곳을 이용하세요.</p></div>
					<details class="workshop-card"><summary>세계관 전체 정의 · JSON</summary><div class="card-body"><p class="field-hint">현재 진행과 기억은 유지됩니다. 초기 배치는 초기화할 때 적용됩니다.</p><form method="POST" action="?/definition" use:enhance class="settings-form"><input type="hidden" name="worldId" value={world.id} /><input type="hidden" name="revision" value={world.revision} /><label>세계관 정의<textarea name="definition" class="code-input definition-input" rows="24" value={JSON.stringify(world.definition, null, 2)} required></textarea></label><button>정의 저장</button></form></div></details>
				{/if}
			{/key}
		</section>
	</div>
</main>
