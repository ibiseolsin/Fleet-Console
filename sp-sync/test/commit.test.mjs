// node --test sp-sync/test/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// **이 파일도 홈을 갈아끼운다** (worker.test.mjs 와 같은 이유). 여기서 만지는 것은 세션 기록
// (`~/.sp-sync/state.json`)이라 진짜 홈에서 돌리면 사용자의 기록을 건드린다. `os.homedir()` 는
// 모듈 로드 때 굳으므로 바꾼 뒤 동적 import 한다 — 그래서 정적 import 가 없다.
const HOME = mkdtempSync(join(tmpdir(), 'sp-commit-home-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
mkdirSync(join(HOME, '.sp-sync'), { recursive: true });

const { turnClosed, flushNotes, flushIfTurnClosed, ensureSession, patchSession } = await import('../lib/hooks.mjs');
const { state } = await import('../lib/common.mjs');

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
});

// ---------- turnClosed ----------
test('turnClosed — 두 시각만 본다. 묵은 열린 턴은 닫힘이 아니다', () => {
  const t = 1_000_000_000;
  assert.equal(turnClosed({ turnStartedAt: t, turnEndedAt: t + 1000 }), true);
  // 래퍼가 turnEndedAt 을 찍은 뒤 커밋 훅이 도착한 경우 — 같은 밀리초여도 닫힘이다
  assert.equal(turnClosed({ turnStartedAt: t, turnEndedAt: t }), true);
  // 턴 진행 중: 이 커밋은 곧 올 Stop 이 가져간다
  assert.equal(turnClosed({ turnStartedAt: t + 1000, turnEndedAt: t }), false);
  assert.equal(turnClosed({ turnStartedAt: t, turnEndedAt: null }), false);
  // 훅이 끊긴 창(열린 턴이 아무리 묵어도)은 닫힘으로 안 본다 — turnStateFor 과 같은 잣대다.
  // 여기서 닫힘으로 읽으면 아직 일하는 세션의 커밋이 그때그때 태스크를 만든다.
  assert.equal(turnClosed({ turnStartedAt: t - 86400000, turnEndedAt: null }), false);
  assert.equal(turnClosed(undefined), false);
  // 세션 밖 커밋의 합성 기록(`commits:<저장소>:<날짜>`)에는 아예 턴이 없다 — 그 경로는 turnClosed
  // 를 거치지 않고 늘 바로 보낸다.
  assert.equal(turnClosed({}), false);
});

// ---------- flushIfTurnClosed ----------
/** SP 왕복만 가짜로. 판정은 taskId 가 이미 붙은 세션이라 모델도 SP 도 안 부른다. */
function fakeSp() {
  const calls = [];
  return { calls, appendNotes: async (taskId, lines) => calls.push({ taskId, lines }) };
}

function session(id, patch) {
  ensureSession(id, HOME, '테스트');
  patchSession(id, (e) => Object.assign(e, patch));
  return id;
}

const LINE = 'abc1234 (slice10) 마지막 커밋';

test('턴이 닫힌 세션의 커밋은 그 자리에서 SP 로 간다', async () => {
  // 에이전트가 커밋 직후 바로 끝난 모양: 래퍼가 turnEndedAt 을 찍고 SP 노트까지 마친 뒤
  // detached 커밋 훅이 도착했다. 이 세션에는 다음 Stop 이 없다.
  const id = session('closed-1', {
    taskId: 'T1',
    turnStartedAt: 1000,
    turnEndedAt: 2000,
    commits: ['0000000 앞 커밋', LINE],
    written: ['- 0000000 앞 커밋'],
  });
  const sp = fakeSp();
  const r = await flushIfTurnClosed(id, sp);

  assert.equal(sp.calls.length, 1, 'SP 쓰기가 한 번');
  assert.equal(sp.calls[0].taskId, 'T1');
  // 이미 쓴 줄은 다시 안 보낸다
  assert.deepEqual(sp.calls[0].lines, ['- ' + LINE]);
  assert.deepEqual(r.added, ['- ' + LINE]);
  // 쓴 것을 기록해야 다음 턴이 같은 줄을 또 보내지 않는다
  assert.deepEqual(state().sessions[id].written, ['- 0000000 앞 커밋', '- ' + LINE]);
});

test('턴이 열려 있으면 안 보낸다 — 곧 올 Stop 이 가져간다', async () => {
  const id = session('open-1', {
    taskId: 'T2',
    turnStartedAt: 3000,
    turnEndedAt: 2000,
    commits: [LINE],
    written: [],
  });
  const sp = fakeSp();
  assert.equal(await flushIfTurnClosed(id, sp), null);
  assert.equal(sp.calls.length, 0, 'SP 를 부르지 않는다');
  assert.deepEqual(state().sessions[id].written, [], 'written 도 안 건드린다');
});

test('턴이 닫혀도 붙일 줄이 없으면 SP 를 안 부른다', async () => {
  const id = session('closed-2', {
    taskId: 'T3',
    turnStartedAt: 1000,
    turnEndedAt: 2000,
    commits: [LINE],
    written: ['- ' + LINE],
  });
  const sp = fakeSp();
  const r = await flushIfTurnClosed(id, sp);
  assert.deepEqual(r.added, []);
  assert.equal(sp.calls.length, 0);
});

test('판정이 태스크를 못 정하면(질문만 한 세션) 아무 일도 없다', async () => {
  // 커밋도 작업항목도 없는 세션에는 태스크를 안 만든다 — resolveSessionTask 의 0순위 규칙이다.
  const id = session('closed-3', { turnStartedAt: 1000, turnEndedAt: 2000 });
  const sp = fakeSp();
  assert.equal(await flushIfTurnClosed(id, sp), null);
  assert.equal(sp.calls.length, 0);
});

// ---------- flushNotes ----------
test('flushNotes — 커밋과 작업 항목을 한 번에, 표시가 다르다', async () => {
  // Stop 과 커밋 훅이 같은 함수를 쓴다. 턴 조건이 없는 쪽(세션 밖 커밋·Stop)이 부르는 자리다.
  const id = session('flush-1', {
    taskId: 'T4',
    commits: [LINE],
    todos: ['테스트 작성'],
    written: [],
  });
  const sp = fakeSp();
  const r = await flushNotes(id, sp);
  assert.deepEqual(sp.calls[0].lines, ['- ' + LINE, '- ☑ 테스트 작성']);
  assert.equal(r.sess.taskId, 'T4');
});
