#!/usr/bin/env node
/**
 * 에이전트 루프 — 화면 대신 명령줄에서 (슬라이스 7).
 *
 *   node scripts/agent.mjs                 # "이 플릿의 다음 할 일을 정해줘" 로 시작해 멈출 때까지 보여준다
 *   node scripts/agent.mjs "<지시>"        # 다른 지시로
 *   node scripts/agent.mjs resume <id>     # 승인·보류 뒤, 또는 끊긴 실행을 이어서 끝낸다
 *   node scripts/agent.mjs list            # 실행 목록
 *
 * 승인은 여기서도 안 한다 — `npm run approve` 또는 `/approvals`.
 */
import { resumeRun, startRun } from '../src/agent/loop.mjs';
import { listRuns } from '../src/agent/runs.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function show(run) {
  for (const s of run.steps) {
    if (s.type === 'text') console.log('\n모델: ' + s.text);
    else if (s.type === 'call') console.log('\n→ ' + s.tool + ' ' + JSON.stringify(s.args) + '\n  이유: ' + s.reason);
    else if (s.type === 'result') console.log('  ← ' + s.status + ' (' + s.ms + 'ms)');
    else if (s.type === 'deny') console.log('  ✗ 게이트 거부: ' + s.message);
    else console.log('\n■ ' + s.reason);
  }
  console.log('\n상태 ' + run.state + ' · 실행 ' + run.id);
  if (run.state === 'waiting' && run.approval) console.log('승인 큐: ' + run.approval.id + ' → 답한 뒤 `node scripts/agent.mjs resume ' + run.id + '`');
}

if (cmd === 'list') {
  for (const r of listRuns()) console.log(r.state.padEnd(11), r.createdAt.slice(0, 16), r.id, r.prompt, '—', r.stop?.reason || '');
} else if (cmd === 'resume') {
  const r = resumeRun(rest[0]);
  if (!r.ok) {
    console.error(r.error);
    process.exit(2);
  }
  show(await r.done);
} else {
  const { done } = startRun(cmd ? { prompt: [cmd, ...rest].join(' ') } : {});
  show(await done);
}
