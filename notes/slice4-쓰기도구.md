# 슬라이스 4 — MCP 쓰기 도구 2종 + 승인 게이트 (2026-09-10)

`fleet_dispatch` · `fleet_land` 를 MCP 로 연다. 둘 다 승인 게이트를 지난다.

```
npm run check            # 픽스처 → 판정 → 읽기 도구 → 쓰기 도구, 넷을 순서대로
npm run mcp:write-check  # 쓰기 도구만 (픽스처를 다시 만들고 시작한다)
npm run approve          # 대기 항목 — 승인·보류는 사람이 한다
```

## 층을 둘 더 얹었다

| 파일 | 하는 일 |
|---|---|
| `src/fleet/approvals.mjs` | 승인 큐 — 대기 항목 만들기·사람의 결정·실행 직전 관문 |
| `src/fleet/execute.mjs` | 실행 — `dispatchOne`·`landOne` 을 픽스처용 손으로 갈아 끼워 부른다 |

`tools.mjs` 는 표에 둘을 더했고, `server.mjs` 는 도구마다 다른 `annotations` 를 싣도록 한 줄 바꿨다
(슬라이스 3의 인계 메모대로 — 그전에는 모든 도구에 읽기 전용 표시가 박혀 있었다).

## 승인 게이트 — 네 갈래로 끝난다

쓰기 도구 둘은 같은 뼈대(`gatedRun`)를 지난다. **자격 판정 → 승인 게이트 → 실행** 순서를
도구마다 따로 쓰면 한쪽만 게이트를 건너뛰는 날이 온다.

| status | 언제 | 무엇이 생기나 |
|---|---|---|
| `rejected` | 자격 미달 · 보류된 항목 · 남의 승인 | **아무것도 안 생긴다** (대기 항목도) |
| `pending` | 자격은 있고 승인이 없다 | 대기 항목 하나. 작업 공간은 안 생긴다 |
| `executed` / `failed` | 승인된 것을 실제로 돌렸다 | 픽스처에 반영 + 항목이 `done`/`failed` 로 닫힌다 |

**같은 호출을 다시 하는 것이 승인 뒤의 실행이다.** `approvalId` 를 따로 안 넘겨도 된다 —
지문(도구 이름 + 인자 + 픽스처 생성 시각)으로 찾는다. 그래서 에이전트 쪽 흐름이 단순하다:
불러 본다 → pending 이면 사람을 기다린다 → 같은 걸 다시 부른다.

지문에 인자를 넣은 이유는 하나다. 승인은 "이 슬라이스를 이 에이전트로" 에 대한 것이지 도구
이름에 대한 것이 아니다. 승인 하나로 다른 대상을 실행할 수 있으면 게이트가 아니다
(`mcp-write-check.mjs` 7번이 이걸 확인한다).

**보류는 다시 불러도 안 풀린다.** 보류된 항목을 또 부르면 새 대기 항목이 생기는 것이 아니라
거부된다 — 안 그러면 보류가 "다시 부르면 풀리는 것" 이 된다.

## 승인은 도구가 아니다

`fleet_approve` 를 만들지 않았다. 에이전트가 제 요청을 스스로 승인할 수 있으면 게이트가 아니다.
승인·보류는 `scripts/approve.mjs`(사람의 명령줄)와 슬라이스 6의 화면(`/approvals`)이 한다.
둘 다 `approvals.mjs` 의 같은 함수를 부른다.

## 실행은 sp-sync 를 그대로 부른다 — 손만 갈아 끼웠다

순서를 흉내 내 다시 쓰지 않았다. `dispatchOne` · `landOne` 이 이미 주입 구멍
(`DISPATCH_DEPS` · `LAND_DEPS`)을 열어 두고 있어서, 그 구멍만 픽스처용으로 바꿨다.
착륙은 실제와 똑같이 **검사 → push → PR → 충돌 → 최종 게이트 → 머지 → 정리** 를 지난다.

| 실제 | 픽스처 |
|---|---|
| `orca worktree create` · `terminal create` · `worktree rm` | `git worktree` + `sandbox/fleet/state/*.json` 기록 |
| `gh pr view/create/merge` | `sandbox/fleet/state/prs.json` + **진짜 `git merge`** → bare 원격 |
| `landCleanup` (Orca 목록 · 공유 자원 해제) | 픽스처 전용 정리. **자원 표는 안 건드린다** |

파견 쪽은 기본 표를 펼치지 **않았다** — 하나라도 빠뜨리면 실제 Orca 를 부르게 된다.
착륙 쪽은 반대로 `...LAND_DEPS` 를 깔고 다섯만 덮었다: 여덟 중 어느 것이 위험한지가
목록에 그대로 드러나야 하고, 나머지 셋(`head`·`check`·`recheck`)은 로컬 git 만 본다.

