#!/usr/bin/env node
/**
 * 세팅 비교 실험 (슬라이스 9) — 동시 상한(2/3/5) × 재개 상한(1/2/3)을 갈아 끼워 같은 픽스처를
 * 아홉 번 관찰하고, 세팅이 판정을 어떻게 가르는지 표로 낸다.
 *
 *   node scripts/eval-settings.mjs        (npm run eval:settings)
 *
 * **판정 규칙을 새로 만들지 않는다.** 여기서 바꾸는 것은 판정에 넘기는 **입력값** 둘뿐이고
 * (`observeFleet` 의 `caps`·`resumeMax`), 표에 싣는 사유는 sp-sync 가 낸 문장 그대로다.
 * **픽스처도 늘리지 않는다** — 늘리면 슬라이스 8의 시나리오 표본이 같이 바뀐다 (2026-09-11 검토 R5).
 * 수가 안 늘면 표본 수를 그대로 적는다.
 *
 * **시나리오 일치율은 여기서 재지 않는다** (R4). 재개 상한 1은 슬라이스 8 시나리오 8의 근거를
 * 지운다 — 그 세팅에서 beacon/slice3 이 `wait` 가 아니라 `exhausted` 가 된다. 세팅마다 일치표를
 * 다시 판정하면 일치율이 판정이 아니라 세팅 탓에 흔들린다. 일치표는 기준 세팅에서만 판정하고
 * (`scripts/eval.mjs`), 여기서는 **갈래가 바뀐 사실**만 적는다.
 *
 * 관찰은 읽기다. 실행 전후 `sandbox/fleet/` 의 파일 해시를 대조해 그것을 말이 아니라 수로 낸다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeFleet } from '../src/fleet/source.mjs';
import { FIXTURE, ROOT as FIXTURE_ROOT } from './fixture.mjs';
import { requireCleanFixture } from './fixture-guard.mjs';
import { diffTrees, hashTree } from './hash-tree.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(REPO, 'data', 'eval', 'settings.json');

/** sweep 축 둘. `PLAN.md` 슬라이스 9가 정한 값이다. */
const CAPS = [2, 3, 5];
const RESUME_MAXES = [1, 2, 3];

/** 기준 세팅 — 픽스처 정의 그대로의 동시 상한(`caps: null`)과 `RESUME_MAX`. 슬라이스 8의 일치표가 선 자리다. */
const BASE_CAPS = null;
const BASE_RESUME_MAX = 2;

/** 한 축 sweep 에서 나머지 축을 고정할 값. 동시 상한은 sp-sync 기본값과 같은 3이다. */
const FIXED_CAP = 3;

/**
 * **사람 호출** 다섯 갈래. `PRD.md §5` 의 개입 지점을 관찰 결과에서 셀 수 있는 모양으로 옮긴 것이다.
 * 갈래를 나눠 세는 이유는 세팅이 그중 둘(상한 도달 · 재개 소진)만 움직이기 때문이다 — 합계만
 * 내면 그 둘이 나머지 셋에 묻힌다.
 *
 * `PRD.md §5` 의 "충돌 해소 실패" 는 여기 없다: 샌드박스에는 살아 있는 워커 세션이 없어 해소를
 * 시도조차 하지 않는다 (`src/fleet/execute.mjs` 의 `conflict`, 슬라이스 8 시나리오 9와 같은 사정).
 *
 * 한 워크스페이스가 두 갈래에 들 수 있다 (cobalt/slice5 는 착륙 막힘이면서 재개 소진이다).
 * 그래서 갈래별 수·갈래 합계와 함께 **서로 다른 대상 수**도 낸다.
 */
