# PLAN 리뷰 2026-09-11-stage2-5a47927d5eb8

프로젝트/단계/슬라이스: Fleet-Console / 2단계 (평가·배포·공개) / 8~13
리뷰 전 기준: HEAD `3ae3b89` · `PLAN.md` 미커밋 변경 있음 (41+/44-), `PLAN-archive.md` 미추적
모델·reasoning·provider: Opus 5 (1M context, `claude-opus-5[1m]`) · Anthropic — **최상위(Fable 5.1)가 아니다**
세션/usage 원천: Claude Code 세션 `a1849e73-2ab8-4227-81b8-5a47927d5eb8` · JSONL `~/.claude/projects/C--Users-----orca-projects-Fleet-Console/<세션>.jsonl`
측정 구간: 세션 시작 ~ 커밋 직전 / coverage: partial (마지막 답변은 아직 로그에 없다 — 하한값)
토큰: input_total=6093985 cache_read=5944560 cache_write=149327 output_total=53267 reasoning=미제공 total=6147252 non_cache_read=202692
자식 비용: 없음 (서브에이전트를 띄우지 않았다)

## 지적

| id | 슬라이스/검증 담당 | 잘못된 전제와 실패 조건 | 근거 | 반영한 수정 |
|---|---|---|---|---|
| R1 | 10 | "막힘·결정 필요 사유 문장을 `holdOf`·`workspaceState` 에 넣어 `other` 비율을 잰다". `workspaceState(check)` 는 문장이 아니라 `{ready, blocked, waiting}` 깃발을 읽는 함수라 문장을 주면 늘 `busy` 를 돌려주고 `other` 갈래 자체가 없다. 그대로 구현하면 (나) 축의 절반이 상수가 된다 | `src/fleet/source.mjs:60~65`(`workspaceState`) · `:44~49`(`holdOf`) · `:28~40`(`HOLD_CODES` 는 전부 **파견 보류** 사유 접두어). 실측(반입 241회차 전수): 막힘 20행 → `other` 20/20(100%), 결정 필요 328행 → `other` 202(61.6%)·`limit-hold` 83·`decision` 43, 파견 127행의 마지막 칸은 사유가 아니라 지시(`/slice N`) | (나) 축을 **파견·결정 필요 사유(`holdOf`)** 와 **착륙 막힘 사유(별도 분류표)** 로 나누고, 표에 열 이름과 표본 수(착륙 70·파견 127·막힘 20·결정 필요 328)를 적게 했다 |
| R2 | 8 | "시나리오 3(계획 미커밋 파견)은 sp-sync 의 판정이 아니라 파견 스크립트 밖 게이트일 수 있다 → 없으면 '규칙 밖' 으로 기록". 실제로는 sp-sync 안에 있고 픽스처로 재생 가능하다. 그대로 두면 재생 가능한 시나리오 하나가 근거 없이 표본에서 빠진다 | `sp-sync/lib/fleet.mjs:1063`(문구 상수) · `:1069~1075`(`planDirtyBlock`, export 됨) · `:1138`(`dispatchPlan({ planDirty })`) · `:1211~1215`(사유로 냄). `observeFleet` 이 그 인자를 안 넘길 뿐이다 — `src/fleet/source.mjs:126~136`. 실행 확인: `fleet dispatch Fleet-Console --dry-run` 이 미체크 6개 전부에 그 사유를 냈다 | "규칙 밖" 갈래를 지우고 재생하도록 고쳤다. planDirty 는 그 프로젝트의 새 파견을 **전부** 막으므로 시나리오 4·5·10 과 같은 관찰에 섞지 말고 별도 패스로 재라고 적었다 |
| R3 | 8 | "픽스처에 이미 있는 것 여덟 … 8(beacon/slice3 카드 `wait`)" — 있기는 하나 **워크스페이스 상태로는 안 나온다.** 재생기가 워크스페이스 상태를 대조하면 시나리오 8이 불일치로 떨어지고, 워커가 픽스처나 판정 규칙을 건드리게 된다(`PRD.md §7` 금지) | `landCheck` 가 카드를 실제 홈에서만 읽는다 — `sp-sync/lib/fleet.mjs:2526`(`cardForWorkspace`), 주입 구멍 없음. `scripts/fixture.mjs:27~29` 가 이미 "픽스처에는 어떤 카드도 안 붙는다" 고 적어 뒀다. 실측 `observeFleet`: beacon/slice3 `state=busy`("턴 진행 중"), `counts.waiting` 이 세 프로젝트 모두 0. 카드 `wait` 는 `resume[].action==='wait'` 와 `cards[]` 에만 나온다 | 시나리오 8의 판정 재료를 재개 갈래·`cards[]` 로 못 박았다 |
| R4 | 9 | "재개 상한 1→3 에서 cobalt/slice5 의 갈래가 바뀐다" 는 맞지만, 같은 sweep 이 **슬라이스 8의 시나리오 8 근거를 지운다** — 재개 상한 1에서 beacon/slice3 이 `wait` 가 아니라 `exhausted` 가 된다. 시나리오 표를 세팅마다 다시 판정하면 일치율이 세팅 탓에 흔들린다 | 실행 확인(`resumePlan` 에 max 1/2/3 을 직접 넘겨 실측): max=1 → beacon/slice3 `exhausted`("재개 1회 실패 — claude 5시간 한도"), max=2·3 → `wait`. cobalt/slice5 는 `exhausted`→`exhausted`→`resume`(3/3) | 시나리오 일치표는 **기준 세팅(재개 상한 2)** 에서만 판정하고, sweep 은 갈래 변화로만 적게 했다 |
| R5 | 9 | "상한 2→5 에서 `cap-project` 보류가 줄고 자격이 느는 것이 수로 보인다" — 지금 픽스처 전체에서 `cap-project` 는 **한 줄**(beacon 5번)뿐이라 sweep 은 1 → 0 → 0 이다. 수가 안 는다고 워커가 픽스처를 늘리면 시나리오 표본이 바뀐다 | 실측 `observeFleet` 파견 판정 전수: atlas 2·3 `running`, 4 `deps-undone`, 5 `decision` / beacon 4 자격 있음, 5 `cap-project` / cobalt 2 자격 있음, 3 `plan-error`, 4 `solo`. `cap-project` 총 1건 | 표본 수를 그대로 적고 픽스처를 늘리지 말라고 적었다 |
| R6 | 8, 9, 10 | `PRD.md §6` 화면 표는 `/eval` 이 "회차별 시간·토큰·비용, **세팅별 비교표, 실패 사례**" 를 담는다고 정했는데, 지금 페이지는 비용·시간뿐이고 코드 주석이 그 둘을 "슬라이스 8의 몫" 으로 미뤄 뒀다. 2단계 어느 슬라이스도 화면에 안 붙인다 — 슬라이스 12의 "`/eval` 이 뜬다" 로는 안 잡혀 MVP 화면 하나가 빈 채로 공개된다 | `web/app/eval/page.js:1~10`(머리 주석 "세팅별 비교표와 실패 사례 분류는 슬라이스 8(평가 세트 재생)의 몫이라 여기 없다") · `PRD.md §6` 화면 표 | 슬라이스 8·9가 결과를 `data/eval/*.json` 으로도 남기고(화면이 읽는 자리는 `data/usage/cycles.json` 과 같은 꼴), 슬라이스 10의 완료 기준에 "`/eval` 이 네 표를 보여준다" 를 넣었다 |
| R7 | 8 | `PRD.md §8` 다섯 기준 중 "회차 소요 10초 이내 — 재생 시간 측정" 의 재료를 **아무 슬라이스도 안 낸다.** 슬라이스 10이 "다섯 기준 각각에 현재 값" 을 요구하는데 그 값을 만들 곳이 없다 | `PLAN.md` 슬라이스 8 완료 기준에 시간 출력 없음. 참고 실측: `observeFleet` 3회 연속 377·386·405ms (Windows) | 슬라이스 8 완료 기준에 시나리오별 판정 시간(ms)과 합계 출력을 넣었다 |
| R8 | 11 | "3초를 넘으면 방문자별 격리를 포기한다" 는 게이트는 좋은데 **무엇으로 재는지가 없다.** `npm run fixture` 로 재면 npm 기동 두 번이 얹혀 게이트를 헛되이 넘긴다 | 실측(Windows, warm): `npm run fixture` 8.58초 · `node scripts/fixture.mjs` 단독 2.83초 · `node scripts/fixture-runs.mjs` 0.38초 (합 3.21초) | 게이트를 스크립트 단독 시간으로, 그리고 **리눅스 컨테이너 안에서** 재라고 못 박았다 |
| R9 | 11 | "격리는 상태 루트 하나로 묶어 파라미터화한다" — 함수 인자로만 열면 슬라이스 12의 "컨테이너를 재시작해도 승인 큐와 실행 기록이 남는다" 를 못 만족해 12가 11을 다시 고친다. 셋 다 모듈 최상위 const 가 `REPO` 에서 파생된다 | `scripts/fixture.mjs:45`(그리고 46~49의 파생 넷) · `src/fleet/approvals.mjs:23` · `src/agent/runs.mjs:16` — 셋 다 `join(REPO, 'sandbox', …)`. `.gitignore` 가 `sandbox/` 를 무시하므로 이미지 안에서는 부팅 때 생긴다 | 상태 루트를 **환경변수**로 열고 기본값을 지금 경로로 두게 했다 (슬라이스 12가 마운트한 디스크를 가리킨다) |
| R10 | 10 | "사고 사례는 … 29건이다" — 표가 29행인 것은 맞지만 **전부 사고는 아니다.** 최소 3행이 "사용자 결정", 몇 행은 점검 결과·기능 설명이다. 29를 사고 수로 적으면 `EVAL.md` 의 표본 수가 틀린다 | 실측: `~/orca/projects/coordinator/notes/규칙-근거.md` 의 `\| N \|` 행 29개(최대 N=29), 그중 `사용자 결정` 으로 시작하는 행 3개 | "표는 29행이고 그중 사고가 몇 건인지 분류해 두 수를 적는다" 로 고쳤다 |
| R11 | 10 | 사고 사례 반입에 필요한 익명화 설정 파일이 **지금 저장소에 없다.** 반입 스크립트는 설정이 없으면 아무것도 반입하지 않고 멈춘다 — 워커가 세션 하나를 여기서 태운다 | 저장소에 있는 로컬 파일은 `anonymize-map.local.md` 하나뿐(`ls anonymize*`). `scripts/import-runs.mjs:32` 는 `anonymize.local.json` 을 읽고, `ANONYMIZATION.md §5` 가 "설정이 없으면 아무것도 반입하지 않고 멈춘다" 고 적어 뒀다 | 슬라이스 10 본문에 선행 준비물로 적고, 없으면 그 시점에 카드 `wait` 로 요청하고 멈추라고 했다 |
| R12 | 13 | `§4` 스캔은 매핑 파일의 **금칙어 grep** 이라 외부 서비스·업체 이름과 개인 생활 맥락은 못 잡는다. 반입한 `결정 필요` 328행의 `무엇`·`내용` 열에 그런 문자열이 남아 있다. 스캔 0건을 통과해도 공개는 되돌릴 수 없다 | `ANONYMIZATION.md §4`(패턴 grep) · `anonymize-map.local.md` 의 치환·제외 표에 그 부류가 없음 · 실측: `data/runs/` 의 `결정 필요` 표 328행 `무엇` 열의 서로 다른 값 55종 중 다수가 사람이 읽는 자유 문장이다 (값은 여기 옮기지 않는다 — `ANONYMIZATION.md` 머리말) | 슬라이스 13 제출물에 "그 두 열을 사람이 훑는다" 를 넣었다 |

