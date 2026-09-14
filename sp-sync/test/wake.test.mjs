// node --test sp-sync/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWakeAt, checkSubmitted, planCounts, fleetEta, fleetGap, screenUnavailable, wakeOne } from '../sp-sync.mjs';
import { readScreen } from '../lib/wake.mjs';

// 2026-08-28 11:31 로컬
const now = new Date(2026, 7, 28, 11, 31).getTime();

test('HH:MM — 아직 안 지난 시각은 오늘', () => {
  assert.equal(parseWakeAt('14:40', now), new Date(2026, 7, 28, 14, 40).getTime());
});

test('HH:MM — 이미 지난 시각은 내일 (초기화는 언제나 앞에 있다)', () => {
  assert.equal(parseWakeAt('04:40', now), new Date(2026, 7, 29, 4, 40).getTime());
});

test('절대 시각, 상대 시각, now', () => {
  assert.equal(parseWakeAt('2026-08-29T04:40', now), new Date(2026, 7, 29, 4, 40).getTime());
  assert.equal(parseWakeAt('+90m', now), now + 90 * 60000);
  assert.equal(parseWakeAt('+2h', now), now + 2 * 3600000);
  assert.equal(parseWakeAt('now', now), now);
});

test('모르는 형식과 빈 값은 던진다', () => {
  assert.throws(() => parseWakeAt('2:40pm', now));
  assert.throws(() => parseWakeAt('', now));
});

const idleScreen = [
  '❯ 경로에 있는 파일은 수정하지 말고',
  '  대답만 해줘.',
  '● 알겠습니다.',
  '✻ Cogitated for 3s · done 9:16 PM',
  '───────────────────────────────',
  '❯',
  '───────────────────────────────',
  '  Sonnet 5 │ high │ 7%',
];

test('입력창이 비어 있으면 제출됨 — 위 이력의 ❯ 는 입력창이 아니다', () => {
  assert.equal(checkSubmitted(idleScreen, '이어서 진행해'), 'submitted');
});

test('입력창에 글이 남아 있으면 미제출 (작업 중인 세션에 보낸 경우)', () => {
  const stuck = ['● 작업 중…', '───────', '❯ 이어서 진행해', '───────'];
  assert.equal(checkSubmitted(stuck, '이어서 진행해'), 'stuck');
  const wrapped = ['───────', '❯ 이어서', '  진행해', '───────'];
  assert.equal(checkSubmitted(wrapped, '이어서 진행해'), 'stuck');
});

test('입력창에 다른 글이 있어도 진행 흔적이 없으면 unknown — 빈 화면을 제출로 읽지 않는다', () => {
  assert.equal(checkSubmitted(['───', '❯ 다른 입력', '───'], '이어서 진행해'), 'unknown');
  // 진행 흔적이 있으면 그 글은 사용자 것이고 우리 것은 들어간 것이다
  assert.equal(checkSubmitted(['● 알겠습니다.', '───', '❯ 다른 입력', '───'], '이어서 진행해'), 'submitted');
});

test('Claude Code 화면이 아니면 unknown', () => {
  assert.equal(checkSubmitted(['PS C:\\Users\\x>', ''], '이어서 진행해'), 'unknown');
});

test('PLAN.md 체크 수', () => {
  assert.deepEqual(planCounts('- [x] a\n- [ ] b\n  - [X] c\n- 그냥 줄\n'), { open: 1, done: 2 });
});

test('마감 차이 — 마감 없으면 null, 예상이 늦으면 음수', () => {
  const eta = { at: new Date(2026, 7, 29, 12, 0).getTime() };
  assert.equal(fleetGap(null, eta), null);
  assert.ok(fleetGap('2026-08-28', eta) < 0);
  assert.ok(fleetGap('2026-08-30', eta) > 0);
});

