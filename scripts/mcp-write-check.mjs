#!/usr/bin/env node
/**
 * 슬라이스 4 완료 기준 — **진짜 MCP 클라이언트**로 쓰기 도구 둘과 승인 게이트를 확인한다.
 *
 *   node scripts/mcp-write-check.mjs
 *
 * 확인하는 것 넷 (`PLAN.md` 슬라이스 4):
 *  1) 승인 없이 부르면 **대기 항목만** 생기고 작업 공간은 생기지 않는다.
 *  2) 승인 뒤 재호출하면 픽스처에 **실제로** 반영된다 (파견: 폴더와 창 · 착륙: main 의 `[x]`).
 *  3) 자격 미달 슬라이스·작업 공간은 **사유와 함께 거부**되고 대기 항목도 안 생긴다.
 *  4) **격리** — 호출 전후로 `~/.sp-sync/fleet-run.lock` · `fleet-trigger.json` ·
 *     `fleet-cycle-result.*.json` 이 하나도 안 변한다.
 *
 * 순서가 있다: 픽스처를 새로 만들고 시작하며, 뒤 확인이 앞 확인의 결과 위에 선다
 * (착륙이 atlas 2번을 머지해야 4번의 선행이 풀린다). 그래서 이 스크립트는 회차 하나를
 * 통째로 재생하는 것에 가깝다.
 *
 * 승인·보류는 클라이언트가 아니라 **이 프로세스가 직접** 한다 — 승인은 도구가 아니라 사람의
 * 자리라서다 (`src/fleet/approvals.mjs` 머리말). 큐가 파일이라 서버 쪽에서 그대로 읽힌다.
 */
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { QUEUE_FILE, decideApproval, listApprovals } from '../src/fleet/approvals.mjs';
import { planSliceDone } from '../src/fleet/execute.mjs';
import { buildFixture, workspacePath } from './fixture.mjs';
import { diffTrees, hashTree } from './hash-tree.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(REPO, 'src', 'mcp', 'server.mjs');
const WRITE_TOOLS = ['fleet_dispatch', 'fleet_land'];

/**
 * 완료 기준이 이름으로 못 박은 셋. `fleet-run.lock` 은 폴더고 회차 결과는 프로젝트마다
 * 파일이 따로라(`fleet-cycle-result.<이름>.json`) 앞자리로 고른다.
 */
const WATCHED = [/^fleet-run\.lock(\/|$)/, /^fleet-trigger\.json$/, /^fleet-cycle-result\..*\.json$/, /^fleet-trigger\.lock(\/|$)/];

const fails = [];
const check = (ok, what, detail = '') => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + what + (detail ? ' — ' + detail : ''));
  if (!ok) fails.push(what);
};

// ---------- 시작 상태 ----------
// 픽스처를 처음부터 다시 만든다. 반쯤 파견된 픽스처에서 시작하면 자격 판정이 달라져 아래
// 순서가 통째로 어긋난다. 승인 큐도 비운다 — 지난 실행의 항목이 지문으로 걸려 되살아난다.
buildFixture();
rmSync(QUEUE_FILE, { force: true });
const SP_DIR = join(homedir(), '.sp-sync');
const before = hashTree(SP_DIR);

const client = new Client({ name: 'fleet-console-write-check', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: REPO, stderr: 'inherit' });
await client.connect(transport);

/** 도구 하나를 부르고 구조화된 결과만 돌려준다. 오류는 그대로 던진다 — 조용히 삼키면 확인이 아니다. */
const callTool = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;

const queueSize = () => listApprovals({}).length;
const openIds = () => listApprovals({ open: true }).map((it) => it.id);

