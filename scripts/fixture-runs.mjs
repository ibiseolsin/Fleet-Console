#!/usr/bin/env node
import { statePath } from '../src/state.mjs';
/**
 * 샌드박스 회차 기록 만들기 (슬라이스 3) — `fleet_report` 가 읽을 기록을 픽스처에서 낸다.
 *
 *   node scripts/fixture-runs.mjs        # sandbox/runs/YYYY-MM-DD-cycle.md 를 다시 만든다
 *
 * **형식을 손으로 짓지 않는다.** sp-sync 의 `renderCycleReport` 를 그대로 불러 쓴다 — 파서를
 * 내가 지은 형식으로만 확인하면, 진짜 기록을 들여오는 슬라이스 5에서 처음 깨진다.
 *
 * 회차 셋은 픽스처의 **같은 판정**을 시간만 달리해 실은 것이다 (판정을 새로 만들지 않는다):
 *   1) 어제 — 파견만 (자격 있는 슬라이스를 띄웠다)
 *   2) 오늘 이른 회차 — 착륙 + 막힘
 *   3) 오늘 방금 — 지금 판정 그대로 (착륙도 파견도 없이 막힘·결정 필요만)
 *
 * 슬라이스 5가 익명화한 **진짜** 회차 기록을 이 폴더에 들여오면 이 생성물은 그 옆에 남는다 —
 * 파일 이름이 날짜라 같은 날짜면 덮인다. 그때 이 스크립트를 지울지는 그 슬라이스가 정한다.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landCheck, dispatchPlan, renderCycleReport } from '../sp-sync/lib/fleet.mjs';
import { resumePlan } from '../sp-sync/lib/resume.mjs';
import { fixtureSlices, loadFixture } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RUNS_DIR = statePath('runs');
const currentPath = () => statePath('runs');

const HOUR = 3600000;

/** 파일 이름의 날짜 — `cycleReportPath` 와 같이 **로컬 시각**으로 가른다. */
function dayOf(ts) {
  const d = new Date(ts);
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}

/** 픽스처 한 바퀴를 관찰하고 판정한다 — `scripts/fixture-check.mjs` 와 같은 부름이다. */
function judge(now) {
  const fx = loadFixture(now);
  return fx.projects.map((project) => {
    const r = fixtureSlices(project, fx);
    const checks = r.workspaces.map((w) => landCheck(w, { baseRef: 'origin/main', quietMs: 120000, idleMs: 5000, now }));
    const plan = dispatchPlan({ slices: r.slices, allSlices: r.allSlices, workspaces: r.workspaces, max: fx.max(project), block: null, limitHold: null, project });
    const resume = resumePlan(fx.resume[project] || [], { now, workspaces: r.workspaces, slices: r.slices, cards: fx.cards, limits: null, max: 2 });
    // `fleetDispatch` 가 `--json` 으로 내는 모양 그대로 (`fleet.mjs` 의 `decisions` 매핑).
    const decisions = plan.map((p) => ({
      number: p.slice.number,
      title: p.slice.title,
      tags: p.slice.tags,
      deps: p.slice.deps || [],
      errors: p.slice.errors || [],
      agent: p.slice.agent || 'claude',
      eligible: p.eligible,
      reason: p.reason,
      redispatch: p.redispatch ? p.redispatch.name : null,
    }));
    return { project, checks, decisions, resume, max: fx.max(project) };
  });
}

/** 파견한 것 한 줄 — 실제로 창을 띄우고 지시를 보낸 회차의 기록. */
const dispatchedRow = (d) => ({
  name: d.redispatch || 'slice' + d.number,
  slice: d.number,
  ok: true,
  outcome: 'sent',
  submit: d.redispatch ? '지시 다시 보냄' : '지시 보냄',
  text: '슬라이스 ' + d.number + ' 진행 (' + d.agent + ')',
});

/** 착륙한 것 한 줄 — PR 번호는 회차 순서대로 매긴다 (픽스처라 진짜 PR 이 아니다). */
const landedRow = (c, pr) => ({ name: c.name, slice: c.slice, ok: true, pr, ff: true, stage: 'merge' });

/** 회차 셋. 같은 판정을 시간만 달리해 싣는다 — 판정을 새로 만들지 않는다. */
function cycles(now) {
  const j3 = judge(now);
  return [
    {
      at: now - 26 * HOUR,
      projects: j3.map((p) => ({
        project: p.project,
        sync: { action: 'ff', text: 'origin/main 으로 맞춤' },
        // 어제 회차: 자격이 난 슬라이스를 띄웠다. 워크스페이스는 아직 없었으니 착륙 판정도 없다.
        land: { landed: [], checks: [] },
        dispatch: { decisions: p.decisions, dispatched: p.decisions.filter((d) => d.eligible).map(dispatchedRow) },
        resume: { rows: [] },
      })),
    },
    {
      at: now - 2 * HOUR,
      projects: j3.map((p, i) => ({
        project: p.project,
        // 오늘 이른 회차: 자격이 난 워크스페이스를 착륙시키고, 나머지는 막힘으로 남겼다.
        land: { landed: p.checks.filter((c) => c.ready).map((c, k) => landedRow(c, 100 + i * 10 + k)), checks: p.checks.filter((c) => !c.ready) },
        dispatch: { decisions: p.decisions, dispatched: [] },
        resume: { rows: p.resume },
      })),
    },
    {
      at: now - 5 * 60000,
      projects: j3.map((p) => ({
        project: p.project,
        // 방금 회차: 지금 판정 그대로. 착륙도 파견도 없고 막힘·결정 필요만 남는다.
        land: { landed: [], checks: p.checks },
        dispatch: { decisions: p.decisions, dispatched: [] },
        resume: { rows: p.resume },
      })),
    },
  ];
}

function buildRuns(now = Date.now()) {
  if (existsSync(currentPath())) rmSync(currentPath(), { recursive: true, force: true });
  mkdirSync(currentPath(), { recursive: true });
  const files = new Map();
  for (const c of cycles(now)) {
    const day = dayOf(c.at);
    files.set(day, (files.get(day) || '') + renderCycleReport({ ...c, dryRun: false, paused: [] }));
  }
  for (const [day, text] of files) writeFileSync(join(currentPath(), day + '-cycle.md'), text);
  return { dir: currentPath(), files: [...files.keys()].sort() };
}

export { RUNS_DIR, buildRuns };

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  const { dir, files } = buildRuns();
  console.log('회차 기록을 만들었다: ' + dir);
  for (const f of files) console.log('  ' + f + '-cycle.md');
}
