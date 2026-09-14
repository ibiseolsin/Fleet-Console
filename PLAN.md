# 작업계획

근거: `PRD.md`. 채점 기준: `ASSIGNMENT.md` (사용자 제공 Main Quest 4 원문과 현재 결과 대조).
지난 단계 본문은 `PLAN-archive.md`.

## 우선 제약 변경 (2026-09-11)

- 사용자 지시: 추가 지출 없이 과제 평가 기준을 충족하는 최소 범위만 진행한다. 개발 토큰도 절약한다.
- 유료 Render 배포와 Anthropic 키 준비 요청은 철회한다. 실제 AI 호출이 필요한 경우에만 교육기관 제공 OpenAI 키를 최소 사용한다.
- 평가 기준 원문과 필수 제출물을 확인했다(`ASSIGNMENT.md`). URL에서 실제 실행은 필수이며 호스팅·모델 제공사는 지정되지 않았다. 배점·마감일은 미제공이다.
- 남은 최소 범위는 OpenAI 실행 연결, 무지출 URL 배포/수용 검증, 제출용 캡처다. 12번의 유료 방식은 계속 보류하며 무료 배포 가능성을 확인한 뒤 남은 계획을 고친다.
- 2026-09-11 배포 선택 확정: **PC 없이 동작하는 무료 호스팅**(로컬 상시 실행·Cloudflare 로컬 터널 제외). 무료 호스팅·상태 보존 방식은 슬라이스 12 본문. 계획 개정 기록: `notes/handoff-minimum-submission.md`.

## 1단계 완료 (2026-09-10, `d078528`~`3ae3b89`) — 판정을 도구와 화면으로 연다

슬라이스 1~7. 샌드박스 픽스처 · 도구 5종(읽기 3 · 쓰기 2 + 승인 게이트) · 회차 기록 241개 반입과 trace 화면 ·
승인 큐 · 회차별 시간·토큰 · 앱 안의 에이전트 루프. 본문과 그때의 결정 표는 `PLAN-archive.md`.

## 2단계 — 평가 · 배포 · 공개

2026-09-10 최상위 모델 plan mode 에서 실물을 대조해 짰다.
리뷰 기록: `notes/plan-reviews/2026-09-11-stage2-5a47927d5eb8/review.md` (2026-09-11, 지적 12건).
리뷰 기록: `notes/plan-reviews/2026-09-11-stage2-211bd2d92394/review.md` (2026-09-11 개정분 12·13, 지적 8건 — 설계는 `notes/slice12-무료배포-설계.md`).

**이 계획에서 정한 것**:

| 정한 것 | 왜 |
|---|---|
| 판정 일치율을 **두 축으로 나눠** 잰다 (슬라이스 10) | 회차 기록에는 결과만 있고 그 시점의 저장소 상태가 없다 — `src/fleet/runs.mjs` 가 뽑는 것은 표 넷과 요약 줄뿐이라 `PRD.md §8` 의 "기록을 재생해 90% 일치" 를 문자 그대로 할 수 없다 |
| AI 루프의 기존 소유자 키 방식은 **보류** | 2026-09-11 변경: 평가에 필요한 경우 교육기관 제공 OpenAI 키만 최소 사용. 전환 여부는 평가 기준 확인 뒤 결정 |
| 유료 **Render 배포 철회** | 2026-09-11 변경: 추가 지출 금지. 배포 필요 여부와 무지출 제출 방식을 평가 기준으로 다시 정함 |
| 방문자별로 샌드박스를 가른다 (슬라이스 11) | 상태가 전부 `sandbox/` 아래 파일 하나씩이라(`fixture.mjs:45` · `approvals.mjs:23` · `agent/runs.mjs:16`) 둘이 동시에 열면 서로를 덮어쓴다 |

