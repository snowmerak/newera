const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const RELATION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

const DEFAULT_BASE = { energy: 20, maxEnergy: 20 };
const DEFAULT_TALENT = { pride: 50, openness: 50, libido: 50, modesty: 50, assertiveness: 50, receptiveness: 50, curiosity: 50 };
const DEFAULT_ABL = { conversation: 1, empathy: 1, seduction: 1, intimacy: 1 };
const DEFAULT_EXP = { social: 0, romantic: 0, seduction: 0, intimacy: 0 };
const DEFAULT_RELATION = { affection: 0, trust: 0, desire: 0, attachment: 0, jealousy: 0, resentment: 0 };
const DEFAULT_PALAM = { rapport: 0, comfort: 0, arousal: 0, pleasure: 0, embarrassment: 0, tension: 0, frustration: 0, satisfaction: 0 };
const DEFAULT_REQUIREMENTS = [
  { actionId: 'flirt', stat: 'relation.trust', minimum: 2 },
  { actionId: 'kiss', stat: 'relation.affection', minimum: 5 },
  { actionId: 'kiss', stat: 'relation.trust', minimum: 4 },
  { actionId: 'kiss', stat: 'relation.desire', minimum: 3 },
  { actionId: 'intimacy', stat: 'relation.affection', minimum: 8 },
  { actionId: 'intimacy', stat: 'relation.trust', minimum: 7 },
  { actionId: 'intimacy', stat: 'relation.desire', minimum: 9 }
];

const ACTIONS = new Set(['talk', 'listen', 'flirt', 'kiss', 'intimacy']);
const REQUIREMENT_STATS = new Set([
  'base.energy',
  ...Object.keys(DEFAULT_TALENT).map((key) => `talent.${key}`),
  ...Object.keys(DEFAULT_ABL).map((key) => `abl.${key}`),
  ...Object.keys(DEFAULT_EXP).map((key) => `exp.${key}`),
  ...Object.keys(DEFAULT_RELATION).map((key) => `relation.${key}`),
  ...Object.keys(DEFAULT_PALAM).map((key) => `palam.${key}`)
]);
const NARRATIVE_MODES = new Set(['restrained', 'sensual', 'explicit']);

function error(path, message) {
  throw new Error(`${path}: ${message}`);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) error(path, '객체여야 합니다.');
  return value;
}

function knownKeys(value, path, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) error(`${path}.${key}`, '지원하지 않는 필드입니다. 철자를 확인해 주세요.');
  }
}

function text(value, path, maximum, required = true) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
    error(path, `${required ? '비어 있지 않은 ' : ''}${maximum}자 이하 문자열이어야 합니다.`);
  }
  return value.trim();
}

function whole(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    error(path, `${minimum}~${maximum} 범위의 정수여야 합니다.`);
  }
  return value;
}

function numbers(value, path, defaults, maximum) {
  const supplied = value === undefined ? {} : object(value, path);
  for (const key of Object.keys(supplied)) {
    if (!(key in defaults)) error(`${path}.${key}`, '지원하지 않는 수치입니다.');
  }
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
    key,
    whole(supplied[key] ?? fallback, `${path}.${key}`, 0, maximum ?? Number.MAX_SAFE_INTEGER)
  ]));
}

function strings(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) error(path, '최대 30개의 문자열 배열이어야 합니다.');
  return [...new Set(value.map((item, index) => text(item, `${path}[${index}]`, 100)))];
}

