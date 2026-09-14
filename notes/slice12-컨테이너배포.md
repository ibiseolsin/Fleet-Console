# 슬라이스 12 — 컨테이너 준비, Render 배포 대기

> 2026-09-11 후속 사용자 지시로 유료 배포·Anthropic 키 준비 요청을 철회했다. 아래는 변경 전 작업 기록이다.
> 추가 지출 없이 평가 기준 충족에 필요한 최소 범위로 재조정하며, 현재 대기는 계정 준비가 아니라 평가 기준 원문 확인이다.

2026-09-11. 기준 HEAD `4637702`, main에서 구현 diff가 있는 상태로 검증했다.
Render 배포·실제 서버 키를 쓴 모델 실행이 남아 있어 PLAN은 미체크다.

## 변경

- Docker 이미지: Node 22 Debian, git, SDK의 Linux Claude Code 바이너리, Next 프로덕션 빌드.
  의존성은 두 lockfile로 설치한다. 컨텍스트는 앱 소스·검사·익명화 데이터만 허용하며
  `.git`, 로컬 매핑, `.env`, 로컬 의존성·생성물·운영 노트를 제외한다.
- Render: Starter 1대, 1GB `/var/data` 디스크, 상태 루트 `/var/data/fleet`, `/health`,
  `$PORT`, 서버 키 비밀 입력, 하루 20회·실행당 $0.25, 자동 배포 꺼짐.
- 시작 시 마운트 하위 상태 폴더를 준비한 뒤 `node` 사용자로 권한을 낮춘다.
  기존 픽스처·승인·SDK 세션·사용량은 초기화하지 않는다. 독점 디스크를 전제로 남은 빈 잠금을
  해제하고 `running` 기록을 `interrupted`로 바꾼다. 컨테이너 PID 재사용으로 중단된 실행이
  살아 있다고 오인하는 경우도 복구한다. 손상된 기록·비어 있지 않은 잠금은 시작을 실패시킨다.
- 필수 부수 수정: Linux에서 샌드박스 파견이 잘못된 경로를 만드는 오류를 실행기에서 수정했다.
  벤더 `repoRoot`가 Windows 경로 구분자를 반환해 `workspacesDirOf`의 프로젝트 이름이 깨졌다.
  `src/fleet/execute.mjs`의 IO 경계에서 이미 알고 있는 픽스처 프로젝트 경로를 사용한다.
  `sp-sync` 및 판정 규칙은 수정하지 않았다.

## 실행 결과

| 검사 | 결과 |
|---|---|
| 최종 `docker build -t fleet-console:slice12 .` | 통과. 이미지 `sha256:c0505feafc27783fcac34dbf02f6f0cb15a6ab7dc130ef3b0c2e859cc445e158` |
| 이미지 내부 `npm run check` | 통과. 픽스처·읽기 MCP·승인 후 실제 파견/착륙·사용량 검사 |
| 이미지 내부 `npm run web:build` | 통과. 다섯 화면 및 `/health` 포함 |
| Linux 실행 파일 | `git version 2.39.5`, `Claude Code 2.1.267` 실제 호출. 서버 UID 1000 |
| 단독 생성 시간 | `scripts/container-benchmark.mjs`: fixture 332ms + fixture-runs 116ms = **448ms** |
| 다섯 화면 HTTP | `/` 200/336ms, `/runs` 200/18ms, `/approvals` 200/277ms, `/eval` 200/23ms, `/agent` 200/268ms. 모두 Fleet Console 식별 |
| 재시작 | `container-check.mjs seed` → `docker restart` → `verify` 통과. 픽스처 해시·승인 큐·대기 실행 원문·사용량 유지, 잠금 해제, PID 1의 중단 복구, 저장된 승인으로 실제 착륙 |
| Linux `demo-check.mjs` | 두 방문자 파견·착륙·큐 분리, 초기화, 옛 승인 거부, 비용/일일 상한·재시작 우회 방지 통과 |
| Windows `npm test` | **455/455 통과**, 건너뜀 0 |
| 익명화 | 로컬 매핑 패턴으로 변경 파일 0건. 전체 공개 대상은 기존 **23파일 156줄** 일치가 남아 있음 |

