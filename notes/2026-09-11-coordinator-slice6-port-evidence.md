# coordinator PLAN 6 — Fleet Console 포트 고정 검증 근거

- 검증일: 2026-09-11 (KST, UTC+09:00)
- 대상 저장소: `~\orca\projects\Fleet-Console`
- 대상 브랜치/검증 전 HEAD: `main` / `c148272e33a59e91f07fbd9817b005e3c1bf48a1`
- 범위: `web/package.json`의 `dev`, `start`를 `127.0.0.1:3018`로 고정하고 읽기 전용 HTTP/프로세스 검증을 수행했다. 브라우저 UI 클릭과 쓰기 동작은 수행하지 않았다.

## 변경 전과 포트 사전 확인

2026-09-11 01:00:31 +09:00에 `Get-Content -Raw web/package.json`으로 확인한 변경 전 스크립트는 다음과 같았다.

```text
dev   = next dev
start = next start
```

둘 다 hostname과 port를 지정하지 않았다. 같은 시각대에 `netstat -ano -p TCP`로 LISTEN 상태를 확인한 결과 `127.0.0.1:3017`은 PID 3928이 사용 중이었고, `:3018` 행은 없어 3018이 비어 있었다. `Get-NetTCPConnection`은 샌드박스 권한으로 거부되어, 이후 포트 판정은 변경을 일으키지 않는 `netstat` 결과를 기준으로 삼았다.

변경 후 스크립트:

```text
dev   = next dev --hostname 127.0.0.1 --port 3018
start = next start --hostname 127.0.0.1 --port 3018
```

## 주소 → 프로세스 → 앱 → 저장소/워크트리 대응 기준

로컬 UI에서 쓰기 동작을 허용하려면 다음을 모두 같은 대상으로 확인해야 한다.

1. 주소와 포트가 계획된 값과 일치한다.
2. 그 포트의 LISTEN 소유 PID와 명령줄이 계획된 실행 경로를 가리킨다.
3. 읽기 전용 HTTP 응답의 상태와 앱 표식(이 검증에서는 HTML title 및 `Fleet Console` 본문 문자열)이 일치한다.
4. 실행 저장소/워크트리의 절대 경로, branch, HEAD가 계획된 대상과 일치한다.

같은 앱의 다른 워크트리도 포트만으로 동일시하지 않는다. 반드시 **포트 + 실행 경로 + branch + HEAD** 조합으로 구별한다. 하나라도 다르거나 확인할 수 없으면 UI 클릭·입력·쓰기 API 호출 전에 중단한다.

## 잘못된 대상 3017 안전 게이트

2026-09-11 01:05:05 +09:00에 `http://127.0.0.1:3017/`을 읽기 전용 GET하고 포트 소유 프로세스를 조회했다.

| 항목 | 실제 값 |
|---|---|
| HTTP | `200` |
| 응답 title | `seadevil — 승인 대시보드` |
| LISTEN PID | `3928` |
| 서버 명령줄 | `"C:\Program Files\nodejs\node.exe" "~\orca\workspaces\<다른 프로젝트>\slice20\node_modules\next\dist\server\lib\start-server.js"` |
| 런처 PID/명령줄 | `9548` / `next dev -H 127.0.0.1 -p 3017` (`<다른 프로젝트>\slice20`의 Next CLI) |
| 실행 워크트리 | `~\orca\workspaces\<다른 프로젝트>\slice20` |
| branch / HEAD | `<user>/slice20` / `f6ce0958f7fd2bc21561c6f94dab752f47c11944` |

검증 게이트 입력을 Fleet Console의 기대값(포트 3018, title `Fleet Console`, 저장소 경로 `~\orca\projects\Fleet-Console`)과 비교한 실제 출력은 `PortMatch=False`, `AppMatch=False`, `RepositoryPathMatch=False`, `GateDecision=STOP_BEFORE_UI_WRITE`, `UiClicks=0`, `WriteCalls=0`이었다. 따라서 3017의 기존 <다른 프로젝트> slice20 서버에는 종료·UI·쓰기 호출을 하지 않았다.

## dev 실행 검증

