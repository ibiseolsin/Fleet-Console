import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixture } from '../scripts/fixture.mjs';
import { buildRuns } from '../scripts/fixture-runs.mjs';
import { listRuns } from './agent/runs.mjs';
import { STATE_ROOT, statePath, withState } from './state.mjs';

export const validVisitor = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || '');
export const visitorRoot = (id) => {
  if (!validVisitor(id)) throw new Error('방문자 쿠키가 필요합니다. 페이지를 새로 열어 주세요.');
  return join(STATE_ROOT, 'visitors', id);
};

// A disk lock also covers multiple Next server processes. Fail closed on a stale lock.
export async function withVisitor(id, fn) {
  const root = visitorRoot(id);
  mkdirSync(root, { recursive: true });
  const lock = join(root, '.lock');
  const until = Date.now() + 30_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > until) throw new Error('데모 처리 중입니다. 잠시 뒤 다시 시도해 주세요.');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await withState(root, async () => {
      if (!existsSync(statePath('ready.json'))) {
        buildFixture();
        buildRuns();
        writeFileSync(statePath('ready.json'), JSON.stringify({ initializedAt: new Date().toISOString() }));
      }
      return fn();
    }, true);
  } finally { rmdirSync(lock); }
}

export function assertIdle() {
  if (listRuns().some((r) => r.state === 'running')) throw new Error('에이전트가 실행 중입니다. 끝난 뒤 다시 시도해 주세요.');
}

export function resetDemo() {
  assertIdle();
  buildFixture();
  buildRuns();
  // Keep approvals as evidence; their fixture stamp prevents reuse after reset.
  // Execution history and the global daily ledger must survive reset too.
  writeFileSync(statePath('ready.json'), JSON.stringify({ initializedAt: new Date().toISOString() }));
}

function setting(name, fallback, integer = false) {
  if (process.env[name] === undefined) return fallback;
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new Error(name + ' 설정이 잘못되었습니다.');
  return n;
}
export const demoLimits = () => ({ daily: setting('FLEET_DAILY_RUNS', 20, true), maxUsd: setting('FLEET_MAX_RUN_USD', 0.25) });
const ledgerFile = () => join(STATE_ROOT, 'daily-runs.json');
function ledger() {
  if (!existsSync(ledgerFile())) return { day: new Date().toISOString().slice(0, 10), used: 0 };
  const row = JSON.parse(readFileSync(ledgerFile(), 'utf8'));
  if (!Number.isInteger(row.used) || row.used < 0 || typeof row.day !== 'string') throw new Error('하루 사용량 기록을 읽을 수 없습니다.');
  return row.day === new Date().toISOString().slice(0, 10) ? row : { day: new Date().toISOString().slice(0, 10), used: 0 };
}
export function runAvailability(run = null) {
  const limits = demoLimits();
  const used = ledger().used;
  const spent = (run?.legs || []).reduce((n, l) => n + (l.costUsd || 0), 0);
  const maxUsd = Math.min(limits.maxUsd, run?.limits?.maxUsd ?? limits.maxUsd);
  const reason = used >= limits.daily ? `오늘 서버 전체 실행 상한 ${limits.daily}회에 닿았습니다 (UTC 자정에 초기화). 저장된 실행은 계속 열 수 있습니다.`
    : spent >= maxUsd ? `이 실행의 비용 상한 $${maxUsd}에 닿았습니다. 저장된 실행은 계속 열 수 있습니다.`
      : !process.env.OPENAI_API_KEY ? '서버 API 키가 아직 설정되지 않았습니다.' : '';
  return { allowed: !reason, reason, used, ...limits, remainingUsd: Math.max(0, maxUsd - spent) };
}
// Reserve synchronously before starting any paid leg, including resume. Cookie changes
// and resets cannot refund it. Separate processes contend on the same disk lock.
export function reserveRun(run = null) {
  mkdirSync(STATE_ROOT, { recursive: true });
  const lock = join(STATE_ROOT, '.quota-lock');
  try { mkdirSync(lock); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('다른 실행을 접수 중입니다. 잠시 뒤 다시 시도해 주세요.');
    throw e;
  }
  try {
    const a = runAvailability(run);
    if (!a.allowed) throw new Error(a.reason);
    const row = ledger();
    row.used++;
    const tmp = ledgerFile() + '.tmp';
    writeFileSync(tmp, JSON.stringify(row));
    renameSync(tmp, ledgerFile());
    return a;
  } finally { rmdirSync(lock); }
}
