<script lang="ts">
	import type { Character } from '$lib/game/types';

	let { stats }: { stats: Pick<Character, 'base' | 'talent' | 'abl' | 'exp' | 'relation' | 'palam'> } = $props();
</script>

<div class="stat-fields">
	<fieldset>
		<legend>BASE · 기본 수치</legend>
		<div class="stat-grid">
			<label>체력 <small>energy</small><input name="base.energy" type="number" min="0" step="1" required value={stats.base.energy} /></label>
			<label>최대 체력 <small>maxEnergy</small><input name="base.maxEnergy" type="number" min="1" step="1" required value={stats.base.maxEnergy} /></label>
		</div>
	</fieldset>
	<fieldset>
		<legend>TALENT · 성향 (0~100)</legend>
		<div class="stat-grid">
			<label>자존심 <small>pride</small><input name="talent.pride" type="number" min="0" max="100" step="1" required value={stats.talent.pride} /></label>
			<label>개방성 <small>openness</small><input name="talent.openness" type="number" min="0" max="100" step="1" required value={stats.talent.openness} /></label>
			<label>공감 성향 <small>empathy</small><input name="talent.empathy" type="number" min="0" max="100" step="1" required value={stats.talent.empathy} /></label>
			<label>주도성 <small>assertiveness</small><input name="talent.assertiveness" type="number" min="0" max="100" step="1" required value={stats.talent.assertiveness} /></label>
		</div>
	</fieldset>
	<fieldset>
		<legend>ABL · 능력</legend>
		<div class="stat-grid">
			<label>대화 <small>conversation</small><input name="abl.conversation" type="number" min="0" step="1" required value={stats.abl.conversation} /></label>
			<label>공감 <small>empathy</small><input name="abl.empathy" type="number" min="0" step="1" required value={stats.abl.empathy} /></label>
			<label>유혹 <small>seduction</small><input name="abl.seduction" type="number" min="0" step="1" required value={stats.abl.seduction} /></label>
		</div>
	</fieldset>
	<fieldset>
		<legend>EXP · 경험</legend>
		<div class="stat-grid">
			<label>대화 <small>conversation</small><input name="exp.conversation" type="number" min="0" step="1" required value={stats.exp.conversation} /></label>
			<label>공감 <small>empathy</small><input name="exp.empathy" type="number" min="0" step="1" required value={stats.exp.empathy} /></label>
			<label>유혹 <small>seduction</small><input name="exp.seduction" type="number" min="0" step="1" required value={stats.exp.seduction} /></label>
		</div>
	</fieldset>
	<fieldset>
		<legend>RELATION · 관계</legend>
		<div class="stat-grid">
			<label>호감 <small>affection</small><input name="relation.affection" type="number" min="0" step="1" required value={stats.relation.affection} /></label>
			<label>신뢰 <small>trust</small><input name="relation.trust" type="number" min="0" step="1" required value={stats.relation.trust} /></label>
			<label>욕망 <small>desire</small><input name="relation.desire" type="number" min="0" step="1" required value={stats.relation.desire} /></label>
		</div>
	</fieldset>
	<fieldset>
		<legend>PALAM · 현재 반응</legend>
		<div class="stat-grid">
			<label>친밀 <small>rapport</small><input name="palam.rapport" type="number" min="0" step="1" required value={stats.palam.rapport} /></label>
			<label>신뢰 <small>trust</small><input name="palam.trust" type="number" min="0" step="1" required value={stats.palam.trust} /></label>
			<label>흥분 <small>arousal</small><input name="palam.arousal" type="number" min="0" step="1" required value={stats.palam.arousal} /></label>
			<label>쾌감 <small>pleasure</small><input name="palam.pleasure" type="number" min="0" step="1" required value={stats.palam.pleasure} /></label>
		</div>
	</fieldset>
</div>
