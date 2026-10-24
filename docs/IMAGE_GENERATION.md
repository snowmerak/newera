# 이미지 생성 클라이언트

현재 범위는 **OpenAI·xAI·OpenRouter·ComfyUI의 이름 있는 이미지 설정 프리셋, 세션별 조건, 수동·자동 이미지 생성과 대화 기록 속 삽화 저장**이다. 이미지 저장 슬롯·내보내기·참조 이미지 입력·편집은 후속 작업이다. 이미지 Provider 등록은 기존 판단·대사 Provider와 별개이며, 자연어 생성 조건은 세션에서 선택한 대사 생성 모델을 사용한다. ComfyUI는 완성된 이미지의 WebSocket 수신을 구현했으며 토큰·진행 미리보기는 표시하지 않는다.

2026-10-24 KST에 다음 공식 문서의 동기 응답 규격을 확인했다.

| Provider | 기본 API 루트 | 생성 경로 | 기본 키 환경 변수 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `/images/generations` | `NEWERA_OPENAI_API_KEY` |
| Grok(xAI) | `https://api.x.ai/v1` | `/images/generations` | `NEWERA_XAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `/images` | `NEWERA_OPENROUTER_API_KEY` |

근거: [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate), [xAI 이미지 생성](https://docs.x.ai/developers/model-capabilities/images/generation), [OpenRouter Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).

OpenAI GPT Image에는 `response_format`을 보내지 않는다. xAI에는 임시 URL 대신 바이트를 받도록 `response_format: "b64_json"`을 지정한다. OpenRouter는 전용 Image API의 `data[].b64_json`과 `media_type`을 읽는다. SDK 추가 없이 Node의 `fetch`로 전송한다.

## 사용

`.env`에 사용할 Provider의 키를 설정한다. 개발 서버는 `NEWERA_` 변수를 읽고 `npm start`도 `.env`를 읽는다. 키 변경 후에는 서버와 클라이언트를 다시 생성한다. `apiKey`나 `apiKeyEnv`를 지정해 다른 서버 설정에서 자격 증명을 공급할 수도 있다.

`src/lib/server/images/client.ts`의 `createImageClient`를 서버 코드에서만 가져온다.

```ts
import { createImageClient } from '$lib/server/images/client';

const images = createImageClient({ provider: 'openai', timeoutMs: 180000 });
const result = await images.generate({
  model: 'gpt-image-1.5',
  prompt: '비가 그친 극장 앞. 두 사람이 젖은 우산을 접는다. 따뜻한 수채화 삽화.',
  count: 1,
  options: { size: '1536x1024', quality: 'medium', outputFormat: 'png' }
}, abortSignal);

// 저장 위치와 장면 연결은 호출자가 결정한다.
const image = result.images[0];
// image.bytes: Uint8Array, image.mediaType: image/png | image/jpeg | image/webp
// result.provider, result.model, result.created?, result.usage?
```

`abortSignal`은 호출자가 생성한 선택적 `AbortSignal`이다. 인자를 생략하면 클라이언트의 시간 제한만 적용한다. 모델은 항상 명시적으로 지정하며 기본 모델로 자동 대체하지 않는다. 위 모델은 사용 예이고 계정 접근 권한·현재 가용성을 보장하지 않는다.

다른 Provider도 같은 `generate`를 사용한다. `options` 타입은 클라이언트를 만든 Provider에 맞춰진다.

```ts
const grok = createImageClient({ provider: 'xai' });
await grok.generate({
  model: 'grok-imagine-image-2.0', prompt: '저녁의 극장 로비, 두 사람이 대화하는 삽화.',
  options: { aspectRatio: '16:9', resolution: '2k', quality: 'medium' }
});