- [x] **8. 평가 세트 재생기** (2026-09-11, `notes/slice8-평가재생.md` · 검증 기록 `notes/plan-reviews/2026-09-11-stage2-5a47927d5eb8/slice-8.md` · 결과 `data/eval/scenarios.json`) — `PRD.md §9` 의 시나리오 10개를 픽스처로 재생해 기대와 대조한다(`scripts/eval.mjs`, `npm run eval`). 재생은 `observeFleet` 결과를 읽는 것이고 **판정 규칙을 새로 만들지 않는다**. 완료 기준: 시나리오별 `기대 / 실제 / 일치·불일치·재생 불가(사유)` 표가 나오고 **재생한 수와 일치 수를 그대로** 출력한다. 시나리오별 판정 시간(ms)과 합계도 같이 낸다 — `PRD.md §8` 의 "회차 소요 10초 이내" 를 잴 곳이 여기뿐이다(참고 실측: `observeFleet` 3회 연속 377·386·405ms). 결과를 `data/eval/scenarios.json` 으로도 남긴다 — 슬라이스 10의 `/eval` 화면이 읽는다(`data/usage/cycles.json` 과 같은 꼴). 두 번 돌려 결과가 같다. 실행 전후 `sandbox/fleet/` 해시가 같다(재생은 읽기다).
  - 픽스처에 이미 있는 것 여덟: 1(atlas/slice2 ready) · 2(beacon/slice2 잠든 창·미체크) · 4(atlas 4번 `[선행: 2]`) · 5(beacon max 2 로 상한) · 6(cobalt/slice5 한도, atlas/slice3 초기화 지남) · 7(cobalt 재개 2회 소진) · 8(beacon/slice3 카드 `wait`) · 10(atlas 5번 `[결정 필요]`).
  - **3(계획 미커밋 파견)은 재생한다 — 2026-09-11 검토에서 확인했다.** sp-sync 안에 있다: `sp-sync/lib/fleet.mjs:1063`(사유 문구) · `:1069`(`planDirtyBlock`, export 됨) · `:1138`·`:1212`(`dispatchPlan` 이 `planDirty` 인자로 받아 사유로 낸다). `observeFleet` 이 그 인자를 안 넘길 뿐이다(`src/fleet/source.mjs:126~136`). "규칙 밖" 으로 넘기지 않는다.
    - 함정: `planDirty` 는 그 프로젝트의 **새 파견을 전부** 막는다 — 시나리오 4·5·10 과 같은 관찰에 섞으면 그 셋이 같이 죽는다. 별도 관찰 패스로 잰다.
  - 함정: **시나리오 8(카드 `wait`)의 판정 재료는 워크스페이스 상태가 아니다.** `landCheck` 는 카드를 실제 홈에서만 읽어(`sp-sync/lib/fleet.mjs:2526` `cardForWorkspace`, 주입 구멍 없음) 픽스처 카드가 안 붙는다 — 실측으로 beacon/slice3 의 `state` 는 `busy`("턴 진행 중")이고 `counts.waiting` 은 세 프로젝트 모두 0이다. 카드 `wait` 는 `resume[].action === 'wait'` 와 `cards[]` 에만 나온다. 상태를 대조하면 8번이 헛되이 불일치가 되고, 그걸 맞추려 픽스처나 판정 규칙을 고치면 `PRD.md §7` 을 어긴다.
  - 함정: 9(충돌 2회 실패)는 **픽스처로 지어내지 않는다.** `src/fleet/execute.mjs:321~328` 이 이미 "샌드박스에는 워커 세션이 없어 해소를 시도하지 않는다" 로 적어 뒀다 — 회차 기록으로 보여주는 데까지다.

