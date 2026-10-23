# Provider와 모델 별칭

화면 상단 **모델 설정 → Provider 관리**에서 OEV 서버와 OpenAI 호환 API를 여러 개 등록합니다. Provider 등록은 앱 전체에서 공유하며, 판단·생성 모델 선택은 세계관별로 저장합니다.

## 화면에서 설정하기

1. **새 Provider 추가**에서 이름, API 유형, 기본 주소와 필요한 경우 API 키를 입력하고 **Provider 저장**을 누릅니다. 주소는 `http://macstudio:12821/v1`처럼 API 접두 경로까지 포함합니다.
2. **서버 모델 목록 가져오기**로 모델을 가져오거나 **모델 별칭 추가**로 직접 등록합니다. 실제 모델 ID와 표시 별칭을 입력하고 저장합니다. 조회한 모델은 저장 전까지 편집 초안입니다.
3. 위쪽 판단·생성 선택창에서 `Provider 이름 / 모델 별칭`을 선택하고 **모델 적용**을 누릅니다. 같은 모델 ID도 서버별로 구분됩니다.

판단은 `/systemone`을 제공하는 **OEV**만 선택할 수 있습니다. 생성에는 OEV와 **OpenAI 호환 API**를 모두 사용할 수 있습니다. 관찰·관계 해석도 선택한 생성 Provider를 사용합니다. 정체성·표현 검수와 옷차림 선택은 판단 Provider의 typed decision을 사용합니다. 임베딩용 별칭은 판단·생성 목록에서 제외합니다.

기존 기본 OEV 자동 모델 목록과 별칭 없는 모델 ID도 계속 사용할 수 있습니다. 기본 OEV는 삭제하거나 OpenAI 호환 유형으로 바꿀 수 없습니다. 세션에서 선택 중인 Provider나 별칭을 제거하려면 해당 세션의 모델을 먼저 변경합니다. 선택 중인 별칭의 표시 이름이나 실제 모델 ID는 수정할 수 있습니다.

API 키는 저장 후 브라우저에 다시 보내지 않습니다. 입력란을 비워 저장하면 기존 키를 유지하며, **저장된 API 키 지우기**로 제거합니다. **API 세부 옵션**의 환경 변수 이름을 지정하면 서버 프로세스의 해당 값을 직접 입력한 키보다 우선하여 사용합니다.

## API 호환 옵션

| 옵션 | 동작 |
| --- | --- |
| 출력 토큰 옵션 | `max_completion_tokens` 또는 `max_tokens`를 선택합니다. |
| JSON Schema | 생성 요청에 기존 `response_format.json_schema` 계약을 전달합니다. |
| JSON 객체 | `response_format: {"type":"json_object"}`와 스키마 지침을 전달하고, 앱이 동일한 출력 계약을 검증합니다. |

OpenAI 호환 생성 요청에는 OEV 전용 `input_type`, `reasoning_effort`, `temperature`를 보내지 않습니다. JSON 객체 모드에서도 행동·대사 분리와 필드·실행 가능성 검증을 유지하며, 평문으로 자동 전환하지 않습니다. Provider가 선택한 구조화 출력 방식과 토큰 옵션을 지원해야 합니다. 이 기능은 Chat Completions 호환 API를 대상으로 하며 Responses 전용 API는 지원하지 않습니다.

## 저장과 적용 시점

등록 정보는 기본 `data/providers.json`에 저장합니다. `NEWERA_PROVIDER_CONFIG`로 경로를 바꿀 수 있습니다. 파일이 없으면 기존 `models.json` 또는 `NEWERA_OEV_BASE_URL`에서 기본 OEV 주소를 사용합니다. 파일을 저장한 뒤에는 등록된 기본 Provider의 주소를 사용하므로 이후 기본 주소 수정도 Provider 관리에서 합니다.