const router = createImageClient({ provider: 'openrouter' });
await router.generate({
  model: 'openai/gpt-image-2', prompt: '저녁의 극장 로비, 두 사람이 대화하는 삽화.',
  options: { aspectRatio: '16:9', resolution: '2K', outputFormat: 'png' }
});
```

키·API 루트는 생성 시점에 고정한다. `baseUrl`은 `/v1` 또는 `/api/v1`까지 포함한 API 루트이며 프록시·로컬 테스트 서버로 바꿀 수 있다. 자격 증명·쿼리·해시를 포함한 주소와 리다이렉트는 허용하지 않는다.

## 옵션과 응답

- 공통: `model`, `prompt`(1~32000자), `count`(기본 1, 1~10). 모델별 실제 제한은 서비스가 최종 검증한다.
- OpenAI: `size`, `quality`, `outputFormat`, `outputCompression`, `background`.
- xAI: `aspectRatio`, `resolution`(`1k`/`2k`), `quality`(`auto`/`low`/`medium`). 품질 옵션의 지원 여부는 모델에 따라 다르다.
- OpenRouter: `size`, `aspectRatio`, `resolution`, `quality`, `outputFormat`, `outputCompression`, `background`. 모델별 허용 범위는 `/api/v1/images/models`와 해당 모델의 `/endpoints`에서 확인한다. 모델 목록은 아래 조회 모듈에서 제공하며, 생성 클라이언트는 크기나 옵션을 자동 변환하지 않는다.

압축률은 0~100이며 `jpeg`/`webp`를 명시해야 한다. JPEG와 투명 배경의 조합은 전송 전에 거부한다. 지원하지 않는 옵션도 조용히 버리지 않고 거부한다.

응답은 Provider의 실제 모델 ID가 있으면 이를 보존하고, 없으면 요청한 ID를 쓴다. `images`에는 디코딩된 바이트·실제 헤더로 판별한 MIME과 선택적인 수정 프롬프트가 있다. 헤더 판별은 전체 이미지 디코딩 검사가 아니다. 반환 이미지가 한 장 이상이고 요청 수를 넘지 않는지, base64와 선언된 MIME이 일치하는지 검증한다. URL만 있는 응답·SVG·잘못된 base64는 거부하며 외부 이미지 URL을 자동으로 내려받지 않는다.

`usage`는 Provider마다 단위와 필드가 달라 원본 객체로 유지한다. 값이 없으면 사용량 미제공이며 0으로 해석하지 않는다. 응답 JSON은 최대 64MiB, 이미지 한 장은 디코딩 후 최대 20MiB다.

## 취소와 오류

호출자의 취소는 원래 `AbortSignal.reason`으로 전달한다. 응답 본문을 읽는 동안에도 취소·시간 제한이 적용되고, 취소 후 도착한 결과는 반환하지 않는다. 기본 대기는 180초, 설정 범위는 1~600000ms다.

그 밖의 오류는 `ImageGenerationError`의 `provider`, `code`, 선택적인 HTTP `status`로 구분한다. 코드는 `configuration`, `invalid_request`, `http`, `network`, `timeout`, `invalid_response`, `content_filtered`, `execution`이다. API 오류 본문과 전송 예외 원문은 키·프롬프트 노출을 피하기 위해 반환하거나 로그에 쓰지 않는다.

이미지 요청은 비용이 발생할 수 있으므로 **자동 재시도를 하지 않는다**. 특히 시간 초과·연결 실패·잘못된 응답은 원격 생성 실패나 과금 취소를 뜻하지 않는다. 호출 측에서 완료 여부와 재요청 정책을 정해야 한다.

## 외부 API 모델 목록

`/images`에서 외부 Provider 프리셋을 선택하면 현재 서버 주소와 키 환경 변수로 모델 목록을 조회한다. **서버 모델 불러오기**로 갱신하고, **모델 검색**에서 이름·ID를 대소문자 구분 없이 검색해 **이미지 생성 모델** 드롭다운에서 고를 수 있다. 새로고침·검색은 선택 모델을 변경하지 않는다. 목록에 없는 모델은 **모델 ID**에 직접 입력한다. 주소·키 환경 변수·Provider가 바뀌면 이전 목록은 사용할 수 없고, 이전 요청의 늦은 응답도 적용하지 않는다.

| Provider | 조회 경로 (API 루트 기준) | 필터 기준 |
| --- | --- | --- |
| OpenAI | `GET /models` | `gpt-image-*`, `chatgpt-image-*` 모델 ID |
| xAI | `GET /image-generation-models` | 전용 목록에서 text 입력·image 출력 확인 |
| OpenRouter | `GET /images/models` | 전용 목록의 architecture에서 text 입력·image 출력 확인 |

근거: [OpenAI 모델 목록](https://developers.openai.com/api/reference/resources/models/methods/list), [xAI 모델 API](https://docs.x.ai/developers/rest-api-reference/inference/models), [OpenRouter 모델 검색](https://openrouter.ai/docs/guides/overview/multimodal/image-generation#model-discovery).

OpenAI 목록에는 이미지 생성 기능 메타데이터가 없어 알려진 GPT Image 계열 이름을 사용한다. 이름이 다른 새 계열은 직접 입력하거나 필터를 갱신해야 한다. 기존 DALL-E는 현재 생성 클라이언트의 GPT Image 응답 계약과 달라 목록에 포함하지 않는다. 모델 목록은 생성 성공·조직 권한·품질/크기/출력 형식 지원을 보장하지 않으며, 옵션은 모델별로 설정한다. OpenRouter의 `supported_parameters`에 따른 옵션 UI 자동 조정은 구현하지 않았다.

서버 모듈은 `getHostedImageCatalog(config, signal?)`이며 생성과 동일한 API 루트·자격 증명 검증을 사용한다. 앱 경로 `POST /api/images/models`는 `{ provider, baseUrl, apiKeyEnv }`만 받아 서버에서 upstream GET을 실행하고 `{ provider, models: [{ id, name }], filter }`를 반환한다. 원시 키 전달은 거부하며 동일 출처 요청만 허용한다. 기본 시간 제한 20초, 응답 한도 4MiB·10000항목, 자동 재시도 없음, `Cache-Control: no-store`다. 오류 원문·응답의 부가 필드는 브라우저로 전달하지 않는다.

2026-10-24 실제 환경 변수로 앱의 조회 경로를 호출해 OpenAI 10개, xAI 3개, OpenRouter 61개를 확인했다. 이는 조회 시점의 목록이며 생성 호출은 하지 않았다. 새 모델 조회 테스트 9개를 포함한 전체 단위/계약 테스트 145개와 기존 통합 테스트 18개가 통과했다. 프로덕션 빌드의 Chromium에서 세 Provider의 검색·선택·직접 입력·저장/재로드·늦은 응답 무시·390px 화면을 확인했다.

## 이미지 설정 프리셋과 세션별 선택

공연 화면의 **이미지 설정 → 이미지 생성 조건**에서 세션별로 자동 삽화를 켜고 규칙을 최대 10개 추가한다. 기본값은 꺼짐이다. 프리셋 적용 후 **이미지 생성 조건 저장**을 누르면 다음 확정된 진행부터 확인한다. **현재 장면 삽화 추가**는 자동 생성 설정과 무관하게 현재 공개 장면을 한 장으로 요청하고 기록에 남긴다. 기존 **이 세션의 프리셋으로 삽화 생성**과 `/images` 테스트는 저장하지 않는 미리보기다.

| 발동 시점 | 동작 |
| --- | --- |
| 현재 장소가 바뀌었을 때 | 직전 확인 장소와 달라지면 확인 |
| 게임 내 시간이 지났을 때 | 설정 저장 또는 해당 규칙의 마지막 이미지 접수에서 지정 분 이상 경과 |
| 조건이 새로 충족됐을 때 | 첫 확인에서 참 또는 관찰한 거짓→참 전환에 한 번 발동 |

각 규칙의 장소·함께 있어야 하는 대상·대상의 속성값·자연어 조건은 AND, 규칙들 사이는 OR다. 대상은 현재 장소에 활성 상태로 있어야 한다. 속성 비교는 JSON 기본값의 타입까지 같아야 한다(`true`와 `"true"`는 다르다). 재발동 간격은 마지막 접수 기준의 게임 내 분이며 날짜가 바뀌어도 이어진다. 간격 중에는 자연어 조건을 호출하지 않으므로 그 사이만 잠깐 거짓이었던 상태는 재발동 근거가 되지 않는다. 조건이 계속 참인 경우 한 번만 생성하고, 여러 규칙이 한 번에 맞으면 그림 지침을 합쳐 한 장만 만든다. 설정 저장은 시간 기준과 이전 판정을 새로 잡는다.

인물 반응 작업이 진행 중이면 장면이 확정될 때까지 자동 판정을 미룬다. 텍스트 작업과 이미지 작업은 별도이며 이미지 실패가 사건·기억·진행을 되돌리지 않는다. 자연어 조건은 확정 장면당 대상 조건을 한 번에 묶어 세션의 생성 모델에 `image_conditions` JSON 스키마로 요청한다. 판단에는 현재 장소·시각·겉모습·최근 공개 사건 8개만 전달하고 개인 메모·기억·성격·관계·숨은 속성값은 넣지 않는다. 알 수 없는 정보는 거짓으로 판단하도록 지시하며, 잘린 출력·중복/누락 ID·비정상 응답은 실패로 처리한다. 자연어 판정의 의미적 정확성을 보장하지는 않는다.

그림 프롬프트는 같은 공개 스냅샷에 규칙별 그림 지침과 프리셋 화풍을 합친다. 공개 맥락은 최대 16000자, 합친 규칙 지침은 최대 8000자다. 접수 때 이미지 프리셋·리비전·모델 선택을 고정하고 실제 키 값은 저장하지 않는다. 자연어 판정은 최대 2분, 기존 LLM 요청 설정은 사용자 환경의 30분(`1800000ms`)까지 허용한다. 이미지 생성은 Provider 클라이언트의 시간 제한을 따른다. 이미지와 자연어 판단은 자동 재시도하지 않는다.

조건 설정·판정 커서는 `theater_image_settings`, 접수 상태·공개 스냅샷·이미지 바이트는 `theater_illustrations`에 저장한다. 판정 및 이미지는 기존 수동 미리보기와 공통으로 한 번에 하나만 실행한다. 동일 진행 리비전·설정 리비전은 한 번만 접수하고, 이미지 요청 전에 발동 커서를 먼저 저장하므로 실패한 이미지가 다음 조회에서 반복 과금되지 않는다. 서버 재시작 시 대기 중 작업은 이어서 처리하고, 판단·생성 중이던 작업은 완료 여부 불명으로 실패 처리한다. 완성 이미지는 유지한다. 단일 앱 프로세스를 전제로 한다.

`GET /api/images/session?worldId=...`는 설정·작업 요약을 반환하고, 동일 출처 `POST /api/images/session`은 `{ worldId, operation: 'save', revision, config }`, `{ worldId, operation: 'request' }`, `{ worldId, operation: 'clear' }`를 받는다. `GET /api/images/illustrations/:id`는 완성된 PNG/JPEG/WebP 바이트를 반환한다. 그림은 해당 사건 뒤에 표시하며 최근 100개 사건에서 벗어난 그림은 기록 아래에 표시한다. 인물의 행동·목격 기억에는 삽화를 추가하지 않는다.

세션당 삽화 요청 기록은 최대 100개다. 한도에 도달하면 새 자동 생성 접수를 멈추고 **삽화 기록 비우기**로 다시 사용할 수 있다. 설정 저장·비활성화는 아직 이미지 요청을 보내지 않은 이전 자동 판정을 무효화한다. 이미 원격 이미지 생성을 시작한 요청은 당시 설정으로 완료될 수 있다. 기록 비우기·진행 초기화·슬롯 불러오기는 이미지 기록을 지우고 늦은 응답 저장을 막지만 원격 생성·과금을 취소한다는 보장은 없다. 프리셋과 조건 설정은 유지한다. 세계관 파일 교체·삭제는 조건과 이미지 기록도 지운다. 이미지·조건은 저장 슬롯이나 세계관/공연 내보내기에 포함하지 않는다.

2026-10-24 검증: 단위/계약 테스트 156개, 통합 테스트 19개, 데스크톱·390px Chromium에서 규칙 생성·수동 요청·자동 삽화·저장/재로드·기록 비우기를 확인했다. 실제 OpenAI `gpt-5.4-nano-2026-03-17`로 참·거짓 자연어 조건 두 개를 판정한 뒤, 참인 조건만 OpenRouter `openai/gpt-image-2` 이미지 한 장으로 연결했다(PNG 2111218바이트, 약 15.4초). 동일 진행 재조회 시 추가 이미지 요청이 없는 것도 확인했다.

`/images`의 **프리셋 관리**에서 이름·Provider·서버 주소·모델·화풍 지침·생성 옵션을 저장한다. **복사해서 새로 만들기**는 같은 설정을 별도 ID로 저장할 초안을 만들고, 수정은 기존 ID의 리비전을 올린다. 같은 ComfyUI 워크플로우로 모델이나 화풍이 다른 프리셋을 여러 개 만들 수 있다. 오래된 화면의 수정·삭제와 같은 이름의 중복 등록은 거부한다. 프리셋은 최대 100개다.

기본 워크플로우(ZIT·SDXL·Anima)는 노드 그래프 템플릿이며, 사용자가 만드는 이미지 설정 프리셋은 Provider와 실제 실행 옵션의 묶음이다. ComfyUI 설정 프리셋에는 선택한 워크플로우 하나의 모델·크기·네거티브 프롬프트·LoRA를 담는다. 외부 Provider에는 모델 ID·Provider별 옵션과 `apiKeyEnv`를 담는다. API 키 값은 저장하거나 화면에 반환하지 않는다. 개발 서버도 표준 `OPENAI_API_KEY`, `XAI_API_KEY`, `X_AI_API_KEY`, `OPENROUTER_API_KEY`와 `NEWERA_` 환경 변수를 `.env`에서 읽는다. 기타 이름은 서버 프로세스의 환경 변수로 설정하거나 `NEWERA_` 접두사를 사용한다.

화풍 지침은 장면 프롬프트 앞에 빈 줄로 구분해 붙인다. 합계가 32000자를 넘으면 잘라내지 않고 오류를 반환한다. 저장 전 **테스트 이미지 생성**으로 화면의 현재 설정을 검증할 수 있으며, 외부 Provider 테스트는 실제 유료 요청이다.

공연 화면의 **이미지 설정**에서 현재 세션(세계관)이 쓸 프리셋을 선택하고 **이미지 프리셋 적용**을 누른다. 기본은 **이미지 사용 안 함**이다. 선택은 진행 리비전을 바꾸거나 텍스트 생성 작업을 중단하지 않는다. 초기화·저장 슬롯 불러오기·서버 재시작 후에도 유지하며, 다른 세션의 선택과 독립적이다. 세계관 내보내기에는 포함하지 않는다. 새 세계관 가져오기는 선택 없이 시작하고, 기존 세계관을 파일로 교체하면 기존 이미지 선택도 해제한다.

같은 프리셋을 선택한 세션들은 다음 생성부터 수정된 공통 설정을 쓴다. 독립적인 설정이 필요하면 프리셋을 복사한다. 생성이 시작되면 프리셋 ID·리비전·설정과 자격 증명을 해당 요청에서 확정하므로, 진행 중 프리셋을 수정하거나 세션 선택을 바꿔도 그 응답의 모델·화풍은 바뀌지 않는다. 한 세션이라도 선택한 프리셋은 삭제하지 못한다.

세션 설정의 **이 세션의 프리셋으로 삽화 생성**에서 직접 장면을 적고 생성할 수 있다. 이 요청은 서버가 세션의 저장된 선택을 조회해 실행한다. 화면이 다른 프리셋 ID나 설정을 끼워 넣어 세션 선택을 대체할 수 없다. 결과는 현재 화면에서만 표시하며 대화 사건이나 기억에는 추가하지 않는다. 연결 취소는 결과 수신 중단이며 이미 시작한 원격 생성·과금을 취소한다는 보장은 없다.

저장 원본은 SQLite의 `theater_image_presets`(ID·이름·리비전·설정 JSON·생성/수정 시각)와 `theater_worlds.image_preset_id`다. 기존 DB에는 테이블과 nullable 외래 키 열을 추가하고 기존 진행은 보존한다. `GET/POST/DELETE /api/image-presets`로 관리하며 `POST /api/images/generate`는 `worldId`, `presetId`, `config` 중 하나만 받는다. `worldId`는 세션 생성, `presetId`는 저장 프리셋 테스트, `config`는 저장 전 테스트다. 변경·생성 API는 같은 origin 요청만 받으며 기존 ComfyUI 테스트 경로와 공통 실행 제한을 사용한다.

## ComfyUI 기본 워크플로우

이미지 설정 프리셋에서 Provider를 **ComfyUI**로 고르면 서버 주소·워크플로우·모델 파일을 설정한다. **서버 모델 불러오기**는 `/object_info`와 `/models/loras`에서 실제 설치 목록을 가져온다. **프리셋 저장**으로 선택한 워크플로우의 실행 설정을 저장한다.

서버 기본값은 `http://localhost:22222`다. 이전의 `comfyui.json` 설정은 새 ComfyUI 프리셋을 만들 때 초깃값으로 읽는다. `NEWERA_COMFYUI_BASE_URL`은 그 최초 주소, `NEWERA_COMFYUI_CONFIG`는 이전 설정 파일 경로를 바꾼다. 기존 파일을 덮어쓰거나 자동으로 새 프리셋을 생성하지 않는다. 모델 파일명은 기본 워크플로우에 고정하지 않으며 사용자가 서버 목록에서 선택해야 한다.

