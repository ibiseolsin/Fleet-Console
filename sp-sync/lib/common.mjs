/**
 * 공용 — 경로·설정·로그, `state.json` 락, SP REST, 프로젝트 매핑. 다른 모듈은 전부 여기에 의존하고
 * 여기는 아무 모듈에도 의존하지 않는다.
 *
 * `SELF` 는 진입점(`sp-sync.mjs`)이다 — 훅 설정과 분리 자식(`node SELF …`)이 그 경로를 부른다.
 * `CODE_FILES` 는 진입점 + 이 폴더의 모듈 전부 — 회차 도중 코드가 갱신됐는지(`selfHash`)는
 * 파일 하나가 아니라 이 목록을 본다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, rmdirSync, rmSync, renameSync } from 'node:fs';
import { join, basename, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const DIR = join(HOME, '.sp-sync');
const STATE_FILE = join(DIR, 'state.json');
const CONFIG_FILE = join(DIR, 'config.json');
const LOG_FILE = join(DIR, 'log.txt');
const NODE = process.execPath;
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(LIB_DIR, '..', 'sp-sync.mjs');
// 진입점 + 모듈 전부. `selfHash` 가 이 목록을 통째로 해시한다 — 모듈 하나만 바뀌어도 "코드 갱신됨"이다.
const CODE_FILES = [SELF, ...readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs')).sort().map((f) => join(LIB_DIR, f))];

const DEFAULT_CONFIG = {
  port: 3876,
  host: '127.0.0.1',
  timeoutMs: 2500,
  // SP에 같은 이름의 프로젝트가 없을 때: 'inbox' = 제목에 [프로젝트] 접두사 붙여 Inbox로, 'skip' = 아무것도 안 함
  fallback: 'inbox',
  // 계획에 없어서 새로 만든 태스크를 오늘 할 일(dueDay)로 넣을지.
  // 기본 false — 자동 생성물이 오늘 계획을 오염시키지 않도록 백로그에 쌓는다.
  planForToday: false,
  // 오늘 계획 후보가 여러 개일 때 claude CLI로 판정할지 (false면 항상 새 태스크)
  askClaude: true,
  // claude -p 실행 파일. PATH에 있으면 그대로 둔다.
  claudeBin: 'claude',
  // 판정 모델. 못 박아 둔다 — null 로 두면 사용자가 /model 로 작업 모델을 바꿀 때
  // 판정 모델까지 조용히 따라 바뀐다. 오푸스로 바꿔두면 판정도 오푸스로 돈다.
  // 속도로 고를 이유는 없다: 2026-08-25 실측에서 haiku 와 sonnet 둘 다 4.4초로 같았다.
  // 병목은 요약 자체가 아니라 매번 Claude Code 시스템 프롬프트를 새로 올리는 비용이다.
  claudeModel: 'sonnet',
  // 판정 제한 시간. 백그라운드 워커 안이라 훅 타임아웃과 무관하다.
  claudeTimeoutMs: 90000,
  // 이 길이 미만의 프롬프트로는 태스크를 만들지 않음 (ok, ㅇㅇ, 계속 같은 잡음 방지)
  minPromptLen: 8,
  // 세션 태스크 제목 최대 길이
  titleMaxLen: 80,
  // 세션 경과 시간을 timeSpent 로 기록할지. 기본 false — 이 값은 벽시계 시간(자는 시간,
  // 다른 창에서 일한 시간 포함)이라 작업 시간이 아니다. 한 태스크에 25.9시간이 찍힌 적이 있다.
  // 쓰면 안 되는 값을 SP 에 계속 밀어 넣을 이유가 없다.
  trackTime: false,
  // 저장소 폴더명 → SP 프로젝트 제목 (이름이 다를 때만)
  // 예: { "vn_project": "Project x" }
  projectAliases: {},

  // --- 복귀 카드 ---
  // 전 프로젝트 카드를 모은 status.md 를 워크트리 루트에 쓸지 (Orca 파일 트리에서 눌러 본다)
  board: true,
  // 이보다 오래된 카드는 status.md 에서 뺀다. 끝난 세션이 남아 있으면 현재 상태로 오해된다.
  boardMaxAgeHours: 12,
  // 일한 창의 카드가 최신 카드보다 이만큼 낡았으면 자리를 내준다. 오전에 커밋한 창이
  // 오후 내내 붙어 있는 걸 막는다 — 그 창은 이미 몇 시간째 아무것도 안 하고 있다.
  boardWorkedGraceHours: 2,
  // 한 워크트리에서 보여줄 창 수. 1이면 가장 최근 것 하나만 — 돌아왔을 때 되찾을 건
  // "지금 뭐 하고 있었나" 하나뿐이고, 옆 창 사정은 그 창에 가면 상태줄에 있다.
  boardMaxPerWorktree: 1,
  // 한 줄의 길이 상한. Orca 에디터 패널은 좁아서 (한 줄에 한글 40자 남짓) 여기서 안 자르면
  // 세 줄짜리 카드가 열 줄이 된다. 전문은 상태줄과 Orca 코멘트에 그대로 남는다.
  boardFieldMax: 90,
  // "한 일"에 보여줄 커밋 수. 이 세션이 낸 것 중 최근 것부터.
  boardCommits: 3,
  // "남은 일"에 보여줄 미완 태스크 수. 넘어오자마자 뭘 시킬지 고르는 재료다.
  boardTasks: 5,
  // fleet status 표에서 지금/대기/다음 한 칸의 너비(터미널 칸 수). 전문은 --json 에 있다.
  fleetFieldMax: 36,
  // 예상 완료 계산에서 실측 속도가 없을 때 "회차당 1슬라이스"로 놓는데, 그 한 회차의 길이(시간).
  // coordinator 회차는 지시~완료 한 사이클이고 세션 한도 창(5시간) 안에 하나가 도는 것이 보통이다.
  fleetRoundHours: 4,
  // 실측 속도를 재는 PLAN.md 이력의 커밋 수 상한. 더 보면 옛 속도가 지금 속도를 가린다.
  fleetPaceCommits: 30,
  // fleet dispatch: 프로젝트당 동시에 띄우는 워크스페이스 수. `--max` 로 회차마다 덮는다.
  // 3 인 이유는 한도(세션 5시간 창)를 여럿이 나눠 쓰기 때문 — 더 띄우면 다 같이 느려진다.
  fleetMaxWorkspaces: 3,
  // fleet dispatch: **모든 프로젝트를 합친** 동시 워크스페이스 수의 상한 (슬라이스 42). 프로젝트별 상한
  // (`fleetMaxWorkspaces`)만 있던 동안에는 프로젝트가 셋이면 최대 아홉 개가 같이 돌 수 있었는데, 한도도
  // 기계도 계정 단위라 그때는 전부가 같이 느려진다. 4 인 이유는 프로젝트별 3 에 "다른 프로젝트 하나"를
  // 더한 값 — 한 프로젝트가 자기 상한을 다 써도 옆 프로젝트가 한 자리는 받는다.
  fleetMaxWorkspacesTotal: 4,
  // `[어려움]` 슬라이스를 띄울 모델. 전역 규칙의 "최상위". 모델 이름이 바뀌면 여기만 고친다.
  fleetHardModel: 'fable',
  // 보통 슬라이스를 띄울 모델. 전역 규칙의 "표준". **명시하지 않으면 사용자의 Claude Code 기본값
  // (`~/.claude/settings.json` 의 `model`)을 따라간다** — 2026-08-30 에 그 기본이 Fable 이던 동안
  // `[어려움]` 아닌 슬라이스 둘이 Fable 로 떴다. 그래서 파견이 매번 못 박는다.
  // `[1m]` 은 다른 모델이 아니라 컨텍스트 창 변종이다. 워커는 긴 파일을 여럿 읽으므로 붙여 둔다.
  fleetModel: 'opus[1m]',
  // --- 헤드리스 워커 (4단계) ---
  // 에이전트 프로필. 키가 슬라이스 태그 `[에이전트: <이름>]` 과 `fleetProjectAgent` 의 값이다.
  // **코드가 특별히 아는 이름은 `claude`(TUI) 하나뿐**이고 나머지는 전부 이 표에서 읽는다 —
  // opencode·gemini 는 나중에 여기 줄 하나로 붙는다. 프로필에 없는 이름은 그 슬라이스만
  // "모르는 에이전트" 로 보류된다 (모르는 태그와 같은 경로).
  //
  // `args` 의 자리표시자는 셋이다. 셸을 안 거치고 인자 배열로 그대로 넘기므로 따옴표가 필요 없다:
  //  - `{path}`   워크스페이스 경로
  //  - `{prompt}` 지시 문장 (통째로 한 인자)
  //  - `{hard}`   `[어려움]` 이면 그 프로필의 `hard` 배열로 펼쳐지고, 아니면 **사라진다**(인자 0개)
  fleetAgents: {
    // codex 0.152.0. `exec` 에 `-a` 는 **없다** — 넣으면 파싱 오류로 즉시 exit 2(2026-09-02 slice6 첫 파견).
    // **샌드박스는 유지하고 승인은 자동 심사에 맡긴다**(`--approve-for-me` = workspace-write + on-request +
    // approvals_reviewer=auto_review). 처음엔 `--dangerously-bypass-approvals-and-sandbox` 였다 — 실측(2026-09-02,
    // `507a965`)에서 `workspace-write` 가 링크된 워크트리의 `git commit`(본체 `.git/worktrees/<이름>/index.lock`
    // 쓰기)과 `~/.sp-sync/drop` 카드 쓰기를 막았고 `writable_roots` 로도 안 풀렸기 때문이다. 그러나 bypass 는
    // Claude 워커 `auto` 모드(분류기 심사 있음)보다 훨씬 약한 보호라 2026-09-03 에 되돌렸다: 자동 심사가 카드 쓰기와
    // `.git` 잠금 쓰기를 승인하는 것을 본체 저장소에서 실측했다(링크된 워크트리에서는 첫 파견이 확인한다).
    // **네트워크는 워커에 연다**(`sandbox_workspace_write.network_access=true`) — workspace-write 기본은 차단이라
    // npm install·스크래핑 테스트가 슬라이스마다 승인을 타게 되므로 사용자 결정(2026-09-03)으로 열었다.
    // AGENTS.md 는 저장소 루트 것만 읽고 기본 32KB 에서 잘리므로 `project_doc_max_bytes` 를 올린다.
    //
    // `[어려움]` 은 **모델이 아니라 추론 강도**를 올린다 (`minimal|low|medium|high|xhigh`).
    // 쓸 수 있는 모델 이름은 계정마다 다르고(이 PC 기본은 gpt-5.6-terra) exec 에서 되는지
    // 확인하지 못했다 — 모델로 바꾸려면 이 `hard` 를 `['-m', '<이름>']` 으로 고치면 된다.
    codex: {
      cmd: 'codex',
      args: ['exec', '-C', '{path}', '--approve-for-me', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'project_doc_max_bytes=131072', '{hard}', '{prompt}'],
      hard: ['-c', 'model_reasoning_effort="xhigh"'],
    },
    // Antigravity CLI(agy) 1.1.23, `~/AppData/Local/agy/bin/agy.exe`. cwd 가 워크스페이스라 경로 인자가 없다.
    // `--print-timeout` 기본이 5분이라 **반드시 올린다**(Go duration 꼴) — 슬라이스 하나가 5분에 안 끝난다.
    // 헤드리스에서는 권한 프롬프트를 받을 수 없으니 `--dangerously-skip-permissions` 가 기본이다
    // (Claude 의 `auto` 모드에 해당). `--sandbox` 를 겹칠 수 있다는 설명은 agy 자답일 뿐 실측하지 못했다
    // (2026-09-02 개인 한도 초과). 사용자가 Antigravity 도입을 다시 꺼낼 때 확인한다.
    antigravity: {
      cmd: 'agy',
      args: ['-p', '{prompt}', '--dangerously-skip-permissions', '--print-timeout', '4h', '{hard}'],
      hard: ['--model', 'gemini-3.1-pro-high'],
    },
  },
  // --- 한도 읽기 (5단계, `lib/limits.mjs`) ---
  // 마지막으로 읽힌 한도 값이 이보다 오래됐으면 **모른다**(null)로 본다. 모르면 막지 않으므로
  // 짧게 잡을수록 "여유" 쪽으로 기운다. 3시간인 이유는 5시간 창의 절반 남짓이라 그 안의 값이면
  // 아직 같은 창의 이야기이기 때문이다. Claude 캐시는 Claude 창이 하나라도 열려 있으면 상태줄이
  // 몇 초마다 갱신하고, codex 는 턴이 끝날 때만 쌓이므로 이 값에 실제로 걸리는 건 codex 쪽이다.
  limitStaleMin: 180,
  // codex 한도를 찾을 때 훑을 최신 rollout 파일 수. 첫 요청부터 막힌 턴의 rollout 에는
  // `rate_limits` 가 아예 없어서 한두 개는 건너뛰게 된다. 이 안에 하나도 없으면 최근에 성공한
  // 턴 자체가 없다는 뜻이라 더 파고들어도 묵은 값만 나온다.
  limitCodexScan: 12,
  // --- 자동 인계 (5단계, 슬라이스 13) ---
  // 한도에 막힌 워크스페이스를 **누가 이어받는가**: { "codex": "claude", "claude": "codex" }.
  // **비어 있으면 자동 인계가 없다 — 지금 동작 그대로다.** 회차는 막힘으로 보고만 하고, 인계는
  // 손 명령(`fleet handoff`)만 남는다. 판정이 몇 번 맞는 것을 본 뒤에 켜라는 뜻이다(2026-09-02 결정).
  fleetFallback: {},
  // 파견 직전에 그 에이전트의 5시간 사용률이 이 값 이상이면 안 띄우고 보류한다("한도 임박").
  // 100 은 늦다 — 이미 막힌 뒤이고, 그 워크스페이스는 만들어지자마자 첫 턴이 죽어 사람 몫으로
  // 남는다(그 자리를 되살리는 길은 인계뿐이다). 95 는 5시간 창의 마지막 5% 로, 슬라이스 하나를
  // 시작해 볼 만한 여유는 아니지만 다음 회차(30분)에는 대개 풀려 있는 폭이다.
  // 0 이나 음수면 이 게이트를 끈다. `[어려움]` Claude 슬라이스는 Fable 의 모델 한도도 같이 본다.
  fleetLimitStartPct: 95,
  // 초기화까지 이 분 안이면 **인계하지 않고 기다린다.** 30분인 이유는 시계 회차 간격과 같아서다 —
  // 그 안이면 다음 회차가 어차피 풀린 한도로 다시 판정한다. 남의 에이전트로 넘기는 값은 워크스페이스
  // 하나가 통째로 다른 손에 가는 것이라, 30분을 아끼자고 치를 값이 아니다.
  fleetLimitWaitMin: 30,
  // --- 한도 해제 뒤 자동 재개 (9단계, 슬라이스 43) ---
  // 한도에 막혀 인계되지 못한 워크스페이스를 초기화 뒤 같은 창에서 몇 번까지 깨울지. 시도마다 회차 하나라
  // 2 는 "한 시간 안에 두 번" 이다 — 두 번 깨웠는데도 슬라이스가 안 끝나면 한도가 아니라 다른 것이 막고
  // 있는 것이니 사람에게 간다(결정 항목 "재개 N회 실패"). 1 이면 한 번만.
  fleetResumeMax: 2,
  // 프로젝트별 기본 에이전트: { "<프로젝트 이름>": "codex" }. 이름은 `fleetChecks` 와 같은
  // 잣대다 — `fleet slices` 표 머리에 나오는 이름(폴더명, `projectAliases` 가 있으면 그 값).
  // **슬라이스 태그가 이긴다.**
  // 비어 있으면 `claude` — 지금 동작 그대로다.
  fleetProjectAgent: {},
  // 준비 신호(훅 파일 + 화면의 `❯` + TUI 유휴)를 기다리는 상한. Orca 설정 스크립트가 약 1분 걸린다.
  fleetReadyMs: 300000,
  // 지시를 보낸 뒤 제출 흔적을 몇 번 볼지 / 그 사이 간격. 흔적(`❯ 그 글`·스피너)이 뜨는 데
  // 시간이 걸려서, 한 번만 보면 아직 안 뜬 화면을 미제출로 읽는다.
  fleetSubmitTries: 3,
  fleetSubmitWaitMs: 3000,
  // orca worktree/terminal create 한 번의 상한. 체크아웃과 설정 스크립트가 여기 들어간다.
  fleetCreateMs: 300000,
  // fleet land: "지금 유휴인가"를 보는 대기. 짧아야 한다 — 작업 중인 창을 기다리는 게 아니라
  // 지금 손이 멈춰 있는지만 보는 것이다. 길게 잡으면 도는 창 앞에서 회차가 통째로 선다.
  fleetIdleMs: 5000,
  // fleet land: 마지막 화면 출력이 이만큼 지나야 "끝났다"로 본다. **훅 기록이 없는 창에만** 걸린다
  // (`outputQuiet`). 2026-08-30 slice10("Committed, tree clean. → Writing the return card") 뒤에
  // 넣을 때의 근거는 "`tui-idle` 이 도구 호출 사이의 짧은 유휴도 완료로 잡는다" 였는데 그건
  // 2026-09-07 실측에서 거짓이었다(열린 턴 37/37 시간 초과). 지금 근거는 훅 기록이 없는 창은
  // Claude 가 떴는지조차 모르는 창이고 그 화면에서는 `tui-idle` 이 통과한다는 것이다 —
  // `fleet.mjs` 의 `outputQuiet` 머리 주석.
  fleetQuietMs: 120000,
  // 충돌 해소를 시킨 뒤 워커를 기다리는 상한. 그 세션이 머지하고 커밋할 시간이다.
  // 충돌 루프가 push 까지 하게 된 뒤(818e741)로는 한 번에 풀린다 — 600초×2회는 Orca precheck
  // 상한(540초)을 넘겨 회차를 통째로 끊을 뿐이라 240초로 내렸다 (2026-08-31).
  fleetConflictMs: 240000,
  // 충돌 해소 재시도 횟수. 넘으면 사용자 결정으로 넘긴다 (원본 §2).
  fleetConflictTries: 2,
  // gh 명령 하나의 상한.
  fleetGhMs: 120000,
  // 착륙 전에 워크스페이스에서 돌릴 프로젝트별 검사 명령. 예: { "project-b": "pytest -q" }
  // 자동 머지를 허용한 만큼 한 겹 더 두고 싶을 때만 채운다. 비어 있으면 게이트가 없다.
  fleetChecks: {},
  // 그 검사 명령의 상한.
  fleetCheckMs: 600000,
  // 자동 회차에서 잠깐 빼 둘 프로젝트 이름(폴더명). `fleet pause|resume` 이 넣고 뺀다.
  // 리뷰·계획 수정 중인 프로젝트에 파견이 계속 들어가는 걸 막는 스위치다. coordinator precheck 도
  // 이 배열을 읽어 `--project` 에서 제외하지만, `fleet cycle` 자체도 읽는다 — precheck 를 안
  // 거친 수동 실행이 다른 결과를 내면 스위치를 믿을 수 없게 된다.
  fleetPause: [],
  // 파견·착륙·인계는 안 하지만 **본체 동기화(push/ff)는 하는** 프로젝트. `fleetPause` 와 다르다 —
  // pause 는 그 프로젝트를 회차에서 통째로 빼(동기화도 안 한다), 이 목록은 "슬라이스 단위로
  // 돌지 않는 저장소" 를 뜻한다. coordinator 이 그렇다: 팀장이 직접 커밋하는 저장소라 워커에게
  // 나눠 줄 슬라이스가 없지만, 그 커밋도 누군가 push 해야 한다 — 세션은 push 를 하지 않으므로
  // (`~/orca/CLAUDE.md`) 회차가 맡는다. 예전에는 이름 'coordinator' 이 코드 두 곳에 박혀 있어
  // 동기화까지 같이 빠졌고 본체가 15 커밋 밀렸다 (슬라이스 41).
  fleetNoDispatch: ['coordinator'],
  // fleet cycle 의 회차 보고가 쌓이는 폴더. 팀장 세션이 여기 있는 것을 읽는다.
  cycleRunsDir: './sandbox/runs',
  // 워커·본체 세션의 턴이 끝날 때 회차를 바로 부를지 (슬라이스 20). 끄면 시계 자동화만 남는다.
  fleetTrigger: true,
  // 그 회차 precheck 스크립트. 회차 자체(착륙 → 파견 → 보고)는 이 안에서 돈다.
  // `'builtin'` 이면 외부 스크립트 대신 이 도구의 `fleet precheck` 를 같은 프로세스에서 부른다 (슬라이스 38) —
  // 지난 자동 회차 세션 닫기는 coordinator 스크립트에만 있으므로, 그걸 원하면 coordinator 쪽을 한 줄 위임으로 바꾼다.
  fleetPrecheck: './sandbox/scripts/cycle-precheck.mjs',
  // precheck 가 0 을 내면 깨울 Orca 자동화 id. **비어 있으면 회차만 돌고 팀장 세션은 안 깨운다** —
  // 사용자는 대응 가능한 낮에는 자동화를 꺼 두고 잘 때만 켜는 안전망으로 쓴다 (꺼진 자동화도 수동 run 은 된다).
  fleetAutomationId: '',
  // 회차가 "도는 중"으로 보는 창. 그 안이면 새 회차를 안 띄운다 — 회차 둘이 같은 워크스페이스를
  // 착륙시키면 안 된다. Orca precheck 상한(600초)과 같은 값이다.
  fleetTriggerLockMs: 600000,
  // 턴 끝의 3줄을 Orca 워크트리 메모 칸(comment)에도 보낼지.
  // 매 턴이 아니라 의미 있는 매듭에만 쓴다 — Orca 가이드가 "at meaningful checkpoints"라고 명시한다.
  // 통째로 끄고 싶으면 false. 그래도 status.md 는 그대로 돌다.
  orcaCard: true,
  // orca CLI. 윈도우에서는 .cmd가 아니라 .exe를 직접 부른다 (execFile은 셸을 안 거친다)
  orcaBin: process.platform === 'win32' ? 'orca.exe' : 'orca',
  // Orca 앱의 상태 파일. **읽기만 한다** — 앱이 통째로 메모리에 들고 있다가 덮어쓰므로 손대면 사라진다.
  // 절전(Agent sleep)으로 잠든 에이전트 창은 `terminal list`·`worktree ps` 어디에도 안 나오고 이 파일의
  // `workspaceSession.sleepingAgentSessionsByPaneKey` 에만 남는다 (슬라이스 28, `notes/2026-09-07-agent-hibernation-실측.md`).
  // 빈 문자열이면 기본 위치 `%APPDATA%/orca/profiles/local-default/orca-data.json` (`wake.mjs` 의 `ORCA_DATA_FILE`).
  orcaDataFile: '',
  // 상태줄용 카드 파일 보관 일수
  cardKeepDays: 7,
  // tasks review: 마지막 귀속 커밋·세션 활동이 이만큼 조용하면 "완료 제안"으로 올린다.
  // 7일인 이유는 세션 기록 보관 일수와 같다 — 그보다 짧게 잡으면 아직 state.json 에 남아
  // 있는 세션의 활동을 근거로 쓰는 셈이라, 근거가 "조용하다" 하나뿐인 태스크가 표에 오른다.
  tasksStaleDays: 7,
  // tasks drift: 마감이 없는 태스크가 이만큼 아무 활동 없이 지나면 "표류"로 들춘다.
  // 14일인 이유는 완료 회수 기준(7일)의 두 배다 — 7일로 잡으면 회수 표에 오를 만한 것이
  // 표류 표에도 그대로 올라 두 표가 같은 말을 하게 된다. 여기서 찾는 것은 "조용해서 끝난 것 같다"가
  // 아니라 "마감을 안 잡아 둔 채 두 주가 지났다"라, 한 주기(주 단위 계획) 이상 지난 것이라야 뜻이 있다.
  tasksDriftDays: 14,
  // tasks today: 오늘 편성으로 한 번에 제안하는 태스크 수. 5인 이유는 "오늘 하루" 라서다 —
  // 미완 최상위가 Orca 프로젝트만 50개대라 순위를 매겨도 열 줄이 넘으면 고르는 일이 다시 사람 몫이 된다.
  // 순위가 낮은 것은 다음 날 그대로 다시 오르므로 잘라도 잃는 것이 없다.
  tasksTodayMax: 5,
  // state.json 의 세션 기록 보관 일수. 세션 기록은 세션마다 하나씩 쌓이므로 안 치우면
  // 무한히 는다 — 3일에 57개·48KB 였다. 매 훅이 이 파일을 통째로 읽고 쓰므로 크기가 곧 지연이다.
  sessionKeepDays: 7,
};

// ---------- 유틸 ----------
function log(...a) {
  try {
    appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + a.join(' ') + '\n');
  } catch {}
}
function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}
function readJson(f, fb) {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
}
/**
 * 임시 파일에 쓰고 이름을 바꾼다(원자적). 이 함수가 쓰는 settings.local.json 은
 * **Claude Code 가 세션이 뜰 때 읽는 파일**이라, 반쯤 쓰인 순간에 읽히면 그 세션 전체가
 * 훅 없이 돈다 — 눈에 안 보이는 누락이다. state.json 쪽(saveState)과 같은 방식이다.
 *
 * 끝내 rename 이 안 되면 **던진다.** 여기 호출부는 install/sweep 이라, 조용히 넘어가면
 * 한 줄도 안 깔린 채 '✓ 설치 완료'가 찍힌다.
 */
