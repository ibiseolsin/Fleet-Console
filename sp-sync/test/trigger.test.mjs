// node --test sp-sync/test/*.test.mjs
// 슬라이스 20 — 워커 완료가 회차를 부른다. Stop 훅의 자격 판정과 회차 잠금.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cycleTriggerCheck, cycleRunning, cycleResultFiles, acquireTriggerLock, releaseTriggerLock, renderCycleReport } from '../sp-sync.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();

const CONF = { fleetTrigger: true, fleetPause: [], fleetTriggerLockMs: 600000 };

/**
 * `<home>/orca/projects/<이름>` 본체 하나 + `<home>/orca/workspaces/<이름>/slice1` 워크트리 하나.
 * 판정이 보는 것(git 워크트리 관계·브랜치·PLAN.md·트리 상태)이 전부 진짜 git 이라 실제 저장소로 만든다.
 */
function fleet(name = 'Demo') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spsync-trigger-')));
  const remote = join(dir, 'remote.git');
  const root = join(dir, 'orca', 'projects', name);
  mkdirSync(remote, { recursive: true });
  mkdirSync(join(dir, 'orca', 'projects'), { recursive: true });
  git(['init', '--bare', '--initial-branch=master'], remote);
  git(['clone', remote, root], dir);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'PLAN.md'), '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 다음**\n', 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-m', 'init'], root);
  git(['push', '-u', 'origin', 'master'], root);
  git(['remote', 'set-head', 'origin', '-a'], root);
  return { dir, root, home: dir };
}

function workspace(f, name = 'slice1') {
  const ws = join(f.dir, 'orca', 'workspaces', 'Demo', name);
  mkdirSync(join(f.dir, 'orca', 'workspaces', 'Demo'), { recursive: true });
  git(['worktree', 'add', '-b', name, ws], f.root);
  return ws;
}

const plan = (dir, text) => writeFileSync(join(dir, 'PLAN.md'), text, 'utf8');
const commitAll = (dir, msg) => {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
};
const DONE = '- [x] **1. 첫 슬라이스**\n- [ ] **2. 다음**\n';

