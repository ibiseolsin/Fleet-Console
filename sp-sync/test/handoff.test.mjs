// node --test sp-sync/test/handoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffOne, handoffPlan, handoffPrompt, renderHandoff, cycleHandoff } from '../sp-sync.mjs';

const agents = { codex: { cmd: 'codex', args: [] } };
const slice = (over = {}) => ({ number: 12, title: '인계', done: false, tags: ['hard', 'agent', 'deps'], ...over });
const workspace = (over = {}) => ({
  name: 'slice12',
  path: 'C:/w/slice12',
  slice: 12,
  terminals: ['old'],
  turn: { known: true, active: false, agent: 'codex', exitCode: 1 },
  ...over,
});

test('판정 표 — 대상 없음·창 없음·기록 없음·턴 진행 중·같은 에이전트·한도 막힘', () => {
  const base = { number: 12, slice: slice(), to: 'claude', agents, now: 1_000_000 };
  assert.match(handoffPlan(base).reason, /워크스페이스가 없음/);
  assert.match(handoffPlan({ ...base, workspace: workspace({ terminals: [] }) }).reason, /살아 있는 창이 없음/);
  assert.match(handoffPlan({ ...base, workspace: workspace({ turn: { known: false } }) }).reason, /턴 기록이 없음/);
  assert.match(handoffPlan({ ...base, workspace: workspace({ turn: { known: true, active: true, agent: 'codex' } }) }).reason, /턴 진행 중/);
  assert.match(handoffPlan({ ...base, to: 'codex', workspace: workspace() }).reason, /이미 codex/);

  const limit = {
    reached: true,
    resetsAt: 2_000_000,
    windows: { fiveHour: { pct: 100, resetsAt: 2_000_000 } },
    models: {},
  };
  const possible = handoffPlan({ ...base, workspace: workspace({ turn: { known: true, active: false, agent: 'codex', exitCode: 1, limit } }) });
  assert.equal(possible.eligible, true);
  assert.equal(possible.from, 'codex');
  assert.equal(possible.to, 'claude');
  assert.equal(possible.limit, limit);
  assert.match(possible.reason, /한도 막힘.*인계 가능/);
});

test('끝난 턴은 한도 막힘이 아니어도 인계할 수 있고, 열린 묵은 턴은 안 된다', () => {
  const ended = handoffPlan({ number: 12, slice: slice(), workspace: workspace(), to: 'claude', agents });
  assert.equal(ended.eligible, true);
  assert.match(ended.reason, /턴 종료/);
  const stale = handoffPlan({
    number: 12,
    slice: slice(),
    workspace: workspace({ turn: { known: false, stale: true, agent: 'codex' } }),
    to: 'claude',
    agents,
  });
  assert.equal(stale.eligible, false);
  assert.match(stale.reason, /아직 열려 있음/);
});

test('헤드리스 인계는 고정 프롬프트와 --hard 를 래퍼 새 턴에 싣는다', async () => {
  const calls = [];
  const s = slice();
  const decision = { number: 12, name: 'slice12', path: 'C:/w/slice12', from: 'claude', to: 'codex', hard: true, eligible: true };
  const out = await handoffOne(
    s,
    decision,
    { agents, model: 'opus[1m]', hardModel: 'fable', readyMs: 10, createMs: 20 },
    {
      createTerminal: (path, title, command) => (calls.push(['create', path, title, command]), 'new'),
      waitForPrompt: async () => (calls.push(['prompt']), { ok: true }),
      waitIdle: () => calls.push(['idle']),
      closeExtraTabs: (path, keep) => (calls.push(['close', path, keep]), { closed: ['old'], failed: [], detail: '여분 탭 1개 닫음' }),
      send: async () => (calls.push(['send']), { result: 'submitted', submit: '제출 확인', resent: 0 }),
    }
  );
  assert.equal(out.ok, true);
  assert.match(calls[0][3], /worker --agent codex --prompt "슬라이스 12 이어받기\. 워크트리의 미커밋 변경과 PLAN\.md 인계 메모를 먼저 읽고 이어서 진행\." --hard$/);
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'close']);
});

test('Claude 인계는 어려운 슬라이스를 Fable 로 띄우고 준비 뒤 고정 프롬프트를 제출한다', async () => {
  const calls = [];
  const s = slice();
  const decision = { number: 12, name: 'slice12', path: 'C:/w/slice12', from: 'codex', to: 'claude', hard: true, eligible: true };
  const out = await handoffOne(
    s,
    decision,
    { agents, model: 'opus[1m]', hardModel: 'fable', readyMs: 10, createMs: 20 },
    {
      createTerminal: (path, title, command) => (calls.push(['create', path, title, command]), 'new'),
      waitForPrompt: async (handle) => (calls.push(['prompt', handle]), { ok: true }),
      waitIdle: (handle) => calls.push(['idle', handle]),
      closeExtraTabs: (path, keep) => (calls.push(['close', path, keep]), { closed: ['old'], failed: [] }),
      send: async (handle, text) => (calls.push(['send', handle, text]), { result: 'submitted', submit: '제출 확인', resent: 0 }),
    }
  );
  assert.equal(out.ok, true);
  assert.equal(calls[0][3], 'claude --model fable');
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'prompt', 'close', 'idle', 'send']);
  assert.equal(calls.at(-1)[2], handoffPrompt(12));
});

