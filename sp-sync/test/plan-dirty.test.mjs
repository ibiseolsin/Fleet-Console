// node --test sp-sync/test/*.test.mjs
// 본체 PLAN.md 가 커밋 전이면 새 파견을 접는다 (`planDirtyBlock`). 파견은 작업 트리 PLAN.md 를 읽으므로
// 미검토 계획이 그대로 나갔다 — 2026-09-03 slice6, 2026-09-08 slice13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchPlan, planDirtyBlock, renderDispatch } from '../sp-sync.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spsync-plandirty-')));
  git(['init', '-q', '--initial-branch=master'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  return dir;
}

test('PLAN.md 가 HEAD 와 같으면 null, 수정돼 있으면 사유, 미추적(첫 계획)이면 null', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, 'PLAN.md'), '- [ ] **1. 첫**\n', 'utf8');
    assert.equal(planDirtyBlock(dir), null, '미추적 PLAN.md 는 비교할 HEAD 가 없다');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'plan'], dir);
    assert.equal(planDirtyBlock(dir), null, '커밋과 같으면 막지 않는다');
    writeFileSync(join(dir, 'PLAN.md'), '- [ ] **1. 첫**\n- [ ] **2. 새 슬라이스**\n', 'utf8');
    assert.match(planDirtyBlock(dir), /PLAN\.md 미커밋 변경/);
    writeFileSync(join(dir, 'other.md'), 'x', 'utf8');
    git(['add', 'PLAN.md'], dir); // 스테이지만 해도 커밋 전이다
    assert.match(planDirtyBlock(dir), /PLAN\.md 미커밋 변경/);
    git(['commit', '-q', '-m', 'plan 2'], dir);
    assert.equal(planDirtyBlock(dir), null, '다른 파일이 더러운 것은 상관없다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planDirty 가 오면 새 파견은 전부 그 사유로 보류되고 재파견은 그대로 간다', () => {
  const s = (number, tags = [], extra = {}) => ({ number, title: 't' + number, tags, decision: null, done: false, workspace: null, ...extra });
  const stalled = { name: 'slice1', path: 'C:/w/slice1', branch: 'u/slice1', slice: 1, terminals: ['t1'], stalled: { stalled: true, why: '지시 미전송' } };
  const p = dispatchPlan({ slices: [s(1, [], { workspace: stalled }), s(2, ['parallel']), s(3)], workspaces: [stalled], max: 3, planDirty: 'PLAN.md 미커밋 변경 — 커밋이 파견 신호' });
  const by = Object.fromEntries(p.map((x) => [x.slice.number, x]));
  assert.equal(by[1].eligible, true, '재파견은 간다');
  assert.equal(by[1].redispatch, stalled);
  assert.equal(by[2].eligible, false);
  assert.match(by[2].reason, /PLAN\.md 미커밋 변경/);
  assert.equal(by[3].eligible, false);
  assert.match(by[3].reason, /PLAN\.md 미커밋 변경/);
});

test('보고에 한 줄로 뜬다', () => {
  const text = renderDispatch({ project: 'Demo', phase: null, max: 3, active: 0, sync: { text: '' }, block: null, createBlock: null, planBlock: 'PLAN.md 미커밋 변경 — 커밋이 파견 신호', decisions: [], dispatched: [], stale: { stale: [] } });
  assert.match(text, /⚠ PLAN\.md 미커밋 변경.*새 파견 없음/);
});