- [x] **9. 세팅 비교 실험** (2026-09-11, `notes/slice9-세팅비교.md` · 검증 기록 `notes/plan-reviews/2026-09-11-stage2-5a47927d5eb8/slice-9.md` · 결과 `data/eval/settings.json`) — 동시 상한(2/3/5)·재개 상한(1/2/3)을 바꿔 슬라이스 8의 재생을 반복한다. `observeFleet` 에 `caps`·`resumeMax` 옵션을 연다(`src/fleet/source.mjs:118`, 지금은 동시 상한이 `fx.max(project)`·재개 상한이 상수 `RESUME_MAX` 로 고정이다). 완료 기준: 조합별 표(파견 자격 수 · 보류 사유 분포 · 재개 갈래 분포 · 사람 호출 수)가 나오고, 상한 2→5 에서 `cap-project` 보류가 줄고 자격이 느는 것이, 재개 상한 1→3 에서 cobalt/slice5 의 갈래가 바뀌는 것이 **수로 보인다**.
  - 사유는 `holdOf` 코드로 세되 `other` 로 떨어진 것은 **문장을 그대로** 표에 남긴다. 조합별 결과를 `data/eval/settings.json` 으로도 남긴다 — 슬라이스 10의 `/eval` 화면이 읽는다.
  - **표본이 작다 (2026-09-11 실측).** 지금 픽스처 전체에서 `cap-project` 는 **한 줄**(beacon 5번)뿐이라 동시 상한 2/3/5 sweep 은 `cap-project` 1 → 0 → 0 이 된다. 수가 안 는다고 픽스처를 늘리지 않는다 — 늘리면 슬라이스 8의 시나리오 표본이 같이 바뀐다. 표본 수를 그대로 적는다. 재개 상한 1/2/3 은 cobalt/slice5 가 `exhausted` → `exhausted` → `resume`(3/3) 으로 갈린다.
  - **함정: 재개 상한 1 은 슬라이스 8의 시나리오 8 근거를 지운다.** 그 세팅에서 beacon/slice3 이 `wait` 가 아니라 `exhausted`("재개 1회 실패")가 된다(실측). 시나리오 일치표는 **기준 세팅(재개 상한 2)** 에서만 판정하고, 여기서는 갈래가 바뀐 사실만 적는다.
  - 에이전트 조합(단일 / 2종)은 픽스처 정의를 바꿔야 하므로 이번엔 **지금 픽스처가 이미 섞어 쓰는 두 종**(codex 헤드리스 · claude TUI)의 갈래 차이를 내는 데까지만 한다.

- [x] **10. `EVAL.md` — 일치율·헛호출·실패 사례 분류** (2026-09-11, `EVAL.md` · 노트 `notes/slice10-평가정리.md` · 검증 기록 `notes/plan-reviews/2026-09-11-stage2-5a47927d5eb8/slice-10.md` · 결과 `data/eval/coverage.json`·`data/eval/incidents.json`) — `PRD.md §8` 을 실제로 잰 수로 채운다. 판정 일치율은 두 축으로 나눠 잰다: **(가) 시나리오 재생 일치율**(슬라이스 8의 수) · **(나) 사유 분류 커버리지**(반입한 241회차의 사유 문장이 코드로 분류되는 비율). **축을 둘로 나눈다 — `workspaceState` 는 문장을 못 받는다**(`src/fleet/source.mjs:60~65` 는 `{ready, blocked, waiting}` 깃발을 읽는다): 파견·결정 필요 사유는 `holdOf`, 착륙 막힘 사유는 별도 분류표. 왜 그렇게 나눴는지를 `EVAL.md` 머리에 적는다. 완료 기준: 네 표(시나리오 일치 · 세팅 비교 · 사유 커버리지 · 사고 분류)와 표본 수가 있고, `PRD.md §8` 다섯 기준 각각에 현재 값이 적혀 있다. **`/eval` 화면이 그 네 표를 보여준다** — `PRD.md §6` 화면 표가 `/eval` 에 "세팅별 비교표, 실패 사례" 를 두기로 했는데 지금 페이지는 비용·시간뿐이고, 주석(`web/app/eval/page.js` 머리말)이 그 둘을 이 단계로 미뤄 뒀다. `ANONYMIZATION.md §4` 스캔 0건.
  - 헛호출률: 회차 기록의 "결정 필요" 항목을 사후 분류한다(진짜 사람 판단이 필요했나).
  - **표본 수와 열 이름은 이미 실측돼 있다 (2026-09-11).** 241회차의 표 넷: 착륙 70(`결과`·`비고`) · 파견 127(`결과`·`지시` — 마지막 칸은 사유가 아니다) · 막힘 20(`이유`) · 결정 필요 328(`무엇`·`내용`). `holdOf` 를 그대로 먹이면 막힘 20/20 이 `other`(100%)이고 결정 필요는 `other` 202(61.6%) · `limit-hold` 83 · `decision` 43 이다 — `HOLD_CODES` 가 **파견 보류** 사유 접두어만 담고 있어서다. 착륙 막힘 사유용 분류표를 따로 두되 **판정 규칙은 건드리지 않는다**(`holdOf` 와 같은 자리 — 문장 → 코드 라벨일 뿐이다).
  - 함정: 사고 사례는 운영 저장소의 규칙 근거 노트에 있고 그 표는 **29행**이다(2026-09-11 실측, 최대 번호 29). 다만 **29 = 사고 수가 아니다** — 최소 3행이 "사용자 결정" 이고 몇 행은 점검 결과·기능 설명이다. 표 행 수와 그중 사고 건수를 **둘 다** 적는다.
  - **선행 준비물: 익명화 설정 파일이 지금 저장소에 없다.** 있는 것은 `anonymize-map.local.md` 하나이고, 반입 스크립트가 읽는 `anonymize.local.json`(`scripts/import-runs.mjs:32`)은 없다 — `ANONYMIZATION.md §5` 대로 설정이 없으면 스크립트가 아무것도 반입하지 않고 멈춘다. 매핑 파일의 제외·치환 표에서 만들되, 판단이 갈리면 그 시점에 카드 `wait` 로 요청하고 멈춘다. **익명화가 여기서 또 필요하다**(코드·회차 기록에 이은 세 번째): 제외 목록 프로젝트의 사고는 통째로 빼고 남는 것만 `project-a` 형식으로.

