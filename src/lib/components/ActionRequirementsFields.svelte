<script lang="ts">
	import {
		ACTION_REQUIREMENT_ACTIONS,
		ACTION_REQUIREMENT_LABELS,
		ACTION_REQUIREMENT_STATS,
		actionRequirementMaximum,
		type ActionRequirement
	} from '$lib/game/types';

	let { requirements }: { requirements: ActionRequirement[] } = $props();
	function initialItems() { return requirements.map((requirement) => ({ ...requirement })); }
	let items = $state(initialItems());
	const actionLabels = { talk: '대화', listen: '이야기 듣기', flirt: '호감 표현', kiss: '입맞춤', intimacy: '함께 밤 보내기' };

	function addRequirement() {
		items.push({ actionId: 'flirt', stat: 'relation.trust', minimum: 0 });
	}

	function removeRequirement(index: number) {
		items.splice(index, 1);
	}
</script>

<fieldset class="requirement-table">
	<legend>행동 선행 조건</legend>
	<input type="hidden" name="requirements.present" value="1" />
	<p class="minor">현재 수치가 최소값 이상일 때 행동할 수 있습니다. 조건이 없는 행동은 관계 수치로 잠기지 않습니다.</p>
	<div class="requirement-head" aria-hidden="true"><span>행동</span><span>수치</span><span>최소값</span><span></span></div>
	{#each items as requirement, index}
		<div class="requirement-row">
			<label><span class="sr-only">행동</span><select name={`requirement.${index}.actionId`} bind:value={requirement.actionId}>
				{#each ACTION_REQUIREMENT_ACTIONS as action}<option value={action}>{actionLabels[action]}</option>{/each}
			</select></label>
			<label><span class="sr-only">수치</span><select name={`requirement.${index}.stat`} bind:value={requirement.stat}>
				{#each ACTION_REQUIREMENT_STATS as stat}<option value={stat}>{ACTION_REQUIREMENT_LABELS[stat]}</option>{/each}
			</select></label>
			<label><span class="sr-only">최소값</span><input name={`requirement.${index}.minimum`} type="number" min="0" max={actionRequirementMaximum(requirement.stat)} step="1" required bind:value={requirement.minimum} /></label>
			<button type="button" class="requirement-remove" aria-label="이 선행 조건 삭제" onclick={() => removeRequirement(index)}>−</button>
		</div>
	{/each}
	<button type="button" class="requirement-add" onclick={addRequirement}>＋ 조건 추가</button>
</fieldset>