재시작 검사에 넣은 실행 기록은 유료 호출 없이 만든 검사 데이터다. 실제 모델의 SDK 세션 재개나
배포본 `/agent`의 끝까지 실행을 확인한 것으로 세지 않는다. HTTP 응답도 화면 클릭 검증과 구별한다.

로컬 쓰기 전 확인: `127.0.0.1:3118` → 컨테이너 `10000`, 포트 소유 PID 22200
(`com.docker.backend.exe services`), 컨테이너 Next PID 6659, 실행 경로 `/app`,
프로젝트 Fleet-Console/main/기준 HEAD `4637702` + 이번 diff로 빌드한 이미지.
재시작 검사 대상 이미지 `639acb6c…`에서 최종 이미지에는 측정 스크립트만 추가됐다.
절대 사용자 경로·비밀 환경변수는 기록하지 않는다.

## 실패 원문과 처리

1. 첫 시도: `Error: fleet_status 실패: … 픽스처가 없습니다. 먼저 node scripts/fixture.mjs 를 실행하세요.`
   검사에 임시 상태 루트를 주었으나 기존 MCP 검사 클라이언트가 그 환경변수를 전달하지 않았다.
   빌드 검사에는 기본 경로를 쓰고, 런타임 이미지에는 검사 생성물을 복사하지 않도록 바꿨다.
2. Linux 파견: `상태 executed — failed — repo 단계에서 실패: 엉뚱한 저장소에 생성됨: (픽스처 밖) (원한 것: cobalt)`.
   위 IO 경계 수정 뒤 동일한 이미지 `npm run check`가 통과했다.
3. Linux 벤더 테스트: `tests 455 / pass 440 / fail 13 / skipped 2`.
   예: `actual: 'spawnSync orca ENOENT'`, `projectHere: … 프로젝트 폴더가 아님`, 절전 사유의 시각 차이.
   Windows 경로·로컬 Orca·시간대에 기대는 테스트가 포함돼 있다. 벤더 코드를 바꾸거나 통과로 숨기지 않았다.
   이미지 빌드의 필수 검사는 앱의 `npm run check`와 웹 빌드로 두고, 전체 벤더 검사는 Windows에서 455/455 확인했다.
4. 익명화 JSON 읽기: `ENOENT … anonymize.local.json`. 반입은 하지 않았으며,
   `anonymize-map.local.md`의 "검증용 금칙어 패턴"을 직접 읽어 추적 파일과 미추적 공개 대상까지 검사했다.
   변경 파일은 0건이지만 전체의 기존 일치는 남아 있으므로 저장소 전체 스캔 0건이라고 주장하지 않는다.

## 결정 (세 줄)

- 방문자별 격리를 유지한다.
- Linux 이미지의 스크립트 단독 생성 448ms가 계획의 3초 게이트를 통과했다.
- Render 실측이 3초를 넘으면 계획에 따라 공용 샌드박스 전환을 다시 검토한다.

## 남은 절차

Render 계정·결제 수단·API 키와 유료 배포 승인이 필요하다. 키는 Render 비밀 환경변수로 입력한다.
`README.md`의 구성과 비용을 확인한 뒤 `render.yaml`로 생성한다. 계정·서비스 생성·결제·원격 배포는 실행하지 않았다.
배포 링크에서 다섯 화면, 실제 키로 실행→승인 대기→승인→착륙, 컨테이너 재시작 후 큐와 SDK 세션 재개,
첫 접속 시간·유휴 후 접속·생성 시간을 확인해야 한다. 512MB에서 모델 실행 시 메모리도 미확인이다.
그 결과를 이 노트와 README에 추가하고 모든 완료 기준을 충족한 뒤에만 PLAN을 체크한다.

Render 공식 근거는 README에 링크했다. 저장소 공개 전환과 기존 자유 문장 검수는 13번 범위다.

## 2차 (2026-09-11) — 무료 배포: Render Free + GitHub 스냅샷

기준 HEAD `9691b43`, 워크트리 `slice12`. 설계는 `notes/slice12-무료배포-설계.md`, 검토 지적 R1~R8 결과는
`notes/plan-reviews/2026-09-11-stage2-211bd2d92394/slice-12.md`. **앱 코드(`src/`)는 손대지 않았다.**