사용자가 제공한 세 API 형식 JSON을 `src/lib/server/images/workflows/`에 포함했다. 샘플러·연결·확대 설정을 보존하고 프롬프트와 모델 파일명을 비웠으며, 파일 저장/미리보기 출력을 각각 단일 `SaveImageWebsocket` 출력으로 교체했다. 기존 두 프리셋만 저장한 version 1 설정은 그대로 읽고 Anima의 빈 기본 설정만 추가한다. 기존 선택 모델·크기·기본 워크플로우·리비전은 유지한다. 화면의 누락 노드 검사도 실제 선택한 워크플로우에서 계산한다.

| 항목 | ZIT · Moody Minimal | SDXL · Simple | Anima · Preview |
| --- | --- | --- | --- |
| 프롬프트 | `627.inputs.text` | `10.inputs.text` | `60:11.inputs.text` |
| 네거티브 프롬프트 | 별도 텍스트 입력 없음 | `11.inputs.text` | `60:12.inputs.text` |
| seed | `649.inputs.seed`, 두 샘플러가 공유 | `12.inputs.seed` | `60:19.inputs.seed` |
| 기본 크기·생성 수 | `698.inputs.width/height/batch_size` | `13.inputs.width/height/batch_size` | `60:28.inputs.width/height/batch_size` |
| 모델 | `761` 확산 모델, `755` 인코더, `757` VAE | `15` 체크포인트 | `60:44` 확산 모델, `60:45` 인코더, `60:15` VAE |
| 선택 LoRA | `822.inputs.lora_1`의 파일·활성·강도 | 없음 | 없음 |
| 이미지 출력 | `732` | `7` | `46` |
| 기본 크기 | 640×960 → 1.8배 확대 | 1024×1024 | 1024×1024 |

