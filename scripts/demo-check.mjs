#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Isolate the verification itself from both CLI fixtures and browser visitors.
process.env.FLEET_STATE_ROOT = resolve('sandbox', 'demo-check-' + randomUUID());
process.env.FLEET_DAILY_RUNS = '2';
process.env.FLEET_MAX_RUN_USD = '0.25';
process.env.OPENAI_API_KEY = 'test-no-network';
const { withVisitor, visitorRoot, resetDemo, reserveRun, runAvailability } = await import('../src/demo.mjs');
const { statePath, stateRoot, STATE_ROOT } = await import('../src/state.mjs');
const { TOOLS } = await import('../src/fleet/tools.mjs');
const { readQueue, decideApproval } = await import('../src/fleet/approvals.mjs');
const { readRun, writeRun } = await import('../src/agent/runs.mjs');
const { startRun, resumeRun } = await import('../src/agent/loop.mjs');
const { observeFleet } = await import('../src/fleet/source.mjs');
const call = async (name, args) => (await TOOLS.find((t) => t.name === name).run(args)).data;
const visitors = [randomUUID(), randomUUID()];
const approvals = [];

await Promise.all(visitors.map((id, i) => withVisitor(id, async () => {
  await new Promise((r) => setTimeout(r, i ? 1 : 30));
  assert.equal(stateRoot(), visitorRoot(id));
  assert.equal(readQueue().items.length, 0);
  const land = await call('fleet_land', { project: 'atlas', workspace: 'slice2' });
  assert.equal(land.status, 'pending');
  approvals[i] = land.approval.id;
  const dispatch = await call('fleet_dispatch', { project: 'cobalt', slice: 2 });
  assert.equal(dispatch.status, 'pending');
  for (const item of readQueue().items) {
    assert.equal(decideApproval(item.id, 'approve').ok, true);
    const done = await call(item.tool, { ...item.args, approvalId: item.id });
    assert.equal(done.status, 'executed', JSON.stringify(done));
  }
  assert.equal(readQueue().items.length, 2);
  assert.ok(existsSync(statePath('fleet', 'orca', 'workspaces', 'cobalt', 'slice2')));
  assert.ok(!existsSync(statePath('fleet', 'orca', 'workspaces', 'atlas', 'slice2')));
})));
assert.notEqual(approvals[0], approvals[1]);
console.log('PASS two concurrent visitors: independent queues, dispatch, landing and async paths');

await withVisitor(visitors[0], async () => {
  assert.equal(decideApproval(approvals[1], 'approve').ok, false);
  assert.equal(readRun('../../daily-runs'), null);
  const saved = { id: randomUUID(), state: 'stopped', limits: { maxUsd: 0.25 }, legs: [{ costUsd: 0.25 }], steps: [], createdAt: new Date().toISOString() };
  writeRun(saved);
  assert.match(runAvailability(saved).reason, /비용 상한/);
  assert.equal(resumeRun(saved.id).ok, false);
  const pending = await call('fleet_dispatch', { project: 'beacon', slice: 4 });
  assert.equal(pending.status, 'pending');
  decideApproval(pending.approval.id, 'approve');
  resetDemo();
  assert.equal(readRun(saved.id).id, saved.id);
  assert.equal((await call('fleet_dispatch', { project: 'beacon', slice: 4, approvalId: pending.approval.id })).status, 'rejected');
  assert.ok(existsSync(statePath('fleet', 'orca', 'workspaces', 'atlas', 'slice2')));
  assert.ok(!existsSync(statePath('fleet', 'orca', 'workspaces', 'cobalt', 'slice2')));
  writeRun({ ...saved, id: randomUUID(), state: 'running', pid: process.pid });
  assert.throws(resetDemo, /실행 중/);
});
await withVisitor(visitors[1], () => {
  assert.ok(!existsSync(statePath('fleet', 'orca', 'workspaces', 'atlas', 'slice2')));
  assert.equal(readQueue().items.length, 2);
});
console.log('PASS reset restores only own fixture, preserves histories, rejects old approval and busy reset');

reserveRun(); reserveRun();
assert.throws(() => reserveRun(), /오늘 서버 전체 실행 상한/);
await withVisitor(randomUUID(), () => {
  assert.throws(() => startRun({ limits: { maxUsd: 999 }, model: 'forged' }), /오늘 서버 전체 실행 상한/);
  resetDemo();
  assert.equal(runAvailability().allowed, false);
});
const child = spawnSync(process.execPath, ['--input-type=module', '-e', "const {runAvailability}=await import('./src/demo.mjs'); if(runAvailability().allowed) process.exit(1); console.log('persisted quota');"], { cwd: resolve('.'), env: process.env, encoding: 'utf8', windowsHide: true });
assert.equal(child.status, 0, child.stderr);
writeFileSync(join(STATE_ROOT, 'daily-runs.json'), JSON.stringify({ day: '2000-01-01', used: 999 }));
assert.equal(runAvailability().used, 0);
writeFileSync(join(STATE_ROOT, 'daily-runs.json'), 'broken');
assert.throws(reserveRun);
console.log('PASS global quota: new cookies/reset/restart cannot bypass; UTC rollover; corrupt ledger fails closed');
assert.throws(() => visitorRoot('../escape'));
console.log('PASS visitor path validation; no model calls made');
