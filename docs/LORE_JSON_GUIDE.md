# 세계관 JSON 안내

검증 기준은 `src/lib/theater/validation.ts`다. 새 세계관 파일은 `format: "newera-theater"`, `version: 2`를 사용한다. 실행 가능한 예제는 `static/lore-presets/theater-opening.json`, 작성 원본은 `skills/newera-lore-authoring/assets/example-source.json`이다.

캐릭터의 선택적 외모·옷/음식 취향·옷차림 후보, 공개 초기 관계와 현재 인상착의, `appearanceSelection`, 세계관의 `appearanceChangeMinutes`는 [인물 소개·인상착의 계약](CHARACTER_PRESENTATION.md)을 따른다. 기존 v2 파일에는 이 필드가 없어도 된다.

`world.definition.writingStyle`은 선택적 서술 문체 프롬프트다. 최대 4000자의 문자열이며 비워두거나 생략하면 기존 기본 프롬프트를 사용한다. 상세 행동·대사 생성에만 전달하고 행동 여부 판단·관계 해석에는 전달하지 않는다. 저장 슬롯과 내보내기에 포함하며, [작업실 문체 설정](EDITOR_GUIDE.md#세계관)에서 수정한다.

현재 캐릭터 인스턴스는 선택적으로 `inactivity: { "mode": "continue", "tick": 1, "model": "판단 모델 ID" }`를 저장한다. `mode`는 `watch`·`continue`·`idle` 중 하나이고, 선택 시점은 현재 tick 이하여야 한다. `watch`는 지켜보는 wait 사건을 남긴다. `continue`와 `idle`은 사건·목격 기억·대사를 만들지 않으며, 실제 일을 완료하거나 오브젝트를 조작하지 않는다. 새 사건을 보고 다시 참여하면 이 비참여 상태를 해제한다. 타인의 비공개 상태는 관찰 입력에 공유하지 않는다. 초기 배치에 가짜 과거 선택을 넣지 않는다.

## 파일 구성

```json
{
  "format": "newera-theater",
  "version": 2,
  "world": {
    "definition": {
      "name": "작은 극장",
      "description": "비가 그친 저녁의 동네 극장.",
      "rules": "현장에서 목격한 일에만 반응한다.",
      "startingSceneId": "lobby",
      "scenes": [
        { "id": "lobby", "name": "로비", "description": "조용한 로비.", "exits": ["backstage"] },
        { "id": "backstage", "name": "무대 뒤", "description": "소품이 놓인 준비실.", "exits": ["lobby"] }
      ],
      "templates": [],
      "spawns": []
    }
  },
  "saves": []
}
```

`world.state`를 생략하면 `startingSceneId`와 `spawns`에서 초기 진행을 만든다. 내보내기에는 현재 `state`와 최대 세 개의 저장 슬롯이 포함된다. 슬롯의 형식은 `{ "slot": 1, "savedAt": "...", "world": { "definition": {}, "state": {} } }`다.

씬·원형·인스턴스의 ID는 영문·숫자로 시작하고 영문·숫자·점·밑줄·콜론·하이픈을 쓴다. 인스턴스 ID `player`, `stage`는 예약되어 있다. ID는 각 목록 안에서 유일해야 하며 씬 출구·원형·배치 참조가 모두 존재해야 한다. 출구는 방향을 가진다. 편집 화면의 씬 추가·수정은 해당 씬의 인접 목록만 저장하며, 서로 오가려면 반대편 씬에도 출구를 등록한다.

## 원형과 독립 인스턴스

캐릭터 원형:

```json
{
  "id": "performer",
  "kind": "character",
  "name": "배우",
  "description": "첫 공연을 준비하는 신인 배우.",
  "personality": "조심스럽지만 할 말은 분명히 한다.",
  "goals": ["공연 전에 마지막 장면을 맞춰본다"],
  "initialState": { "mood": "긴장함" },
  "interactions": [],
  "reactions": []
}
```

배치는 `spawns`에 추가한다:

```json
{
  "id": "harin",
  "templateId": "performer",
  "sceneId": "lobby",
  "name": "하린",
  "companion": true,
  "state": { "mood": "기대함" }
}
```

원형의 초기 상태에 배치의 상태를 덮어써 인스턴스를 만든다. 같은 원형을 여러 번 배치해도 상태와 기억은 공유하지 않는다. 동행의 초기 배치는 시작 씬이어야 하고, 진행 중에는 현재 씬의 캐릭터만 동행으로 지정할 수 있다. `state`는 최대 100개의 문자열·유한 숫자·참거짓·null 값이며 중첩 객체를 지원하지 않는다.

## 진행의 메모와 생성 기록

캐릭터의 `memories`는 목격한 사건의 주체와 대상을 분리해 저장한다. 예를 들어 플레이어가 작업등을 끈 사건은 다음과 같다.

```json
{
  "eventId": "event-light-off",
  "tick": 4,
  "sceneId": "stage",
  "kind": "interact",
  "actorId": "player",
  "targetId": "stage-light",
  "interactionId": "off",
  "body": { "narrative": "작업등 스위치를 내린다.", "utterance": null },
  "changes": { "on": false }
}
```

`actorId`는 실제 실행 주체를 실행기가 붙인 값이다. 모델 출력은 `actionId`, `targetId`, `narrative`, `utterance`, `memoUpdate`이며 주체를 지정할 수 없다. `targetId`는 선택한 행동의 대상과 일치해야 한다. `body.utterance`는 해당 주체가 한 말의 원문이므로 발언 속 주장이 실제 행동 기록과 같다고 가정하지 않는다.

기존 `{ "eventId": "...", "tick": 4, "text": "..." }` 기억도 읽을 수 있다. 연결된 사건이 있으면 그 사건의 주체·대상·본문을 복원하며 문자열을 자연어로 재작성하지 않는다. 연결된 사건이 없는 옛 문자열은 보존하지만 모델 입력에서 제외한다. 구조화된 기억의 주체·대상이 연결된 사건과 다르면 가져오기를 거부한다.

현재 진행의 캐릭터 인스턴스는 `memories`(목격 사건)와 별도로 선택 필드 `memo`를 가진다. 생략하거나 null이면 개인 메모가 없다. 객체일 때는 `summary`(최대 1200자), `currentIntention`(최대 600자), `feelings`, `openThreads`가 모두 필요하다. 두 목록은 각각 최대 8개, 항목당 300자다. 생성 모델은 자기 메모만 갱신하며 다른 캐릭터의 입력에는 노출하지 않는다. 원형이나 초기 배치의 `state`에 이 중첩 메모를 넣지 않는다.

사건에는 선택 필드 `narrative`(행동 묘사), `utterance`(대사)가 추가될 수 있다. `decision`에는 판단 모델·행동 ID와 `acted`(행동 여부), `generationModel`을 기록한다. 기존 version 2 사건의 `reaction`, `intensity`는 읽을 수 있으나 새 판단에서는 생성하지 않는다. 내보내기와 슬롯은 이 필드를 유지한다.

## 조건부 상호작용과 사건 반응

오브젝트는 다음처럼 정의한다:

```json
{
  "id": "lamp",
  "kind": "object",
  "name": "작업등",
  "description": "벽의 스위치로 켜는 작업등.",
  "personality": "",
  "goals": [],
  "initialState": { "on": false },
  "interactions": [
    {
      "id": "switch-on",
      "label": "불을 켠다",
      "description": "스위치를 올린다.",
      "conditions": [{ "key": "on", "equals": false }],
      "effects": { "on": true }
    }
  ],
  "reactions": [
    {
      "id": "light-up",
      "on": "interact",
      "targeted": true,
      "conditions": [{ "key": "on", "equals": true }],
      "effects": { "noticed": true },
      "text": "작업등 아래로 따뜻한 빛이 번진다."
    }
  ]
}
```

조건은 모두 만족해야 한다. 상호작용은 대상의 조건을 검사하고 효과를 적용한다. 오브젝트 반응은 같은 씬에서 `on`에 해당하는 사건을 보면 검사한다. `targeted: true`면 사건의 대상이 자기 자신이어야 한다. 상호작용 효과가 먼저 적용된 후 반응 조건을 확인한다. 반응의 효과는 해당 오브젝트 자신의 상태에만 적용한다.

`on`은 `speak`, `interact`, `wait`, `move`, `enter`, `leave`, `change` 중 하나다. 이동은 `leave`와 `enter`를 발생시킨다. 반응이 만드는 `change` 사건은 같은 실행 패스에서 재귀적으로 다시 처리하지 않는다. 캐릭터의 자율 반응은 OEV가 선택하며 선언형 `reactions`는 오브젝트에 적용한다.

## 작성과 검증

작성 원본은 `{ "format": "newera-theater-source", "version": 2, "definition": { ... } }`다. 원본에는 실제로 발생하지 않은 사건을 넣지 않는다. 배경 설정은 설명·성격·목표에 둔다.

```powershell
npm run lore:build -- skills/newera-lore-authoring/assets/example-source.json world.json
npm run lore:validate -- world.json
```

가져오기·빌드·검증은 이 문서의 씬 기반 version 2 형식만 지원한다.

## 캐릭터의 초기 관계

`spawns[].relationships`에 상대 ID별 초기 관계를 지정할 수 있습니다. 신뢰도·호감도·친밀도·존중도·경계도는 각기 0~100 또는 null이며, 초기 근거 목록은 빈 배열입니다. 원형은 공유해도 관계는 인스턴스마다 독립적입니다. 초기 관계 편집은 현재 진행을 덮어쓰지 않으며 초기화할 때 적용됩니다. 현재·초기 관계는 작업실의 배치·관계 탭에서 편집 시점을 고른 뒤 슬라이더와 일반 입력으로 수정할 수 있습니다. [작업실 사용 안내](EDITOR_GUIDE.md)를 참고하세요. [관계 데이터·JSON 예제·갱신 계약](CHARACTER_RELATIONSHIPS.md)을 참고하세요. 기존 version 2 파일에서 생략해도 가져올 수 있습니다.