**창은 기록만 있고 프로세스는 없다.** 파견하면 세션 기록에 **턴이 열린 채로** 찍히므로,
바로 이어서 `fleet_status` 를 부르면 그 워크스페이스가 `busy` 로 뜬다. 실제 워커가 도는
것과 같은 모양이다 — 착륙은 그것을 "작업 중" 으로, 파견은 "이미 돌고 있음" 으로 본다.

## 하지 않은 것 둘

- **충돌 해소 시도.** `conflictLoop` 는 워커 세션에 문장을 보내 풀게 하는데 픽스처에는
  살아 있는 세션이 없다. 충돌이면 시도 없이 사람에게 올린다. "2회 시도했다" 고 적으면
  회차 상세가 거짓이 된다 — 시나리오 9는 회차 기록을 재생하는 슬라이스 8의 몫이다.
- **재파견.** `dispatchPlan` 이 재파견 대상으로 낸 슬라이스는 거부한다. 이 도구는 새 파견만 한다.

## 검사 명령을 하나 두었다

`SANDBOX_CHECK = 'node --version'` — 운영의 `fleetChecks` 자리다. 픽스처에 돌릴 테스트는
없지만 **검사 단계 자체는 태운다**: 최종 게이트(`mergeGate`)가 "검사한 SHA = 로컬 = PR 머리"
로 머지 여부를 가르므로, 검사를 건너뛰면 그 게이트가 확인되지 않는다.

## 완료 기준 확인 (실행)

```
npm run check   → 넷 전부 통과 (exit 0)
npm test        → tests 455 · pass 455 · fail 0
```

| 완료 기준 | 결과 |
|---|---|
| 승인 없이 부르면 대기 항목만 생기고 작업 공간은 안 생긴다 | `cobalt/2번` pending · 폴더 없음 · `fleet_status` 에도 안 뜸. 다시 불러도 항목은 하나 |
| 승인 뒤 재호출하면 픽스처에 실제로 반영된다 | 파견: `cobalt/slice2` 폴더 생김 · 현황에 `busy`. 착륙: `atlas/slice2` 머지 → 본체 PLAN.md 2번이 `[x]` · 폴더 사라짐 |
| 자격 미달은 사유와 함께 거부된다 | `deps-undone`(선행 미완) · `decision`(결정 필요) · `cap-project`(상한 도달) · 착륙 막힘 — 넷 다 큐가 안 늘었다 |
| 격리 | `fleet-run.lock` · `fleet-trigger.json` · `fleet-cycle-result.*.json` **변한 것 0건** (실행 중 `~/.sp-sync/` 전체도 0건이었다) |

`ANONYMIZATION.md §4` 스캔: 추적 파일 **0건** (`drift` 오탐만 — 이 슬라이스가 `scripts/mcp-write-check.mjs`
에 다섯 줄 늘렸다).

## 곁들여 고친 것 둘

- `scripts/fixture-check.mjs` 의 해시 사본을 `hash-tree.mjs` 로 합쳤다 (슬라이스 3의 인계 메모).
- `scripts/mcp-check.mjs` 가 "도구가 셋뿐" 을 단언하고 있어 "읽기 셋 밖은 쓰기 둘뿐" 으로 바꿨다.
  수를 아예 안 세면 읽기 전용 아닌 도구가 슬그머니 하나 더 붙어도 아무도 모른다.

## 다음 슬라이스가 알아야 할 것

- **슬라이스 6의 승인 큐 화면은 `approvals.mjs` 위에 그대로 올린다.** `listApprovals({open:true})`
  가 배지가 셀 것이고, 버튼 둘은 `decideApproval(id, 'approve'|'hold', 메모)` 다. 큐 파일은
  `sandbox/approvals.json`(git 무시) 하나이고 tmp→rename 으로 쓴다.
- **항목에 `evidence` 가 이미 들어 있다** — 파견은 슬라이스·에이전트·명령·단계·지금 도는 수,
  착륙은 브랜치·완료 체크·커밋 목록·검사 명령. 화면은 그 표를 그대로 그리면 된다.
- **시간·토큰 계측(슬라이스 6)이 붙을 자리**는 `runDispatch`·`runLand` 의 반환값이 아니라
  승인 항목의 `result` 다 — 승인부터 실행까지가 한 항목에 담긴다.
- 슬라이스 7(에이전트 루프)이 "쓰기 도구 앞에서 승인 대기로 멈춘다" 를 만족하는 자리가
  `status: 'pending'` 이다. 루프는 그 값을 보고 멈추고, 승인 뒤 **같은 인자로 다시** 부르면 된다.
- **확인 스크립트는 순서가 있다.** `mcp-write-check` 가 픽스처를 바꿔 놓으므로 `fixture:check`·
  `mcp:check` 를 그 뒤에 돌리면 실패한다. `npm run check` 가 그 순서를 못 박아 둔다.