- [x] **11. 데모 모드 — 방문자 격리·초기화·실행 상한** [어려움] (2026-09-11, `notes/slice11-데모격리.md` · 검증 기록 `notes/plan-reviews/2026-09-11-stage2-5a47927d5eb8/slice-11.md`) — 방문자 둘이 동시에 열어도 서로의 승인 큐와 픽스처를 바꾸지 않게 하고, AI 루프에 상한을 건다. 완료 기준: 브라우저 둘(다른 쿠키)로 각각 파견 승인·착륙을 해도 큐와 픽스처가 안 섞인다. 되돌리기 버튼으로 픽스처가 처음 상태로 돌아온다. 상한 소진 뒤 실행 버튼이 **사유와 함께** 막히고 저장된 실행은 계속 열린다.
  - 격리는 상태 루트 하나로 묶어 **환경변수로** 연다(기본값은 지금 경로) — `scripts/fixture.mjs:45`(`ROOT`, 46~49의 파생 넷도 같이) · `src/fleet/approvals.mjs:23`(`QUEUE_FILE`) · `src/agent/runs.mjs:16`(`RUNS_DIR`). 셋 다 모듈 최상위 const 가 `REPO` 에서 파생된다. **함수 인자로만 열면 슬라이스 12가 이걸 다시 고친다** — 12의 "재시작해도 큐와 실행 기록이 남는다" 는 루트가 마운트한 디스크를 가리켜야 만족된다. sp-sync 의 경로 계산은 `workspacesDirOf(root, home)` 라 루트만 갈면 그대로 맞는다(`scripts/fixture.mjs` 머리말).
  - **먼저 픽스처 한 벌 생성 시간을 잰다.** git init 셋 + worktree 라 첫 방문이 느려질 수 있다 — **3초를 넘으면 방문자별 격리를 포기하고 공용 샌드박스 하나 + 되돌리기 버튼**으로 물러선다. 그 판단과 실측치를 노트에 적는다.
    - **무엇으로 재는지**: `node scripts/fixture.mjs` + `node scripts/fixture-runs.mjs` 의 단독 시간이다. `npm run fixture` 로 재면 npm 기동 두 번이 얹혀 게이트를 헛되이 넘긴다 — 2026-09-11 실측(Windows, warm) `npm run fixture` **8.58초** 대 스크립트 단독 **2.83 + 0.38 = 3.21초**. 게이트 판정은 **리눅스 컨테이너 안에서** 잰 값으로 한다(슬라이스 12의 이미지가 서면 거기서, 그 전이면 이 판단을 12로 미룬다).
  - 상한은 서버가 건다: 키는 환경변수(`ANTHROPIC_API_KEY`), 하루 실행 횟수와 1회 비용 상한(`DEFAULT_LIMITS.maxUsd`, `src/agent/loop.mjs:38`). 한 실행이 4~6턴 · $0.05~0.10 이다.

