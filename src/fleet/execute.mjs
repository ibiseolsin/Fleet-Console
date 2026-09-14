import { fixtureRoot } from '../state.mjs';
/**
 * 실행 층 (슬라이스 4) — 승인된 파견·착륙을 **샌드박스 픽스처 위에서 진짜로** 돌린다.
 *
 * **판정도 실행 순서도 새로 만들지 않는다.** sp-sync 의 `dispatchOne` · `landOne` 을 그대로 부르고,
 * 그 둘이 바깥(Orca CLI · gh · 실제 `~/.sp-sync/`)과 닿는 자리만 갈아 끼운다. 두 함수는 이미
 * 주입 구멍(`DISPATCH_DEPS` · `LAND_DEPS`)을 열어 두고 있다 — 그 구멍이 이 파일의 전부다.
 * 순서를 흉내 내 다시 쓰면(검사 → push → PR → 충돌 → 최종 게이트 → 머지) 화면이 보여 주는 것과
 * 실제 플릿이 하는 것이 갈린다.
 *
 * **바깥을 절대 건드리지 않는다** (`PLAN.md` 슬라이스 4의 함정). 갈아 끼우는 자리는 셋이다:
 *   - Orca CLI (`orca worktree create` · `terminal create` · `worktree rm`) → 픽스처 폴더의 git 과
 *     `sandbox/fleet/state/*.json` 에 직접 쓴다. 창은 기록만 있고 실제 프로세스는 없다.
 *   - gh (`pr create` · `pr view` · `pr merge`) → `sandbox/fleet/state/prs.json` 의 가짜 PR 표와
 *     픽스처의 bare 원격에 대한 **실제 git 머지**. 커밋은 진짜로 옮겨간다.
 *   - `landCleanup` (Orca 목록 · 공유 자원 해제) → 픽스처 전용 정리로 바꾼다. 실제 자원 예약
 *     (`~/.sp-sync/resources.json`)에는 손대지 않는다.
 *
 * 회차 락(`fleet-run.lock`)·방아쇠(`fleet-trigger.json`)·회차 결과 파일은 `fleetCycle`·`fleetTrigger`
 * 만 쓰는 것이라 여기서는 아예 부르지 않는다 — 그래서 안 변한다. `scripts/mcp-write-check.mjs` 가
 * 호출 전후로 그 셋을 해시로 대조한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_CONFIG, normPath, sliceInPlan, parsePlanSlices } from '../../sp-sync/lib/common.mjs';
import { LAND_DEPS, dispatchCommand, dispatchOne, landCheck, landOne, sliceCommandFor } from '../../sp-sync/lib/fleet.mjs';
import { fixtureSlices, loadFixture, projectRoot } from '../../scripts/fixture.mjs';
import { observeFleet } from './source.mjs';

const stateDir = () => join(fixtureRoot(), 'state');

/**
 * 샌드박스의 검사 명령 — 운영의 `~/.sp-sync/config.json` `fleetChecks` 자리다 (`PLAN.md` 메모).
 * 픽스처 프로젝트에는 돌릴 테스트가 없지만 **검사 단계 자체는 태운다**: `landOne` 의 최종 게이트가
 * "검사한 SHA = 로컬 = PR 머리" 로 머지 여부를 가르므로, 검사를 건너뛰면 그 게이트가 안 확인된다.
 */
const SANDBOX_CHECK = 'node --version';

/** 파견 모델. 실제 파견과 같은 두 갈래 — `[어려움]` 만 최상위(`hardModel`). */
const DISPATCH_MODELS = { model: 'opus', hardModel: 'fable' };

/** 착륙 판정에 넘기는 값. `source.mjs` 의 `LAND_OPTS` 와 같아야 한다 — 자격 판정과 실행이 같은 잣대를 봐야 한다. */
const LAND_OPTS = { baseRef: 'origin/main', quietMs: 120000, idleMs: 5000 };

