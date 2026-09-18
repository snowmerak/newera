# newera

era의 행동·수치 체계를 바탕으로 세계와 등장인물이 스스로 움직이는 성인 텍스트 게임 실험판입니다. 플레이어는 행동을 먼저 선택하거나 `다음 장면`을 눌러 세계의 진행과 인물의 제안을 받을 수 있습니다. [진행 구조](docs/PRODUCT.md)에 현재 범위와 설계를 적었습니다.

## 실행

Node.js 24 이상이 필요합니다.

```powershell
npm install
npm run dev
```

개발 화면은 기본적으로 `http://localhost:5173`에서 열립니다. 배포용 서버는 `npm run build` 후 `node build/index.js`로 실행합니다. 배포 주소에 맞춰 SvelteKit Node 어댑터의 `ORIGIN`을 설정하세요.

## 모델 설정

| 변수 | 기본값 |
| --- | --- |
| `NEWERA_LLM_BASE_URL` | `http://localhost:1234/v1` |
| `NEWERA_LLM_MODEL` | `gemma4-31b-qat-uncensored-hauhaucs-balanced-mtp` |
| `NEWERA_EMBEDDING_MODEL` | `text-embedding-qwen3-embedding-0.6b` |
| `NEWERA_LLM_TIMEOUT_MS` | `180000` |
| `NEWERA_DATA_DIR` | 프로젝트의 `data` 폴더 |

`.env.example`에 같은 항목이 있습니다. 채팅 요청에는 `max_tokens`를 지정하지 않습니다. 세계와 인물은 같은 모델에 각각 독립적인 단발 요청을 보냅니다. 서버가 장면 응답을 주지 않으면 턴은 진행되지 않습니다. 임베딩 실패만으로는 턴이 중단되지 않습니다.

## 사용

- `다음 장면`은 세계가 상황을 만들고 주목한 인물이 반응하도록 합니다. 인물이 제안을 하면 수락·거절할 수 있습니다.
- 상대 또는 세계·장소를 고른 뒤 LLM에게 행동 선택지를 받거나 행동을 자유롭게 입력할 수 있습니다. 선택지는 그 턴과 상대에 맞춰 생성되며, 직접 입력한 문장도 그대로 장면의 의도로 전달됩니다.
- 자유 행동은 먼저 기존 COMMAND에 해당하는지 해석합니다. 해당하면 조건을 검사하고 수락된 행동에 SOURCE, PALAM, 관계·경험·MARK 변화를 적용합니다. 이동·탐색 등 다른 행동은 사건으로 진행하며 현재는 수치를 임의로 바꾸지 않습니다.
- 접힌 설정 메뉴에서 세계관과 era 규칙, 인물의 프로필과 수치를 편집하고 새 성인 인물을 추가할 수 있습니다.
- `모듈` 메뉴에서 JSON 파일로 세계관과 성인 등장인물을 설치하고 적용할 수 있습니다. 세계관 모듈은 한 번에 하나, 인물 모듈은 여러 개를 켤 수 있습니다. [형식과 예시](static/modules/README.md)를 참고하세요. 모듈을 꺼도 인물의 진행과 기억은 유지됩니다.
- 진행은 SQLite에 자동 저장됩니다. 슬롯 1~3에는 별도 스냅샷을 저장·불러올 수 있습니다.

기억은 SQLite FTS5 trigram/BM25와 임베딩 유사도로 검색합니다. `data/newera.sqlite`에는 이전 실험판의 데이터가 남아 있을 수 있으며, 시작 장면은 새 데이터 저장소에서 생성됩니다.