function requirements(value, path) {
  if (value === undefined) return DEFAULT_REQUIREMENTS.map((entry) => ({ ...entry }));
  if (!Array.isArray(value) || value.length > 50) error(path, '최대 50개의 배열이어야 합니다.');
  const seen = new Set();
  return value.map((item, index) => {
    const row = object(item, `${path}[${index}]`);
    knownKeys(row, `${path}[${index}]`, ['actionId', 'stat', 'minimum']);
    if (!ACTIONS.has(row.actionId)) error(`${path}[${index}].actionId`, '지원하지 않는 행동입니다.');
    if (!REQUIREMENT_STATS.has(row.stat)) error(`${path}[${index}].stat`, '지원하지 않는 수치 경로입니다.');
    const maximum = /^(talent|relation|palam)\./.test(row.stat) ? 100 : Number.MAX_SAFE_INTEGER;
    const minimum = whole(row.minimum, `${path}[${index}].minimum`, 0, maximum);
    const key = `${row.actionId}:${row.stat}`;
    if (seen.has(key)) error(`${path}[${index}]`, '같은 행동과 수치 조건이 중복되었습니다.');
    seen.add(key);
    return { actionId: row.actionId, stat: row.stat, minimum };
  });
}

function normalizeCharacter(value, index, allowNamespacedId = false) {
  const path = `characters[${index}]`;
  const input = object(value, path);
  const allowedFields = [
    'id', 'name', 'age', 'portrait', 'introduction', 'profile', 'base', 'trait', 'talent', 'abl', 'exp',
    'mark', 'relations', 'palam', 'actionRequirements'
  ];
  if (allowNamespacedId) allowedFields.push('moduleId');
  knownKeys(input, path, allowedFields);
  const id = text(input.id, `${path}.id`, 60);
  if (!(allowNamespacedId ? RELATION_ID_PATTERN : ID_PATTERN).test(id)) {
    error(`${path}.id`, `영문 소문자, 숫자, 점, 밑줄, 하이픈${allowNamespacedId ? ', 콜론' : ''}만 사용할 수 있습니다.`);
  }
  const age = whole(input.age, `${path}.age`, 20, 120);
  const base = numbers(input.base, `${path}.base`, DEFAULT_BASE);
  if (base.maxEnergy < 1 || base.energy > base.maxEnergy) error(`${path}.base`, 'energy는 maxEnergy 이하여야 하고 maxEnergy는 1 이상이어야 합니다.');
  const relationsInput = input.relations === undefined ? {} : object(input.relations, `${path}.relations`);
  const relations = {};
  for (const [targetId, relation] of Object.entries(relationsInput)) {
    if (!RELATION_ID_PATTERN.test(targetId)) error(`${path}.relations`, `대상 ID '${targetId}' 형식이 올바르지 않습니다.`);
    relations[targetId] = numbers(relation, `${path}.relations.${targetId}`, DEFAULT_RELATION, 100);
  }
  relations.player ??= { ...DEFAULT_RELATION };
  return {
    id,
    moduleId: null,
    name: text(input.name, `${path}.name`, 100),
    age,
    portrait: text(input.portrait, `${path}.portrait`, 500, false),
    introduction: text(input.introduction, `${path}.introduction`, 500),
    profile: text(input.profile, `${path}.profile`, 20_000),
    base,
    trait: strings(input.trait, `${path}.trait`),
    talent: numbers(input.talent, `${path}.talent`, DEFAULT_TALENT, 100),
    abl: numbers(input.abl, `${path}.abl`, DEFAULT_ABL),
    exp: numbers(input.exp, `${path}.exp`, DEFAULT_EXP),
    mark: strings(input.mark, `${path}.mark`),
    relations,
    palam: numbers(input.palam, `${path}.palam`, DEFAULT_PALAM, 100),
    actionRequirements: requirements(input.actionRequirements, `${path}.actionRequirements`)
  };
}

