<script lang="ts">
	import { STANDARD_MARKS } from '$lib/game/types';
	let { marks }: { marks: string[] } = $props();
	const labels: Record<string, string> = {
		firstConversation: '첫 대화', becameFriend: '친구가 됨',
		firstDate: '첫 데이트', firstKiss: '첫 입맞춤', firstIntimacy: '첫 친밀 관계',
		becameLovers: '연인이 됨', exclusiveRelationship: '독점 관계',
		relationshipCrisis: '관계 위기', reconciled: '화해'
	};
	const standard = ['firstConversation', 'becameFriend', ...STANDARD_MARKS];
	let custom = $derived(marks.filter((mark) => !standard.includes(mark)).join(', '));
</script>

<fieldset class="sim-marks"><legend>MARK · 지속 사건 / 상태</legend>
	<input type="hidden" name="mark.present" value="1" />
	<div class="stat-grid">
		{#each standard as mark}
			<label><input name={`mark.${mark}`} type="checkbox" checked={marks.includes(mark)} /> {labels[mark]} <small>{mark}</small></label>
		{/each}
	</div>
	<label>추가 MARK <small>쉼표로 구분 · 모듈 사용자 정의 태그</small><input name="mark.custom" value={custom} /></label>
</fieldset>
