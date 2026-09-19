<script lang="ts">
	import { PALAM_METADATA, type Character } from '$lib/game/types';

	type StatField = { key: string; label: string; description: string; value: number; min?: number; max?: number };
	type StatSection = { title: string; description: string; fields: StatField[] };

	let { stats }: { stats: Pick<Character, 'base' | 'talent' | 'abl' | 'exp' | 'relations' | 'palam'> } = $props();
	let sections: StatSection[] = $derived([
		{ title: 'BASE · 현재 자원', description: '인물이 현재 사용할 수 있는 자원입니다.', fields: [
			{ key: 'base.energy', label: '체력', description: '인물의 현재 행동 여력', value: stats.base.energy },
			{ key: 'base.maxEnergy', label: '최대 체력', description: '체력이 회복될 수 있는 상한', value: stats.base.maxEnergy, min: 1 }
		] },
		{ title: 'TALENT · 성향 (0~100)', description: '쉽게 바뀌지 않는 인물의 기본 성향입니다.', fields: [
			{ key: 'talent.pride', label: '자존심', description: '자신의 기준과 자존감을 지키려는 성향', value: stats.talent.pride, max: 100 },
			{ key: 'talent.openness', label: '개방성', description: '생각과 감정을 드러내고 새로운 관계를 받아들이는 성향', value: stats.talent.openness, max: 100 },
			{ key: 'talent.libido', label: '기본 욕구', description: '장면의 흥분과 별개인 평소의 성적 욕구', value: stats.talent.libido, max: 100 },
			{ key: 'talent.modesty', label: '수치심 성향', description: '노출과 친밀한 상황에서 부끄러움을 느끼는 성향', value: stats.talent.modesty, max: 100 },
			{ key: 'talent.assertiveness', label: '주도성', description: '먼저 행동하고 자신의 의견을 유지하는 성향', value: stats.talent.assertiveness, max: 100 },
			{ key: 'talent.receptiveness', label: '수용성', description: '상대의 말과 제안을 듣고 반응하는 성향', value: stats.talent.receptiveness, max: 100 },
			{ key: 'talent.curiosity', label: '호기심', description: '새로운 상황과 정보를 탐색하려는 성향', value: stats.talent.curiosity, max: 100 }
		] },
		{ title: 'ABL · 능력', description: '행동의 효과에 영향을 주는 숙련도입니다.', fields: [
			{ key: 'abl.conversation', label: '대화', description: '대화를 이어가고 교감을 만드는 능력', value: stats.abl.conversation },
			{ key: 'abl.empathy', label: '공감', description: '상대의 감정을 읽고 편안하게 하는 능력', value: stats.abl.empathy },
			{ key: 'abl.seduction', label: '유혹', description: '호감과 욕망을 자극하는 능력', value: stats.abl.seduction },
			{ key: 'abl.intimacy', label: '친밀함', description: '친밀한 관계에서 상대를 배려하고 반응하는 능력', value: stats.abl.intimacy }
		] },
		{ title: 'EXP · 누적 경험', description: '해당 분야의 행동으로 쌓인 장기 경험입니다.', fields: [
			{ key: 'exp.social', label: '사회 경험', description: '대화와 사회적 교류로 쌓인 경험', value: stats.exp.social },
			{ key: 'exp.romantic', label: '연애 경험', description: '연애와 애정 표현으로 쌓인 경험', value: stats.exp.romantic },
			{ key: 'exp.seduction', label: '유혹 경험', description: '유혹과 성적 교감으로 쌓인 경험', value: stats.exp.seduction },
			{ key: 'exp.intimacy', label: '친밀 경험', description: '성적 친밀감을 나눈 누적 경험', value: stats.exp.intimacy }
		] },
		{ title: 'RELATION · 이 인물 → 플레이어 (0~100)', description: '장면이 바뀌어도 유지되는 플레이어와의 장기 관계입니다.', fields: [
			{ key: 'relation.affection', label: '호감', description: '플레이어를 좋아하고 아끼는 마음', value: stats.relations.player.affection, max: 100 },
			{ key: 'relation.trust', label: '신뢰', description: '플레이어의 말과 행동을 믿을 수 있다는 판단', value: stats.relations.player.trust, max: 100 },
			{ key: 'relation.desire', label: '상대를 향한 욕망', description: '플레이어에게 느끼는 지속적인 성적 끌림', value: stats.relations.player.desire, max: 100 },
			{ key: 'relation.attachment', label: '애착', description: '관계를 지키고 가까이 있고 싶은 정서적 유대', value: stats.relations.player.attachment, max: 100 },
			{ key: 'relation.jealousy', label: '질투', description: '관계를 빼앗기거나 위협받을 수 있다는 감정', value: stats.relations.player.jealousy, max: 100 },
			{ key: 'relation.resentment', label: '반감', description: '플레이어에게 쌓인 불만과 적의', value: stats.relations.player.resentment, max: 100 }
		] },
		{ title: 'PALAM · 첫 장면의 초기 반응 (0~100)', description: '플레이를 시작할 때의 잠시적 반응입니다. 새 장면이 시작되면 0으로 초기화됩니다.', fields: PALAM_METADATA.map((field) => ({
			key: `palam.${field.key}`, label: field.label, description: field.description,
			value: stats.palam[field.key], max: 100
		})) }
	]);
</script>

<div class="stat-fields">
	{#each sections as section}
		<fieldset><legend>{section.title}</legend><p class="stat-section-note">{section.description}</p><div class="stat-grid">
			{#each section.fields as field}
				<label><span>{field.label} <code>{field.key.split('.')[1]}</code></span><small>{field.description}</small>
					<input name={field.key} type="number" min={field.min ?? 0} max={field.max} step="1" required value={field.value} />
				</label>
			{/each}
		</div></fieldset>
	{/each}
</div>
