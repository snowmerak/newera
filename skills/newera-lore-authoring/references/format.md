# newera 로어 작성 형식

## 두 JSON 형식

### `newera-lore-source`

사람과 에이전트가 새 로어를 작성하기 위한 원본이다. 앱이 직접 읽는 형식은 아니며 `scripts/build-lore.mjs`로 변환한다. 인물 원본과 현재 세션을 중복 작성하거나 JSON 안에 JSON 문자열을 직접 이스케이프할 필요가 없다.

### `newera-lore`

newera의 `/lores`에서 가져오는 완성형 번들이다. 현재 세계 상태, 인물 원본, 플레이 중인 인물 수치, 사건, 기억과 저장 슬롯을 담는다. 새 로어는 source에서 빌드하고, 진행 중인 로어는 게임에서 내보내는 것이 안전하다.

## Source 최상위 필드

| 필드 | 형식 | 의미 |
| --- | --- | --- |
| `format` | `"newera-lore-source"` | 고정값 |
| `version` | `1` | 고정값 |
| `title` | 문자열, 1~80자 | 사이드바에 표시할 로어 제목 |
| `start.day` | 1 이상의 정수 | 시작 일차 |
| `start.time` | `HH:MM` | 시작 시각 |
| `start.location` | 문자열 | 첫 장면의 정확한 장소 |
| `world.setting` | 문자열 | 시대, 장소, 생활 조건, 주요 갈등과 움직이는 요소 |
| `world.eraRules` | 문자열 | 세계와 인물이 따라야 할 진행 규칙 |
| `world.narrativeMode` | 아래 표의 값 | 로어별 묘사 모드 |
| `world.memory` | 문자열, 선택 | 시작 시점에 이미 확정된 세계 사실 |
| `characters` | 배열 | 0~50명의 성인 인물 |

### 묘사 모드

| 값 | 동작 |
| --- | --- |
| `restrained` | 간결한 문장, 암시와 여운 중심 |
| `sensual` | 감각과 직접 표현, 짧은 비유를 혼합 |
| `explicit` | 실제 성적 장면에서 행위와 신체 반응을 생략하지 않고 직접 묘사 |

묘사 모드는 문체만 바꾼다. 캐릭터의 성향, 행동 조건, 수락과 거절 판단은 바꾸지 않는다.

## 캐릭터 필드

필수 필드는 `id`, `name`, `age`, `introduction`, `profile`이다. 나이는 20~120의 정수다. `id`는 영문 소문자나 숫자로 시작하고 영문 소문자, 숫자, `.`, `_`, `-`만 사용한다.

| 필드 | 의미 |
| --- | --- |
| `introduction` | 목록이나 첫 등장에 쓸 500자 이하의 짧은 소개 |
| `profile` | 배경, 목표, 가치관, 일정, 말투, 관계, 욕망과 경계를 담는 상세 설정 |
| `portrait` | 선택 문자열. 현재 UI가 사용할 수 있는 이미지 경로 |
| `trait` | 자유 문자열 성향 목록. 최대 30개 |
| `base` | 현재 자원. `energy`, `maxEnergy` |
| `talent` | 비교적 고정된 성향. 각 0~100 |
| `abl` | 성장 가능한 능력. 0 이상의 정수 |
| `exp` | 누적 경험. 0 이상의 정수 |
| `mark` | 이미 일어난 중요한 이력과 사용자 정의 마크 |
| `relations` | 대상별 장기 관계. 플레이어 ID는 `player` |
| `palam` | 시작 장면에만 적용되는 현재 반응. 각 0~100 |
| `actionRequirements` | 행동별 최소 요구 수치 목록 |

생략한 수치 객체나 그 안의 필드는 빌더가 기본값으로 채운다. 관계가 시작된 설정이라면 `EXP`, `MARK`, `RELATION`을 실제 관계에 맞게 설정한다. 이미 연인인데 모든 값이 0인 식의 모순을 만들지 않는다.

## 수치 의미

### TALENT

