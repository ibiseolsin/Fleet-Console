# 슬라이스 12 설계 — 무료 URL 배포 (2026-09-11 계획, 검토 반영)

계획 세션이 정한 설계를 `PLAN.md` 에서 옮겼다(본문 3줄 규칙). 검토 지적 R1~R8 은
`notes/plan-reviews/2026-09-11-stage2-211bd2d92394/review.md` — 워커는 같은 폴더 `slice-12.md` 에 결과를 남긴다.

## 조사 (공식 문서 열람, 2026-09-11)

- Render Free: 15분 무트래픽 후 절전, 절전 시 로컬 파일시스템 변경 소실, 영구 디스크 불가, 워크스페이스당 월 750 인스턴스 시간
  (https://render.com/docs/free). **Docker 런타임이 Free 에서 되는지와 카드 요구 여부는 문서 셋(free · docker ·
  platform-features-by-plan)에 명시가 없다** — 서비스 생성 화면에서 확인한다.
- 탈락: Hugging Face Docker Space(2026-07부터 유료) · Koyeb(카드 필수) · Fly(무료 없음) · Render Free Postgres(30일 만료).
- GitHub Contents API (https://docs.github.com/en/rest/repos/contents): 시간당 생성 요청 500회 상한
  (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). **1MB~100MB 파일은 JSON GET 의 `content` 가 빈
  문자열·`encoding: "none"`** — 본문은 `Accept: application/vnd.github.raw+json` 으로 받는다(100MB 까지). PUT 은 기존 파일의 `sha` 필수.
- Render 종료 절차(https://render.com/docs/deploys): SIGTERM 뒤 기본 30초 안에 안 끝나면 SIGKILL. 절전에도 같은지는 미명시.

## 기존 진행 (접음)

2026-09-11 Docker·Render 설정, Linux 파견 경로 수정, 이미지 검사·Windows 455개 테스트·로컬 재시작 보존/착륙 검증 완료 —
`notes/slice12-컨테이너배포.md`. 유료 Starter·1GB 디스크·Anthropic 키는 철회.

## 바꾸는 것

- `render.yaml`: `plan: free`, `disk` 제거, env 에 `OPENAI_API_KEY`·`FLEET_STATE_REPO`(owner/repo)·`FLEET_STATE_TOKEN`(sync:false).
  `FLEET_STATE_ROOT=/var/data/fleet` 는 컨테이너 안 일반 폴더 — 엔트리포인트가 root 로 만들어 node 에 넘기는 지금 방식 그대로.
- `scripts/state-sync.mjs` 신설: `restore`(부팅 시 상태 루트가 비어 있으면 최신 tar.gz 를 받아 **같은 절대경로**에 풀기 — 링크드
  워크트리가 절대경로를 갖는다, `scripts/fixture.mjs:219`) · `watch`(`fs.watch` 재귀 — Node 22 리눅스 지원, 3초 디바운스 후
  tar.gz → PUT, 해시 같으면 생략, SIGTERM 에 마지막 1회 flush). 백엔드 둘: `github`(운영) · `dir`(로컬·컨테이너 검사용).
  잠금 폴더(`.lock`·`.quota-lock`)와 `*.tmp`(`<id>.json.<pid>.tmp` 포함) 제외.
- `scripts/container-entrypoint.sh` 순서: **restore → `container-prepare.mjs` → watch → next**. prepare 가 `running` 을
  `interrupted` 로 바꾸고 빈 잠금을 지우므로 restore 뒤여야 한다(R1). watch 는 next 와 함께 **엔트리포인트가 기다리는 자식**으로
  둔다 — 지금은 `exec next` 라 next 가 끝나는 순간 tini 가 종료해 watcher 의 마지막 flush 가 잘린다(R2).
- 절전 중 끊긴 루프는 prepare 와 `readRun`(`src/agent/runs.mjs:66~`)이 `interrupted` 로 판정하고 14 의 `messages`(`closeDangling`,
  `src/agent/loop.mjs:177`)로 이어간다. **앱 코드(`src/`)는 손대지 않는다.**

## 사용자 준비물 — 로컬 검증을 다 끝낸 그 시점에 카드 `wait` 로 요청하고 멈춘다

① Render 가입(무료, GitHub 연결) ② 상태용 비공개 저장소 하나 + 그 저장소 contents 쓰기만 되는 fine-grained 토큰(만료일은 심사기간 뒤)
③ Render 비밀 환경변수에 OpenAI 키·토큰 입력. 값은 채팅에 받지 않는다.

## 함정

- Render 가입이 카드를 요구하거나 Free 에 Docker 런타임이 없으면 멈추고 카드 `wait`(무료 대안이 없음을 함께 적는다).
- PUT 은 GET 으로 `sha` 를 받아 보낸다(409 면 한 번 재시도). 스냅샷 하나가 커밋 하나다 — 상태 저장소는 스냅샷 크기 × 횟수로 자란다
  (방문자 샌드박스 한 벌 0.6~1.8MB, 2026-09-11 로컬 실측 — 첫 방문자부터 1MB 를 넘어 raw GET 이 필요하다). 검사 때 tar 크기와 실행 한 번의
  PUT 횟수를 적는다. 50MB 를 넘으면 방문자 사본 정리.
- 절전 SIGTERM 의 마지막 flush 실패 시 마지막 3초 변경이 유실될 수 있다 — 승인·재개 직후 새로고침으로 저장 여부를 보는 정도로 둔다.
- Render 위에서 `interrupted` 를 실제로 만들기는 어렵다(실행이 수 초에 끝난다) — `interrupted` 경로는 완료 기준 1(seed 의 `running`
  실행)로 보고, Render 에서는 `waiting` 실행의 보존·재개로 본다(R5).
- 첫 방문 픽스처 생성 시간은 슬라이스 11 의 3초 게이트 마지막 판정이다(`notes/slice11-데모격리.md` "다시 볼 조건"). 3초를 넘으면
  공용 샌드박스 하나 + 되돌리기로 물러선다.
