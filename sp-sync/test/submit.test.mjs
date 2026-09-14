// node --test sp-sync/test/*.test.mjs
// 슬라이스 11 — 파견 지시가 실제로 제출됐는지 가리는 판정과 준비 신호.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSubmitted, hasClaudePrompt, sendInstruction } from '../sp-sync.mjs';

const TEXT = 'PRD.md, PLAN.md 읽고 슬라이스 11 진행. 끝나면 PLAN.md 체크하고 커밋.';

// Orca 가 워크스페이스를 막 만들었을 때의 화면. Claude 는 아직 안 떴다.
const setupScreen = ['Waiting for setup to finish before starting agent...', '✶'];

// 지시가 실제로 들어간 직후. 이력에 `❯ 그 글` 이 남고 스피너가 돈다.
const workingScreen = [
  ' ▐▛███▛█   Claude Code v2.1.251',
  '▝▜██████▀  Opus 5 (1M context) · Claude Max',
  '❯ ' + TEXT,
  '● I will start by reading PRD.md and PLAN.md.',
  '· Combobulating… (6m 20s · ↓ 18.0k tokens)',
  '────────────────────────',
  '❯',
  '────────────────────────',
  '  Opus 5 (1M context) │ high │ ▓░░░░░░░░░ 12% 121k/1.0M',
];

// 지시가 안 들어간 창. 프롬프트는 떴지만 아무 흔적이 없고 컨텍스트가 0% 다.
const emptyScreen = [
  ' ▐▛███▛█   Claude Code v2.1.251',
  '▝▜██████▀  Opus 5 (1M context) · Claude Max',
  '────────────────────────',
  '❯',
  '────────────────────────',
  '  Opus 5 (1M context) │ high │ ░░░░░░░░░░ 0% 0/1.0M',
];

test('빈 프롬프트 화면은 submitted 가 아니다 — 21:00 회차 미제출 6건의 모습', () => {
  assert.equal(checkSubmitted(emptyScreen, TEXT), 'unknown');
});

test('Orca draft 에 글이 남아 있으면 stuck — 화면에는 안 보인다', () => {
  assert.equal(checkSubmitted(emptyScreen, TEXT, TEXT), 'stuck');
  assert.equal(checkSubmitted(setupScreen, TEXT, TEXT), 'stuck');
});

test('이력의 `❯ 그 글` 과 진행 흔적이 제출 증거다', () => {
  assert.equal(checkSubmitted(workingScreen, TEXT), 'submitted');
  // 이력이 스크롤돼 사라져도 진행 흔적만으로 인정한다
  const scrolled = workingScreen.filter((l) => !l.startsWith('❯ '));
  assert.equal(checkSubmitted(scrolled, TEXT), 'submitted');
  // 흔적 중 컨텍스트만 남아도 (0% 가 아니어야 한다)
  assert.equal(checkSubmitted(['───', '❯', '───', '  Opus 5 │ ▓░░░ 3% 30k/1.0M'], TEXT), 'submitted');
});

test('입력창에 그 글이 남아 있으면 stuck (draft 없이도)', () => {
  const stuck = [...emptyScreen.slice(0, 3), '❯ ' + TEXT, '────────────────────────'];
  assert.equal(checkSubmitted(stuck, TEXT), 'stuck');
});

test('준비 신호: Waiting for setup 화면은 준비가 아니다', () => {
  assert.equal(hasClaudePrompt(setupScreen), false);
  assert.equal(hasClaudePrompt([]), false);
  assert.equal(hasClaudePrompt(['PS C:/Users/x> ']), false);
  assert.equal(hasClaudePrompt(emptyScreen), true);
  assert.equal(hasClaudePrompt(workingScreen), true);
});

// --- 재전송: 정확히 한 번 ---

/** 창 하나를 흉내 낸다. `screens` 는 read 마다 꺼내 쓸 화면 목록(모자라면 마지막 것을 반복). */
function fakeTerminal(screens) {
  const sent = [];
  let i = 0;
  return {
    sent,
    io: {
      send: (handle, text, enter) => sent.push({ text, enter }),
      read: () => screens[Math.min(i++, screens.length - 1)],
      sleep: async () => {},
    },
  };
}
const S = (lines, draft = '') => ({ lines, draft });

test('제출이 확인되면 재전송하지 않는다', async () => {
  const t = fakeTerminal([S(workingScreen)]);
  const r = await sendInstruction('term_x', TEXT, t.io);
  assert.equal(r.submit, '제출 확인');
  assert.equal(r.resent, 0);
  assert.deepEqual(t.sent, [{ text: TEXT, enter: true }]);
});

test('미제출이면 입력창을 비운 뒤 정확히 한 번만 다시 보낸다', async () => {
  // 처음엔 draft 에 남아 미제출 → 재전송 뒤에는 들어갔다
  const t = fakeTerminal([S(emptyScreen, TEXT), S(workingScreen)]);
  const r = await sendInstruction('term_x', TEXT, t.io);
  assert.equal(r.submit, '재전송 1회');
  assert.equal(r.resent, 1);
  assert.deepEqual(t.sent, [
    { text: TEXT, enter: true },
    { text: '\u0015', enter: false }, // Ctrl+U — 안 비우면 두 지시가 한 문장이 된다
    { text: TEXT, enter: true },
  ]);
});

test('두 번째도 미제출이면 막힘으로 보고하고 더 보내지 않는다', async () => {
  const t = fakeTerminal([S(emptyScreen, TEXT)]);
  const r = await sendInstruction('term_x', TEXT, t.io);
  assert.match(r.submit, /^미제출\(막힘\)/);
  assert.equal(r.resent, 1);
  assert.equal(t.sent.filter((x) => x.text === TEXT).length, 2);
});
