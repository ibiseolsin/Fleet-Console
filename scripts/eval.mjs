#!/usr/bin/env node
/**
 * 평가 세트 재생기 (슬라이스 8) — `PRD.md §9` 의 시나리오 10개를 픽스처로 재생해 기대와 대조한다.
 *
 *   node scripts/eval.mjs        (npm run eval)
 *
 * **판정 규칙을 새로 만들지 않는다.** 재생은 `observeFleet` 을 부르고 그 결과를 **읽는 것**뿐이다.
 * 시나리오의 `기대` 는 판정을 다시 쓴 것이 아니라 "그 결과의 어디를 봐야 하는지" 이고, 표에 싣는
 * `실제` 는 sp-sync 가 낸 사유 문장 그대로다. 안 맞으면 픽스처도 판정도 고치지 않고 **불일치로
 * 적는다** (`PRD.md §7` — 판정 규칙 신설·변경은 안 한다).
 *
 * **시나리오마다 관찰을 따로 돈다.** 두 이유:
 *  - 시나리오 3(계획 미커밋)의 `planDirty` 는 그 프로젝트의 **새 파견을 전부** 막는다 — 4·5·10 과
 *    같은 관찰에 섞으면 그 셋이 같이 죽는다 (2026-09-11 PLAN 검토 R2).
 *  - `PRD.md §8` 의 "회차 하나의 판정이 10초 이내" 를 잴 자리가 여기뿐이다 (R7). 관찰부터 판정까지가
 *    한 회차이므로 시나리오마다 그 한 바퀴를 통째로 잰다.
 *
 * 판정 시각(`now`)은 **한 번 정해** 모든 관찰에 같이 넘긴다 — 픽스처 시각이 상대값이라 관찰마다
 * 따로 재면 "턴이 묵었나"·"한도가 풀렸나" 의 답이 관찰 사이에 갈릴 수 있다.
 *
 * 재생은 읽기다. 실행 전후 `sandbox/fleet/` 의 파일 해시를 대조해 그것을 말이 아니라 수로 낸다.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDirtyBlock } from '../sp-sync/lib/fleet.mjs';
import { readRuns } from '../src/fleet/runs.mjs';
import { observeFleet } from '../src/fleet/source.mjs';
import { ROOT as FIXTURE_ROOT, projectRoot } from './fixture.mjs';
import { requireCleanFixture } from './fixture-guard.mjs';
import { diffTrees, hashTree } from './hash-tree.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(REPO, 'data', 'eval', 'scenarios.json');
const RUNS_DIR = join(REPO, 'data', 'runs');

/** `PRD.md §8` 의 회차 소요 기준. 넘으면 표에 적고 실패로 센다. */
const CYCLE_BUDGET_MS = 10000;

// ---------- 관찰 결과에서 한 줄 집기 ----------
const projectOf = (o, name) => o.projects.find((p) => p.project === name) || null;
const wsOf = (o, project, name) => (projectOf(o, project)?.workspaces || []).find((w) => w.name === name) || null;
const sliceOf = (o, project, n) => (projectOf(o, project)?.slices || []).find((s) => s.number === n) || null;
const resumeOf = (o, project, name) => (projectOf(o, project)?.resume || []).find((r) => r.name === name) || null;
const cardOf = (o, project, ws) => (projectOf(o, project)?.cards || []).find((c) => c.workspace === ws) || null;

const wsText = (w) => (w ? w.state + ' — ' + (w.reason || '(사유 없음)') : '그 워크스페이스가 없다');
const sliceText = (s) => (s ? (s.eligible ? '파견 자격 있음' : '보류(' + s.hold + ')') + ' — ' + s.reason : '그 슬라이스가 없다');
const resumeText = (r) => (r ? r.action + '(' + r.attempts + '회) — ' + r.reason : '그 재개 항목이 없다');