### 바꾼 것

- `scripts/state-sync.mjs` 신설 — `restore`(빈 루트에만, 같은 절대경로) · `watch`(`fs.watch` 재귀, 3초 디바운스, 내용 해시가
  바뀐 때만 tar.gz 업로드, 60초 안전망, SIGTERM/SIGINT 에 마지막 1회) · `hash` · `pack`. 백엔드 `github`(Contents API: 본문 raw
  Accept, sha 는 JSON GET, PUT 409/422 면 sha 재조회 후 한 번 재시도) · `dir`(폴더 하나). 잠금 폴더·`*.tmp` 제외.
  스냅샷 안에 `.state-sync.json`(루트 경로·시각)을 넣어 경로가 다르면 경고한다.
- `scripts/container-entrypoint.sh` — `restore → container-prepare → watch & → next &`, 셸이 next 를 기다린 뒤 watcher 에 TERM 을
  보내고 끝날 때까지 기다린다(`exec next` 폐기).
- `render.yaml` — `plan: free`, 디스크 제거, `FLEET_STATE_REPO`·`FLEET_STATE_TOKEN`(sync:false) 추가.
- `scripts/container-recreate-check.sh` — 완료 기준 1 절차(볼륨 없음, `dir` 백엔드, seed → stop·rm → 새 컨테이너 → verify).
- `scripts/state-sync-check.mjs` — 가짜 GitHub Contents API 로 백엔드 검사(네트워크·토큰 없음).
- `README.md` 배포 절을 Free 플랜·상태 보존 방식·환경변수 표로 고쳤다. 실측 칸은 "미확인" 으로 비워 뒀다.
- 정한 것: Windows 의 GNU tar 가 `C:` 를 원격 호스트로 읽어 tar 인자는 상대경로로 넘긴다(로컬 검사용). Git Bash 에서 검사 스크립트는
  `MSYS_NO_PATHCONV=1` 로 `/snapshot` 을 지킨다. watch 시작 시 현재 내용을 "이미 저장됨" 으로 본다 — prepare 가 바꾼 `interrupted`
  는 다음 변경 때 같이 올라간다(복원 시 prepare 가 다시 만들므로 무해).

### 실행 결과 (로컬 Docker Desktop 29.6.2, 이미지 `fleet-console:slice12`)

| 검사 | 결과 |
|---|---|
| `docker build` | 통과(이미지 안 `npm run check` · `web:build` 포함) |
| 완료 기준 1 `sh scripts/container-recreate-check.sh` | **PASS** — seed 뒤 `docker stop` 에 `uploaded(final)` 79,165B, 컨테이너 삭제, 새 컨테이너 `restored` 82ms → `state-ready interrupted:1` → verify 통과(픽스처 해시·큐·대기 실행 원문·`used:7` 보존, 잠금 없음, `running`→`interrupted`, 저장된 승인으로 실제 착륙) |
| 운영 중 업로드 | 파일 하나 수정 → 3초 뒤 `uploaded(change)` 269B. 첫 방문(`/` 307 99ms → `/agent` 200 310ms) 뒤 72,282B |
| next 단독 종료 | `next-server` 에만 SIGTERM → watcher `uploaded(final)` → 컨테이너 `Exited (0)` |
| `node scripts/state-sync-check.mjs` | PASS — raw GET 으로 1.5MB 복원, 두 번째 PUT 에 sha, 409 → 재시도 1회, 빈 루트에만 복원 |
| Windows `npm run check` | 통과(워크트리에 `npm ci` 뒤) |
| Windows `npm test` | 455/455 |
| 익명화 §4 (변경·신규 파일 6개) | 0건 |

스냅샷 크기 실측: 빈 루트 269B · 방문자 한 벌 72KB · seed 한 벌 80KB(1차 노트의 0.6~1.8MB 는 실행 기록이 쌓인 방문자 폴더 기준).

### 남은 것 — 사용자 준비물 뒤 (카드 `wait`)

