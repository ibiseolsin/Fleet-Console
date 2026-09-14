#!/usr/bin/env node
/**
 * 슬라이스 2 완료 기준 — 픽스처로 판정 함수 셋을 부르고 결과를 낸다.
 *
 *   node scripts/fixture-check.mjs
 *
 * 확인하는 것 둘:
 *  1) `landCheck` · `resumePlan` · `dispatchPlan` 이 픽스처에서 돌고, 그 결과에
 *     **착륙 자격 있음 · 막힘 · 파견 보류** 가 각각 한 번 이상 나온다.
 *  2) 실행 전후 실제 `~/.sp-sync/` 의 파일이 하나도 안 변한다 (해시 대조).
 *
 * 판정에 필요한 바깥 값은 전부 픽스처에서 주입한다 — 실제 Orca 도 실제 플릿도 부르지 않는다.
 * 판정 시각(`now`)을 한 번 정해 세 함수에 같이 넘긴다: 상대 시각으로 적힌 픽스처가 호출마다
 * 조금씩 다른 답을 내면 안 된다.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { landCheck, dispatchPlan } from '../sp-sync/lib/fleet.mjs';
import { resumePlan } from '../sp-sync/lib/resume.mjs';
import { fixtureSlices, loadFixture } from './fixture.mjs';
import { diffTrees, hashTree } from './hash-tree.mjs';

// ---------- 격리 확인 ----------
// 해시는 `hash-tree.mjs` 하나가 낸다 (슬라이스 4에서 합쳤다) — 같은 일을 하는 사본이 둘이면
// "안 변했다" 의 잣대가 스크립트마다 달라진다.
const stateHashes = () => hashTree(join(homedir(), '.sp-sync'));
const diffHashes = diffTrees;

// ---------- 판정 ----------
const now = Date.now();
const fx = loadFixture(now);
const before = stateHashes();

const landOpts = { baseRef: 'origin/main', quietMs: 120000, idleMs: 5000, now };
const rows = { land: [], resume: [], dispatch: [] };

for (const project of fx.projects) {
  const r = fixtureSlices(project, fx);

  for (const w of r.workspaces) rows.land.push({ project, ...landCheck(w, landOpts) });

  rows.resume.push(
    ...resumePlan(fx.resume[project] || [], {
      now,
      workspaces: r.workspaces,
      slices: r.slices,
      cards: fx.cards,
      limits: null, // 한도를 모르면 막지 않는다 — 픽스처는 항목의 `resetsAt` 으로만 가른다
      max: 2, // fleetResumeMax 기본값
    }).map((x) => ({ project, ...x }))
  );

  rows.dispatch.push(
    ...dispatchPlan({
      slices: r.slices,
      allSlices: r.allSlices,
      workspaces: r.workspaces,
      max: fx.max(project),
      block: null,
      limitHold: null,
      project,
    }).map((d) => ({ project, ...d }))
  );
}

const after = stateHashes();
const drift = diffHashes(before, after);

// ---------- 출력 ----------
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length));
const line = (a, b, c) => console.log('  ' + pad(a, 18) + pad(b, 12) + c);

console.log('픽스처: ' + fx.root);
console.log('판정 시각: ' + new Date(now).toISOString() + '\n');

console.log('landCheck — 착륙 자격');
for (const r of rows.land) {
  const verdict = r.ready ? '자격 있음' : r.blocked ? '막힘' : '아직';
  line(r.project + '/' + r.name, verdict, r.reason);
}

console.log('\nresumePlan — 재개 판정');
for (const r of rows.resume) line(r.project + '/' + r.name, r.action, r.reason);

console.log('\ndispatchPlan — 파견 자격');
for (const d of rows.dispatch) {
  const n = d.slice.number ?? '?';
  line(d.project + '/' + n + '번', d.eligible ? '파견' : '보류', d.slice.title + ' — ' + d.reason);
}

// ---------- 완료 기준 ----------
const landReady = rows.land.filter((r) => r.ready);
const landBlocked = rows.land.filter((r) => r.blocked);
const dispatchHeld = rows.dispatch.filter((d) => !d.eligible);
const resumeActions = new Set(rows.resume.map((r) => r.action));

const checks = [
  ['착륙 자격 있음', landReady.length, landReady.map((r) => r.project + '/' + r.name)],
  ['막힘', landBlocked.length, landBlocked.map((r) => r.project + '/' + r.name)],
  ['파견 보류', dispatchHeld.length, [...new Set(dispatchHeld.map((d) => d.reason.split(' — ')[0].split(' (')[0]))]],
  ['재개 갈래', resumeActions.size, [...resumeActions]],
];

console.log('\n갈래 확인');
for (const [name, n, what] of checks) line(name, n + '건', what.join(' · '));

const failed = checks.filter(([, n]) => n < 1).map(([name]) => name);
console.log('\n격리 — ~/.sp-sync/ 파일 ' + before.size + '개');
if (drift.length) {
  console.log('  변한 것 ' + drift.length + '건:');
  for (const d of drift) console.log('    ' + d);
} else {
  console.log('  변한 것 없음');
}

if (failed.length) {
  console.error('\n실패 — 안 나온 갈래: ' + failed.join(', '));
  process.exit(1);
}
if (drift.length) {
  console.error('\n실패 — ~/.sp-sync/ 가 변했다 (위 목록).');
  process.exit(1);
}
console.log('\n통과 — 세 갈래가 모두 나왔고 ~/.sp-sync/ 는 변하지 않았다.');