function writeJson(f, v) {
  ensureDir();
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, f);
      return;
    } catch (e) {
      // Windows 에서는 상대가 읽으려고 연 순간 rename 이 EPERM 이다. 잠깐 재시도한다.
      if (i >= 10) {
        try {
          unlinkSync(tmp);
        } catch {}
        throw e;
      }
      pauseSync(5 + i * 5);
    }
  }
}

/**
 * 파일 이름으로 쓸 수 있게 다듬는다.
 *
 * 예전 `[^\w.-]` 는 `\w` 가 ASCII 만 뜻해서 **한글을 전부 `_` 로 바꿨다** — '가계부'와
 * '자격증'이 똑같이 `___.json` 이 되어 서로의 후보 목록을 덮어썼다. 유니코드 글자·숫자는
 * 그대로 두고 나머지만 바꾼다. ASCII 이름의 결과는 예전과 같다(`_` 도 글자가 아니므로 `_` 로 남는다).
 */
function safeName(v) {
  return String(v).replace(/[^\p{L}\p{N}.\-]/gu, '_');
}

function config() {
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
}

/**
 * 에이전트 프로필 표. 기본 프로필 위에 사용자 것을 **키마다** 얹는다 — `config()` 의 얕은
 * 병합만 쓰면 사용자가 codex 하나를 손보는 순간 antigravity 프로필이 통째로 사라진다
 * (2026-09-01 에 실제로 그 모양이 됐다: 사용자 config.json 의 codex 하나가 표 전체를 가렸다).
 */