export function validateSource(value) {
  const source = object(value, 'source');
  knownKeys(source, 'source', ['format', 'version', 'title', 'start', 'world', 'characters']);
  if (source.format !== 'newera-lore-source' || source.version !== 1) error('source', 'format은 newera-lore-source, version은 1이어야 합니다.');
  const title = text(source.title, 'title', 80);
  const startInput = object(source.start, 'start');
  knownKeys(startInput, 'start', ['day', 'time', 'location']);
  const time = text(startInput.time, 'start.time', 5);
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) error('start.time', 'HH:MM 형식의 유효한 시각이어야 합니다.');
  const start = {
    day: whole(startInput.day, 'start.day', 1),
    minute: Number(match[1]) * 60 + Number(match[2]),
    location: text(startInput.location, 'start.location', 500)
  };
  const worldInput = object(source.world, 'world');
  knownKeys(worldInput, 'world', ['setting', 'eraRules', 'narrativeMode', 'memory']);
  const narrativeMode = worldInput.narrativeMode ?? 'sensual';
  if (!NARRATIVE_MODES.has(narrativeMode)) error('world.narrativeMode', 'restrained, sensual, explicit 중 하나여야 합니다.');
  const world = {
    setting: text(worldInput.setting, 'world.setting', 20_000),
    eraRules: text(worldInput.eraRules, 'world.eraRules', 10_000),
    narrativeMode,
    memory: text(worldInput.memory, 'world.memory', 10_000, false)
  };
  if (!Array.isArray(source.characters) || source.characters.length > 50) error('characters', '최대 50명의 배열이어야 합니다.');
  const characters = source.characters.map(normalizeCharacter);
  const ids = new Set();
  for (const character of characters) {
    if (ids.has(character.id)) error('characters', `ID '${character.id}'가 중복되었습니다.`);
    ids.add(character.id);
  }
  for (const character of characters) {
    for (const targetId of Object.keys(character.relations)) {
      if (targetId !== 'player' && !ids.has(targetId)) error(`characters.${character.id}.relations.${targetId}`, '로어에 없는 인물을 가리킵니다.');
    }
  }
  return { title, start, world, characters };
}

function characterRow(character, sortOrder) {
  return {
    id: character.id,
    module_id: null,
    sort_order: sortOrder,
    name: character.name,
    age: character.age,
    portrait: character.portrait,
    introduction: character.introduction,
    profile: character.profile,
    base_json: JSON.stringify(character.base),
    trait_json: JSON.stringify(character.trait),
    talent_json: JSON.stringify(character.talent),
    abl_json: JSON.stringify(character.abl),
    exp_json: JSON.stringify(character.exp),
    mark_json: JSON.stringify(character.mark),
    relation_json: JSON.stringify(character.relations),
    palam_json: JSON.stringify(character.palam),
    action_requirements_json: JSON.stringify(character.actionRequirements)
  };
}

export function buildBundle(value) {
  const source = validateSource(value);
  const state = {
    world: [{ id: 1, turn: 0, day: source.start.day, minute: source.start.minute, location: source.start.location }],
    config: [{
      id: 1,
      world_setting: source.world.setting,
      era_rules: source.world.eraRules,
      narrative_mode: source.world.narrativeMode,
      world_memory: source.world.memory,
      scene_note: '',
      pending_proposal_json: null,
      player_suggestions_json: null
    }],
    characters: source.characters.map(characterRow),
    characterTemplates: source.characters.map((character, sortOrder) => ({
      id: character.id,
      sort_order: sortOrder,
      character_json: JSON.stringify(character)
    })),
    events: [],
    memories: [],
    modules: [],
    enabledModuleIds: []
  };
  return {
    format: 'newera-lore',
    version: 1,
    title: source.title,
    sessionStart: { day: source.start.day, minute: source.start.minute, location: source.start.location, worldMemory: source.world.memory },
    state,
    saves: []
  };
}

function parseField(row, field, path) {
  if (typeof row[field] !== 'string') error(`${path}.${field}`, 'JSON 문자열이어야 합니다.');
  try { return JSON.parse(row[field]); } catch { error(`${path}.${field}`, '내부 JSON 문자열이 올바르지 않습니다.'); }
}