const GIT_ID = ['-c', 'user.name=Fixture Bot', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

function git(args, cwd) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

/** 실패해도 던지지 않는 git. `gitTry` 와 같은 모양(`{ok, out, detail}`)으로 낸다. */
function gitTry(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd), detail: '' };
  } catch (e) {
    return { ok: false, out: '', detail: String(e.stderr || e.message).trim().split('\n')[0] };
  }
}

// ---------- 픽스처 상태 파일 ----------
// Orca 가 쥐고 있는 것들(창 목록·워크트리 목록·세션 기록)을 픽스처에서는 이 셋이 대신한다.
// 파견이 만들고 착륙이 지운다 — 안 고치면 `fleet_status` 가 방금 만든 워크스페이스를 못 보거나
// 방금 지운 것을 계속 보여 준다.

const stateFile = (f) => join(stateDir(), f);

function readState(f, fallback) {
  try {
    return JSON.parse(readFileSync(stateFile(f), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeState(f, v) {
  mkdirSync(stateDir(), { recursive: true });
  const p = stateFile(f);
  const tmp = p + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, p);
}

const sameP = (a, b) => normPath(a || '') === normPath(b || '');

/** 새 워크스페이스를 Orca 워크트리 목록에 올린다. */
function addWorktreeRecord(path, branch) {
  const list = readState('worktrees.json', []).filter((w) => !sameP(w.path, path));
  list.push({ path, branch, isMainWorktree: false, lastActivityAt: Date.now() });
  writeState('worktrees.json', list);
}

/** 창 하나를 연다. 실제 프로세스는 없다 — `activeCount` 와 유휴 판정이 보는 기록만 만든다. */
function addTerminalRecord(path, handle) {
  const list = readState('terminals.json', []).filter((t) => t.handle !== handle);
  list.push({ handle, worktreePath: path, connected: true, lastOutputAt: Date.now() });
  writeState('terminals.json', list);
  return handle;
}

/**
 * 턴 시작을 세션 기록에 찍는다 — TUI 는 훅이, 헤드리스는 래퍼가 하는 일이다.
 * **턴을 열어 둔 채로** 둔다(`turnEndedAt` 없음): 방금 파견된 워크스페이스는 도는 중이어야
 * 하고, 그래야 `landCheck` 가 "작업 중" 으로, `dispatchPlan` 이 "이미 돌고 있음" 으로 본다.
 */
function addSessionRecord(id, { path, root, agent = null }) {
  const s = readState('sessions.json', {});
  s[id] = { worktree: path, cwd: root, ...(agent ? { agent } : {}), turnStartedAt: Date.now() };
  writeState('sessions.json', s);
}

/** 워크스페이스가 사라졌다 — 그 경로에 걸린 기록을 전부 걷는다. 남으면 유령 워크스페이스가 된다. */
function dropWorkspaceRecords(path) {
  writeState('worktrees.json', readState('worktrees.json', []).filter((w) => !sameP(w.path, path)));
  writeState('terminals.json', readState('terminals.json', []).filter((t) => !sameP(t.worktreePath, path)));
  const s = readState('sessions.json', {});
  for (const [k, v] of Object.entries(s)) if (sameP(v.worktree, path)) delete s[k];
  writeState('sessions.json', s);
}

// ---------- 가짜 PR 표 ----------
// gh 가 하는 일 중 착륙이 쓰는 것은 넷이다: PR 조회 · 생성 · 머지 · 충돌 여부. 픽스처의 원격은
// bare git 저장소라 그 넷을 여기서 만든다. **머지는 진짜다** — `git merge` 로 본체 main 에 붙이고
// bare 원격에 민다. 그래야 "픽스처에 실제로 반영된다" 를 커밋으로 확인할 수 있다.

const prKey = (project, branch) => project + '/' + branch;

/** PR 머리는 **원격의** 브랜치 머리다 — 로컬만 앞선 상태를 머지 가능으로 읽으면 게이트가 뚫린다. */
function remoteHead(root, branch) {
  return gitTry(['rev-parse', 'refs/remotes/origin/' + branch], root).out || null;
}

/**
 * 머지 가능한가. `git merge-tree --write-tree` 는 머지를 실제로 만들지 않고 충돌만 본다 —
 * 0이 아닌 종료 코드가 충돌이다. 명령을 못 쓰면 `UNKNOWN` 으로 두고 막지 않는다:
 * 모르는 것을 충돌이라 하면 착륙이 영영 안 돈다.
 */
function mergeableOf(root, branch) {
  const head = remoteHead(root, branch);
  if (!head) return 'UNKNOWN';
  try {
    execFileSync('git', ['merge-tree', '--write-tree', 'refs/remotes/origin/main', head], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return 'MERGEABLE';
  } catch (e) {
    return e.status === 1 ? 'CONFLICTING' : 'UNKNOWN';
  }
}

function readPr(root, project, branch) {
  const store = readState('prs.json', { next: 1, items: {} });
  const rec = store.items[prKey(project, branch)];
  if (!rec) return null;
  // 저장된 것은 번호·상태·url 뿐이다. 머리와 충돌 여부는 **부를 때마다 git 에서 다시 잰다** —
  // 그 사이에 워커가 커밋을 얹었을 수 있고, 실제 gh 도 그때그때의 값을 낸다.
  return rec.state === 'MERGED'
    ? { ...rec, mergeable: 'MERGEABLE' }
    : { ...rec, headRefOid: remoteHead(root, branch), mergeable: mergeableOf(root, branch) };
}

function createPr(root, project, branch) {
  const store = readState('prs.json', { next: 1, items: {} });
  const number = store.next;
  store.next = number + 1;
  store.items[prKey(project, branch)] = {
    number,
    state: 'OPEN',
    url: 'sandbox://' + project + '/pull/' + number,
    headRefOid: remoteHead(root, branch),
    createdAt: new Date().toISOString(),
  };
  writeState('prs.json', store);
  return store.items[prKey(project, branch)];
}

function markMerged(root, project, branch, sha) {
  const store = readState('prs.json', { next: 1, items: {} });
  const rec = store.items[prKey(project, branch)];
  if (!rec) return null;
  rec.state = 'MERGED';
  rec.headRefOid = sha;
  rec.mergedAt = new Date().toISOString();
  writeState('prs.json', store);
  return rec;
}

// ---------- 파견의 손 ----------

/** `--name x` 꼴 인자에서 값 하나를 꺼낸다. */
const argOf = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

/**
 * `DISPATCH_DEPS` 를 픽스처용으로 갈아 끼운다.
 *
 * `opts.repoId` 자리에 **본체 경로**를 넣어 부른다 — 실제 파견은 Orca 저장소 id 를 쓰지만
 * 여기서는 `--repo id:<경로>` 로 들어와 그대로 다시 나온다. 워크트리 id 도 경로다.
 */
function dispatchDeps(fx) {
  // The vendored repoRoot returns Windows separators even on Linux. Fixture roots
  // are already canonical project paths; use the fixture layout at this IO boundary.
  const workspaceDir = (root) => join(fixtureRoot(), 'orca', 'workspaces', basename(root));
  return {
    nameTaken: (root, name) => {
      const p = join(workspaceDir(root), name);
      return existsSync(p) ? p : null;
    },
    // Orca 의 `worktree create` 자리. TUI 파견(`--agent claude`)은 Orca 가 창까지 열어 주므로
    // 여기서 창 기록도 같이 만든다 — 헤드리스는 아래 `createTerminal` 이 따로 연다.
    createWorktree: (args) => {
      const root = String(argOf(args, '--repo') || '').replace(/^id:/, '');
      const name = argOf(args, '--name');
      const path = join(workspaceDir(root), name);
      mkdirSync(dirname(path), { recursive: true });
      git(['worktree', 'add', '-b', name, path, 'origin/main'], root);
      addWorktreeRecord(path, name);
      const tui = args.includes('--agent');
      const handle = tui ? addTerminalRecord(path, 'term_' + basename(root) + '_' + name) : null;
      // `newWorktreeOf` 가 이미 푼 모양으로 낸다 — 이 자리에 오는 실제 값이 그 함수의 결과다.
      // 워크트리 id 는 경로 그대로 쓴다: 아래 `createTerminal` 이 `--worktree id:<경로>` 로 받는다.
      return { id: path, path, handle };
    },
    // 훅이 세션 기록을 찍을 때까지 기다리는 자리. 픽스처에는 기다릴 프로세스가 없으니 그 기록을 만든다.
    waitForSession: async (path, since, ms) => {
      const p = fx.io.projectOf(path);
      addSessionRecord(p.name + '-' + basename(path), { path, root: p.root });
      return { ok: true, detail: '' };
    },
    // 헤드리스 래퍼가 도는 창. 래퍼는 제 프로세스가 뜨자마자 세션 기록을 찍으므로 여기서 같이 찍는다.
    createTerminal: (args) => {
      const path = String(argOf(args, '--worktree') || '').replace(/^id:/, '');
      const name = argOf(args, '--title') || basename(path);
      const p = fx.io.projectOf(path);
      const handle = addTerminalRecord(path, 'term_' + p.name + '_' + name);
      addSessionRecord(p.name + '-' + name, { path, root: p.root, agent: 'codex' });
      return handle;
    },
    // 설정 훅이 남기는 파일. 헤드리스 파견은 이것이 생겨야 래퍼를 띄운다.
    waitForHooks: async (path) => {
      const f = join(path, '.claude', 'settings.local.json');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({ note: '샌드박스 파견이 만든 자리 표시' }, null, 2) + '\n');
      return true;
    },
    waitForPrompt: async () => ({ ok: true, detail: '' }),
    sessions: () => readState('sessions.json', {}),
    waitIdle: () => true,
    // 픽스처에는 여분 탭이 없다. 파견은 이 값의 성패와 무관하게 간다.
    closeExtraTabs: () => ({ ok: true, closed: [], detail: '' }),
    send: async () => ({ sent: true, result: '샌드박스 — 보낼 창이 없다' }),
    projectOf: (path) => fx.io.projectOf(path).name,
    // **기다리지 않는다.** 실제 파견은 설정 훅이 끝나기를 3초 기다리지만 픽스처에는 기다릴 것이 없고,
    // 회차 하나가 10초 안에 끝나야 한다 (`PRD.md §8`).
    sleep: async () => {},
    removeWorktree: (repoId, path) => gitTry(['worktree', 'remove', '--force', path], repoId),
    removeDir: (path, root) => {
      try {
        rmSync(path, { recursive: true, force: true });
        return { ok: true, detail: '' };
      } catch (e) {
        return { ok: false, detail: String(e.message) };
      }
    },
    setStatus: () => ({}),
  };
}

// ---------- 착륙의 손 ----------

/**
 * 착륙 뒤 정리 — 실제 `landCleanup` 자리. 하는 일은 같다(워크스페이스 삭제 → 브랜치 삭제 →
 * 본체 ff). 다른 것은 둘뿐이다: Orca 목록 대신 픽스처 상태 파일을 걷고, **공유 자원 해제를
 * 하지 않는다** — 그 표는 실제 `~/.sp-sync/` 에 있어서 건드리면 도는 플릿이 영향을 받는다.
 */
async function sandboxCleanup(w, r, step, opts) {
  const rm = gitTry(['worktree', 'remove', '--force', w.path], opts.root);
  step('worktree rm', rm.ok, rm.detail);
  if (existsSync(w.path)) {
    try {
      rmSync(w.path, { recursive: true, force: true });
      step('폴더 삭제', true, '');
    } catch (e) {
      step('폴더 삭제', false, String(e.message));
    }
  } else {
    step('폴더 삭제', true, 'worktree remove 가 이미 치움');
  }
  dropWorkspaceRecords(w.path);
  step('기록 삭제', true, '워크트리·창·세션');
  const rmRemote = gitTry(['push', 'origin', '--delete', w.branch], opts.root);
  const rmLocal = gitTry(['branch', '-D', w.branch], opts.root);
  step('브랜치 삭제', rmRemote.ok || rmLocal.ok, [rmRemote.ok ? '원격' : '', rmLocal.ok ? '로컬' : ''].filter(Boolean).join('·') || rmRemote.detail);
  const pull = gitTry(['pull', '--ff-only'], opts.root);
  step('본체 pull --ff-only', pull.ok, pull.ok ? '' : pull.detail);
  return { ...r, ok: true, ff: pull.ok };
}

/**
 * `LAND_DEPS` 를 픽스처용으로. **바깥과 닿는 다섯만 갈아 끼운다** — 나머지 셋
 * (`head` · `check` · `recheck`)은 로컬 git 과 픽스처 폴더만 보므로 실제 것을 그대로 쓴다.
 * 파견 쪽과 달리 여기서는 기본 표를 펼쳐 깐다: 착륙의 손 여덟 중 실제로 위험한 것이 어느 것인지가
 * 이 목록에 그대로 드러나야 한다.
 */
function landDeps(fx, project, root) {
  const branchOf = (path) => gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], path).out;
  return {
    ...LAND_DEPS,
    read: async (path) => readPr(root, project, branchOf(path)),
    push: async (path, first) => gitTry(first ? ['push', '-u', 'origin', 'HEAD'] : ['push', 'origin', 'HEAD'], path),
    create: (path) => createPr(root, project, branchOf(path)),
    merge: (path, number) => {
      const branch = branchOf(path);
      const msg = 'Merge pull request #' + number + ' from ' + project + '/' + branch;
      git(['merge', '--no-ff', '-m', msg, branch], root);
      git(['push', 'origin', 'main'], root);
      markMerged(root, project, branch, remoteHead(root, branch));
    },
    /**
     * 충돌 해소는 **워커 세션이 하는 일**이다 (`conflictLoop` — 그 세션에 문장을 보내 풀게 한다).
     * 픽스처에는 살아 있는 세션이 없으므로 시도하지 않고 사람에게 올린다. 실제 루프를 흉내 내
     * "2회 시도했다" 고 적으면 회차 상세가 거짓이 된다 — 시나리오 9(충돌 2회 실패)는 회차 기록을
     * 재생하는 슬라이스 8의 몫이다.
     */
    conflict: async (w, pr, opts, step) => {
      if (pr?.mergeable !== 'CONFLICTING') return { pr };
      step('충돌 해소', false, '샌드박스에는 워커 세션이 없어 해소를 시도하지 않는다 — 사람에게 올림');
      return { pr, noTerminal: true };
    },
    cleanup: sandboxCleanup,
  };
}

// ---------- 도구가 부르는 자리 ----------

/** 프로젝트 하나를 관찰한 결과. 없는 프로젝트면 null. */
function observeOne(project, now) {
  return observeFleet({ now, projects: [project] }).projects[0] || null;
}

/**
 * 파견 하나. **자격 판정은 다시 하지 않는다** — `observeFleet` 이 부른 `dispatchPlan` 의 결과를
 * 그대로 본다. 자격이 없으면 사유(`reason`)와 갈래(`hold`)를 그대로 실어 거부한다.
 */
async function planDispatch(project, number, { now = Date.now() } = {}) {
  const p = observeOne(project, now);
  if (!p) return { ok: false, error: '그런 프로젝트가 픽스처에 없다: ' + project };
  const row = p.slices.find((s) => s.number === number);
  if (!row) return { ok: false, error: project + ' 계획서의 현재 단계에 ' + number + '번이 없다' };
  if (row.done) return { ok: false, error: number + '번은 이미 완료(체크)된 슬라이스다 — 파견 대상이 아니다', slice: row };
  if (!row.eligible) return { ok: false, error: '파견 자격 없음: ' + row.reason, hold: row.hold, reason: row.reason, slice: row };
  if (row.redispatch) return { ok: false, error: '재파견 대상이다(' + row.redispatch + ') — 이 도구는 새 파견만 한다', slice: row };
  return { ok: true, project: p, slice: row, command: dispatchCommandOf(project, number, now) };
}

/**
 * 그 슬라이스가 뜬다면 어떤 명령인가. **승인 화면이 보여 줄 것**이다 — 사람은 "어느 에이전트에게"
 * 를 이 한 줄로 본다 (`PRD.md §5`). 못 만들면(모르는 에이전트·빈 모델) null 이고, 그래도 판정은
 * 그대로 간다: 명령을 못 만드는 것은 `dispatchOne` 이 자기 자리에서 사유와 함께 낸다.
 */
function dispatchCommandOf(project, number, now = Date.now()) {
  try {
    const s = fixtureSlices(project, loadFixture(now)).slices.find((x) => x.number === number);
    return s ? dispatchCommand(s, sliceCommandFor(projectRoot(project), number), { ...DISPATCH_MODELS, agents: DEFAULT_CONFIG.fleetAgents }) : null;
  } catch {
    return null;
  }
}

/**
 * 승인된 파견을 실행한다. `dispatchOne` 을 그대로 부른다 — 이름 밀림 확인, 워크스페이스 생성,
 * 헤드리스/TUI 두 갈래, 시작 확인까지 실제 파견과 같은 순서다.
 */
async function runDispatch(project, number, { now = Date.now() } = {}) {
  const fx = loadFixture(now);
  const r = fixtureSlices(project, fx);
  const slice = r.slices.find((s) => s.number === number);
  if (!slice) return { ok: false, error: project + ' 계획서에 ' + number + '번이 없다' };
  const root = projectRoot(project);
  const d = await dispatchOne(
    slice,
    { ...DISPATCH_MODELS, agents: DEFAULT_CONFIG.fleetAgents, readyMs: 5000, createMs: 5000, exitWatchMs: 0, repoId: root, project, root },
    dispatchDeps(fx)
  );
  // 시도가 아니라 **결과**를 한 낱말로. `fleetDispatch` 가 회차 보고에 싣는 값과 같은 잣대다.
  d.outcome = !d.ok ? 'failed' : d.exited ? 'exited' : 'started';
  return { ok: !!d.ok, dispatched: d };
}

/** 착륙 판정 하나 — 워크스페이스 이름(`sliceN`)으로 고른다. */
function planLand(project, workspace, { now = Date.now() } = {}) {
  const fx = loadFixture(now);
  const r = fixtureSlices(project, fx);
  const w = r.workspaces.find((x) => x.name === workspace);
  if (!w) return { ok: false, error: project + ' 에 그런 워크스페이스가 없다: ' + workspace + ' (있는 것: ' + (r.workspaces.map((x) => x.name).join(', ') || '없음') + ')' };
  const c = landCheck(w, { ...LAND_OPTS, now });
  if (!c.ready) return { ok: false, error: '착륙 자격 없음: ' + c.reason, reason: c.reason, check: c, workspace: w };
  return { ok: true, check: c, workspace: w, root: projectRoot(project), fx };
}

/** 승인된 착륙을 실행한다. `landOne` 을 그대로 부른다 — 검사 → push → PR → 최종 게이트 → 머지 → 정리. */
async function runLand(project, workspace, { now = Date.now() } = {}) {
  const p = planLand(project, workspace, { now });
  if (!p.ok) return p;
  const root = p.root;
  const opts = {
    ...LAND_OPTS,
    now,
    check: SANDBOX_CHECK,
    checkMs: 60000,
    ghMs: 60000,
    conflictTries: 2,
    conflictMs: 60000,
    baseBranch: 'main',
    root,
    repoId: root,
    json: true, // landOne 이 화면에 직접 찍지 않게 한다 — 단계는 결과의 `steps` 로 나간다
    quiet: true,
  };
  const d = await landOne(p.workspace, p.check, opts, landDeps(p.fx, project, root));
  return { ok: !!d.ok, landed: d };
}

/** 본체 PLAN.md 에서 그 슬라이스가 체크됐는가 — 착륙이 실제로 반영됐는지 보는 재료다. */
function planSliceDone(project, number) {
  try {
    const s = sliceInPlan(parsePlanSlices(readFileSync(join(projectRoot(project), 'PLAN.md'), 'utf8')), number);
    return s ? !!s.done : null;
  } catch {
    return null;
  }
}

export { SANDBOX_CHECK, dispatchCommandOf, planDispatch, planLand, planSliceDone, runDispatch, runLand };