// ---------- 시나리오 3의 재료 ----------
const GIT_ID = ['-c', 'user.name=Fixture Bot', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (args, cwd) => execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/**
 * "본체 `PLAN.md` 가 커밋 전" 사유를 **sp-sync 의 `planDirtyBlock` 에게 받아** 온다.
 *
 * 문장을 여기 베껴 두면 sp-sync 가 문구를 고쳤을 때 재생만 옛 문장으로 통과한다. 그렇다고 픽스처
 * 본체를 더럽힐 수도 없다 — 재생은 읽기여야 한다. 그래서 임시 폴더에 픽스처와 **같은 계획서**를
 * 가진 git 저장소를 하나 만들어 그 상태를 실제로 만들고, 탐지 함수를 그대로 부른다.
 * 깨끗한 저장소(픽스처 본체)에서는 `null` 이 나오는 것도 같이 확인한다 — 탐지가 늘 켜져 있는 게
 * 아니라 미커밋일 때만 켜진다는 뜻이다.
 */
function planDirtyProbe() {
  const plan = readFileSync(join(projectRoot('atlas'), 'PLAN.md'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-eval-plan-'));
  try {
    git(['init', '-b', 'main', dir], tmpdir());
    writeFileSync(join(dir, 'PLAN.md'), plan);
    git(['add', '-A'], dir);
    git(['commit', '-m', '계획'], dir);
    const clean = planDirtyBlock(dir);
    appendFileSync(join(dir, 'PLAN.md'), '- [ ] **6. 검토 전 슬라이스**\n');
    return { dirty: planDirtyBlock(dir), clean };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 반입한 회차 기록에서 표 칸에 그 낱말이 든 행 수. 시나리오 9가 "기록에도 없다" 를 수로 낼 자리. */
function rowsMentioning(word) {
  const { runs } = readRuns({ dir: RUNS_DIR, limit: Number.MAX_SAFE_INTEGER });
  let rows = 0;
  for (const r of runs) {
    for (const table of Object.values(r.tables || {})) {
      for (const row of table) if (Object.values(row).some((v) => String(v).includes(word))) rows++;
    }
  }
  return { runs: runs.length, rows };
}

// ---------- 시나리오 ----------
// `pass` 는 어느 관찰로 재생하는지다. `base` 는 기준 세팅(픽스처 정의 그대로 · 재개 상한 2),
// `plan-dirty` 는 본체 PLAN.md 가 미커밋인 관찰. `null` 이면 재생하지 않는다(사유를 적는다).
const SCENARIOS = [
  {
    n: 1,
    name: '정상 착륙',
    source: '실제 회차 기록',
    pass: 'base',
    expect: 'atlas/slice2 — 완료 체크 + 커밋 + 유휴 → 착륙 자격 있음(ready)',
    check: (o) => {
      const w = wsOf(o, 'atlas', 'slice2');
      return { ok: w?.state === 'ready', actual: 'atlas/slice2 ' + wsText(w) };
    },
  },
  {
    n: 2,
    name: '미완인데 유휴',
    source: '2026-09-10 회차의 막힘 항목',
    pass: 'base',
    expect: 'beacon/slice2 — 착륙하지 않고 막힘(blocked), 사유에 "미체크"',
    check: (o) => {
      const w = wsOf(o, 'beacon', 'slice2');
      return { ok: w?.state === 'blocked' && /미체크/.test(w.reason || ''), actual: 'beacon/slice2 ' + wsText(w) };
    },
  },
  {
    n: 3,
    name: '계획 미커밋 상태의 파견',
    source: '사고 기록 (미검토 계획이 파견됨)',
    pass: 'plan-dirty',
    // 기준 관찰에서 자격이 있던 둘이 여기서 막히는 것이 이 시나리오다. 나머지는 원래 사유가 먼저다
    // (이미 돌고 있음 · 계획 오류) — `dispatchPlan` 이 그 둘을 planDirty 보다 앞에서 가른다.
    expect: '기준 관찰에서 자격이 있던 beacon 4번·cobalt 2번이 보류되고 사유가 planDirtyBlock 의 문장, 자격 있는 슬라이스 0개',
    check: (o, ctx) => {
      const rows = ['beacon', 'cobalt'].map((p, i) => sliceOf(o, p, [4, 2][i]));
      const eligible = o.projects.flatMap((p) => p.slices.filter((s) => s.eligible));
      const ok = rows.every((s) => s && !s.eligible && s.reason === ctx.planDirty) && eligible.length === 0;
      return { ok, actual: 'beacon 4번 ' + sliceText(rows[0]) + ' / cobalt 2번 ' + sliceText(rows[1]) + ' / 자격 있는 슬라이스 ' + eligible.length + '개' };
    },
  },
  {
    n: 4,
    name: '선행 의존 미충족',
    source: '계획서의 선행 표시 슬라이스',
    pass: 'base',
    expect: 'atlas 4번 `[선행: 2]` — 파견 자격 없음(deps-undone) + 어느 슬라이스 때문인지',
    check: (o) => {
      const s = sliceOf(o, 'atlas', 4);
      return { ok: s && !s.eligible && s.hold === 'deps-undone' && /2번/.test(s.reason), actual: 'atlas 4번 ' + sliceText(s) };
    },
  },
  {
    n: 5,
    name: '동시 실행 상한 도달',
    source: '상한 설정',
    pass: 'base',
    // `PRD.md §9` 는 "상한 3 설정 → 넷째 보류" 로 적었지만 픽스처의 beacon 은 상한 2다(2개가 이미
    // 돌고 4번이 자격을 받아 셋째가 되는 자리). 재는 것은 같다 — 상한을 채운 뒤의 다음 슬라이스가
    // `cap-project` 로 보류되는가. 상한 값 자체의 sweep 은 슬라이스 9다.
    expect: 'beacon 5번 — 동시 상한을 채워 보류(cap-project). 픽스처 상한은 2 (PRD 예시의 3이 아니다)',
    check: (o) => {
      const s = sliceOf(o, 'beacon', 5);
      const p = projectOf(o, 'beacon');
      return { ok: s && !s.eligible && s.hold === 'cap-project', actual: 'beacon(상한 ' + p?.max + ') 5번 ' + sliceText(s) };
    },
  },
  {
    n: 6,
    name: '한도로 막힌 워크스페이스',
    source: '재개 대기 기록',
    pass: 'base',
    expect: '초기화 전이면 대기 — cobalt/slice5 는 막힘(한도) · 초기화가 지난 atlas/slice3 은 재개(resume)',
    check: (o) => {
      const w = wsOf(o, 'cobalt', 'slice5');
      const r = resumeOf(o, 'atlas', 'slice3');
      const held = w?.state === 'blocked' && /한도/.test(w.reason || '');
      return { ok: held && r?.action === 'resume', actual: '초기화 전 cobalt/slice5 ' + wsText(w) + ' / 초기화 지남 atlas/slice3 ' + resumeText(r) };
    },
  },
  {
    n: 7,
    name: '재개 2회 소진',
    source: '재시도 상한',
    pass: 'base',
    expect: 'cobalt/slice5 — 재개 상한(2)을 소진해 사람에게 넘김(exhausted)',
    check: (o) => {
      const r = resumeOf(o, 'cobalt', 'slice5');
      return { ok: r?.action === 'exhausted' && r.attempts === 2, actual: 'cobalt/slice5 ' + resumeText(r) };
    },
  },
  {
    n: 8,
    name: '카드가 질문 대기 중',
    source: '사고 기록 (승인 문구로 착륙이 영영 멈춤)',
    pass: 'base',
    // R3: 판정 재료가 워크스페이스 상태가 아니다. `landCheck` 는 카드를 실제 홈에서만 읽어
    // (`cardForWorkspace`, 주입 구멍 없음) 픽스처 카드가 안 붙는다 — beacon/slice3 의 상태는 `busy` 다.
    // 카드 `wait` 는 `resumePlan` 의 갈래와 `cards[]` 에만 나오므로 거기서 본다.
    expect: 'beacon/slice3 — 재개 갈래가 wait(워커가 결정을 기다림)이고 카드 `wait` 가 차 있다',
    check: (o) => {
      const r = resumeOf(o, 'beacon', 'slice3');
      const c = cardOf(o, 'beacon', 'slice3');
      return { ok: r?.action === 'wait' && !!c?.wait, actual: 'beacon/slice3 ' + resumeText(r) + ' / 카드 wait="' + (c?.wait || '') + '"' };
    },
  },
  {
    n: 9,
    name: '충돌 해소 2회 실패',
    source: '충돌 상한',
    pass: null,
    expect: '사람에게 넘김 + 두 번의 시도 내역 표시',
    // 지어내지 않는다. 샌드박스에는 살아 있는 워커 세션이 없어 해소 자체를 시도하지 않고
    // (`src/fleet/execute.mjs:321~328`), 반입한 회차 기록에도 충돌 행이 없다 — 아래에서 세어 적는다.
    skip: () => {
      const { runs, rows } = rowsMentioning('충돌');
      return (
        '픽스처로 지어내지 않는다 — 샌드박스에는 워커 세션이 없어 해소를 시도하지 않는다' +
        '(`src/fleet/execute.mjs` conflict). 반입한 회차 ' + runs + '개의 표에서 "충돌" 이 든 행 ' + rows + '개'
      );
    },
  },
  {
    n: 10,
    name: '결정 필요 표시 슬라이스',
    source: '계획서 태그',
    pass: 'base',
    expect: 'atlas 5번 `[결정 필요: 보관 기간]` — 파견하지 않고 보고만(decision)',
    check: (o) => {
      const s = sliceOf(o, 'atlas', 5);
      return { ok: s && !s.eligible && s.hold === 'decision', actual: 'atlas 5번 ' + sliceText(s) };
    },
  },
];

// ---------- 재생 ----------
const now = Date.now();
requireCleanFixture(observeFleet({ now }), 'npm run eval');

const probe = planDirtyProbe();
const before = hashTree(FIXTURE_ROOT);

const results = [];
for (const sc of SCENARIOS) {
  if (!sc.pass) {
    results.push({ n: sc.n, name: sc.name, source: sc.source, expect: sc.expect, actual: sc.skip(), result: 'skip', ms: null });
    continue;
  }
  const opts = sc.pass === 'plan-dirty' ? { now, planDirty: probe.dirty } : { now };
  const t0 = process.hrtime.bigint();
  const o = observeFleet(opts);
  const r = sc.check(o, { planDirty: probe.dirty });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push({ n: sc.n, name: sc.name, source: sc.source, pass: sc.pass, expect: sc.expect, actual: r.actual, result: r.ok ? 'match' : 'mismatch', ms: Math.round(ms) });
}

const after = hashTree(FIXTURE_ROOT);
const drift = diffTrees(before, after);

// ---------- 출력 ----------
const replayed = results.filter((r) => r.result !== 'skip');
const matched = replayed.filter((r) => r.result === 'match');
const mismatched = replayed.filter((r) => r.result === 'mismatch');
const skipped = results.filter((r) => r.result === 'skip');
const times = replayed.map((r) => r.ms);
const totalMs = times.reduce((a, b) => a + b, 0);
const maxMs = times.length ? Math.max(...times) : 0;
const over = replayed.filter((r) => r.ms > CYCLE_BUDGET_MS);
const MARK = { match: '✓', mismatch: '✗', skip: '—' };

console.log('평가 세트 재생 — 픽스처: ' + FIXTURE_ROOT);
console.log('판정 시각: ' + new Date(now).toISOString());
console.log('기준 세팅: 동시 상한 = 픽스처 정의(atlas 3 · beacon 2 · cobalt 3) · 재개 상한 2\n');

for (const r of results) {
  console.log(String(r.n).padStart(2) + ' ' + MARK[r.result] + ' ' + r.name + (r.ms == null ? ' (재생 불가)' : ' (' + r.ms + 'ms)'));
  console.log('     기대  ' + r.expect);
  console.log('     실제  ' + r.actual);
}

console.log('\n일치 — 재생 ' + replayed.length + '개 중 일치 ' + matched.length + ' · 불일치 ' + mismatched.length + ' · 재생 불가 ' + skipped.length + ' (시나리오 ' + SCENARIOS.length + '개)');
console.log('  일치율 ' + (replayed.length ? ((matched.length / replayed.length) * 100).toFixed(1) : '0.0') + '% — 재생한 것만 분모다 (재생 불가는 빼고 그 사유를 위에 적었다)');
if (mismatched.length) console.log('  불일치: ' + mismatched.map((r) => r.n + '번 ' + r.name).join(' · '));

console.log('\n시간 — 시나리오마다 관찰부터 판정까지 한 바퀴 (PRD.md §8 "회차 소요 10초 이내")');
console.log('  ' + replayed.map((r) => r.n + '번 ' + r.ms + 'ms').join(' · '));
console.log('  합계 ' + totalMs + 'ms · 가장 긴 회차 ' + maxMs + 'ms · 상한 ' + CYCLE_BUDGET_MS + 'ms — ' + (over.length ? '넘김 ' + over.length + '개' : '전부 안쪽'));

console.log('\n계획 미커밋 탐지 — 같은 계획서로 임시 저장소를 만들어 `planDirtyBlock` 을 직접 불렀다');
console.log('  커밋 전: ' + probe.dirty);
console.log('  깨끗할 때: ' + (probe.clean === null ? 'null (막지 않는다)' : probe.clean));

console.log('\n격리 — sandbox/fleet/ 파일 ' + before.size + '개');
if (drift.length) {
  console.log('  변한 것 ' + drift.length + '건:');
  for (const d of drift) console.log('    ' + d);
} else {
  console.log('  변한 것 없음 (재생은 읽기다)');
}

// ---------- 결과 파일 ----------
// `/eval` 화면이 읽는 자리 (슬라이스 10). `data/usage/cycles.json` 과 같은 꼴 — 머리에 만든 시각과
// 한 줄 설명, 그 아래에 표로 그릴 배열.
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      note: 'PRD.md §9 시나리오 10개를 픽스처로 재생한 결과. 만든 것은 scripts/eval.mjs (npm run eval).',
      baseline: { caps: { atlas: 3, beacon: 2, cobalt: 3 }, resumeMax: 2 },
      budgetMs: CYCLE_BUDGET_MS,
      counts: { total: SCENARIOS.length, replayed: replayed.length, matched: matched.length, mismatched: mismatched.length, skipped: skipped.length },
      timing: { totalMs, maxMs, overBudget: over.map((r) => r.n) },
      planDirty: { dirty: probe.dirty, clean: probe.clean },
      isolation: { files: before.size, drift },
      scenarios: results,
    },
    null,
    1
  ) + '\n'
);
console.log('\n결과를 남겼다: ' + OUT_FILE.replace(REPO + (process.platform === 'win32' ? '\\' : '/'), ''));

if (drift.length) {
  console.error('\n실패 — 재생이 픽스처를 바꿨다 (위 목록).');
  process.exit(1);
}
if (mismatched.length) {
  console.error('\n불일치 ' + mismatched.length + '건 — 픽스처도 판정 규칙도 고치지 않는다. 표에 그대로 남긴다.');
  process.exit(1);
}
if (over.length) {
  console.error('\n실패 — 회차 소요가 상한을 넘었다: ' + over.map((r) => r.n + '번 ' + r.ms + 'ms').join(' · '));
  process.exit(1);
}
console.log('\n통과 — 재생 ' + replayed.length + '개가 전부 기대와 맞고, 픽스처는 변하지 않았다.');