const CALLS = [
  {
    key: 'landBlocked',
    label: '착륙 막힘',
    from: (o) => o.projects.flatMap((p) => p.workspaces.filter((w) => w.state === 'blocked').map((w) => p.project + '/' + w.name)),
  },
  {
    key: 'cardWait',
    label: '카드 질문 대기',
    from: (o) => o.projects.flatMap((p) => p.cards.filter((c) => c.wait).map((c) => p.project + '/' + c.workspace)),
  },
  {
    key: 'resumeExhausted',
    label: '재개 소진',
    from: (o) => o.projects.flatMap((p) => p.resume.filter((r) => r.action === 'exhausted').map((r) => p.project + '/' + r.name)),
  },
  {
    key: 'decision',
    label: '결정 필요 슬라이스',
    from: (o) => o.projects.flatMap((p) => p.slices.filter((s) => !s.done && s.hold === 'decision').map((s) => p.project + ' ' + s.number + '번')),
  },
  {
    key: 'capReached',
    label: '상한 도달',
    from: (o) =>
      o.projects.flatMap((p) => p.slices.filter((s) => !s.done && (s.hold === 'cap-project' || s.hold === 'cap-global')).map((s) => p.project + ' ' + s.number + '번')),
  },
];

// ---------- 표 ----------
// 터미널에서 한글은 두 칸을 먹는다. `padEnd` 는 코드 단위로 세므로 그대로 쓰면 한글이 든 칸부터
// 열이 어긋난다 — 화면에서 세는 폭으로 채운다.
const width = (s) => [...String(s)].reduce((a, ch) => a + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s);

const tally = (xs) => xs.reduce((a, k) => ({ ...a, [k]: (a[k] || 0) + 1 }), {});
const tallyText = (t) =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => k + ' ' + v)
    .join(' · ') || '(없음)';

/**
 * 관찰 하나에서 이번 실험이 보는 수를 전부 뽑는다. **사유 문장은 손대지 않는다** — `other` 로
 * 떨어진 보류는 코드만으로는 무엇인지 알 수 없으므로 문장을 그대로 실어 표에 남긴다.
 */
function measure(o) {
  const undone = o.projects.flatMap((p) => p.slices.filter((s) => !s.done).map((s) => ({ ...s, project: p.project })));
  const eligible = undone.filter((s) => s.eligible);
  const held = undone.filter((s) => !s.eligible);
  const resume = o.projects.flatMap((p) => p.resume.map((r) => ({ ...r, project: p.project })));
  const calls = Object.fromEntries(CALLS.map((c) => [c.key, c.from(o)]));
  const targets = new Set(Object.values(calls).flat());
  return {
    settings: o.settings,
    slices: { undone: undone.length, eligible: eligible.length, held: held.length },
    eligibleList: eligible.map((s) => s.project + ' ' + s.number + '번'),
    holds: tally(held.map((s) => s.hold)),
    // `other` 는 코드가 못 알아본 사유다. 세는 것으로 끝내지 않고 문장을 그대로 남긴다.
    otherReasons: held.filter((s) => s.hold === 'other').map((s) => s.project + ' ' + s.number + '번: ' + s.reason),
    resumeActions: tally(resume.map((r) => r.action)),
    resumeRows: resume.map((r) => ({ where: r.project + '/' + r.name, action: r.action, attempts: r.attempts, reason: r.reason })),
    calls: Object.fromEntries(CALLS.map((c) => [c.key, calls[c.key].length])),
    callTargets: calls,
    callsTotal: Object.values(calls).reduce((a, x) => a + x.length, 0),
    callTargetsUnique: targets.size,
  };
}

// ---------- 관찰 ----------
const now = Date.now();
requireCleanFixture(observeFleet({ now }), 'npm run eval:settings');

const before = hashTree(FIXTURE_ROOT);

const base = measure(observeFleet({ now, caps: BASE_CAPS, resumeMax: BASE_RESUME_MAX }));
const rows = [];
for (const caps of CAPS) {
  for (const resumeMax of RESUME_MAXES) {
    // 회차 소요(ms)는 여기서 안 담는다 — 그 기준은 슬라이스 8이 재고(`data/eval/scenarios.json`),
    // 여기 담으면 두 번 돌린 결과 파일이 잰 시간 탓에만 달라져 "같은가" 를 못 본다.
    rows.push({ caps, resumeMax, ...measure(observeFleet({ now, caps, resumeMax })) });
  }
}

const after = hashTree(FIXTURE_ROOT);
const drift = diffTrees(before, after);