완료 기준 2·3 은 Render 서비스와 상태 저장소가 있어야 한다: ① Render 가입(무료, GitHub 연결) ② 상태용 비공개 저장소 하나 +
그 저장소 Contents 쓰기만 되는 fine-grained 토큰 ③ Render 비밀 환경변수에 `OPENAI_API_KEY`·`FLEET_STATE_REPO`·`FLEET_STATE_TOKEN`.
Free 에서 Docker 런타임이 되는지·카드 요구 여부는 생성 화면에서 본다(R4). 준비되면: 배포 링크 다섯 화면 → `/agent` 실행·승인·착륙(실제
OpenAI) → 수동 재배포 뒤 `waiting` 실행·큐·오늘 횟수 보존과 이어서 끝내기 → 절전 첫 접속·첫 방문 생성 시간 → 요금·사용량 화면으로 지출 0.

### 3차 (2026-09-14) — 배포 전 자격증명 확인 수단

사용자 준비물이 아직 없어(가입 전) 완료 기준 2·3 은 그대로 대기다. 그 대기 시간에 **Render 에서만 드러나던 실패를
로컬에서 먼저 거르도록** 한 가지를 붙였다.

- `scripts/state-sync.mjs preflight` 신설 — 실제 저장소·토큰으로 `<path>.preflight` 한 파일을 올렸다가 raw 로 받아 바이트를
  대조한다. **스냅샷(`state.tar.gz`)은 건드리지 않는다.** 실패하면 `hint` 로 401 토큰 · 403 Contents 권한 · 404 저장소 이름 ·
  409 동시 쓰기를 구분해 낸다. 확인용 파일 하나는 저장소에 남긴다(지워도 무해 — 다음 PUT 이 sha 를 다시 받는다).
- `scripts/state-sync-check.mjs` 에 (5) 추가 — 가짜 Contents API 에 경로별 슬롯을 둬, preflight 가 스냅샷 슬롯의 sha·내용을
  바꾸지 않고 자기 경로에만 PUT 하는 것과 두 번째 호출이 기존 sha 로 덮는 것을 확인한다. `FLEET_STATE_REPO` 없으면 거부한다.
- `README.md` 에 "Render 배포 절차 (사람이 하는 부분)" 6단계 — 비공개 상태 저장소 · fine-grained 토큰(Contents 쓰기 **하나만**) ·
  preflight · Render 생성 화면에서 Free+Docker·카드 요구 확인(R4) · 비밀 환경변수 셋 · URL 인계.

검사: `node scripts/state-sync-check.mjs` PASS(5항목) · `npm run check` 통과 · `npm test` 455/455 · 익명화 §4 변경 파일 0건.
저장소 전체 스캔의 935건은 매핑 파일 "결정 필요" 의 `sp-sync` 이름 건으로, 소유자 결정 사안이라 그대로 뒀다(슬라이스 13 `§0`).

**실물 확인 (2026-09-14)** — 상태 저장소 `ibiseolsin/fleet-console-state`(비공개, `main`)와 그 저장소 하나만 대상인 Contents 쓰기
토큰으로 `preflight` 2회 통과: 1회차 82B 1,669ms(생성 PUT, sha 없음) · 2회차 1,984ms(기존 sha 로 덮는 PUT — 운영 중 계속 도는 경로).
`gh api`(다른 인증 경로)로 저장소에 `state.tar.gz.preflight` 82B 와 커밋 2개가 실제로 생긴 것을 따로 확인했다. 확인용 파일은 남겨 뒀다.
같은 날 이 프로젝트의 origin 을 `<이전 계정>/Fleet-Console` → `ibiseolsin/Fleet-Console`(비공개, 36커밋 전부) 로 옮겼다 — 상태 저장소와
같은 계정이라 토큰 범위가 단순해진다. 옛 원격은 `<이전 계정>` 이름으로 남겨 뒀다.

**여전히 막힌 것**: ① Render 가입 ② Render 비밀 환경변수 셋(`OPENAI_API_KEY`·`FLEET_STATE_REPO`·`FLEET_STATE_TOKEN`). 배포 URL 이 나오면 완료 기준 2·3.

### 4차 (2026-09-14) — Render Free 배포본 검증