ZIT는 `Seed (rgthree)`와 `Power Lora Loader (rgthree)`가 필요하다. LoRA를 선택하지 않으면 해당 로더의 LoRA를 비활성화한다. SDXL의 기존 네거티브 프롬프트에는 `color, colored`가 포함되어 있으며 색상 이미지를 원하면 사용자가 이를 수정할 수 있다.

Anima는 제공 파일의 30스텝·CFG 4·`er_sde` 샘플러·`simple` 스케줄러와 `CLIPLoader.type: stable_diffusion`을 유지한다. `60:11`처럼 콜론이 들어간 노드 ID도 원문 문자열로 보존한다. 제공 파일의 모델 조합은 `animaCatTower_v11.safetensors`, `qwen_3_06b_base.safetensors`, `qwen_image_vae.safetensors`이며, 이는 참고 조합이고 앱에 고정된 기본 선택은 아니다.

```ts
import { getComfySettings } from '$lib/server/images/comfy-settings';
import { createComfyImageClient } from '$lib/server/images/comfyui';

const settings = getComfySettings();
const client = createComfyImageClient(settings, {
  timeoutMs: 600000,
  onQueued: (promptId) => { /* 필요하면 호출자가 작업 ID를 보관한다. */ }
});
const result = await client.generate({
  model: settings.presetId, // ComfyUI에서는 등록된 워크플로우 ID
  prompt: '비가 그친 극장 입구의 수채화 삽화',
  count: 1,
  options: { seed: 20261024 }
}, abortSignal);
// 공통 images[].bytes/mediaType와 ComfyUI jobId·seed를 반환한다.
```

