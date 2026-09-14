import { accessSync, constants, existsSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_ROOT } from '../src/state.mjs';

// Startup only, before serving requests, with exclusive ownership of the state disk.
// Container PIDs can be reused, so checking whether an old PID is alive is insufficient.
export function prepareState(root = STATE_ROOT) {
  accessSync(root, constants.R_OK | constants.W_OK);
  const removeLock = (path) => { if (existsSync(path)) rmdirSync(path); }; // empty locks only
  removeLock(join(root, '.quota-lock'));
  const visitors = join(root, 'visitors');
  let interrupted = 0;
  if (existsSync(visitors)) {
    for (const dir of readdirSync(visitors, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const visitor = join(visitors, dir.name);
      removeLock(join(visitor, '.lock'));
      const runs = join(visitor, 'agent-runs');
      if (!existsSync(runs)) continue;
      for (const name of readdirSync(runs).filter((n) => n.endsWith('.json'))) {
        const file = join(runs, name);
        const run = JSON.parse(readFileSync(file, 'utf8'));
        if (run.state !== 'running') continue;
        run.state = 'interrupted';
        run.pid = null;
        run.stop = { kind: 'interrupted', reason: '서버가 재시작되었습니다. 승인과 실행 기록을 확인하고 이어서 실행하세요.' };
        run.updatedAt = new Date().toISOString();
        writeFileSync(file + '.tmp', JSON.stringify(run, null, 2) + '\n');
        renameSync(file + '.tmp', file);
        interrupted++;
      }
    }
  }
  console.log(JSON.stringify({ event: 'state-ready', interrupted }));
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) prepareState();