| 키 | 의미 |
| --- | --- |
| `pride` | 자존심과 자기 기준 |
| `openness` | 감정과 새로운 경험에 열린 정도 |
| `libido` | 평소의 성적 욕구 성향 |
| `modesty` | 노출과 성적 상황에서 수치심을 느끼는 성향 |
| `assertiveness` | 자기 의사와 경계를 먼저 표현하는 정도 |
| `receptiveness` | 타인의 제안과 접근을 받아들이는 성향 |
| `curiosity` | 새로운 사람, 정보와 경험에 대한 호기심 |

### ABL과 EXP

`ABL` 키는 `conversation`, `empathy`, `seduction`, `intimacy`다. `EXP` 키는 `social`, `romantic`, `seduction`, `intimacy`다. 능력과 누적 경험은 별개다.

### RELATION

`affection`, `trust`, `desire`, `attachment`, `jealousy`, `resentment`를 대상별로 저장한다. 호감과 신뢰, 욕망은 서로 대체하지 않는다. 인물 간 관계는 다른 인물 ID를 키로 추가할 수 있다.

### PALAM

`rapport`, `comfort`, `arousal`, `pleasure`, `embarrassment`, `tension`, `frustration`, `satisfaction`을 저장한다. PALAM은 현재 장면 반응이며 새 장면에서 초기화될 수 있다. 특별한 시작 장면이 아니라면 0으로 두는 편이 자연스럽다.

### MARK

표준 마크는 `firstDate`, `firstKiss`, `firstIntimacy`, `becameLovers`, `exclusiveRelationship`, `relationshipCrisis`, `reconciled`다. 그 밖의 이력도 자유 문자열로 넣을 수 있다. 첫 대화나 친구가 된 사건처럼 로어에 필요한 사용자 정의 마크도 허용된다.

## 행동 조건

한 행은 다음 구조다.

```json
{ "actionId": "kiss", "stat": "relation.trust", "minimum": 20 }
```

`actionId`는 `talk`, `listen`, `flirt`, `kiss`, `intimacy` 중 하나다. 같은 행동에 여러 행이 있으면 모두 충족해야 한다. 행이 없는 수치는 그 행동을 제한하지 않는다.

`stat`에는 다음 경로를 쓸 수 있다.

- `base.energy`
- `talent.pride`, `talent.openness`, `talent.libido`, `talent.modesty`, `talent.assertiveness`, `talent.receptiveness`, `talent.curiosity`
- `abl.conversation`, `abl.empathy`, `abl.seduction`, `abl.intimacy`
- `exp.social`, `exp.romantic`, `exp.seduction`, `exp.intimacy`
- `relation.affection`, `relation.trust`, `relation.desire`, `relation.attachment`, `relation.jealousy`, `relation.resentment`
- `palam.rapport`, `palam.comfort`, `palam.arousal`, `palam.pleasure`, `palam.embarrassment`, `palam.tension`, `palam.frustration`, `palam.satisfaction`

TALENT, RELATION, PALAM 조건은 0~100이고 나머지는 0 이상의 정수다. 캐릭터마다 다른 조건을 사용해 접근성, 경계와 관계 속도를 표현한다.

## 빌드 결과

빌더는 source를 다음과 같이 변환한다.

- `state.world`: 0턴의 시간과 장소
- `state.config`: 세계관, 규칙, 묘사 모드와 시작 기억
- `state.characters`: 현재 세션의 인물 행과 JSON 문자열 수치
- `state.characterTemplates`: 세션 초기화에 사용할 인물 원본
- `events`, `memories`, `saves`: 빈 배열
- `sessionStart`: 세션 초기화 시 돌아갈 시간, 장소와 세계 기억

완성형 번들을 직접 수정할 때 `state.characters`는 현재 플레이 수치이고 `state.characterTemplates[].character_json`은 새 세션의 원본이다. 진행 중인 파일에서 둘을 무심코 같게 만들지 않는다. `events`, `memories`, `saves`는 실제 진행 기록이므로 요청 없이 지우거나 재작성하지 않는다.

## 모듈과의 차이

`newera-lore`는 별도 플레이 세션 전체를 가져온다. `schemaVersion: 1` 모듈은 기존 로어에 세계관 또는 인물만 설치한다. 사용자가 “이 설정으로 새 게임을 시작할 파일”을 원하면 로어를 만들고, “현재 게임에 이 인물을 추가할 파일”을 원하면 모듈을 만든다.
