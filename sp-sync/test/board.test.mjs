// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBoard } from '../sp-sync.mjs';
import { pickCards } from '../lib/hooks.mjs';

const card = { at: Date.now(), now: '방금 끝낸 것', wait: '이걸 할지 말지', next: '이어서 할 것', commits: ['커밋 A'] };
const tasks = [{ id: 't1', title: '태스크 하나', when: '오늘' }];

test('기본 모양 — 세 줄과 한 일·남은 일이 모두 나온다', () => {
  const s = renderBoard('P', [card], tasks);
  assert.match(s, /## 지금 · 방금 끝낸 것/);
  assert.match(s, /## 대기 · 이걸 할지 말지/);
  assert.match(s, /## 다음 · 이어서 할 것/);
  assert.match(s, /### 한 일/);
  assert.match(s, /### 남은 일/);
});

test('planOnly — 대기만 남고 나머지는 전부 빠진다', () => {
  const s = renderBoard('P', [card], tasks, { planOnly: true });
  assert.match(s, /## 대기 · 이걸 할지 말지/);
  assert.doesNotMatch(s, /지금 ·|다음 ·|한 일|남은 일|커밋 A|태스크 하나/);
});

test('planOnly — 대기가 없으면 그 사실만 한 줄', () => {
  const s = renderBoard('P', [{ ...card, wait: '' }], tasks, { planOnly: true });
  assert.match(s, /_대기 없음 — 진행은 PLAN.md_/);
  assert.doesNotMatch(s, /## /);
});

// 2026-09-04 — 팀장 자동 회차는 커밋을 안 해 카드가 전부 worked:false. "일한 창 우선" 이 그 카드를
// 2시간 동안 옛 커밋 카드 뒤에 숨겨 결정 5건이 status.md 에 안 떴다. 결정을 기다리는 카드가 제일 먼저다.
test('결정을 기다리는 카드는 일한 카드보다 먼저 뜬다', () => {
  const now = Date.now();
  const workedOld = { at: now - 30 * 60000, cwd: 'C:/p', worked: true, now: '커밋함', wait: '', commits: ['커밋 A'] };
  const waitingNew = { at: now, cwd: 'C:/p', worked: false, now: '회차 돌림', wait: '결정 5건', commits: [] };
  const picked = pickCards([waitingNew, workedOld]);
  assert.equal(picked[0], waitingNew);
  const s = renderBoard('P', picked, [], { planOnly: true });
  assert.match(s, /## 대기 · 결정 5건/);
});

test('기다리는 카드가 없으면 예전 규칙 그대로 — 일한 창 우선', () => {
  const now = Date.now();
  const workedOld = { at: now - 30 * 60000, cwd: 'C:/p', worked: true, wait: '', commits: ['커밋 A'] };
  const idleNew = { at: now, cwd: 'C:/p', worked: false, wait: '' };
  assert.equal(pickCards([idleNew, workedOld])[0], workedOld);
  // `wait` 가 "없음" 류면 기다리는 게 아니다
  assert.equal(pickCards([{ ...idleNew, wait: '없음' }, workedOld])[0], workedOld);
});
