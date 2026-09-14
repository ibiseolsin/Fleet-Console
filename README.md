# Fleet Console

> ℹ️ 이 저장소는 실제 플릿 운영 기록을 익명화해 들여왔다. 공개 전 검수와 소유자 승인을 거쳤다
> (2026-09-14, `§4` 스캔 0건 · 제외 2개 프로젝트 · 검수 기록 [`notes/slice13-공개검수.md`](./notes/slice13-공개검수.md)).
> 규칙과 절차는 [`ANONYMIZATION.md`](./ANONYMIZATION.md) — 파일이 추가되면 승인을 다시 받는다.

**바로 보기 → https://fleet-console-d7c5.onrender.com**

> ⏱️ **첫 접속은 최대 1분 걸립니다.** 무료 호스팅이라 15분 트래픽이 없으면 서버가 잠들고, 다음 접속 때
> 깨어나며 상태를 복원합니다(실측 52초). 깨어난 뒤에는 0.3초 안쪽입니다. 화면이 흰 채로 있어도 기다려 주세요.
> `/agent` 첫 방문은 방문자 전용 샌드박스를 만드느라 3~4초 더 걸립니다.

여러 AI 코딩 에이전트를 병렬로 운영하는 개발자를 위한 **에이전틱 워크플로 콘솔**.

플릿 운영 회차 — 관찰 → 자격 판정 → 승인 → 실행 → 기록 — 를 화면에서 따라가고,
비용이 발생하거나 되돌리기 어려운 실행 전에 사람이 승인한다.
같은 기능을 MCP 도구로 노출해 외부 에이전트가 플릿을 조회하고 (승인을 거쳐) 조작할 수 있다.

## 무엇이 새로 만들어지는가

기존 오케스트레이터(`sp-sync`)는 **수정하지 않는다.** 그 위에 얇은 레이어 세 개를 얹는다.

| | 하는 일 |
|---|---|
| `sp-sync/` | 기존 플릿 오케스트레이터 (벤더링) — 판정 규칙과 테스트 455개 |
| `src/fleet/` | 관찰·판정 결과를 도구가 낼 모양으로 옮기는 층. 화면도 같은 표를 쓴다 |
| `src/mcp/` | 판정·실행 기능을 MCP 도구 5종으로 노출. 읽기 3 / 승인 필요한 쓰기 2 |
| `src/agent/` | 앱 안의 에이전트 루프 — 같은 도구 5종으로 관찰하고 순서를 고르며, 쓰기 앞에서 승인 대기 |
| `web/` | 화면 — 회차 trace 뷰어 · 승인 큐 · 비용·시간 패널 |
| `data/` | 익명화해 반입한 **실제 운영 회차 기록** 241개와 그 회차들의 시간·토큰 계측 |
| `sandbox/` | 샌드박스 플릿과 회차 기록 (생성물 — git 이 무시한다) |

## 문서

- [`PROBLEM.md`](./PROBLEM.md) — 무엇을 왜 만드는가
- [`PRD.md`](./PRD.md) — 타겟 유저 · 워크플로 · 도구 계획 · 사람 개입 지점 · MVP · 평가 시나리오
- [`ANONYMIZATION.md`](./ANONYMIZATION.md) — 공개 전 익명화 규칙과 푸시 승인 절차
- [`PLAN.md`](./PLAN.md) — 구현 슬라이스 (검토 완료)
- [`EVAL.md`](./EVAL.md) — 평가 결과: 판정 일치율(두 축) · 헛호출률 · 사고 분류와 `PRD.md §8` 다섯 기준의 지금 값

## 현재 단계

- [x] 문제정의
- [x] PRD
- [x] 익명화 규칙
- [x] 계획 검토
- [x] 구현 1단계 (슬라이스 7개)
- [ ] 평가 · 배포
- [ ] 공개 전환 승인

## 실행 방법

### 컨테이너 · Render Free (12번 진행 중)

