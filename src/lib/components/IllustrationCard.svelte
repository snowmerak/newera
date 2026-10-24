<script lang="ts">
	import type { Illustration } from '$lib/images/triggers';
	let { illustration, onImageLoad }: { illustration: Illustration; onImageLoad?: () => void } = $props();
	const statusLabels = { pending: '삽화 조건 확인 대기', checking: '삽화 조건 판단 중…', generating: '삽화를 그리고 있습니다…', completed: '장면 삽화', failed: '삽화 생성 실패', skipped: '' };
</script>
<figure class="illustration" aria-label="장면 삽화 기록">
	{#if illustration.status === 'completed'}<img src={`/api/images/illustrations/${encodeURIComponent(illustration.id)}`} alt={`${illustration.reason} · 장면 삽화`} onload={onImageLoad} />{/if}
	<figcaption><span>{statusLabels[illustration.status]} · {illustration.tick}회 진행</span><small>{illustration.reason}</small>{#if illustration.error}<p role="status">{illustration.error}</p>{/if}</figcaption>
</figure>
<style>
	.illustration { margin: 18px 0; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
	img { display: block; width: 100%; max-height: 720px; object-fit: contain; background: #151619; }
	figcaption { padding: 12px 14px; display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
	small { color: var(--accent); } p { margin: 0; line-height: 1.7; overflow-wrap: anywhere; }
</style>
