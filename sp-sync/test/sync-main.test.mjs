// node --test sp-sync/test/*.test.mjs
// 슬라이스 19 — 본체 동기화는 회차가 한다. 앞서면 push, 뒤지면 ff, 갈라지면 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncMain, renderCycleReport } from '../sp-sync.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();

/**
 * 원격(bare) 하나 · 본체 하나 · 다른 사람 몫의 클론 하나.
 * 판정도 push 도 ff 도 git 이 하는 일이라 실제 저장소로 잰다.
 */
function repos() {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-syncmain-'));
  const remote = join(dir, 'remote.git');
  const root = join(dir, 'main');
  const other = join(dir, 'other');
  mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '--initial-branch=master'], remote);
  git(['clone', remote, root], dir);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'PLAN.md'), '- [ ] **1. 첫 슬라이스**\n', 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-m', 'init'], root);
  git(['push', '-u', 'origin', 'master'], root);
  git(['remote', 'set-head', 'origin', '-a'], root); // 빈 저장소를 클론해서 origin/HEAD 가 없다
  git(['clone', remote, other], dir);
  git(['config', 'user.email', 'o@o'], other);
  git(['config', 'user.name', 'o'], other);
  return { dir, root, other };
}

const commit = (root, text, msg) => {
  writeFileSync(join(root, 'PLAN.md'), text, 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-m', msg], root);
};
const originHead = (root) => git(['rev-parse', 'origin/master'], root);
const head = (root) => git(['rev-parse', 'HEAD'], root);

test('앞서면 push 한다 — 미커밋 변경은 그대로 남는다', () => {
  const { dir, root } = repos();
  try {
    commit(root, '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 새 슬라이스**\n', 'PLAN — 슬라이스 2 추가');
    // 트리가 더러워도 push 는 한다 — push 는 커밋된 것만 올린다
    writeFileSync(join(root, 'memo.txt'), '작업 중\n', 'utf8');
    const r = syncMain(root);
    assert.equal(r.action, 'push');
    assert.equal(r.block, null);
    assert.equal(r.ahead, 1);
    assert.equal(r.dirty, true);
    git(['fetch', 'origin', 'master'], root);
    assert.equal(originHead(root), head(root), 'push 뒤 origin 과 일치해야 한다');
    assert.equal(readFileSync(join(root, 'memo.txt'), 'utf8'), '작업 중\n', '미커밋 파일은 그대로');
    assert.match(r.text, /push 1 커밋/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('미커밋 변경만 있으면 아무것도 올라가지 않는다', () => {
  const { dir, root } = repos();
  try {
    const before = originHead(root);
    writeFileSync(join(root, 'PLAN.md'), '- [ ] **1. 고치는 중**\n', 'utf8');
    const r = syncMain(root);
    assert.equal(r.action, 'none');
    assert.equal(r.ahead, 0);
    assert.equal(r.block, null);
    git(['fetch', 'origin', 'master'], root);
    assert.equal(originHead(root), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run 은 push 도 ff 도 하지 않고 판정만 한다', () => {
  const a = repos();
  const b = repos();
  try {
    commit(a.root, '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 새 슬라이스**\n', 'PLAN — 슬라이스 2 추가');
    const before = originHead(a.root);
    const r = syncMain(a.root, { dryRun: true });
    assert.equal(r.action, 'push');
    assert.match(r.text, /예정/);
    git(['fetch', 'origin', 'master'], a.root);
    assert.equal(originHead(a.root), before, 'dry-run 은 push 하지 않는다');

    // 뒤진 쪽도 마찬가지 — 판정만 하고 ff 하지 않는다
    commit(b.other, '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 남이 올린 것**\n', '남의 커밋');
    git(['push'], b.other);
    const at = head(b.root);
    const s = syncMain(b.root, { dryRun: true });
    assert.equal(s.action, 'ff');
    assert.equal(head(b.root), at, 'dry-run 은 ff 하지 않는다');
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('뒤지면 ff — 트리가 더러우면 미룬다', () => {
  const { dir, root, other } = repos();
  try {
    commit(other, '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 남이 올린 것**\n', '남의 커밋');
    git(['push'], other);

    // (1) 트리가 더러우면 ff 를 미룬다 — ff 는 파일을 건드린다
    writeFileSync(join(root, 'memo.txt'), '작업 중\n', 'utf8');
    const dirty = syncMain(root);
    assert.equal(dirty.action, 'ff-deferred');
    assert.equal(dirty.behind, 1);
    assert.equal(dirty.block, null, 'ff 를 미루는 것은 막힘이 아니다');
    assert.notEqual(head(root), originHead(root));

    // (2) 깨끗해지면 ff 한다
    rmSync(join(root, 'memo.txt'));
    const clean = syncMain(root);
    assert.equal(clean.action, 'ff');
    assert.equal(head(root), originHead(root));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('갈라지면 막는다 — 아무것도 push 되지 않는다', () => {
  const { dir, root, other } = repos();
  try {
    commit(other, '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 남이 올린 것**\n', '남의 커밋');
    git(['push'], other);
    commit(root, '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 내가 적은 것**\n', '내 커밋');
    const before = head(other); // 원격의 지금 값 — 본체의 origin/master 는 아직 fetch 전이라 옛것이다
    const mine = head(root);
    const r = syncMain(root);
    assert.equal(r.action, 'diverged');
    assert.match(r.block, /본체 갈라짐 — 사용자가 풀어야/);
    assert.match(r.block, /1 앞 · 1 뒤/);
    git(['fetch', 'origin', 'master'], root);
    assert.equal(originHead(root), before, '갈라진 채로는 push 하지 않는다');
    assert.equal(head(root), mine, '갈라진 채로는 ff 도 하지 않는다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('기본 브랜치가 아니면 지나간다 — 로컬에만 두는 커밋 자리다', () => {
  const { dir, root } = repos();
  try {
    git(['checkout', '-b', 'scratch'], root);
    commit(root, '- [ ] **1. 딴 브랜치**\n', '로컬 전용');
    const before = originHead(root);
    const r = syncMain(root);
    assert.equal(r.action, 'skip');
    assert.match(r.detail, /기본 브랜치/);
    assert.equal(r.block, null);
    git(['fetch', 'origin', 'master'], root);
    assert.equal(originHead(root), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('회차 보고 — 갈라짐은 결정 표 한 줄, push 는 요약 밑 한 줄', () => {
  const out = renderCycleReport({
    at: new Date(2026, 7, 31, 21, 0).getTime(),
    dryRun: false,
    projects: [
      {
        project: '갈라진곳',
        sync: { action: 'diverged', block: '본체 갈라짐 — 사용자가 풀어야 (origin/master 보다 1 앞 · 1 뒤)', commits: ['abc123 내 커밋'], text: '' },
        error: '본체 갈라짐 — 사용자가 풀어야 (origin/master 보다 1 앞 · 1 뒤)',
        syncBlocked: true,
      },
      { project: '올린곳', sync: { action: 'push', block: null, text: 'push 1 커밋 → origin/master' }, dispatch: { dispatched: [], decisions: [] } },
    ],
  });
  assert.match(out, /본체 — 올린곳: push 1 커밋 → origin\/master/);
  assert.match(out, /\| 갈라진곳 \| 본체 동기화 \| 본체 갈라짐 — 사용자가 풀어야 \(origin\/master 보다 1 앞 · 1 뒤\) \(abc123 내 커밋 …\) \|/);
  // 같은 사실이 막힘 표에 두 번 오르면 안 된다
  assert.match(out, /\*\*막힘\*\* — 없음/);
  assert.match(out, /막힘 0 · 결정 필요 1/);
});
