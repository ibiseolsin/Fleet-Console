#!/usr/bin/env node
/**
 * 사유 분류 커버리지 (슬라이스 10) — `PRD.md §8` 판정 일치율의 **둘째 축**.
 *
 *   node scripts/eval-coverage.mjs          # 표를 찍고 data/eval/coverage.json 을 쓴다
 *   node scripts/eval-coverage.mjs --dry    # 쓰지 않고 표만
 *
 * 첫째 축(시나리오 재생 일치율)은 `scripts/eval.mjs` 가 잰다. 축을 나눈 이유는 하나다 —
 * **회차 기록에는 그 시점의 저장소 상태가 없다.** 기록으로 남은 것은 결과 문장뿐이라
 * 재생해서 대조할 수가 없고, 대신 "그 문장을 코드가 알아보는가" 를 잰다.
 *
 * 여기서 판정을 하지 않는다 — `src/fleet/reasons.mjs` 의 분류표로 **라벨만** 붙여 센다.
 * 읽는 것은 `data/runs/` 의 마크다운과 픽스처 관찰 한 번뿐이고 아무것도 쓰지 않는다
 * (결과 파일 하나 빼고).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRunsFile } from '../src/fleet/runs.mjs';
import { holdOf } from '../src/fleet/source.mjs';
import { observeFleet } from '../src/fleet/source.mjs';
import { CALL_LABELS, blockOf, callOf, describe, dispatchResultOf, landResultOf, BLOCK_CODES, DISPATCH_RESULTS, LAND_RESULTS } from '../src/fleet/reasons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RUNS_DIR = join(REPO, 'data', 'runs');
const OUT = join(REPO, 'data', 'eval', 'coverage.json');

const dry = process.argv.includes('--dry');
const pct = (n, d) => (d ? (n / d) * 100 : 0);
const fmtPct = (n, d) => pct(n, d).toFixed(1) + '%';

function tally(items) {
  const m = new Map();
  for (const k of items) m.set(k, (m.get(k) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, n }));
}

/* ─── 회차 기록 읽기 ───────────────────────────────────────────────────────── */

function readAllRuns() {
  const runs = [];
  for (const f of readdirSync(RUNS_DIR).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}-cycle\.md$/.test(f)) continue;
    runs.push(...parseRunsFile(readFileSync(join(RUNS_DIR, f), 'utf8'), f));
  }
  return runs;
}

const rowsOf = (runs, table) => runs.flatMap((r) => r.tables?.[table] || []);

/**
 * 한 열의 커버리지 한 줄. `holdOf` 와 전용 분류표를 **둘 다** 먹여 본다 — 어느 쪽이 얼마나
 * 잡는지가 축을 나눈 근거다(`EVAL.md` 머리말).
 */
function coverageRow({ table, column, kind, rows, classify }) {
  const texts = rows.map((r) => String(r[column] ?? ''));
  const codes = rows.map(classify);
  const byHold = texts.map(holdOf);
  const other = codes.filter((c) => c === 'other').length;
  return {
    table,
    column,
    kind,
    samples: rows.length,
    unique: new Set(texts).size,
    hold: { coded: byHold.filter((c) => c !== 'other').length, codes: tally(byHold) },
    own: { coded: rows.length - other, other, codes: tally(codes) },
    coverage: pct(rows.length - other, rows.length),
    otherSamples: [...new Set(texts.filter((_, i) => codes[i] === 'other'))].slice(0, 3).map((t) => t.slice(0, 60)),
  };
}

/* ─── 사람 호출 사후 분류 (헛호출률) ───────────────────────────────────────── */

const callKey = (r) => [r['프로젝트'], r['무엇'], r['내용']].join('␟');

function callAudit(rows) {
  const uniq = new Map();
  for (const r of rows) {
    const k = callKey(r);
    const cur = uniq.get(k);
    if (cur) cur.rows++;
    else uniq.set(k, { ...callOf(r), project: r['프로젝트'], what: r['무엇'], body: r['내용'], rows: 1 });
  }
  const items = [...uniq.values()];
  const codes = [...new Set(items.map((i) => i.code))];
  const byCode = codes
    .map((code) => {
      const mine = items.filter((i) => i.code === code);
      return {
        code,
        need: CALL_LABELS[code]?.[0] ?? '미분류',
        note: CALL_LABELS[code]?.[1] ?? null,
        items: mine.length,
        rows: mine.reduce((a, i) => a + i.rows, 0),
      };
    })
    .sort((a, b) => b.rows - a.rows);
  const sum = (need, key) => byCode.filter((c) => c.need === need).reduce((a, c) => a + c[key], 0);
  const totals = { items: items.length, rows: rows.length };
  const needs = ['판단', '조작', '불필요', '미분류'].map((need) => ({
    need,
    items: sum(need, 'items'),
    rows: sum(need, 'rows'),
  }));
  return {
    totals,
    byCode,
    needs,
    // 헛호출률 두 가지 — 엄격(판단만)과 느슨(사람이 없으면 못 가는 것).
    strict: { items: pct(sum('판단', 'items'), totals.items), rows: pct(sum('판단', 'rows'), totals.rows) },
    loose: {
      items: pct(sum('판단', 'items') + sum('조작', 'items'), totals.items),
      rows: pct(sum('판단', 'rows') + sum('조작', 'rows'), totals.rows),
    },
    items: items.map((i) => ({ project: i.project, code: i.code, need: i.need, rows: i.rows, what: i.what })),
  };
}

