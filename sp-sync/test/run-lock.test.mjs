// 슬라이스 39 — 회차 배관: 프로젝트별 실행 잠금 · pending 한 바퀴 더 · 트리거 서명은 기동 뒤 · 이름은 safeName.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRunLock, releaseRunLock, runLockPath, pendingFile, leavePending, takePending, fleetCycle, maybeTriggerCycle, cycleResultFiles, renderCycleReport, precheckVerdict } from '../lib/fleet.mjs';

const tmp = (tag) => mkdtempSync(join(tmpdir(), 'spsync-' + tag + '-'));

test('실행 잠금 — 산 소유자는 거부, 죽은 소유자·상한 초과는 뺏는다, 놓으면 다시 잡는다', () => {
  const base = tmp('runlock');
  try {
    const now = 1_000_000;
    const alive = new Set([111]);
    const isAlive = (pid) => alive.has(pid);
    const opt = { maxMs: 600000, base, isAlive };
    // 첫 획득 — 폴더와 owner.json
    let r = acquireRunLock('Demo', { ...opt, now, pid: 111 });
    assert.equal(r.ok, true);
    assert.equal(r.lock, runLockPath('Demo', base));
    assert.deepEqual(JSON.parse(readFileSync(join(r.lock, 'owner.json'), 'utf8')), { project: 'Demo', pid: 111, at: now });
    // 산 소유자 → 거부. 사유에 pid 와 경과가 실린다
    r = acquireRunLock('Demo', { ...opt, now: now + 120000, pid: 222 });
    assert.equal(r.ok, false);
    assert.equal(r.owner.pid, 111);
    assert.match(r.reason, /도는 중 \(pid 111, 2분 전 시작\)/);
    // 다른 프로젝트는 독립이다
    assert.equal(acquireRunLock('Other', { ...opt, now, pid: 222 }).ok, true);
    // 상한을 넘긴 산 소유자 → 묵은 락으로 보고 뺏는다 (매달린 회차의 안전망)
    r = acquireRunLock('Demo', { ...opt, now: now + 600001, pid: 222 });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(readFileSync(join(r.lock, 'owner.json'), 'utf8')).pid, 222);
    // 죽은 소유자 → 상한 안이라도 뺏는다
    alive.clear();
    r = acquireRunLock('Demo', { ...opt, now: now + 600002, pid: 333 });
    assert.equal(r.ok, true, '죽은 pid 222 의 락을 뺏는다');
    assert.equal(JSON.parse(readFileSync(join(r.lock, 'owner.json'), 'utf8')).pid, 333);
    // 놓으면 다시 잡는다 (333 이 살아 있어도)
    alive.add(333);
    assert.equal(acquireRunLock('Demo', { ...opt, now: now + 600003, pid: 444 }).ok, false);
    releaseRunLock('Demo', base);
    assert.equal(existsSync(runLockPath('Demo', base)), false);
    assert.equal(acquireRunLock('Demo', { ...opt, now: now + 600004, pid: 444 }).ok, true);
    // owner.json 이 없는 폴더(막 잡히는 찰나) — 폴더 시각이 상한 안이면 거부, 넘겼으면 뺏는다
    releaseRunLock('Demo', base);
    const lock = runLockPath('Demo', base);
    rmSync(lock, { recursive: true, force: true });
    acquireRunLock('Demo', { ...opt, now: Date.now(), pid: 1 });
    rmSync(join(lock, 'owner.json'));
    assert.equal(acquireRunLock('Demo', { ...opt, now: Date.now(), pid: 2 }).ok, false);
    utimesSync(lock, new Date(Date.now() - 700000), new Date(Date.now() - 700000));
    assert.equal(acquireRunLock('Demo', { ...opt, now: Date.now(), pid: 2 }).ok, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('이름은 safeName — 가계부·자격증이 다른 파일이고, ASCII 이름은 옛 slug 와 같다', () => {
  assert.notEqual(cycleResultFiles('가계부').done, cycleResultFiles('자격증').done);
  assert.match(cycleResultFiles('가계부').done, /fleet-cycle-result\.가계부\.json$/);
  assert.match(cycleResultFiles('Project X').done, /fleet-cycle-result\.Project_X\.json$/, 'coordinator precheck 의 slug 와 같다');
  assert.match(cycleResultFiles('SP-sync').done, /fleet-cycle-result\.SP-sync\.json$/);
  const base = tmp('runlock-name');
  try {
    assert.notEqual(runLockPath('가계부', base), runLockPath('자격증', base));
    assert.match(pendingFile('가계부', base), /fleet-pending\.가계부\.json$/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pending — 남기고, 한 번만 가져간다', () => {
  const dir = tmp('pending');
  try {
    const f = leavePending('Demo', '워커 턴 끝', { dir, now: 5 });
    assert.equal(f, pendingFile('Demo', dir));
    const got = takePending('Demo', dir);
    assert.equal(got.project, 'Demo');
    assert.equal(got.at, 5);
    assert.equal(got.why, '워커 턴 끝');
    assert.equal(existsSync(f), false, '가져가면 지운다');
    assert.equal(takePending('Demo', dir), null, '두 번째는 없다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 가짜 회차 한 바퀴 — 어떤 이름을 몇 번째 바퀴에 돌았는지 기록하고, 시킨 대로 pending 을 남긴다. */
function fakeRunner(calls, { pendingDir, leaveOn = {} }) {
  return async (name) => {
    calls.push(name);
    const n = calls.filter((c) => c === name).length;
    if (leaveOn[name]?.includes(n)) leavePending(name, '회차 도중 끝난 워커', { dir: pendingDir });
    return { project: name, land: { landed: [{ name: 'slice' + n, ok: true, pr: n }] }, dispatch: {} };
  };
}

test('fleetCycle — 산 소유자가 쥔 프로젝트는 건너뛰고 pending 을 남긴다; 죽은 소유자면 돈다', async () => {
  const dir = tmp('cycle-lock');
  try {
    const lockDir = join(dir, 'lock');
    const pendingDir = join(dir, 'pend');
    const reportPath = join(dir, 'cycle.md');
    // 다른 회차(pid 999)가 Demo 를 쥐고 있다
    assert.equal(acquireRunLock('Demo', { maxMs: 600000, base: lockDir, pid: 999, isAlive: () => true }).ok, true);
    const calls = [];
    let out = await fleetCycle({ projects: ['Demo'], quiet: true, limits: {}, deps: { runProject: fakeRunner(calls, { pendingDir }), lockDir, pendingDir, isAlive: () => true, reportPath } });
    assert.deepEqual(calls, [], '회차 본체를 안 부른다');
    assert.equal(out.projects.length, 1);
    assert.match(out.projects[0].cycleRunning, /도는 중 \(pid 999/);
    assert.equal(out.projects[0].pending, true);
    assert.equal(existsSync(pendingFile('Demo', pendingDir)), true, '요청을 남긴다');
    assert.match(readFileSync(reportPath, 'utf8'), /건너뜀 — Demo: .*요청을 남김/);
    assert.equal(existsSync(runLockPath('Demo', lockDir)), true, '남의 락을 건드리지 않는다');
    // 같은 락인데 소유자가 죽었다 → 뺏어서 돈다. 시작하며 pending 을 소비한다(이 바퀴가 그 요청이다)
    out = await fleetCycle({ projects: ['Demo'], quiet: true, limits: {}, deps: { runProject: fakeRunner(calls, { pendingDir }), lockDir, pendingDir, isAlive: () => false, reportPath } });
    assert.deepEqual(calls, ['Demo']);
    assert.equal(out.projects[0].cycleRunning, undefined);
    assert.equal(existsSync(pendingFile('Demo', pendingDir)), false, '시작하며 지운 pending — 한 바퀴 더 돌지 않는다');
    assert.equal(existsSync(runLockPath('Demo', lockDir)), false, '끝나면 놓는다');
    // dry-run — 산 소유자면 건너뛰되 pending 을 쓰지 않는다
    assert.equal(acquireRunLock('Demo', { maxMs: 600000, base: lockDir, pid: 999, isAlive: () => true }).ok, true);
    out = await fleetCycle({ projects: ['Demo'], dryRun: true, quiet: true, limits: {}, deps: { runProject: fakeRunner(calls, { pendingDir }), lockDir, pendingDir, isAlive: () => true, reportPath } });
    assert.match(out.projects[0].cycleRunning, /도는 중/);
    assert.equal(out.projects[0].pending, undefined);
    assert.equal(existsSync(pendingFile('Demo', pendingDir)), false, 'dry-run 은 운영 상태를 안 바꾼다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fleetCycle — 도는 동안 들어온 pending 은 끝에서 한 바퀴 더, 1회 한정, 한 결과 JSON', async () => {
  const dir = tmp('cycle-pending');
  try {
    const lockDir = join(dir, 'lock');
    const pendingDir = join(dir, 'pend');
    const reportPath = join(dir, 'cycle.md');
    const calls = [];
    // Demo 는 1·2바퀴 도중마다 요청이 들어오고, Other 는 조용하다
    const run = fakeRunner(calls, { pendingDir, leaveOn: { Demo: [1, 2] } });
    const out = await fleetCycle({ projects: ['Demo', 'Other'], quiet: true, limits: {}, deps: { runProject: run, lockDir, pendingDir, isAlive: () => true, reportPath } });
    assert.deepEqual(calls, ['Demo', 'Other', 'Demo'], '전부 한 바퀴 뒤 Demo 만 한 번 더');
    assert.deepEqual(out.projects.map((p) => [p.project, p.round ?? 1]), [['Demo', 1], ['Other', 1], ['Demo', 2]], '두 바퀴가 한 결과에 있다');
    assert.equal(existsSync(pendingFile('Demo', pendingDir)), true, '둘째 바퀴 중 들어온 요청은 다음 회차 몫 (1회 한정)');
    assert.equal(existsSync(runLockPath('Demo', lockDir)), false);
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /프로젝트 2\(Demo, Other\)/, '요약은 이름 단위로 센다');
    assert.match(report, /착륙 3/, '행은 두 바퀴 다 싣는다');
    assert.match(report, /한 바퀴 더 — Demo \(회차 중 들어온 요청\)/);
    // 결과 JSON 의 decisions 는 항목마다 붙어 있다
    for (const p of out.projects) assert.ok(Array.isArray(p.decisions));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('두 바퀴 합치기 — 보고·precheck 의 결정은 마지막 바퀴, 건수는 합', () => {
  const wait = (n) => ({ slice: n, name: 'slice' + n, waiting: '결정 요청' });
  const r1 = { project: 'Demo', land: { landed: [{ name: 'slice1', ok: true, pr: 1 }], checks: [wait(2), wait(3)] }, dispatch: {} };
  const r2 = { project: 'Demo', round: 2, land: { landed: [{ name: 'slice3', ok: true, pr: 3 }], checks: [wait(2)] }, dispatch: { dispatched: [{ name: 'slice4', ok: true, text: 't' }] } };
  const out = { at: Date.now(), projects: [r1, r2] };
  const md = renderCycleReport(out);
  const decisionsTable = md.split('**결정 필요**')[1] || '';
  assert.equal((decisionsTable.match(/slice2/g) || []).length, 1, '같은 키는 한 줄');
  assert.doesNotMatch(decisionsTable, /slice3/, '첫 바퀴의 대기가 둘째 바퀴에서 풀렸으면 사라진다');
  assert.match(md, /착륙 2 · 파견 1/);
  const v = precheckVerdict(out, {});
  assert.deepEqual(Object.keys(v.byProject.Demo.keys), ['wait:Demo:2'], '키는 마지막 바퀴');
  assert.deepEqual(v.fresh.map((i) => i.key), ['wait:Demo:2'], '새 키가 두 번 세어지지 않는다');
  assert.equal(v.landed, 2);
  assert.equal(v.dispatched, 1);
  // 지난 회차에 slice3 대기가 있었으면 해소로 잡힌다 (첫 바퀴에는 있었지만 마지막 바퀴에는 없다)
  const v2 = precheckVerdict(out, { Demo: { keys: { 'wait:Demo:3': { since: 1 } } } });
  assert.deepEqual(v2.resolved.map((i) => i.key), ['wait:Demo:3']);
});

test('트리거 서명은 기동을 확인한 뒤에만 — 실패하면 같은 커밋으로 다시 띄울 수 있다; 도는 중이면 pending', () => {
  const dir = tmp('trigger-sig');
  try {
    const seenFile = join(dir, 'fleet-trigger.json');
    const pendingDir = join(dir, 'pend');
    const t = { trigger: true, kind: 'workspace', project: 'Demo', rootKey: 'c:/x/demo/slice1', sig: 'workspace:abc', reason: 'Demo/slice1 — 1번 체크 완료' };
    const launches = [];
    const base = { check: () => t, running: () => false, seenFile, pendingDir };
    // 1) 기동 실패 → 서명 없음
    let r = maybeTriggerCycle({ cwd: dir }, null, { ...base, launch: (plan) => (launches.push(plan), { ok: false, reason: 'WMI 실패: x' }) });
    assert.equal(r.trigger, false);
    assert.match(r.reason, /WMI 실패/);
    assert.equal(existsSync(seenFile), false, '실패했으니 서명을 안 적는다');
    // 2) 같은 sig 로 다시 → 띄운다, 이제 서명이 적힌다
    r = maybeTriggerCycle({ cwd: dir }, null, { ...base, launch: (plan) => (launches.push(plan), { ok: true, pid: 42 }) });
    assert.equal(r.spawned, true);
    assert.equal(r.pid, 42);
    assert.equal(launches.length, 2);
    assert.deepEqual(JSON.parse(readFileSync(seenFile, 'utf8')), { [t.rootKey]: t.sig });
    // 3) 같은 sig 세 번째 → 안 띄운다
    r = maybeTriggerCycle({ cwd: dir }, null, { ...base, launch: () => assert.fail('띄우면 안 된다') });
    assert.equal(r.skipped, '같은 커밋으로 이미 띄웠음');
    // 4) 회차가 도는 중 → pending 을 남기고 서명은 그대로 (새 커밋이라도)
    const t2 = { ...t, sig: 'workspace:def' };
    r = maybeTriggerCycle({ cwd: dir }, null, { ...base, check: () => t2, running: () => true, launch: () => assert.fail('띄우면 안 된다') });
    assert.equal(r.trigger, false);
    assert.match(r.skipped, /요청을 남김/);
    assert.equal(r.pending, pendingFile('Demo', pendingDir));
    assert.equal(JSON.parse(readFileSync(r.pending, 'utf8')).why, t.reason);
    assert.deepEqual(JSON.parse(readFileSync(seenFile, 'utf8')), { [t.rootKey]: t.sig }, '서명은 옛것 그대로 — 회차가 끝난 뒤 같은 커밋으로 띄울 수 있다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
