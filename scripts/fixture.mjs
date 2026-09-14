#!/usr/bin/env node
import { fixtureRoot } from '../src/state.mjs';
/**
 * 샌드박스 플릿 픽스처 (슬라이스 2) — 판정 함수 셋을 실제 기계 없이 부를 수 있게 하는 가짜 플릿.
 *
 * `landCheck` 는 "부수효과 없음" 이라는 주석과 달리 **디스크를 직접 읽는다** — 폴더 존재·
 * 워크스페이스 `PLAN.md`·`git status`·`git log`. 그래서 픽스처는 순수 객체가 아니라 **실제 폴더와
 * 실제 git 저장소**여야 한다. 그 실물을 `sandbox/fleet/` 아래에 만든다 (git 이 무시한다 — 언제든
 * `node scripts/fixture.mjs` 로 다시 만든다).
 *
 * 폴더 배치는 운영 플릿과 **같은 모양**이다. `workspacesDirOf(root, home)` 가
 * `<home>/orca/workspaces/<본체 폴더명>` 을 내므로, `home` 만 이 픽스처 루트로 주면 sp-sync 의
 * 경로 계산이 그대로 맞는다 (슬라이스 4의 쓰기 도구가 쓸 자리다):
 *
 *   sandbox/fleet/
 *     orca/projects/<프로젝트>/            본체 (git, origin 붙음)
 *     orca/workspaces/<프로젝트>/sliceN/    워크스페이스 (linked worktree, 브랜치 sliceN)
 *     origin/<프로젝트>.git                 원격 (bare)
 *     state/sessions.json                  세션 기록 (훅이 찍는 턴 경계)
 *     state/terminals.json                 창 목록
 *     state/worktrees.json                 Orca worktree 목록
 *     state/sleeping.json                  절전(잠든 창) 기록
 *     state/cards/*.json                   진행 카드 (복귀 카드)
 *     state/resume/<프로젝트>.json          재개 항목
 *
 * **실제 `~/.sp-sync/` 는 건드리지 않는다.** 바깥과 닿는 자리는 전부 sp-sync 가 이미 열어 둔
 * 주입 구멍(`WORKSPACE_IO`, `resumePlan` 의 `ctx`)으로 갈아 끼운다. 다만 두 자리는 못 막는다:
 *   - `landCheck` 의 진행 카드 읽기(`cardForWorkspace` → `~/.sp-sync/cards/`) — **읽기만** 한다.
 *     경로가 안 맞아 픽스처에는 어떤 카드도 안 붙는다. 카드 갈래를 보려면 `resumePlan` 의
 *     `ctx.cards` 를 쓴다 (이건 주입된다).
 *   - `config()` 의 설정 읽기 — 읽기만 한다. 판정에 쓰는 설정값은 이 파일이 직접 넘긴다.
 *
 * **왜 헤드리스(codex)·절전 창을 섞었나.** TUI 워크스페이스의 유휴 판정(`landCheck` → `isIdle`)은
 * Orca CLI 를 부른다 — 가짜 핸들로는 시간만 쓰고 "작업 중" 으로 떨어진다. 헤드리스 워커는 세션
 * 기록만으로, 잠든 창은 절전 기록만으로 유휴가 갈리므로 그 둘은 디스크만으로 끝까지 판정된다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, normPath, parsePlanSlices } from '../sp-sync/lib/common.mjs';
import { projectWorkspaces, resolveAgents } from '../sp-sync/lib/fleet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// ROOT is the CLI default; request paths resolve at call time.
const ROOT = fixtureRoot();
const projectsDir = () => join(fixtureRoot(), 'orca', 'projects');
const workspacesDir = () => join(fixtureRoot(), 'orca', 'workspaces');
const originDir = () => join(fixtureRoot(), 'origin');
const stateDir = () => join(fixtureRoot(), 'state');

const projectRoot = (p) => join(projectsDir(), p);
const workspacePath = (p, n) => join(workspacesDir(), p, 'slice' + n);

// ---------- 픽스처 정의 ----------
// 시각은 전부 **상대값**으로 적는다 (`{ $minutesAgo }` · `{ $minutesAhead }`). 한 번 만든 픽스처를
// 몇 시간 뒤에 써도 판정이 같아야 하기 때문이다 — 턴이 묵었는지(`TURN_STALE_MS` 1시간)·한도가
// 풀렸는지는 절대 시각이 아니라 지금과의 거리로 갈린다.
const ago = (m) => ({ $minutesAgo: m });
const ahead = (m) => ({ $minutesAhead: m });

const PRD = '# PRD (픽스처)\n\n판정 함수를 부르기 위한 가짜 프로젝트다. 내용에 뜻은 없다.\n';

const FIXTURE = {
  // 헤드리스(codex) 플릿. 착륙 자격 있음 하나 · 미체크 막힘 하나.
  atlas: {
    max: 3,
    plan: [
      '# 작업계획',
      '',
      '## 1단계',
      '',
      '- [x] **1. 스키마 초안**',
      '- [ ] **2. 인증 기반** [에이전트: codex]',
      '- [ ] **3. 세션 저장소** [에이전트: codex] [병렬 가능]',
      '- [ ] **4. 프로필 화면** [선행: 2]',
      '- [ ] **5. 감사 로그** [결정 필요: 보관 기간]',
      '',
    ].join('\n'),
    workspaces: [
      { slice: 2, check: true, commit: '슬라이스 2 — 인증 기반' },
      { slice: 3 },
    ],
  },
  // TUI 플릿. 잠든 창 하나(미체크 막힘) · 턴 진행 중 하나. 동시 상한 2개를 채우는 자리.
  beacon: {
    max: 2,
    plan: [
      '# 작업계획',
      '',
      '## 1단계',
      '',
      '- [x] **1. 뼈대**',
      '- [ ] **2. 수집기** [병렬 가능]',
      '- [ ] **3. 정규화** [병렬 가능]',
      '- [ ] **4. 리포트** [병렬 가능]',
      '- [ ] **5. 알림** [병렬 가능]',
      '',
    ].join('\n'),
    workspaces: [{ slice: 2 }, { slice: 3 }],
  },
  // 계획 오류(없는 선행)와 순서 막힘. 현재 단계에는 워크스페이스가 없고, 다음 단계 번호의
  // 워크스페이스 하나가 한도에 막힌 채 남아 있다.
  cobalt: {
    max: 3,
    plan: [
      '# 작업계획',
      '',
      '## 1단계',
      '',
      '- [x] **1. 기반**',
      '- [ ] **2. 변환기** [에이전트: codex]',
      '- [ ] **3. 검증** [선행: 99]',
      '- [ ] **4. 문서**',
      '',
      '## 2단계',
      '',
      '- [ ] **5. 배포**',
      '',
    ].join('\n'),
    workspaces: [{ slice: 5 }],
  },
};

/** 세션 기록 — 훅(TUI)·래퍼(헤드리스)가 찍는 턴 경계. `turnStateFor` 의 유일한 재료다. */
const SESSIONS = {
  'atlas-slice2': { project: 'atlas', slice: 2, agent: 'codex', turnStartedAt: ago(50), turnEndedAt: ago(44), exitCode: 0 },
  'atlas-slice3': { project: 'atlas', slice: 3, agent: 'codex', turnStartedAt: ago(38), turnEndedAt: ago(31), exitCode: 0 },
  // 잠들기 전의 마지막 턴. 끝나 있다 — 잠들었다는 사실 자체가 "손을 뗐다" 다.
  'beacon-slice2': { project: 'beacon', slice: 2, turnStartedAt: ago(210), turnEndedAt: ago(196) },
  // 열린 턴 — 아직 도는 창.
  'beacon-slice3': { project: 'beacon', slice: 3, turnStartedAt: ago(4) },
  // 래퍼가 0 아닌 코드로 끝났고 그때 읽은 한도가 지금도 차 있다 → `limitBlock`.
  'cobalt-slice5': {
    project: 'cobalt',
    slice: 5,
    agent: 'codex',
    turnStartedAt: ago(34),
    turnEndedAt: ago(27),
    exitCode: 1,
    limit: { reachedType: 'usage_limit', resetsAt: ahead(95) },
  },
};

