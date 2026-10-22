<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { relationshipMetrics } from '$lib/theater/types';
	import { relationshipLabels, unknownRelationship } from '$lib/theater/reflection';
	import type { Relationship, RelationshipMetric } from '$lib/theater/types';
	let { worldId, revision, instanceId, targetId, targetName, scope, relation }: { worldId: string; revision: number; instanceId: string; targetId: string; targetName: string; scope: 'current' | 'initial'; relation?: Relationship } = $props();
	let known = $state(untrack(() => Object.fromEntries(relationshipMetrics.map((metric) => [metric, (relation?.[metric] ?? null) !== null])) as Record<RelationshipMetric, boolean>));
	let values = $state(untrack(() => Object.fromEntries(relationshipMetrics.map((metric) => [metric, relation?.[metric] ?? 50])) as Record<RelationshipMetric, number>));
	const descriptions = { trust: '말과 약속을 믿는 정도', affinity: '함께 있고 싶은 마음', closeness: '가깝고 편하게 느끼는 정도', respect: '능력과 판단을 인정하는 정도', wariness: '조심하거나 위협을 느끼는 정도' };
</script>

<form method="POST" action="?/relationship" use:enhance class="relationship-form" aria-label={`${targetName}에 대한 ${scope === 'current' ? '현재' : '초기'} 관계`}>
	<input type="hidden" name="worldId" value={worldId} /><input type="hidden" name="revision" value={revision} /><input type="hidden" name="instanceId" value={instanceId} /><input type="hidden" name="targetId" value={targetId} /><input type="hidden" name="scope" value={scope} />
	<div class="relation-title"><h4>{targetName}에 대한 마음</h4><span>{scope === 'current' ? '지금의 관계' : '이야기 시작 시점'}</span></div>
	{#each relationshipMetrics as metric}
		<div class="metric-row">
			<div><strong>{relationshipLabels[metric]}</strong><small>{descriptions[metric]}</small></div>
			<label class="metric-known"><input type="checkbox" name={`${metric}Known`} bind:checked={known[metric]} />{known[metric] ? '평가함' : '미평가'}</label>
			<input type="range" min="0" max="100" step="1" bind:value={values[metric]} disabled={!known[metric]} aria-label={`${relationshipLabels[metric]} 조절`} />
			<label class="metric-number"><span class="sr-only">{relationshipLabels[metric]} 수치</span><!-- Unknown is displayed as a dash; it is never silently stored as the slider midpoint. -->{#if known[metric]}<input type="number" name={metric} min="0" max="100" step="1" bind:value={values[metric]} required />{:else}<input type="text" value="—" disabled />{/if}</label>
		</div>
	{/each}
	<p class="field-hint">미평가는 아직 판단하지 않았다는 뜻이에요. 각 항목은 서로 독립적입니다.</p>
	<label>상대를 어떻게 생각하나요?<textarea name="impression" rows="3" maxlength="600" value={(relation ?? unknownRelationship()).impression} placeholder="좋아하는 사람이지만 중요한 약속은 직접 확인하고 싶다…"></textarea></label>
	{#if scope === 'current' && relation?.evidenceEventIds.length}<p class="field-hint">기존에 목격한 사건의 근거 {relation.evidenceEventIds.length}건은 유지됩니다.</p>{/if}
	<div class="editor-actions"><button class="primary">관계 저장</button>{#if relation}<button type="submit" class="quiet-button" name="intent" value="remove" formnovalidate>이 관계 지우기</button>{/if}</div>
</form>
