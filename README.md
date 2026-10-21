# newera · Theater

씬 안의 인물과 오브젝트가 사건을 관찰하고 각자의 다음 행동을 선택하는 텍스트 게임입니다. 세계관 아래에 씬과 원형을 정의하고, 실제 무대에는 독립적인 상태와 기억을 가진 인스턴스를 배치합니다. 동행 캐릭터는 플레이어와 씬을 이동하면서 같은 정체성과 기억을 유지합니다.

## 실행

Node.js 24.10 이상과 OEV 서버가 필요합니다.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

`http://localhost:5173`에서 플레이하고 `/lores`에서 세계관·씬·원형·인스턴스를 편집합니다. 처음 실행하면 **비가 그친 뒤의 극장**이 열립니다. 기존 DB가 있으면 이전 이야기를 먼저 옮깁니다. 새 예제는 `static/lore-presets/theater-opening.json`을 가져와 열 수 있습니다.

```powershell
npm run build
npm start
```

개발 서버는 시작할 때 `.env`의 `NEWERA_` 설정을 읽습니다. 배포 실행은 `npm start`가 `.env`를 읽습니다. 직접 실행할 때는 `node --env-file-if-exists=.env build/index.js`를 사용합니다.

## 플레이와 편집

- **말하기**: 현재 씬의 한 인물 또는 현장 모두에게 말합니다. 다른 씬의 인물은 듣지 못합니다.
- **상호작용**: 씬에 있는 오브젝트의 현재 조건에 맞는 행동을 선택합니다. 선언된 효과가 상태를 바꾸고, 사건 반응 컴포넌트가 이어서 작동합니다.
- **이동**: 씬에 연결된 출구로 이동합니다. 동행은 같은 인스턴스로 따라오고, 현지 인물은 남습니다.
- **잠시 지켜본다**: 시간을 5분 진행하고 현장 인물들의 선택을 받습니다. 그 밖의 행동은 1분 진행합니다.

각 진행에서 현장 인물은 한 번씩 판단합니다. 말을 건 상대가 먼저 반응하고, 뒤의 인물은 앞에서 확정된 말과 행동을 보고 선택합니다. 인물끼리 대화하거나 오브젝트를 사용하거나 다른 씬으로 이동할 수 있습니다. 무대 밖 인물은 이 라운드에 호출하지 않습니다.

편집 화면에서 씬을 연결하고, 캐릭터·오브젝트 원형을 만들고, 같은 원형을 여러 인스턴스로 배치합니다. 현재 씬의 캐릭터를 동행으로 지정할 수 있습니다. 세부 상호작용과 사건 반응은 세계관 정의 JSON으로 편집합니다. 원형과 초기 배치 편집은 현재 인스턴스의 진행 상태를 초기화하지 않습니다. 공연 화면의 **현재 진행 초기화**를 실행하면 초기 배치를 적용합니다.

진행은 세계관별로 자동 저장됩니다. 저장 슬롯 1~3은 세계관 정의와 현재 인스턴스·기억·사건을 함께 보관합니다. 세계관 내보내기에는 현재 진행과 슬롯이 포함되며, 공연 기록은 Markdown으로 내려받을 수 있습니다.

## OEV 설정

API 명세는 [OEV 제공 문서](http://macstudio:12821/.skill)를 따릅니다. 클라이언트는 먼저 `/v1/models`에서 `task=generation` 모델을 확인합니다. 모델 이름을 비워두면 첫 번째 generation 모델을 사용합니다.

| 설정 | 기본값 | 역할 |
| --- | --- | --- |
| `NEWERA_OEV_BASE_URL` | `http://macstudio:12821/v1` | 모델 검색·판단·대사 API |
| `NEWERA_DECISION_MODEL` | 자동 검색 | `/systemone` 판단 모델 |
| `NEWERA_TEXT_MODEL` | 판단 모델과 동일 | `/chat/completions` 대사 모델 |
| `NEWERA_DECISION_TIMEOUT_MS` | `30000` | 모델 검색·판단 요청별 대기 시간 |
| `NEWERA_LLM_TIMEOUT_MS` | `120000` | 대사 요청별 대기 시간 |
| `NEWERA_MAX_OUTPUT_TOKENS` | `512` | 대사 출력 토큰 한도 |
| `NEWERA_REACTION_THRESHOLD` | `0.5` | `noul`이 이 값 미만이면 기다림 |
| `NEWERA_DATA_DIR` | `./data` | SQLite와 기본 모델 설정 파일 위치 |
| `NEWERA_MODEL_CONFIG` | `<data>/models.json` | 선택적인 실행 중 모델 설정 파일 |

`models.json`은 다음 진행을 시작할 때 다시 읽습니다. 파일이 환경 변수보다 우선하며, 수락한 진행은 설정 스냅샷을 유지합니다. 잘못된 파일은 경고를 남기고 마지막 유효 설정을 유지합니다. 최초 설정이 잘못되었으면 생성을 실패시킵니다.

```json
{
  "baseUrl": "http://macstudio:12821/v1",
  "decisionModel": "hermes3.6-35b",
  "textModel": "hermes3.6-35b",
  "decisionTimeoutMs": 30000,
  "timeoutMs": 120000,
  "maxOutputTokens": 512,
  "reactionThreshold": 0.5
}
```

환경 변수와 `.env`, SQLite 위치를 변경하면 서버를 재시작해야 합니다. 환경 변수는 프로세스 시작 입력이고 SQLite 연결은 한 데이터 디렉터리에 묶여 있습니다.

판단은 `choice`(합법적인 다음 행동), `noul`(반응 신호), `score`(표현 강도)를 한 요청에 담습니다. OEV는 각 질문을 독립적으로 평가하므로 한 HTTP 요청이 한 번의 추론을 의미하지는 않습니다. 대사는 선택이 확정된 뒤 별도로 생성합니다. `noul`과 `score`는 제공한 기준에 대한 상대적 신호이며 실제 진실이나 성공 확률로 저장하지 않습니다. 행동 후보가 36개를 넘으면 묶음 선택 후 세부 선택을 진행합니다.

이 기반에서는 개인의 최근 목격 기억을 사용하며 임베딩 서버를 호출하지 않습니다. 캐릭터가 없는 씬은 모델 연결 없이 진행할 수 있습니다. 모델이나 검증에 실패하면 그 진행의 상태와 사건을 저장하지 않습니다.

## 이전 데이터

기존 `data/newera.sqlite`의 원본 테이블은 유지하고 `theater_*` 테이블에 세계관별로 옮깁니다. 이전 세계관·인물 설명·사건·개인 기억·저장 슬롯을 보존하며, 위치 정보가 없는 이전 인물들은 현재 위치에 해당하는 첫 씬에 배치합니다. 이전 수치와 계산식은 새 실행기에서 사용하지 않습니다. 원본 데이터는 DB와 내보내기의 `legacyArchive`에 남습니다. 이전 `newera-lore` JSON도 가져올 수 있습니다.

## 검증과 작성 도구

```powershell
npm run check
npm test
npm run test:integration
npm run lore:build -- skills/newera-lore-authoring/assets/example-source.json output.json
npm run lore:validate -- output.json
```

구조와 실행 규칙은 [PRODUCT](docs/PRODUCT.md), 파일 형식과 오브젝트 예제는 [세계관 JSON 안내](docs/LORE_JSON_GUIDE.md)를 참고하세요.