서비스 `fleet-console-d7c5.onrender.com`(Free · Docker · 0.1 CPU · 512MB · $0/month). 생성 화면에서 **Free 에 Docker 가 있고 카드를
요구하지 않는 것**을 확인했다(설계 노트 R4 의 열린 질문 — 닫혔다). 일반 Web Service 흐름은 `render.yaml` 을 읽지 않아 환경변수를
손으로 넣었다. 이미지에 `FLEET_STATE_ROOT`·`PORT` 가 박혀 있고 실행 상한은 코드 기본값이라 비밀값 셋만 넣으면 됐다.
Health Check Path 는 Render 기본 예시가 `/healthz` 라 `/health` 로 고쳤다(이 앱의 유일한 라우트이고, 상태 루트 쓰기 가능 여부까지 본다).

**완료 기준 2 — PASS**

| 단계 | 결과 |
|---|---|
| 다섯 화면 | `/` 307 · `/runs` 200(275KB) · `/eval` 200(262KB) · `/agent` 200 · `/approvals` 200 |
| 실제 OpenAI 실행 | `fleet_status` → `fleet_slices` → `fleet_land beacon/slice3` **거부**(자격 없음: 턴 진행 중) → `fleet_land atlas/slice2` **승인 대기** `apr_b6f1ad2c60`. 구간 1: 턴 4 · 9초 · $0.0023 |
| 절전 뒤 보존 | 15분 방치 → 첫 접속 52.3초. 실행 `승인 대기` · 큐 1건(자격·머지 결과·완료체크 원문) · **오늘 1/20회** 전부 남았다 |
| 승인 → 착륙 | 큐에서 승인 → "승인한 작업 실행" → **머지 완료 (PR #1)**, `sandbox://atlas/pull/1`, 단계 로그 check→push→pr create→final→pr merge→worktree rm |
| 이어서 끝내기 | 구간 2 턴 2 · 4초 · $0.0010 → `끝남`. 총 도구 5회 · **$0.0033**. 오늘 **2/20회**(시작·이어가기 각 1회) |

구간 2 에서 모델이 `fleet_land` 를 다시 부른 것은 **거부**됐다 — 사람이 큐에서 이미 실행해 워크스페이스가 없다. 슬라이스 14의
"에이전트 실행당 쓰기 1회" 가 절전을 건너서도 지켜졌다는 뜻이고, 모델은 그 사유를 읽고 다음 후보를 보고하며 끝냈다.

**완료 기준 3 — 실측 둘 완료, 지출 확인은 사람 화면**

절전 첫 접속 **52.3초**(TTFB 52.2초), 첫 방문 픽스처 생성 **3.3~4.0초**(새 쿠키 3회) — 둘 다 `README.md` 에 적었다.
3초 게이트 판정과 격리 유지 근거는 `notes/slice11-데모격리.md`. Render 요금은 생성 화면 `$0/month` 로 확인했고,
소유자가 2026-09-14 두 화면을 열어 **둘 다 $0** 임을 확인했다 — Render 청구액 $0, OpenAI 사용량은 교육기관 크레딧 안. 앱이 스스로 잰 이번 실행 비용은 $0.0033 이다.

스냅샷: `state.tar.gz` 296KB, 커밋 12개(변경마다 하나). preflight 확인 파일 82B 는 그대로 뒀다.

### 5차 (2026-09-14) — 수동 재배포로 보존을 한 번 더 확인

제외를 반영해 푸시하고 Render 에서 **Manual Deploy** 를 눌렀다. 완료 기준 2가 요구한 두 경로 중
앞서 절전 경로만 확인했는데, 이번에 **수동 재배포 경로도 확인됐다**.

| 확인 | 결과 |
|---|---|
| `/runs` 회차 링크 | 241 → **185** (제외 반영) |
| 배포본의 `project-a`·`project-b` | **0건 · 0건** |
| 오늘 실행 횟수 | **9/20 유지** — 컨테이너가 새로 떴는데도 남았다 |
| 방문자 실행 기록 | 04:14 실행이 `끝남` 상태로 그대로 (턴 2 · 도구 5회 · $0.003) |
| `/health` | 200 · 0.24초 (배포 직후라 따뜻하다) |

컨테이너를 새로 만들어도 GitHub 스냅샷에서 상태가 돌아온다는 것을 **절전·재배포 두 경로에서** 봤다.
