# REELCHECK 검수 서버 — Whisper · claude-real-video 연동 가이드

프론트엔드(`content-review-platform.jsx`)가 호출할 백엔드입니다.
브라우저에서는 두 작업 모두 불가능해서 서버가 필요합니다.

| 작업 | 브라우저에서 안 되는 이유 |
|---|---|
| Whisper 전사 | API 키를 프론트엔드에 넣으면 개발자도구에서 그대로 보입니다. 키 하나 유출되면 남의 청구서가 됩니다. |
| claude-real-video | Python 패키지 + ffmpeg 바이너리를 실행합니다. 브라우저에 프로세스 실행 권한이 없습니다. |

---

## 1. 사전 설치 (한 번만)

### ffmpeg / ffprobe
crv와 오디오 추출이 둘 다 씁니다. pip로는 설치되지 않습니다.

| OS | 명령 |
|---|---|
| macOS | `brew install ffmpeg` |
| Ubuntu/Debian | `sudo apt install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |

확인: `ffmpeg -version`

### claude-real-video
```bash
pip install claude-real-video      # 코어 (키프레임 + 중복 제거)
crv --help                         # 설치 확인
```
`[whisper]` 옵션(`pip install "claude-real-video[whisper]"`)은 **설치하지 않아도 됩니다.**
전사는 OpenAI API로 처리합니다 — 이유는 3-2에 적었습니다.

### Node
Node 20 이상 (`node -v`). `--env-file`과 내장 `fetch`/`FormData`를 씁니다.

---

## 2. OpenAI API 키 발급

1. <https://platform.openai.com> 접속 → 가입 (ChatGPT 계정과 별개의 **플랫폼** 계정입니다. ChatGPT Plus 구독은 API 사용량에 포함되지 않습니다.)
2. 좌측 **Settings → Organization → Billing**에서 결제수단 등록. 신규 계정 무료 크레딧은 정책이 자주 바뀌니 대시보드에서 잔액을 직접 확인하세요.
3. **API keys → Create new secret key**
   - 이름: `reelcheck-stt`
   - 권한: **Restricted**로 만들고 `Model capabilities`만 켜세요. 전체 권한 키를 쓸 이유가 없습니다.
   - 생성 직후 화면에서만 보입니다. 놓치면 재발급뿐입니다.
4. **Limits → Usage limits**에서 월 한도를 걸어두세요. 자동 재촬영 루프가 돌면 비용이 조용히 올라갑니다.

### 키 저장
서버 폴더에 `.env` 파일을 만들고 아래 내용을 넣습니다. **저장소에 커밋하지 마세요** (`.gitignore`에 `.env` 추가).

```
OPENAI_API_KEY=여기에_발급받은_키
STT_MODEL=whisper-1
STT_LANG=ko
PORT=8787
ALLOW_ORIGIN=http://localhost:5173
```

### 모델 선택
| 모델 | 분당 요금 | 타임코드 | 비고 |
|---|---|---|---|
| `whisper-1` | 약 $0.006 | **구간 타임스탬프 지원** | 이 프로젝트 기본값 |
| `gpt-4o-mini-transcribe` | 약 $0.003 | 없음 | 가장 저렴 |
| `gpt-4o-transcribe` | 약 $0.006 | 없음 | 정확도 개선 |
| `gpt-transcribe` | 약 $0.0045 | 없음 | 2026년 7월 공개, OpenAI 권장 |

**`whisper-1`을 기본으로 둔 이유는 정확도가 아니라 타임코드입니다.** 신형 모델들이 오류율은 더 낮지만 SRT/구간 타임스탬프를 주지 않습니다. 검수 피드백은 "USP 2가 누락"보다 "00:14에서 빠졌습니다"가 훨씬 쓸모 있으니, 타임코드를 포기할 수 없습니다.
정확도가 더 중요해지면 `STT_MODEL=gpt-transcribe`로 바꾸고 타임코드를 포기하거나, 두 번 호출해 텍스트는 신형 · 타임코드는 `whisper-1`에서 가져오면 됩니다.

비용 감각: 60초 릴스 1건 ≈ $0.006. 인플루언서 100명이 2번씩 제출하면 약 $1.2입니다. 프레임 판독에 쓰는 Claude 비용이 오히려 큽니다.

### 실무에서 걸리는 부분 두 가지

**업로드 25MB 한도.** `server.js`가 영상에서 오디오만 뽑아 16kHz 모노 32kbps로 줄입니다 (1분에 약 240KB). 한도를 넘으면 시간 단위로 자르고 타임코드를 이어 붙입니다.

**`prompt` 파라미터에 브랜드명을 넣지 마세요.** Whisper의 `prompt`는 고유명사 인식률을 올려주는 옵션이라 넣고 싶어지지만, 인플루언서가 "무드렙"이라고 잘못 말해도 힌트를 보고 "무드랩"으로 고쳐 적습니다. **정작 잡아야 할 오기입이 전사 단계에서 사라집니다.** `server.js`에서 의도적으로 비워뒀습니다.

---

## 3. claude-real-video 연동

MIT 라이선스입니다. 상업적 사용·수정·재배포 모두 가능하고, 저작권 표시만 유지하면 됩니다. Pro 버전(카메라 무브, 편집 리듬)은 유료지만 검수 용도에는 필요 없습니다.

### 3-1. 왜 이걸 쓰는지
현재 프론트엔드는 영상을 6등분해서 프레임을 뽑습니다. 릴스에는 이게 맞지 않습니다 — 컷이 빠르면 놓치고, 정지 화면이 길면 같은 프레임을 6장 얻습니다.
crv는 **장면 전환마다** 뽑고 중복을 걸러냅니다. 58초 클립에서 1fps는 58장, crv는 실제로 달라지는 26장만 남깁니다. 자막 검수에서는 이 차이가 곧 놓친 자막 수입니다.

### 3-2. 전사는 crv에 맡기지 않은 이유
crv도 `--lang ko`로 전사할 수 있고, 로컬 실행이라 무료입니다. 다만 이 프로젝트에서는 API를 쓰는 편이 낫습니다.
- crv는 `transcript.txt` 평문을 주지만, 검수에는 구간 타임코드가 필요합니다.
- 로컬 whisper는 서버 CPU를 오래 붙잡습니다. 마감 전날 20명이 동시에 올리면 큐가 밀립니다.
- 분당 $0.006이면 CPU 시간이 더 비쌉니다.

비용을 0으로 만들어야 하면 `--no-transcribe`를 떼고 `crv-out/*.srt`를 파싱하는 쪽으로 바꾸면 됩니다.

### 3-3. 검수용 파라미터 조정 — 여기가 핵심입니다

crv 기본값은 "사람이 영상 내용을 파악하는" 용도로 맞춰져 있습니다. **자막 오타를 잡는 용도에는 그대로 쓰면 안 됩니다.**

문제는 `--dedup-threshold`입니다. 기본값 8은 "픽셀의 8% 이상이 바뀌어야 새 프레임"이라는 뜻입니다. 그런데 인물 고정 + 하단 자막만 교체되는 흔한 릴스 구도에서 자막 영역은 화면의 3~5%입니다. **기본값이면 자막이 바뀌어도 중복으로 버려집니다.** 검수하려던 그 자막이 사라집니다.

`server.js`에 넣어둔 값:

| 플래그 | 기본값 | 이 프로젝트 | 이유 |
|---|---|---|---|
| `--dedup-threshold` | 8 | **4** | 자막만 바뀌는 프레임을 살립니다 |
| `--scene` | 0.30 | **0.22** | 릴스의 빠른 컷 대응 |
| `--fps-floor` | 1.0 | **0.5** | 자막이 0.7초씩 지나가도 걸립니다 |
| `--dedup-window` | 4 | **2** | 같은 구도로 돌아와도 자막은 다릅니다 |
| `--max-frames` | 150 | **60** | Claude 이미지 토큰 상한 |

값 검증은 `--report`로 하세요. `report.html`에 프레임별 keep/drop 판단과 차이 %가 전부 나옵니다. 실제 캠페인 영상 3~5개로 돌려보고, 버려진 프레임에 자막이 있는지 눈으로 확인한 뒤 `--dedup-threshold`를 조이거나 푸세요. 요청 바디에 값을 실어 보내면 서버에서 그대로 씁니다:

```bash
curl -X POST http://localhost:8787/api/frames \
  -F video=@reel.mp4 -F dedup=3 -F scene=0.18 -F report=1
```

### 3-4. 소스를 직접 고쳐야 할 때

파라미터로 안 되는 게 하나 있습니다. crv의 중복 판정은 **화면 전체**의 픽셀 차이를 봅니다. 자막만 보려면 하단 영역만 비교해야 맞습니다. `--dedup-threshold`를 낮추는 건 전체 민감도를 올리는 우회책이라, 프레임 수가 같이 늘어납니다.

정공법은 포크해서 자막 영역 비교를 추가하는 것입니다.

```bash
gh repo fork HUANGCHIHHUNGLeo/claude-real-video --clone
cd claude-real-video
python -m venv .venv && source .venv/bin/activate
pip install -e .                                  # 편집한 코드가 바로 crv에 반영됨
grep -rn "dedup_threshold" claude_real_video/      # 중복 판정 로직 위치 찾기
```

고칠 지점: 프레임 diff를 계산하는 함수에서, 전체 프레임 대신 **하단 30% 영역을 크롭한 뒤** 별도 임계값으로 한 번 더 비교하고, 둘 중 하나라도 넘으면 keep 하도록 합니다. 상단은 기본 임계값, 하단(자막대)은 낮은 임계값 — 프레임 수는 유지하면서 자막 교체는 놓치지 않습니다.

작업 순서:
1. 브랜치를 따고 (`git checkout -b subtitle-band-dedup`) 크롭 비교를 추가합니다.
2. `benchmark/` 영상과 실제 캠페인 영상으로 `--report` 비교. before/after 프레임 수와 놓친 자막 수를 기록하세요.
3. 서버에서는 `CRV_BIN=/경로/.venv/bin/crv`로 포크 버전을 가리킵니다.
4. 업스트림에 PR을 보내면 다음 릴리스에서 포크 유지 부담이 없어집니다. 유지한다면 `pip install git+https://github.com/내계정/claude-real-video@subtitle-band-dedup`로 배포하세요.
5. 업스트림 추적: `git remote add upstream https://github.com/HUANGCHIHHUNGLeo/claude-real-video && git fetch upstream && git rebase upstream/master`

> 프레임 시각 파싱 주의: `server.js`의 `frameTimes()`는 파일명 → MANIFEST.txt → 균등 분배 순으로 시도합니다. crv 버전마다 파일명 규칙이 달라서 그렇습니다. 응답의 `timeSource`가 `estimated`로 오면 타임코드가 근사치라는 뜻이니, 실제 출력 파일명을 보고 정규식을 맞춰주세요.

---

## 4. 실행

```bash
cd reelcheck-server
npm install
npm start
```

```bash
curl -s http://localhost:8787/api/health
# { "ffmpeg": true, "ffprobe": true, "crv": true, "openaiKey": true, "sttModel": "whisper-1" }
```

네 항목이 모두 `true`가 아니면 위 설치 단계로 돌아가세요.

### 엔드포인트

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/health` | 의존성 설치 상태 |
| POST | `/api/transcribe` | `{ duration, text, segments[], language }` |
| POST | `/api/frames` | `{ duration, frames[], timeSource }` |
| POST | `/api/inspect` | 위 둘 합본 + `warnings[]` ← 프론트엔드가 호출 |

`/api/inspect`는 전사와 프레임 추출을 병렬로 돌리고, 한쪽만 실패하면 나머지 결과와 `warnings`를 함께 돌려줍니다. 음성이 없는 영상이라도 자막 검수는 진행됩니다.

```bash
curl -X POST http://localhost:8787/api/inspect -F video=@reel.mp4 | jq '{duration, frames: (.frames|length), timeSource, segments: (.segments|length)}'
```

---

## 5. 배포할 때

- `ALLOW_ORIGIN`을 실제 프론트엔드 도메인으로 좁히세요. `*`는 로컬 개발용입니다.
- 컨테이너 이미지에 ffmpeg과 crv가 함께 들어가야 합니다. `apt install ffmpeg` + `pip install claude-real-video`를 Dockerfile에 넣으세요. 서버리스(Lambda/Vercel Functions)는 실행 시간 제한과 바이너리 크기 때문에 맞지 않습니다.
- 영상 업로드는 서버를 거치지 말고 S3 presigned URL로 직접 올린 뒤 키만 넘기는 편이 낫습니다. 지금 구조는 서버 메모리/디스크를 씁니다.
- 임시 파일은 매 요청 후 삭제하지만, 컨테이너 재시작 실패 시 `/tmp`가 남을 수 있으니 디스크 알림을 걸어두세요.
- 처리 시간이 30초를 넘길 수 있습니다. 인플루언서가 화면을 닫아도 검수가 이어지려면 작업 큐(예: BullMQ)와 폴링으로 바꿔야 합니다. 저장 기능을 붙일 때 같이 설계하는 게 맞습니다.
