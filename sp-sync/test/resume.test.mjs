// node --test sp-sync/test/*.test.mjs
// 슬라이스 43 — 한도 해제 뒤 같은 워크스페이스 자동 재개(`lib/resume.mjs`). 판정(`resumePlan`)은 순수 함수라
// 시각·한도·유휴·카드·시도 상한을 하나씩 바꿔 가며 잰다. 파일은 임시 폴더로 갈아 끼운다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RESUME_DEPS, bumpResume, dropResume, resumeEntries, noteStuck, resumeLine, resumeOne, resumePlan, resumeRowText, stuckWorkspaces } from '../sp-sync.mjs';

const H = 3600000;
const NOW = Date.parse('2026-09-09T12:00:00Z');

const lim = (agent, pct, { resetsAt = NOW + 3 * H } = {}) => ({
  agent,
  pct5h: pct,
  pct7d: 20,
  resetsAt,
  reached: pct >= 100,
  reachedType: null,
  windows: { fiveHour: { pct, resetsAt }, sevenDay: { pct: 20, resetsAt: NOW + 24 * H } },
  models: {},
});
const entry = (over = {}) => ({
  name: 'slice12',
  workspace: 'C:/w/slice12',
  slice: 12,
  agent: 'claude',
  terminal: 't1',
  resetsAt: NOW - 10 * 60000,
  attempts: 0,
  at: NOW - H,
  reason: '대기 — 한도 초기화 임박',
  ...over,
});
const ws = (over = {}) => ({ name: 'slice12', path: 'C:/w/slice12', slice: 12, terminals: ['t1'], turn: { known: true, active: false, agent: 'claude' }, ...over });
const ctx = (over = {}) => ({
  now: NOW,
  limits: { claude: lim('claude', 40), codex: lim('codex', 10) },
  workspaces: [ws()],
  slices: [{ number: 12, done: false, tags: [] }],
  cards: {},
  idle: () => true,
  sliceDone: () => false,
  max: 2,
  ...over,
});
const only = (rows) => (assert.equal(rows.length, 1), rows[0]);

test('초기화가 지났고 한도가 풀렸고 유휴면 깨운다 — TUI 는 적어 둔 창에 "이어서 진행해"', () => {
  const r = only(resumePlan([entry()], ctx()));
  assert.equal(r.action, 'resume');
  assert.equal(r.handle, 't1');
  assert.match(r.reason, /이어서 진행해.*\(1\/2\)/);
  assert.match(resumeRowText(r), /^재개 — /);
});

test('시각 — 초기화 전이면 기다린다. resetsAt 이 없으면 지금 한도만 본다', () => {
  const soon = only(resumePlan([entry({ resetsAt: NOW + 20 * 60000 })], ctx()));
  assert.equal(soon.action, 'wait');
  assert.match(soon.reason, /초기화 전/);
  assert.equal(only(resumePlan([entry({ resetsAt: null })], ctx())).action, 'resume');
});

test('한도 — 초기화가 지났어도 지금 읽은 한도가 여전히 차 있으면 기다린다. 모르면 여유로 본다', () => {
  const still = only(resumePlan([entry()], ctx({ limits: { claude: lim('claude', 100) } })));
  assert.equal(still.action, 'wait');
  assert.match(still.reason, /claude 한도 여전히 참/);
  assert.equal(only(resumePlan([entry()], ctx({ limits: {} }))).action, 'resume');
});

test('유휴 — 턴이 열려 있거나 tui-idle 이 안 되면 기다린다', () => {
  const active = only(resumePlan([entry()], ctx({ workspaces: [ws({ turn: { known: true, active: true, agent: 'claude' } })] })));
  assert.equal(active.action, 'wait');
  assert.match(active.reason, /턴 진행 중/);
  const busy = only(resumePlan([entry()], ctx({ idle: () => false })));
  assert.equal(busy.action, 'wait');
  assert.match(busy.reason, /TUI 유휴 아님/);
});

