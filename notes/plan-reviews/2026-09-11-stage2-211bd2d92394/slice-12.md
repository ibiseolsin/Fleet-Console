# 2026-09-11-stage2-211bd2d92394 — slice 12 검증

기준 HEAD `9691b43`(워크트리 `slice12`), 구현 diff 있음. R1~R8 전부 12 담당. review.md 는 수정하지 않았다.
실행 상세는 `notes/slice12-컨테이너배포.md` "2차(무료 배포)" 절. 로컬 Docker(Linux 이미지)에서 실행했고, Render 실측은 계정 준비 대기라 미확인.

| id | 결과 분류 | 변경 전 증거 | 변경 후 증거 | 코드 상태/비고 |
|---|---|---|---|---|
| R1 | 확정 | 옛 엔트리포인트에 restore 가 없어 복원 자체가 없었다(재현 대상 아님) | `restore → prepare → watch → next`. 재생성 검사에서 restore 뒤 `state-ready interrupted:1`, verify 가 `running`(pid 1) 실행을 `interrupted`·pid null 로 확인 | `scripts/container-entrypoint.sh` |
| R2 | 확정 | `exec next` 상태에서는 watcher 가 없었다(재현 대상 아님) | (가) `docker stop`(SIGTERM): `stopping → uploaded(final) → stopped` 뒤 컨테이너 종료. (나) 컨테이너 안에서 `next-server`(pid 32) 만 SIGTERM: watcher 가 `uploaded(final)` 하고 컨테이너 `Exited (0)`, 스냅샷 265B 갱신 | 엔트리포인트가 next 를 기다린 뒤 watcher 에 TERM → wait |
| R3 | 확정 | 없음(신규 코드) | `scripts/state-sync-check.mjs`: 가짜 Contents API 가 JSON GET 에 `content:""`·`encoding:"none"` 을 주는 상황에서 raw Accept GET 1회로 1.5MB 파일 복원, 해시 일치 | 본문 raw · sha JSON |
| R4 | 미확인 | — | Render 서비스 생성 화면은 계정이 있어야 본다 — 카드 `wait` | 준비물 ① |
| R5 | 확정 | — | 완료 기준 1 = `container-recreate-check.sh` PASS(`interrupted` 경로). Render 의 `waiting` 보존·재개는 미확인 | 완료 기준 2 대기 |
| R6 | 근거 있음 | — | 실측: 빈 루트 269B · 방문자 한 벌(픽스처+runs) 72,282B · seed 한 벌 79~80KB. 실행 한 번의 PUT 횟수는 Render 에서 잰다 | 3초 디바운스 + 해시 비교로 seed 직후 stop 은 PUT 1회 |
| R7 | 확정 | — | 스냅샷 안 `.state-sync.json` 에 루트 경로를 넣고 다르면 `root-mismatch` 로그. 같은 경로(`/var/data/fleet`) 복원 뒤 픽스처 해시 일치·저장된 승인으로 실제 착륙(verify) | 경로 불일치 시 경고만 |
| R8 | 근거 있음 | Linux 이미지 단독 생성 448ms(1차) | 로컬 Docker 첫 방문 `/` 307 99ms → `/agent` 200 310ms(방문자 샌드박스 생성 포함, 스냅샷 269B→72KB) | Render 실측은 미확인 |

추가 확정 실패 조건 검증 2건(R2-나 next 단독 종료, R3 409 재시도 1회). 실행 미확인: R4 · 완료 기준 2·3.