새 작업을 접수할 때 Provider·실제 모델·주소·인증 정보와 API 옵션을 확정합니다. 실행 도중 별칭이나 서버 주소를 바꿔도 진행 중인 작업과 서버 재시작 후 자동 재개는 저장된 대상을 유지합니다. **이어서 재시도**를 누르면 현재 세션의 판단·생성 모델과 현재 Provider 설정을 다시 읽어 작업 스냅샷을 교체합니다. 같은 별칭의 실제 모델·주소·키만 바꿔도 수동 재시도부터 반영하며, 기본 설정 사용 상태라면 현재 기본 모델을 사용합니다. 확정된 사건·기억·진행 위치와 대기 중인 채팅은 유지합니다. 새 설정을 해석할 수 없으면 실패 상태와 이전 스냅샷을 보존하고 오류를 표시합니다. 기존 데이터의 작업에는 최초 자동 재개 시 이 스냅샷을 채웁니다.

이 스냅샷은 SQLite `theater_jobs.providers_json`에 서버 내부 정보로 저장합니다. **직접 입력한 API 키는 로컬 설정 파일에, 실행 시 해석한 키는 작업 스냅샷에 평문으로 저장됩니다.** 환경 변수를 사용하는 경우에도 재시도에 필요한 해석된 키가 작업에 남습니다. 이 파일들과 DB 백업은 비공개로 보관해야 합니다. Provider 키와 작업 스냅샷은 화면 데이터·세계관 내보내기·공연 기록에 포함하지 않습니다. 세계관 파일을 다른 앱 설치로 옮길 때는 Provider 등록을 별도로 준비해야 합니다.

설정 파일은 새 작업이나 수동 재시도의 호출 대상 결정 시 다시 읽고 유효한 전체 설정으로 교체합니다. 잘못된 파일은 마지막 유효 설정을 유지하며, 처음부터 잘못되었으면 오류로 표시합니다. GUI 저장은 리비전을 검사하고 다른 창에서 먼저 저장했다면 목록을 다시 불러오도록 안내합니다. 파일을 직접 수정할 때도 `revision`을 증가시킵니다. 설정 파일 경로와 서버 환경 변수의 변경은 서버 재시작이 필요합니다.

## 파일 형식

GUI가 안정적인 ID를 생성합니다. 선택 값은 `Provider ID::별칭 ID`이고 표시 이름은 자유롭게 바꿀 수 있습니다. 아래 예시의 `writer::story`를 생성 모델로 사용할 수 있습니다.

```json
{
  "version": 1,
  "revision": 1,
  "providers": [
    {
      "id": "default",
      "label": "집 OEV",
      "kind": "oev",
      "baseUrl": "http://macstudio:12821/v1",
      "apiKeyEnv": "",
      "models": [
        { "id": "judge", "label": "빠른 판단", "modelId": "gemma4-26b", "task": "generation" }
      ]
    },
    {
      "id": "writer",
      "label": "이야기 서버",
      "kind": "openai-compatible",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "STORY_API_KEY",
      "outputTokenParameter": "max_tokens",
      "structuredOutput": "json_schema",
      "models": [
        { "id": "story", "label": "상세 서술", "modelId": "my-story-model", "task": "generation" }
      ]
    }
  ]
}
```

Provider는 최대 32개, 각 Provider의 별칭은 최대 100개입니다. 별칭 ID는 Provider 안에서 고유해야 합니다. 기본 Provider에는 `id: "default"`, `kind: "oev"`가 필요합니다. 생략한 토큰 옵션과 구조화 출력 기본값은 각각 `max_completion_tokens`, `json_schema`입니다.

임베딩 Provider는 `task: "embedding"` 별칭을 등록하고 `models.json`의 `embeddingModel` 또는 `NEWERA_EMBEDDING_MODEL`에 `Provider ID::별칭 ID`를 지정합니다. 기본 `embeddinggemma2`는 기존 기본 OEV를 사용합니다. 임베딩 모델과 차원은 별도 설정을 유지하며, 실제 API 주소·유형·모델이 달라지면 다른 LanceDB 테이블을 사용합니다. 각 검색은 테이블 구분과 실제 임베딩 요청에 같은 Provider 스냅샷을 사용하며 다음 검색부터 별칭 변경을 반영합니다. 모델 선택 GUI는 판단·생성용이며 임베딩 선택은 파일·환경 변수로 설정합니다.

로컬 HTTP 서버 두 개를 사용해 Provider별 실제 요청·인증, 구조화 출력 옵션, 수정·삭제 후 재시도와 서버 재시작을 검증합니다. 외부 유료 API에 대한 실호출 검증은 포함하지 않습니다.
