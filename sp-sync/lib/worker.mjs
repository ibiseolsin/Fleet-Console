/**
 * worker — 헤드리스 에이전트(codex · antigravity …)의 **한 턴**을 대신 도는 래퍼.
 *
 * Claude Code TUI 워커는 훅이 턴 경계를 찍는다 — `UserPromptSubmit` 이 `turnStartedAt`,
 * `Stop` 이 나머지 전부(복귀 카드 · status.md · SP 노트 · 회차 트리거). 헤드리스 에이전트에는
 * 그 훅이 없다. 대신 **지시가 명령줄에 실리고 프로세스 종료가 곧 턴 끝**이라, 이 래퍼가
 * 그 자리를 그대로 채운다:
 *
 *   세션 기록 시작(`turnStartedAt`·`agent`) → 에이전트 spawn(stdio 상속) → 종료 → `turnEndedAt`
 *   → 카드 없으면 합성 → **`Stop` 훅과 같은 함수**(`onTurnEnd`) → `[sp-sync worker] … exit N`
 *
 * `onTurnEnd` 를 주입으로 받는 이유는 의존 방향이다. 그 일(카드·SP·회차)은 `hooks` 와 `fleet`
 * 을 둘 다 부르는데, 둘을 잇는 것은 진입점(`sp-sync.mjs` 의 `CMDS.stop`)이라고 저장소 규칙이
 * 정해 뒀다. 그래서 이 모듈은 `common`·`hooks`·`limits` 까지만 안다.
 *
 * 세션 id 는 `<에이전트>-<시각>-<난수>` 이고 자식 env 에 **`CLAUDE_CODE_SESSION_ID`** 로 넣는다.
 * 이름을 새로 만들면 복귀 카드 규칙(`~/orca/CLAUDE.md`)부터 판정·상태줄까지 문서와 코드 여러
 * 군데를 같이 고쳐야 한다 — 값의 출처만 달라졌을 뿐 뜻은 같으므로 이름을 물려받는다.
 * 이 변수는 자식이 낸 커밋의 post-commit 훅도 읽는다(그래서 커밋이 이 세션에 붙는다).
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, delimiter, isAbsolute, extname } from 'node:path';
import { config, clean, log, git, safeName, normPath, state, TURN_STALE_MS } from './common.mjs';
import { ensureSession, patchSession, hasDrop, writeDrop, worktreeRoot } from './hooks.mjs';
import { limitOf } from './limits.mjs';

// TUI 워커에게 보내는 문장과 같다 (`fleet.mjs` 의 `SLICE_PROMPT`). **축약형(`/slice N`)은 쓰지
// 않는다** — 그건 Claude Code 스킬이고 헤드리스 에이전트는 모른다. 두 곳이 갈라지면 워커에
// 따라 다른 일을 시키는 셈이니 문장을 고칠 때는 둘 다 고친다.
const SLICE_PROMPT = 'PRD.md, PLAN.md 읽고 슬라이스 {N} 진행. 끝나면 PLAN.md 체크하고 커밋.';

/**
 * 에이전트 프로필. `config.json` 의 `fleetAgents` 표에서 이름으로 찾는다.
 *
 *   { "cmd": "codex",
 *     "args": ["exec", "{hard}", "-C", "{path}", "-s", "workspace-write", "{prompt}"],
 *     "hard": ["-m", "gpt-5.1-codex-max"] }
 *
 * `{path}`·`{prompt}` 는 토큰 **안에서** 치환되고, `{hard}` 는 토큰 하나가 `hard` 배열로
 * 펼쳐진다(`[어려움]` 이 아니면 사라진다). 자리표시자를 쓰는 이유는 에이전트마다 프롬프트가
 * 놓이는 자리가 다르기 때문이다 — codex 는 맨 끝 위치인자, agy 는 `-p` 의 값이다.
 *
 * 표에 없는 이름은 던진다. 파견(`fleet.mjs`)은 이걸 "모르는 에이전트" 로 그 슬라이스만
 * 보류하고 나머지는 그대로 띄운다 — 모르는 태그와 같은 경로다.
 */