const at = (caps, resumeMax) => rows.find((r) => r.caps === caps && r.resumeMax === resumeMax);
/** 한 축만 움직인 줄들 — 나머지 축은 고정한다. */
const capSweep = CAPS.map((c) => at(c, BASE_RESUME_MAX));
const resumeSweep = RESUME_MAXES.map((m) => at(FIXED_CAP, m));
const arrow = (xs) => xs.join(' → ');

// ---------- 출력 ----------
const capsText = (s) =>
  Object.entries(s.caps)
    .map(([p, v]) => p + ' ' + v)
    .join(' · ');
const wsTotal = Object.values(FIXTURE).reduce((a, d) => a + d.workspaces.length, 0);

console.log('세팅 비교 실험 — 픽스처: ' + FIXTURE_ROOT);
console.log('판정 시각: ' + new Date(now).toISOString());
console.log('기준 세팅: 동시 상한 = 픽스처 정의(' + capsText(base.settings) + ') · 재개 상한 ' + base.settings.resumeMax);
console.log('표본: 미완 슬라이스 ' + base.slices.undone + '개 · 워크스페이스 ' + wsTotal + '개 · 재개 항목 ' + base.resumeRows.length + '개\n');

// 한 표에 넷을 다 넣으면 줄이 150칸을 넘어 접힌다. 파견 쪽과 재개·사람 호출 쪽으로 나눈다.
// 마지막 줄(`정의`)은 기준 세팅이다 — 동시 상한만 픽스처 정의를 그대로 쓴다.
const combos = [...rows.map((r) => [r.caps, r.resumeMax, r]), ['정의', base.settings.resumeMax, base]];

console.log('조합 ' + rows.length + '개 (동시 상한 ' + CAPS.join('/') + ' × 재개 상한 ' + RESUME_MAXES.join('/') + ') + 기준 세팅 1개');
console.log('\n[1] 파견');
console.log('  ' + padL('상한', 6) + padL('재개', 6) + padL('자격', 6) + '  보류 사유 분포');
for (const [cap, rm, r] of combos) {
  console.log('  ' + padL(cap, 6) + padL(rm, 6) + padL(r.slices.eligible, 6) + '  ' + tallyText(r.holds));
}

console.log('\n[2] 재개와 사람 호출');
console.log('  ' + padL('상한', 6) + padL('재개', 6) + padL('사람호출', 10) + padL('대상', 6) + '  재개 갈래 분포');
for (const [cap, rm, r] of combos) {
  console.log(
    '  ' + padL(cap, 6) + padL(rm, 6) + padL(r.callsTotal, 10) + padL(r.callTargetsUnique, 6) + '  ' + tallyText(r.resumeActions)
  );
}
console.log('  ↑ 마지막 줄이 기준 세팅 — 동시 상한은 픽스처 정의 (' + capsText(base.settings) + ')');
console.log('  `대상` 은 갈래 합계에서 겹치는 것을 뺀 수다 — cobalt/slice5 는 착륙 막힘이면서 재개 소진이라 두 갈래에 든다.');

const otherRows = [...rows, base].flatMap((r) => r.otherReasons);
console.log('\n`other` 로 떨어진 보류 — 코드가 못 알아본 사유는 문장을 그대로 남긴다');
if (otherRows.length) for (const t of [...new Set(otherRows)]) console.log('  ' + t);
else console.log('  없음 (' + rows.length + '개 조합과 기준 세팅 전부에서 0건)');

console.log('\n동시 상한 sweep (재개 상한 ' + BASE_RESUME_MAX + ' 고정) — ' + CAPS.join(' → '));
console.log('  파견 자격     ' + arrow(capSweep.map((r) => r.slices.eligible)));
console.log('  cap-project  ' + arrow(capSweep.map((r) => r.holds['cap-project'] || 0)));
console.log('  사람 호출     ' + arrow(capSweep.map((r) => r.callsTotal)));
console.log('  자격 슬라이스  ' + arrow(capSweep.map((r) => '[' + r.eligibleList.join(', ') + ']')));
const capSample = base.holds['cap-project'] || 0;
console.log(
  '  **표본이 작다** — 기준 세팅에서 `cap-project` 로 떨어지는 슬라이스는 픽스처 전체에서 ' + capSample + '개다.\n' +
    '  수가 안 는다고 픽스처를 늘리지 않는다 — 늘리면 슬라이스 8의 시나리오 표본이 같이 바뀐다 (검토 R5).'
);

