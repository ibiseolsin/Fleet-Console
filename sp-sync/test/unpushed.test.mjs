// node --test sp-sync/test/*.test.mjs
// 슬라이스 12 — 본체와 origin 의 어긋남을 재고, 막힘이면 파견을 통째로 세운다.
// 슬라이스 19 부터 "앞섬"은 회차가 push 로 풀므로(`sync-main.test.mjs`), 여기 남는 막힘은
// 사람만 풀 수 있는 둘 — 갈라짐과 push 실패 — 뿐이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unpushedAhead, baseBranchOf, dispatchPlan, renderDispatch, renderCycleReport } from '../sp-sync.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const s = (number, tags = [], extra = {}) => ({ number, title: 't' + number, tags, decision: null, done: false, workspace: null, ...extra });
const BLOCK = '본체 push 실패 — 원격이 거절함';

/** 원격(bare) 하나와 그것을 클론한 본체 하나. 실제 git 으로 재현한다 — 앞섬 판정이 git 의 몫이라서. */
function repoPair() {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-unpushed-'));
  const remote = join(dir, 'remote.git');
  const root = join(dir, 'main');
  mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '--initial-branch=master'], remote);
  git(['clone', remote, root], dir);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'PLAN.md'), '- [ ] **1. 첫 슬라이스**\n', 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-m', 'init'], root);
  git(['push', '-u', 'origin', 'master'], root);
  git(['remote', 'set-head', 'origin', '-a'], root); // 빈 저장소를 클론해서 origin/HEAD 가 없다 — 실제 본체에는 있다
  return { dir, root };
}

test('본체가 push 돼 있으면 앞섬 0 — 파견을 막지 않는다', () => {
  const { dir, root } = repoPair();
  try {
    assert.equal(baseBranchOf(root), 'master');
    const r = unpushedAhead(root);
    assert.equal(r.hasRemote, true);
    assert.equal(r.ahead, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('본체를 1 커밋 앞서게 하면 앞섬 1 — 커밋 제목도 같이 온다', () => {
  const { dir, root } = repoPair();
  try {
    writeFileSync(join(root, 'PLAN.md'), '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 새로 적은 슬라이스**\n', 'utf8');
    git(['add', '-A'], root);
    git(['commit', '-m', 'PLAN — 슬라이스 2 추가'], root);
    const r = unpushedAhead(root);
    assert.equal(r.ahead, 1);
    assert.match(r.commits[0], /슬라이스 2 추가/);
    // push 하면 다시 0. 그 push 를 슬라이스 19 부터는 회차가 한다 (`syncMain`)
    git(['push'], root);
    assert.equal(unpushedAhead(root).ahead, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('원격이 없으면 막지 않는다 — 갈라질 원격이 없다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-noremote-'));
  try {
    git(['init', '--initial-branch=master'], dir);
    const r = unpushedAhead(dir);
    assert.equal(r.hasRemote, false);
    assert.equal(r.ahead, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('block 이 오면 미체크 슬라이스가 전부 보류되고 이유가 그것이다', () => {
  const p = dispatchPlan({ slices: [s(1, ['parallel']), s(2, ['parallel'])], workspaces: [], max: 3, block: BLOCK });
  assert.deepEqual(p.map((x) => x.eligible), [false, false]);
  for (const x of p) assert.equal(x.reason, BLOCK);
});

test('block 이어도 이미 도는 창은 "이미 돌고 있음" 으로 남는다', () => {
  const running = { name: 'slice1', path: 'C:/w/slice1', branch: 'slice1', slice: 1, lastActivityAt: null, terminals: [] };
  const p = dispatchPlan({ slices: [s(1, ['parallel'], { workspace: running })], workspaces: [running], max: 3, block: '본체 미push' });
  assert.match(p[0].reason, /이미 돌고 있음/);
});

test('표 위에 막힘 한 줄이 먼저 나온다', () => {
  const out = renderDispatch({
    project: 'P',
    phase: null,
    max: 3,
    active: 0,
    dryRun: true,
    block: BLOCK,
    decisions: [{ number: 1, title: 't1', tags: [], eligible: false, reason: BLOCK }],
    dispatched: [],
  });
  assert.match(out, /⚠ 본체 push 실패 — 원격이 거절함 — 이번 회차 파견 없음/);
  assert.match(out, /파견 대상 0개/);
});

test('회차 보고의 결정 필요 표에 본체 동기화 실패가 올라간다', () => {
  const out = renderCycleReport({
    at: new Date(2026, 7, 30, 21, 0).getTime(),
    dryRun: true,
    projects: [
      {
        project: 'P',
        dispatch: {
          dispatched: [],
          decisions: [{ number: 1, title: 't1', eligible: false, reason: BLOCK }],
          block: BLOCK,
          sync: { action: 'push-failed', baseBranch: 'master', ahead: 1, block: BLOCK, commits: ['abc123 PLAN — 슬라이스 2 추가'] },
        },
      },
    ],
  });
  assert.match(out, /\| P \| 본체 동기화 \| 본체 push 실패 — 원격이 거절함 \(abc123 PLAN — 슬라이스 2 추가 …\) \|/);
  assert.match(out, /결정 필요 1/);
  // 막힌 회차는 파견 예정을 적지 않는다 — dry-run 이라도 띄울 것이 없다
  assert.match(out, /\*\*파견\*\* — 없음/);
});