/** 창 목록. 살아 있는 창이 있는 워크스페이스만 `activeCount` 에 센다. */
const TERMINALS = [{ handle: 'term_beacon_slice3', project: 'beacon', slice: 3, connected: true, lastOutputAt: ago(1) }];

/** 절전으로 잠든 창. 잠든 창은 `terminals` 에 없다 — 이 표가 "창이 없는 것" 과 "잠든 것" 을 가른다. */
const SLEEPING = { beacon: { 2: [{ agent: 'claude', state: 'done', capturedAt: ago(190) }] } };

/** 진행 카드. `resumePlan` 의 `ctx.cards` 로 주입한다 (`landCheck` 는 실제 홈에서만 읽는다). */
const CARDS = [
  { project: 'atlas', slice: 3, at: ago(31), now: '세션 저장소 스키마 초안', wait: '', next: '마이그레이션 작성', task: 'fixture-atlas-3' },
  { project: 'beacon', slice: 3, at: ago(6), now: '수집기 골격', wait: '수집 주기를 5분과 1시간 중 무엇으로 둘지', next: '정한 주기로 스케줄러 작성', task: 'fixture-beacon-3' },
];

/**
 * 재개 항목 — 한도에 막혀 인계도 못 된 워크스페이스를 적어 두는 자리.
 * 다섯 갈래(drop · exhausted · wait · blocked · resume)가 각각 한 번씩 나오게 골랐다.
 */
