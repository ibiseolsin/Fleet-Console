import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withVisitor, visitorRoot } from '../src/demo.mjs';
import { statePath, STATE_ROOT } from '../src/state.mjs';
import { readQueue, decideApproval } from '../src/fleet/approvals.mjs';
import { readRun, writeRun } from '../src/agent/runs.mjs';
import { TOOLS } from '../src/fleet/tools.mjs';
import { hashTree } from './hash-tree.mjs';

// Use a disposable disk/root. Run seed, restart the container, then verify.
const visitor = '11111111-1111-4111-8111-111111111111';
const waiting = '22222222-2222-4222-8222-222222222222';
const running = '33333333-3333-4333-8333-333333333333';
const proof = join(STATE_ROOT, 'restart-check.json');
const call = async (name, args) => (await TOOLS.find((t) => t.name === name).run(args)).data;
if (process.argv[2] === 'seed') {
  assert.ok(!existsSync(proof), 'use a fresh disposable state root');
  await withVisitor(visitor, async () => {
    const request = await call('fleet_land', { project: 'atlas', workspace: 'slice2' });
    assert.equal(request.status, 'pending');
    const saved = { id: waiting, state: 'waiting', createdAt: new Date().toISOString(), legs: [], limits: { maxUsd: 0.25 } };
    writeRun(saved);
    writeRun({ ...saved, id: running, state: 'running', pid: 1 });
    const evidence = {
      approval: request.approval.id,
      fixture: [...hashTree(statePath('fleet'))],
      queue: readFileSync(statePath('approvals.json'), 'utf8'),
      waiting: readFileSync(statePath('agent-runs', waiting + '.json'), 'utf8'),
    };
    writeFileSync(proof, JSON.stringify(evidence));
  });
  writeFileSync(join(STATE_ROOT, 'daily-runs.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), used: 7 }));
  mkdirSync(join(visitorRoot(visitor), '.lock'));
  mkdirSync(join(STATE_ROOT, '.quota-lock'));
  console.log('seed: pending approval, waiting/running histories, quota and stale locks saved');
} else if (process.argv[2] === 'verify') {
  const before = JSON.parse(readFileSync(proof, 'utf8'));
  assert.ok(!existsSync(join(visitorRoot(visitor), '.lock')));
  assert.ok(!existsSync(join(STATE_ROOT, '.quota-lock')));
  assert.equal(JSON.parse(readFileSync(join(STATE_ROOT, 'daily-runs.json'))).used, 7);
  await withVisitor(visitor, async () => {
    assert.deepEqual([...hashTree(statePath('fleet'))], before.fixture);
    assert.equal(readFileSync(statePath('approvals.json'), 'utf8'), before.queue);
    assert.equal(readFileSync(statePath('agent-runs', waiting + '.json'), 'utf8'), before.waiting);
    assert.equal(readRun(running).state, 'interrupted');
    assert.equal(readRun(running).pid, null);
    assert.equal(readQueue().items.find((r) => r.id === before.approval).state, 'pending');
    assert.equal(decideApproval(before.approval, 'approve').ok, true);
    assert.equal((await call('fleet_land', { project: 'atlas', workspace: 'slice2', approvalId: before.approval })).status, 'executed');
    assert.ok(!existsSync(statePath('fleet', 'orca', 'workspaces', 'atlas', 'slice2')));
  });
  console.log('PASS: restart preserves fixture/approval/history/quota; recovers locks/PID reuse; saved approval lands');
} else {
  throw new Error('usage: node scripts/container-check.mjs seed|verify (disposable FLEET_STATE_ROOT)');
}