function agentTable(cfg = config()) {
  return { ...DEFAULT_CONFIG.fleetAgents, ...(cfg.fleetAgents || {}) };
}

/**
 * 헤드리스 에이전트 프로필 하나. **모르면 null 이다** — 부르는 쪽이 그 슬라이스만 보류하고
 * 보고한다. `claude` 는 TUI 라 이 표에 없고 여기서도 null 이다.
 */
function agentProfile(name, cfg = config()) {
  const p = agentTable(cfg)[String(name || '')];
  return p && p.cmd ? p : null;
}

/**
 * 프로필 → 실제로 spawn 할 `{ command, args }`. **셸을 안 거친다** — 지시 문장에 따옴표·줄바꿈이
 * 있어도 인자 하나로 그대로 들어간다(파견이 셸 한 줄로 만들던 시절의 따옴표 문제가 없다).
 *
 * 자리표시자는 `{path}`·`{prompt}`·`{hard}` 셋. `{hard}` 만 특별하다 — 인자 하나가 배열로
 * 펼쳐지거나(어려움) 통째로 사라진다(보통). 그래서 codex 처럼 프롬프트가 위치 인자인 명령에서도
 * 플래그가 프롬프트 **앞**에 들어갈 자리를 프로필이 직접 정할 수 있다.
 */