try {
  // ---------- 1. 도구 목록 ----------
  console.log('\n1. 도구 목록 — 읽기 셋에 쓰기 둘이 더해졌다');
  const { tools } = await client.listTools();
  check(tools.length === 5, '도구 다섯', tools.map((t) => t.name).join(', '));
  for (const name of WRITE_TOOLS) {
    const t = tools.find((x) => x.name === name);
    check(!!t, name, t ? t.title : '목록에 없음');
    if (!t) continue;
    // 읽기 전용이 아니라는 것과 되돌리기 어렵다는 것이 **스키마에** 있어야 한다.
    check(t.annotations?.readOnlyHint === false, name + ' 읽기 전용 아님', String(t.annotations?.readOnlyHint));
    check(t.annotations?.destructiveHint === true, name + ' 되돌리기 어려움 표시', String(t.annotations?.destructiveHint));
  }

  // ---------- 2. 승인 없이 부르면 대기 항목만 ----------
  console.log('\n2. 승인 없이 파견 — 대기 항목만 생기고 작업 공간은 안 생긴다');
  const ws = workspacePath('cobalt', 2);
  const p1 = await callTool('fleet_dispatch', { project: 'cobalt', slice: 2 });
  check(p1.status === 'pending', '상태 pending', p1.status + ' — ' + p1.reason);
  check(!!p1.approval?.id && p1.approval.state === 'pending', '대기 항목이 생겼다', p1.approval?.id + ' / ' + p1.approval?.state);
  check(!!p1.approval?.cost, '무엇이 발생하는지 실렸다', p1.approval?.cost);
  check(!!p1.approval?.evidence?.명령, '무엇을 어느 에이전트로 띄우는지 실렸다', p1.approval?.evidence?.에이전트);
  check(!existsSync(ws), '작업 공간이 안 생겼다', ws);
  const st1 = await callTool('fleet_status', { project: 'cobalt' });
  check(!st1.projects[0].workspaces.some((w) => w.name === 'slice2'), '현황에도 안 뜬다', st1.projects[0].workspaces.map((w) => w.name).join(', ') || '(없음)');

  // 같은 호출을 또 해도 항목이 쌓이지 않는다 — 에이전트는 "아직 안 눌렸나" 를 이렇게 확인한다.
  const p2 = await callTool('fleet_dispatch', { project: 'cobalt', slice: 2 });
  check(p2.approval?.id === p1.approval.id && p2.created === false, '다시 불러도 같은 항목', p2.approval?.id);
  check(queueSize() === 1, '큐에 한 건', String(queueSize()));

  // ---------- 3. 자격 미달은 사유와 함께 거부 ----------
  console.log('\n3. 자격 미달 — 사유와 함께 거부되고 대기 항목도 안 생긴다');
  const size3 = queueSize();
  const rejects = [
    ['fleet_dispatch', { project: 'atlas', slice: 4 }, 'deps-undone', '선행 미완'],
    ['fleet_dispatch', { project: 'atlas', slice: 5 }, 'decision', '결정 필요'],
    ['fleet_dispatch', { project: 'beacon', slice: 5 }, 'cap-project', '상한 도달'],
  ];
  for (const [tool, args, hold, what] of rejects) {
    const r = await callTool(tool, args);
    check(r.status === 'rejected' && r.hold === hold, what + ' 거부 [' + hold + ']', r.reason);
    check(r.approval === null, '  대기 항목을 안 만들었다', String(r.approval));
  }
  // 착륙 쪽도 같은 잣대다 — 미체크로 막힌 작업 공간은 여기서 걸린다.
  const rl = await callTool('fleet_land', { project: 'beacon', workspace: 'slice2' });
  check(rl.status === 'rejected', '막힌 작업 공간 착륙 거부', rl.reason);
  check(queueSize() === size3, '큐가 안 늘었다', size3 + ' → ' + queueSize());

  // ---------- 4. 승인 뒤 재호출 → 실제로 반영 ----------
  console.log('\n4. 승인 뒤 재호출 — 픽스처에 실제로 반영된다 (파견)');
  const d1 = decideApproval(p1.approval.id, 'approve', '샌드박스 확인');
  check(d1.ok && d1.item.state === 'approved', '사람이 승인했다', d1.item?.state);
  const e1 = await callTool('fleet_dispatch', { project: 'cobalt', slice: 2 });
  check(e1.status === 'executed', '상태 executed', e1.status + ' — ' + e1.reason);
  check(existsSync(ws), '작업 공간이 생겼다', e1.result?.path);
  check(e1.result?.outcome === 'started', '시작됨', e1.result?.outcome + ' / ' + e1.result?.agent);
  const st2 = await callTool('fleet_status', { project: 'cobalt' });
  const w2 = st2.projects[0].workspaces.find((w) => w.name === 'slice2');
  check(!!w2 && w2.state === 'busy', '현황에 도는 중으로 뜬다', w2 ? w2.state + ' — ' + w2.reason : '없음');
  check(listApprovals({}).find((it) => it.id === p1.approval.id).state === 'done', '승인 항목이 done 으로 닫혔다');

  // ---------- 5. 승인 뒤 재호출 → 실제로 반영 (착륙) ----------
  console.log('\n5. 승인 뒤 재호출 — 픽스처에 실제로 반영된다 (착륙)');
  const atlas2 = workspacePath('atlas', 2);
  check(planSliceDone('atlas', 2) === false, '착륙 전 본체 계획서에 2번이 미체크');
  const lp = await callTool('fleet_land', { project: 'atlas', workspace: 'slice2' });
  check(lp.status === 'pending', '착륙도 먼저 대기', lp.status + ' — ' + lp.reason);
  check((lp.approval?.evidence?.커밋 || []).length > 0, '변경 요약이 실렸다', (lp.approval?.evidence?.커밋 || []).join(' / '));
  check(existsSync(atlas2), '  승인 전에는 작업 공간이 그대로다');
  decideApproval(lp.approval.id, 'approve', '샌드박스 확인');
  const le = await callTool('fleet_land', { project: 'atlas', workspace: 'slice2' });
  check(le.status === 'executed', '상태 executed', le.status + ' — ' + le.reason);
  const steps = (le.result?.steps || []).map((s) => s.step.split(' ')[0]);
  check(steps.includes('check') && steps.includes('pr') && steps.includes('final'), '검사·PR·최종 게이트를 다 지났다', steps.join(' → '));
  check(planSliceDone('atlas', 2) === true, '본체 계획서의 2번이 [x] 가 됐다');
  check(!existsSync(atlas2), '작업 공간이 사라졌다', atlas2);

  // ---------- 6. 보류한 항목은 다시 불러도 안 풀린다 ----------
  console.log('\n6. 보류 — 그 항목만 멈추고 다시 불러도 안 풀린다');
  const h1 = await callTool('fleet_dispatch', { project: 'beacon', slice: 4 });
  check(h1.status === 'pending', 'beacon 4번 대기', h1.status);
  decideApproval(h1.approval.id, 'hold', '지금은 말고');
  const h2 = await callTool('fleet_dispatch', { project: 'beacon', slice: 4 });
  check(h2.status === 'rejected', '보류된 항목은 거부', h2.reason);
  check(!existsSync(workspacePath('beacon', 4)), '  작업 공간은 그대로 없다');

  // ---------- 7. 승인은 그 인자에만 붙는다 ----------
  console.log('\n7. 승인 하나로 다른 대상을 실행할 수 없다');
  // 착륙이 2번을 머지했으므로 atlas 4번의 선행이 풀렸다 — 자격은 있는데 승인이 남의 것이다.
  const a4 = await callTool('fleet_dispatch', { project: 'atlas', slice: 4 });
  check(a4.status === 'pending', 'atlas 4번은 이제 자격이 있다', a4.reason);
  decideApproval(a4.approval.id, 'approve', '샌드박스 확인');
  const swap = await callTool('fleet_dispatch', { project: 'beacon', slice: 4, approvalId: a4.approval.id });
  check(swap.status === 'rejected', '남의 승인으로는 거부', swap.reason);
  check(!existsSync(workspacePath('beacon', 4)), '  작업 공간은 그대로 없다');
  check(openIds().length >= 1, '보류 항목은 큐에 남아 있다', openIds().join(', '));
} finally {
  await client.close();
}

// ---------- 8. 격리 ----------
console.log('\n8. 격리 — 실제 플릿의 락·방아쇠·회차 결과');
const drift = diffTrees(before, hashTree(SP_DIR));
const watched = drift.filter((d) => WATCHED.some((re) => re.test(d.replace(/^(생김|사라짐|바뀜) /, ''))));
console.log('  ~/.sp-sync/ 파일 ' + before.size + '개 · 그 사이 변한 것 ' + drift.length + '건 (도는 플릿이 쓴 것이 섞일 수 있다)');
for (const d of drift.slice(0, 10)) console.log('    ' + d);
if (drift.length > 10) console.log('    … 그 밖 ' + (drift.length - 10) + '건');
check(watched.length === 0, 'fleet-run.lock · fleet-trigger.json · fleet-cycle-result.*.json 이 안 변했다', watched.join(', ') || '변한 것 없음');

console.log('');
if (fails.length) {
  console.error('실패 ' + fails.length + '건: ' + fails.join(', '));
  process.exit(1);
}
console.log('통과 — 승인 없이는 아무것도 생기지 않고, 승인 뒤에는 실제로 반영되며, 실제 플릿은 안 건드렸다.');