function agentProfile(agent, cfg = config()) {
  const table = cfg.fleetAgents || {};
  const p = agent ? table[agent] : null;
  if (!p || !p.cmd) throw new Error('모르는 에이전트: ' + agent + ' — config.json 의 fleetAgents 에 프로필이 없다');
  return p;
}

/** 프로필의 인자 틀을 실제 인자 배열로. 셸을 안 거치므로 따옴표를 붙이지 않는다. */
function buildAgentArgs(profile, { path, prompt, hard = false }) {
  const out = [];
  for (const raw of profile.args || []) {
    const t = String(raw);
    if (t === '{hard}') {
      if (hard) for (const h of profile.hard || []) out.push(String(h));
      continue;
    }
    out.push(t.replaceAll('{path}', String(path ?? '')).replaceAll('{prompt}', String(prompt ?? '')));
  }
  return out;
}

/** `<에이전트>-<시각>-<난수>`. 파일 이름이 되므로(drop/·cards/) 안전한 글자만 쓴다. */
function workerSessionId(agent, now = Date.now(), rnd = Math.random()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15); // 20260901T143512
  return safeName(agent + '-' + stamp + '-' + rnd.toString(36).slice(2, 8));
}

// ---------- Windows: .cmd 셔임을 통과시키기 ----------
/**
 * PATH + PATHEXT 로 실행 파일을 찾는다. 못 찾으면 준 이름 그대로 돌려준다(spawn 이 ENOENT 로 운다).
 * 확장자 순서는 PATHEXT 그대로다 — 기본값이 `.COM;.EXE;.BAT;.CMD;…` 라 진짜 실행 파일이 먼저 걸린다.
 *
 * **Windows 에서는 확장자 없는 이름을 후보로 세지 않는다.** npm 이 까는 CLI 는 확장자 없는 셸
 * 스크립트와 `.cmd` 셔임을 나란히 두는데(`…/npm/codex` 와 `…/npm/codex.cmd`), 이름을 그대로
 * 먼저 보면 앞의 것이 걸려 `spawn ENOENT` 로 죽는다 — 그건 Git Bash 용이라 Windows 가 못 띄운다
 * (2026-09-01 codex 실측). cmd.exe 도 PATHEXT 에 있는 확장자만 실행한다.
 */
function resolveBin(cmd, env = process.env) {
  const name = String(cmd);
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  let exts = [''];
  if (process.platform === 'win32') {
    const pathext = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    // 이미 실행 확장자가 붙은 이름(`agy.exe`)만 그대로도 후보다.
    const has = pathext.some((e) => e.toLowerCase() === extname(name).toLowerCase());
    exts = has ? ['', ...pathext] : pathext;
  }
  if (name.includes('/') || name.includes('\\') || isAbsolute(name)) {
    for (const e of exts) if (isFile(name + e)) return name + e;
    return name;
  }
  for (const dir of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const e of exts) {
      const p = join(dir.replace(/^"|"$/g, ''), name + e);
      if (isFile(p)) return p;
    }
  }
  return name;
}

/**
 * Windows 명령줄용 인자 따옴표. 토큰을 통째로 큰따옴표로 감싸므로 `&`·`|`·`<`·`>` 는 cmd 에게도
 * 평범한 글자가 된다 — 캐럿(`^`)을 덧붙이면 안 된다(셔임의 `%*` 가 그 캐럿을 그대로 넘겨서
 * 에이전트가 `^&` 를 받는다. 2026-09-01 실측).
 *
 * **온전히 안 가는 두 가지**: 인자 안의 큰따옴표는 배치 셔임의 두 번째 파싱에서 사라지고,
 * `%VAR%` 는 cmd 가 펼친다. 슬라이스 지시문에는 둘 다 안 나오지만 `--prompt` 를 손으로 줄 때는 피한다.
 */