test('워크스페이스 — 체크 + 깨끗한 트리 + 대기 없음이면 회차를 부른다', () => {
  const f = fleet();
  try {
    const ws = workspace(f);
    plan(ws, DONE);
    commitAll(ws, '슬라이스 1 완료');
    const r = cycleTriggerCheck(ws, { now: '끝', wait: '' }, { home: f.home, config: CONF });
    assert.equal(r.trigger, true, r.reason);
    assert.equal(r.kind, 'workspace');
    assert.equal(r.slice, 1);
    assert.equal(r.project, 'Demo');
    assert.match(r.sig, /^workspace:[0-9a-f]{7,}$/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('워크스페이스 — 미체크·더러운 트리·대기 있음은 회차를 안 부른다', () => {
  const f = fleet();
  try {
    const ws = workspace(f);
    // 아직 체크 안 함
    assert.equal(cycleTriggerCheck(ws, null, { home: f.home, config: CONF }).trigger, false);
    assert.match(cycleTriggerCheck(ws, null, { home: f.home, config: CONF }).reason, /미체크/);

    plan(ws, DONE);
    commitAll(ws, '슬라이스 1 완료');
    // 커밋 안 된 변경이 남아 있으면 착륙이 못 하므로 부르지 않는다
    writeFileSync(join(ws, 'memo.txt'), '작업 중\n', 'utf8');
    const dirty = cycleTriggerCheck(ws, null, { home: f.home, config: CONF });
    assert.equal(dirty.trigger, false);
    assert.match(dirty.reason, /더러움/);

    rmSync(join(ws, 'memo.txt'));
    // 사용자 결정을 기다리는 카드가 있으면 사람 몫이다
    const waiting = cycleTriggerCheck(ws, { wait: '이 API 로 갈까요?' }, { home: f.home, config: CONF });
    assert.equal(waiting.trigger, false);
    assert.match(waiting.reason, /결정을 기다림/);

    // 브랜치도 폴더도 sliceN 이 아니면 어느 슬라이스인지 모른다 (착륙 판정과 같은 잣대)
    const odd = workspace(f, 'tuskfish');
    plan(odd, DONE);
    commitAll(odd, '체크는 했지만 이름이 규칙 밖');
    assert.match(cycleTriggerCheck(odd, null, { home: f.home, config: CONF }).reason, /sliceN/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('본체 — origin 보다 앞서면 부르고, 같으면 안 부른다', () => {
  const f = fleet();
  try {
    assert.match(cycleTriggerCheck(f.root, null, { home: f.home, config: CONF }).reason, /origin\/master 과 같음/);
    plan(f.root, '- [ ] **1. 첫 슬라이스**\n- [ ] **2. 다음**\n- [ ] **3. 새로**\n');
    commitAll(f.root, 'PLAN — 슬라이스 3');
    const r = cycleTriggerCheck(f.root, null, { home: f.home, config: CONF });
    assert.equal(r.trigger, true, r.reason);
    assert.equal(r.kind, 'main');
    assert.equal(r.ahead, 1);
    // 기본 브랜치가 아니면 "로컬에만 두는 커밋" 자리라 건드리지 않는다
    git(['switch', '-c', 'side'], f.root);
    assert.match(cycleTriggerCheck(f.root, null, { home: f.home, config: CONF }).reason, /기본 브랜치/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// 슬라이스 41 — 파견 제외(`fleetNoDispatch`)는 회차가 아니라 **동기화만** 부른다. 예전에는
// 이름 'coordinator' 이 박혀 "회차 대상이 아님" 으로 통째로 걸렸고, 그래서 본체가 15 커밋 밀렸다.
test('파견 제외 프로젝트는 sync-only, 일시 제외·설정 꺼짐은 아무것도 안 부른다', () => {
  const f = fleet('coordinator');
  const NO = { ...CONF, fleetNoDispatch: ['coordinator'] };
  try {
    // 올릴 것이 없으면 sync-only 도 안 뜬다 — 매 턴 도는 자리가 아니다
    assert.match(cycleTriggerCheck(f.root, null, { home: f.home, config: NO }).reason, /origin\/master 과 같음/);
    plan(f.root, '- [ ] **1. 첫**\n');
    commitAll(f.root, '앞서게');
    const r = cycleTriggerCheck(f.root, null, { home: f.home, config: NO });
    assert.equal(r.trigger, true, r.reason);
    assert.equal(r.kind, 'sync-only');
    assert.equal(r.ahead, 1);
    // 서명이 kind 별이라 sync-only 도 같은 HEAD 로 두 번 안 띄운다
    assert.match(r.sig, /^sync-only:[0-9a-f]{7,}$/);
    assert.match(r.reason, /동기화만/);
    // 일시 제외는 동기화까지 막는다 — 파견 제외와 다른 스위치다
    assert.match(cycleTriggerCheck(f.root, null, { home: f.home, config: { ...NO, fleetPause: ['coordinator'] } }).reason, /일시 제외/);
    // 목록에 없으면 그냥 워커 프로젝트다 (본체 갈래)
    assert.equal(cycleTriggerCheck(f.root, null, { home: f.home, config: { ...CONF, fleetNoDispatch: [] } }).kind, 'main');
    // PLAN.md 가 없어도 된다 — 슬라이스를 안 읽고 push 만 한다
    rmSync(join(f.root, 'PLAN.md'));
    commitAll(f.root, 'PLAN 없이');
    assert.equal(cycleTriggerCheck(f.root, null, { home: f.home, config: NO }).kind, 'sync-only');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
  const g = fleet();
  try {
    plan(g.root, '- [ ] **1. 첫**\n');
    commitAll(g.root, '앞서게');
    assert.equal(cycleTriggerCheck(g.root, null, { home: g.home, config: CONF }).trigger, true);
    assert.match(cycleTriggerCheck(g.root, null, { home: g.home, config: { ...CONF, fleetPause: ['Demo'] } }).reason, /일시 제외/);
    assert.match(cycleTriggerCheck(g.root, null, { home: g.home, config: { ...CONF, fleetTrigger: false } }).reason, /꺼짐/);
    // ~/orca/projects 밖의 저장소는 회차가 다루지 않는다
    assert.match(cycleTriggerCheck(g.root, null, { home: join(g.home, '없는곳'), config: CONF }).reason, /Orca 프로젝트가 아님/);
  } finally {
    rmSync(g.dir, { recursive: true, force: true });
  }
});

test('회차 잠금 — .part 가 결과보다 새것일 때만 도는 중이다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-lock-'));
  try {
    const part = join(dir, 'r.json.part');
    const done = join(dir, 'r.json');
    const files = { part, done };
    const now = Date.now();
    const touch = (f, ts) => {
      writeFileSync(f, '{}');
      utimesSync(f, new Date(ts), new Date(ts));
    };
    // 아직 아무 회차도 안 돌았다
    assert.equal(cycleRunning(600000, now, files), false);
    // 회차가 방금 시작했다 — .part 만 있다
    touch(part, now - 60000);
    assert.equal(cycleRunning(600000, now, files), true);
    // 끝났다 — 결과가 .part 보다 새것이다
    touch(done, now - 30000);
    assert.equal(cycleRunning(600000, now, files), false);
    // 다음 회차가 시작했다
    touch(part, now - 10000);
    assert.equal(cycleRunning(600000, now, files), true);
    // 상한을 넘긴 .part 는 죽은 회차로 본다
    assert.equal(cycleRunning(5000, now, files), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 슬라이스 22 — 회차는 프로젝트별로 돈다 ----

test('결과 파일이 프로젝트별로 갈리고, 잠금은 전역 파일과 프로젝트 파일을 둘 다 본다', () => {
  // precheck 의 slug 규칙과 같아야 한다 (cycle-precheck.mjs 의 `slug`) — 어긋나면 sp-sync 는
  // 도는 회차를 못 보고 같은 워크스페이스에 두 번째 회차를 띄운다.
  assert.match(cycleResultFiles(null).done, /fleet-cycle-result\.json$/);
  assert.match(cycleResultFiles('SP-sync').done, /fleet-cycle-result\.SP-sync\.json$/);
  assert.match(cycleResultFiles('Project X').done, /fleet-cycle-result\.Project_X\.json$/);
  assert.equal(cycleResultFiles('SP-sync').part, cycleResultFiles('SP-sync').done + '.part');

  const dir = mkdtempSync(join(tmpdir(), 'spsync-lock2-'));
  try {
    const now = Date.now();
    const files = (n) => ({ part: join(dir, n + '.json.part'), done: join(dir, n + '.json') });
    const touch = (f, ts) => {
      writeFileSync(f, '{}');
      utimesSync(f, new Date(ts), new Date(ts));
    };
    const all = files('all');
    const mine = files('mine');
    assert.equal(cycleRunning(600000, now, [all, mine]), false);
    // 안전망(전체) 회차가 도는 중이면 그 안에 이 프로젝트가 들어 있으므로 프로젝트별 회차도 안 띄운다
    touch(all.part, now - 10000);
    assert.equal(cycleRunning(600000, now, [all, mine]), true);
    assert.equal(cycleRunning(600000, now, mine), false, '프로젝트 파일만 보면 아직 안 돈다');
    touch(all.done, now - 5000);
    assert.equal(cycleRunning(600000, now, [all, mine]), false);
    // 이번엔 이 프로젝트만 도는 중
    touch(mine.part, now - 1000);
    assert.equal(cycleRunning(600000, now, [all, mine]), true);
    assert.equal(cycleRunning(600000, now, mine), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('트리거 잠금은 프로젝트별이라 다른 프로젝트끼리는 동시에 쥔다', () => {
  // 전역 락 하나였을 때는 A 의 트리거가 쥔 동안 끝난 B 워커의 트리거가 통째로 버려졌다.
  // 락 폴더는 임시 폴더로 준다 — 단위 테스트가 진짜 `~/.sp-sync` 에 락을 만들면, 회차가
  // 이 테스트를 게이트로 돌리는 동안(`fleetChecks`) 실제 트리거와 같은 자리를 건드린다.
  const dir = mkdtempSync(join(tmpdir(), 'spsync-triglock-'));
  const a = 'A';
  const b = 'B';
  try {
    assert.equal(acquireTriggerLock(600000, Date.now(), a, dir), true);
    assert.equal(acquireTriggerLock(600000, Date.now(), b, dir), true, '다른 프로젝트는 막히지 않는다');
    assert.equal(acquireTriggerLock(600000, Date.now(), a, dir), false, '같은 프로젝트의 둘째는 막힌다');
    releaseTriggerLock(a, dir);
    assert.equal(acquireTriggerLock(600000, Date.now(), a, dir), true, '놓으면 다시 쥔다');
    // 상한을 넘긴 락은 죽은 트리거로 보고 뺏는다
    assert.equal(acquireTriggerLock(600000, Date.now() + 700000, a, dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('안전망 회차가 건너뛴 프로젝트는 막힘이 아니라 한 줄로 보고된다', () => {
  const r = renderCycleReport({
    at: Date.now(),
    projects: [{ project: 'project-b', cycleRunning: '프로젝트별 회차가 도는 중' }, { project: 'SP-sync', land: {}, dispatch: {} }],
  });
  assert.match(r, /건너뜀 — project-b: 프로젝트별 회차가 도는 중/);
  // 볼 것이 아니다 — 막힘 표에 실리면 precheck 가 "달라짐"으로 읽어 팀장을 깨운다
  assert.doesNotMatch(r.split('## 막힘')[1] || '', /project-b/);
});

// ---- 슬라이스 3 — 단계 경계에서 트리거가 죽지 않는다 ----

test('절의 마지막 슬라이스를 체크해 현재 단계가 넘어가도 회차를 부른다', () => {
  // 워커가 자기 절의 마지막을 체크하면 그 절엔 미체크가 없어 `phase` 가 다음 절로 넘어간다.
  // 현재 단계에서만 번호를 찾던 동안에는 그 순간 "현재 단계에 1번이 없음"으로 트리거도 착륙도
  // 막혔다 — 정확히 끝낸 워커가 방치되는 모양이다 (2026-09-01 재현).
  const f = fleet();
  try {
    const ws = workspace(f);
    plan(ws, '## 3단계\n\n- [x] **1. 첫 슬라이스**\n\n## 4단계\n\n- [ ] **2. 다음**\n');
    commitAll(ws, '슬라이스 1 완료 · 4단계 절 추가');
    const r = cycleTriggerCheck(ws, null, { home: f.home, config: CONF });
    assert.equal(r.trigger, true, r.reason);
    assert.equal(r.slice, 1);
    assert.match(r.reason, /1번 체크 완료/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
