// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCycleReport, decisionItems, cycleHandoffPlan, dispatchPlan, handoffRowText, limitStartHold, splitPaused, cycleProject, isNoDispatch, cycleResume, precheckVerdict, precheckText } from '../sp-sync.mjs';
import { landStaleBlock } from '../lib/fleet.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const base = { at: new Date(2026, 7, 30, 16, 45).getTime(), dryRun: false, projects: [] };

test('제목은 로캘이 아니라 YYYY-MM-DD HH:MM', () => {
  const out = renderCycleReport({ ...base, projects: [] });
  assert.match(out, /^## 2026-08-30 16:45 회차\n/);
  assert.doesNotMatch(out, /시 45분/);
});

test('표 넷이 늘 있고, 빈 것은 "없음" 한 줄', () => {
  const out = renderCycleReport({ ...base, projects: [] });
  for (const t of ['착륙', '파견', '막힘', '결정 필요']) assert.match(out, new RegExp('\\*\\*' + t + '\\*\\* — 없음'));
  assert.match(out, /\n---\n\n$/); // 회차마다 구분선으로 끝나 덧붙여도 섞이지 않는다
});

test('착륙·파견·막힘·결정 필요가 각 표로 갈린다', () => {
  const out = renderCycleReport({
    ...base,
    projects: [
      {
        project: 'P',
        land: {
          landed: [{ name: 'slice8', ok: true, pr: 13, ff: true }],
          checks: [
            { name: 'slice9', slice: 9, blocked: true, reason: '유휴인데 9번이 미체크 — 막힘' },
            { name: 'slice7', slice: 7, blocked: false, waiting: '이걸 할지 말지' },
          ],
        },
        dispatch: { dispatched: [{ name: 'slice10', ok: true, text: '/slice 10' }], decisions: [] },
      },
    ],
  });
  assert.match(out, /\| P \| slice8 \| 머지됨 #13 \| 본체 ff \|/);
  assert.match(out, /\| P \| slice10 \| 지시 보냄 \| \/slice 10 \|/);
  assert.match(out, /\| P \| slice9 \| 9 \| 유휴인데 9번이 미체크 — 막힘 \|/);
  assert.match(out, /\| P \| slice7 \(워커 대기\) \| 이걸 할지 말지 \|/);
  assert.match(out, /착륙 1 · 파견 1 · 막힘 1 · 결정 필요 1/);
});

test('dry-run 은 파견 예정을 표에 적는다 — 안 그러면 "될 일 없음"으로 읽힌다', () => {
  const p = { project: 'P', dispatch: { dispatched: [], decisions: [{ number: 13, eligible: true, reason: '활성 워크스페이스 0개', title: 't' }] } };
  assert.match(renderCycleReport({ ...base, dryRun: true, projects: [p] }), /\| P \| slice13 \| 예정 \| 활성 워크스페이스 0개 \|/);
  // 실제 회차에서는 예정이 아니라 결과만 적는다
  assert.match(renderCycleReport({ ...base, dryRun: false, projects: [p] }), /\*\*파견\*\* — 없음/);
});

test('[결정 필요] 슬라이스는 결정 표로 올라간다', () => {
  const out = renderCycleReport({
    ...base,
    projects: [{ project: 'P', dispatch: { dispatched: [], decisions: [{ number: 7, title: '착륙', eligible: false, reason: '결정 필요: push 승인 — 사용자 결정 뒤에' }] } }],
  });
  assert.match(out, /\| P \| 7번 착륙 \| 결정 필요: push 승인/);
});

test('프로젝트 하나가 죽어도 회차는 남고 막힘으로 보고된다', () => {
  const out = renderCycleReport({ ...base, projects: [{ project: 'P', error: 'orca 안 뜸' }, { project: 'Q' }] });
  assert.match(out, /\| P \| - \| - \| orca 안 뜸 \|/);
  assert.match(out, /프로젝트 2\(P, Q\)/);
});

test('번호 없는 슬라이스는 파견하지 않는다 — slicenull 을 만들면 안 된다', () => {
  const s = { number: null, title: 'S1. 실험 1 보존', tags: [], decision: null, done: false, workspace: null };
  const p = dispatchPlan({ slices: [s], workspaces: [], max: 3 });
  assert.equal(p[0].eligible, false);
  assert.match(p[0].reason, /번호가 없어/);
});

test('파이프가 든 이유가 표를 깨지 않는다', () => {
  const out = renderCycleReport({
    ...base,
    projects: [{ project: 'P', land: { landed: [], checks: [{ name: 'w', slice: 1, blocked: true, reason: 'a|b' }] } }],
  });
  assert.match(out, /a\\\|b/);
});

test('단계 끝 — 미체크 0 이고 활성 워크스페이스 0 이면 재계획 결정이 올라간다', () => {
  const done = { project: 'P', dispatch: { dispatched: [], decisions: [], phaseDone: true, active: 0, phase: { title: '2단계' } } };
  const out = renderCycleReport({ ...base, dryRun: true, projects: [done] });
  assert.match(out, /\| P \| 현재 단계 끝 \(2단계\) \| 다음 단계 재계획 필요/);
  assert.match(out, /결정 필요 1/);
  // 미체크가 하나라도 있으면 안 올라간다
  const open = { project: 'P', dispatch: { dispatched: [], decisions: [{ number: 3, title: 't', eligible: false, reason: '이미 돌고 있음 (slice3)' }], phaseDone: false, active: 1 } };
  assert.doesNotMatch(renderCycleReport({ ...base, projects: [open] }), /현재 단계 끝/);
  // 다 체크됐어도 착륙 전(활성 워크스페이스 남음)이면 아직 아니다
  const landing = { project: 'P', dispatch: { dispatched: [], decisions: [], phaseDone: true, active: 1 } };
  assert.doesNotMatch(renderCycleReport({ ...base, projects: [landing] }), /현재 단계 끝/);
});

test('파견 표는 시작한 것만 싣고 실패는 막힘으로 간다', () => {
  // 제출 확인·재전송 열은 2026-08-30 미제출 6건이 남긴 것이고("지시 보냄"만 적으면 화면을 본 것과
  // 안 본 것이 구별되지 않는다), 실패가 파견 표에 남으면 건수가 시도 수가 돼 create 실패 회차가
  // "파견 1" 로 읽힌다 (coordinator 점검 #6).
  const out = renderCycleReport({
    ...base,
    projects: [
      {
        project: 'P',
        dispatch: {
          decisions: [],
          dispatched: [
            { name: 'slice11', slice: 11, ok: true, submit: '제출 확인', text: '/slice 11' },
            { name: 'slice12', slice: 12, ok: true, submit: '재전송 1회', text: '/slice 12' },
            { name: 'slice13', slice: 13, ok: false, submit: '미제출(막힘): unknown', stage: 'send', text: '/slice 13', detail: '' },
          ],
        },
      },
    ],
  });
  assert.match(out, /\| P \| slice11 \| 제출 확인 \| \/slice 11 \|/);
  assert.match(out, /\| P \| slice12 \| 재전송 1회 \| \/slice 12 \|/);
  assert.match(out, /\| P \| slice13 \| 13 \| send 실패 — 미제출\(막힘\): unknown · 보내려던 것: \/slice 13 \|/);
  assert.match(out, /파견 2\(실패 1\) · 막힘 1/);
});

test('일시 제외 — 목록에 있는 프로젝트는 회차 대상에서 빠지고 요약에 이름이 남는다', () => {
  const { names, paused } = splitPaused(['SP-sync', 'Project A', 'coordinator'], ['Project A']);
  assert.deepEqual(names, ['SP-sync', 'coordinator']);
  assert.deepEqual(paused, ['Project A']);
  // 손으로 config.json 에 적을 수 있는 값이라 대소문자·앞뒤 공백을 안 가린다
  assert.deepEqual(splitPaused(['SP-sync'], ['  sp-SYNC ']).paused, ['SP-sync']);
  // 목록이 없거나 배열이 아니면 아무것도 안 뺀다 — 스위치가 없는 것이 기본이다
  for (const v of [undefined, [], null, 'SP-sync']) assert.deepEqual(splitPaused(['SP-sync'], v).names, ['SP-sync']);
  // 요약에 이름이 나와야 "할 일이 없었다"와 구별된다
  const out = renderCycleReport({ ...base, projects: [{ project: 'SP-sync' }], paused });
  assert.match(out, /· 일시 제외 1\(Project A\)/);
  assert.doesNotMatch(renderCycleReport({ ...base, projects: [] }), /일시 제외/);
});

test('번호 없는 슬라이스는 결정 표에 프로젝트당 한 줄로 나온다', () => {
  // 5건을 슬라이스마다 적으면 결정 표가 그것만으로 차서 정작 볼 줄이 묻힌다
  const decisions = [1, 2, 3, 4, 5].map((i) => ({ number: null, title: 'S' + i + '. 실험 ' + i, eligible: false, reason: '제목에 번호가 없어 워크스페이스 이름을 못 정함' }));
  const out = renderCycleReport({ ...base, projects: [{ project: 'PX', dispatch: { dispatched: [], decisions } }] });
  assert.match(out, /\| PX \| 번호 없는 슬라이스 5개 \| 제목에 번호가 없어 영영 파견되지 않음 .* 예: S1\. 실험 1 \|/);
  assert.match(out, /결정 필요 1/);
  // 번호가 있는 보류는 이 줄을 안 만든다
  const ok = { project: 'P', dispatch: { dispatched: [], decisions: [{ number: 3, title: 't', eligible: false, reason: '이미 돌고 있음 (slice3)' }] } };
  assert.doesNotMatch(renderCycleReport({ ...base, projects: [ok] }), /번호 없는 슬라이스/);
});

test('브랜치가 sliceN 이 아닌 워크스페이스가 결정 표에 오른다', () => {
  // blocked 도 waiting 도 아니라 예전에는 어느 표에도 안 올랐다 (slice10-2)
  const out = renderCycleReport({
    ...base,
    projects: [{ project: 'P', land: { landed: [], checks: [{ name: 'slice10-2', slice: null, blocked: false, attention: '브랜치 `u/slice10-2` 가 sliceN 꼴이 아니라 어느 슬라이스인지 모름 — 착륙 판정 밖이다' }] } }],
  });
  assert.match(out, /\| P \| slice10-2 \| 브랜치 .*sliceN 꼴이 아니라 어느 슬라이스인지 모름/);
  assert.match(out, /결정 필요 1/);
  assert.match(out, /\*\*막힘\*\* — 없음/);
});

test('슬라이스로 안 읽힌 체크박스가 있으면 PLAN.md 구문이 결정 표에 오른다', () => {
  const out = renderCycleReport({
    ...base,
    projects: [{ project: 'CW', dispatch: { dispatched: [], decisions: [], planSyntax: 'PLAN.md 구문이 안 맞음 — 체크박스 4줄이 슬라이스로 안 읽힘 (`- [ ] **N. 제목**` 꼴이어야 한다)' } }],
  });
  assert.match(out, /\| CW \| PLAN\.md 구문 \| PLAN\.md 구문이 안 맞음 — 체크박스 4줄이 슬라이스로 안 읽힘/);
  assert.match(out, /결정 필요 1/);
});

// ---------- 한도 게이트와 자동 인계 (슬라이스 13) ----------
const H = 3600000;
const NOW = Date.parse('2026-09-03T12:00:00Z');

/** 한도 한 덩어리. `stillReached` 가 보는 것은 `windows`·`models` 라 그 둘을 진짜로 채운다. */
const lim = (agent, pct, { resetsAt = NOW + 3 * H, models = {}, pct7d = 20 } = {}) => ({
  agent,
  pct5h: pct,
  pct7d,
  resetsAt,
  reached: pct >= 100,
  reachedType: null,
  windows: { fiveHour: { pct, resetsAt }, sevenDay: { pct: pct7d, resetsAt: NOW + 24 * H } },
  models,
});

const ws = (over = {}) => ({
  name: 'slice12',
  path: 'C:/w/slice12',
  slice: 12,
  terminals: ['t1'],
  turn: { known: true, active: false, agent: 'codex', exitCode: 1 },
  ...over,
});
const chk = (over = {}) => ({ name: 'slice12', path: 'C:/w/slice12', slice: 12, blocked: true, ready: false, reason: '헤드리스(codex) 한도 막힘', ...over });
const sl = (over = {}) => ({ number: 12, title: '인계', done: false, tags: [], agent: 'codex', ...over });
const planArgs = (over = {}) => ({
  checks: [chk()],
  workspaces: [ws()],
  slices: [sl()],
  limits: { codex: lim('codex', 100), claude: lim('claude', 30) },
  fallback: { codex: 'claude', claude: 'codex' },
  waitMin: 30,
  agents: { codex: { cmd: 'codex', args: [] } },
  now: NOW,
  ...over,
});

test('인계 — 한도에 막혔고 상대에게 여유가 있으면 넘긴다', () => {
  const rows = cycleHandoffPlan(planArgs());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'handoff');
  assert.equal(rows[0].from, 'codex');
  assert.equal(rows[0].to, 'claude');
  assert.match(handoffRowText(rows[0]), /^인계 → claude — /);
});

test('대기 — 초기화가 fleetLimitWaitMin 안이거나 상대도 막혀 있으면 안 넘긴다', () => {
  // 10분 뒤에 풀릴 것을 남의 손에 넘기지 않는다
  const soon = cycleHandoffPlan(planArgs({ limits: { codex: lim('codex', 100, { resetsAt: NOW + 10 * 60000 }), claude: lim('claude', 30) } }));
  assert.equal(soon[0].action, 'wait');
  assert.match(handoffRowText(soon[0]), /^대기 — 한도 초기화 임박 \(.*10분 뒤\)/);
  // 상대도 100% 면 넘길 곳이 없다
  const both = cycleHandoffPlan(planArgs({ limits: { codex: lim('codex', 100), claude: lim('claude', 100) } }));
  assert.equal(both[0].action, 'wait');
  assert.match(handoffRowText(both[0]), /^대기 — 상대 claude 도 한도 막힘/);
});

test('상대 한도를 모르면 여유로 보고 넘기되 사유에 그 사실을 적는다', () => {
  const rows = cycleHandoffPlan(planArgs({ limits: { codex: lim('codex', 100) } }));
  assert.equal(rows[0].action, 'handoff');
  assert.match(rows[0].reason, /\(상대 한도 모름\)$/);
});

test('fleetFallback 이 비어 있으면 자동 인계가 없다 — 기본값은 지금 동작 그대로', () => {
  assert.deepEqual(cycleHandoffPlan(planArgs({ fallback: {} })), []);
  assert.deepEqual(cycleHandoffPlan(planArgs({ fallback: undefined })), []);
  // 상대가 안 적힌 에이전트도 마찬가지 — 막힘 표에만 남는다
  assert.deepEqual(cycleHandoffPlan(planArgs({ fallback: { claude: 'codex' } })), []);
});

test('막힌 것만 본다 — 자격이 난 워크스페이스와 사람 몫(대기·이름)은 안 건드린다', () => {
  assert.deepEqual(cycleHandoffPlan(planArgs({ checks: [chk({ blocked: false, ready: true })] })), []);
  assert.deepEqual(cycleHandoffPlan(planArgs({ checks: [chk({ blocked: false, waiting: '이걸 할지' })] })), []);
  // 한도가 안 찼으면 그냥 막힌 것이다 — 인계 대상이 아니다
  assert.deepEqual(cycleHandoffPlan(planArgs({ limits: { codex: lim('codex', 40), claude: lim('claude', 30) } })), []);
});

test('한도가 풀린 뒤에는 옛 기록으로 막지 않는다 — landCheck 의 limit 도 지금 시각으로 다시 본다', () => {
  // 래퍼가 남긴 사진(`check.limit`)은 초기화 시각이 지나면 옛것이다 (stillReached)
  const old = lim('codex', 100, { resetsAt: NOW - H });
  const rows = cycleHandoffPlan(
    planArgs({ checks: [chk({ limit: old })], limits: { codex: lim('codex', 20), claude: lim('claude', 30) } })
  );
  assert.deepEqual(rows, []);
});

test('Claude TUI 는 종료 코드가 없으므로 지금 읽은 한도로 가른다', () => {
  const rows = cycleHandoffPlan(
    planArgs({
      checks: [chk({ reason: '유휴인데 12번이 미체크 — 막힘 (재전송하지 않음)' })],
      workspaces: [ws({ turn: { known: true, active: false, agent: 'claude' } })],
      slices: [sl({ agent: 'claude' })],
      limits: { claude: lim('claude', 100), codex: lim('codex', 10) },
    })
  );
  assert.equal(rows[0].action, 'handoff');
  assert.equal(rows[0].from, 'claude');
  assert.equal(rows[0].to, 'codex');
});

test('인계 불가 — 막혔는데 창이 없으면 보고만 한다', () => {
  const rows = cycleHandoffPlan(planArgs({ workspaces: [ws({ terminals: [] })] }));
  assert.equal(rows[0].action, 'blocked');
  assert.match(handoffRowText(rows[0]), /^인계 불가 — .*살아 있는 창이 없음/);
});

test('한도 임박 — 파견 직전 5시간 사용률이 문턱을 넘으면 안 띄운다', () => {
  const hold = (s, limits, over = {}) => limitStartHold(s, limits, { startPct: 95, hardModel: 'fable', ...over });
  const claude = { number: 13, title: 't', tags: [], agent: 'claude' };
  assert.equal(hold(claude, { claude: lim('claude', 60) }), null);
  assert.match(hold(claude, { claude: lim('claude', 97) }), /^한도 임박 — claude 5시간 97%/);
  // **모르면 막지 않는다** (슬라이스 11 과 같은 잣대)
  assert.equal(hold(claude, {}), null);
  assert.equal(hold({ ...claude, agent: 'antigravity' }, { claude: lim('claude', 99) }), null);
  // 0 이면 게이트를 끈다
  assert.equal(hold(claude, { claude: lim('claude', 100) }, { startPct: 0 }), null);
  // `[어려움]` Claude 슬라이스는 Fable 의 모델 한도도 본다 — 5시간이 여유여도 Fable 만 막힐 수 있다
  const fableFull = { claude: lim('claude', 40, { models: { Fable: { pct: 96, resetsAt: NOW + 24 * H } } }) };
  assert.equal(hold({ ...claude, tags: [] }, fableFull), null);
  assert.match(hold({ ...claude, tags: ['hard'] }, fableFull), /fable 96%/);
  // 헤드리스 슬라이스는 제 에이전트의 한도를 본다
  assert.match(hold({ number: 13, title: 't', tags: [], agent: 'codex' }, { codex: lim('codex', 99), claude: lim('claude', 10) }), /^한도 임박 — codex/);
});

test('한도 임박은 태그·상한보다 먼저 보고, 파견 판정에서 보류로 나온다', () => {
  const s = { number: 13, title: 't', tags: [], deps: [], agent: 'claude', done: false, workspace: null };
  const p = dispatchPlan({ slices: [s], workspaces: [], max: 3, limitHold: () => '한도 임박 — claude 5시간 97% (fleetLimitStartPct 95%)' });
  assert.equal(p[0].eligible, false);
  assert.match(p[0].reason, /^한도 임박/);
  // 게이트가 없으면 그대로 뜬다
  assert.equal(dispatchPlan({ slices: [s], workspaces: [], max: 3 })[0].eligible, true);
});

test('회차 보고 — 인계·대기·한도 임박 세 갈래가 결정 표에 찍힌다', () => {
  const rows = [
    { name: 'slice12', from: 'codex', to: 'claude', action: 'handoff', reason: 'codex 한도 막힘 — claude 인계 가능', result: { ok: true, submit: '제출 확인' } },
    { name: 'slice14', from: 'claude', to: 'codex', action: 'wait', reason: '상대 codex 도 한도 막힘 (초기화 14:30) — 대기' },
  ];
  const out = renderCycleReport({
    ...base,
    projects: [
      {
        project: 'P',
        handoff: { rows },
        dispatch: { dispatched: [], decisions: [{ number: 15, title: '다음 것', eligible: false, reason: '한도 임박 — claude 5시간 97% (fleetLimitStartPct 95%)' }] },
      },
    ],
  });
  assert.match(out, /\| P \| slice12 \(codex\) \| 인계 → claude — codex 한도 막힘 — claude 인계 가능 · 제출 확인 \|/);
  assert.match(out, /\| P \| slice14 \(claude\) \| 대기 — 상대 codex 도 한도 막힘 \(초기화 14:30\) — 대기 \|/);
  assert.match(out, /\| P \| 15번 다음 것 \| 한도 임박 — claude 5시간 97%/);
  // 인계는 결정 표 안에 있지만 요약에 따로 센다 — "결정 필요 3" 에 묻히면 안 되는 사건이다
  assert.match(out, /결정 필요 3 · 인계 2/);
  assert.doesNotMatch(renderCycleReport({ ...base, projects: [{ project: 'P' }] }), /· 인계 /);
});

// 2026-09-04 — slice2 가 PR 머지된 12초 뒤 같은 회차가 slice2 를 다시 띄웠다. 착륙 뒤 본체
// `pull --ff-only` 가 갈라짐으로 실패해 본체 PLAN.md 에 `[x]` 가 안 들어왔는데 파견이 그 파일을 읽었다.
test('착륙 뒤 본체 ff 가 실패하면 그 회차의 파견을 건너뛴다', () => {
  const why = landStaleBlock({ landed: [{ name: 'slice2', ok: true, ff: false }] });
  assert.match(why, /^착륙 뒤 본체 ff 실패/);
  assert.match(why, /\(slice2\)/);
});

test('본체 ff 가 됐거나 정상 건너뜀(다른 브랜치)이면 파견을 막지 않는다', () => {
  assert.equal(landStaleBlock({ landed: [{ name: 'slice2', ok: true, ff: true }] }), null);
  assert.equal(landStaleBlock({ landed: [{ name: 'slice2', ok: true, ff: false, ffSkipped: '본체가 feat 에 있음' }] }), null);
  // 머지 자체가 실패한 건 본체 PLAN.md 가 옛것이 아니다 — 이 게이트의 일이 아니다
  assert.equal(landStaleBlock({ landed: [{ name: 'slice2', ok: false, stage: 'merge' }] }), null);
  assert.equal(landStaleBlock({ landed: [] }), null);
  assert.equal(landStaleBlock(undefined), null);
});

test('회차 보고 — 파견 건너뜀 사유가 프로젝트마다 다르면 사유별 한 줄', () => {
  const out = renderCycleReport({
    ...base,
    projects: [
      { project: 'A', dispatchSkipped: '회차 코드 갱신됨 — 파견은 다음 회차' },
      { project: 'B', dispatchSkipped: '착륙 뒤 본체 ff 실패 — 본체 PLAN.md 가 옛것이라 파견은 다음 회차 (slice2)' },
      { project: 'C', dispatchSkipped: '회차 코드 갱신됨 — 파견은 다음 회차' },
    ],
  });
  assert.match(out, /⚠ 회차 코드 갱신됨 — 파견은 다음 회차 \(A, C\)/);
  assert.match(out, /⚠ 착륙 뒤 본체 ff 실패 — .* \(slice2\) \(B\)/);
});

// --- 슬라이스 36: 계획 오류·모르는 에이전트도 결정 표에 남는다 ---
// 안 올리면 그 슬라이스는 매 회차 조용히 건너뛰어져 아무도 오타를 못 본다 (coordinator 점검 #2).
test('계획 오류·모르는 에이전트 보류가 결정 표에 오른다', () => {
  const out = renderCycleReport({
    ...base,
    projects: [
      {
        project: 'P',
        dispatch: {
          dispatched: [],
          decisions: [
            { number: 11, title: '오타 태그', eligible: false, reason: '계획 오류: 모르는 태그 [결정필요: 승인]' },
            { number: 12, title: '헤드리스', eligible: false, reason: '모르는 에이전트: codx — config.json 의 fleetAgents 에 없다' },
            { number: 13, title: '멀쩡', eligible: false, reason: '동시 상한 3개를 채움' },
          ],
        },
      },
    ],
  });
  assert.match(out, /\| P \| 11번 오타 태그 \| 계획 오류: 모르는 태그/);
  assert.match(out, /\| P \| 12번 헤드리스 \| 모르는 에이전트: codx/);
  // 저절로 풀리는 보류(상한)는 결정 표에 안 올린다 — 올리면 표가 그것으로 찬다
  assert.doesNotMatch(out, /13번 멀쩡/);
  assert.match(out, /결정 필요 2/);
});

// --- 슬라이스 37: 결정 항목은 한 곳에서 난다 (coordinator 점검 #3·#6) ---
// 예전에는 보고의 표와 통지 판정이 각각 세어, 표에는 오르는데 아무도 안 깨우는 상황이 다섯 있었다.

test('노트 #3 의 다섯 상황이 저마다 결정 항목 키 하나가 된다', () => {
  const out = {
    ...base,
    projects: [
      { project: 'A', dispatch: { dispatched: [], decisions: [], phaseDone: true, active: 0, phase: { title: '8단계' } } },
      { project: 'B', dispatch: { dispatched: [], decisions: [], planSyntax: 'PLAN.md 구문이 안 맞음 — 체크박스 4줄이 슬라이스로 안 읽힘' } },
      { project: 'C', dispatch: { dispatched: [], decisions: [{ number: 15, title: '다음 것', eligible: false, reason: '한도 임박 — claude 5시간 97%' }] } },
      { project: 'D', dispatch: { dispatched: [], decisions: [], planBlock: 'PLAN.md 가 커밋 전이다' } },
      { project: 'E', dispatch: { dispatched: [], decisions: [{ number: 12, title: '헤드리스', eligible: false, reason: '모르는 에이전트: codx — config.json 의 fleetAgents 에 없다' }] } },
    ],
  };
  assert.deepEqual(
    decisionItems(out).map((i) => i.key),
    ['stage-done:A:', 'plan-syntax:B:', 'limit-hold:C:15', 'plan-dirty:D:', 'unknown-agent:E:12']
  );
  // 다섯 다 사람 몫이고 막힘이 아니다 — 결정 표에 그대로 오른다
  assert.ok(decisionItems(out).every((i) => i.needsUser && !i.blocked));
  assert.match(renderCycleReport(out), /결정 필요 5/);
});

test('같은 상황이 이어지면 같은 키, 풀리면 사라진다 — 회차 사이 비교의 단위', () => {
  const p = (reason) => ({ ...base, projects: [{ project: 'P', dispatch: { dispatched: [], decisions: [{ number: 7, title: 't', eligible: false, reason }] } }] });
  const a = decisionItems(p('결정 필요: push 승인 — 사용자 결정 뒤에'));
  const b = decisionItems(p('결정 필요: push 승인 — 사용자 결정 뒤에 (다시)'));
  assert.deepEqual(a.map((i) => i.key), b.map((i) => i.key)); // 사유 문장이 조금 달라져도 같은 키다
  assert.deepEqual(decisionItems(p('동시 상한 3개를 채움')), []); // 저절로 풀리는 보류는 항목이 아니다
  assert.equal(a[0].type, 'decision-tag');
  assert.equal(a[0].slice, 7);
});

test('저절로 다시 보는 것은 needsUser 가 아니다 — 막힘·인계 성공·인계 대기', () => {
  const items = decisionItems({
    ...base,
    projects: [
      {
        project: 'P',
        land: { landed: [], checks: [{ name: 'slice9', slice: 9, blocked: true, reason: '유휴인데 9번이 미체크 — 막힘' }] },
        handoff: {
          rows: [
            { name: 'slice12', from: 'codex', to: 'claude', action: 'handoff', reason: 'codex 한도 막힘', result: { ok: true, submit: '제출 확인' } },
            { name: 'slice14', from: 'claude', to: 'codex', action: 'wait', reason: '상대도 한도 막힘' },
            { name: 'slice15', from: 'codex', to: 'claude', action: 'blocked', reason: '살아 있는 창이 없음' },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    items.map((i) => [i.type, i.needsUser, i.blocked]),
    [
      ['land-blocked', false, true],
      ['handoff-handoff', false, false],
      ['handoff-wait', false, false],
      ['handoff-blocked', true, false],
    ]
  );
});

test('생성 실패는 파견 0(실패 1) 이고 dispatch-failed 키가 난다', () => {
  // 2026-09-08 14:43 Project A — create 실패인데 요약이 "파견 1 · 막힘 0 · 결정 필요 0" 이었다
  const out = {
    ...base,
    projects: [
      {
        project: 'CW',
        dispatch: {
          decisions: [],
          dispatched: [{ name: 'slice9', slice: 9, ok: false, outcome: 'failed', stage: 'create', detail: 'orca worktree create 시간 초과', text: '/slice 9' }],
        },
      },
    ],
  };
  assert.deepEqual(decisionItems(out).map((i) => i.key), ['dispatch-failed:CW:9']);
  const r = renderCycleReport(out);
  assert.match(r, /파견 0\(실패 1\) · 막힘 1/);
  assert.match(r, /\| CW \| slice9 \| 9 \| create 실패 — orca worktree create 시간 초과 · 보내려던 것: \/slice 9 \|/);
  assert.match(r, /\*\*파견\*\* — 없음/);
});

test('즉시 종료한 헤드리스 워커도 시작 성공으로 안 남는다', () => {
  const out = {
    ...base,
    projects: [
      {
        project: 'P',
        dispatch: {
          decisions: [],
          dispatched: [{ name: 'slice6', slice: 6, ok: true, outcome: 'exited', submit: '래퍼 실행 (codex) — 즉시 종료 exit 75', text: 'worker --agent codex --slice 6' }],
        },
      },
    ],
  };
  assert.deepEqual(decisionItems(out).map((i) => i.type), ['dispatch-failed']);
  const r = renderCycleReport(out);
  assert.match(r, /파견 0\(즉시 종료 1\)/);
  assert.match(r, /\| P \| slice6 \| 6 \| 래퍼 실행 \(codex\) — 즉시 종료 exit 75 · 보내려던 것/);
});

test('착륙 실패도 결정 항목이 된다 — 충돌과 그 밖이 다른 유형', () => {
  const items = decisionItems({
    ...base,
    projects: [
      {
        project: 'P',
        land: {
          landed: [
            { name: 'slice8', slice: 8, ok: false, stage: 'conflict', needsUser: true },
            { name: 'slice9', slice: 9, ok: false, stage: 'push' },
            { name: 'slice10', slice: 10, ok: true, pr: 3, ff: true },
          ],
          checks: [],
        },
      },
    ],
  });
  assert.deepEqual(items.map((i) => i.key), ['conflict:P:8', 'land-failed:P:9']);
  assert.match(items[0].reason, /사용자 결정 필요/);
});

// --- 슬라이스 41: 파견 제외(`fleetNoDispatch`)는 동기화만 한다 ---
// 이름 'coordinator' 이 코드에 박혀 있던 동안 그 저장소는 **동기화까지** 회차 밖이었고, 팀장이 직접
// 커밋하는 본체가 15 커밋 밀린 채 있었다. 파견 제외와 동기화 제외(`fleetPause`)는 다른 스위치다.

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();

/** 원격(bare) 하나 + `<이름>` 본체 하나. 동기화도 판정도 git 이 하는 일이라 실제 저장소로 잰다. */
function repo(name) {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-nodispatch-'));
  const remote = join(dir, 'remote.git');
  const root = join(dir, name);
  mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '--initial-branch=master'], remote);
  git(['clone', remote, root], dir);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  writeFileSync(join(root, 'PLAN.md'), '- [ ] **1. 첫 슬라이스**\n', 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-m', 'init'], root);
  git(['push', '-u', 'origin', 'master'], root);
  git(['remote', 'set-head', 'origin', '-a'], root);
  return { dir, root };
}

test('이름 비교는 `fleetPause` 와 같은 잣대 — 대소문자·공백을 안 가린다', () => {
  assert.equal(isNoDispatch('coordinator', ['  coordinaTOR ']), true);
  assert.equal(isNoDispatch('SP-sync', ['coordinator']), false);
  for (const v of [undefined, [], null, 'coordinator']) assert.equal(isNoDispatch('coordinator', v), false, String(v));
});

test('파견 제외 프로젝트는 회차가 동기화(push)만 하고 착륙·인계·파견을 건너뛴다', async () => {
  const { dir, root } = repo('coordinator');
  try {
    writeFileSync(join(root, 'notes.md'), '팀장이 직접 쓴 것\n', 'utf8');
    git(['add', '-A'], root);
    git(['commit', '-m', '팀장 커밋'], root);
    const ctx = { opts: {}, c: { fleetNoDispatch: ['coordinator'] }, base: null, limits: {}, codeAt: null, out: {} };
    const p = await cycleProject(root, ctx);
    assert.equal(p.syncOnly, true);
    assert.equal(p.sync.action, 'push', p.sync.text || p.error);
    assert.equal(p.sync.ahead, 1);
    assert.equal(git(['rev-list', '--count', 'origin/master..HEAD'], root), '0', '실제로 올라갔다');
    // 착륙·인계·파견은 아예 안 돈다 — 워크스페이스도 슬라이스도 읽지 않는다
    for (const k of ['land', 'handoff', 'dispatch']) assert.equal(p[k], undefined, k);
    assert.equal(p.error, undefined);
    // 결정 항목 0 — 통지(precheck)가 이 프로젝트 때문에 팀장을 깨우지 않는다
    assert.deepEqual(decisionItems({ projects: [p] }), []);
    // 보고에 한 줄. 안 적으면 "회차가 돌았는데 할 일이 없었다" 와 구별되지 않는다
    const md = renderCycleReport({ ...base, projects: [{ ...p, project: 'coordinator' }] });
    assert.match(md, /동기화만 — coordinator \(fleetNoDispatch/);
    assert.match(md, /본체 — coordinator: push 1 커밋/);
    assert.match(md, /착륙 0 · 파견 0 · 막힘 0 · 결정 필요 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 목록에 없으면 평소대로 착륙·파견을 시도한다 — 여기서는 워크스페이스가 없어 0건이지만,
// `syncOnly` 가 안 붙고 `land`·`dispatch` 결과가 실제로 생긴다는 것이 이 줄의 요점이다.
test('목록에 없는 프로젝트는 그대로 착륙·파견을 돈다', async () => {
  const { dir, root } = repo('Demo');
  try {
    const ctx = { opts: {}, c: { fleetNoDispatch: ['coordinator'] }, base: null, limits: {}, codeAt: null, out: {} };
    const p = await cycleProject(root, ctx);
    assert.equal(p.syncOnly, undefined);
    assert.notEqual(p.land, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 슬라이스 46: dry-run 도 같은 사유를 내야 한다 ---
// 회차는 자원 예약과 전역 활성 수를 한 번 세어 `ctx` 로 나른다. 실제 파견은 띄운 것으로 갱신하는데,
// dry-run 은 아무것도 안 띄우므로 갱신이 없으면 앞 프로젝트가 집을 자원·자리를 뒤 프로젝트가 못 본다 —
// 같은 자원을 쓰는 두 프로젝트가 dry-run 에서만 둘 다 "파견 예정" 으로 나온다.

test('dry-run 도 띄울 것으로 ctx(자원·전역 수)를 갱신한다', async () => {
  const { dir, root } = repo('Demo');
  try {
    const deps = {
      runLand: async () => ({ landed: [], checks: [] }),
      runResume: async () => ({ rows: [] }),
      runHandoff: async () => ({ rows: [] }),
      runDispatch: async () => ({
        project: 'Demo',
        dispatched: [],
        decisions: [
          { number: 7, eligible: true, redispatch: null, resources: ['실측'] },
          { number: 8, eligible: false, redispatch: null, resources: ['실측'], reason: '자원 점유: 실측 — Demo slice7' },
          { number: 9, eligible: true, redispatch: 'slice9', resources: [] },
        ],
      }),
    };
    const ctx = { opts: { dryRun: true }, c: { fleetNoDispatch: [] }, base: null, limits: {}, codeAt: null, out: {}, deps, held: {}, total: 1 };
    await cycleProject(root, ctx);
    // 재파견은 새 워크스페이스를 안 만든다 — 전역 수에 안 센다
    assert.equal(ctx.total, 2);
    assert.deepEqual(Object.keys(ctx.held), ['실측']);
    assert.equal(ctx.held['실측'].slice, 7);
    assert.equal(ctx.held['실측'].project, 'Demo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 슬라이스 43: 회차 순서에 재개 단계 — 착륙 → 재개 → 인계 → 파견 ---
// 한도가 풀린 워크스페이스는 `limitStuckOf` 가 null 이라 인계 판정에 안 걸린다. 그 자리를 재개가 맡으므로
// 인계보다 앞이어야 하고, 파견보다 앞이어야 깨운 창이 그 회차의 활성 수에 세어진다.
test('회차는 착륙 → 재개 → 인계 → 파견 순으로 돌고, 재개 단계에 시도 상한·프로젝트 이름을 준다', async () => {
  const { dir, root } = repo('Demo');
  try {
    const order = [];
    let resumeOpts = null;
    const deps = {
      runLand: async () => (order.push('land'), { landed: [], checks: [] }),
      runResume: async (snap, o) => (order.push('resume'), (resumeOpts = o), { rows: [] }),
      runHandoff: async () => (order.push('handoff'), { rows: [] }),
      runDispatch: async () => (order.push('dispatch'), { dispatched: [], decisions: [] }),
    };
    const ctx = { opts: {}, c: { fleetResumeMax: 3, fleetNoDispatch: [] }, base: null, limits: {}, codeAt: null, out: {}, deps };
    const p = await cycleProject(root, ctx);
    assert.equal(p.error, undefined);
    assert.deepEqual(order, ['land', 'resume', 'handoff', 'dispatch']);
    assert.equal(resumeOpts.max, 3);
    assert.equal(resumeOpts.project, 'Demo');
    assert.deepEqual(p.resume, { rows: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('회차 보고 — 재개 성공은 요약·한 줄로, 소진·불가는 결정 표로, 전송 실패는 결정 표(사람 몫 아님)로', () => {
  const rows = [
    { name: 'slice12', slice: 12, agent: 'claude', action: 'resume', reason: '"이어서 진행해" 전송 (1/2)', result: { ok: true, submit: '제출 확인' } },
    { name: 'slice13', slice: 13, agent: 'codex', action: 'exhausted', reason: '재개 2회 실패 — 사람이 볼 것' },
    { name: 'slice14', slice: 14, agent: 'claude', action: 'blocked', reason: '창이 없음' },
    { name: 'slice15', slice: 15, agent: 'claude', action: 'resume', reason: '"이어서 진행해" 전송 (2/2)', result: { ok: false, stage: 'send', detail: '미제출' } },
    { name: 'slice16', slice: 16, agent: 'claude', action: 'wait', reason: '초기화 전 (14:30)' },
    { name: 'slice17', slice: 17, agent: 'claude', action: 'drop', reason: '17번이 본체 PLAN.md 에서 체크됨' },
  ];
  const p = { project: 'P', resume: { rows } };
  const items = decisionItems({ projects: [p] });
  assert.deepEqual(items.map((i) => [i.key, i.needsUser, i.blocked]), [
    ['resume-exhausted:P:13', true, false],
    ['resume-blocked:P:14', true, false],
    ['resume-failed:P:15', false, false],
  ]);
  assert.match(items[0].reason, /^재개 포기 — 재개 2회 실패/);
  const md = renderCycleReport({ ...base, projects: [p] });
  assert.match(md, /착륙 0 · 파견 0 · 막힘 0 · 결정 필요 3 · 재개 1/);
  assert.match(md, /\n재개 — P: 재개 — "이어서 진행해" 전송 \(1\/2\) · 제출 확인\n/);
  assert.match(md, /\| P \| slice13 \(codex\) \| 재개 포기 — 재개 2회 실패 — 사람이 볼 것 \|/);
  assert.match(md, /\| P \| slice15 \(claude\) \| 재개 — .* · send 실패: 미제출 \|/);
  // 대기·삭제는 어느 표에도 안 오른다 — 회차마다 되풀이될 줄이다
  assert.doesNotMatch(md, /slice16|slice17/);
  // precheck: 재개 성공은 파견처럼 변화로 세고, 소진·불가는 새 결정으로 깨운다
  const v = precheckVerdict({ at: base.at, projects: [p] }, {});
  assert.equal(v.resumed, 1);
  assert.deepEqual(v.fresh.map((i) => i.key), ['resume-exhausted:P:13', 'resume-blocked:P:14']);
  assert.match(precheckText(v, { projects: ['P'] }), /파견 0 · 재개 1 · 깨움/);
  // dry-run 은 예정으로 적는다
  const dry = renderCycleReport({ ...base, dryRun: true, projects: [{ project: 'P', resume: { rows: [{ ...rows[0], result: undefined }] } }] });
  assert.match(dry, /재개 — P: 재개 — "이어서 진행해" 전송 \(1\/2\) \(예정\)/);
});

test('cycleResume — 항목을 읽어 판정하고, resume 만 깨우며, 시도를 세고, drop·exhausted 는 지운다', async () => {
  const calls = [];
  const table = {
    slice12: { name: 'slice12', workspace: 'C:/w/slice12', slice: 12, agent: 'claude', terminal: 't1', resetsAt: NOW - H, attempts: 0, at: NOW - 2 * H, reason: '대기' },
    slice13: { name: 'slice13', workspace: 'C:/w/slice13', slice: 13, agent: 'codex', terminal: null, resetsAt: NOW - H, attempts: 2, at: NOW - 2 * H, reason: '대기' },
    slice14: { name: 'slice14', workspace: 'C:/w/slice14', slice: 14, agent: 'codex', terminal: null, resetsAt: NOW - H, attempts: 0, at: NOW - 2 * H, reason: '상대 없음' },
  };
  const deps = {
    entries: () => Object.values(table),
    bump: (project, name) => (calls.push(['bump', project, name]), { ...table[name], attempts: table[name].attempts + 1 }),
    drop: (project, name) => (calls.push(['drop', project, name]), true),
    liveTerminals: () => new Set(['t1']),
    cardOf: () => null,
    idle: () => true,
    wake: async (h, t) => (calls.push(['wake', h, t]), { result: 'submitted', detail: '' }),
    createTerminal: (path, title, command) => (calls.push(['create', path, title, command]), 'h2'),
    closeExtraTabs: () => null,
  };
  const snap = {
    project: 'SP-sync',
    slices: [
      { number: 12, tags: [], done: false, agent: 'claude' },
      { number: 13, tags: [], done: false, agent: 'codex' },
      { number: 14, tags: ['hard'], done: false, agent: 'codex' },
    ],
    workspaces: [
      { name: 'slice12', path: 'C:/w/slice12', slice: 12, terminals: ['t1'], turn: { known: true, active: false, agent: 'claude' } },
      { name: 'slice13', path: 'C:/w/slice13', slice: 13, terminals: [], turn: { known: true, active: false, agent: 'codex', exitCode: 1 } },
      { name: 'slice14', path: 'C:/w/slice14', slice: 14, terminals: [], turn: { known: true, active: false, agent: 'codex', exitCode: 1 } },
    ],
  };
  const opts = { now: NOW, limits: { claude: lim('claude', 30), codex: lim('codex', 30) }, agents: { codex: { cmd: 'codex', args: [] } }, max: 2, project: 'SP-sync' };
  const out = await cycleResume(snap, opts, deps);
  assert.deepEqual(out.rows.map((r) => [r.name, r.action]), [['slice12', 'resume'], ['slice13', 'exhausted'], ['slice14', 'resume']]);
  assert.equal(out.rows[0].result.ok, true);
  assert.equal(out.rows[0].attempts, 1);
  assert.equal(out.rows[2].result.handle, 'h2');
  // 헤드리스는 파견과 같은 래퍼 명령 — `[어려움]` 이면 --hard
  assert.match(out.rows[2].result.command, /worker --agent codex --slice 14 --hard$/);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [
    ['wake', 't1', '이어서 진행해'],
    ['bump', 'SP-sync', 'slice12'],
    ['drop', 'SP-sync', 'slice13'],
    ['create', 'C:/w/slice14', 'slice14 재개 codex'],
    ['bump', 'SP-sync', 'slice14'],
  ]);
  // dry-run 은 판정만 — 깨우지도 세지도 지우지도 않는다
  calls.length = 0;
  const dry = await cycleResume(snap, { ...opts, dryRun: true }, deps);
  assert.equal(dry.rows.length, 3);
  assert.deepEqual(calls, []);
  // 항목이 없으면 창 목록도 안 읽는다
  const none = await cycleResume(snap, opts, { ...deps, entries: () => [], liveTerminals: () => { throw new Error('안 불러야 함'); } });
  assert.deepEqual(none.rows, []);
});