const RESUME = {
  atlas: {
    // 워크스페이스 PLAN.md 에서 체크됨 → drop
    slice2: { slice: 2, agent: 'codex', attempts: 0, resetsAt: ago(120), at: ago(130), reason: 'codex 사용량 한도' },
    // 초기화가 지났고 래퍼 턴도 끝났다 → resume
    slice3: { slice: 3, agent: 'codex', attempts: 0, resetsAt: ago(15), at: ago(40), reason: 'codex 사용량 한도' },
    // 워크스페이스가 이미 사라졌다 → drop
    slice9: { slice: 9, agent: 'codex', attempts: 1, resetsAt: ago(300), at: ago(320), reason: 'codex 사용량 한도' },
  },
  beacon: {
    // 잠들어 창이 없다 → blocked (CLI 로 못 깨움)
    slice2: { slice: 2, agent: 'claude', attempts: 0, resetsAt: ago(60), at: ago(200), reason: 'claude 5시간 한도' },
    // 카드에 답을 기다리는 질문이 있다 → wait
    slice3: { slice: 3, agent: 'claude', attempts: 1, resetsAt: ago(20), at: ago(90), terminal: 'term_beacon_slice3', reason: 'claude 5시간 한도' },
  },
  cobalt: {
    // 재개 상한(2)을 소진했다 → exhausted, 사람이 볼 것
    slice5: { slice: 5, agent: 'codex', attempts: 2, resetsAt: ago(240), at: ago(260), reason: 'codex 사용량 한도' },
  },
};

const PROJECT_NAMES = Object.keys(FIXTURE);

// ---------- 만들기 ----------
const GIT_ID = ['-c', 'user.name=Fixture Bot', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

function git(args, cwd) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

const write = (f, s) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, s);
};
const writeJson = (f, v) => write(f, JSON.stringify(v, null, 2) + '\n');

/** `- [ ] **N.` → `- [x] **N.` — 워커가 완료 기준을 확인하고 체크한 것과 같은 모양. */
function checkSlice(text, n) {
  const re = new RegExp('^- \\[ \\] (\\*\\*' + n + '\\.)', 'm');
  if (!re.test(text)) throw new Error('체크할 슬라이스를 못 찾음: ' + n);
  return text.replace(re, '- [x] $1');
}