test('카드 wait 가 차 있으면 사람이 답할 차례라 깨우지 않는다', () => {
  const r = only(resumePlan([entry()], ctx({ cards: { 'c:/w/slice12': { wait: '이걸 할지 말지' } } })));
  assert.equal(r.action, 'wait');
  assert.match(r.reason, /워커가 결정을 기다림: 이걸 할지 말지/);
  // 빈 wait 는 기다림이 아니다
  assert.equal(only(resumePlan([entry()], ctx({ cards: { 'c:/w/slice12': { wait: '' } } }))).action, 'resume');
});

test('시도 상한 — attempts 가 max 에 닿으면 소진(사람 몫)이고, 그 아래면 시도 수를 사유에 적는다', () => {
  const r = only(resumePlan([entry({ attempts: 2 })], ctx()));
  assert.equal(r.action, 'exhausted');
  assert.match(resumeRowText(r), /^재개 포기 — 재개 2회 실패 — 사람이 볼 것/);
  assert.match(only(resumePlan([entry({ attempts: 1 })], ctx())).reason, /\(2\/2\)/);
  // 상한 1 이면 한 번 뒤 소진
  assert.equal(only(resumePlan([entry({ attempts: 1 })], ctx({ max: 1 }))).action, 'exhausted');
});

test('항목 삭제 — 체크됨(본체든 워크스페이스든)·워크스페이스 없음', () => {
  assert.match(only(resumePlan([entry()], ctx({ slices: [{ number: 12, done: true }] }))).reason, /본체 PLAN\.md 에서 체크됨/);
  assert.match(only(resumePlan([entry()], ctx({ sliceDone: () => true }))).reason, /워크스페이스 PLAN\.md 에서 체크됨/);
  const gone = only(resumePlan([entry()], ctx({ workspaces: [] })));
  assert.equal(gone.action, 'drop');
  assert.match(gone.reason, /워크스페이스가 없음/);
});

test('창 — 적어 둔 창이 죽었으면 그 워크스페이스의 살아 있는 창, 그것도 없으면 재개 불가', () => {
  const other = only(resumePlan([entry({ terminal: 'dead' })], ctx({ workspaces: [ws({ terminals: ['t2'] })], live: new Set(['t2']) })));
  assert.equal(other.action, 'resume');
  assert.equal(other.handle, 't2');
  const none = only(resumePlan([entry()], ctx({ workspaces: [ws({ terminals: [] })] })));
  assert.equal(none.action, 'blocked');
  assert.match(resumeRowText(none), /^재개 불가 — 창이 없음/);
});

test('헤드리스 — 창이 아니라 턴 기록으로 가르고, 래퍼 새 턴으로 깨운다', () => {
  const w = ws({ terminals: [], turn: { known: true, active: false, agent: 'codex', exitCode: 1 } });
  const r = only(resumePlan([entry({ agent: 'codex', terminal: null })], ctx({ workspaces: [w] })));
  assert.equal(r.action, 'resume');
  assert.match(r.reason, /codex 래퍼 새 턴/);
  const active = only(resumePlan([entry({ agent: 'codex' })], ctx({ workspaces: [ws({ turn: { known: true, active: true, agent: 'codex' } })] })));
  assert.equal(active.action, 'wait');
  const stale = only(resumePlan([entry({ agent: 'codex' })], ctx({ workspaces: [ws({ turn: { known: false, stale: true, agent: 'codex' } })] })));
  assert.equal(stale.action, 'blocked');
});