function agentArgv(profile, { path = '', prompt = '', hard = false } = {}) {
  const args = [];
  for (const a of profile.args || []) {
    if (a === '{hard}') {
      if (hard) args.push(...(profile.hard || []));
      continue;
    }
    args.push(String(a).replace('{path}', path).replace('{prompt}', prompt));
  }
  return { cmd: profile.cmd, args };
}
/**
 * **파싱 실패를 빈 상태로 삼키면 안 된다.** 빈 상태를 mutateState 가 그대로 저장하면
 * 세션 기록 전체가 그 순간 사라진다 — 반쯤 쓰인 파일을 한 번 잘못 읽은 대가가 영구 소실이다.
 * 그래서 파일이 **있는데** 못 읽으면 던진다. 훅으로 불린 명령은 어차피 exit 0 이라
 * 그 워커 하나만 조용히 물러나고, 다음 워커가 성한 파일을 읽는다.
 * 파일이 아예 없는 건 첫 실행이므로 그때만 빈 상태가 맞다.
 */
function state() {
  let s;
  try {
    s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') s = { sessions: {}, repos: {}, projectIds: {} };
    else throw new Error('state.json 을 읽지 못함 — 이 워커는 물러난다: ' + (e.code || e.message));
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('state.json 내용이 객체가 아님 — 이 워커는 물러난다');
  s.sessions = s.sessions || {};
  s.repos = s.repos || {};
  s.projectIds = s.projectIds || {};
  // 구버전 캐시 합치기: 예전에는 키가 SP 제목 글자 그대로였다. 조회는 대소문자를 무시하는데
  // 캐시만 글자 그대로라 'Project x' 과 'Project X' 이 각각 한 칸씩 차지했고,
  // forget 은 한쪽만 지웠다. 소문자 키로 접는다 (resolveProjectId 가 쓰는 키와 같다).
  for (const k of Object.keys(s.projectIds)) {
    const lk = k.toLowerCase();
    if (lk === k) continue;
    if (!s.projectIds[lk]) s.projectIds[lk] = s.projectIds[k];
    delete s.projectIds[k];
  }
  // 구버전 엔트리 호환: todos 는 예전에 {내용: 서브태스크id} 객체였다.
  for (const e of Object.values(s.sessions)) {
    if (!Array.isArray(e.commits)) e.commits = [];
    if (!Array.isArray(e.todos)) e.todos = [];
    if (!Array.isArray(e.written)) e.written = [];
  }
  return s;
}
/**
 * 임시 파일에 쓰고 이름을 바꾼다(원자적). writeFileSync 는 중간에 읽힐 수 있는데, 반쯤 쓰인
 * state.json 은 읽는 쪽에서 파싱이 깨진다. 이제 state() 가 그걸 던져서 막긴 하지만,
 * 그건 최후의 방어선이고 애초에 반쯤 쓰인 파일이 남에게 보이지 않게 하는 것이 여기 몫이다.
 */
function saveState(s) {
  ensureDir();
  const tmp = STATE_FILE + '.' + process.pid + '.tmp';
  const text = JSON.stringify(s, null, 2);
  writeFileSync(tmp, text);
  // Windows 에서는 누가 state.json 을 읽으려고 열어둔 순간 rename 이 EPERM 으로 실패한다.
  // 읽기는 락 밖에서도 일어나므로 창이 늘 열려 있다. 잠깐 재시도한다.
  //
  // 끝내 실패하면 **저장을 포기한다.** 예전에는 제자리 덮어쓰기로 떨어졌는데, 그러면
  // 파일이 순간 0바이트가 되고 그 틈에 읽은 워커가 빈 상태를 보게 된다 — 지키려던 것을
  // 폴백이 그대로 부수는 셈이다. 이번 변경분을 잃는 편이 파일 전체를 잃는 것보다 싸다.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, STATE_FILE);
      return;
    } catch (e) {
      if (i >= 10) {
        try {
          unlinkSync(tmp);
        } catch {}
        log('state.json rename 실패 — 이번 저장은 포기한다(파일은 그대로): ' + e.code);
        return;
      }
      pauseSync(5 + i * 5);
    }
  }
}