function buildProject(name, def) {
  const origin = join(originDir(), name + '.git');
  const root = projectRoot(name);
  git(['init', '--bare', '-b', 'main', origin], fixtureRoot());
  git(['init', '-b', 'main', root], fixtureRoot());
  write(join(root, 'PLAN.md'), def.plan);
  write(join(root, 'PRD.md'), PRD);
  git(['add', '-A'], root);
  git(['commit', '-m', '계획과 PRD'], root);
  git(['remote', 'add', 'origin', origin], root);
  git(['push', '-u', 'origin', 'main'], root);
  for (const w of def.workspaces) {
    const path = workspacePath(name, w.slice);
    mkdirSync(dirname(path), { recursive: true });
    git(['worktree', 'add', '-b', 'slice' + w.slice, path, 'main'], root);
    if (!w.check) continue;
    // 워커가 한 일: 슬라이스를 체크하고 커밋했다. 트리는 깨끗하고 origin/main 보다 한 커밋 앞선다.
    write(join(path, 'PLAN.md'), checkSlice(def.plan, w.slice));
    write(join(path, 'notes.md'), '슬라이스 ' + w.slice + ' 작업 메모 (픽스처)\n');
    git(['add', '-A'], path);
    git(['commit', '-m', w.commit], path);
  }
}

/** 픽스처를 처음부터 다시 만든다. 있으면 지운다 — 상태가 반쯤 남은 픽스처는 판정을 못 믿게 한다. */
function buildFixture() {
  if (existsSync(fixtureRoot())) rmSync(fixtureRoot(), { recursive: true, force: true });
  mkdirSync(fixtureRoot(), { recursive: true });
  for (const [name, def] of Object.entries(FIXTURE)) buildProject(name, def);

  const wsPath = (project, slice) => workspacePath(project, slice);
  writeJson(
    join(stateDir(), 'sessions.json'),
    Object.fromEntries(
      Object.entries(SESSIONS).map(([id, e]) => {
        const { project, slice, ...rest } = e;
        return [id, { worktree: wsPath(project, slice), cwd: projectRoot(project), ...rest }];
      })
    )
  );
  writeJson(
    join(stateDir(), 'terminals.json'),
    TERMINALS.map(({ project, slice, ...t }) => ({ ...t, worktreePath: wsPath(project, slice) }))
  );
  writeJson(join(stateDir(), 'worktrees.json'), [
    ...PROJECT_NAMES.map((p) => ({ path: projectRoot(p), branch: 'main', isMainWorktree: true })),
    ...PROJECT_NAMES.flatMap((p) =>
      FIXTURE[p].workspaces.map((w) => ({ path: workspacePath(p, w.slice), branch: 'slice' + w.slice, isMainWorktree: false, lastActivityAt: ago(30) }))
    ),
  ]);
  writeJson(
    join(stateDir(), 'sleeping.json'),
    Object.fromEntries(Object.entries(SLEEPING).flatMap(([p, m]) => Object.entries(m).map(([n, v]) => [normPath(workspacePath(p, Number(n))), v])))
  );
  for (const c of CARDS) {
    const { project, slice, ...rest } = c;
    writeJson(join(stateDir(), 'cards', project + '-slice' + slice + '.json'), { cwd: wsPath(project, slice), ...rest });
  }
  for (const [p, entries] of Object.entries(RESUME)) {
    writeJson(
      join(stateDir(), 'resume', p + '.json'),
      Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { workspace: workspacePath(p, v.slice), ...v }]))
    );
  }
  writeJson(join(fixtureRoot(), 'fixture.json'), {
    builtAt: new Date().toISOString(),
    note: '생성물이다. 고치지 말고 scripts/fixture.mjs 를 고쳐 다시 만든다.',
    projects: Object.fromEntries(PROJECT_NAMES.map((p) => [p, { root: projectRoot(p), max: FIXTURE[p].max, workspaces: FIXTURE[p].workspaces.map((w) => w.slice) }])),
  });
  return fixtureRoot();
}

// ---------- 읽기 ----------
/** 상대 시각(`{$minutesAgo}`·`{$minutesAhead}`)을 `now` 기준 밀리초로 푼다. */
function resolveTimes(v, now) {
  if (Array.isArray(v)) return v.map((x) => resolveTimes(x, now));
  if (!v || typeof v !== 'object') return v;
  if (typeof v.$minutesAgo === 'number') return now - v.$minutesAgo * 60000;
  if (typeof v.$minutesAhead === 'number') return now + v.$minutesAhead * 60000;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveTimes(x, now)]));
}

const readState = (f, now) => resolveTimes(JSON.parse(readFileSync(join(stateDir(), f), 'utf8')), now);

