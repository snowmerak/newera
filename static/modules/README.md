# newera JSON 모듈 형식 (schemaVersion 1)

게임 화면 왼쪽 로어 사이드바의 **로어 가져오기 · JSON**에서 파일을 설치합니다. 설치와 동시에 적용되며, 세계관·등장인물 목록에서 고르고 켜거나 끌 수 있습니다. 파일 내용은 SQLite에 저장됩니다. 모듈 파일을 옮겨도 계속 사용할 수 있습니다.

```json
{
  "schemaVersion": 1,
  "id": "author.package-name",
  "name": "모듈 이름",
  "version": "1.0.0",
  "description": "선택 사항",
  "world": {
    "setting": "세계관 설명",
    "eraRules": "선택 사항인 추가 규칙"
  },
  "characters": [
    {
      "id": "local-id",
      "name": "인물 이름",
      "age": 25,
      "profile": "인물의 배경, 목적, 말투, 생활과 관계 설정",
      "introduction": "선택 사항인 짧은 소개",
      "trait": ["성격"],
      "base": { "energy": 20, "maxEnergy": 20 },
      "abl": { "conversation": 1, "empathy": 1, "seduction": 1 },
      "exp": { "conversation": 0, "empathy": 0, "seduction": 0 },
      "mark": [],
      "relation": { "affection": 0, "trust": 0, "desire": 0 },
      "palam": { "rapport": 0, "trust": 0, "arousal": 0, "pleasure": 0 }
    }
  ]
}
```

- `world`와 `characters` 중 하나만 넣어도 됩니다. 함께 넣으면 한 모듈로 적용됩니다.
- 모듈 ID와 인물 ID는 영문 소문자, 숫자, `.`, `_`, `-`를 사용합니다. 인물의 실제 ID는 `mod:<모듈 ID>:<인물 ID>`로 만들어집니다.
- 인물은 20세 이상이어야 합니다. `profile`, `name`, `age`, `id`가 필수입니다. 스탯을 생략하면 기본값이 적용됩니다.
- 세계관 모듈은 하나만 켤 수 있습니다. 적용 중에는 기본 세계관 대신 모듈의 `setting`을 사용하고, `eraRules`는 기본 규칙에 추가됩니다. 인물 전용 모듈은 여러 개를 동시에 켤 수 있습니다.
- 모듈을 꺼도 인물의 스탯, 사건, 기억은 남습니다. 다시 켜면 기존 진행을 이어갑니다. 같은 ID의 새 파일로 업데이트하면 프로필 등 기본 설명을 갱신하고 진행 수치는 유지합니다.
- 저장 슬롯은 당시 켜져 있던 모듈 목록도 기억합니다. 설치된 모듈 목록 자체는 슬롯 불러오기로 지워지지 않습니다.
