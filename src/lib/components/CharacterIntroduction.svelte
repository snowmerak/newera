<script lang="ts">
	import type { EntityInstance } from '$lib/theater/types';
	let { instance }: { instance: EntityInstance } = $props();
</script>

<div class="character-introduction" data-character={instance.id}>
	<div><span>나와의 처음 설정</span><p>{instance.playerContext || '처음의 관계는 따로 정해져 있지 않다.'}</p></div>
	<div><span>현재 인상착의{#if instance.appearanceSelection} · {instance.appearanceSelection.day}일차{/if}</span><p>{instance.appearance || '겉모습과 옷차림은 아직 정해져 있지 않다.'}</p></div>
</div>