function quoteWinArg(arg) {
  return '"' + String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

/**
 * spawn 에 넘길 것. 배치 셔임(`.cmd`/`.bat`)은 Node 18+ 가 셸 없이 못 띄우므로(spawn EINVAL,
 * CVE-2024-27980 대응) `cmd.exe /d /s /c` 를 통해 부른다. npm 으로 깐 CLI 는 대개 이쪽이다 —
 * `codex` 가 그렇다(`%APPDATA%/npm/codex.cmd`).
 */
function spawnSpec(cmd, args, env = process.env) {
  const file = resolveBin(cmd, env);
  if (process.platform === 'win32' && /^\.(cmd|bat)$/i.test(extname(file))) {
    const line = [file, ...args].map(quoteWinArg).join(' ');
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
  }
  return { file, args, verbatim: false };
}

/** 이 워크스페이스에 아직 아무 원격에도 없는 커밋 수. 합성 카드의 "커밋 K개" 다. */
function localCommits(cwd) {
  try {
    return Number(git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd)) || 0;
  } catch {
    return 0;
  }
}

/**
 * 그 워크트리에 **아직 안 끝난 래퍼 턴**이 있으면 그 세션 id, 없으면 null. 부수효과가 없다.
 *
 * 착륙의 유휴 판정(`fleet.turnStateFor`)은 헤드리스를 **가장 최근 래퍼 턴 하나**로 가른다 — 래퍼는
 * 턴마다 새 세션을 만들어서 최신 기록이 곧 지금 상태이기 때문(옛 기록이 섞인 slice6 실측). 그래서
 * 한 워크트리에 래퍼 턴을 겹쳐 띄우면, 짧은 쪽이 끝나는 순간 긴 본 턴이 "끝난 것"으로 읽혀 착륙이
 * 그 워크스페이스를 지울 수 있다(2026-09-02 slice7: 워커가 문서 예시를 검증하느라 본 턴 안에서
 * `worker --prompt` 를 돌렸고, 트리가 더러워 안 지워졌을 뿐이다). 래퍼가 시작 전에 이걸 보고 거부한다.
 *
 * 묵은 열린 턴(`TURN_STALE_MS` 넘게)은 무시한다 — 착륙과 같은 잣대. 안 그러면 죽은 래퍼 기록 하나가
 * 그 워크트리의 손 실행을 영영 막는다. TUI(Claude) 세션은 안 센다 — 착륙도 그 판정에서 TUI 창은 따로 본다.
 */
function openWrapperTurn(cwd, sessions, now = Date.now()) {
  const want = normPath(worktreeRoot(cwd) || cwd);
  for (const [id, e] of Object.entries(sessions || {})) {
    if (!e || !e.agent || e.agent === 'claude') continue;
    if (normPath(e.worktree) !== want) continue;
    const open = (e.turnStartedAt || 0) > (e.turnEndedAt || 0);
    if (open && now - e.turnStartedAt < TURN_STALE_MS) return id;
  }
  return null;
}

/** 겹친 래퍼 턴을 거부할 때의 종료 코드 (sysexits 의 EX_TEMPFAIL — "나중에 다시"). */
const EXIT_BUSY = 75;

/**
 * 세션 기록을 저장하지 못해 자식을 안 띄웠을 때의 종료 코드 (sysexits 의 EX_IOERR).
 * **`EXIT_BUSY` 와 달라야 한다** — 겹침 거부는 "그 턴이 끝나면 다시" 지만 이쪽은
 * `~/.sp-sync/state.json` 이나 그 락이 상한 것이라 사람이 봐야 한다.
 */
const EXIT_NOSESSION = 74;

/**
 * 그 기록이 **디스크에** 있고 이 래퍼의 것인지 다시 읽어 확인한다.
 *
 * `ensureSession` 의 반환값만으로는 "락을 잡고 fn 이 돌았다" 까지다. 파일을 한 번 더 읽는 값은
 * 싸고(훅 하나가 이미 state.json 을 2~4번 읽는다) 얻는 것은 확실하다 — 아래 refuse 경로가
 * "기록이 없다" 를 근거로 자식을 막는 이상, 근거는 추정이 아니라 파일이어야 한다.
 */
function sessionSaved(sessionId, agent) {
  try {
    const e = state().sessions[sessionId];
    return !!(e && e.agent === agent && e.turnStartedAt);
  } catch {
    return false; // 반쯤 쓰인 state.json — 확인 못 한 것은 실패다
  }
}