// 미체크 0 = 단계가 끝났다. 예상을 "지금" 으로 내면 지난 마감과 비교돼 다 끝난 프로젝트가
// ⚠ 를 달고 표 맨 위에 앉는다.
test('예상 — 미체크 0 이면 예상·차이가 빈 칸', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-eta-'));
  try {
    writeFileSync(join(dir, 'PLAN.md'), '- [x] 1\n- [x] 2\n');
    const eta = fleetEta(dir, new Date(2026, 7, 28, 11, 31).getTime());
    assert.equal(eta.open, 0);
    assert.equal(eta.at, null);
    assert.equal(eta.basis, '미체크 0 — 단계 끝');
    assert.equal(fleetGap('2026-08-01', eta), null); // 지난 마감이어도 ⚠ 가 안 붙는다
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('예상 — 미체크가 남으면 그대로 난다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-eta-'));
  try {
    writeFileSync(join(dir, 'PLAN.md'), '- [x] 1\n- [ ] 2\n- [ ] 3\n');
    const from = new Date(2026, 7, 28, 11, 31).getTime();
    const eta = fleetEta(dir, from);
    assert.equal(eta.open, 2);
    assert.ok(eta.at > from);
    assert.match(eta.basis, /미체크 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --- 슬라이스 27: 화면 읽기는 `--screen` 이고, 못 읽으면 그 사실이 값으로 나온다 ---
// `--screen` 없이 읽으면 누적 스트림이 오고 재그리기가 글자 단위로 겹친다 (`clear` → `cclclecleaclear`).
// 그 문자열이 `hasClaudePrompt`·`checkSubmitted` 에 들어가면 판정이 조용히 어긋난다.

const fakeRead = (terminal) => {
  const calls = [];
  const logs = [];
  const io = { json: (args) => (calls.push(args), { terminal }), log: (m) => logs.push(m) };
  return { calls, logs, io };
};

test('readScreen 은 --screen 으로 읽는다', () => {
  const f = fakeRead({ tail: ['❯'], draft: '', source: 'screen' });
  const s = readScreen('term_1', f.io);
  assert.deepEqual(f.calls[0], ['terminal', 'read', '--terminal', 'term_1', '--screen']);
  assert.deepEqual(s.lines, ['❯']);
  assert.equal(s.source, 'screen');
  assert.equal(f.logs.length, 0);
});

test('screen-unavailable — 로그에 남기고 source 를 실어 보낸다', () => {
  const f = fakeRead({ tail: ['cclclecleaclear'], draft: '', source: 'screen-unavailable' });
  const s = readScreen('term_2', f.io);
  assert.equal(s.source, 'screen-unavailable');
  assert.equal(screenUnavailable(s.source), true);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /term_2.*screen-unavailable/);
});

// `source` 가 없는 것은 그 필드가 없던 옛 런타임이다 — 폴백으로 읽으면 멀쩡한 화면이 전부
// "못 읽음" 이 된다 (`terminal read --help`: "An absent source means the host predates the field").
test('source 가 없는 옛 런타임은 폴백으로 보지 않는다', () => {
  const f = fakeRead({ tail: ['❯'], draft: '' });
  const s = readScreen('term_3', f.io);
  assert.equal(s.source, null);
  assert.equal(screenUnavailable(s.source), false);
  assert.equal(f.logs.length, 0);
});

test('wakeOne — 화면을 못 읽어 unknown 이면 사유가 "제출 흔적 없음" 이 아니라 "못 읽음" 이다', async () => {
  const io = {
    send: () => {},
    read: () => ({ lines: ['cclclecleaclear'], draft: '', source: 'screen-unavailable' }),
    sleep: async () => {},
  };
  const r = await wakeOne('term_4', '이어서 진행해', io);
  assert.equal(r.result, 'unknown');
  assert.equal(r.source, 'screen-unavailable');
  assert.match(r.detail, /화면을 못 읽음/);
});

test('wakeOne — 화면을 제대로 읽었으면 사유를 덧붙이지 않는다', async () => {
  const io = {
    send: () => {},
    read: () => ({ lines: ['───', '❯ 다른 입력', '───'], draft: '', source: 'screen' }),
    sleep: async () => {},
  };
  const r = await wakeOne('term_5', '이어서 진행해', io);
  assert.equal(r.result, 'unknown');
  assert.equal(r.source, 'screen');
  assert.equal(r.detail, '');
});

test('wakeOne — 잠든 창(절전)에 보내면 send 가 terminal_not_writable 로 거부되고 사유에 "탭을 열어야 함"이 붙는다', async () => {
  const io = {
    send: () => {
      throw new Error('terminal_not_writable');
    },
    read: () => ({ lines: [], draft: '' }),
    sleep: async () => {},
  };
  const r = await wakeOne('term_9', '이어서 진행해', io);
  assert.equal(r.sent, false);
  assert.equal(r.result, 'error');
  assert.match(r.detail, /terminal_not_writable — 잠들었거나 죽은 창, CLI 로 못 깨움 \(Orca 에서 탭을 열어야 함\)/);
  // 다른 오류에는 안 붙는다
  const r2 = await wakeOne('term_9', 'x', { ...io, send: () => { throw new Error('boom'); } });
  assert.equal(r2.detail, 'boom');
});
