# 2026-09-11-stage2-5a47927d5eb8 — slice 10 검증

구현 세션: Claude Code, Opus 5 (1M context, `claude-opus-5[1m]`) · 워크스페이스 `slice10` · 기준 HEAD `a8860bd`.
자기 담당 지적만 확인했다 (R1 · R10 · R11, 그리고 R6 중 슬라이스 10 몫). `review.md` 와 다른 워커 파일은 고치지 않았다.

| id | 결과 분류 | 변경 전 증거 | 변경 후 증거 | 코드 상태/비고 |
|---|---|---|---|---|
| R1 | 실행 확인 | 계획대로 사유 문장을 `workspaceState`·`holdOf` 에 먹여 봤다. `workspaceState('유휴인데 8번이 미체크 — 막힘 (재전송하지 않음)')` = `"busy"` 이고, 반입한 막힘 20행 전부를 넣어도 결과 집합이 `['busy']` 하나다 — 문장을 주면 늘 같은 값이라 `other` 갈래 자체가 안 생긴다. `holdOf` 는 막힘 `이유` 20/20 이 `other`(100%), 결정 필요 `내용` 202/328 이 `other`(61.6%) | 축을 나누고 표마다 분류표를 따로 뒀다(`src/fleet/reasons.mjs`). 같은 전수 입력에서 `blockOf` 막힘 `other` **0/20**, `callOf` 결정 필요 `other` **0/328**. 착륙 70·파견 127 도 `other` 0 — 네 열 545행 커버리지 100.0% (`npm run eval:coverage`) | `workspaceState` · `holdOf` 는 **안 고쳤다** — 새 분류표는 라벨만 붙이고 판정에 끼어들지 않는다(`PRD.md §7`). `EVAL.md` 머리말에 축을 나눈 이유를 적었다 |
| R6 | 실행 확인 (슬라이스 10 몫) | 변경 전 `/eval` 은 비용·시간만 그렸고, 머리 주석이 "세팅별 비교표와 실패 사례 분류는 슬라이스 8의 몫이라 여기 없다" 로 미뤄 뒀다 — 슬라이스 8·9가 만든 `data/eval/*.json` 을 읽는 자리가 어디에도 없었다 | `npm run web:build` 통과 후 `next start`(127.0.0.1:3118, 이 워크트리의 `web/`)로 띄워 `/eval` 을 받아 표 넷을 확인했다: 시나리오 재생(일치율 100.0% · 10줄) · 세팅 비교(9행) · 사유 커버리지(4행 + 헛호출 3행) · 사고 분류(4행). 읽는 쪽은 `src/fleet/evals.mjs`, 없으면 만드는 명령을 안내한다 | 화면은 수를 다시 재지 않고 결과 파일만 읽는다 — 보는 사람마다 다른 수가 나오면 안 된다. 표는 `overflow-x` 상자 안에 넣어 좁은 화면에서 문서 전체가 밀리지 않게 했다 |
| R10 | 실행 확인 | 계획 초안은 "사고 사례 29건" 이었다. 원본 표를 전수로 세면 지금 **30행**(최대 번호 30 — 리뷰 뒤 한 행이 늘었다)이고, 그중 사용자 결정·점검 결과·기능 설명이 섞여 있다. 29(또는 30)를 사고 수로 적으면 표본 수가 틀린다 | 행마다 `사고`/`사고 아님` 을 갈라 **둘 다** 적는다: 원본 30행 → 제외로 뺀 1행 → 반입 29행 → **사고 19건 · 사고 아님 10행**(사용자 결정·요청 4 · 점검 결과 3 · 기능 2 · 운영 결정 1). `npm run import:incidents` 출력과 `data/eval/incidents.json` `counts`, `EVAL.md` 표 4, `/eval` 이 같은 수를 낸다 | 라벨 표에 없는 번호는 `미분류` 로 세어 보고한다 — 원본에 행이 늘면 조용히 빠지지 않는다 |
| R11 | 실행 확인 | 익명화 설정이 없는 상태로 반입을 돌리면 멈춘다: `node scripts/import-incidents.mjs --dry` → `익명화 설정이 없다: …/anonymize.local.json` · `exit 2` (설정 파일을 잠시 치우고 실측). 지적대로 여기서 세션 하나를 태울 자리였다 | `anonymize-map.local.md` 의 제외·치환·경로 표에서 `anonymize.local.json` 을 만들었다(git 무시). 반입이 끝까지 돈다 — 원본 30행 · 제외 1행 · 반입 29행 · **금칙어 스캔 0건**. 판단이 갈리는 자리는 없었다(제외 목록이 이름 둘로 명확했다) — 카드 `wait` 로 멈추지 않았다 | 설정에 `incidentSource` 를 더했다. §2 대로 ssh 호스트 별칭은 `<ssh-alias>` 로 치환했다(반입본 13번). 설정 파일 자체는 커밋되지 않는다 |

## 이 슬라이스가 돌린 검사

- `npm run eval:coverage` — 네 열 545행 커버리지 100.0% · `other` 0 · 지금 관찰의 막힘 3건도 `other` 0 · exit 0
- `npm run import:incidents` — 30행 → 29행 · 금칙어 0건 · 미분류 0 · exit 0
- **두 번 돌려 같은가** — `coverage.json` · `incidents.json` 을 연속 두 번 만들어 `builtAt` 을 뺀 내용이 문자열 단위로 동일(각각 13,324자 · 10,763자).
- **격리** — 두 스크립트를 네 번 돌리는 동안 `sandbox/fleet` 244개 파일 해시가 그대로다(변한 것 0건). 회차 기록도 읽기만 한다.
- `npm run check` — 다섯 전부 통과 (`node_modules` 가 이 워크트리에 없어 `npm install` 을 먼저 했다)
- `npm test` — 455/455
- `npm run web:build` — 통과, `/eval` 정적 생성됨
- **관찰 가능성 실측** — `next start` 로 띄운 뒤 회차 상세 **241개를 전부** 받아 200 응답과 사유 표시를 확인했다: 200 응답 241건 · 그 회차에 기록된 막힘 `이유`·결정 필요 `내용` 문장이 응답 본문에 없는 경우 0건. 확인용 스크립트는 임시로 돌리고 지웠다.
- `ANONYMIZATION.md §4` 스캔 — 이번 슬라이스가 만든·고친 파일(`EVAL.md` · `README.md` · `package.json` · `src/fleet/reasons.mjs` · `src/fleet/evals.mjs` · `scripts/eval-coverage.mjs` · `scripts/import-incidents.mjs` · `data/eval/coverage.json` · `data/eval/incidents.json` · `web/app/eval/page.js` · `web/app/globals.css`)에서 **0건**.
  저장소 전체에는 남아 있다 — `notes/2026-09-11-…-slice6-port-evidence.md`(12줄: 실명 · 마스킹 안 된 절대경로 · 치환 대상 프로젝트 이름)와 `review.md:24`(운영 저장소 경로 한 줄). 둘 다 이 슬라이스가 만든 것이 아니라 손대지 않았고, `PLAN.md` 슬라이스 13의 공개 전환 전에 처리해야 한다. 나머지 스캔 히트는 전부 `drift` 오탐이다.