## 기계 검사

- `fleet slices Fleet-Console`: 8~13 전부 읽힘, 모르는 태그 0, 번호 없는 슬라이스 0. `어려움` 11·12, `결정 필요: 익명화 검수` 13.
- `fleet dispatch Fleet-Console --dry-run`: 6개 전부 "PLAN.md 미커밋 변경 — 커밋(`/plan-review`)이 파견 신호" 로 보류. 커밋하면 다음 회차에 **8번**이 뜬다(활성 0 · 상한 3 · 전역 2/4).
- `fleet pause`: Fleet-Console 은 목록에 없다 — resume 이 필요 없다.
- 번호: 1단계 1~7 은 `PLAN-archive.md` 로 접혔고 2단계는 8부터. 재사용 없음.

## 토큰 실측

`references/review-metrics.md` 의 Claude JSONL 공식으로 커밋 직전에 잰 값. `coverage: partial`.

- 응답 49개(`(session id, message.id)` 로 합침) · 마지막 usage 시각 2026-09-10T15:52:31Z (= 2026-09-11 00:52 KST).
- `input_total = input + cache_creation + cache_read`, `total = input_total + output`, `non_cache_read = total - cache_read`.
- 이 세션은 리뷰 전용이라 세션 전체를 리뷰 비용으로 본다. `reasoning` 은 Claude JSONL 에 별도 값이 없어 **미제공**이다(0 이 아니다).
- 커밋과 이 문단 뒤의 마지막 답변은 아직 로그에 없다 — **하한값**이다. 다음 정리 세션이 종료된 로그로 `complete` 합계를 확정한다.