console.log('\n재개 상한 sweep (동시 상한 ' + FIXED_CAP + ' 고정) — ' + RESUME_MAXES.join(' → '));
for (const k of ['exhausted', 'wait', 'resume', 'drop', 'blocked']) {
  if (resumeSweep.every((r) => !(r.resumeActions[k] || 0))) continue;
  console.log('  ' + k.padEnd(10) + ' ' + arrow(resumeSweep.map((r) => r.resumeActions[k] || 0)));
}
console.log('  워크스페이스별 갈래 (바뀌는 것만):');
const names = [...new Set(resumeSweep.flatMap((r) => r.resumeRows.map((x) => x.where)))];
for (const name of names) {
  const cells = resumeSweep.map((r) => r.resumeRows.find((x) => x.where === name));
  if (cells.every((c) => c?.action === cells[0]?.action)) continue;
  console.log('    ' + name + ' (시도 ' + (cells[0]?.attempts ?? '?') + '회): ' + arrow(cells.map((c) => c?.action || '(없음)')));
}
console.log(
  '  **함정** — 재개 상한 1 은 슬라이스 8 시나리오 8(카드가 질문 대기 중)의 근거를 지운다:\n' +
    '  그 세팅에서 beacon/slice3 은 카드 `wait` 를 보기 전에 시도 수로 먼저 갈린다 (`resumePlan` 이\n' +
    '  `attempts >= max` 를 카드보다 앞에서 본다). 그래서 일치표는 기준 세팅에서만 판정한다 (검토 R4).'
);
for (const m of RESUME_MAXES) {
  const r = at(FIXED_CAP, m).resumeRows.find((x) => x.where === 'beacon/slice3');
  console.log('    재개 상한 ' + m + ' → beacon/slice3 ' + (r ? r.action + ': ' + r.reason : '(재개 항목이 없다)'));
}

console.log('\n사람 호출 갈래 (PRD.md §5 의 개입 지점. 충돌 해소 실패는 샌드박스에 없다 — 슬라이스 8 시나리오 9)');
console.log('  ' + padR('갈래 (상한/재개)', 22) + rows.map((r) => padL(r.caps + '/' + r.resumeMax, 6)).join('') + '   움직이나');
for (const c of CALLS) {
  const vals = rows.map((r) => r.calls[c.key]);
  console.log('  ' + padR(c.label, 22) + vals.map((v) => padL(v, 6)).join('') + '   ' + (new Set(vals).size > 1 ? '예' : '아니오'));
}
console.log('  ' + padR('갈래 합계', 22) + rows.map((r) => padL(r.callsTotal, 6)).join(''));
console.log('  ' + padR('서로 다른 대상', 22) + rows.map((r) => padL(r.callTargetsUnique, 6)).join(''));
console.log('  세팅이 움직이는 갈래는 위 표의 "예" 뿐이다 — 나머지는 착륙 판정·카드·계획 태그가 정하는 것이라 상한과 무관하다.');

