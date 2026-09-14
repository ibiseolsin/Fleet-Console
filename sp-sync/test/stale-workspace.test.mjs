// node --test sp-sync/test/*.test.mjs
//
// 착륙이 지우고 남긴 워크스페이스 폴더가 다음 파견의 이름을 막던 것 (2026-09-02).
// `orca worktree rm` 은 git 등록과 추적 파일만 걷고 폴더는 남긴다 — `node_modules` 가 있으면
// 그것까지, 없어도 빈 껍데기가. 슬라이스 번호는 단계마다 1로 되감기므로 다음 단계의 같은
// 번호가 그 이름과 부딪치고, Orca 는 `slice4-2` 로 비켜 만든다. 그 이름은 `sliceNumberOf`
// 에 안 걸려 착륙도 재파견도 그 워크스페이스를 못 찾고, 창이 살아 있으면 `strayBlock` 이
// 그 프로젝트의 새 파견을 전부 멈춘다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { normPath, repoRoot } from '../lib/common.mjs';
import {
  staleWorkspaceReason,
  staleWorkspacePlan,
  sweepStaleWorkspaces,
  removeWorkspaceDir,
  workspacesDirOf,
  WORKSPACE_DEPS,
} from '../lib/fleet.mjs';

const WS = 'C:/Users/u/orca/workspaces/SP-sync';
const ROOT = 'C:/Users/u/orca/projects/SP-sync';
const reason = (path, over = {}) =>
  staleWorkspaceReason({ path, workspacesDir: WS, orcaPaths: [], gitPaths: [], hasDotGit: false, ...over });

// --- 판정: 무엇을 지워도 되는가 ---

test('고아 sliceN 폴더는 지워도 된다 — git 도 Orca 도 모른다', () => {
  assert.equal(reason(WS + '/slice5'), null);
  assert.equal(reason(WS + '/slice12'), null);
  // Orca 가 비켜 만든 이름도 파견이 만든 것이라 같이 치운다
  assert.equal(reason(WS + '/slice4-2'), null);
});

test('워크스페이스 폴더 밖은 손대지 않는다 — 본체·홈·다른 프로젝트', () => {
  assert.equal(reason(ROOT), '워크스페이스 폴더 밖');
  assert.equal(reason('C:/Users/u'), '워크스페이스 폴더 밖');
  // 워크스페이스 폴더 자기 자신도 아니다 — 반드시 그 **밑**이어야 한다
  assert.equal(reason(WS), '워크스페이스 폴더 밖');
  assert.equal(reason('C:/Users/u/orca/workspaces/project-b/slice5'), '워크스페이스 폴더 밖');
});

test('더 깊은 경로는 안 지운다 — 파견은 바로 밑에만 만든다', () => {
  assert.equal(reason(WS + '/slice5/node_modules'), '워크스페이스 바로 밑이 아님');
});

test('파견이 만든 이름이 아니면 안 지운다 — 사람이 판 폴더는 사람 것이다', () => {
  assert.equal(reason(WS + '/snakehead'), '파견이 만든 이름이 아님');
  assert.equal(reason(WS + '/slice'), '파견이 만든 이름이 아님');
  assert.equal(reason(WS + '/sliceN'), '파견이 만든 이름이 아님');
  assert.equal(reason(WS + '/my-slice5'), '파견이 만든 이름이 아님');
});

test('살아 있는 워크트리는 셋 중 무엇으로든 걸리면 안 지운다', () => {
  assert.equal(reason(WS + '/slice5', { hasDotGit: true }), '.git 이 있음 — 살아 있는 워크트리');
  assert.equal(reason(WS + '/slice5', { gitPaths: [WS + '/slice5'] }), 'git worktree 목록에 있음');
  assert.equal(reason(WS + '/slice5', { orcaPaths: [WS + '/slice5'] }), 'Orca 워크트리 목록에 있음');
});