// ---------- state.json 락 ----------
/**
 * prompt/stop/commit/todos 는 각각 detached 워커로 떨어져 **따로** 돈다. 모두 state.json 을
 * "읽고 → 고치고 → 통째로 다시 쓰는" 식이라, 둘이 겹치면 나중에 쓴 쪽이 먼저 쓴 쪽의
 * 변경을 덮는다. 실제로 위험한 순간은 커밋 직후다 — post-commit 워커가 commits.push 를
 * 하는 사이에 Stop 워커가 deciding 을 찍으면 둘 중 하나가 조용히 사라진다. 커밋이 사라지면
 * 그 세션은 "질문만 한 세션"으로 보여 태스크가 안 생긴다.
 *
 * 그래서 read-modify-write 구간을 디렉터리 락으로 묶는다. mkdirSync 는 원자적이라 둘이
 * 동시에 만들 수 없다(EEXIST). 동기 함수인 이유: 락 안에서 await 를 하면 그 사이에
 * 이벤트 루프가 돌아 구간이 길어지고, SP 응답을 기다리며 락을 쥐고 있게 된다.
 * api() 결과를 다 받은 뒤 락을 잡고 짧게 쓴다.
 *
 * 끝내 못 잡으면 **fn 을 실행하지 않고 null 을 돌린다.** 예전에는 락 없이 진행했는데,
 * 이 안에 있는 건 전부 read-modify-write 라 락 없는 실행이 곧 남의 변경을 덮어쓰는 실행이다.
 * 훅을 막지 않는다는 원칙은 그대로다 — 던지지 않고 log() 만 남기고 물러난다.
 * 호출부는 전부 null 을 받아도 되는 자리다(반환값을 안 쓰거나 `?.` 로 받는다).
 * 죽은 워커가 남긴 락(mtime 이 LOCK_STALE_MS 넘게 낡음)은 빼앗는다.
 */
const STATE_LOCK_DIR = join(DIR, 'state.lock');
const LOCK_STALE_MS = 10000; // 이보다 오래된 락은 주인이 죽은 것으로 본다
const LOCK_WAIT_MS = 3000; // 이만큼 기다려도 못 잡으면 포기한다
const LOCK_STEP_MS = 20;
// 동기 대기. busy loop 대신 Atomics.wait 로 스레드를 재운다 — 값이 바뀔 일이 없는
// 공유 버퍼라 타임아웃까지 그냥 잔다.
const LOCK_SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function pauseSync(ms) {
  try {
    Atomics.wait(LOCK_SLEEPER, 0, 0, ms);
  } catch {}
}

// 락 주인을 적어두는 파일. 낡았다고 빼앗긴 뒤 뒤늦게 finally 에 닿은 프로세스가
// **남이 새로 만든 락**을 rmdir 하는 걸 막는다 (그 순간 두 워커가 동시에 state.json 을 쓴다).
const LOCK_PID_FILE = 'pid';

/** 내가 쥔 락일 때만 푼다. 주인이 바뀌었으면 손대지 않고 로그만 남긴다. */
function releaseDirLock(dir) {
  const pf = join(dir, LOCK_PID_FILE);
  const nm = basename(dir);
  let owner = null;
  try {
    owner = readFileSync(pf, 'utf8').trim();
  } catch {}
  if (owner !== String(process.pid)) {
    log(nm + ' 주인이 바뀌어 해제를 건너뜀 (지금 주인: ' + (owner || '표시 없음') + ')');
    return;
  }
  try {
    unlinkSync(pf);
  } catch {}
  try {
    rmdirSync(dir);
  } catch (e) {
    log(nm + ' 해제 실패: ' + (e.code || e.message));
  }
}

/**
 * 위 규칙 그대로의 디렉터리 락. **`state.json` 말고도 락이 필요한 파일이 생겨서**(예약 저장소
 * `fleet-resources.json` — 슬라이스 42) 락 경로만 인자로 뺐다. 구현을 두 벌 두면 한쪽만 고쳐진다.
 */
function withDirLock(LOCK_DIR, fn) {
  ensureDir();
  let held = false;
  const deadline = Date.now() + LOCK_WAIT_MS;
  // 루프를 한 바퀴로 합쳤다. 예전에는 steal 성공·statSync 실패가 `continue` 로 빠져
  // deadline 검사와 pauseSync 를 통째로 건너뛰었는데, 락이 계속 낡은 채로 보이면
  // 그 두 경로만 왕복하며 CPU 를 100% 태우고 영영 안 끝났다. 이제 **모든 경로**가
  // 아래 deadline 검사와 sleep 을 지난다.
  while (true) {
    try {
      mkdirSync(LOCK_DIR);
      held = true;
      // 주인 표시. 실패해도 진행한다 — 그때는 해제 쪽이 "표시 없음"으로 보고 물러날 뿐이라
      // 락이 LOCK_STALE_MS 뒤에 빼앗기는 것으로 끝난다.
      try {
        writeFileSync(join(LOCK_DIR, LOCK_PID_FILE), String(process.pid));
      } catch {}
      break;
    } catch (e) {
      // Windows 에서는 주인이 rmdir 하는 순간과 겹친 mkdir 이 EEXIST 가 아니라 EPERM 을
      // 낸다(디렉터리가 삭제 대기 상태). 이걸 "락 못 만듦"으로 보면 정확히 경합 순간에
      // 락이 풀린다 — 재현에서 900건 중 5~7건이 그렇게 사라졌다. 전부 "누가 쥐고 있다"로 본다.
      if (!['EEXIST', 'EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e.code)) {
        log(basename(LOCK_DIR) + ' 생성 실패 — 이번 변경은 건너뛴다: ' + e.message);
        break;
      }
      // 낡은 락은 빼앗는다. rmdir 로 바로 지우면 안 된다 — 둘이 동시에 "낡았다"고 보고
      // 한쪽이 새로 만든 락을 다른 쪽이 지울 수 있다. 자기 이름으로 rename 한 뒤 지우면
      // rename 은 한 프로세스만 성공하고, 그 사이 새로 생긴 락은 이름이 달라 안 건드린다.
      // statSync 가 실패하면 그 사이에 주인이 풀어준 것이니 그냥 다음 바퀴에 다시 잡는다.
      try {
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
          const mine = LOCK_DIR + '.' + process.pid + '.stale';
          renameSync(LOCK_DIR, mine);
          // 안에 주인 표시 파일이 있으므로 rmdir 로는 안 지워진다.
          try {
            rmSync(mine, { recursive: true, force: true });
          } catch {}
          log(basename(LOCK_DIR) + ' 이 낡아 빼앗음');
        }
      } catch {}
    }
    if (Date.now() >= deadline) {
      log(basename(LOCK_DIR) + ' 을 ' + LOCK_WAIT_MS + 'ms 안에 못 잡음 — 이번 변경은 건너뛴다');
      break;
    }
    pauseSync(LOCK_STEP_MS);
  }
  // 락 없이 read-modify-write 를 돌리면 남의 변경을 덮어쓴다. 아무것도 안 하고 물러난다.
  if (!held) return null;
  try {
    return fn();
  } finally {
    releaseDirLock(LOCK_DIR);
  }
}

/** `state.json` 의 read-modify-write 를 묶는 락. 경로가 고정인 것 말고는 `withDirLock` 그대로다. */
function withStateLock(fn) {
  return withDirLock(STATE_LOCK_DIR, fn);
}

/** 락 안에서 state() 를 읽고 fn 으로 고친 뒤 저장한다. fn 의 반환값을 돌려준다. */
function mutateState(fn) {
  return withStateLock(() => {
    const s = state();
    const r = fn(s);
    saveState(s);
    return r;
  });
}

function token() {
  if (process.env.SP_TOKEN) return process.env.SP_TOKEN.trim();
  const la = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local');
  const ad = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');
  const cands = [
    process.env.SP_TOKEN_FILE,
    join(la, 'Packages', '53707johannesjo.SuperProductivity_ch45amy23cdv6', 'LocalCache', 'Roaming', 'superProductivity', 'local-rest-api-token'),
    join(ad, 'superProductivity', 'local-rest-api-token'),
    join(HOME, '.config', 'superProductivity', 'local-rest-api-token'),
  ].filter(Boolean);
  for (const p of cands) {
    try {
      const t = readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch {}
  }
  return null;
}

// ---------- SP API ----------
async function api(method, path, body) {
  const c = config();
  const tk = token();
  if (!tk) throw new Error('SP 토큰 파일을 찾을 수 없음 (SP 설정 > Misc > Access Token 확인)');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), c.timeoutMs);
  try {
    const res = await fetch('http://' + c.host + ':' + c.port + path, {
      method,
      headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const e = json.error || {};
      throw new Error((method + ' ' + path + ' -> ' + res.status + ' ' + (e.code || '') + ' ' + (e.message || '')).trim());
    }
    return json.data !== undefined ? json.data : json;
  } finally {
    clearTimeout(t);
  }
}