- [x] **14. 에이전트 루프를 OpenAI 호출로 전환** (2026-09-11, `notes/slice14-openai.md`) — `src/agent/loop.mjs` 의 Claude Agent SDK `query()` 를 전역 `fetch` 로 OpenAI Chat Completions(function calling)를 부르는 직접 루프로 바꾼다. `openai` 패키지는 넣지 않는다. 모델 `FLEET_AGENT_MODEL`(기본 `gpt-4.1-mini`) · 키 `OPENAI_API_KEY` · 주소 `OPENAI_BASE_URL`(기본 `https://api.openai.com/v1`) 전부 환경변수. 완료 기준: (1) `node scripts/agent-check.mjs --fake` 가 기존 7항목을 **네트워크·키 없이** 통과한다. (2) `npm run check` · `npm test` 통과. (3) 실제 키로 `npm run agent:check` **1회** 통과 — 실행 기록 하나에 `messages`·usage·costUsd 가 남고 `/agent/<id>` 에 시간·토큰·비용이 보인다. (4) 코드·설정에 `@anthropic-ai` 참조가 남지 않는다(노트 제외).
  - 도구 정의: `TOOLS`(`src/fleet/tools.mjs:157`)의 `schema` + `reason` 필드를 `z.toJSONSchema(z.object(…))`(zod 4, 확인됨)로 function 파라미터로. 이름은 `fleet_status` 그대로 — `mcp__fleet__` 접두사(`PREFIX`)와 그 검사·deny 문구는 이름 기준으로 바꾼다. 도구 실행 핸들러(현재 `fleetTools` 콜백 82~103행: call/result step · approval 기록 · 오류 재시도 없음)는 한 함수로 뽑아 그대로 쓴다.
  - 세션 보존: `run.messages`(system · user · assistant(tool_calls) · tool)를 실행 기록에 넣고 매 응답·도구 결과 뒤 `writeRun`. `resumeRun` 은 `messages` 에 user 프롬프트를 덧붙여 같은 루프를 돈다(`resume`·`sessionId` 인자 제거). 다른 프로세스 재개는 파일만 있으면 된다.
  - 승인 게이트: `canUseTool` 대신 도구 실행 직전에 같은 두 검사(모르는 도구 · `run.approval` 이 pending)를 하고 거부 사유를 **도구 결과 텍스트**로 돌려준다(step `deny` 유지). pending 뒤 모델이 도구 없이 답하면 구간 종료 → `waiting`. 상태 판정(191~210행)은 `subtype` 문자열(`success`/`error_max_turns`/`error_max_budget_usd`)을 그대로 내서 유지한다.
  - 상한: 반복 = 모델 호출 수 ≥ `maxTurns`; 시간 = `AbortController` 를 fetch 에; 비용 = 응답 `usage` × 단가 누적(`FLEET_PRICE_USD_PER_M`, 기본 `0.40,0.10,1.60` = gpt-4.1-mini 입력/캐시/출력 공식가 2026-09-11). `leg.usage` 4필드 매핑: `prompt_tokens`−`cached_tokens` → input · `cached_tokens` → cacheRead · cacheWrite 0 · `completion_tokens` → output — 화면 `web/app/agent/[id]/page.js:140` 은 손대지 않는다.
  - HTTP 실패: 4xx/5xx·네트워크 오류는 재시도 없이 `failed`, 응답 본문 앞 200자를 `stop.reason` 에(`PRD.md §4`).
  - 가짜 모델: `FLEET_AGENT_FAKE=1` 이면 `src/agent/fake-model.mjs` 의 결정적 응답(status → slices → 쓰기 도구 하나 → pending 이면 도구 없이 보고 · 재개 프롬프트에 "승인" 이 있으면 같은 인자 재호출 → 보고 · 프롬프트에 "끝없이" 가 있으면 읽기 도구만 계속 불러 반복 상한 시험). `scripts/demo-check.mjs:12` 는 `OPENAI_API_KEY='test-no-network'` 로.
  - 정리: `package.json` 에서 `@anthropic-ai/claude-agent-sdk` 제거(`npm install` 로 lock 갱신, 이미지에 Claude Code 실행 파일 불필요). 문구·설정: `.env.example`(키 셋) · `README.md:49,51,62,106,107` · `render.yaml` 키 이름 · `src/demo.mjs:73` · `scripts/agent-check.mjs:19` · `web/app/agent/page.js:39`.
  - 실제 키: 로컬 `.env`(커밋 안 함, `node --env-file=.env`)에 사용자가 넣는다. 없으면 가짜 검증까지 끝내고 **카드 `wait` 로 ".env 에 OPENAI_API_KEY 를 넣어 달라" 요청 후 멈춘다** — 키 값을 채팅에 요구하지 않는다. 실측(시간·토큰·비용·턴)은 `notes/slice14-openai.md` 에 새 모델 값으로, `EVAL.md` 의 옛 Claude 실측은 "Claude 시절" 로 구분만 하고 지우지 않는다.
  - 함정: 교육기관 키가 `gpt-4.1-mini` 를 못 쓰거나 다른 base URL 을 요구할 수 있다 — 코드 수정 없이 환경변수로. 모델이 `tool_calls` 를 여러 개 한 번에 낼 수 있다 — 순서대로 실행하고 pending 이후 것은 게이트가 거부한다.