test('resumeOne — TUI 는 wakeOne 의 제출 확인이 곧 성공, 헤드리스는 래퍼 창 생성', async () => {
  const calls = [];
  const tui = await resumeOne(
    { name: 'slice12', path: 'C:/w/slice12', agent: 'claude', handle: 't1' },
    { wake: async (h, t) => (calls.push(['wake', h, t]), { result: 'submitted', detail: '' }) }
  );
  assert.equal(tui.ok, true);
  assert.deepEqual(calls, [['wake', 't1', '이어서 진행해']]);
  const miss = await resumeOne({ agent: 'claude', handle: 't1' }, { wake: async () => ({ result: 'unknown', detail: '흔적 없음' }) });
  assert.equal(miss.ok, false);
  assert.match(miss.submit, /미제출: unknown/);
  const hl = await resumeOne(
    { name: 'slice12', path: 'C:/w/slice12', agent: 'codex' },
    { command: (row) => '& node worker --agent ' + row.agent + ' --slice 12 --hard', createTerminal: (p, title, cmd) => (calls.push(['create', p, title, cmd]), 'h9') }
  );
  assert.equal(hl.ok, true);
  assert.equal(hl.handle, 'h9');
  assert.deepEqual(calls[1], ['create', 'C:/w/slice12', 'slice12 재개 codex', '& node worker --agent codex --slice 12 --hard']);
  // 창을 못 열면 실패 — 던지지 않는다
  const bad = await resumeOne({ agent: 'codex', path: 'x' }, { command: 'c', createTerminal: () => { throw new Error('orca 안 뜸'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /orca 안 뜸/);
});

test('파일 — 적기(갱신은 resetsAt·reason 만)·시도 세기·지우기, 실제 ~/.sp-sync 는 안 건드린다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-resume-'));
  const deps = { file: (p) => join(dir, 'fleet-resume.' + p + '.json'), lock: () => join(dir, 'fleet-resume.lock') };
  try {
    const a = noteStuck('SP-sync', { name: 'slice12', workspace: 'C:/w/slice12', slice: 12, agent: 'claude', terminal: 't1', resetsAt: NOW + H, reason: '대기' }, deps);
    assert.equal(a.attempts, 0);
    assert.equal(a.resetsAt, NOW + H);
    assert.equal(bumpResume('SP-sync', 'slice12', { now: NOW }, deps).attempts, 1);
    // 막힘이 이어져 다시 적어도 attempts 는 되돌아가지 않는다 — resetsAt·reason 만 새 값
    const b = noteStuck('SP-sync', { name: 'slice12', workspace: 'C:/w/slice12', slice: 12, agent: 'claude', resetsAt: NOW + 2 * H, reason: '또 대기' }, deps);
    assert.equal(b.attempts, 1);
    assert.equal(b.resetsAt, NOW + 2 * H);
    assert.equal(b.reason, '또 대기');
    assert.equal(b.terminal, 't1');
    const list = resumeEntries('SP-sync', deps);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'slice12');
    // 파일에는 name 이 키다
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(deps.file('SP-sync'), 'utf8'))), ['slice12']);
    assert.equal(resumeLine(list[0], 2), '재개 예약 slice12 ' + new Date(NOW + 2 * H).toTimeString().slice(0, 5) + ' (1/2)');
    assert.equal(dropResume('SP-sync', 'slice12', deps), true);
    assert.equal(dropResume('SP-sync', 'slice12', deps), false);
    assert.deepEqual(resumeEntries('SP-sync', deps), []);
    // 없는 항목의 시도 세기는 아무것도 안 한다
    assert.equal(bumpResume('SP-sync', 'slice12', {}, deps), null);
    // 다른 프로젝트 파일은 따로다
    assert.deepEqual(resumeEntries('CW', deps), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stuckWorkspaces — 인계 상대가 있든 없든 한도에 막힌 것 전부. 창·에이전트를 같이 낸다', () => {
  const checks = [
    { name: 'slice12', path: 'C:/w/slice12', slice: 12, blocked: true, reason: '유휴인데 미체크' },
    { name: 'slice13', path: 'C:/w/slice13', slice: 13, blocked: false, ready: true },
  ];
  const wss = [ws(), ws({ name: 'slice13', path: 'C:/w/slice13', slice: 13 })];
  const out = stuckWorkspaces({ checks, workspaces: wss, limits: { claude: lim('claude', 100) }, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'slice12');
  assert.equal(out[0].agent, 'claude');
  assert.deepEqual(out[0].terminals, ['t1']);
  assert.equal(out[0].limit.resetsAt, NOW + 3 * H);
  // 한도가 안 찼으면 비어 있다
  assert.deepEqual(stuckWorkspaces({ checks, workspaces: wss, limits: { claude: lim('claude', 40) }, now: NOW }), []);
});

test('RESUME_DEPS 의 기본 경로는 ~/.sp-sync/fleet-resume.<safeName>.json', () => {
  assert.match(RESUME_DEPS.file('Project X').replace(/\\/g, '/'), /\/\.sp-sync\/fleet-resume\.Project_X\.json$/);
});