// ---------- 프로젝트 매핑 ----------
// windowsHide 를 빼먹으면 안 된다. 훅의 실작업은 detached 로 떼어낸 백그라운드 워커에서
// 도는데, detached 프로세스에는 콘솔이 없다. 콘솔 없는 부모가 콘솔 프로그램(git)을 띄우면
// 윈도우가 자식에게 콘솔을 새로 할당한다 — 매 턴 깜빡이던 검은 창이 이것이었다.
// (Win11 기본 콘솔 호스트가 Windows Terminal이라 터미널 창으로 보인다.)
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
}

/**
 * 워크트리에서 작업해도 같은 프로젝트로 모이도록 **메인 저장소 루트**를 돌려준다.
 * `--show-toplevel`은 워크트리 안에서 워크트리 경로를 주기 때문에 그대로 쓰면
 * 프로젝트명이 워크트리 폴더명(seadevil, surgeonfish, fix-...)으로 잡힌다.
 */
function repoRoot(cwd) {
  try {
    const common = git(['rev-parse', '--git-common-dir'], cwd);
    // 메인 저장소에서는 '.git'·'../.git' 같은 상대경로가 나온다. **기준은 저장소 루트가 아니라
    // 우리가 준 cwd 다** — git rev-parse 는 상대경로를 실행 위치 기준으로 낸다. 루트를 기준으로
    // 풀면 하위 폴더에서 부를 때마다 그만큼 위로 새어 저장소 바깥이 프로젝트 루트로 잡힌다
    // (2026-08-30: 본체 SP-sync 의 sp-sync/ 에서 부른 값이 ~/orca/projects 였다).
    const abs = isAbsolute(common) ? common : resolve(cwd, common);
    return dirname(abs).replace(/\//g, '\\');
  } catch {
    return resolve(cwd);
  }
}

function currentBranch(cwd) {
  try {
    return git(['branch', '--show-current'], cwd);
  } catch {
    return '';
  }
}

/** 저장소 폴더명과 SP 프로젝트 제목이 다를 때 config.projectAliases로 매핑 */
function projectTitleFor(root) {
  const name = basename(root);
  const aliases = config().projectAliases || {};
  return aliases[name] || name;
}

async function resolveProjectId(name) {
  // 캐시 키는 소문자로 맞춘다. 아래 매칭이 대소문자를 무시하므로, 키만 글자 그대로면
  // 같은 프로젝트가 표기가 달라질 때마다 캐시에 한 칸씩 더 생긴다 (state() 가 옛 키를 접는다).
  const key = String(name).toLowerCase();
  const s = state();
  if (s.projectIds[key]) return s.projectIds[key];
  const list = await api('GET', '/projects?query=' + encodeURIComponent(name));
  const arr = Array.isArray(list) ? list : list?.projects || [];
  const hit = arr.find((p) => (p.title || '').toLowerCase() === key);
  if (hit) {
    // SP 응답을 받은 뒤에 락을 잡는다. 위에서 읽은 s 는 버리고 락 안에서 다시 읽는다.
    mutateState((x) => (x.projectIds[key] = hit.id));
    return hit.id;
  }
  return null;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 대기 줄이 실제로 뭔가를 기다리는가 ("없음"류는 줄 자체를 안 쓴다). 상태줄과 같은 규칙이다. */
const NO_WAIT = /^(없음|없다|없습니다|none|n\/a|-)$/i;
function isWaiting(v) {
  return !!(v && !NO_WAIT.test(String(v).trim()));
}

function clean(str, max) {
  const one = String(str || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}


// ---------- 공용 헬퍼 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 경로 비교 키. 역슬래시 → 슬래시, 끝 슬래시 제거, 소문자. 워크스페이스·세션·카드를 경로로
 * 맞출 때는 **반드시 이것**으로 — 한 곳만 끝 슬래시를 안 털어도 매칭이 갈린다.
 */
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 제목 비교 키. 공백 전부 제거 + 소문자 — 카드의 `task` 와 SP 태스크 제목을 맞출 때. */
function normTitle(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/** 한글은 두 칸이다. 안 세면 표가 프로젝트마다 다르게 어긋난다. 표를 그리는 모듈(fleet·tasks)이 전부 이걸 쓴다. */
function dispWidth(str) {
  let w = 0;
  for (const ch of String(str))
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

/** 표 한 칸. 넘치면 … 로 자르고 모자라면 공백으로 채운다 (칸 너비는 dispWidth 기준). */
function fitCell(str, width) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = dispWidth(ch);
    if (w + cw > width - 1) return out + '…' + ' '.repeat(width - w - 1);
    out += ch;
    w += cw;
  }
  return out + ' '.repeat(width - w);
}

/** PLAN.md 본문의 체크박스 수. */
function planCounts(text) {
  let open = 0;
  let done = 0;
  for (const l of String(text).split('\n')) {
    if (/^\s*- \[ \]/.test(l)) open++;
    else if (/^\s*- \[[xX]\]/.test(l)) done++;
  }
  return { open, done };
}


// 끝나지 않은 채 이만큼 묵은 턴은 없는 것으로 본다. 훅이 못 도는 사이에 창이 죽으면
// `turnStartedAt` 만 남는데, 그대로 믿으면 그 워크스페이스가 영영 "턴 진행 중"으로 굳는다.
// 착륙의 유휴 판정(`fleet.turnStateFor`)과 래퍼의 겹침 거부(`worker.openWrapperTurn`)가 같은 값을 본다.
const TURN_STALE_MS = 3600000;

// ---------- PLAN.md 슬라이스 파서 ----------
// `fleet` 이 파견·착륙에 쓰고 `hooks` 가 워크스페이스 카드 상태(`in-progress`/`in-review`)를 정하는 데 쓴다.
// `hooks` 는 `fleet` 을 import 하지 못하므로(의존 방향 `common ← hooks ← fleet`) 여기에 둔다 — 같은 판정을
// 두 벌 쓰면 한쪽이 반드시 어긋난다. 태그의 뜻은 `~/orca/CLAUDE.md` 가 정한다.

const SLICE_TAGS = [
  { key: 'hard', label: '어려움', re: /\[어려움\]/ },
  { key: 'decision', label: '결정 필요', re: /\[결정 필요(?::\s*([^\]]*))?\]/ },
  { key: 'parallel', label: '병렬 가능', re: /\[병렬 가능\]/ },
  // `[선행: 3, 5]` — **부분 의존.** 그 번호들이 모두 `[x]` 여야 파견 자격이 생기고, 나머지
  // 미완 앞 슬라이스와는 독립으로 본다 (그래서 `[병렬 가능]` 을 함축한다 — dispatchPlan 의
  // `isParallel`). `[병렬 가능]` 하나로는 "전부 독립"밖에 못 적어서, 부분 의존을 적으려면
  // 거짓말을 하거나 태그를 빼고 혼자 돌 차례를 기다리는 수밖에 없었다.
  { key: 'deps', label: '선행', re: /\[선행:\s*([^\]]*)\]/ },
  // `[에이전트: codex]` — Claude Code TUI 대신 **헤드리스 워커**로 구현한다. 값은
  // `fleetAgents` 의 프로필 키이고, 코드가 특별히 아는 이름은 `claude`(지금 동작) 하나뿐이다.
  // 프로젝트 기본값(`fleetProjectAgent`)보다 이 태그가 이긴다 — 한 슬라이스만 다른 에이전트로
  // 돌리는 것이 이 태그의 용도다.
  { key: 'agent', label: '에이전트', re: /\[에이전트:\s*([^\]]*)\]/ },
  // `[자원: 폰, 마이크]` — 그 슬라이스가 독점해야 하는 **공유 자원**의 이름들 (슬라이스 42).
  // `[병렬 가능]` 은 "파일이 안 겹친다"까지만 말하는데, 폰·마이크·같은 API 쿼터는 파일이 아니라
  // 실물이라 그 태그로는 못 적었다. 예약은 프로젝트를 넘어 배타다 — 같은 이름을 쓰는 슬라이스는
  // 다른 프로젝트의 것이어도 그 워크스페이스가 사라질 때까지 안 뜬다 (`lib/resources.mjs`).
  { key: 'resources', label: '자원', re: /\[자원:\s*([^\]]*)\]/ },
];

