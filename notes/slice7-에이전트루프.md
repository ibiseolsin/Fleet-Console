# 슬라이스 7 — 앱 안의 에이전트 루프 (2026-09-10)

```
npm run agent              # 명령줄에서 한 실행 — "이 플릿의 다음 할 일을 정해줘"
npm run agent -- resume <id>
npm run agent:check        # 완료 기준을 실제 모델로 끝까지 (모델 호출 4~5회, 약 $0.2)
npm run web                # /agent · /agent/<id>
```

## 무엇을 어디에

| | 어디 |
|---|---|
| 루프 | `src/agent/loop.mjs` — Claude Agent SDK `query()` 한 번 = 구간(leg) 하나 |
| 실행 기록 | `src/agent/runs.mjs` → `sandbox/agent-runs/<id>.json` (git 무시) |
| 화면 | `web/app/agent/` — 목록·시작, 상세(trace)·이어서 끝내기 |
| 검사 | `scripts/agent-check.mjs` · 명령줄 `scripts/agent.mjs` |

## 결정 셋

**Claude Agent SDK 로 갔다 — 이 기계에 API 키가 없고 Claude Code 로그인만 있어서다.** `ANTHROPIC_API_KEY`
도 `ant` CLI 도 없다. Agent SDK 는 Claude Code 프로세스를 띄워 그 로그인을 그대로 쓴다. 대신 SDK 가
zod 4 를 요구해 저장소의 zod 를 3 → 4 로 올렸다 (MCP SDK 는 둘 다 받는다). `npm run check` 다섯과
테스트 455 가 zod 4 에서 그대로 통과했다.

**도구는 `tools.mjs` 의 같은 표 다섯을 프로세스 안 MCP 서버로 등록했다.** 더한 것은 `reason` 인자
하나뿐이다 — 도구를 부를 때마다 이유 한 문장을 받아 trace 에 남긴다. 내장 도구는 전부 끄고
(`tools: []`), 이 기계의 설정·CLAUDE.md·훅도 읽지 않는다(`settingSources: []`). 판정 규칙은 새로 만들지
않았다 — 시스템 프롬프트가 "도구가 낸 자격 위에서 순서만 고른다" 고 못 박는다.

**승인 게이트는 도구 안에 그대로 두고, 루프는 `pending` 을 보면 멈춘다.** 쓰기 도구가 `pending` 을
내면 `canUseTool` 이 그 뒤의 모든 호출을 거부하고, 구간이 끝나면 상태가 `waiting` 이 된다. 사람이
`/approvals` 에서 답하면 **같은 세션을 `resume`** 해 "승인됐다 — 같은 인자로 다시 불러라" 를 전한다.
승인·보류는 여기서도 도구가 아니다.

## 두 번 틀린 것

**반복 상한이 "오류" 로 읽혔다.** SDK 는 상한에 닿으면 `error_max_turns` 결과를 **먼저** 보내고 그 뒤에
예외를 던진다. 예외를 먼저 봐서 `failed` 가 됐다 — 결과의 subtype 을 먼저 보도록 순서를 바꿨다.

**모델이 승인을 의심했다.** 검사가 승인 메모에 "agent-check 가 승인" 이라 적자, 재개한 모델이 "사람이
아니라 에이전트가 승인했으니 자기승인 루프" 라며 실행을 거부했다. 옳은 조심이지만 자리가 틀렸다 —
승인의 진위는 도구가 큐에서 실행 직전에 확인한다. 프롬프트에 "승인의 진위·메모는 네가 따지지 않는다,
도구가 확인하고 없으면 스스로 거부한다" 를 넣었다. 그 뒤로는 바로 실행한다.

## 서버를 껐다 켜도 이어진다

실행 기록은 SDK 메시지마다 파일로 다시 쓴다(tmp → rename). 세션 id = 실행 id 라 Claude Code 의 세션
기록과 1:1 이다. 돌던 프로세스의 pid 를 적어 두고, 읽는 쪽이 그 pid 가 죽어 있으면 `interrupted` 로
고쳐 적는다. "이어서 끝내기" 는 `resume: id` 로 같은 세션에 "서버가 다시 켜졌다, 이어서 끝내라" 를
보낸다. 검사는 이것을 진짜로 한다 — 실행 하나를 자식 프로세스로 띄워 첫 도구 호출 뒤에 죽이고,
부모가 이어서 끝냈다(관찰 도중 끊긴 실행이 `waiting` 까지 갔다).

