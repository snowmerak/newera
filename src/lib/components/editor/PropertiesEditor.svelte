<script lang="ts">
	import { untrack } from 'svelte';
	import type { Properties } from '$lib/theater/types';
	let { name, value = {}, title = '상태' }: { name: string; value?: Properties; title?: string } = $props();
	let rows = $state(untrack(() => Object.entries(value).map(([key, value], index) => ({ id: index, key, type: value === null ? 'null' : typeof value === 'string' ? 'text' : typeof value, value: String(value ?? '') }))));
	let nextId = untrack(() => rows.length);
</script>

<fieldset class="property-editor"><legend>{title}</legend>
	<input type="hidden" name={`${name}Rows`} value={JSON.stringify(rows.map(({ key, type, value }) => ({ key, type, value })))} />
	{#each rows as row (row.id)}
		<div class="property-row">
			<label>이름<input bind:value={row.key} maxlength="100" placeholder="예: 기분" required /></label>
			<label>종류<select bind:value={row.type} onchange={(event) => { const type = event.currentTarget.value; row.value = type === 'boolean' ? 'false' : type === 'number' ? '0' : ''; }}><option value="text">글자</option><option value="number">숫자</option><option value="boolean">켜짐 / 꺼짐</option><option value="null">비어 있음</option></select></label>
			<label>값{#if row.type === 'boolean'}<select bind:value={row.value}><option value="true">켜짐 · 참</option><option value="false">꺼짐 · 거짓</option></select>{:else if row.type === 'null'}<input value="비어 있음" disabled />{:else}<input type={row.type === 'number' ? 'number' : 'text'} step={row.type === 'number' ? 'any' : undefined} bind:value={row.value} maxlength="4000" required={row.type === 'number'} />{/if}</label>
			<button type="button" class="quiet-button" aria-label={`${row.key || '새 항목'} 삭제`} onclick={() => { rows = rows.filter((entry) => entry.id !== row.id); }}>삭제</button>
		</div>
	{:else}<p class="empty-hint">필요한 상태가 있다면 하나씩 추가해 보세요.</p>{/each}
	<button type="button" class="soft-button" onclick={() => rows.push({ id: nextId++, key: '', type: 'text', value: '' })}>+ 상태 추가</button>
</fieldset>
