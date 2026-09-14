#!/usr/bin/env node
/**
 * 슬라이스 7 완료 기준 — 앱 안의 에이전트 루프를 **실제 모델로** 끝까지 돌려 확인한다.
 *
 *   node scripts/agent-check.mjs            # 전부 (모델을 네 번 부른다 — 몇 센트)
 *   node scripts/agent-check.mjs --fake     # 같은 검사를 가짜 모델로 — 네트워크·키 없이 (슬라이스 14)
 *   node scripts/agent-check.mjs --resume <id>   # 내부용: 새 프로세스에서 이어서 끝내기
 *   node scripts/agent-check.mjs --orphan        # 내부용: 실행 하나를 시작해 두고 죽임 당한다
 *
 * 확인하는 것 (`PLAN.md` 슬라이스 7):
 *  1) "이 플릿의 다음 할 일을 정해줘" 한 번에 읽기 도구를 **2종 이상 스스로** 부른다.
 *  2) 쓰기 도구 앞에서 **승인 대기로 멈춘다** — 대기 항목만 생기고 실제 파견·착륙은 없다.
 *  3) 승인 뒤 **다른 프로세스에서** 이어서 끝낸다(실행됨). 서버를 껐다 켠 것과 같은 조건이다.
 *  4) 모든 도구 호출에 **이유**가 남는다.
 *  5) 반복 상한 · 시간 상한에 닿으면 **사유와 함께** 멈춘다.
 *  6) 돌던 프로세스를 죽이면 `interrupted` 로 보이고, 그 실행을 이어서 끝낼 수 있다.
 *  7) 격리 — 전후로 `~/.sp-sync/` 의 락·트리거·회차 결과가 안 변한다.
 *
 * `OPENAI_API_KEY` 가 있어야 돈다(`npm run agent:check` 는 저장소의 `.env` 를 읽는다). `--fake` 는
 * `FLEET_AGENT_FAKE=1` 을 켜 자식 프로세스까지 가짜 모델을 쓰게 한다. 모델의 선택은 매번 같지 않으므로
 * "무엇을 골랐나" 가 아니라 "관찰 → 쓰기 앞에서 멈춤 → 승인 뒤 실행" 의 **모양**을 확인한다.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumeRun, startRun } from '../src/agent/loop.mjs';
import { readRun, writeRun } from '../src/agent/runs.mjs';
import { QUEUE_FILE, decideApproval, listApprovals } from '../src/fleet/approvals.mjs';
import { buildFixture } from './fixture.mjs';
import { diffTrees, hashTree } from './hash-tree.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const WATCHED = [/^fleet-run\.lock(\/|$)/, /^fleet-trigger\.json$/, /^fleet-cycle-result\..*\.json$/, /^fleet-trigger\.lock(\/|$)/];
const READ_TOOLS = ['fleet_status', 'fleet_slices', 'fleet_report'];
const WRITE_TOOLS = ['fleet_dispatch', 'fleet_land'];

if (process.argv.includes('--fake')) process.env.FLEET_AGENT_FAKE = '1';
const argv = process.argv.slice(2).filter((a) => a !== '--fake');

// ---------- 내부 단계 (새 프로세스에서 돈다) ----------
if (argv[0] === '--resume') {
  const r = resumeRun(argv[1]);
  if (!r.ok) {
    console.error(r.error);
    process.exit(2);
  }
  const run = await r.done;
  console.log('[resume 프로세스 ' + process.pid + '] 상태 ' + run.state + ' — ' + run.stop.reason);
  process.exit(run.state === 'done' ? 0 : 1);
}
if (argv[0] === '--orphan') {
  const { run, done } = startRun({ limits: { maxTurns: 12, maxMs: 120_000 } });
  console.log(run.id);
  await done;
  process.exit(0);
}

// ---------- 본 검사 ----------
const fails = [];
const check = (ok, what, detail = '') => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + what + (detail ? ' — ' + detail : ''));
  if (!ok) fails.push(what);
};
const calls = (run, names) => run.steps.filter((s) => s.type === 'call' && names.includes(s.tool));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

buildFixture();
rmSync(QUEUE_FILE, { force: true });
const SP_DIR = join(homedir(), '.sp-sync');
const before = hashTree(SP_DIR);

// 1·2·4 — 관찰 → 쓰기 앞에서 멈춤
console.log('\n1. "이 플릿의 다음 할 일을 정해줘" — 관찰하고 쓰기 도구 앞에서 멈춘다');
const t0 = Date.now();
const first = startRun();
let run = await first.done;
const reads = new Set(calls(run, READ_TOOLS).map((s) => s.tool));
check(reads.size >= 2, '읽기 도구 2종 이상을 스스로 불렀다', [...reads].join(', '));
const writes = calls(run, WRITE_TOOLS);
check(writes.length >= 1, '쓰기 도구를 불렀다', writes.map((s) => s.tool + ' ' + JSON.stringify(s.args)).join(' · '));
check(run.state === 'waiting', '승인 대기로 멈췄다', run.state + ' — ' + run.stop?.reason);
const pendingResults = run.steps.filter((s) => s.type === 'result' && WRITE_TOOLS.includes(s.tool));
check(pendingResults.length >= 1 && pendingResults.every((s) => s.status === 'pending' || s.status === 'rejected'), '쓰기 결과는 pending(또는 rejected)뿐 — 실제로 실행된 것 없음', pendingResults.map((s) => s.tool + ':' + s.status).join(' · '));
const open = listApprovals({ open: true });
check(open.length === 1 && run.approval?.id === open[0].id, '큐에 대기 항목 하나가 생겼고 실행이 그것을 가리킨다', open.map((it) => it.id + ' ' + it.tool).join(' · '));
const noReason = run.steps.filter((s) => s.type === 'call' && !(s.reason || '').trim());
check(noReason.length === 0, '모든 도구 호출에 이유가 있다', run.steps.filter((s) => s.type === 'call').map((s) => s.tool + ': ' + s.reason).join(' / '));
check(run.legs[0].costUsd >= 0 && run.legs[0].durationMs > 0, '구간 계측', '턴 ' + run.legs[0].turns + ' · ' + run.legs[0].durationMs + 'ms · $' + run.legs[0].costUsd.toFixed(4));
console.log('  (첫 구간 ' + Math.round((Date.now() - t0) / 1000) + '초)');

// 3 — 승인 뒤 **다른 프로세스**가 이어서 끝낸다
console.log('\n2. 사람이 승인 → 새 프로세스가 같은 실행을 이어서 끝낸다');
const beforeResume = resumeRun(run.id);
check(!beforeResume.ok, '승인 전에는 이어갈 수 없다', beforeResume.error);
const dec = decideApproval(run.approval.id, 'approve', '확인함');
check(dec.ok, '승인했다', dec.ok ? dec.item.id : dec.error);
const child = spawn(process.execPath, [SELF, '--resume', run.id], { cwd: REPO, stdio: 'inherit' });
const code = await new Promise((r) => child.on('exit', r));
run = readRun(run.id);
check(code === 0 && run.state === 'done', '다른 프로세스에서 done 으로 끝났다', run.state + ' — ' + run.stop?.reason);
const executed = run.steps.filter((s) => s.type === 'result' && WRITE_TOOLS.includes(s.tool) && s.leg === 2);
check(executed.some((s) => s.status === 'executed'), '승인된 호출이 실제로 실행됐다', executed.map((s) => s.tool + ':' + s.status).join(' · '));
const item = listApprovals({}).find((it) => it.id === dec.item.id);
check(item?.state === 'done', '승인 항목이 done 이다', item?.state);
check(run.legs.length === 2 && run.legs[1].kind === 'resume', '구간 둘(start · resume)이 한 기록에 있다');

// 5 — 상한
console.log('\n3. 상한에 닿으면 사유와 함께 멈춘다');
const capped = await startRun({ limits: { maxTurns: 1, maxMs: 120_000 } }).done;
check(capped.state === 'stopped' && capped.stop.kind === 'max-turns', '반복 상한 1턴', capped.state + ' — ' + capped.stop?.reason);
const timed = await startRun({ limits: { maxTurns: 12, maxMs: 1500 } }).done;
check(timed.state === 'stopped' && timed.stop.kind === 'timeout', '시간 상한 1.5초', timed.state + ' — ' + timed.stop?.reason);

// 6 — 돌던 프로세스를 죽인다 → interrupted → 이어서 끝냄
console.log('\n4. 돌던 프로세스를 죽인 뒤 이어서 끝낸다');
rmSync(QUEUE_FILE, { force: true });
buildFixture();
const orphan = spawn(process.execPath, [SELF, '--orphan'], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] });
const orphanId = await new Promise((r) => orphan.stdout.once('data', (d) => r(String(d).trim())));
// 첫 도구 호출이 기록될 때까지 기다렸다가 죽인다 — 관찰 도중에 끊긴 실행이다.
let seen = null;
for (let i = 0; i < 120 && !seen; i++) {
  await sleep(500);
  const r = readRun(orphanId);
  if (r?.steps.some((s) => s.type === 'call')) seen = r;
}
check(!!seen, '고아 실행이 도구를 부르기 시작했다', seen ? seen.steps.filter((s) => s.type === 'call').map((s) => s.tool).join(', ') : '120초 안에 호출 없음');
orphan.kill();
await new Promise((r) => orphan.on('exit', r));
const dead = readRun(orphanId);
check(dead.state === 'interrupted', '죽은 프로세스의 실행이 interrupted 로 보인다', dead.state + ' — ' + dead.stop?.reason);
const revived = resumeRun(orphanId);
check(revived.ok, '이어서 돌릴 수 있다', revived.ok ? '' : revived.error);
const after = revived.ok ? await revived.done : dead;
check(['waiting', 'done'].includes(after.state), '이어서 돌린 결과가 대기 또는 완료다', after.state + ' — ' + after.stop?.reason);

// 마무리 — 가짜 pid 로도 판정이 서는지, 격리
const fake = writeRun({ ...capped, id: '00000000-0000-4000-8000-00000000dead', state: 'running', pid: 999_999_999, stop: null });
check(readRun(fake.id).state === 'interrupted', '없는 pid 의 running 은 interrupted 로 읽힌다');
rmSync(join(REPO, 'sandbox', 'agent-runs', fake.id + '.json'), { force: true });

console.log('\n5. 격리');
const drift = diffTrees(before, hashTree(SP_DIR)).filter((p) => WATCHED.some((re) => re.test(p)));
check(drift.length === 0, 'fleet-run.lock · fleet-trigger.json · fleet-cycle-result.*.json 이 안 변했다', drift.length ? drift.join(', ') : '변한 것 없음');

const cost = [run, capped, timed, after].reduce((a, r) => a + r.legs.reduce((b, l) => b + (l.costUsd || 0), 0), 0);
console.log('\n모델 호출 비용 합계 $' + cost.toFixed(4) + ' · 실행 기록 sandbox/agent-runs/' + run.id + '.json');
if (fails.length) {
  console.log('\n실패 ' + fails.length + '건: ' + fails.join(' / '));
  process.exit(1);
}
console.log('통과 — 관찰 → 쓰기 앞에서 멈춤 → 승인 뒤 다른 프로세스가 이어서 끝냄. 상한·중단·격리도 확인.');