## 완료 기준 확인 (실행)

`npm run agent:check` — 2026-09-10, 모델 `claude-opus-5`, 비용 합계 $0.20:

| 완료 기준 | 결과 |
|---|---|
| 읽기 도구 2종 이상을 스스로 | `fleet_status` · `fleet_slices` 둘 다 (지시 없이) |
| 쓰기 도구 앞에서 승인 대기 | `fleet_land atlas/slice2` → `pending` → 상태 `waiting`. 큐에 항목 하나, 실제 착륙 없음 |
| 승인 뒤 이어서 끝냄 | **다른 프로세스**가 `resume` → 같은 인자로 재호출 → `executed` (PR #1 머지) → `done`. 승인 전엔 "아직 답하지 않았다" 로 거부 |
| 호출과 이유가 trace 에 | 호출 3개 전부 `reason` 있음 (예: "유일한 착륙 자격 작업 공간이고, 착륙하면 선행 미완으로 막힌 atlas 4번이 풀린다") |
| 반복 상한 | 1턴 → `stopped` "반복 상한 1턴에 닿았다 (구간 1)" |
| 시간 상한 | 1.5초 → `stopped` "시간 상한 2초에 닿았다" |
| 껐다 켠 뒤 이어서 | 자식 프로세스 kill → `interrupted` → 부모가 `resume` → `waiting`(쓰기 앞) |
| 격리 | `~/.sp-sync/` 의 락·트리거·회차 결과 변화 없음 |

화면 — `npm run web:build && next start -p 3117`, 브라우저에서:
`/agent` 시작 → 3초마다 갱신되며 호출·이유·결과가 쌓임 → `승인 대기` (턴 4 · 18초 · $0.065) →
`/approvals` 에서 승인(메모 "화면에서 승인") → 상세의 "이어서 끝내기" → `fleet_land executed` → `끝남`
(구간 2 · 턴 2 · $0.031). 폭 391px(iframe)에서 `/agent` · 상세 둘 다 `scrollWidth === clientWidth`, 넘치는 요소 0.

기타 — `npm run check` 다섯 통과 · `npm test` 455/455 · `ANONYMIZATION.md §4` 스캔: 새 파일의 히트는
`agent-check.mjs` 의 `drift` 안 4글자 오탐뿐 (슬라이스 6과 같음), 실명 0건.

## 다음 슬라이스가 알아야 할 것

- **`agent:check` 는 `npm run check` 에 넣지 않았다.** 모델을 부르고 돈이 들며 로그인이 필요하다.
- **모델은 `FLEET_AGENT_MODEL` 로 바꾼다** (기본 `claude-opus-5`). 한 실행이 4~6턴, $0.05~0.10.
- **배포본(슬라이스 9)은 Claude Code 로그인이 없다.** Agent SDK 는 `ANTHROPIC_API_KEY` 도 받으므로 키를
  환경변수로 넣으면 그대로 돈다 — 단 Claude Code 실행 파일이 배포 이미지에 있어야 한다(SDK 패키지가
  플랫폼별 바이너리를 같이 깐다). 확인은 슬라이스 9 몫.
- **상한은 구간(leg) 단위다.** 이어서 돌리면 턴·시간이 새로 센다. 비용 상한($1)도 마찬가지.
- 실행 상세(`/agent/<id>`)와 회차 상세(`/runs/<회차>`)는 다른 것이다 — 하나는 방금 돈 루프, 하나는 반입한
  운영 기록. 슬라이스 8의 재생은 어느 쪽에도 섞지 않는다.
- 모델의 선택은 매번 같지 않다. 검사는 "무엇을 골랐나" 가 아니라 "관찰 → 쓰기 앞에서 멈춤 → 승인 뒤 실행"
  의 모양을 본다. 세 번 돌려 세 번 다 `atlas/slice2` 착륙을 먼저 골랐지만 보장은 아니다.
