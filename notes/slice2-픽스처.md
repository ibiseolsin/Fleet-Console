# 슬라이스 2 — 샌드박스 플릿 픽스처 (2026-09-10)

가짜 프로젝트 셋으로 판정 함수 셋(`landCheck` · `resumePlan` · `dispatchPlan`)을 실제 기계 없이 부른다.

```
node scripts/fixture.mjs         # 픽스처를 처음부터 만든다 (sandbox/fleet/, git 이 무시)
node scripts/fixture-check.mjs   # 판정 셋을 부르고 갈래·격리를 확인한다
```

## 왜 실물 폴더인가

계획서 함정 메모대로였다 — `landCheck` 는 "부수효과 없음" 이라는 주석과 달리 **디스크를 직접 읽는다**:
폴더 존재(`existsSync`) · 워크스페이스 `PLAN.md` · `git status --porcelain` · `git log <base>..HEAD`.
그래서 픽스처는 순수 객체가 아니라 **실제 폴더 · 실제 git 저장소 · 실제 linked worktree** 다.

배치는 운영 플릿과 같은 모양으로 뒀다. `workspacesDirOf(root, home)` 이
`<home>/orca/workspaces/<본체 폴더명>` 을 내므로, 슬라이스 4의 쓰기 도구는 `home` 만 픽스처 루트로
주면 sp-sync 의 경로 계산이 그대로 맞는다.

```
sandbox/fleet/
  orca/projects/<프로젝트>/           본체 (origin 붙은 git)
  orca/workspaces/<프로젝트>/sliceN/   워크스페이스 (linked worktree, 브랜치 sliceN)
  origin/<프로젝트>.git                원격 (bare) — 착륙의 base 가 `origin/main`
  state/                              세션 기록 · 창 목록 · worktree 목록 · 절전 · 카드 · 재개 항목
```

## 실제 `~/.sp-sync/` 를 안 건드리는 법

바깥과 닿는 자리는 sp-sync 가 이미 열어 둔 주입 구멍으로 갈아 끼웠다 —
`projectWorkspaces(root, io)` 의 `io`(창·worktree·세션·절전), `resumePlan(list, ctx)` 의
`ctx`(워크스페이스·슬라이스·카드·한도). 실제 Orca CLI 는 한 번도 안 부른다.

못 막은 자리 둘. 둘 다 **읽기만** 한다:

- `landCheck` → `cardForWorkspace` → `~/.sp-sync/cards/`. `CARDS_DIR` 이 모듈 상수라 못 바꾼다.
  경로가 안 맞아 픽스처 워크스페이스에는 어떤 카드도 안 붙는다 — **착륙의 "워커가 결정을 기다림"
  갈래는 이 픽스처로 못 낸다.** 카드 갈래를 보려면 `resumePlan` 의 `ctx.cards` 를 쓴다(주입된다).
  슬라이스 4가 착륙 쪽 카드 갈래를 다뤄야 하면 그때 도구 층에서 감싸야 한다.
- `config()` 의 설정 읽기. 판정에 쓰는 값(에이전트 표·상한·재개 상한)은 픽스처가 직접 넘긴다.

확인은 해시로 한다 — `fixture-check.mjs` 가 실행 전후 `~/.sp-sync/` 아래 모든 파일의
sha256 을 떠서 대조하고, 하나라도 다르면 그 경로를 찍고 실패한다.

## 왜 헤드리스(codex)·잠든 창을 섞었나

TUI 워크스페이스의 유휴 판정(`landCheck` → `isIdle`)은 Orca CLI(`terminal wait --for tui-idle`)를
부른다. 가짜 핸들로는 시간만 쓰고 "작업 중" 으로 떨어져 그 뒤(체크·커밋·트리)를 못 본다.
**헤드리스 워커는 세션 기록만으로, 잠든 창은 절전 기록만으로** 유휴가 갈리므로 그 둘은
디스크만으로 끝까지 판정된다. 그래서 착륙 자격이 나야 하는 워크스페이스는 헤드리스로,
"잠들었는데 미체크" 는 절전 창으로 뒀다. 살아 있는 TUI 창 하나(`beacon/slice3`)는 **열린 턴**이라
`isIdle` 앞에서 "턴 진행 중" 으로 끝난다 — 이것도 Orca 를 안 부른다.

## 시각은 상대값으로 적는다

픽스처의 모든 시각은 `{"$minutesAgo": 40}` · `{"$minutesAhead": 95}` 꼴로 저장하고 읽을 때 푼다.
턴이 묵었는지(`TURN_STALE_MS` 1시간)와 한도가 풀렸는지는 절대 시각이 아니라 지금과의 거리로
갈리므로, 절대 시각으로 적으면 한 번 만든 픽스처가 몇 시간 뒤 다른 판정을 낸다.
`fixture-check.mjs` 는 `now` 를 한 번 정해 세 함수에 같이 넘긴다.

## 픽스처가 담은 상황

| 프로젝트 | 성격 | 워크스페이스 |
|---|---|---|
| `atlas` | 헤드리스(codex) 플릿 | `slice2` 체크·커밋·깨끗함 / `slice3` 턴 끝났는데 미체크 |
| `beacon` | TUI 플릿, 동시 상한 2 | `slice2` 잠듦·미체크 / `slice3` 턴 진행 중 |
| `cobalt` | 계획 오류와 순서 막힘 | `slice5`(다음 단계 번호) 한도에 막힌 채 남음 |

## 완료 기준 확인 (실행)

```
node scripts/fixture.mjs && node scripts/fixture-check.mjs   → 통과 (exit 0)
node --test "sp-sync/test/*.test.mjs"                        → tests 455 · pass 455 · fail 0
```

`fixture-check.mjs` 가 낸 갈래:

| 갈래 | 건수 | 어디서 |
|---|---|---|
| 착륙 자격 있음 | 1 | `atlas/slice2` — 체크 완료 · 커밋 1개 · 깨끗함 |
| 막힘 | 3 | `atlas/slice3` 미체크 · `beacon/slice2` 잠듦+미체크 · `cobalt/slice5` 한도 막힘 |
| 파견 보류 | 9 | 이미 돌고 있음 · 선행 미완 · 결정 필요 · 동시 상한 · 계획 오류 · 혼자 돌아야 함 |
| 재개 판정 | 5갈래 전부 | drop · resume · wait · blocked · exhausted |

격리: 실행 전후 `~/.sp-sync/` 파일 205개 해시 동일, 변한 것 0건. 두 번 연속 실행해도 같다.

## 다음 슬라이스가 알아야 할 것

- 슬라이스 3(읽기 도구)이 요구하는 **파견 불가 사유 세 가지**(선행 미완 · 상한 도달 · 결정 필요)가
  이 픽스처에서 이미 각각 나온다 — `atlas/4번` · `beacon/5번` · `atlas/5번`.
- 슬라이스 4(쓰기 도구)는 `fleetDispatch`·`fleetLand` 를 그대로 부르면 실제 락·트리거를 건드린다.
  픽스처는 `home` 주입으로 경로가 맞게 만들어 뒀지만, `~/.sp-sync/fleet-run.lock` 등 **상태 파일
  경로는 `DIR`(모듈 상수) 고정**이라 도구 층에서 실행부를 감싸야 한다.
- `fixture-check.mjs` 의 해시 대조는 그대로 슬라이스 4의 격리 확인에 쓸 수 있다.
- 픽스처를 고칠 때는 `sandbox/fleet/` 을 손으로 고치지 말고 `scripts/fixture.mjs` 의 정의를 고쳐
  다시 만든다. 생성물은 git 이 무시한다.
