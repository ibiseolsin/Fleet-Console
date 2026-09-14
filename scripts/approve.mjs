#!/usr/bin/env node
/**
 * 승인 큐를 사람이 다루는 자리 (슬라이스 4).
 *
 *   node scripts/approve.mjs                  대기 중인 항목 (기본)
 *   node scripts/approve.mjs list --all       끝난 것까지 전부
 *   node scripts/approve.mjs show <id>        그 항목의 근거 전부
 *   node scripts/approve.mjs approve <id> [메모]
 *   node scripts/approve.mjs hold <id> [메모]
 *
 * **도구가 아니라 명령줄인 것이 요점이다.** 승인을 MCP 도구로 열면 에이전트가 제 요청을 스스로
 * 승인할 수 있어 게이트가 아니게 된다 (`PRD.md §4`·`§5` — 승인은 사람의 자리). 슬라이스 6이
 * 같은 함수 위에 화면(`/approvals`)을 올린다 — 이 파일은 그때까지의 임시 창구가 아니라
 * 화면이 없을 때도 남는 두 번째 창구다.
 */
import { decideApproval, listApprovals } from '../src/fleet/approvals.mjs';

const [cmd = 'list', id = null, ...rest] = process.argv.slice(2);
const note = rest.filter((a) => !a.startsWith('--')).join(' ');
const all = process.argv.includes('--all');

const target = (it) => it.project + '/' + (it.target?.slice != null ? it.target.slice + '번' : it.target?.workspace || '?');

function line(it) {
  console.log('  ' + it.id + '  ' + it.state.padEnd(9) + it.tool.replace('fleet_', '').padEnd(9) + target(it));
  console.log('    ' + it.reason);
  if (it.cost) console.log('    승인하면: ' + it.cost);
  if (it.note) console.log('    메모: ' + it.note);
}

if (cmd === 'list') {
  const items = listApprovals(all ? {} : { open: true });
  console.log(all ? '승인 큐 — 전부 ' + items.length + '건' : '승인 대기 — ' + items.length + '건');
  if (!items.length) console.log('  (없음)');
  for (const it of items) line(it);
  if (!all) console.log('\n승인: node scripts/approve.mjs approve <id>   ·   보류: ... hold <id>');
} else if (cmd === 'show') {
  const it = listApprovals({}).find((x) => x.id === id);
  if (!it) {
    console.error('그런 항목이 없다: ' + id);
    process.exit(1);
  }
  console.log(JSON.stringify(it, null, 2));
} else if (cmd === 'approve' || cmd === 'hold') {
  const r = decideApproval(id, cmd === 'approve' ? 'approve' : 'hold', note);
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
  console.log((cmd === 'approve' ? '승인' : '보류') + ' — ' + r.item.id + ' ' + target(r.item));
  if (cmd === 'approve') console.log('이제 같은 인자로 ' + r.item.tool + ' 를 다시 부르면 실행된다.');
} else {
  console.error('모르는 명령: ' + cmd + ' (list · show · approve · hold)');
  process.exit(1);
}