/**
 * 픽스처를 판정 함수가 받는 모양으로 읽는다. `now` 를 넘기면 그 시각 기준으로 상대 시각이 풀린다.
 * 실제 `~/.sp-sync/` 는 한 번도 안 읽는다 — 여기서 나온 것만 `io`·`ctx` 로 주입한다.
 */
function loadFixture(now = Date.now()) {
  if (!existsSync(join(fixtureRoot(), 'fixture.json'))) throw new Error('픽스처가 없습니다. 먼저 `node scripts/fixture.mjs` 를 실행하세요.');
  const sessions = readState('sessions.json', now);
  const terminals = readState('terminals.json', now);
  const worktrees = readState('worktrees.json', now);
  const sleeping = new Map(Object.entries(readState('sleeping.json', now)));
  const cards = {};
  for (const f of readdirSync(join(stateDir(), 'cards'))) {
    const c = resolveTimes(JSON.parse(readFileSync(join(stateDir(), 'cards', f), 'utf8')), now);
    cards[normPath(c.cwd)] = c;
  }
  const resume = {};
  for (const f of readdirSync(join(stateDir(), 'resume'))) {
    const entries = resolveTimes(JSON.parse(readFileSync(join(stateDir(), 'resume', f), 'utf8')), now);
    resume[f.replace(/\.json$/, '')] = Object.entries(entries).map(([name, v]) => ({ name, terminal: null, ...v }));
  }
  const branches = new Map(worktrees.map((w) => [normPath(w.path), w.branch]));
  // 경로 → 프로젝트. 실제 `fleetProjectOf` 는 git 으로 본체를 찾지만, 픽스처는 배치를 알고 있다.
  const projectOf = (path) => {
    const k = normPath(path) + '/';
    for (const p of PROJECT_NAMES) {
      if (k.startsWith(normPath(projectRoot(p)) + '/') || k.startsWith(normPath(join(workspacesDir(), p)) + '/')) return { name: p, root: projectRoot(p) };
    }
    return { name: '(픽스처 밖)', root: normPath(path) };
  };
  const io = {
    terminals: () => terminals,
    worktrees: () => worktrees,
    sessions: () => sessions,
    sleeping: () => sleeping,
    projectOf,
    branchOf: (path) => branches.get(normPath(path)) || null,
  };
  return { root: fixtureRoot(), now, projects: PROJECT_NAMES, io, cards, resume, max: (p) => FIXTURE[p].max };
}

/**
 * `fleetSlices` 와 **같은 재료**를 픽스처에서 만든다 — 계획서를 읽고, 워크스페이스를 붙이고,
 * 에이전트를 푼다. `fleetSlices` 를 그대로 못 쓰는 이유는 그것이 `~/orca/projects` 와 실제 Orca
 * 창 목록을 보기 때문이다 (`resolveProjectRoot`·`WORKSPACE_IO`).
 */
function fixtureSlices(project, fx) {
  const root = projectRoot(project);
  const parsed = parsePlanSlices(readFileSync(join(root, 'PLAN.md'), 'utf8'));
  const ws = projectWorkspaces(root, fx.io);
  const slices = resolveAgents(parsed.slices, { agents: DEFAULT_CONFIG.fleetAgents }).map((s) => ({
    ...s,
    workspace: (s.number != null && ws.find((w) => w.slice === s.number)) || null,
  }));
  for (const s of slices) if (s.workspace) s.workspace.agent = s.agent;
  return { project, root, phase: parsed.phase, slices, allSlices: parsed.allSlices, workspaces: ws, errors: parsed.errors };
}

export { FIXTURE, PROJECT_NAMES, ROOT, buildFixture, fixtureSlices, loadFixture, projectRoot, workspacePath };

// 직접 실행일 때만 만든다. URL 비교는 안 된다 — 한글 경로가 퍼센트 인코딩돼 안 맞는다.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  const at = buildFixture();
  console.log('픽스처를 만들었다: ' + at);
  for (const p of PROJECT_NAMES) console.log('  ' + p + ' — 워크스페이스 ' + FIXTURE[p].workspaces.map((w) => 'slice' + w.slice).join(', '));
}
