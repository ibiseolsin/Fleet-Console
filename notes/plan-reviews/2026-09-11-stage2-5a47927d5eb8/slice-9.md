# 2026-09-11-stage2-5a47927d5eb8 — slice 9 검증

구현 세션: Claude Code, Opus 5 (1M context, `claude-opus-5[1m]`) · 워크스페이스 `slice9` · 기준 HEAD `734371b`.
자기 담당 지적만 확인했다 (R4 · R5, 그리고 R6 중 슬라이스 9 몫). `review.md` 와 다른 워커 파일은 고치지 않았다.

| id | 결과 분류 | 변경 전 증거 | 변경 후 증거 | 코드 상태/비고 |
|---|---|---|---|---|
| R4 | 실행 확인 | 계획대로면 세팅마다 슬라이스 8의 시나리오 표를 다시 판정한다. 재개 상한 1로 관찰해 보면 beacon/slice3 의 재개 갈래가 `wait` 가 아니라 `exhausted`("재개 1회 실패 — 사람이 볼 것 (claude 5시간 한도)")다 — 시나리오 8의 기대(`resume[].action==='wait'` + 카드 `wait`)가 깨져 **일치율이 판정이 아니라 세팅 탓에 8/9 로 떨어진다**. 원인은 `sp-sync/lib/resume.mjs:210` 의 `attempts >= max` 가 `:224` 의 카드 검사보다 앞이라는 것 | 일치표는 `scripts/eval.mjs` 가 **기준 세팅(재개 상한 2)에서만** 판정하고 그대로 100.0%(재생 9 / 일치 9)를 유지했다. `scripts/eval-settings.mjs` 는 일치 여부를 아예 안 재고 갈래 변화만 적는다 — 실측 출력: `재개 상한 1 → beacon/slice3 exhausted: 재개 1회 실패 — 사람이 볼 것 (claude 5시간 한도)` / `재개 상한 2·3 → wait: 워커가 결정을 기다림: …`. 워크스페이스별 갈래도 표로 낸다: beacon/slice3 `exhausted → wait → wait`, cobalt/slice5 `exhausted → exhausted → resume` | `scripts/eval.mjs` 는 이 슬라이스에서 판정 관련 변경이 없다(픽스처 가드를 `scripts/fixture-guard.mjs` 로 옮긴 것뿐). 새 스크립트 머리말과 출력 양쪽에 이 함정을 적어 뒀다 |
| R5 | 실행 확인 | 계획의 완료 기준 문장은 "상한 2→5 에서 `cap-project` 보류가 줄고 자격이 느는 것이 수로 보인다" 였다. 실행하면 `cap-project` 는 **1 → 0 → 0**, 자격은 **2 → 3 → 3** 이다 — 상한 3에서 이미 소진되고 3→5 는 아무것도 안 움직인다. 표만 내면 "수가 안 늘었다" 로 읽혀 픽스처를 늘리고 싶어지는 자리이고, 늘리면 슬라이스 8의 시나리오 표본이 같이 바뀐다 | 픽스처를 그대로 두고 **표본 수를 출력에 박았다**: `**표본이 작다** — 기준 세팅에서 cap-project 로 떨어지는 슬라이스는 픽스처 전체에서 1개다.` 결과 파일 `data/eval/settings.json` 의 `sample.capProjectSlices = 1` 과 같은 문장이 들어간다. 자격이 느는 자리는 슬라이스 이름까지 낸다: `[beacon 4번, cobalt 2번] → [beacon 4번, beacon 5번, cobalt 2번] → (같음)` | `sandbox/fleet/` 233개 파일 해시가 실행 전후 동일 — 픽스처를 안 늘렸을 뿐 아니라 **읽지도 않고 쓰지도 않았다**는 것을 수로 확인했다 |
| R6 | 실행 확인 (슬라이스 9 몫만) | 결과가 표준출력뿐이면 `/eval` 화면이 읽을 자리가 없다 — 슬라이스 8이 만든 `data/eval/` 에 세팅 비교표가 없었다 | `npm run eval:settings` 가 `data/eval/settings.json` 을 남긴다(`scenarios.json` 과 같은 꼴). 담은 것: 축 둘 · 기준 세팅 · 표본 수 · 사람 호출 갈래 정의 · 조합 9행 · 축별 sweep · 에이전트 두 종 · 격리 | 화면에 붙이는 것은 슬라이스 10의 완료 기준이다 |

## 두 번 돌려 같은가 — 실행 확인

`npm run eval:settings` 를 연속 두 번 돌려 결과 파일을 대조했다. `builtAt` 을 뺀 **1,200여 줄이 바이트 단위로 동일**했다(diff 0건).

같은 대조를 분 경계에 걸쳐 돌면 사유 문장 두 곳만 달라진다 — `잠듦(claude done 22:38→22:39)` 과
`초기화 03:23→03:24`. 픽스처 시각이 상대값이라 `now` 에서 분 단위로 계산되는 자리다(슬라이스 8이 이미
같은 것을 기록했다). **수와 갈래는 안 바뀐다** — 시각을 `HH:MM` 으로 정규화하면 그 diff 도 0건이다.
회차 소요(ms)는 결과 파일에 안 담았다: 그 기준은 슬라이스 8이 재고, 여기 담으면 두 번 돌린 파일이
잰 시간 탓에만 달라져 "같은가" 를 못 본다.

## 이 슬라이스가 돌린 검사

- `npm run eval:settings` — 조합 9개 + 기준 세팅 1개 관찰 · `other` 로 떨어진 보류 0건 · 격리 233개 파일 중 변한 것 없음 · exit 0
- 연속 두 번 결과 대조 — `builtAt` 제외 동일 (위)
- `npm run eval` — 슬라이스 8의 일치표가 그대로다: 재생 9 / 일치 9 / 불일치 0 / 재생 불가 1 · 일치율 100.0% · exit 0
- `npm run check` — 다섯 전부 통과 (`node_modules` 가 이 워크트리에 없어 `npm install` 을 먼저 했다)
- `npm test` — 455/455
- `ANONYMIZATION.md §4` 스캔 — 이번 슬라이스가 만든·고친 파일(`scripts/eval-settings.mjs` · `scripts/fixture-guard.mjs` ·
  `scripts/eval.mjs` · `src/fleet/source.mjs` · `package.json` · `data/eval/settings.json`)에서 **제외 목록 0건 ·
  치환 결정분 0건**. 저장소 전체에는 여전히 1건이 남아 있다 — 슬라이스 8이 "발견한 것" 에 적은 `review.md:24`
  (커밋 `c148272` 이 들여왔다). 슬라이스 규칙대로 손대지 않았고, 슬라이스 13의 공개 전환 전에 치환해야 한다.