ComfyUI 요청은 생성 수 1~4, 기본 크기 64~4096px(8의 배수), seed 0 이상 2^48 미만을 받는다. seed 생략 시 새 값을 만든다. 기본 크기·네거티브 프롬프트는 `options`로 덮어쓸 수 있고, ZIT의 독립 네거티브 프롬프트 옵션은 거부한다. 모델 파일과 노드를 서버 목록으로 확인한 후에만 큐에 제출한다. 설정과 워크플로우는 요청별 복제본으로 처리한다.

고유 `client_id`로 WebSocket을 먼저 연결하고, 고유 `prompt_id`로 `/prompt`에 제출한다. 동일 작업의 선택된 출력 노드에서 받은 완성 이미지만 수집하며 샘플러 미리보기·다른 작업의 결과를 제외한다. `execution_success`를 확인하고 요청 수만큼의 이미지가 있어야 성공이다. 실행 오류·중단·연결 종료·이미지 형식 불일치·누락은 각각 실패로 보고한다. 공식 [디스크 없는 WebSocket 출력 예제](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example_ws_images.py)와 [실행 메시지 규격](https://docs.comfy.org/development/comfyui-server/comms_messages)을 따른다.

새 프리셋·세션 화면은 `/api/images/generate`에서 이미지 바이트를 받아 브라우저의 Blob URL로 표시한다. 기존 `/api/images/comfyui` 테스트 API도 유지한다. ComfyUI의 저장 폴더와 앱의 디스크에 이미지를 쓰지 않고, 사용자가 **이미지 내려받기**를 누를 때 파일로 내려받는다. 두 생성 경로는 앱 프로세스당 한 번에 한 요청만 받는 공통 제한을 사용한다.

기본 실행 대기는 10분이며 클라이언트에서 최대 30분까지 설정할 수 있다. **생성 수신 중단**이나 시간 초과 시 이 요청 ID의 대기 작업만 큐에서 제거한다. 이미 실행 중인 GPU 작업은 계속될 수 있으며 다른 작업까지 중단할 수 있는 전역 `/interrupt`는 호출하지 않는다. 연결이 끊기면 자동 재제출·재개하지 않으며, 디스크 없는 결과의 재시작 복구는 아직 지원하지 않는다. 임의 워크플로우 가져오기와 매핑 편집 UI도 후속 범위다.

## 검증

`npm test`에 클라이언트 계약 테스트가 포함된다. 세 API의 주소·인증·필드 변환·바이트 정규화·오류·중복 호출 방지와 로컬 HTTP 서버에서 응답 본문 중단·시간 초과를 검증한다.

2026-10-24 KST에 실제 환경 변수의 키로 아래 요청을 각각 한 번 실행했다. 같은 극장 입구 수채화 프롬프트로 한 장씩 생성했으며, 반환 바이트를 파일로 저장하고 이미지가 열리는 것도 확인했다.

| Provider | 요청 모델 | 결과 | 소요 시간 |
| --- | --- | --- | --- |
| OpenAI 직접 호출 | `gpt-image-1.5` | PNG 2170410바이트 | 약 10.7초 |
| xAI 직접 호출 | `grok-imagine-image-2.0` | JPEG 549582바이트 | 약 12.0초 |
| OpenRouter | `openai/gpt-image-2` | PNG 2138056바이트 | 약 18.1초 |

xAI는 `X_AI_API_KEY`, OpenRouter는 `OPENROUTER_API_KEY`를 `apiKeyEnv`로 지정했다. OpenRouter가 보고한 사용량은 총 241토큰, 비용은 USD 0.006105였다. 이 값은 해당 요청의 응답이며 고정 요금이나 이후 응답 시간을 보장하지 않는다. 원본 이미지·결과 JSON은 Git에서 제외한 `.qa-data/image-smoke-20261024/`에 저장했다.

이후 사용자가 `.env`에 추가한 `OPENAI_API_KEY`를 `apiKeyEnv`로 지정해 OpenAI 직접 호출도 한 번 실행했다. 입력 45토큰·출력 431토큰·총 476토큰을 보고했으며 이미지 저장·표시까지 확인했다. 세 서비스의 직접 연결 경로는 각각 검증했지만, 다른 모델·설정·계정의 지원 여부까지 보장하지 않는다.

ComfyUI는 같은 날짜에 `http://localhost:22222`, ComfyUI 0.42.5, RTX 4050 Laptop GPU에서 두 프리셋을 직접 실행했다. 모델은 제공 파일에 쓰인 설치 모델을 테스트 설정에서 선택했고, 앱 기본값에는 파일명을 고정하지 않았다. ZIT는 seed 20261024·기본 640×960·LoRA 강도 1로 약 45.9초에 1152×1728 PNG를, SDXL은 같은 seed·기본 1024×1024로 약 23.9초에 PNG를 수신했다. 두 그래프 모두 출력 노드가 `SaveImageWebsocket`뿐인 상태에서 실행했다. 검증용 수신 이미지는 앱 기능과 별도로 `.qa-data/comfy-smoke-20261024/`에 저장했다.

ComfyUI 테스트는 세 프리셋 매핑·선택 모델 확인·원본 불변·기존 두 프리셋 설정의 호환 읽기·다른 작업/미리보기 배제·HTTP 확인보다 빠른 완료 메시지·실행 실패·빈 이미지·연결 종료·취소·시간 초과·설정 충돌을 포함한다.

Browser 플러그인과 레포의 Playwright 설치가 없어 번들 Playwright와 이미 설치된 Chromium으로 프로덕션 앱을 검증했다. 테스트 데이터는 임시 폴더로 분리했다. `/`의 이미지 설정 링크 → 서버 목록 조회 → ZIT/SDXL 모델 선택·저장 → 새로고침 복원 → 프리셋별 설정 유지 → 실제 SDXL 이미지의 API 수신·표시 흐름을 통과했다. 기존 동일 seed의 샘플러 결과가 캐시되어도 WebSocket 출력이 다시 전달되는 것을 확인했다. 1440×1000·390×844 화면에서 의미 있는 콘텐츠·모바일 가로 넘침 없음·콘솔 오류/경고 없음·프레임워크 오류 화면 없음을 확인했다. 화면과 보고서는 레포 밖 임시 폴더 `C:/Users/snowm/AppData/Local/Temp/newera-comfyui-qa-20261024/`에 보관했다.

Anima 추가 후 같은 서버에서 제공 파일의 모델 조합과 원본 30스텝·CFG 4·1024×1024 설정, seed 20261024로 실제 실행했다. 약 56.4초에 PNG 1465241바이트를 WebSocket으로 수신했다. 검증용 파일은 `.qa-data/anima-smoke-20261024/`에 보관한다. 타입 검사 오류·경고 0개, 전체 127개 테스트 통과, 프로덕션 빌드 성공을 확인했다.

Anima 화면 검증은 기존 두 프리셋만 저장한 version 1 설정 파일로 시작했다. 기존 기본 워크플로우 유지 → 세 번째 Anima 선택 → 확산 모델·인코더·VAE 선택 → 저장·새로고침 복원 → 실제 Anima 이미지 수신·표시를 확인했고, 저장 후에도 기존 ZIT/SDXL 설정이 그대로 남았다. 1440×1000·390×844 화면에서 콘솔 오류/경고와 가로 넘침이 없었다. 번들 Playwright·기존 Chromium을 사용했고, 증거는 `C:/Users/snowm/AppData/Local/Temp/newera-anima-qa-20261024/`에 보관한다.

이름 있는 이미지 설정 프리셋과 세션 선택 추가 후 타입 검사 오류·경고 0개, 전체 136개 단위/계약 테스트와 기존 18개 통합 테스트 통과, 프로덕션 빌드 성공을 확인했다. 기존 DB의 열 추가·세션 간 선택 격리·슬롯/초기화 후 선택 유지·사용 중 삭제 차단·리비전 충돌·인라인 API 키 거부·진행 중 프리셋 수정/선택 변경에 대한 스냅샷·프리셋 자체의 ComfyUI 주소와 모델 사용을 검증했다.

브라우저에서는 이름 있는 프리셋 생성·복사·재진입 복원·두 세션의 서로 다른 선택·선택 재로딩·세션별 모델/화풍 적용·사용 중 삭제 버튼 비활성화를 확인했다. 1440×1000·390×844 화면에 가로 넘침과 콘솔 오류/경고가 없었다. 이 화면 검증은 로컬 모의 이미지 API를 사용했으며 증거는 `C:/Users/snowm/AppData/Local/Temp/newera-image-presets-qa-20261024/`에 보관한다.

추가로 실제 환경 변수 키를 사용해 각 Provider의 설정 프리셋을 SQLite에 저장하고, 서로 다른 테스트 세션에 연결한 후 `generateWorldImage()`로 각각 한 번씩 생성했다. OpenAI `gpt-image-1.5`는 약 7.5초에 PNG 2338481바이트, xAI `grok-imagine-image-2.0`은 약 10.4초에 JPEG 590861바이트, OpenRouter `openai/gpt-image-2`는 약 16.6초에 PNG 2202441바이트를 반환했다. 응답 프리셋 ID·리비전을 확인했고 세 이미지의 디코딩도 성공했다. OpenRouter가 보고한 비용은 USD 0.0061이었다. 테스트 DB·원본 결과·사용량 JSON은 `.qa-data/image-preset-live-20261024/`에 보관하며 실제 플레이 데이터는 변경하지 않았다.