test('검증용 --prompt 는 고정 지시를 대신하고 표는 dry-run 판정을 드러낸다', async () => {
  const calls = [];
  const decision = { number: 12, name: 'slice12', path: 'C:/w/slice12', from: 'claude', to: 'codex', hard: false, eligible: true, reason: 'claude 턴 종료 — codex 인계 가능' };
  await handoffOne(slice({ tags: [] }), decision, { prompt: '한 줄만 답해라', agents }, {
    createTerminal: (_path, _title, command) => (calls.push(command), 'new'),
    closeExtraTabs: () => ({ closed: [], failed: [] }),
  });
  assert.match(calls[0], /--prompt "한 줄만 답해라"$/);
  const text = renderHandoff({ project: 'P', phase: { title: '5단계' }, dryRun: true, decision, handoff: null });
  assert.match(text, /dry-run/);
  assert.match(text, /claude.*codex.*인계/);
  assert.match(text, /dry-run 이라 안 띄움/);
});

// --- 슬라이스 43: 회차의 인계 단계가 막힌 워크스페이스를 재개 항목으로 적는다 ---
// 인계가 **실행되지 않은** 모든 한도 막힘 — 대기·인계 불가뿐 아니라 상대가 없어 인계 표에 줄이 안 나는 것까지.
// 막혀 있는 동안 적어야 한다: 초기화가 지나면 `limitStuckOf` 가 null 이라 그 창은 "유휴인데 미체크" 로만 보인다.
const H = 3600000;
const NOW = Date.parse('2026-09-09T12:00:00Z');
const lim = (agent, pct, resetsAt = NOW + 3 * H) => ({
  agent, pct5h: pct, pct7d: 20, resetsAt, reached: pct >= 100, reachedType: null,
  windows: { fiveHour: { pct, resetsAt }, sevenDay: { pct: 20, resetsAt: NOW + 24 * H } }, models: {},
});
const snapOf = (w) => ({ project: 'SP-sync', slices: [slice({ tags: [], agent: 'claude' })], workspaces: [w] });
const landOf = (w) => ({ checks: [{ name: w.name, path: w.path, slice: w.slice, blocked: true, ready: false, reason: '유휴인데 12번이 미체크 — 막힘' }] });
const tui = () => workspace({ terminals: ['t1', 't2'], turn: { known: true, active: false, agent: 'claude' } });
const fakeDeps = (calls) => ({
  noteStuck: (project, e) => (calls.push(['note', project, e]), { ...e, attempts: 0 }),
  dropResume: (project, name) => (calls.push(['drop', project, name]), true),
  pickTerminal: (list) => list[list.length - 1],
  createTerminal: (path, title, command) => (calls.push(['create', title, command]), 'h1'),
  closeExtraTabs: () => null,
});

test('대기 갈래(초기화 임박)는 재개 항목을 쓴다 — 창은 Claude 프롬프트가 뜬 것, 시각은 막고 있는 한도의 것', async () => {
  const calls = [];
  const w = tui();
  const soon = NOW + 10 * 60000;
  const out = await cycleHandoff(
    snapOf(w), landOf(w),
    { now: NOW, limits: { claude: lim('claude', 100, soon), codex: lim('codex', 10) }, fallback: { claude: 'codex' }, waitMin: 30, agents, project: 'SP-sync' },
    fakeDeps(calls)
  );
  assert.equal(out.rows[0].action, 'wait');
  assert.equal(calls.length, 1);
  const [, project, e] = calls[0];
  assert.equal(project, 'SP-sync');
  assert.equal(e.name, 'slice12');
  assert.equal(e.workspace, 'C:/w/slice12');
  assert.equal(e.agent, 'claude');
  assert.equal(e.terminal, 't2');
  assert.equal(e.resetsAt, soon);
  assert.match(e.reason, /^대기 — 한도 초기화 임박/);
  assert.equal(out.noted.length, 1);
  assert.equal(out.noted[0].attempts, 0);
});

test('상대 에이전트가 없어 인계 표에 줄이 없어도(fleetFallback 비어 있음) 항목은 쓴다', async () => {
  const calls = [];
  const w = tui();
  const out = await cycleHandoff(snapOf(w), landOf(w), { now: NOW, limits: { claude: lim('claude', 100) }, fallback: {}, agents, project: 'SP-sync' }, fakeDeps(calls));
  assert.deepEqual(out.rows, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].reason, '상대 에이전트 없음 (fleetFallback)');
  assert.equal(calls[0][2].resetsAt, NOW + 3 * H);
});

test('인계가 실행되면 항목을 지운다 — 남으면 상대가 도는 창에 옛 에이전트의 재개가 들어간다', async () => {
  const calls = [];
  const w = tui();
  const out = await cycleHandoff(
    snapOf(w), landOf(w),
    { now: NOW, limits: { claude: lim('claude', 100), codex: lim('codex', 10) }, fallback: { claude: 'codex' }, waitMin: 30, agents, project: 'SP-sync' },
    fakeDeps(calls)
  );
  assert.equal(out.rows[0].action, 'handoff');
  assert.equal(out.rows[0].result.ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'drop']);
  assert.deepEqual(out.noted, []);
});

test('한도가 안 찼거나 dry-run 이면 항목을 안 쓴다', async () => {
  const calls = [];
  const w = tui();
  await cycleHandoff(snapOf(w), landOf(w), { now: NOW, limits: { claude: lim('claude', 40) }, fallback: { claude: 'codex' }, agents, project: 'SP-sync' }, fakeDeps(calls));
  await cycleHandoff(snapOf(w), landOf(w), { now: NOW, dryRun: true, limits: { claude: lim('claude', 100) }, fallback: {}, agents, project: 'SP-sync' }, fakeDeps(calls));
  assert.deepEqual(calls, []);
});