test('경로 비교는 구분자와 대소문자를 안 가린다 — Windows 라 둘 다 흔들린다', () => {
  assert.equal(
    reason(WS + '/slice5', { gitPaths: ['C:\\Users\\u\\orca\\workspaces\\SP-sync\\Slice5'] }),
    'git worktree 목록에 있음'
  );
  assert.equal(
    staleWorkspaceReason({ path: WS + '/slice5', workspacesDir: WS.replace(/\//g, '\\'), orcaPaths: [], gitPaths: [] }),
    null
  );
});

// --- 계획: 목록을 못 읽으면 아무것도 안 지운다 ---

const fakeDeps = (over = {}) => ({
  orcaPaths: () => [],
  gitPaths: () => [],
  dir: () => WS,
  list: () => ['slice2', 'slice5', 'slice4-2', 'snakehead'],
  hasDotGit: () => false,
  exists: () => false,
  rm: () => {},
  ...over,
});

test('고아만 계획에 오르고, 이름이 다른 폴더는 보고에도 안 뜬다', () => {
  const plan = staleWorkspacePlan(ROOT, fakeDeps());
  assert.deepEqual(plan.stale.map((x) => x.name), ['slice2', 'slice5', 'slice4-2']);
  assert.deepEqual(plan.kept, []); // snakehead 는 파견과 무관하다 — 보고에 줄만 는다
});

test('Orca 목록을 못 읽으면 빈 계획 — 모르면 안 지운다', () => {
  // 빈 배열로 떨어지면 살아 있는 워크스페이스가 전부 고아로 보여 통째로 날아간다
  const plan = staleWorkspacePlan(ROOT, fakeDeps({ orcaPaths: () => null }));
  assert.deepEqual(plan.stale, []);
  assert.match(plan.detail, /목록을 못 읽어/);
});

test('git 목록을 못 읽어도 빈 계획', () => {
  const plan = staleWorkspacePlan(ROOT, fakeDeps({ gitPaths: () => null }));
  assert.deepEqual(plan.stale, []);
});

test('살아 있는 것은 계획에서 빠지고 사유가 보고에 남는다', () => {
  const plan = staleWorkspacePlan(ROOT, fakeDeps({ orcaPaths: () => [WS + '/slice5'] }));
  assert.deepEqual(plan.stale.map((x) => x.name), ['slice2', 'slice4-2']);
  assert.deepEqual(plan.kept, [{ name: 'slice5', why: 'Orca 워크트리 목록에 있음' }]);
});

// --- 쓸기: 하나가 실패해도 나머지는 지운다 ---

test('삭제가 실패해도 던지지 않고 나머지를 계속 지운다', () => {
  const plan = {
    stale: [
      { name: 'a', path: 'C:/x/a' },
      { name: 'b', path: 'C:/x/b' },
      { name: 'c', path: 'C:/x/c' },
    ],
  };
  const r = sweepStaleWorkspaces(
    plan,
    fakeDeps({
      rm: (p) => {
        if (p.endsWith('/b')) throw new Error('EBUSY: resource busy');
      },
    })
  );
  assert.deepEqual(r.removed, ['a', 'c']);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].detail, /EBUSY/);
});

test('지웠는데 남아 있으면 성공으로 세지 않는다 — Windows 는 조용히 실패한다', () => {
  const r = sweepStaleWorkspaces({ stale: [{ name: 'a', path: 'C:/x/a' }] }, fakeDeps({ exists: () => true }));
  assert.deepEqual(r.removed, []);
  assert.equal(r.failed[0].detail, '지웠는데 남아 있음');
});

// --- 실제 파일 시스템 ---

// 실제 파일 시스템은 그대로 쓰고, 바깥(Orca·git·`~/orca` 경로)만 임시 폴더로 갈아 끼운다.
const realDeps = (dir, over = {}) => ({ ...WORKSPACE_DEPS, orcaPaths: () => [], gitPaths: () => [], dir: () => dir, ...over });

test('실제로 지운다 — node_modules 만 남은 껍데기도, 빈 폴더도', () => {
  const home = mkdtempSync(join(tmpdir(), 'sp-stale-'));
  try {
    const dir = join(home, 'orca', 'workspaces', 'SP-sync');
    mkdirSync(join(dir, 'slice5', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'slice5', 'node_modules', 'pkg', 'index.js'), 'x');
    mkdirSync(join(dir, 'slice7'), { recursive: true }); // 빈 껍데기
    mkdirSync(join(dir, 'snakehead'), { recursive: true }); // 사람이 판 것 — 남아야 한다
    const root = join(home, 'orca', 'projects', 'SP-sync');
    const plan = staleWorkspacePlan(root, realDeps(dir));
    assert.deepEqual(plan.stale.map((x) => x.name).sort(), ['slice5', 'slice7']);
    const r = sweepStaleWorkspaces(plan, realDeps(dir));
    assert.deepEqual(r.removed.sort(), ['slice5', 'slice7']);
    assert.equal(existsSync(join(dir, 'slice5')), false);
    assert.equal(existsSync(join(dir, 'slice7')), false);
    assert.equal(existsSync(join(dir, 'snakehead')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('.git 이 있는 폴더는 실제로도 안 지운다', () => {
  const home = mkdtempSync(join(tmpdir(), 'sp-stale-'));
  try {
    const dir = join(home, 'orca', 'workspaces', 'SP-sync');
    mkdirSync(join(dir, 'slice9'), { recursive: true });
    writeFileSync(join(dir, 'slice9', '.git'), 'gitdir: ../../.git/worktrees/slice9');
    const root = join(home, 'orca', 'projects', 'SP-sync');
    const plan = staleWorkspacePlan(root, realDeps(dir));
    assert.deepEqual(plan.stale, []);
    assert.deepEqual(plan.kept, [{ name: 'slice9', why: '.git 이 있음 — 살아 있는 워크트리' }]);
    assert.equal(existsSync(join(dir, 'slice9')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- 착륙 경로: removeWorkspaceDir 는 판정을 다시 한다 ---

test('착륙의 폴더 삭제도 살아 있는 워크트리는 거절한다 — worktree rm 이 실패했을 수 있다', () => {
  const path = WS + '/slice5';
  const r = removeWorkspaceDir(path, ROOT, fakeDeps({ exists: () => true, orcaPaths: () => [path] }));
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'Orca 워크트리 목록에 있음');
});

test('폴더가 이미 없으면 성공이다 — Orca 가 이미 치웠을 수 있다', () => {
  const r = removeWorkspaceDir('C:/x/slice5', ROOT, fakeDeps({ exists: () => false }));
  assert.equal(r.ok, true);
});

test('착륙이 지우면 폴더가 정말 사라진다 — node_modules 째로', () => {
  const home = mkdtempSync(join(tmpdir(), 'sp-stale-'));
  try {
    const dir = join(home, 'orca', 'workspaces', 'SP-sync');
    mkdirSync(join(dir, 'slice5', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'slice5', 'node_modules', 'pkg', 'index.js'), 'x');
    const r = removeWorkspaceDir(join(dir, 'slice5'), join(home, 'orca', 'projects', 'SP-sync'), realDeps(dir));
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(dir, 'slice5')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('workspacesDirOf 는 본체 폴더명을 그대로 쓴다 — projects/ 의 형제 폴더', () => {
  // 본체 폴더명이 곧 워크스페이스 폴더명이다. 이 저장소 자신으로 확인한다 (repoRoot 가 git 을 탄다).
  // 벤더링본은 저장소 이름이 다르므로 본체 폴더명을 하드코딩하지 않고 `repoRoot` 에서 얻는다.
  const dir = workspacesDirOf(process.cwd(), 'C:/Users/u');
  assert.equal(normPath(dir), normPath(join('C:/Users/u', 'orca', 'workspaces', basename(repoRoot(process.cwd())))));
});