- [x] **12. 무료 URL 배포 — Render Free + GitHub 스냅샷으로 상태 보존** (2026-09-14, `fleet-console-d7c5.onrender.com`) [어려움] [선행: 14] — 2026-09-11 배포 선택 확정(PC 없이 무료 호스팅, 지출 0). 호스팅은 Render Free Docker, 상태는 비공개 GitHub 저장소의 tar.gz 한 파일(`scripts/state-sync.mjs` restore/watch). 후보 비교·설계·엔트리포인트 순서·준비물 요청 시점·함정: `notes/slice12-무료배포-설계.md`. **앱 코드(`src/`)는 손대지 않는다.**
  - 완료 기준 1: `scripts/container-check.mjs` seed → 컨테이너 **삭제 후 새로 생성**(볼륨 없음, `dir` 백엔드) → verify 통과 — 큐·실행 기록·오늘 실행 횟수가 돌아오고 `running` 이던 실행이 `interrupted` 로 보인다.
  - 완료 기준 2: 배포 링크로 `/` `/runs` `/approvals` `/eval` `/agent` 가 뜨고, `/agent` 에서 실행 → 승인 대기 → 승인 → 착륙이 **실제 OpenAI 호출로** 끝난다. 승인 대기 중인 실행을 남긴 채 Render 수동 재배포(또는 15분 방치 후 재접속) 뒤 그 실행·큐·오늘 실행 횟수가 남아 있고 이어서 끝난다.
  - 완료 기준 3: 절전 첫 접속 시간과 첫 방문 픽스처 생성 시간(슬라이스 11 의 3초 게이트 마지막 판정)을 실측해 `README.md` 에 적고, Render 요금 화면·OpenAI 사용량으로 지출 0 을 확인해 `notes/slice12-컨테이너배포.md` 에 이어 적는다.
  - **2026-09-14 배포 검증**: 완료 기준 1·2 **PASS**, 3은 실측 둘 끝나고 **지출 확인만 남았다**(Render 요금 청구 화면·OpenAI 사용량은
    소유자만 볼 수 있다). 서비스 `fleet-console-d7c5.onrender.com`. 절전 첫 접속 52.3초 · 첫 방문 3.3~4.0초 · 실행 1회 $0.0033.
    3초 게이트는 넘었으나 격리 유지로 결정했다(`notes/slice11-데모격리.md`). 상세: `notes/slice12-컨테이너배포.md` 4차 절.
  - 인계 메모 (2026-09-11, 워크트리 `slice12`): **한 것** — `scripts/state-sync.mjs`(restore/watch, github·dir) · 엔트리포인트 순서 · `render.yaml` Free · 완료 기준 1 PASS(`scripts/container-recreate-check.sh`) · 가짜 GitHub API 검사 · check/test 통과 (`notes/slice12-컨테이너배포.md` 2차 절, `notes/plan-reviews/2026-09-11-stage2-211bd2d92394/slice-12.md`). **남은 것** — 완료 기준 2·3(Render 배포·실제 OpenAI 흐름·재배포 보존·절전/첫 방문 실측·지출 0 확인, README 실측 칸). **막힌 것** — 사용자 준비물: Render 가입 · 상태용 비공개 저장소 + Contents 쓰기 토큰 · Render 비밀 환경변수 3개. 카드 `wait` 로 요청함.
  - 2026-09-14: 준비물은 아직 시작 전(사용자 확인). 대기 중 `state-sync.mjs preflight`(실제 토큰 왕복 확인, 스냅샷 불변)와 `README.md` 의 "Render 배포 절차" 6단계를 붙였다 — 3차 절, `notes/slice12-컨테이너배포.md`.
  - 2026-09-14: 준비물 ①② 완료 — 상태 저장소 `ibiseolsin/fleet-console-state` + Contents 쓰기 토큰으로 `preflight` 2회 실측 통과. 이 저장소 origin 도 `ibiseolsin/Fleet-Console` 로 옮겼다. **남은 준비물은 Render 가입과 비밀 환경변수 셋뿐이다.**

