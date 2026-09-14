import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { REPO } from '../src/state.mjs';

if (process.platform !== 'linux') throw new Error('Run this gate inside the Linux deployment image.');
const root = mkdtempSync(join(tmpdir(), 'fleet-benchmark-'));
const elapsed = {};
for (const script of ['fixture', 'fixture-runs']) {
  const start = performance.now();
  execFileSync(process.execPath, [join(REPO, 'scripts', script + '.mjs')], {
    cwd: REPO, env: { ...process.env, FLEET_STATE_ROOT: root }, stdio: 'pipe',
  });
  elapsed[script] = Math.round(performance.now() - start);
}
const totalMs = Object.values(elapsed).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ platform: process.platform, milliseconds: elapsed, totalMs, visitorIsolation: totalMs <= 3000 }, null, 2));