> **2026-09-11 변경: 유료 Render 배포는 철회하고 무료(Free) 플랜으로 간다.** 추가 결제·Anthropic 키는 필요 없다.
> 에이전트 루프는 OpenAI API(`OPENAI_API_KEY`)로 돈다(슬라이스 14).

`Dockerfile`은 git과 프로덕션 웹 앱을 포함한다. 빌드 중 `npm run check`를
실행하며, 서버는 일반 사용자 `node`로 돈다. 상태는 `/var/data/fleet` 한 곳에 저장한다.

```bash
docker build -t fleet-console .
docker run -d --name fleet-console -p 127.0.0.1:3118:10000 --mount type=volume,source=fleet-state,target=/var/data fleet-console
# http://127.0.0.1:3118 — API 키 없이도 기록과 승인 화면을 열 수 있다.
docker run --rm --user node --entrypoint node fleet-console scripts/container-benchmark.mjs
```

#### 상태 보존 — 영구 디스크 없이

Render Free 는 영구 디스크가 없고 15분 무트래픽이면 절전하며 그때 로컬 파일 변경이 사라진다
([Free 문서](https://render.com/docs/free)). 그래서 상태 루트 전체를 **tar.gz 한 파일**로 바깥에 둔다(`scripts/state-sync.mjs`):

- 부팅: `restore`(루트가 비어 있으면 최신 스냅샷을 같은 경로에 푼다) → `container-prepare.mjs`(`running` → `interrupted`, 빈 잠금 제거) → `watch` + Next.
- 운영 중: `watch` 가 루트를 재귀 감시해 3초 디바운스 뒤 내용 해시가 바뀐 경우에만 올린다. 60초마다 해시를 다시 재는 안전망이 있고, SIGTERM 에 마지막 한 번 더 올린다.
- 저장소: 비공개 GitHub 저장소의 `state.tar.gz` 하나(Contents API, 스냅샷마다 커밋 하나). 잠금 폴더와 `*.tmp` 는 넣지 않는다.

| 환경변수 | 뜻 |
|---|---|
| `FLEET_STATE_REPO` | `owner/repo` — 상태 스냅샷을 둘 **비공개** 저장소. 있으면 GitHub 백엔드 |
| `FLEET_STATE_TOKEN` | 그 저장소 **Contents 쓰기**만 되는 fine-grained 토큰(만료일은 심사 기간 뒤) |
| `FLEET_STATE_PATH` · `FLEET_STATE_BRANCH` | 선택. 기본 `state.tar.gz` · 기본 브랜치 |
| `FLEET_STATE_DIR` | 대신 폴더 하나(로컬·컨테이너 검사용 `dir` 백엔드). 둘 다 없으면 동기화 없음 |

`render.yaml`은 Free 플랜 한 대, 디스크 없음, `/health`, `$PORT`, 자동 배포 꺼짐이다.
`OPENAI_API_KEY`·`FLEET_STATE_REPO`·`FLEET_STATE_TOKEN` 은 Render 의 비밀 환경변수 입력란에 넣는다. 채팅·소스·이미지에는 넣지 않는다.
`FLEET_DAILY_RUNS=20`, `FLEET_MAX_RUN_USD=0.25`가 기본이다. API 비용은 호스팅과 별도이며 OpenAI 사용량 화면으로 확인한다.

**실측 (2026-09-14, `fleet-console-d7c5.onrender.com`, Free 0.1 CPU · 512MB)**

| 잰 것 | 값 |
|---|---|
| 절전 뒤 첫 접속 | **52.3초** (TTFB 52.2초 — 컨테이너 기동 + 스냅샷 복원). 그 뒤 요청은 0.26초 |
| 첫 방문 픽스처 생성 | **3.3~4.0초** (새 쿠키 3회: 4.02 · 3.84 · 3.34초). 같은 방문자 재방문 0.22~0.45초 |
| 화면 응답 (따뜻할 때) | `/runs` 0.22초 · `/eval` 0.49초 · `/agent` 0.22초 · `/approvals` 0.23초 |
| 에이전트 1회 (실행+재개) | 도구 5회 · 턴 6 · 13초 · **$0.0033** (gpt-4.1-mini) |
| 스냅샷 | `state.tar.gz` 296KB (방문자 3벌 + 실행 기록), 변경마다 커밋 하나 |

첫 방문 3.3~4.0초는 슬라이스 11이 정한 3초 게이트를 넘지만 방문자별 격리를 유지하기로 했다 — 근거는
`notes/slice11-데모격리.md`. 로컬 Docker Desktop 에서는 같은 이미지가 448ms 였다(0.1 CPU 와의 차이).
같은 상태 저장소에 서버 둘을 동시에 띄우면 안 된다(나중 스냅샷이 먼저 것을 덮는다).

#### 캡처 — 배포본에서 한 바퀴

`docs/captures/` (배포본에서 `node scripts/capture-demo.mjs <주소>` 로 다시 만들 수 있다 — 모델을 한 번 부른다).

| 파일 | 무엇 |
|---|---|
| `1-agent-trace.png` | 실행 trace — 도구 호출·인자·**이유**·결과·소요, 쓰기 도구 앞에서 멈춘 지점 |
| `2-approval-queue.png` | 승인 큐 — 자격 근거와 "승인하면 무엇이 벌어지는가" |
| `3-landing-result.png` | 착륙 결과 — `머지 완료 (PR #1)` 과 단계 로그 |
| `4-run-finished.png` | 승인 뒤 같은 실행을 이어서 끝낸 결과 |
| `5-usage.png` | 비용·시간 화면 |

#### Render 배포 절차 (사람이 하는 부분)

계정·토큰·비밀값 입력은 소유자가 직접 한다. 값은 채팅·소스·이미지에 넣지 않는다.

1. **상태 저장소** — GitHub 에 **비공개** 저장소 하나를 만든다(예: `fleet-console-state`, 내용 없이 시작해도 된다).
   이 저장소의 `Fleet-Console` 소유 계정과 같은 계정에 두는 것이 토큰 범위가 단순하다.
2. **토큰** — GitHub → Settings → Developer settings → **Fine-grained personal access token**.
   Repository access 는 1번 저장소 **하나만**, 권한은 **Repository permissions → Contents: Read and write** 하나만.
   만료일은 심사 기간 뒤로 둔다. (Contents 만 있으면 된다 — 다른 권한은 켜지 않는다.)
3. **배포 전 확인** — 로컬에서 토큰이 실제로 되는지 한 번 본다. Render 는 셸이 없어 실패하면 부팅 로그로만 보인다.

   ```bash
   FLEET_STATE_REPO=<owner>/<state-repo> FLEET_STATE_TOKEN=<token> node scripts/state-sync.mjs preflight
   ```

   `preflight-ok` 가 나오면 된 것이다(`state.tar.gz.preflight` 확인용 파일 하나가 그 저장소에 남는다 — 지워도 된다).
   `preflight-fail` 의 `hint` 가 401 토큰 · 403 권한 · 404 저장소 이름 중 무엇인지 알려준다.
4. **Render** — [render.com](https://render.com) 가입(무료, GitHub 연결) → New → Web Service → 이 저장소 →
   **Runtime: Docker**, **Instance Type: Free**. *생성 화면에서 Free 에 Docker 가 있는지와 카드 요구 여부를 확인한다 —
   공식 문서에 명시가 없어 여기서 처음 보인다. 카드를 요구하면 멈추고 알린다.*
5. **환경변수** — 서비스의 Environment 에 비밀값 셋을 넣는다(`render.yaml` 의 `sync: false` 항목).

   | 키 | 값 |
   |---|---|
   | `OPENAI_API_KEY` | 교육기관 제공 키 |
   | `FLEET_STATE_REPO` | 1번 저장소 `owner/repo` |
   | `FLEET_STATE_TOKEN` | 2번 토큰 |

6. 배포 뒤 URL 을 알려주면 남은 검증(다섯 화면 · 실제 OpenAI 실행/승인/착륙 · 재배포 후 보존 · 절전 첫 접속 실측 · 지출 0)을 이어서 한다.

#### 재생성 검사 (모델 호출 없음)

컨테이너를 **지우고 새로 만들어도**(볼륨 없음) 큐·실행 기록·오늘 실행 횟수가 돌아오고 `running` 이던 실행이 `interrupted` 로 보이는지 본다.
스냅샷은 호스트 폴더 하나(`dir` 백엔드)로만 건너간다.

```bash
sh scripts/container-recreate-check.sh fleet-console          # seed → stop·rm → 새 컨테이너 → verify
```

검증 상세와 남은 일: [`notes/slice12-컨테이너배포.md`](./notes/slice12-컨테이너배포.md).

### 로컬 개발

```bash
npm install
npm run check          # 아래 다섯을 순서대로 (픽스처를 다시 만들고 시작한다)
npm run fixture        # 샌드박스 플릿과 회차 기록을 만든다 (sandbox/, git 이 무시)
npm run fixture:check  # 판정 함수 셋이 픽스처에서 도는지
npm run mcp:check      # MCP 클라이언트로 읽기 도구 셋을 부르고 격리를 확인한다
npm run mcp:write-check # 쓰기 도구 둘과 승인 게이트 — 승인 전/후를 한 회차로 재생한다
npm run usage:check    # 반입한 시간·토큰 계측이 회차 기록과 맞는지 (원본 없이도 돈다)
npm test               # 벤더링한 오케스트레이터의 테스트 455개

npm run eval           # 평가 시나리오 10개를 픽스처로 재생해 기대와 대조 (data/eval/scenarios.json)
npm run eval:settings  # 동시 상한 × 재개 상한을 갈아 끼워 판정이 어떻게 갈리는지 (data/eval/settings.json)
npm run eval:coverage  # 반입한 회차 기록의 사유 문장이 코드로 분류되는 비율과 헛호출 (data/eval/coverage.json)

npm run web            # 화면 (http://localhost:3000) — 처음이면 `npm --prefix web install`
npm run approve        # 승인 큐 — 화면 대신 명령줄에서
npm run agent          # 에이전트 루프 한 실행 — 화면 대신 명령줄에서 (.env 의 OPENAI_API_KEY)
npm run agent:check    # 루프의 완료 기준을 실제 모델로 끝까지 — 모델을 여러 번 부른다
node scripts/agent-check.mjs --fake  # 같은 검사를 가짜 모델로 — 네트워크·키 없이
npm run import:runs    # 운영 회차 기록을 익명화해 data/runs/ 로 다시 들여온다
npm run import:usage   # 그 회차들의 시간·토큰을 다시 묶는다 (로컬 로그·세션 기록이 있어야 한다)
npm run import:incidents # 사고 사례를 익명화해 data/eval/incidents.json 으로 들여온다 (원본이 있어야 한다)
```

## 화면

| 경로 | 담는 것 |
|---|---|
| `/runs` | 반입한 회차 목록 — 날짜별로 `착륙 · 파견 · 막힘 · 결정 필요` |
| `/runs/<회차>` | 회차 상세 — **관찰 → 자격 판정 → 실행** 순서로, 각 판정의 사유까지. 그 회차의 시간·토큰도 |
| `/approvals` | 승인 큐 — 대기 항목의 근거를 보고 **승인 / 보류**. 사람의 자리다 |
| `/eval` | 비용·시간 — 회차별 소요와 토큰, 어느 단계가 병목인지 |
| `/agent` | 에이전트 루프 — "이 플릿의 다음 할 일을 정해줘" 를 시작하고, 실행마다 **도구 호출과 그 이유**를 본다. 쓰기 앞에서 승인 대기로 멈추고, 승인 뒤 이어서 끝낸다 |

대시보드(`/`)와 평가 표(세팅 비교·실패 사례)는 2단계다.

## 회차 기록 반입

`data/runs/` 는 실제로 플릿을 돌린 기록이다. `scripts/import-runs.mjs` 가 [`ANONYMIZATION.md`](./ANONYMIZATION.md)
대로 치환·제외하고, 행을 지운 회차는 **요약 숫자를 다시 세어** 들여온다. 무엇을 몇 개 지웠는지는
[`data/import-report.md`](./data/import-report.md) 에 그 스크립트가 남긴다.

실명·제외 목록은 저장소에 없다 — 로컬 전용 파일(`anonymize.local.json`, git 무시)에서 읽고,
금칙어가 하나라도 남으면 **아무것도 쓰지 않는다**.

## 회차별 시간·토큰

회차 기록에는 시간이 없고, 운영 저장소의 토큰 요약은 프로젝트·주 단위라 회차별이 없다.
그래서 `scripts/import-usage.mjs` 가 **플릿 로그의 줄 시각**과 **에이전트 세션 기록**을 회차
시각 범위로 새로 묶는다 → [`data/usage/cycles.json`](./data/usage/cycles.json) ·
[`data/usage-report.md`](./data/usage-report.md).

로그는 단계가 **끝날 때** 한 줄을 남기지 시작할 때는 안 남긴다. 그래서 구간 이름은 그것을 끝낸
줄의 단계이고, 실행 네 단계에는 그 앞의 관찰·판정이 얼마간 섞여 있다. 회차 시작이 분 단위라
소요 시간은 최대 59초 길게 나온다 — 한계를 보고서와 화면에 그대로 적는다.

프로젝트별은 **비중(%)만** 낸다 (`ANONYMIZATION.md §2`). 제외 프로젝트의 세션은 통째로 빼고
비중을 다시 계산한다 (§1·§3).

승인 대기 항목은 **사람이** 다룬다 (도구로 노출하지 않는다 — 에이전트가 제 요청을 승인하면
게이트가 아니다). 창구는 둘이고 같은 함수를 부른다 — 화면 `/approvals`, 그리고 명령줄:

```bash
npm run approve                       # 대기 중인 항목
node scripts/approve.mjs show <id>    # 그 항목의 근거 전부
node scripts/approve.mjs approve <id> # 승인 — 같은 인자로 도구를 다시 부르면 실행된다
node scripts/approve.mjs hold <id>    # 보류 — 그 항목만 멈춘다
```

MCP 서버는 `npm run mcp` (stdio) 로 뜬다. 저장소 루트의 `.mcp.json` 에 등록돼 있어,
MCP 클라이언트를 이 폴더에서 열면 도구가 바로 목록에 뜬다.

| 도구 | 하는 일 | 권한 |
|---|---|---|
| `fleet_status` | 프로젝트별 작업 공간과 진행 상태 + 그 사유 | 읽기 전용 |
| `fleet_slices` | 슬라이스 목록과 **파견 자격 + 불가 사유** | 읽기 전용 |
| `fleet_report` | 지난 회차 기록 (날짜 범위) | 읽기 전용 |
| `fleet_dispatch` | 슬라이스를 에이전트에게 파견 | **승인 필요** |
| `fleet_land` | 완료된 작업 공간을 본 저장소에 반영 | **승인 필요** |

읽기 도구 셋은 어떤 상태도 바꾸지 않는다 — `npm run mcp:check` 가 호출 전후 해시로 확인한다.

쓰기 도구 둘은 승인 없이 부르면 **아무것도 만들지 않고** 대기 항목만 낸다. 사람이 승인한 뒤
같은 인자로 다시 불러야 실행된다. 자격이 없으면 대기시키지도 않고 **사유와 함께 거부한다** —
"파견 불가" 가 아니라 "선행 2번이 미완" 까지. 실행 대상은 저장소 안의 샌드박스 픽스처뿐이고,
실제 플릿의 회차 락·방아쇠·회차 결과는 건드리지 않는다 (`npm run mcp:write-check` 가 해시로 확인).