- [ ] **13. 수용 기준 재확인 · 제출물 · 공개 전환 준비** [선행: 12] — **진행 중 (2026-09-14)**: 완료 기준 1의 `EVAL.md` 배포본 표와
  완료 기준 2(README 실행법·URL·캡처 5장 `docs/captures/`, `ASSIGNMENT.md` 결과 갱신)는 끝났다. 완료 기준 3의 검수 결과는
  `notes/slice13-공개검수.md`. 1차 검수에서 막혔던 셋은 소유자 결정으로 닫혔다 — `project-a`·`project-b` **통째로 제외**
  (회차 241 → 185), `Orca`·`sp-sync` 는 **이름으로 보고 그대로 둔다**. `§4` 스캔 **0건**(파일 이름까지).
  남은 것: 휴대폰 확인(사람) · 푸시 후 재배포 · §0 승인(사람). **공개 전환·제출은 사람이 한다.** — 배포본을 다른 기기에서 검증하고 제출물을 모은 뒤 `ANONYMIZATION.md §0` 의 승인을 **카드 `wait` 로 요청하고 멈춘다**(체크는 사용자 승인 뒤). `§4` 스캔은 금칙어 grep 이라 외부 서비스·업체 이름과 개인 생활 맥락은 못 잡는다 — 스캔 0건과 공개해도 되는 것은 다른 문제다. **저장소 공개 전환과 제출 폼 제출은 사람이 한다.**
  - 완료 기준 1: 휴대폰 브라우저에서 배포 링크만으로 실행 → 승인 → 착륙 → 이어서 끝내기 성공 기록, `PRD.md §8` 다섯 기준을 배포본에서 다시 잰 `EVAL.md` **새 표**(옛 Claude 실측은 "Claude 시절" 로 남긴다).
  - 완료 기준 2: `README.md` 에 실행법(로컬 `.env` 키 셋 · Render 환경변수 · 상태 저장소) · 서비스 URL · 캡처(`docs/captures/`: 실행 trace · 승인 화면 · 착륙 결과 · 사용량), `ASSIGNMENT.md` 의 "남은 것" 열을 결과로 갱신.
  - 완료 기준 3: `notes/slice13-공개검수.md` 에 `§0` 제출물 셋(스캔 결과 0건 · 지난 승인 이후 새 파일 목록 · 외부에서 들여온 것) + 넷째(반입한 `결정 필요` 328행의 `무엇`·`내용` 자유문장을 사람이 훑은 결과, 기존 23파일 156줄 패턴 일치 목록 포함)가 있고 카드 `wait` 가 떠 있다.

