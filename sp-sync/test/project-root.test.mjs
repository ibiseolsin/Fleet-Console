// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { repoRoot, resolveProjectRoot, projectHere } from '../sp-sync.mjs';

/** 임시 git 저장소 하나. 실제 git 을 부른다 — 상대 `--git-common-dir` 이 버그의 씨앗이라 흉내로는 안 잡힌다. */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-sync-root-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('repoRoot: 저장소 하위 폴더에서 불러도 저장소 루트다', () => {
  const dir = tempRepo();
  try {
    const sub = join(dir, 'sp-sync');
    mkdirSync(sub);
    // 2026-08-30 회귀: `--git-common-dir` 이 하위 폴더에서 `../.git` 로 나오는데 그걸 저장소
    // 루트 기준으로 풀어 한 칸 위(= 저장소 바깥)를 프로젝트 루트로 내놨다.
    assert.equal(repoRoot(sub).toLowerCase(), repoRoot(dir).toLowerCase());
    assert.equal(repoRoot(sub).replace(/\\/g, '/').toLowerCase(), dir.replace(/\\/g, '/').toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: 맨 이름은 지금 위치의 같은 이름 폴더로 새지 않는다', () => {
  // 본체 SP-sync 와 같은 배치를 세운다: 프로젝트 폴더 안에 이름이 겹치는 코드 폴더 `sp-sync/`.
  // Windows 는 대소문자를 안 가려서 `SP-sync` 라는 **이름**이 그 폴더로 걸렸고, 거기 PLAN.md 가
  // 없으니 저장소 밖으로 올라가 `~/orca/projects` 가 프로젝트 루트가 됐다 (2026-08-30 회귀).
  const projects = mkdtempSync(join(tmpdir(), 'sp-sync-projects-'));
  const repo = join(projects, 'SP-sync');
  const cwd = process.cwd();
  try {
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'sp-sync'));
    writeFileSync(join(repo, 'PLAN.md'), '- [ ] 1. 뭔가\n', 'utf8');
    process.chdir(repo);
    assert.equal(resolveProjectRoot('SP-sync', projects).toLowerCase(), repo.toLowerCase());
  } finally {
    process.chdir(cwd);
    rmSync(projects, { recursive: true, force: true });
  }
});

test('projectHere: 본체·하위 폴더·연결된 워크스페이스 모두 프로젝트 폴더명, 프로젝트 밖은 거부', () => {
  // ~/orca 배치를 흉내 낸다: projects/<이름> 이 본체, workspaces/<이름>/sliceN 이 연결된 워크트리.
  const base = mkdtempSync(join(tmpdir(), 'sp-sync-here-'));
  const projects = join(base, 'projects');
  const repo = join(projects, 'Project X');
  const ws = join(base, 'workspaces', 'Project X', 'slice3');
  const outside = join(base, 'elsewhere');
  try {
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'PLAN.md'), '- [ ] 1. 뭔가\n', 'utf8');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo });
    mkdirSync(join(base, 'workspaces', 'Project X'), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'slice3', ws], { cwd: repo });
    mkdirSync(join(repo, 'sub'));
    assert.equal(projectHere(repo, projects), 'Project X');
    assert.equal(projectHere(join(repo, 'sub'), projects), 'Project X');
    // 워크스페이스에서 눌러도 본체 이름이다 — repoRoot 가 git 공용 디렉터리로 올라간다
    assert.equal(projectHere(ws, projects), 'Project X');
    // 프로젝트 밖 저장소는 거부 — 엉뚱한 이름이 fleetPause 에 남으면 안 된다
    mkdirSync(outside);
    execFileSync('git', ['init', '-q'], { cwd: outside });
    assert.throws(() => projectHere(outside, projects), /프로젝트 폴더가 아님/);
    // git 저장소가 아닌 폴더도 거부
    assert.throws(() => projectHere(base, projects), /프로젝트 폴더가 아님/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: 경로를 주면 그 경로 그대로 (PLAN.md 가 있을 때)', () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, 'PLAN.md'), '- [ ] 1. 뭔가\n', 'utf8');
    assert.equal(resolveProjectRoot(dir).toLowerCase(), dir.toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
