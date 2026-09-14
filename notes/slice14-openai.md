# 슬라이스 14 — 에이전트 루프를 OpenAI 호출로 전환

2026-09-11. 근거: `PLAN.md` 슬라이스 14.

## 바꾼 것

- `src/agent/loop.mjs` — Claude Agent SDK `query()` 를 전역 `fetch` 로 부르는 Chat Completions 직접 루프로 바꿨다. 도구 정의는 `TOOLS` 의 `schema` + `reason` 을 `z.toJSONSchema` 로 만들고 `$schema` 키만 뺐다. 이름은 `fleet_status` 그대로다(접두사 없음).
- 대화 보존: `run.messages`(system · user · assistant(tool_calls) · tool)를 응답과 도구 결과마다 `writeRun` 한다. `resumeRun` 은 user 메시지를 덧붙여 같은 루프를 돈다.
- `src/agent/fake-model.mjs` — `FLEET_AGENT_FAKE=1` 이면 결정적 응답을 낸다. 응답마다 `FLEET_AGENT_FAKE_DELAY_MS`(기본 500ms)를 기다려 시간 상한 시험이 걸릴 틈을 둔다.
- 정리: `@anthropic-ai/claude-agent-sdk` 를 `npm uninstall` 로 뺐다(lock 갱신). 키 이름은 `.env.example` · `render.yaml` · `src/demo.mjs` · `scripts/demo-check.mjs` 에서, 문구는 `README.md` · `web/app/agent/page.js` · `scripts/agent-check.mjs` 머리말에서 바꿨다.
- 부수 변경(계획에 없던 것): `web/next.config.mjs` 의 `serverExternalPackages` 에서 SDK 를 뺐다. 이게 완료 기준 (4) 의 남은 참조였다. `npm run agent` · `agent:check` 는 `node --env-file-if-exists=.env` 로 로컬 `.env` 를 읽는다(Node ≥22.9. 이미지는 node:22).

## 정한 것 (계획이 안 정한 세부)

| 무엇 | 왜 |
|---|---|
| 인자가 스키마에 안 맞으면 step `deny` + 도구 결과 문장 | SDK 는 핸들러 전에 거부해 `call` step 이 없었다. `call` 로 적으면 "모든 호출에 이유" 검사가 깨진다 |
| 비용 상한은 **다음 모델 호출 직전에** 본다 | 도구 없이 답한 마지막 응답은 상한과 무관하게 success |
| 결과 없는 `tool_calls` 가 대화 끝에 남으면 재개 전에 "결과 없음" 을 채운다(`closeDangling`) | 도구 도중에 죽은 실행은 API 가 다음 메시지를 받지 않는다 |
| `messages` 가 없는(전환 전) 실행은 이어가기를 거절한다 | 옛 Claude 세션은 파일로 옮길 수 없다 |
| 실행(또는 실행 실패)된 쓰기가 있으면 다음 쓰기 호출을 `deny` | "한 실행에 쓰기 하나" 는 시스템 지시였는데 gpt-4.1-mini 가 어겼다(아래 첫 실측) |

## 검증 (2026-09-11, Windows)

- `node scripts/agent-check.mjs --fake` — 7항목 전부 ✓, 35초, 네트워크·키 없음(`OPENAI_API_KEY` 미설정 상태). 비용 $0.0034 는 가짜 usage 로 계산한 값이라 실측이 아니다.
- `npm test` 455/455 · `npm run check` 종료 0 · `npm run demo:check` PASS 4줄 · `npm run web:build` 성공.
- `@anthropic-ai` 참조: 코드·설정 0건. 남은 곳은 `PLAN.md`(계획 문장)뿐이다.

## 실제 키 — 완료 기준 (3) (2026-09-11, 교육용 키, `.env` 에 키만 · 기본 주소·모델)

- 1차 `npm run agent:check`: 7항목 중 1 실패 — 승인된 `fleet_land` 실행 뒤 같은 구간에서 모델이 `fleet_dispatch` 를 또 불러 `waiting` 으로 끝났다(Claude 시절엔 지시로 지켜졌다). 위 쓰기 게이트를 넣었다.
- 2차: **7항목 전부 ✓.** 재개 구간에서 모델이 파견을 다시 시도했고 게이트가 `deny` 한 뒤 보고하고 `done`.
- 대표 실행 `3c1f5552-…`(gpt-4.1-mini, `messages` 16개):

| 구간 | 턴 | 시간 | 입력(캐시 제외) | 캐시 입력 | 출력 | 비용 |
|---|---|---|---|---|---|---|
| 1 시작 | 3 | 5.8초 | 2,980 | 4,224 | 179 | $0.0019 |
| 2 재개 | 4 | 9.3초 | 885 | 12,160 | 225 | $0.0019 |

- 검사 전체 비용: 1차 $0.0069 + 2차 $0.0056. **usage × 기본 단가표로 계산한 값**이고, 교육용 키의 실제 청구 화면은 보지 않았다(미확인).
- 비교용 Claude 시절 기록: 한 실행 4~6턴 · $0.05~0.10(`PLAN.md` 슬라이스 11 본문). `EVAL.md` 에는 에이전트 루프 실측이 없어 "Claude 시절" 로 나눌 줄이 없다. 새 모델 표는 슬라이스 13 이 `EVAL.md` 에 넣는다.
- `/agent/<id>`: 새로 빌드한 웹을 `127.0.0.1:3141` 에서 띄워 확인했다(리스너 PID 27528 = `next start -H 127.0.0.1 -p 3141`, main `679d1ed` + 게이트 변경). 방문자 폴더에 위 기록을 복사해 GET 200. 두 구간 모두 `턴 · 초 · $` 와 `토큰 입력 / 출력`, 모델 `gpt-4.1-mini` 가 보였다. 쓰기 동작은 하지 않았다.
