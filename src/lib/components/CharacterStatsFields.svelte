<script lang="ts">
	import type { Character } from '$lib/game/types';

	let { stats }: { stats: Pick<Character, 'base' | 'talent' | 'abl' | 'exp' | 'relations' | 'palam'> } = $props();
	let sections: { title: string; fields: { key: string; label: string; value: number; min?: number; max?: number }[] }[] = $derived([
		{ title: 'BASE · 현재 자원', fields: [
			{ key: 'base.energy', label: '체력', value: stats.base.energy },
			{ key: 'base.maxEnergy', label: '최대 체력', value: stats.base.maxEnergy, min: 1 }
		] },
		{ title: 'TALENT · 성향 (0~100)', fields: [
			{ key: 'talent.pride', label: '자존심', value: stats.talent.pride, max: 100 },
			{ key: 'talent.openness', label: '개방성', value: stats.talent.openness, max: 100 },
			{ key: 'talent.libido', label: '기본 욕구', value: stats.talent.libido, max: 100 },
			{ key: 'talent.modesty', label: '수치심 성향', value: stats.talent.modesty, max: 100 },
			{ key: 'talent.assertiveness', label: '주도성', value: stats.talent.assertiveness, max: 100 },
			{ key: 'talent.receptiveness', label: '수용성', value: stats.talent.receptiveness, max: 100 },
			{ key: 'talent.curiosity', label: '호기심', value: stats.talent.curiosity, max: 100 }
		] },
		{ title: 'ABL · 능력', fields: [
			{ key: 'abl.conversation', label: '대화', value: stats.abl.conversation },
			{ key: 'abl.empathy', label: '공감', value: stats.abl.empathy },
			{ key: 'abl.seduction', label: '유혹', value: stats.abl.seduction },
			{ key: 'abl.intimacy', label: '친밀함', value: stats.abl.intimacy }
		] },
		{ title: 'EXP · 누적 경험', fields: [
			{ key: 'exp.social', label: '사회 경험', value: stats.exp.social },
			{ key: 'exp.romantic', label: '연애 경험', value: stats.exp.romantic },
			{ key: 'exp.seduction', label: '유혹 경험', value: stats.exp.seduction },
			{ key: 'exp.intimacy', label: '친밀 경험', value: stats.exp.intimacy }
		] },
		{ title: 'RELATION · 이 인물 → 플레이어 (0~100)', fields: [
			{ key: 'relation.affection', label: '호감', value: stats.relations.player.affection, max: 100 },
			{ key: 'relation.trust', label: '신뢰', value: stats.relations.player.trust, max: 100 },
			{ key: 'relation.desire', label: '상대를 향한 욕망', value: stats.relations.player.desire, max: 100 },
			{ key: 'relation.attachment', label: '애착', value: stats.relations.player.attachment, max: 100 },
			{ key: 'relation.jealousy', label: '질투', value: stats.relations.player.jealousy, max: 100 },
			{ key: 'relation.resentment', label: '반감', value: stats.relations.player.resentment, max: 100 }
		] },
		{ title: 'PALAM · 현재 장면의 반응 (0~100)', fields: [
			{ key: 'palam.rapport', label: '교감', value: stats.palam.rapport, max: 100 },
			{ key: 'palam.comfort', label: '편안함', value: stats.palam.comfort, max: 100 },
			{ key: 'palam.arousal', label: '현재 흥분', value: stats.palam.arousal, max: 100 },
			{ key: 'palam.pleasure', label: '현재 쾌감', value: stats.palam.pleasure, max: 100 },
			{ key: 'palam.embarrassment', label: '부끄러움', value: stats.palam.embarrassment, max: 100 },
			{ key: 'palam.tension', label: '긴장', value: stats.palam.tension, max: 100 },
			{ key: 'palam.frustration', label: '좌절', value: stats.palam.frustration, max: 100 },
			{ key: 'palam.satisfaction', label: '만족', value: stats.palam.satisfaction, max: 100 }
		] }
	]);
</script>

<div class="stat-fields">
	{#each sections as section}
		<fieldset><legend>{section.title}</legend><div class="stat-grid">
			{#each section.fields as field}
				<label>{field.label} <small>{field.key.split('.')[1]}</small>
					<input name={field.key} type="number" min={field.min ?? 0} max={field.max} step="1" required value={field.value} />
				</label>
			{/each}
		</div></fieldset>
	{/each}
</div>