/**
 * 헤드리스 워커의 한 턴. 종료 코드를 그대로 돌려준다(진입점이 그 값으로 끝난다).
 *
 * `force` 는 겹침 거부(`openWrapperTurn`)의 우회다 — 겹쳐 돌리면 착륙이 본 턴을 잘못 읽을 수 있음을
 * 알고 쓰는 자리라 파견·착륙은 안 쓰고 사람이 `--force` 로만 준다.
 *
 * `deps` 는 테스트가 갈아끼우는 자리다: `onTurnEnd`(진입점의 `CMDS.stop`), `sessionId`, `profile`,
 * `sessions`(겹침 판정이 읽는 세션 기록), `limitOf`(턴 끝의 한도 읽기), `now`.
 */
async function runWorker({ agent, slice = null, prompt = null, hard = false, force = false, cwd = process.cwd() }, deps = {}) {
  const cfg = deps.config || config();
  const profile = deps.profile || agentProfile(agent, cfg);
  let text = prompt ? String(prompt) : null;
  if (!text) {
    if (!/^\d+$/.test(String(slice ?? ''))) throw new Error('--slice <번호> 나 --prompt <문장> 중 하나가 필요합니다');
    text = SLICE_PROMPT.replace('{N}', String(Number(slice)));
  }

  // 겹침 거부 — 세션을 만들기 **전에** 본다. 만들고 나서 물러나면 그 기록 자체가 "열린 래퍼 턴"이 된다.
  if (!force) {
    let sessions = {};
    try {
      sessions = deps.sessions ? deps.sessions() : state().sessions || {};
    } catch {} // 반쯤 쓰인 state.json — 모르면 막지 않는다 (막히는 쪽의 비용이 더 크다: 워커가 아예 안 뜬다)
    const busy = openWrapperTurn(cwd, sessions, deps.now ? deps.now() : Date.now());
    if (busy) {
      const msg = '같은 워크트리에 아직 안 끝난 래퍼 턴이 있음: ' + busy + ' — 겹쳐 돌리면 착륙이 본 턴을 끝난 것으로 읽는다. 그 턴이 끝난 뒤에 다시 띄우거나 --force';
      log('worker 거부 ' + agent + ': ' + msg);
      console.error('[sp-sync worker] ' + agent + ' 거부 (exit ' + EXIT_BUSY + '): ' + msg);
      return EXIT_BUSY;
    }
  }

  const sessionId = deps.sessionId || workerSessionId(agent);
  // 턴 시작을 **띄우기 전에** 찍는다. 이 값이 열려 있는 동안은 착륙이 "작업 중"으로 보고
  // 손대지 않는다 — 뒤로 밀면 그 틈에 회차가 워크스페이스를 유휴로 읽는다.
  // `claimRepo: false` — 본체의 "마지막 프롬프트 창" 자리를 차지하지 않는다(`ensureSession` 주석).
  // `init` 으로 `agent` 표시를 **같은 락 쓰기에** 실어 보낸다. 착륙·미파견 판정이 "이 워크스페이스는
  // 헤드리스" 를 그 한 글자로 안다 — TUI 의 화면 판정(`❯`·tui-idle)은 셸 프롬프트에서 뜻이 없다.
  const saved = ensureSession(sessionId, cwd, text, { claimRepo: false, init: (e) => (e.agent = agent) });

  // **기록을 못 남겼으면 자식을 안 띄운다.** 락은 3초 안에 못 잡으면 조용히 물러나는데(`withStateLock`),
  // 예전에는 그 반환값을 안 봐서 기록 없이 에이전트가 떴다. 그러면 셋이 한꺼번에 어긋난다:
  // 착륙이 그 워크스페이스를 옛 기록으로 판정하거나 "기록 없음" 으로 굳고, 자식이 낸 커밋의
  // post-commit 훅이 `CLAUDE_CODE_SESSION_ID` 로 세션을 못 찾아 "세션 밖 커밋"(`repos`)으로
  // 떨어지며, 턴 경계가 없어 회차가 이 창을 유휴로 읽는다. 안 띄우고 종료 코드로 알리는 편이
  // 싸다 — 파견이면 다음 회차가 다시 띄운다.
  // (2026-09-02 codex 실측에서 기본·xhigh 가 공통으로 찾은 구멍이다. `notes/2026-09-02-codex-xhigh-실측.md`)
  if (!saved || !sessionSaved(sessionId, agent)) {
    const msg = '세션 기록을 저장하지 못했다 (state.lock 경합 또는 state.json 손상) — 기록 없이 띄우면 착륙·커밋 귀속·턴 경계가 다 어긋난다';
    log('worker 거부 ' + agent + ' [' + sessionId + ']: ' + msg);
    console.error('[sp-sync worker] ' + agent + ' 거부 (exit ' + EXIT_NOSESSION + '): ' + msg);
    return EXIT_NOSESSION;
  }

  const argv = buildAgentArgs(profile, { path: cwd, prompt: text, hard });
  const spec = spawnSpec(profile.cmd, argv);
  log('worker 시작 ' + agent + ' [' + sessionId + '] ' + clean(text, 120));

  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.file, spec.args, {
        cwd,
        // 사용자가 Orca 탭에서 진행을 그대로 본다. 헤드리스라도 화면은 있어야 한다.
        // **stdin 도 물려준다** — 파견은 터미널(PTY)에서 띄우므로 자식의 stdin 이 TTY 다.
        // `ignore` 로 막으면 codex 가 그걸 파이프로 보고 "stdin 을 프롬프트에 이어 붙인다"는
        // 경로로 들어간다 (2026-09-01 실측: 파이프로 돌렸을 때 그 줄이 떴다).
        stdio: 'inherit',
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
      });
    } catch (e) {
      log('worker spawn 실패 ' + agent + ': ' + clean(e.message, 200));
      return resolve(127);
    }
    child.on('error', (e) => {
      log('worker spawn 실패 ' + agent + ': ' + clean(e.message, 200));
      resolve(127);
    });
    child.on('close', (c, sig) => resolve(c === null ? (sig ? 128 : 1) : c));
  });

  // 프로세스 종료 = 턴 끝. `onTurnEnd`(=`CMDS.stop`)도 같은 값을 다시 찍지만, 이 래퍼는
  // 그것 없이도 턴 경계를 온전히 남겨야 한다 — 착륙이 읽는 건 이 두 시각뿐이다.
  //
  // 종료 코드와 그 순간의 한도를 같이 남긴다. 둘 다 지금까지는 로그와 합성 카드에만 있어서
  // **착륙이 읽을 재료가 없었다** — "codex 가 exit 1 로 죽었다" 와 "한도에 막혀 죽었다" 를
  // 가르는 것이 인계 판정의 첫 갈래인데, 카드 문장은 기계가 읽을 것이 못 된다.
  // 한도는 자식이 끝난 **직후** 읽어야 그 턴의 사진이 된다(codex 는 마지막 턴의 rollout 에 적는다).
  // 모르면 null 이고, null 은 부르는 쪽에서 "여유" 다 — 모른다는 이유로 막지 않는다.
  const limit = (deps.limitOf || limitOf)(agent);
  patchSession(sessionId, (e) => {
    e.turnEndedAt = Date.now();
    e.exitCode = code;
    e.limit = limit;
  });

  // 규칙 문서의 카드 스니펫을 그대로 따른 에이전트는 이미 drop 카드를 써 뒀다. 안 썼으면
  // 여기서 대신 떨군다 — 2순위인 "답변 본문 긁기" 는 Claude 전사기록 전용이라 헤드리스에는
  // 읽을 것이 없고, 카드가 없으면 status.md 도 Orca 코멘트도 그 턴을 통째로 놓친다.
  if (!hasDrop(sessionId)) {
    const k = localCommits(cwd);
    writeDrop(sessionId, { now: agent + ' 종료 (exit ' + code + ') · 커밋 ' + k + '개' });
  }

  const onTurnEnd = deps.onTurnEnd;
  if (onTurnEnd) await onTurnEnd({ session_id: sessionId, cwd });
  else log('worker: onTurnEnd 가 없어 카드·SP 기록을 건너뛴다 [' + sessionId + ']');

  console.log('[sp-sync worker] ' + agent + ' exit ' + code);
  return code;
}

export { EXIT_BUSY, EXIT_NOSESSION, SLICE_PROMPT, agentProfile, buildAgentArgs, localCommits, openWrapperTurn, quoteWinArg, resolveBin, runWorker, sessionSaved, spawnSpec, workerSessionId };
