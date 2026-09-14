#!/usr/bin/env node
/**
 * 슬라이스 3 완료 기준 — **진짜 MCP 클라이언트**로 서버를 띄우고 도구 셋을 확인한다.
 *
 *   node scripts/mcp-check.mjs
 *
 * 확인하는 것 넷:
 *  1) MCP 클라이언트의 도구 목록에 `fleet_status` · `fleet_slices` · `fleet_report` 셋이 뜬다.
 *  2) 픽스처를 대상으로 불러 슬라이스 목록이 돌아오고, **파견 불가 사유**가 서로 다른 세 갈래
 *     (선행 미완 · 상한 도달 · 결정 필요)로 각각 한 번 이상 나온다.
 *  3) `fleet_report` 가 회차를 날짜 범위로 내고, 없는 날짜에는 **오류가 아니라 빈 결과**를 낸다.
 *  4) 호출 전후 픽스처(`sandbox/`)와 실제 `~/.sp-sync/` 의 파일이 하나도 안 변한다.
 *
 * 서버는 **자식 프로세스**로 띄운다 — 같은 프로세스에서 핸들러만 부르면 전송 계층(스키마 등록·
 * 직렬화)이 확인되지 않아, 정작 클라이언트에 도구가 안 뜨는 것을 못 잡는다.
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { diffTrees, hashTree } from './hash-tree.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(REPO, 'src', 'mcp', 'server.mjs');
const WANT_TOOLS = ['fleet_status', 'fleet_slices', 'fleet_report'];
/** 완료 기준이 이름으로 못 박은 세 갈래 — 이 셋이 각각 한 번 이상 나와야 한다. */
const WANT_HOLDS = [
  ['deps-undone', '선행 미완'],
  ['cap-project', '상한 도달'],
  ['decision', '결정 필요'],
];

const fails = [];
const check = (ok, what, detail = '') => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + what + (detail ? ' — ' + detail : ''));
  if (!ok) fails.push(what);
};

const client = new Client({ name: 'fleet-console-check', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: REPO, stderr: 'inherit' });

// 격리 확인은 **연결 전에** 뜬다 — 서버를 띄우는 것 자체가 아무것도 안 바꿔야 한다.
const watched = [
  ['sandbox/', join(REPO, 'sandbox')],
  ['~/.sp-sync/', join(homedir(), '.sp-sync')],
];
const before = watched.map(([, dir]) => hashTree(dir));

await client.connect(transport);