## 메모

- **2026-09-11 배포 선택 확정**: PC 없이 무료 호스팅. 로컬 상시 실행·Cloudflare 로컬 터널 제외, 추가 지출 금지 유지. 12·13 의 `[결정 필요]` 는 뗐다 — 익명화 검수·계정 준비는 그 시점의 카드 `wait` 다. 파일 순서 = 실행 순서(14 → 12 → 13).
- 14 의 `agent:check --fake` 는 `npm run check` 에 넣지 않는다(프로세스 spawn·`~/.sp-sync` 격리 검사라 느리다) — 루프를 만진 슬라이스만 돌린다. 12·13 의 실제 OpenAI 호출은 대표 실행 각 1~2회.

- **병렬 태그는 하나도 붙이지 않았다** — 8~10 이 같은 재생기를, 11~12 가 같은 앱·이미지를 만진다. 착륙이 번호 순으로 하나씩 머지한다.
- `[어려움]`(최상위 모델)은 11·12 둘. 11은 sp-sync 경로 계산 위에서 상태를 가르는 판단이고, 12는 처음 하는 배포다.
- **익명화는 이번이 세 번째다** — 코드(슬라이스 1) · 회차 기록(슬라이스 5) · 사고 사례(슬라이스 10).
- **`~/.sp-sync/config.json` 의 `fleetChecks` 에 이 프로젝트의 검사 명령을 넣는다.** 없으면 착륙이 검사 없이 머지한다.
- **어떤 슬라이스도 `git push` 로 끝나지 않는다.** 푸시는 착륙 스크립트가 한다.
- **로컬 웹 앱을 띄워 확인하는 슬라이스(11·12)는 쓰기 동작 전에 대상을 확인한다** — `127.0.0.1` + 배정 포트를 명시하고, 포트 소유 PID·명령과 실행한 워크트리의 경로·브랜치·HEAD 가 대상과 맞는지 본다(`~/orca/CLAUDE.md` "로컬 웹 앱 조작 전 식별").
- 슬라이스마다 도는 검사: `npm run check`(다섯) · `npm test`(455/455) · `ANONYMIZATION.md §4` 스캔. `npm run agent:check` 는 모델을 부르고 돈이 들어 `check` 에 없다 — 루프를 만진 슬라이스에서만 돌린다.

## 토큰 예산 — 구현 세션이 지킬 것

**2단계 목표: nonRead 1.2M 이하 (슬라이스당 200k 안팎), 6~9 세션. 2026-09-11 개정으로 14·12·13 세 세션 추가, 슬라이스당 200k 유지.**

1단계와 같은 넷을 지킨다 (근거는 `PLAN-archive.md`. 요지: total 의 96%가 캐시 재청구라, 세션이 같은 컨텍스트를 매 턴 다시 읽는 것이 비용의 거의 전부다).

1. **큰 파일을 통째로 읽지 않는다.** 벤더링한 오케스트레이터 본체가 4554줄(약 60k)이다 — 필요한 것은 export 목록과 시그니처뿐이라 `grep -n "^export\|^function"` 으로 본다. 반입한 회차 기록 241개도 마찬가지다.
2. **대량 치환·집계는 스크립트로 한다.** 슬라이스 10의 사유 분류는 파일을 컨텍스트에 올리는 것이 아니라 스크립트가 세고 요약만 본다.
3. **슬라이스마다 새 세션.** 시작 프롬프트는 고정 — "PRD.md, PLAN.md 읽고 슬라이스 N 진행. 끝나면 PLAN.md 체크하고 커밋."
4. **테스트는 실패한 것만 본다.** 455개 통과 출력을 통째로 올리지 않는다.
