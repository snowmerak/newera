<script lang="ts">
	import type { CharacterPresentation } from '$lib/theater/types';
	let { presentation, characterId }: { presentation: CharacterPresentation; characterId: string } = $props();
</script>

<div class="event-introduction" data-character={characterId}>
	{#if presentation.playerContext}<p>{presentation.playerContext}</p>{/if}
	{#if presentation.appearance}<p>{presentation.appearance}</p>{/if}
</div>