- 실행 시각: dev 포트 소유 프로세스 시작 시각 `2026-09-11 01:09:36 +09:00`
- 실행 root: `~\orca\projects\Fleet-Console\web`
- 명령: `npm run dev`
- 실제 확장 명령: `next dev --hostname 127.0.0.1 --port 3018`
- 서버 출력: `Local: http://127.0.0.1:3018`, `Ready in 8.3s`
- HTTP 검증 시각: `2026-09-11 01:12:49 +09:00`
- HTTP 결과: `http://127.0.0.1:3018/`이 `/runs`로 이동한 뒤 `200`, `Content-Type: text/html; charset=utf-8`, title `Fleet Console`, 본문 `Fleet Console` 표식 있음
- LISTEN PID: `36004`
- PID 명령줄: `"C:\Program Files\nodejs\node.exe" ~\orca\projects\Fleet-Console\web\node_modules\next\dist\server\lib\start-server.js`
- 저장소 root / branch / HEAD: `~\orca\projects\Fleet-Console` / `main` / `c148272e33a59e91f07fbd9817b005e3c1bf48a1`

장기 실행 통합 터미널에 `Ctrl+C`를 전달했으나 Windows PTY가 즉시 자식에게 전달하지 않았다. 이후 팀장이 PID 36004의 명령줄을 위 값으로 재확인한 뒤 **그 검증 프로세스만** 종료했고, 3018에 LISTEN이 없음을 독립 확인했다. 기존 3016·3017 프로세스는 종료하지 않았다.

## build와 start 실행 검증

`start`에 필요한 프로덕션 산출물을 만들기 위해 `npm run build`를 실행했다. 첫 실행은 루트 의존성이 설치되지 않아 `@anthropic-ai/claude-agent-sdk`, `zod`를 찾지 못하고 실패했다. `npm ci`로 루트 잠금파일의 의존성을 설치한 뒤 재실행했고, 2026-09-11 01:24:25 +09:00 이전에 `Compiled successfully`, 정적 페이지 `6/6` 생성으로 성공했다. 의존성 디렉터리는 추적 제외 상태이며 잠금파일 변경은 없었다.

start 직전 `netstat -ano -p TCP` 결과 3016(PID 7936)과 3017(PID 3928)은 LISTEN 중이었고 3018은 비어 있었다.

- 실행 시각: `2026-09-11 01:24:25–01:25:07 +09:00` 사이
- 실행 root: `~\orca\projects\Fleet-Console\web`
- 명령: `npm run start`
- 실제 확장 명령: `next start --hostname 127.0.0.1 --port 3018`
- 서버 출력: `Local: http://127.0.0.1:3018`, `Ready in 349ms`
- HTTP 검증 시각: `2026-09-11 01:25:07 +09:00`
- HTTP 결과: `http://127.0.0.1:3018/`이 `/runs`로 이동한 뒤 `200`, `Content-Type: text/html; charset=utf-8`, title `Fleet Console`, 본문 `Fleet Console` 표식 있음
- LISTEN PID: `17696`
- PID 명령줄: `"node" "~\orca\projects\Fleet-Console\web\node_modules\.bin\\..\next\dist\bin\next" start --hostname 127.0.0.1 --port 3018`
- 부모 PID/명령줄: `7704` / `cmd.exe /d /s /c next start --hostname 127.0.0.1 --port 3018`
- 저장소 root / branch / HEAD: `~\orca\projects\Fleet-Console` / `main` / `c148272e33a59e91f07fbd9817b005e3c1bf48a1`

통합 터미널 세션에 `Ctrl+C`를 보냈고 세션이 종료 코드 1로 닫혔다. 2026-09-11 01:27:44 +09:00 확인 결과 PID 17696은 존재하지 않고 3018 LISTEN도 없었다. 기존 3016(PID 7936)과 3017(PID 3928)은 계속 LISTEN 중이어서 건드리지 않았음을 확인했다.

## 결과

- `dev`와 `start` 모두 `127.0.0.1:3018`을 명시한다.
- dev와 start를 각각 실제로 띄워 HTTP 200, Fleet Console 표식, PID/명령줄, 실행 root/main/HEAD를 확인했다.
- 잘못된 3017 대상은 앱·경로·포트 불일치로 UI 쓰기 전 중단됐고 UI 클릭 및 쓰기 호출은 각각 0회였다.
- 검증을 위해 띄운 3018 서버만 종료했으며, 검증 종료 시 3018은 해제되고 기존 3016·3017은 유지됐다.
