# 로어 JSON 작성 가이드

newera에는 두 종류의 로어 관련 JSON이 있다.

- **완성형 로어 (`newera-lore`)**: 별도의 세계, 인물, 현재 진행과 저장 슬롯을 `/lores`에서 가져온다.
- **모듈 (`schemaVersion: 1`)**: 현재 로어에 세계관이나 인물을 추가한다. 모듈 형식은 [모듈 안내](../static/modules/README.md)를 참고한다.

새 완성형 로어는 내부 DB 형식을 직접 작성하는 대신 `newera-lore-source` 파일을 만들고 빌드하는 방식을 권장한다. 빌더가 현재 인물과 세션 초기화용 인물 원본을 함께 만들고, 중첩된 JSON 문자열을 올바르게 이스케이프한다.

## 빠른 시작

예제 원본을 복사한다.

```powershell
Copy-Item skills/newera-lore-authoring/assets/example-source.json my-lore.source.json
```

`my-lore.source.json`을 편집한 뒤 완성형 파일을 만든다.

```powershell
npm run lore:build -- my-lore.source.json my-lore.json
npm run lore:validate -- my-lore.json
```

완성된 `my-lore.json`을 `/lores`의 **로어 가져오기 · JSON**에서 선택한다.

## 최소 원본

```json
{
  "format": "newera-lore-source",
  "version": 1,
  "title": "로어 제목",
  "start": {
    "day": 1,
    "time": "18:30",
    "location": "서울 · 시작 장소"
  },
  "world": {
    "setting": "세계의 시대, 장소, 생활 조건과 움직이는 사건을 적는다.",
    "eraRules": "세계 진행과 캐릭터 행동이 지킬 규칙을 적는다.",
    "narrativeMode": "sensual",
    "memory": "시작 시점에 이미 확정된 사실을 적는다."
  },
  "characters": [
    {
      "id": "character-id",
      "name": "이름",
      "age": 25,
      "introduction": "목록에 표시할 짧은 소개",
      "profile": "직업, 목표, 가치관, 말투, 일정, 관계와 경계를 포함한 상세 설정"
    }
  ]
}
```

나이는 정수로 기록하며 빌더가 최소 나이를 강제하지 않는다. 생략한 수치는 빌더가 중립적인 기본값으로 채운다. 이미 연인, 동료 또는 원수인 설정이라면 `EXP`, `MARK`, `RELATION`을 직접 적어 관계의 과거와 현재 수치가 모순되지 않게 한다.

전체 필드, 수치 의미, 행동 조건 경로와 완성형 번들 구조는 Agent Skill의 [형식 참고서](../skills/newera-lore-authoring/references/format.md)에 정리되어 있다. 바로 수정할 수 있는 전체 예제는 [example-source.json](../skills/newera-lore-authoring/assets/example-source.json)이다.

## 묘사 모드

- `restrained`: 암시와 여운 중심
- `sensual`: 감각 묘사와 직접 표현을 혼합
- `explicit`: 성적 장면에서 행위와 신체 반응을 생략하지 않고 직접 묘사

묘사 모드는 문체만 바꾸며 캐릭터의 행동 조건이나 수락 여부를 바꾸지 않는다.

## 캐릭터 작성 기준

- `profile`에는 외형만 나열하지 말고 독립적인 목표, 일정, 판단 기준, 말투, 좋아하는 것과 싫어하는 것을 넣는다.
- `TALENT`는 비교적 고정된 성향, `ABL`은 능력, `EXP`는 누적 경험이다.
- `RELATION`은 장기 관계이고 `PALAM`은 현재 장면의 반응이다.
- 중요한 과거는 `MARK`와 관계 수치에 함께 반영한다.
- 행동의 허용 속도는 캐릭터별 `actionRequirements`로 조정한다. 조건을 삭제하면 그 수치는 해당 행동을 제한하지 않는다.
- 플레이어와 무관한 일상과 목적을 설정해야 `다음 장면`에서 캐릭터가 반복 대화만 하지 않는다.

## 진행 중인 로어 수정

게임에서 내보낸 `newera-lore`에는 사건, 기억과 저장 슬롯이 포함된다. 이 파일을 수정할 때 다음 구분을 유지한다.

- `state.characters`: 현재 플레이 중인 세션 수치
- `state.characterTemplates`: 세션 초기화에 사용할 원본 수치
- `state.events`, `state.memories`: 실제로 진행된 기록
- `saves`: 저장 슬롯별 스냅샷

세계관이나 캐릭터 원본만 바꾸려면 UI에서 편집한 뒤 다시 내보내는 방법이 가장 안전하다. 직접 편집한 경우 `npm run lore:validate -- 파일.json`으로 구조를 확인한다.

## Agent Skill 설치

저장소의 `skills/newera-lore-authoring`은 독립적으로 설치할 수 있는 Agent Skill이다. Codex에 다음과 같이 요청할 수 있다.

> `snowmerak/newera` 저장소의 `skills/newera-lore-authoring` 스킬을 설치해 줘.

또는 Codex의 skill installer 스크립트를 직접 실행한다.

```powershell
python "$HOME/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py" `
  --repo snowmerak/newera `
  --path skills/newera-lore-authoring
```

설치한 다음 새 작업에서 `$newera-lore-authoring`을 호출하고 세계관과 캐릭터 메모를 전달하면, 작성 원본과 import 가능한 완성형 JSON을 만들고 검증한다.