try {
  // ---------- 1. 도구 목록 ----------
  console.log('\n1. 도구 목록');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const want of WANT_TOOLS) {
    const t = tools.find((x) => x.name === want);
    check(!!t, want, t ? t.title + ' · 입력 ' + Object.keys(t.inputSchema?.properties || {}).join(', ') : '목록에 없음');
    if (t) check(t.annotations?.readOnlyHint === true, want + ' 읽기 전용 표시', String(t.annotations?.readOnlyHint));
  }
  // 읽기 셋 말고 목록에 있는 것은 **쓰기 둘뿐**이어야 한다 (슬라이스 4). 여기서 수를 안 세면
  // 읽기 전용이 아닌 도구가 슬그머니 하나 더 붙어도 아무도 모른다 — 그쪽 확인은 `mcp-write-check.mjs`.
  const extra = names.filter((n) => !WANT_TOOLS.includes(n));
  check(extra.length === 2 && extra.every((n) => ['fleet_dispatch', 'fleet_land'].includes(n)), '읽기 셋 밖은 쓰기 둘뿐', extra.join(', ') || '(없음)');

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(name + ' 실패: ' + JSON.stringify(r.content));
    return r;
  };

  // ---------- 2. fleet_status ----------
  console.log('\n2. fleet_status');
  const status = await call('fleet_status');
  const sd = status.structuredContent;
  check(sd.projects.length === 3, '프로젝트 셋', sd.projects.map((p) => p.project).join(', '));
  const states = sd.projects.flatMap((p) => p.workspaces.map((w) => w.state));
  for (const want of ['ready', 'blocked', 'busy']) check(states.includes(want), '작업 공간 상태 ' + want, states.join(' '));
  const noReason = sd.projects.flatMap((p) => p.workspaces.filter((w) => !w.reason && !w.waiting).map((w) => w.name));
  check(!noReason.length, '작업 공간마다 사유가 실림', noReason.length ? '사유 없음: ' + noReason.join(', ') : '전부 있음');
  const waits = sd.projects.flatMap((p) => p.cards.filter((c) => c.wait));
  check(waits.length >= 1, '사람을 기다리는 카드가 잡힘', waits.map((c) => c.workspace + ': ' + c.wait).join(' · '));
  const one = await call('fleet_status', { project: 'atlas' });
  check(one.structuredContent.projects.length === 1, 'project 인자로 하나만', one.structuredContent.projects[0]?.project);

  // ---------- 3. fleet_slices — 파견 불가 사유 세 갈래 ----------
  console.log('\n3. fleet_slices — 파견 자격과 불가 사유');
  const slices = await call('fleet_slices');
  const gd = slices.structuredContent;
  const todo = gd.projects.flatMap((p) => p.slices.filter((s) => !s.done).map((s) => ({ project: p.project, ...s })));
  check(todo.length > 0, '슬라이스 목록이 돌아옴', todo.length + '개 미완');
  check(
    todo.every((s) => s.reason),
    '슬라이스마다 사유가 실림'
  );
  for (const [code, label] of WANT_HOLDS) {
    const hit = todo.filter((s) => s.hold === code);
    check(hit.length >= 1, '불가 사유 ' + label + ' (' + code + ')', hit.map((s) => s.project + '/' + s.number + '번 — ' + s.reason).join(' · ') || '안 나옴');
  }
  check(Object.keys(gd.holds).length >= 3, 'hold 갈래 집계', JSON.stringify(gd.holds));
  const only = await call('fleet_slices', { eligibleOnly: true });
  const elig = only.structuredContent.projects.flatMap((p) => p.slices);
  check(elig.length > 0 && elig.every((s) => s.eligible), 'eligibleOnly 로 자격 있는 것만', elig.map((s) => s.number + '번 ' + s.title).join(' · '));
  const dep = await call('fleet_slices', { hold: 'deps-undone' });
  const depRows = dep.structuredContent.projects.flatMap((p) => p.slices);
  check(depRows.length > 0 && depRows.every((s) => s.hold === 'deps-undone'), 'hold 로 거르기', depRows.map((s) => s.number + '번').join(' · '));

  // ---------- 4. fleet_report ----------
  console.log('\n4. fleet_report');
  const report = await call('fleet_report');
  const rd = report.structuredContent;
  check(rd.runs.length > 0, '회차가 돌아옴', rd.runs.map((r) => r.id).join(' · '));
  const withTables = rd.runs.filter((r) => Object.values(r.tables).some((t) => t.length));
  check(withTables.length > 0, '착륙/파견/막힘/결정 필요 표가 실림', Object.entries(withTables[0].tables).map(([k, v]) => k + ' ' + v.length).join(' · '));
  check(
    rd.runs.every((r) => Object.keys(r.counts).length),
    '회차마다 요약 수치',
    JSON.stringify(rd.runs[0].counts)
  );
  const day = rd.runs[0].date;
  const oneDay = await call('fleet_report', { from: day, to: day });
  check(oneDay.structuredContent.runs.every((r) => r.date === day), '날짜 범위로 거르기', day + ' → ' + oneDay.structuredContent.runs.length + '개');
  const none = await call('fleet_report', { from: '2000-01-01', to: '2000-01-02' });
  check(!none.isError && none.structuredContent.runs.length === 0, '없는 날짜면 빈 결과 (오류 아님)', none.content[0].text);

  // ---------- 5. 사람이 읽는 요약 ----------
  console.log('\n5. 사람이 읽는 요약');
  for (const r of [status, slices, report]) {
    const text = r.content?.[0]?.text || '';
    check(text.length > 40, '요약 문장이 실림', text.split('\n')[0]);
  }
} finally {
  await client.close();
}

// ---------- 6. 격리 ----------
console.log('\n6. 격리 — 호출 전후 해시');
const after = watched.map(([, dir]) => hashTree(dir));
watched.forEach(([label], i) => {
  const changed = diffTrees(before[i], after[i]);
  check(!changed.length, label + ' 파일 ' + before[i].size + '개 그대로', changed.length ? changed.slice(0, 5).join(' / ') : '변한 것 없음');
});

if (fails.length) {
  console.error('\n실패 ' + fails.length + '건: ' + fails.join(' · '));
  process.exit(1);
}
console.log('\n통과 — 도구 셋이 MCP 목록에 뜨고, 불가 사유 세 갈래가 나오며, 아무것도 바뀌지 않았다.');
