// node --test sp-sync/test/*.test.mjs
// 슬라이스 44 — 마감·예상 단위 정리. 표의 `예상`·`차이` 두 칸이 **같은 것을 재게** 하는 판정들:
// 예상의 기준점(`fleetEta`), 태스크↔단계 연결(`linkTaskToStage`), 차이(`fleetGapOf`), 줄 순서(`sortFleetRows`).
// 전부 순수 함수거나 임시 폴더의 PLAN.md 하나만 읽는다 — SP·Orca·git 을 안 탄다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fleetEta, fleetGapOf, gapText, linkTaskToStage, planStageNumber, parsePlanSlices, sortFleetRows } from '../sp-sync.mjs';

const PLAN9 = [
  '# 계획',
  '',
  '## 8단계 완료 (2026-09-09, 슬라이스 34~40 — …) — 본문은 `PLAN-archive.md`',
  '',
  '## 9단계 — 재개·자원·의미 정리',
  '',
  '- [x] **41. 동기화 정책 분리**',
  '- [ ] **44. 마감·예상 단위 정리**',
  '- [ ] **45. 직접 Codex 세션 계약**',
  '',
].join('\n');

const withPlan = (text, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-eta-'));
  try {
    if (text != null) writeFileSync(join(dir, 'PLAN.md'), text);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// --- (1) 기준점 ---

// 며칠 멈춘 프로젝트의 기준점을 마지막 활동으로 잡으면 예상이 **과거**로 나온다. 그러면 지난 마감과의
// 차이가 실제보다 늦은 쪽으로 벌어져 멈춘 프로젝트마다 ⚠ 가 붙는다.
test('예상 기준점 — 마지막 활동이 지났으면 지금부터 잰다', () => {
  const now = new Date(2026, 8, 9, 12, 0).getTime();
  const stale = now - 5 * 86400000;
  withPlan('- [ ] 1\n- [ ] 2\n', (dir) => {
    const eta = fleetEta(dir, stale, now);
    assert.equal(eta.from, now);
    assert.ok(eta.at > now, '예상이 지금보다 뒤여야 한다');
  });
});

test('예상 기준점 — 마지막 활동이 앞이면(막 커밋했으면) 그쪽을 쓴다', () => {
  const now = new Date(2026, 8, 9, 12, 0).getTime();
  const future = now + 3600000; // 시계 어긋남·미래 커밋
  withPlan('- [ ] 1\n', (dir) => {
    assert.equal(fleetEta(dir, future, now).from, future);
  });
});

// --- (2) 태스크 ↔ 단계 연결 ---

test('단계 번호 — 현재 단계는 첫 미체크 절이고, 접힌 완료 절이 아니다', () => {
  assert.equal(planStageNumber(parsePlanSlices(PLAN9)), 9);
  assert.equal(planStageNumber(parsePlanSlices('## 나중에\n\n- [ ] a\n')), null);
  assert.equal(planStageNumber(null), null);
});

// 실제 제목이 `SP-sync 8단계 자동 머지`·`8단계 계획 검토`·`PLAN 1단계 검토` 로 제각각이라
// 자리를 고정하면 절반이 안 걸린다 (2026-09-09 `~/.sp-sync/candidates/`).
test('연결 — 제목 어디에 있어도 걸리고, 다른 단계는 안 걸린다', () => {
  const plan = parsePlanSlices(PLAN9);
  assert.equal(linkTaskToStage({ title: 'SP-sync 9단계 자동 머지' }, plan), true);
  assert.equal(linkTaskToStage({ title: '9단계 계획 검토' }, plan), true);
  assert.equal(linkTaskToStage({ title: 'PLAN 9단계 검토' }, plan), true);
  assert.equal(linkTaskToStage({ title: '8단계 계획 검토' }, plan), false, '지난 단계는 연결이 아니다');
  assert.equal(linkTaskToStage({ title: '머지 충돌 해결' }, plan), false);
  assert.equal(linkTaskToStage({ title: '9단계 계획 검토' }, null), false);
  assert.equal(linkTaskToStage({ title: '19단계 계획' }, 9), false, '19 를 9 로 읽지 않는다');
});

// --- (3) 차이 ---

test('차이 — 연결된 마감 태스크가 없으면 산정 불가다', () => {
  const plan = parsePlanSlices(PLAN9);
  const eta = { at: new Date(2026, 8, 12, 12, 0).getTime(), basis: '미체크 2 × …' };
  const g = fleetGapOf([{ title: '8단계 자동 머지', due: '2026-09-08' }], plan, eta);
  assert.equal(g.gap, null);
  assert.equal(g.why, '9단계 마감 태스크 없음');
  assert.equal(gapText(g.gap), '산정 불가');
});

test('차이 — 가장 급한 태스크가 연결 안 돼도 연결된 것 중 가장 이른 마감으로 잰다', () => {
  const plan = parsePlanSlices(PLAN9);
  const eta = { at: new Date(2026, 8, 12, 12, 0).getTime(), basis: '미체크 2 × …' };
  const tasks = [
    { title: '8단계 자동 머지', due: '2026-09-01' }, // 더 급하지만 지난 단계 — 안 쓴다
    { title: '9단계 마무리', due: '2026-09-20' },
    { title: 'SP-sync 9단계 계획 검토', due: '2026-09-14' },
  ];
  const g = fleetGapOf(tasks, plan, eta);
  assert.equal(g.task.due, '2026-09-14');
  assert.ok(g.gap > 0, '마감이 예상보다 뒤면 양수');
  assert.equal(gapText(g.gap), '+2.5d');
});

test('차이 — 예상이 없으면(미체크 0·PLAN.md 없음) 그 사유가 그대로 근거가 된다', () => {
  const plan = parsePlanSlices(PLAN9);
  const done = { at: null, basis: '미체크 0 — 단계 끝' };
  assert.equal(fleetGapOf([{ title: '9단계 검토', due: '2026-09-14' }], plan, done).why, '미체크 0 — 단계 끝');
  assert.equal(fleetGapOf([], null, done).why, 'PLAN.md 없음');
});

// --- (4) 줄 순서 ---

test('순서 — 차이 음수 → 양수 → 산정 불가', () => {
  const row = (project, gap, at) => ({ project, gap, terminals: [], due: { nearest: null }, card: { at } });
  const rows = [
    row('산정불가-옛', null, 100),
    row('여유', 3 * 86400000, 900),
    row('산정불가-새', null, 800),
    row('많이늦음', -2 * 86400000, 200),
    row('조금늦음', -1 * 86400000, 300),
  ];
  assert.deepEqual(
    sortFleetRows(rows).map((r) => r.project),
    ['많이늦음', '조금늦음', '여유', '산정불가-새', '산정불가-옛'],
  );
});