// ---------- 에이전트 두 종 ----------
// `PLAN.md` 슬라이스 9: 에이전트 조합(단일 / 2종)은 픽스처 정의를 바꿔야 하므로 이번엔 **지금
// 픽스처가 이미 섞어 쓰는 두 종**의 갈래 차이를 내는 데까지만 한다. 새 워크스페이스를 만들지 않는다.
const baseObs = observeFleet({ now, caps: BASE_CAPS, resumeMax: BASE_RESUME_MAX });
const agentRows = baseObs.projects.flatMap((p) =>
  p.workspaces.map((w) => ({
    where: p.project + '/' + w.name,
    kind: w.headless ? '헤드리스' : 'TUI',
    agent: w.agent,
    state: w.state,
    reason: w.reason,
    resume: (p.resume.find((r) => r.name === w.name) || {}).action || null,
  }))
);
console.log('\n에이전트 두 종 — 픽스처가 이미 섞어 쓰는 것 (새로 만들지 않는다). 기준 세팅에서:');
for (const kind of ['헤드리스', 'TUI']) {
  const g = agentRows.filter((r) => r.kind === kind);
  console.log('  ' + kind + ' ' + g.length + '개 — 상태 ' + tallyText(tally(g.map((r) => r.state))) + ' · 재개 ' + tallyText(tally(g.map((r) => r.resume || '(없음)'))));
  for (const r of g) console.log('    ' + r.where + ' [계획 에이전트 ' + (r.agent || '없음') + '] ' + r.state + ' — ' + (r.reason || '(사유 없음)'));
}
console.log(
  '  갈래가 갈리는 자리는 **유휴 판정**이다 — 헤드리스는 세션 기록만으로 끝까지 갈리고, TUI 는\n' +
    '  Orca CLI 를 부르므로 잠든 창(절전 기록)이어야 디스크만으로 갈린다 (`scripts/fixture.mjs` 머리말).\n' +
    '  종류는 `headlessOf` 가 정한다 — 계획의 `[에이전트: …]` 보다 **세션 기록**이 먼저다.\n' +
    '  세팅 sweep 은 이 차이를 움직이지 않는다: 상한은 파견·재개를, 유휴는 착륙을 가른다.'
);

console.log('\n격리 — sandbox/fleet/ 파일 ' + before.size + '개');
if (drift.length) {
  console.log('  변한 것 ' + drift.length + '건:');
  for (const d of drift) console.log('    ' + d);
} else {
  console.log('  변한 것 없음 (관찰은 읽기다)');
}

// ---------- 결과 파일 ----------
// `/eval` 화면이 읽는 자리 (슬라이스 10). `data/eval/scenarios.json` 과 같은 꼴이다 — 머리에 만든
// 시각과 한 줄 설명, 그 아래에 표로 그릴 배열.
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      note:
        '동시 상한 × 재개 상한을 갈아 끼워 같은 픽스처를 관찰한 결과. 만든 것은 scripts/eval-settings.mjs (npm run eval:settings). ' +
        '두 번 돌리면 같다 — 다만 사유 문장 몇 개가 시각을 담아(한도 초기화 시각·잠든 시각) 분이 바뀌는 순간에 걸치면 그 문자열만 달라진다. 수와 갈래는 안 바뀐다.',
      axes: { caps: CAPS, resumeMax: RESUME_MAXES, fixedCap: FIXED_CAP },
      baseline: base,
      sample: {
        undoneSlices: base.slices.undone,
        workspaces: wsTotal,
        resumeEntries: base.resumeRows.length,
        capProjectSlices: capSample,
        note: 'cap-project 표본이 ' + capSample + '개다. 픽스처를 늘리지 않는다 — 늘리면 슬라이스 8의 시나리오 표본이 같이 바뀐다 (검토 R5).',
      },
      callKinds: CALLS.map((c) => ({ key: c.key, label: c.label })),
      rows,
      sweeps: {
        caps: {
          fixed: { resumeMax: BASE_RESUME_MAX },
          values: CAPS,
          eligible: capSweep.map((r) => r.slices.eligible),
          capProject: capSweep.map((r) => r.holds['cap-project'] || 0),
          calls: capSweep.map((r) => r.callsTotal),
        },
        resumeMax: {
          fixed: { caps: FIXED_CAP },
          values: RESUME_MAXES,
          actions: Object.fromEntries(['exhausted', 'wait', 'resume', 'drop', 'blocked'].map((k) => [k, resumeSweep.map((r) => r.resumeActions[k] || 0)])),
          watched: names.map((n) => ({ where: n, actions: resumeSweep.map((r) => (r.resumeRows.find((x) => x.where === n) || {}).action || null) })),
        },
      },
      agents: agentRows,
      isolation: { files: before.size, drift },
    },
    null,
    1
  ) + '\n'
);
console.log('\n결과를 남겼다: ' + OUT_FILE.replace(REPO + (process.platform === 'win32' ? '\\' : '/'), ''));

if (drift.length) {
  console.error('\n실패 — 관찰이 픽스처를 바꿨다 (위 목록).');
  process.exit(1);
}
console.log('\n통과 — 조합 ' + rows.length + '개를 관찰했고, 픽스처는 변하지 않았다.');
