# 세계관 JSON 안내

검증 기준은 `src/lib/theater/validation.ts`다. 새 세계관 파일은 `format: "newera-theater"`, `version: 2`를 사용한다. 실행 가능한 예제는 `static/lore-presets/theater-opening.json`, 작성 원본은 `skills/newera-lore-authoring/assets/example-source.json`이다.

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

씬·원형·인스턴스의 ID는 영문·숫자로 시작하고 영문·숫자·점·밑줄·콜론·하이픈을 쓴다. 인스턴스 ID `player`, `stage`는 예약되어 있다. ID는 각 목록 안에서 유일해야 하며 씬 출구·원형·배치 참조가 모두 존재해야 한다. 출구는 방향을 가진다. 편집 화면의 씬 추가는 선택한 씬과 양방향 출구를 만든다.

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

이전 `newera-lore` 파일은 가져오기에서 변환한다. 이전 `newera-lore-source` 원본은 빌드 도구가 새 파일로 변환할 수 있다. 이전 수치와 계산식은 새 런타임에 연결하지 않으며 원본 아카이브로 보존한다.