/** `[자원: 폰, 마이크]` 의 값 → `['폰', '마이크']`. 쉼표로 가르고 앞뒤 공백을 털며 `normTitle` 로 중복을 접는다. */
function resourceNames(v) {
  const seen = new Set();
  const out = [];
  for (const raw of String(v || '').split(',')) {
    const name = raw.trim();
    if (!name) continue;
    const key = normTitle(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * 슬라이스 한 줄을 뜯는다. 태그는 **굵은 제목 바로 뒤에 붙은 것만** 센다 — 제목 줄 전체를
 * 훑으면 본문의 인용이 태그가 된다. SP-sync 슬라이스 6 의 제목 줄이 그렇다:
 * "…— 파견. 자격: `[결정 필요]` 는 건너뛰고 보고" 는 규칙 설명이지 그 슬라이스의 태그가 아니다.
 * 그래서 제목 뒤 백틱·공백만 건너뛰며 태그를 연달아 먹고, 태그가 아닌 글자가 나오면 멈춘다.
 */
function parseSliceLine(rest) {
  // `**8. 제목**` 이 표준형. 번호가 없으면 null 로 두고 워크스페이스 매핑에서 뺀다.
  const bold = rest.match(/^\*\*\s*(?:(\d+)\.\s*)?([\s\S]*?)\s*\*\*/);
  let number = null;
  let title;
  let zone;
  if (bold) {
    number = bold[1] ? Number(bold[1]) : null;
    title = bold[2];
    zone = rest.slice(bold[0].length);
  } else {
    // 굵게 안 쓴 계획도 있다. 제목 경계가 없으므로 줄 전체를 태그 자리로 본다.
    const plain = rest.match(/^(?:(\d+)\.\s*)?(.*)$/);
    number = plain[1] ? Number(plain[1]) : null;
    title = plain[2];
    zone = plain[2];
  }
  const tags = [];
  let decision = null;
  let deps = [];
  let agent = null;
  let resources = [];
  const unknownTags = [];
  const nums = (s) => [...new Set((String(s || '').match(/\d+/g) || []).map(Number))];
  if (bold) {
    // 제목 바로 뒤의 연속된 `[…]` 만 본다. 첫 비대괄호 글자에서 끊는다 — 줄 전체를 훑으면
    // 본문의 인용이 태그가 되기 때문이다 (SP-sync 슬라이스 6 의 제목 줄).
    //
    // **모르는 태그는 연쇄를 끊지 않는다.** 예전에는 아는 태그만 먹고 멈춰서, 모르는 것이
    // 먼저 오면 뒤의 아는 태그까지 통째로 안 읽혔다 (`**7. x** [선행: 3] [병렬 가능]` →
    // 태그 없음). 건너뛴 것은 `unknownTags` 로 남겨 보고에 싣는다 — 조용히 무시하면 오타가
    // 영영 안 보인다.
    const one = /^[\s`]*\[([^\]]*)\]/;
    let cut = zone;
    let m;
    while ((m = cut.match(one))) {
      const after = cut.slice(m[0].length);
      if (after.startsWith('(')) break; // `[글](링크)` 는 태그가 아니다
      let known = false;
      for (const t of SLICE_TAGS) {
        const h = m[0].match(t.re);
        if (!h) continue;
        // 번호가 하나도 없는 `[선행: ]` 은 태그로 안 친다 — 의존이 없다는 뜻으로 읽히면
        // 오타가 자격을 넓혀 버린다. 모르는 태그로 넘겨 보고에 올린다.
        if (t.key === 'deps' && !nums(h[1]).length) continue;
        // 이름이 빈 `[에이전트: ]` 도 같은 이유로 태그가 아니다 — 빈 이름이 `claude` 로 읽히면
        // 오타가 조용히 지금 동작으로 떨어진다. 모르는 태그로 넘겨 보고에 올린다.
        if (t.key === 'agent' && !(h[1] || '').trim()) continue;
        // 이름이 하나도 없는 `[자원: ]` 도 같은 이유로 태그가 아니다 — 빈 목록이 "자원을 안 쓴다"로
        // 읽히면 오타가 조용히 배타를 풀어 버린다. 모르는 태그로 넘겨 보고에 올린다.
        if (t.key === 'resources' && !resourceNames(h[1]).length) continue;
        known = true;
        if (!tags.includes(t.key)) tags.push(t.key);
        if (t.key === 'decision') decision = (h[1] || '').trim() || null;
        if (t.key === 'deps') deps = nums(h[1]);
        if (t.key === 'agent') agent = h[1].trim();
        if (t.key === 'resources') resources = resourceNames(h[1]);
      }
      if (!known) unknownTags.push(m[1].trim());
      cut = after;
    }
  } else {
    for (const t of SLICE_TAGS) {
      const h = zone.match(t.re);
      if (!h) continue;
      if (t.key === 'deps' && !nums(h[1]).length) continue;
      if (t.key === 'agent' && !(h[1] || '').trim()) continue;
      if (t.key === 'resources' && !resourceNames(h[1]).length) continue;
      tags.push(t.key);
      if (t.key === 'decision') decision = (h[1] || '').trim() || null;
      if (t.key === 'deps') deps = nums(h[1]);
      if (t.key === 'agent') agent = h[1].trim();
      if (t.key === 'resources') resources = resourceNames(h[1]);
    }
  }
  for (const t of SLICE_TAGS) title = title.replace(t.re, '');
  // `agent` 는 **태그에 적힌 이름 그대로**다. 프로젝트 기본값·`claude` 로 채우는 것은
  // `resolveAgents` 몫 — 파서는 계획에 쓰인 것만 돌려준다.
  return { number, title: title.replace(/`/g, '').replace(/\s+/g, ' ').trim(), tags, decision, deps, agent, resources, unknownTags };
}

/**
 * 접힌 단계 제목이 말하는 슬라이스 번호들 — `## 3단계 완료 (2026-09-01, 슬라이스 1~7 — …)` → 1..7.
 *
 * **모든 `##` 줄에서 따로 읽는다.** `phases` 는 슬라이스가 없는 절을 버리므로(접힌 절에는 체크박스가
 * 한 줄도 없다) 거기서는 못 얻는다. `PLAN-archive.md` 는 읽지 않는다 — SP-sync 3·4단계가 둘 다
 * 1~7 이라 "그 번호가 있었다"의 근거가 못 된다. 여기서 나온 번호는 **완료로 본다**: 접힌 절의
 * 슬라이스는 전부 끝난 것이기 때문이다.
 *
 * `슬라이스` 뒤에 숫자가 이어질 때만 센다. `(2026-08-30~31, 슬라이스 5~24 — …)` 의 날짜 범위처럼
 * 낱말 밖의 `~` 는 안 먹는다.
 */
function foldedSliceNumbers(text) {
  const out = new Set();
  for (const l of String(text).split(/\r?\n/)) {
    if (!/^##\s/.test(l)) continue;
    for (const m of l.matchAll(/슬라이스\s*(\d[\d\s,~\-–]*)/g)) {
      for (const part of m[1].split(',')) {
        const r = part.trim().match(/^(\d+)\s*[~\-–]\s*(\d+)$/);
        if (r) {
          const [a, b] = [Number(r[1]), Number(r[2])].sort((x, y) => x - y);
          // 범위가 터무니없이 넓으면(오타) 통째로 버린다 — 없는 선행을 전부 덮어 버리면 검사가 무의미해진다.
          if (b - a <= 500) for (let i = a; i <= b; i++) out.add(i);
          continue;
        }
        const one = part.trim().match(/^(\d+)$/);
        if (one) out.add(Number(one[1]));
      }
    }
  }
  return out;
}

/**
 * **계획 오류** — 그 슬라이스를 파견하면 안 되는 이유. `[{slice, line, kind, detail}]` 을 내고
 * 같은 객체를 슬라이스의 `errors` 에도 붙인다 (파견은 슬라이스 하나만 보면 되게).
 *
 * 판정이 파서에 있는 이유: `fleet slices`(사람이 보는 검토)와 `fleet dispatch`(파견)가 **같은 함수**를
 * 써야 "검토에서는 통과인데 파견이 막는" 이 안 생긴다 (coordinator 점검 #2).
 *
 * 셋뿐이다 — 오타 하나가 조용히 기본값으로 읽히는 것들:
 *  - `unknown-tag` — `[결정필요: 승인]` 처럼 태그 표에 없는 것. 예전에는 사유에 경고만 붙고 **떴다**
 *  - `dup-number` — 같은 번호가 둘. 브랜치 이름(`sliceN`)이 겹쳐 옛 PR 로 읽힌다 (2026-09-02 SP-sync).
 *    **둘 다** 막는다 — 어느 쪽이 진짜인지 도구가 정할 일이 아니다
 *  - `missing-prereq` — 파일의 어느 절에도, 접힌 단계 제목의 범위에도 없는 선행 번호. 예전에는
 *    "접힌 지난 단계겠지"로 **완료 취급**해 `[선행: 999]` 오타가 자격을 넓혔다
 */
function planErrors(allSlices, folded) {
  const errors = [];
  const known = new Set(folded || []);
  const lines = new Map();
  for (const s of allSlices) {
    if (s.number == null) continue;
    known.add(s.number);
    lines.set(s.number, (lines.get(s.number) || []).concat(s.line));
  }
  const add = (s, kind, detail) => {
    const e = { slice: s.number ?? null, line: s.line, kind, detail };
    errors.push(e);
    s.errors = (s.errors || []).concat(e);
  };
  for (const s of allSlices) {
    for (const t of s.unknownTags || []) add(s, 'unknown-tag', '모르는 태그 [' + t + ']');
    const dup = s.number == null ? [] : lines.get(s.number);
    if (dup && dup.length > 1) add(s, 'dup-number', '번호 ' + s.number + ' 중복 — ' + dup.length + '곳 (' + dup.map((n) => n + '줄').join(', ') + ')');
    const miss = (s.deps || []).filter((n) => !known.has(n));
    if (miss.length) add(s, 'missing-prereq', '선행 ' + miss.join(', ') + '번이 계획에 없음');
  }
  return errors;
}

/** PLAN.md 본문 → { phase, slices, phases, strayChecks }. 파일을 안 읽으므로 테스트가 문자열로 부른다. */
function parsePlanSlices(text) {
  const sections = [{ title: '', line: 0, slices: [] }];
  let stray = 0;
  // CRLF 를 여기서 벗긴다. 아래 정규식들이 `$` 로 끝나는데 `.` 는 `\r` 을 안 먹어서,
  // 안 벗기면 CRLF 로 저장된 PLAN.md 에서 슬라이스가 **한 줄도 안 잡힌다** (2026-08-30).
  String(text)
    .split(/\r?\n/)
    .forEach((l, i) => {
      const h = l.match(/^##\s+(.*)$/); // ### 이하는 절을 가르지 않는다 (한 슬라이스 안의 소제목)
      if (h) {
        sections.push({ title: h[1].trim(), line: i + 1, slices: [] });
        return;
      }
      // 슬라이스는 **들여쓰기 없는** 목록 항목이다. 들여쓴 체크박스는 그 슬라이스의 하위 항목이다.
      const s = l.match(/^- \[([ xX])\] (.*)$/);
      if (!s) {
        // 체크박스인데 슬라이스로 안 잡힌 줄. 대개는 슬라이스 밑의 하위 항목이라 정상이지만,
        // 슬라이스가 한 줄도 안 잡혔는데 이런 줄만 있으면 구문이 어긋난 계획이다
        // (`### - [ ] 슬라이스 1.` — Project A 2026-08-30). 세어서 넘기고 판정은 위에서 한다.
        if (/^\s*(?:#+\s+)?[-*]\s*\[[ xX]\]/.test(l)) stray++;
        return;
      }
      sections[sections.length - 1].slices.push({ done: s[1] !== ' ', line: i + 1, ...parseSliceLine(s[2]) });
    });
  const withSlices = sections.filter((s) => s.slices.length);
  // **모든 절**의 슬라이스. 파견은 현재 단계만 보지만 착륙·트리거는 여기서 번호를 찾고
  // (`sliceInPlan`), 계획 오류 판정도 파일 전체를 봐야 한다 (다른 절의 번호와 겹치는지).
  const all = withSlices.flatMap((s) => s.slices);
  const phase = withSlices.find((s) => s.slices.some((x) => !x.done)) || withSlices[withSlices.length - 1] || null;
  return {
    phase: phase ? { title: phase.title, line: phase.line } : null,
    slices: phase ? phase.slices : [],
    allSlices: all,
    // 계획 오류 — 파견을 막는다 (`planErrors`). 같은 객체가 슬라이스의 `errors` 에도 붙어 있다.
    errors: planErrors(all, foldedSliceNumbers(text)),
    strayChecks: stray,
    phases: withSlices.map((s) => ({
      title: s.title,
      line: s.line,
      open: s.slices.filter((x) => !x.done).length,
      done: s.slices.filter((x) => x.done).length,
      current: s === phase,
    })),
  };
}

/**
 * PLAN.md 에서 그 번호의 슬라이스를 찾는다 — **현재 단계뿐 아니라 모든 절에서.**
 *
 * 착륙·트리거가 쓴다. 워커가 자기 절의 **마지막** 슬라이스를 체크하면 그 절에는 미체크가 하나도
 * 안 남아 `phase` 가 다음 절로 넘어가고, 그 순간 "현재 단계에 N번이 없음"으로 착륙이 막힌다
 * (재현 확인 2026-09-01). `~/orca/CLAUDE.md` 의 "7개 넘으면 N+1 절" 규칙이 정확히 이 배치를 만든다.
 * 파견은 그대로 현재 단계만 본다 — 다음에 무엇을 띄울지는 단계 순서가 정하는 것이 맞다.
 *
 * 번호는 대개 단계를 가로질러 이어지지만(1~24), 절마다 1부터 다시 매기는 계획도 있을 수 있다.
 * 그래서 **현재 단계 → 현재 단계보다 앞선 절 중 마지막 → 그 외 첫 번째** 순으로 고른다.
 * 방금 끝낸 절은 언제나 현재 단계 **앞**에 있다.
 */
function sliceInPlan(parsed, n) {
  if (n == null) return null;
  const inPhase = (parsed.slices || []).find((x) => x.number === n);
  if (inPhase) return inPhase;
  const all = (parsed.allSlices || []).filter((x) => x.number === n);
  if (!all.length) return null;
  const line = parsed.phase?.line ?? Infinity;
  const before = all.filter((x) => x.line < line);
  return before.length ? before[before.length - 1] : all[0];
}

/**
 * 그 슬라이스를 Claude 로 띄울 모델. `[어려움]` 은 최상위(`fleetHardModel`), 나머지는 표준(`fleetModel`).
 * 한 함수인 이유: 파견의 명령·표(`fleet.mjs` 의 `workerCommand`)와 워크트리 훅 설치(`hooks.mjs` 의
 * `writeSettings` 가 `.claude/settings.local.json` 의 `model` 로 박는다)가 **같은 판정**을 써야 한다 —
 * 2026-09-04 실측(`notes/2026-09-04-worktree-create-agent-실측.md`)으로 파견이 `worktree create --agent claude`
 * 로 바뀌면서 모델을 명령줄(`--model`)에 실을 자리가 없어져, 그 값을 아는 곳이 설치 쪽으로 옮겨갔다.
 * 빈 값이면 null — 호출부가 사유(`fleetModel`/`fleetHardModel`)를 붙여 알린다.
 */
function sliceModel(slice, cfg = config()) {
  const hard = (slice.tags || []).includes('hard');
  return (hard ? cfg.fleetHardModel : cfg.fleetModel) || null;
}

/** `<user>/slice8` · `slice8` → 8. 끝 조각이 정확히 `sliceN` 일 때만 — `plan-slice-5-merge` 는 아니다. */
function sliceNumberOf(...names) {
  for (const n of names) {
    const tail = String(n || '')
      .replace(/^refs\/heads\//, '')
      .replace(/\\/g, '/')
      .split('/')
      .pop();
    const m = /^slice[-_]?(\d+)$/i.exec(String(tail || '').trim());
    if (m) return Number(m[1]);
  }
  return null;
}

export { CODE_FILES, CONFIG_FILE, DEFAULT_CONFIG, DIR, HOME, LOCK_PID_FILE, LOCK_STALE_MS, LOCK_STEP_MS, NODE, SELF, SLICE_TAGS, TURN_STALE_MS, agentArgv, agentProfile, agentTable, api, clean, config, currentBranch, dispWidth, ensureDir, fitCell, foldedSliceNumbers, git, isWaiting, log, mutateState, normPath, normTitle, parsePlanSlices, parseSliceLine, planCounts, planErrors, projectTitleFor, readJson, repoRoot, resolveProjectId, resourceNames, safeName, saveState, sleep, sliceInPlan, sliceModel, sliceNumberOf, state, todayStr, token, withDirLock, withStateLock, writeJson };
