<script lang="ts">
	import { untrack } from 'svelte';
	import type { OutfitOption } from '$lib/theater/types';
	let { value = [] }: { value?: OutfitOption[] } = $props();
	let outfits = $state(untrack(() => structuredClone(value)));
</script>

<fieldset class="wardrobe-editor"><legend>오늘의 옷차림 후보</legend>
	<p class="field-hint">첫 등장과 날짜가 바뀐 뒤에 판단 모델이 선택해요. 같은 날에도 설정한 시간이 지나 다른 씬에 등장하면 다시 고를 수 있어요. 최대 36개이며, 비워두면 수동 인상착의를 유지합니다.</p>
	<input type="hidden" name="wardrobe" value={JSON.stringify(outfits)} />
	{#each outfits as outfit, index (outfit.id)}
		<div class="wardrobe-option">
			<label>옷차림 이름<input bind:value={outfit.name} maxlength="200" placeholder="예: 방과후 교복" required /></label>
			<label>옷과 소지품<textarea bind:value={outfit.appearance} rows="2" maxlength="700" placeholder="남색 조끼와 흰 셔츠, 소매를 접은 교복 재킷." required></textarea></label>
			<label>언제·어디에서 주로 입나요?<textarea bind:value={outfit.context} rows="2" maxlength="1200" placeholder="평일 학교. 수업 뒤에도 교내에서 친구를 안내할 때."></textarea></label>
			<button type="button" class="quiet-button" aria-label={`${outfit.name || '옷차림'} 후보 제거`} onclick={() => { outfits = outfits.filter((_, candidate) => candidate !== index); }}>후보 제거</button>
		</div>
	{/each}
	<button type="button" class="soft-button" disabled={outfits.length >= 36} onclick={() => { outfits = [...outfits, { id: crypto.randomUUID(), name: '', appearance: '', context: '' }]; }}>+ 옷차림 후보 추가</button>
</fieldset>