/* ─── 실행 ─────────────────────────────────────────────────────────────────── */

const runs = readAllRuns();
const land = rowsOf(runs, '착륙');
const dispatch = rowsOf(runs, '파견');
const blocked = rowsOf(runs, '막힘');
const calls = rowsOf(runs, '결정 필요');

const rows = [
  coverageRow({ table: '착륙', column: '결과', kind: '결과 갈래', rows: land, classify: (r) => landResultOf(r['결과']) }),
  coverageRow({ table: '파견', column: '결과', kind: '결과 갈래', rows: dispatch, classify: (r) => dispatchResultOf(r['결과']) }),
  coverageRow({ table: '막힘', column: '이유', kind: '착륙 막힘 사유', rows: blocked, classify: (r) => blockOf(r['이유']) }),
  coverageRow({ table: '결정 필요', column: '내용', kind: '사람 호출 사유', rows: calls, classify: (r) => callOf(r).code }),
];

const audit = callAudit(calls);

/**
 * 같은 분류표를 **지금 관찰**의 막힘 사유에도 먹여 본다. 기록(과거 문장)과 픽스처(현재 판정)가
 * 같은 라벨을 받아야 화면의 "막힘 N건" 과 `EVAL.md` 의 수가 같은 것을 센다.
 */
function liveBlocks() {
  const obs = observeFleet({});
  const reasons = obs.projects
    .flatMap((p) => p.workspaces)
    .filter((w) => w.state === 'blocked')
    .map((w) => w.reason || '');
  const codes = reasons.map(blockOf);
  return { samples: reasons.length, codes: tally(codes), other: codes.filter((c) => c === 'other').length };
}

const live = liveBlocks();

const out = {
  builtAt: new Date().toISOString(),
  note:
    '반입한 회차 기록의 사유 문장이 코드로 분류되는 비율. 만든 것은 scripts/eval-coverage.mjs (npm run eval:coverage). ' +
    '판정이 아니라 라벨링이다 — 분류표는 src/fleet/reasons.mjs.',
  runs: { files: new Set(runs.map((r) => r.file)).size, cycles: runs.length },
  tables: rows,
  live,
  calls: audit,
  codeBooks: {
    block: BLOCK_CODES.map(([, code]) => ({ code, note: describe(BLOCK_CODES, code) })),
    land: LAND_RESULTS.map(([, code]) => ({ code, note: describe(LAND_RESULTS, code) })),
    dispatch: DISPATCH_RESULTS.map(([, code]) => ({ code, note: describe(DISPATCH_RESULTS, code) })),
  },
};

/* ─── 출력 ─────────────────────────────────────────────────────────────────── */

console.log('# 사유 분류 커버리지 — 회차 ' + out.runs.cycles + '개 (파일 ' + out.runs.files + '개)\n');
console.log('| 표 | 분류한 열 | 무엇인가 | 표본 | 고유 | holdOf | 전용 분류표 | 커버리지 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.table} | \`${r.column}\` | ${r.kind} | ${r.samples} | ${r.unique} | ${r.hold.coded} (${fmtPct(r.hold.coded, r.samples)}) | ` +
      `${r.own.coded} | **${fmtPct(r.own.coded, r.samples)}** |`
  );
}
console.log('\n못 알아본 문장 (`other`):');
for (const r of rows) {
  if (!r.own.other) continue;
  console.log('  ' + r.table + '/' + r.column + ' — ' + r.own.other + '건: ' + r.otherSamples.map((s) => '"' + s + '"').join(' / '));
}
if (rows.every((r) => !r.own.other)) console.log('  없음 — 네 열 모두 100%');

console.log('\n지금 관찰의 막힘 사유도 같은 표로: ' + live.samples + '건 · ' + live.codes.map((c) => c.code + ' ' + c.n).join(' · ') + ' · other ' + live.other);

console.log('\n# 헛호출 — `결정 필요` 사후 분류');
console.log('행 ' + audit.totals.rows + ' · 고유 항목 ' + audit.totals.items + ' (같은 항목이 답을 받을 때까지 회차마다 다시 올라온다)\n');
console.log('| 코드 | 사람이 할 일 | 고유 | 행 | 무엇인가 |');
console.log('|---|---|---|---|---|');
for (const c of audit.byCode) console.log(`| \`${c.code}\` | ${c.need} | ${c.items} | ${c.rows} | ${c.note ?? ''} |`);
console.log('\n| 사람이 할 일 | 고유 | 행 |');
console.log('|---|---|---|');
for (const n of audit.needs) console.log(`| ${n.need} | ${n.items} (${fmtPct(n.items, audit.totals.items)}) | ${n.rows} (${fmtPct(n.rows, audit.totals.rows)}) |`);
console.log(
  '\n헛호출률 — 판단만: 고유 ' + audit.strict.items.toFixed(1) + '% · 행 ' + audit.strict.rows.toFixed(1) + '%' +
    ' / 판단+조작: 고유 ' + audit.loose.items.toFixed(1) + '% · 행 ' + audit.loose.rows.toFixed(1) + '%'
);

if (!dry) {
  if (!existsSync(dirname(OUT))) throw new Error('결과 폴더가 없다: ' + dirname(OUT));
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('\n→ ' + OUT.replace(REPO, '').replace(/\\/g, '/').replace(/^\//, ''));
}