export function validateBundle(value) {
  const bundle = object(value, 'bundle');
  if (bundle.format !== 'newera-lore' || bundle.version !== 1) error('bundle', 'format은 newera-lore, version은 1이어야 합니다.');
  const title = text(bundle.title, 'title', 80);
  const state = object(bundle.state, 'state');
  if (!Array.isArray(state.world) || state.world.length !== 1) error('state.world', '세계 상태 한 행이 필요합니다.');
  const world = object(state.world[0], 'state.world[0]');
  whole(world.turn, 'state.world[0].turn', 0);
  whole(world.day, 'state.world[0].day', 1);
  whole(world.minute, 'state.world[0].minute', 0, 1439);
  text(world.location, 'state.world[0].location', 500);
  if (!Array.isArray(state.config) || state.config.length !== 1) error('state.config', '설정 한 행이 필요합니다.');
  const config = object(state.config[0], 'state.config[0]');
  text(config.world_setting, 'state.config[0].world_setting', 20_000);
  text(config.era_rules, 'state.config[0].era_rules', 10_000);
  const narrativeMode = config.narrative_mode ?? 'sensual';
  if (!NARRATIVE_MODES.has(narrativeMode)) error('state.config[0].narrative_mode', '지원하지 않는 묘사 모드입니다.');
  if (!Array.isArray(state.characters)) error('state.characters', '배열이어야 합니다.');
  const sessionIds = new Set();
  state.characters.forEach((raw, index) => {
    const row = object(raw, `state.characters[${index}]`);
    const candidate = {
      id: row.id,
      name: row.name,
      age: row.age,
      portrait: row.portrait ?? '',
      introduction: row.introduction,
      profile: row.profile ?? row.introduction,
      base: parseField(row, 'base_json', `state.characters[${index}]`),
      trait: parseField(row, 'trait_json', `state.characters[${index}]`),
      talent: parseField(row, 'talent_json', `state.characters[${index}]`),
      abl: parseField(row, 'abl_json', `state.characters[${index}]`),
      exp: parseField(row, 'exp_json', `state.characters[${index}]`),
      mark: parseField(row, 'mark_json', `state.characters[${index}]`),
      relations: parseField(row, 'relation_json', `state.characters[${index}]`),
      palam: parseField(row, 'palam_json', `state.characters[${index}]`),
      actionRequirements: parseField(row, 'action_requirements_json', `state.characters[${index}]`)
    };
    const character = normalizeCharacter(candidate, index, true);
    if (sessionIds.has(character.id)) error('state.characters', `ID '${character.id}'가 중복되었습니다.`);
    sessionIds.add(character.id);
  });
  if (!Array.isArray(state.characterTemplates)) error('state.characterTemplates', '배열이어야 합니다.');
  const templateIds = new Set();
  state.characterTemplates.forEach((raw, index) => {
    const row = object(raw, `state.characterTemplates[${index}]`);
    whole(row.sort_order, `state.characterTemplates[${index}].sort_order`, 0);
    if (typeof row.character_json !== 'string') error(`state.characterTemplates[${index}].character_json`, 'JSON 문자열이어야 합니다.');
    let character;
    try { character = JSON.parse(row.character_json); } catch { error(`state.characterTemplates[${index}].character_json`, '내부 JSON이 올바르지 않습니다.'); }
    const normalized = normalizeCharacter(character, index, true);
    if (normalized.id !== row.id) error(`state.characterTemplates[${index}]`, '행 ID와 character_json의 ID가 다릅니다.');
    templateIds.add(normalized.id);
  });
  if (sessionIds.size !== templateIds.size || [...sessionIds].some((id) => !templateIds.has(id))) {
    error('state.characterTemplates', '현재 인물과 인물 원본의 ID 목록이 다릅니다.');
  }
  for (const field of ['events', 'memories', 'modules', 'enabledModuleIds']) {
    if (!Array.isArray(state[field])) error(`state.${field}`, '배열이어야 합니다.');
  }
  if (!Array.isArray(bundle.saves) || bundle.saves.length > 3) error('saves', '최대 3개의 배열이어야 합니다.');
  return { title, narrativeMode, characterCount: sessionIds.size, turn: world.turn };
}
