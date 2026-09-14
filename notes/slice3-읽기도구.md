# 슬라이스 3 — MCP 읽기 도구 3종 (2026-09-10)

`fleet_status` · `fleet_slices` · `fleet_report` 를 MCP 로 연다. 셋 다 읽기 전용이다.

```
npm install
npm run fixture      # 샌드박스 플릿(sandbox/fleet) + 회차 기록(sandbox/runs)
npm run mcp:check    # MCP 클라이언트로 셋을 부르고 격리까지 확인
npm run mcp          # 서버만 stdio 로 (클라이언트가 이렇게 띄운다)
```

## 층을 셋으로 나눴다

| 파일 | 하는 일 | 왜 나눴나 |
|---|---|---|
| `src/fleet/source.mjs` | 픽스처 관찰 + 판정 셋 호출 → 도구가 낼 모양 | 화면(슬라이스 5~6)과 에이전트 루프(7)가 같은 것을 본다 |
| `src/fleet/runs.mjs` | 회차 기록 마크다운 → 구조 | `fleet_report` 의 재료. 파일 형식이 바뀌면 여기만 고친다 |
| `src/fleet/tools.mjs` | 도구 셋의 이름·설명·스키마·핸들러 | 전송(MCP·HTTP·화면)과 떼어 둔다 |
| `src/mcp/server.mjs` | stdio 전송 | 이 파일에는 판정도 형식도 없다 |

**판정 규칙은 하나도 새로 만들지 않았다.** `landCheck` · `dispatchPlan` · `resumePlan` 이 낸
사유 문장을 그대로 실어 나른다. 문장을 다시 쓰면 화면과 실제 판정이 갈린다.

## 사유에 코드를 붙였다 (`holdOf`)

사유 문장은 사람이 읽는 것이고, 도구를 부른 쪽은 **거르고 세야** 한다. 그래서 문장은 그대로 두고
갈래 코드를 하나 얹었다 — `deps-undone` · `cap-project` · `cap-global` · `decision` · `running` ·
`solo` · `order` · `plan-error` · `limit-hold` · `unknown-agent` · `resource-held` · `no-number`.

앞머리로 가른다(사유 뒤에 "모르는 태그" 같은 꼬리가 붙기 때문). 못 알아본 것은 `other` 로 두고
문장을 그대로 싣는다 — 여기서 문장을 지어내면 안 된다. sp-sync 에도 비슷한 표(`dispatchHoldType`)가
있지만 그건 **통지에 올릴 넷**만 고르는 것이라 목적이 다르다. 규칙이 늘면 둘 다 봐야 한다.

## 워크스페이스 상태를 넷으로 이름 붙였다

`landCheck` 는 `ready` · `blocked` 두 깃발만 준다. 둘 다 아닌 것이 둘인데(도는 중 · 워커가 답을
기다림) 이름이 없었다. 화면과 도구가 같은 낱말을 써야 "막힘 3건" 이 어디서나 같은 3건이 된다.

`ready`(착륙 자격) · `blocked`(막힘) · `waiting`(답 대기) · `busy`(도는 중).

프로젝트별 `active` 수는 **안 낸다.** sp-sync 의 `activeCount` 를 흉내 내면 두 수가 갈린다 —
그 수는 파견 판정 안에서만 뜻이 있다(`동시 상한 N개를 채움`). 대신 상태별 개수(`counts`)를 낸다.

## 회차 기록을 픽스처에서 만들었다 (`scripts/fixture-runs.mjs`)

`fleet_report` 를 확인하려면 읽을 기록이 있어야 하는데, 진짜 기록 반입은 슬라이스 5다.
그래서 픽스처의 **같은 판정**을 시간만 달리해 세 회차로 싣고, 마크다운은 sp-sync 의
`renderCycleReport` 를 그대로 불러 썼다 — 형식을 손으로 지으면 슬라이스 5에서 처음 깨진다.

회차 셋: 어제(파견만) · 오늘 이른 회차(착륙 + 막힘) · 방금(막힘·결정 필요만). 날짜가 둘이라
범위 거르기도 확인된다. 슬라이스 5가 진짜 기록을 같은 폴더에 들여오면 같은 날짜 파일은 덮인다.

## 파서가 지키는 것 — 못 읽은 줄을 버리지 않는다

표에도 요약에도 안 잡힌 줄은 `notes` 로 남긴다(`⚠` · `본체 —` · `재개 —` · `건너뜀 —` 따위).
형식이 바뀌면 그 사실이 결과에 드러나야지, 조용히 빈 회차가 되면 안 된다.

## 완료 기준 확인 (실행)

```
npm run fixture && npm run mcp:check     → 통과 (exit 0), 확인 32건 전부 ✓
npm run fixture:check                    → 통과 (슬라이스 2 기준 그대로)
npm test                                 → tests 455 · pass 455 · fail 0
```

`npm run mcp:check` 는 서버를 **자식 프로세스**로 띄우고 공식 SDK 의 MCP 클라이언트로 붙는다 —
같은 프로세스에서 핸들러만 부르면 스키마 등록·직렬화가 안 확인돼, 정작 목록에 도구가 안 뜨는
것을 못 잡는다.

| 완료 기준 | 결과 |
|---|---|
| 도구 셋이 클라이언트 목록에 뜬다 | `fleet_status` · `fleet_slices` · `fleet_report` (그 셋뿐, 셋 다 `readOnlyHint: true`) |
| 슬라이스 목록이 돌아온다 | 미완 11개, 전부 사유가 실림 |
| 파견 불가 사유 세 가지 | 선행 미완 `atlas/4번` · 상한 도달 `beacon/5번` · 결정 필요 `atlas/5번` |
| 호출 전후 픽스처 해시가 같다 | `sandbox/` 235개 · `~/.sp-sync/` 203개, 변한 것 0건 |

`ANONYMIZATION.md §4` 스캔: 추적 파일 **0건** (`drift` 오탐은 이 슬라이스에서 새로 만들지 않았다).

## 다음 슬라이스가 알아야 할 것

- **슬라이스 4(쓰기 도구)는 `TOOLS` 표에 둘을 더 얹는다.** `run` 이 `{ data, text }` 를 내면
  `server.mjs` 는 안 고쳐도 된다. 다만 쓰기 도구는 `readOnlyHint` 를 빼고 승인 게이트를 붙여야 한다 —
  지금 `server.mjs` 는 모든 도구에 읽기 전용 표시를 박아 두었다.
- **격리 확인은 `scripts/hash-tree.mjs` 를 쓴다.** `scripts/fixture-check.mjs` 에 같은 일을 하는
  사본이 남아 있다(슬라이스 2). 쓰기 도구의 격리 확인을 붙일 때 그쪽도 이 파일을 쓰게 합친다.
- `fleet_report` 는 `sandbox/runs/` 만 본다. 폴더가 없으면 `missing: true` 로 빈 결과다 — 오류가 아니다.
- 슬라이스 6(승인 큐·계측)이 회차별 시간·토큰을 붙일 자리는 `runs.mjs` 의 회차 객체다.
  지금 회차에는 시각(`id`·`date`·`time`)만 있고 소요·토큰이 없다 — 기록에 그 값이 없어서다.
