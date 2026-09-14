# PLAN 리뷰 2026-09-11-stage2-211bd2d92394
프로젝트/단계/슬라이스: Fleet-Console / 2단계 개정(2026-09-11) / 12 · 13 · 우선 제약 변경 절
리뷰 전 기준: HEAD a1db6a1 / PLAN 미커밋 변경 있음(12·13 재작성, 14 추가 체크, 메모·예산 절)
모델·reasoning·provider: claude-fable-5-1 · reasoning 미제공 · Anthropic (Claude Code)
세션/usage 원천: f0752b7f-4827-4e63-8f5e-211bd2d92394 · `~/.claude/projects/C--Users-----orca-projects-Fleet-Console/<session>.jsonl`
측정 구간: 세션 시작 ~ 커밋 직전 / coverage: partial
토큰: (아래 "토큰 실측" 절)
자식 비용: 없음(서브에이전트 미사용)

기계 검사: `fleet slices` 12·13 태그 `어려움 · 선행: 14` / `선행: 12` 로 읽힘, 모르는 태그 0. `dispatch --dry-run` 은 "PLAN 미커밋" 보류만 —
커밋 뒤 12 가 뜨고 13 은 선행 미완. 번호 14 는 아카이브 최댓값 7·현 단계 8~13 다음이라 중복 없음. 1단계는 접혀 있음.
PLAN 본문은 사용자 지시(완료 기준 3줄 규칙)대로 12·13 을 헤더 + 완료 기준 3줄로 줄이고 설계는 `notes/slice12-무료배포-설계.md` 로 옮겼다.

| id | 슬라이스/검증 담당 | 잘못된 전제와 실패 조건 | 근거 | 반영한 수정 |
|---|---|---|---|---|
| R1 | 12 | 계획의 엔트리포인트 순서 `restore → watch → next` 에 `container-prepare.mjs` 가 없다. 복원된 `running` 실행의 옛 pid 가 새 컨테이너에서 재사용되면 `readRun` 은 `alive(pid)` 가 참이라 `interrupted` 로 못 바꾸고, 빈 잠금(`.lock`·`.quota-lock`)이 복원돼 남는다 | `scripts/container-entrypoint.sh`(현재 prepare 실행) · `scripts/container-prepare.mjs:8~33` · `src/agent/runs.mjs:66~78` | 설계 노트: restore → prepare → watch → next |
| R2 | 12 | "SIGTERM 에 마지막 1회 flush" 는 watcher 가 신호를 받고 끝날 때까지 컨테이너가 살아 있어야 성립한다. 지금 엔트리포인트는 `exec next` 라 next 가 tini 의 유일한 자식 — next 가 먼저 죽으면 tini 가 종료해 컨테이너가 멈추고 백그라운드 watcher 의 PUT 이 잘린다 | `Dockerfile` ENTRYPOINT `tini -g` · `container-entrypoint.sh` 마지막 줄 · https://render.com/docs/deploys (SIGTERM 뒤 30초) | 설계 노트: watcher 를 엔트리포인트가 기다리는 자식으로 |
| R3 | 12 | Contents API 로 tar.gz 를 받는 restore: 1MB 이상 파일은 JSON 응답 `content` 가 비고 `encoding: "none"` 이다. 방문자 샌드박스 한 벌이 0.6~1.8MB 라 첫 방문자부터 걸린다 — restore 가 빈 내용을 풀고 실패한다 | https://docs.github.com/en/rest/repos/contents (1~100MB 절) · `du -sh sandbox/visitors sandbox/demo-check-*` 2026-09-11 | 설계 노트: `Accept: application/vnd.github.raw+json`, `sha` 는 JSON GET |
| R4 | 12 | "Render Free 는 Docker 지원" 을 공식 문서 열람으로 적었으나 free · docker · platform-features-by-plan 세 문서 어디에도 Free 의 Docker 런타임·카드 요구 문구가 없다(2026-09-11 재열람). 서비스 생성 화면에서 막히면 무료 대안이 없다 | WebFetch 셋 결과 | 설계 노트 조사 절을 "미명시" 로 고치고 함정에 Docker 없음 → `wait` 추가 |
| R5 | 12 | 완료 기준 "재배포 뒤 끊긴 실행이 `interrupted` 로 보이며 이어서 끝난다" 는 Render 에서 실행 불가에 가깝다 — 실제 실행은 수 초에 끝나 절전·재배포 순간에 `running` 인 실행을 만들 수 없다. 워커가 기준을 못 채워 체크를 못 한다 | `notes/slice14-openai.md` 대표 실행(16 메시지, 수 초) · `container-check.mjs seed` 의 `running` 실행은 pid 1 가짜 | 완료 기준 1 = container-check(`interrupted`), 완료 기준 2 = Render 에서 `waiting` 실행 보존·재개 |
| R6 | 12 | 스냅샷마다 커밋 하나라 상태 저장소가 크기 × 횟수로 자란다는 사실이 계획에 없다. `writeRun` 이 응답·도구 결과마다 파일을 쓰므로 실행 한 번에 PUT 여러 번 | `src/agent/runs.mjs` 머리말 · 3초 디바운스 | 함정에 tar 크기·PUT 횟수 기록 추가(설계 변경 없음) |
| R7 | 12 | 복원 경로가 다르면 픽스처의 링크드 워크트리가 깨진다(절대경로 `gitdir`) | `scripts/fixture.mjs:219` `git worktree add` | 설계 노트: 같은 절대경로에 복원, `dir` 검사도 컨테이너 안 같은 경로 |
| R8 | 12 | 슬라이스 11 의 3초 게이트 "다시 볼 조건: Render 실측" 이 12 에 없었다 | `notes/slice11-데모격리.md:16` · `notes/slice12-컨테이너배포.md:68` | 완료 기준 3 에 첫 방문 생성 시간 실측 추가 |

13: 실질 지적 0건 — 완료 기준을 3줄로 재배치만 했다. `[선행: 12]` 유지(12 의 배포 링크가 입력). 체크는 사용자 승인 뒤라는 조건은 카드 `wait` 규칙과 일치한다.
우선 제약 변경 절: 이상 없음 — 노트 `notes/handoff-minimum-submission.md` 와 일치.

## 토큰 실측
Claude JSONL `(session id, message.id)` 로 합쳐 응답당 최댓값. 커밋 직전, 마지막 usage 2026-09-11T10:14:06Z, 응답 15개. 최종 답변·카드 미포함(하한값).
토큰: input_total=1610132 cache_read=1512594 cache_write=97088 output_total=27644 reasoning=미제공 total=1637776 non_cache_read=125182 / coverage: partial
