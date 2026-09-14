// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landCheck, landOne, mergeGate, outputQuiet, turnStateFor, renderLand, conflictText, conflictLoop } from '../sp-sync.mjs';

const w = (over = {}) => ({ name: 'slice8', path: 'C:/nope/slice8', branch: 'u/slice8', slice: 8, terminals: ['t1'], ...over });
const opts = { idleMs: 10, baseRef: 'origin/main' };

test('브랜치가 sliceN 이 아니면 제외 — 막힘이 아니다', () => {
  const c = landCheck(w({ slice: null, branch: 'tuskfish' }), opts);
  assert.equal(c.ready, false);
  assert.equal(c.blocked, false); // 사람이 볼 "막힘" 목록을 이런 창으로 채우면 안 된다
  assert.match(c.reason, /sliceN 이 아니라/);
});

test('폴더가 없으면 제외', () => {
  const c = landCheck(w(), opts);
  assert.equal(c.ready, false);
  assert.equal(c.blocked, false);
  assert.match(c.reason, /폴더가 없음/);
});

test('판정 결과에 이름·번호·브랜치가 그대로 실린다', () => {
  const c = landCheck(w({ slice: null }), opts);
  assert.equal(c.name, 'slice8');
  assert.equal(c.branch, 'u/slice8');
});

test('표 — 판정별로 착륙/막힘/제외가 갈린다', () => {
  const out = renderLand({
    project: 'P',
    baseRef: 'origin/main',
    hasRemote: true,
    dryRun: true,
    checks: [
      { name: 'slice8', slice: 8, ready: true, reason: '체크 완료 · 커밋 2개 · 깨끗함' },
      { name: 'slice9', slice: 9, ready: false, blocked: true, reason: '유휴인데 9번이 미체크 — 막힘 (재전송하지 않음)' },
      { name: 'slice10', slice: 10, ready: false, blocked: false, reason: '작업 중 (TUI 유휴 아님)' },
    ],
    landed: [],
  });
  assert.match(out, /P {2}— {2}착륙 \(base origin\/main\)/);
  assert.match(out, /\(dry-run\) 워크스페이스 3 · 자격 1/);
  assert.match(out, /slice8 .*8 .*착륙/);
  assert.match(out, /slice9 .*9 .*막힘/);
  assert.match(out, /slice10 .*10 .*제외/);
});

test('원격이 없으면 표 머리에 그렇게 적힌다', () => {
  const out = renderLand({ project: 'P', baseRef: 'main', hasRemote: false, dryRun: true, checks: [], landed: [] });
  assert.match(out, /base main, 원격 없음/);
  assert.match(out, /활성 워크스페이스 없음/);
});

test('사용자 결정이 필요한 착륙은 맨 밑에 따로 모인다', () => {
  const out = renderLand({
    project: 'P',
    baseRef: 'origin/main',
    hasRemote: true,
    dryRun: false,
    checks: [{ name: 'slice8', slice: 8, ready: true, reason: 'ok' }],
    landed: [{ name: 'slice8', slice: 8, ok: false, stage: 'conflict', needsUser: true }],
  });
  assert.match(out, /사용자 결정 필요: slice8/);
});

test('머지된 것은 PR 번호와 본체 ff 결과를 같이 낸다', () => {
  const out = renderLand({
    project: 'P',
    baseRef: 'origin/main',
    hasRemote: true,
    dryRun: false,
    checks: [{ name: 'slice8', slice: 8, ready: true, reason: 'ok' }],
    landed: [{ name: 'slice8', slice: 8, ok: true, pr: 12, ff: true }],
  });
  assert.match(out, /slice8 {2}머지됨 #12 · 본체 ff/);
});

test('충돌 문구는 그 저장소의 기본 브랜치를 쓴다', () => {
  // SP-sync·coordinator 은 master 다. main 고정이던 동안 워커는 없는 브랜치를 받았다.
  assert.equal(conflictText('master'), 'origin/master 머지해 충돌 풀고 커밋');
  assert.equal(conflictText('main'), 'origin/main 머지해 충돌 풀고 커밋');
  // base 를 못 읽은 자리에서도 문장은 나와야 한다 — baseBranchOf 의 기본값과 같은 main.
  assert.equal(conflictText(undefined), 'origin/main 머지해 충돌 풀고 커밋');
});

// --- 슬라이스 14: 마지막 출력이 조용해질 때까지 착륙하지 않는다 ---

test('마지막 출력이 방금이면 자격 없음 — 막힘이 아니다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  const c = landCheck(w({ path: dir, lastOutputAt: Date.now() - 3000 }), { ...opts, quietMs: 120000 });
  assert.equal(c.ready, false);
  assert.equal(c.blocked, false); // 워커가 일하는 중이지 막힌 게 아니다
  // 초는 재는 순간에 따라 3~4 로 갈린다 — 느린 기계에서 회차의 테스트 게이트를 깨뜨리지 않게 모양만 본다
  assert.match(c.reason, /방금까지 출력 — 다음 회차 \(\d+초 전\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('N초가 지나면 출력 조건을 통과해 다음 판정으로 넘어간다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  // PLAN.md 를 안 두면 유휴 판정 다음 칸에서 걸린다 — 출력 조건을 넘었다는 뜻이다.
  const c = landCheck(w({ path: dir, terminals: [], lastOutputAt: Date.now() - 600000 }), { ...opts, quietMs: 120000 });
  assert.doesNotMatch(c.reason, /방금까지 출력/);
  rmSync(dir, { recursive: true, force: true });
});

test('마지막 출력을 모르면(창 목록에 없음) 막지 않는다', () => {
  assert.equal(outputQuiet(null, 120000).quiet, true);
  assert.equal(outputQuiet(Date.now(), 0).quiet, true);
});

test('경계 — 딱 N초면 통과, 1ms 모자라면 아니다', () => {
  const now = 1_000_000;
  assert.equal(outputQuiet(now - 120000, 120000, now).quiet, true);
  assert.equal(outputQuiet(now - 119999, 120000, now).quiet, false);
});

// --- 충돌 루프: 워커가 푼 것을 밀어야 PR 이 바뀐다 ---

// 바깥 손 넷을 가짜로. 부른 순서를 그대로 기록해 "언제" 밀었는지까지 본다.
const fakeDeps = (over = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      send: async (h, text) => (calls.push('send:' + text), { sent: true, result: 'submitted' }),
      idle: async () => (calls.push('idle'), true),
      push: async (path) => (calls.push('push:' + path), over.push ?? { ok: true }),
      read: async () => (calls.push('read'), over.read ? over.read(calls) : { mergeable: 'MERGEABLE' }),
      ...(over.deps || {}),
    },
  };
};
const lw = { name: 'slice15', path: 'C:/w/slice15', branch: 'slice15', terminals: ['t1'] };
const steps = () => {
  const out = [];
  return { out, step: (s, ok, detail) => out.push({ step: s, ok, detail }) };
};

test('충돌 루프가 유휴 뒤·PR 재조회 전에 push 한다', async () => {
  const { calls, deps } = fakeDeps();
  const st = steps();
  const r = await conflictLoop(lw, { mergeable: 'CONFLICTING' }, { conflictTries: 2, conflictMs: 1, baseBranch: 'master' }, st.step, deps);
  // 순서가 핵심이다 — 밀기 전에 PR 을 읽으면 언제나 CONFLICTING 이 나온다
  assert.deepEqual(calls, ['send:origin/master 머지해 충돌 풀고 커밋', 'idle', 'push:C:/w/slice15', 'read']);
  assert.equal(r.pr.mergeable, 'MERGEABLE'); // 풀렸으면 한 바퀴로 끝난다
  assert.deepEqual(st.out.map((x) => [x.step, x.ok]), [['충돌 해소 1회', true], ['충돌 push 1회', true]]);
});

test('push 실패는 시도 1회로 세고 사유를 보고에 남긴다', async () => {
  const { calls, deps } = fakeDeps({ push: { ok: false, detail: 'rejected — non-fast-forward' }, read: () => ({ mergeable: 'CONFLICTING' }) });
  const st = steps();
  const r = await conflictLoop(lw, { mergeable: 'CONFLICTING' }, { conflictTries: 2, conflictMs: 1, baseBranch: 'master' }, st.step, deps);
  // 상한 2회를 그대로 쓴다 — push 가 실패했다고 건너뛰면 상한이 무의미해진다
  assert.equal(calls.filter((c) => c.startsWith('push:')).length, 2);
  assert.equal(calls.filter((c) => c.startsWith('send:')).length, 2);
  assert.equal(r.pr.mergeable, 'CONFLICTING'); // 호출부가 "사용자 결정 필요"로 넘긴다
  const p = st.out.filter((x) => x.step.startsWith('충돌 push'));
  assert.deepEqual(p.map((x) => x.ok), [false, false]);
  assert.match(p[0].detail, /non-fast-forward/); // 사유가 steps 에 남아 보고로 나간다
});

test('창이 없으면 아무것도 안 보내고 사용자 결정으로 넘긴다', async () => {
  const { calls, deps } = fakeDeps();
  const st = steps();
  const r = await conflictLoop({ ...lw, terminals: [] }, { mergeable: 'CONFLICTING' }, { conflictTries: 2, conflictMs: 1 }, st.step, deps);
  assert.equal(r.noTerminal, true);
  assert.deepEqual(calls, []); // 창이 없는데 push 만 하면 안 된다 — 푼 사람이 없다
});

test('충돌이 아니면 루프를 돌지 않는다 — 멀쩡한 PR 에 push 하지 않는다', async () => {
  const { calls, deps } = fakeDeps();
  const st = steps();
  const r = await conflictLoop(lw, { mergeable: 'MERGEABLE' }, { conflictTries: 2, conflictMs: 1 }, st.step, deps);
  assert.deepEqual(calls, []);
  assert.equal(r.pr.mergeable, 'MERGEABLE');
  assert.deepEqual(st.out, []);
});

// --- 슬라이스 23: 유휴 판정의 원천은 화면 출력이 아니라 훅이다 ---

// 세션 기록의 `cwd` 는 **본체** 경로다 — 워크스페이스를 가르는 건 `worktree` 뿐이다.
const S = (over = {}) => ({ cwd: String.raw`C:\orca\projects\P`, worktree: String.raw`C:\w\slice8`, ...over });

test('훅이 Stop 으로 끝났으면 방금 화면이 움직였어도 유휴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  // 워커의 Stop 훅이 띄운 회차·사람이 창을 열어 본 재그리기 — 둘 다 lastOutputAt 을 지금으로 올린다.
  const c = landCheck(w({ path: dir, terminals: [], lastOutputAt: Date.now(), turn: { known: true, active: false } }), { ...opts, quietMs: 120000 });
  assert.doesNotMatch(c.reason, /방금까지 출력/);
  rmSync(dir, { recursive: true, force: true });
});

test('프롬프트 뒤 Stop 이 없으면 화면이 오래 조용해도 턴 진행 중이다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  const c = landCheck(w({ path: dir, lastOutputAt: Date.now() - 600000, turn: { known: true, active: true } }), { ...opts, quietMs: 120000 });
  assert.equal(c.ready, false);
  assert.equal(c.blocked, false); // 일하는 중이지 막힌 게 아니다
  assert.match(c.reason, /턴 진행 중/);
  rmSync(dir, { recursive: true, force: true });
});

test('훅 기록이 없는 창은 옛 판정으로 떨어지고 사유에 그 표시가 붙는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  const c = landCheck(w({ path: dir, lastOutputAt: Date.now() - 3000 }), { ...opts, quietMs: 120000 });
  assert.match(c.reason, /방금까지 출력 — 다음 회차 \(\d+초 전\) \(훅 기록 없음 — 출력 시각으로 판정\)/);
  // 안 끝난 턴만 묵어 있는 창(훅이 끊긴 창)도 같은 자리로 떨어진다 — 사유만 다르다
  const c2 = landCheck(w({ path: dir, lastOutputAt: Date.now() - 3000, turn: { known: false, stale: true } }), { ...opts, quietMs: 120000 });
  assert.match(c2.reason, /훅 턴이 안 끝난 채 오래됨 — 출력 시각으로 판정/);
  rmSync(dir, { recursive: true, force: true });
});

test('턴 상태 — 같은 본체의 옆 워크스페이스는 안 센다 (구분자·대소문자는 무시)', () => {
  const now = 1_000_000_000;
  const sessions = {
    a: S({ turnStartedAt: now - 5000, turnEndedAt: now - 1000 }),
    b: S({ worktree: 'C:/w/slice9', turnStartedAt: now - 500 }), // 다른 워크스페이스 — 여기서 턴 중이어도 상관없다
  };
  const t = turnStateFor('c:/w/slice8/', sessions, now);
  assert.deepEqual(t, { known: true, active: false, endedAt: now - 1000, agent: 'claude' });
});

test('턴 상태 — 한 폴더에 창이 여럿이면 하나라도 턴 중이면 턴 중', () => {
  const now = 1_000_000_000;
  const sessions = {
    a: S({ turnStartedAt: now - 5000, turnEndedAt: now - 4000 }), // 끝난 작업 창
    b: S({ turnStartedAt: now - 500 }), // 곁가지 질문 창이 지금 턴 중
  };
  assert.equal(turnStateFor(String.raw`C:\w\slice8`, sessions, now).active, true);
});

test('턴 상태 — 기록이 없거나 안 끝난 턴만 묵었으면 옛 판정으로 넘긴다', () => {
  const now = 1_000_000_000;
  assert.deepEqual(turnStateFor('C:/w/slice8', {}, now), { known: false });
  // 훅이 못 도는 사이에 죽은 창. 이걸 믿으면 그 워크스페이스가 영영 "턴 진행 중"으로 굳는다
  const dead = { a: S({ turnStartedAt: now - 7200000 }) };
  assert.deepEqual(turnStateFor('C:/w/slice8', dead, now), { known: false, stale: true, agent: 'claude' });
  // 딱 1시간 전이면 아직 산 것으로 본다 (경계)
  assert.equal(turnStateFor('C:/w/slice8', { a: S({ turnStartedAt: now - 3599999 }) }, now).active, true);
});

// --- 4단계 슬라이스 5: 착륙·충돌의 헤드리스 경로 ---
// 헤드리스 워커에는 화면도 `tui-idle` 도 없다 — 유휴는 래퍼가 찍은 세션 기록(`turnStateFor`)뿐이고,
// 충돌 해소는 REPL 에 쳐 넣는 대신 `--prompt` 를 실은 래퍼를 새 탭으로 띄워 새 턴을 연다.
import { workerPromptCommand, headlessTurnDone, prIsForHead } from '../lib/fleet.mjs';

test('헤드리스 — 턴이 끝났으면 창이 없고 화면이 방금 움직였어도 유휴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  // 창 0개 + 방금 출력 — TUI 라면 "창이 없음" 에서 걸린다. 헤드리스는 기록만 보고 다음 칸(PLAN.md)으로 간다.
  const c = landCheck(w({ path: dir, terminals: [], lastOutputAt: Date.now(), turn: { known: true, active: false, agent: 'codex' } }), { ...opts, quietMs: 120000 });
  assert.doesNotMatch(c.reason, /창이 없음|방금까지 출력|TUI 유휴/);
  assert.match(c.reason, /PLAN\.md 가 없음/);
  // 기록이 없고 계획(슬라이스 태그)만 헤드리스여도 TUI 판정으로 떨어지지 않는다 — 셸 프롬프트를 빈 창으로 읽으면 안 된다
  const c2 = landCheck(w({ path: dir, terminals: ['t1'], lastOutputAt: Date.now(), agent: 'antigravity' }), { ...opts, quietMs: 120000 });
  assert.match(c2.reason, /헤드리스\(antigravity\) 인데 래퍼 턴 기록이 없음/);
  assert.equal(c2.blocked, true); // 래퍼가 못 뜬 것 — 사람이 볼 것
  rmSync(dir, { recursive: true, force: true });
});

test('헤드리스 — 래퍼 턴이 열려 있으면 작업 중, 막힘이 아니다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  const c = landCheck(w({ path: dir, terminals: ['t1'], lastOutputAt: Date.now() - 600000, turn: { known: true, active: true, agent: 'codex' } }), { ...opts, quietMs: 120000 });
  assert.equal(c.ready, false);
  assert.equal(c.blocked, false);
  assert.match(c.reason, /헤드리스\(codex\) 작업 중 — 래퍼 턴 진행 중/);
  rmSync(dir, { recursive: true, force: true });
});

test('헤드리스 — 턴이 안 끝난 채 묵었으면 "래퍼가 안 끝남" 으로 사람 몫이다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  // TUI 는 이 모양을 옛 판정(출력 시각)으로 넘기지만, 헤드리스에는 출력 시각이 뜻이 없다 — 셸 프롬프트다
  const c = landCheck(w({ path: dir, terminals: ['t1'], lastOutputAt: Date.now() - 600000, turn: { known: false, stale: true, agent: 'codex' } }), { ...opts, quietMs: 120000 });
  assert.equal(c.ready, false);
  assert.equal(c.blocked, true);
  assert.match(c.reason, /헤드리스\(codex\) 래퍼가 안 끝남 — 턴이 60분 넘게 열려 있음/);
  rmSync(dir, { recursive: true, force: true });
});

// --- 5단계 슬라이스 11: 한도 막힘 ---
// 겉모습은 "유휴인데 미체크 — 막힘"과 같지만 원인이 다르고 대처도 다르다 — 사람 몫이 아니라
// 상대 에이전트가 이어받을 자리다(슬라이스 12·13). 재료는 래퍼가 턴 끝에 남긴 exitCode·limit 뿐이다.
import { limitBlock } from '../sp-sync.mjs';
import { hhmm } from '../lib/hooks.mjs';

// `landCheck` 는 시계를 주입받지 않는다(`limitBlock` 이 `Date.now()` 를 쓴다). 초기화 시각을
// 고정값으로 박으면 그 시각이 지난 뒤부터 이 테스트가 영영 실패한다 — 실제로 슬라이스 11 이
// 박아둔 `2026-09-03T04:14` 가 그날 오후에 만료됐다. 그래서 **지금 기준 상대 시각**으로 만든다.
const RESET = Date.now() + 3600000; // 한 시간 뒤 초기화 = 지금도 막혀 있다
const LIM = (over = {}) => ({
  agent: 'codex',
  pct5h: 100,
  pct7d: 13,
  resetsAt: RESET,
  reached: true,
  windows: { fiveHour: { pct: 100, resetsAt: RESET }, sevenDay: { pct: 13, resetsAt: RESET + 6 * 86400000 } },
  models: {},
  ...over,
});

test('헤드리스 — 한도에 막혀 끝났으면 사유가 "한도 막힘 — 초기화 HH:MM"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-land-'));
  const turn = { known: true, active: false, agent: 'codex', exitCode: 1, limit: LIM() };
  const c = landCheck(w({ path: dir, terminals: [], lastOutputAt: Date.now(), turn }), {
    ...opts,
    quietMs: 120000,
    now: Date.parse('2026-09-03T02:00:00'),
  });
  assert.equal(c.ready, false);
  assert.equal(c.blocked, true, '재파견 대상이 아니다 — 같은 에이전트로 다시 띄우면 또 막힌다');
  assert.equal(c.reason, '헤드리스(codex) 한도 막힘 — 초기화 ' + hhmm(RESET) + ' (exit 1)');
  assert.equal(c.limit.pct5h, 100, '판정 재료를 결과에 실어 보낸다 (인계가 그걸 읽는다)');
  rmSync(dir, { recursive: true, force: true });
});

test('한도 막힘 판정 — 종료 코드와 한도가 둘 다여야 하고, 창이 초기화되면 풀린다', () => {
  const now = RESET - 3600000;
  const t = { agent: 'codex', exitCode: 1, limit: LIM() };
  assert.ok(limitBlock(t, now));
  // 잘 끝난 턴은 한도가 차 있어도 막힘이 아니다 — 막히기 직전에 일을 끝낸 턴이 그 모양이다
  assert.equal(limitBlock({ ...t, exitCode: 0 }, now), null);
  // 그냥 죽은 턴(한도와 무관)도 아니다 — 사람이 볼 몫으로 남는다
  assert.equal(limitBlock({ ...t, limit: LIM({ reached: false, windows: { fiveHour: { pct: 42, resetsAt: now + 1000 } } }) }, now), null);
  assert.equal(limitBlock({ ...t, limit: null }, now), null);
  // 옛 래퍼 기록(4단계)에는 exitCode 가 아예 없다 — 없으면 판정하지 않는다
  assert.equal(limitBlock({ agent: 'codex', limit: LIM() }, now), null);
  // **초기화 시각이 지나면 풀린다.** 기록된 reached 를 그대로 믿으면 그 워크스페이스가 영영 막힘이다
  assert.equal(limitBlock(t, RESET + 60000), null);
});

// 헤드리스 충돌 루프의 바깥 손. 시계는 부를 때마다 1초씩 가고, 세션 기록은 `after` 번째 조회부터 "턴 끝" 이 된다.
const headlessDeps = (over = {}) => {
  const calls = [];
  let now = 1_000_000; // 첫 호출(since)이 1_001_000 — 충돌 턴은 그 시각에 시작한다
  let reads = 0;
  const hw = 'C:/w/slice6';
  return {
    calls,
    deps: {
      send: async () => calls.push('send') && { sent: true, result: 'submitted' },
      idle: async () => calls.push('idle') && true,
      push: async (path) => (calls.push('push:' + path), { ok: true }),
      read: async () => (calls.push('read'), { mergeable: 'MERGEABLE' }),
      createTerminal: (path, title, command) => (calls.push('create:' + title + ':' + command), over.handle === undefined ? 'h9' : over.handle),
      sessions: () => {
        reads++;
        calls.push('poll');
        const done = over.after != null && reads >= over.after;
        // 앞 슬라이스 턴은 이미 끝나 있다 — 그것만 보면 열자마자 "끝남" 이 된다
        return {
          old: { worktree: hw, agent: 'codex', turnStartedAt: 900_000, turnEndedAt: 950_000 },
          ...(done ? { cur: { worktree: hw, agent: 'codex', turnStartedAt: 1_001_000, turnEndedAt: 1_001_000 + reads * 1000 } } : {}),
        };
      },
      sleep: async (ms) => calls.push('sleep:' + ms),
      now: () => (now += 1000),
    },
  };
};
const hlw = { name: 'slice6', path: 'C:/w/slice6', branch: 'slice6', terminals: [], turn: { known: true, active: false, agent: 'codex' } };
const agents = { codex: { cmd: 'codex', args: [] } };

test('헤드리스 충돌 — REPL 대신 --prompt 래퍼를 새 탭으로 띄우고, 턴 끝을 기록으로 기다린 뒤 push 한다', async () => {
  const { calls, deps } = headlessDeps({ after: 2 });
  const st = steps();
  const r = await conflictLoop(hlw, { mergeable: 'CONFLICTING' }, { conflictTries: 2, conflictMs: 30000, baseBranch: 'master', agents }, st.step, deps);
  assert.ok(!calls.includes('send') && !calls.includes('idle')); // 셸 탭에 지시를 쳐 넣지 않는다
  const create = calls.find((c) => c.startsWith('create:'));
  assert.match(create, /^create:slice6 충돌:.*sp-sync\.mjs worker --agent codex --prompt "origin\/master 머지해 충돌 풀고 커밋"$/);
  // 순서: 띄움 → 기록 폴링(첫 조회는 앞 턴뿐이라 대기) → 끝남 → push → PR 재조회
  assert.deepEqual(calls.filter((c) => !c.startsWith('sleep')).slice(1), ['poll', 'poll', 'push:C:/w/slice6', 'read']);
  assert.equal(r.pr.mergeable, 'MERGEABLE');
  assert.deepEqual(st.out.map((x) => [x.step, x.ok]), [['충돌 해소 1회', true], ['충돌 push 1회', true]]);
  assert.match(st.out[0].detail, /헤드리스\(codex\) 래퍼 턴 열음/);
});

test('헤드리스 충돌 — 래퍼 턴이 상한 안에 안 끝나면 접는다 (push 도 재시도도 없다)', async () => {
  const { calls, deps } = headlessDeps({}); // 영영 안 끝난다
  const st = steps();
  const r = await conflictLoop(hlw, { mergeable: 'CONFLICTING' }, { conflictTries: 2, conflictMs: 10000, baseBranch: 'master', agents }, st.step, deps);
  assert.equal(r.timedOut, true);
  assert.equal(r.pr.mergeable, 'CONFLICTING');
  assert.equal(calls.filter((c) => c.startsWith('create:')).length, 1); // 도는 래퍼 위에 같은 지시를 겹치지 않는다
  assert.ok(!calls.some((c) => c.startsWith('push')));
  assert.match(st.out.at(-1).detail, /래퍼 턴이 10초 안에 안 끝남/);
  // 탭을 못 열면 사용자 결정으로 (TUI 의 "창이 없음" 과 같은 자리)
  const t2 = headlessDeps({ handle: null });
  const r2 = await conflictLoop(hlw, { mergeable: 'CONFLICTING' }, { conflictTries: 2, conflictMs: 10000, baseBranch: 'master', agents }, steps().step, t2.deps);
  assert.equal(r2.noTerminal, true);
});

test('래퍼 프롬프트 명령 — 문장은 큰따옴표로 감싸고, 셸이 건드릴 글자는 거부한다', () => {
  const cmd = workerPromptCommand('codex', 'origin/master 머지해 충돌 풀고 커밋', agents);
  assert.match(cmd, /worker --agent codex --prompt "origin\/master 머지해 충돌 풀고 커밋"$/);
  // Orca 탭의 셸은 pwsh 다 — 따옴표로 싼 노드 경로는 호출 연산자 `&` 없이는 ParserError 로 죽는다 (2026-09-02 실측)
  assert.match(cmd, /^& /);
  assert.throws(() => workerPromptCommand('codex', 'say "hi"', agents), /쓸 수 없는 글자/);
  assert.throws(() => workerPromptCommand('gemini', 'x', agents), /모르는 에이전트/);
  // 턴 끝 판정은 since 이후에 시작한 래퍼 턴만 센다
  const s = { a: { worktree: 'C:/w/slice6', agent: 'codex', turnStartedAt: 10, turnEndedAt: 20 } };
  assert.equal(headlessTurnDone('c:/w/slice6/', 5, s), true);
  assert.equal(headlessTurnDone('C:/w/slice6', 15, s), false);
  assert.equal(headlessTurnDone('C:/w/slice6', 5, { a: { ...s.a, turnEndedAt: 0 } }), false);
  assert.equal(headlessTurnDone('C:/w/slice6', 5, { a: { ...s.a, agent: undefined } }), false); // TUI 세션은 안 센다
});

test('턴 상태 — 섞인 기록은 가장 최근 에이전트 종류가 판정이다', () => {
  const now = 1_000_000_000;
  // 지난 단계의 같은 번호 워크스페이스가 남긴 TUI 기록 + 앞 턴(끝남) + 묵은 래퍼 턴 — 2026-09-02 slice6 실측 모양
  const old = { a: S({ turnStartedAt: now - 9_000_000, turnEndedAt: now - 8_000_000 }), b: S({ agent: 'codex', turnStartedAt: now - 7_000_000, turnEndedAt: now - 6_000_000 }) };
  const stale = { ...old, c: S({ agent: 'codex', turnStartedAt: now - 7_200_000 - 1, turnEndedAt: undefined }) };
  // 시작 시각이 가장 늦은 래퍼 턴이 판정이다 — c 는 b 보다 먼저 열렸으므로 끝난 b 가 이긴다 → 유휴
  assert.deepEqual(turnStateFor('C:/w/slice8', stale, now), { known: true, active: false, endedAt: now - 6_000_000, agent: 'codex' });
  const stale2 = { ...old, c: S({ agent: 'codex', turnStartedAt: now - 5_000_000 }) }; // 앞 턴 뒤에 열렸고 1시간 넘게 안 끝남
  assert.deepEqual(turnStateFor('C:/w/slice8', stale2, now), { known: false, stale: true, agent: 'codex' });
  const live = { ...old, c: S({ agent: 'codex', turnStartedAt: now - 500 }) };
  assert.deepEqual(turnStateFor('C:/w/slice8', live, now), { known: true, active: true, startedAt: now - 500, agent: 'codex' });
  // codex → Claude 인계: 가장 최근 시작은 TUI 다. 옛 래퍼 기록이 있어도 TUI 규칙과 이름으로 돈다.
  const tui = { ...old, d: S({ turnStartedAt: now - 300 }) };
  assert.equal(turnStateFor('C:/w/slice8', tui, now).active, true);
  assert.equal(turnStateFor('C:/w/slice8', tui, now).agent, 'claude');
  const tuiDone = { ...old, d: S({ turnStartedAt: now - 300, turnEndedAt: now - 100 }) };
  assert.deepEqual(turnStateFor('C:/w/slice8', tuiDone, now), { known: true, active: false, endedAt: now - 100, agent: 'claude' });
});

// --- 같은 이름 브랜치의 옛 PR 을 이번 것으로 착각하지 않는다 (2026-09-02 SP-sync slice5, 3단계 PR #22) ---

test('머지된 옛 PR 은 head 가 지금 HEAD 일 때만 "정리만 남음"이다', () => {
  const sha = '85f4e1363416cff76d97bf0da61bbb04de27eb0c';
  assert.equal(prIsForHead({ state: 'MERGED', headRefOid: sha }, sha + '\n'), true);
  assert.equal(prIsForHead({ state: 'MERGED', headRefOid: sha }, 'c75cb447a0d3e84549cd7c0b03c3d79b2a555dfd'), false);
  // 어느 쪽이든 모르면 아니다 — 모르는 채로 워크스페이스를 지우면 안 된다
  assert.equal(prIsForHead({ state: 'MERGED' }, sha), false);
  assert.equal(prIsForHead({ state: 'MERGED', headRefOid: sha }, ''), false);
  assert.equal(prIsForHead(null, sha), false);
});

// --- 절전(Agent sleep, 슬라이스 28): 잠든 워크스페이스는 창이 없어도 유휴다 ---

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { projectWorkspaces, sleepingOf, sleepingAgents, redispatchOne, undispatched, isGoneError } from '../sp-sync.mjs';

const gitq = (args, cwd) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

/** 체크된 슬라이스 하나가 base 보다 커밋 한 개 앞선 진짜 저장소. `landCheckWork` 가 git 을 실제로 부른다. */
function readyRepo(n) {
  const dir = mkdtempSync(join(tmpdir(), 'sp-sleep-'));
  gitq(['init', '-q', '-b', 'master'], dir);
  writeFileSync(join(dir, 'PLAN.md'), '## 1단계\n\n- [ ] **' + n + '. 잠든 슬라이스**\n');
  gitq(['add', '.'], dir);
  gitq(['commit', '-q', '-m', 'base'], dir);
  gitq(['branch', 'base'], dir);
  writeFileSync(join(dir, 'PLAN.md'), '## 1단계\n\n- [x] **' + n + '. 잠든 슬라이스**\n');
  gitq(['commit', '-q', '-am', 'done'], dir);
  return dir;
}

// 실측(2026-09-07)의 모양 그대로: 잠든 창은 `terminal list` 에서 사라지고, `worktree list` 에는 평소처럼 남고,
// orca-data.json 의 sleeping 표에 `origin: 'worktree-sleep'` 으로만 있다. 살아 있는 창도 같은 표에 `live` 로 있다.
const fakeIo = (path, over = {}) => ({
  terminals: () => over.terminals || [],
  worktrees: () => [{ path, branch: 'refs/heads/slice8', isMainWorktree: false, isArchived: false, lastActivityAt: 1 }],
  sessions: () => over.sessions || {},
  sleeping: () => over.sleeping || new Map([[path.toLowerCase().replace(/\\/g, '/'), [{ agent: 'claude', state: 'done', capturedAt: Date.parse('2026-09-07T17:55:46+09:00'), sessionId: 's1', origin: 'worktree-sleep' }]]]),
  projectOf: () => ({ name: 'P', root: path }),
  branchOf: () => 'slice8',
});

test('절전 — 잠든 워크스페이스는 창 없이도 ready 다 (terminal list·worktree list 가짜 주입)', () => {
  const dir = readyRepo(8);
  const ws = projectWorkspaces(dir, fakeIo(dir));
  assert.equal(ws.length, 1);
  assert.deepEqual(ws[0].terminals, []); // 잠든 창은 목록에 없다
  assert.equal(ws[0].sleeping.length, 1);
  const c = landCheck(ws[0], { ...opts, baseRef: 'base' });
  assert.equal(c.ready, true);
  assert.match(c.reason, /^잠듦\(claude done 17:55\) · 체크 완료 · 커밋 1개 · 깨끗함$/);
  assert.equal(c.sleeping, '잠듦(claude done 17:55)');
  rmSync(dir, { recursive: true, force: true });
});

test('절전 — 잠들었는데 미체크면 막힘이고 사유에 "사람이 열어야 함"이 붙는다 (재파견 아님)', () => {
  const dir = readyRepo(8);
  writeFileSync(join(dir, 'PLAN.md'), '## 1단계\n\n- [ ] **8. 잠든 슬라이스**\n');
  gitq(['commit', '-q', '-am', 'uncheck'], dir);
  const w8 = projectWorkspaces(dir, fakeIo(dir))[0];
  const c = landCheck(w8, { ...opts, baseRef: 'base' });
  assert.equal(c.ready, false);
  assert.equal(c.blocked, true);
  assert.match(c.reason, /잠듦\(claude done 17:55\) · 유휴인데 8번이 미체크 — 막힘 .* — CLI 로 못 깨움 — 사람이 Orca 에서 탭을 열어야 함/);
  assert.equal(c.stalled.stalled, false); // 파견이 다시 보내지 않는다
  assert.match(c.stalled.why, /잠듦.*CLI 로 못 깨움/);
  rmSync(dir, { recursive: true, force: true });
});

test('절전 — 절전 기록이 없으면 예전처럼 "창이 없음"이고, 살아 있는 창이 있으면 잠든 것이 아니다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-sleep-'));
  const none = projectWorkspaces(dir, fakeIo(dir, { sleeping: new Map() }))[0];
  assert.equal(none.sleeping, null);
  assert.match(landCheck(none, opts).reason, /창이 없음 — 유휴인지 확인 불가/);
  // 옛 절전 기록이 남은 채 창이 살아 있으면(사람이 다시 열었다) 잠든 게 아니다 — 창 판정으로 간다
  const live = projectWorkspaces(dir, fakeIo(dir, { terminals: [{ handle: 't9', worktreePath: dir, connected: true }] }))[0];
  assert.deepEqual(live.terminals, ['t9']);
  assert.equal(sleepingOf(live), null);
  // 훅이 "턴 진행 중"이라 하면 잠듦보다 그쪽이 이긴다 — 틀리는 값의 비용이 비대칭이다
  const busy = projectWorkspaces(dir, fakeIo(dir, { sessions: { a: { worktree: dir, turnStartedAt: Date.now() - 1000 } } }))[0];
  assert.match(landCheck(busy, opts).reason, /턴 진행 중/);
  rmSync(dir, { recursive: true, force: true });
});

test('절전 — 잠든 창에는 재파견·충돌 지시를 보내지 않고 "사람이 열어야 함"으로 올린다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-sleep-'));
  const w8 = projectWorkspaces(dir, fakeIo(dir))[0];
  const sent = [];
  const io = { send: (h, t) => sent.push(t), read: () => ({ lines: ['❯'], draft: '' }), sleep: async () => {} };
  const r = await redispatchOne({ number: 8 }, w8, io);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'terminal');
  assert.match(r.detail, /잠듦\(claude done 17:55\) — CLI 로 못 깨움 — 사람이 Orca 에서 탭을 열어야 함/);
  assert.deepEqual(sent, []);
  // 충돌 루프도 같은 자리에서 접는다 — 셸 탭도 없고 깨울 길도 없다
  const { calls, deps } = fakeDeps();
  const st = steps();
  const c = await conflictLoop(w8, { mergeable: 'CONFLICTING' }, { conflictTries: 2, conflictMs: 1, baseBranch: 'master' }, st.step, deps);
  assert.equal(c.noTerminal, true);
  assert.equal(c.sleeping, true);
  assert.deepEqual(calls, []);
  assert.match(st.out[0].detail, /잠듦\(claude done 17:55\) — 못 보냄, CLI 로 못 깨움/);
  // 미파견 판정도 빈 창으로 읽지 않는다
  assert.match(undispatched({ terminals: false, sleeping: sleepingOf(w8) }).why, /잠듦.*사람이 Orca 에서 탭을 열어야 함/);
  rmSync(dir, { recursive: true, force: true });
});

test('절전 — orca-data.json 읽기: live 는 빼고 worktreeId 의 경로로 묶는다, 못 읽으면 빈 표', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-sleep-'));
  const f = join(dir, 'orca-data.json');
  writeFileSync(
    f,
    JSON.stringify({
      workspaceSession: {
        sleepingAgentSessionsByPaneKey: {
          'tab1:pane1': { worktreeId: 'repo::C:/Users/x/orca/workspaces/P/slice3', agent: 'claude', state: 'done', capturedAt: 5, origin: 'worktree-sleep', providerSession: { key: 'session_id', id: 'abc' } },
          'tab2:pane2': { worktreeId: 'repo::C:/Users/x/orca/workspaces/P/slice4', agent: 'claude', state: 'done', capturedAt: 6, origin: 'live' },
          'tab3:pane3': { worktreeId: 'repo::C:\\Users\\x\\orca\\workspaces\\P\\Slice3', agent: 'codex', state: 'done', capturedAt: 7, origin: 'quit', providerSession: { key: 'conversation_id', id: 'def' } },
        },
      },
    })
  );
  const m = sleepingAgents(f);
  assert.deepEqual([...m.keys()], ['c:/users/x/orca/workspaces/p/slice3']); // live 는 없고, 구분자·대소문자는 접힌다
  assert.deepEqual(m.get('c:/users/x/orca/workspaces/p/slice3').map((e) => e.sessionId), ['abc', 'def']);
  assert.equal(sleepingAgents(join(dir, 'nope.json')).size, 0);
  writeFileSync(f, '{ broken');
  assert.equal(sleepingAgents(f).size, 0);
  rmSync(dir, { recursive: true, force: true });
  // 잠든 창의 send/switch 가 내는 오류 코드 (2026-09-07 실측)
  assert.equal(isGoneError('terminal_not_writable'), true);
  assert.equal(isGoneError('terminal_exited'), true);
  assert.equal(isGoneError('timeout'), false);
});

// --- 최종 게이트: 검사한 커밋만 머지한다 (슬라이스 35, coordinator 점검 #1) ---

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('mergeGate — 셋이 같을 때만 merge', () => {
  assert.equal(mergeGate({ localHead: A, prHead: A, checkedSha: A }).action, 'merge');
});

test('mergeGate — 검사 뒤 커밋이 얹히면(로컬≠검사) merge 가 아니라 recheck', () => {
  assert.equal(mergeGate({ localHead: B, prHead: B, checkedSha: A }).action, 'recheck');
  // 로컬≠검사가 PR 머리보다 먼저다 — 검사부터 다시 해야 push 할 것이 정해진다
  assert.equal(mergeGate({ localHead: B, prHead: A, checkedSha: A }).action, 'recheck');
});

test('mergeGate — 열린 PR 의 원격 머리가 뒤처지면(PR≠로컬) merge 가 아니라 push', () => {
  assert.equal(mergeGate({ localHead: A, prHead: B, checkedSha: A }).action, 'push');
});

test('mergeGate — 모르는 값은 절대 merge 가 아니다', () => {
  assert.equal(mergeGate({ localHead: '', prHead: A, checkedSha: A }).action, 'recheck');
  assert.equal(mergeGate({ localHead: A, prHead: A, checkedSha: null }).action, 'recheck');
  assert.equal(mergeGate({ localHead: A, prHead: undefined, checkedSha: A }).action, 'push');
});

// `landOne` 의 바깥 손을 가짜로. `head` 는 호출마다 순서대로 값을 내 "검사 뒤에 커밋이 얹힘"을 흉내 내고
// (마지막 값에서 멈춘다), `read` 도 같은 식으로 PR 조회 결과를 순서대로 낸다.
const fakeLand = (over = {}) => {
  const calls = [];
  const heads = [...(over.heads || [A])];
  const prs = [...(over.prs || [])];
  const head = () => {
    const h = heads.length > 1 ? heads.shift() : heads[0];
    calls.push('head:' + h.slice(0, 1));
    return h;
  };
  const deps = {
    head,
    check: () => {
      const sha = head();
      calls.push('check:' + sha.slice(0, 1));
      return over.checkFail ? { ok: false, sha, detail: 'npm test: 1 failing' } : { ok: true, sha, detail: 'npm test' };
    },
    read: async () => {
      calls.push('read');
      const p = prs.length > 1 ? prs.shift() : prs[0];
      return p === undefined ? null : p;
    },
    push: async (path, first) => (calls.push('push' + (first ? ':-u' : '')), { ok: true }),
    create: () => calls.push('create'),
    merge: () => calls.push('merge'),
    conflict: async (w2, pr) => {
      calls.push('conflict');
      return over.conflict ? over.conflict(pr) : { pr };
    },
    recheck: () => (calls.push('recheck'), over.recheck || { ready: true, reason: '체크 완료 · 커밋 2개 · 깨끗함' }),
    cleanup: async (w2, r) => (calls.push('cleanup'), { ...r, ok: true }),
  };
  return { calls, deps };
};
const lopts = { quiet: true, baseBranch: 'master', conflictTries: 2 };
const lw2 = { name: 'slice35', path: 'C:/w/slice35', branch: 'slice35', slice: 35, terminals: ['t1'] };
const open = (head, over = {}) => ({ number: 7, state: 'OPEN', mergeable: 'MERGEABLE', url: 'u', headRefOid: head, ...over });
const stepNames = (r) => r.steps.map((x) => x.step);

test('landOne 정상 — check → push → PR → final 이 같은 SHA 로 서고 merge 한다', async () => {
  const { calls, deps } = fakeLand({ prs: [null, open(A)] });
  const r = await landOne(lw2, { ready: true }, lopts, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(stepNames(r), ['check aaaaaaa', 'push aaaaaaa', 'pr create', 'final aaaaaaa', 'pr merge']);
  assert.equal(r.checkedSha, A);
  assert.equal(r.finalSha, A);
  // 게이트가 merge 를 낸 뒤에야 merge 를 부른다
  assert.ok(calls.indexOf('merge') > calls.lastIndexOf('head:a'));
});

test('landOne — 검사 명령이 없어도 SHA 일치 확인은 한다', async () => {
  const { deps } = fakeLand({ prs: [open(A)] });
  const r = await landOne(lw2, { ready: true }, { ...lopts, check: null }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(stepNames(r), ['check aaaaaaa', 'pr 있음', 'final aaaaaaa', 'pr merge']);
});

test('landOne — 검사 뒤 커밋이 얹히면 옛 검사로 머지하지 않는다: 재판정 → 재검사 → final', async () => {
  // head 순서: check(A) → "pr 있음" 경로의 head 가 B(검사 뒤에 얹힌 커밋) → push → 게이트 B≠검사 A → 재판정·재검사(B) → 게이트 통과
  const { calls, deps } = fakeLand({ heads: [A, B], prs: [open(A), open(B)] });
  const r = await landOne(lw2, { ready: true }, lopts, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(stepNames(r), ['check aaaaaaa', 'pr 있음', 'push bbbbbbb', '재판정 bbbbbbb', 'check bbbbbbb', 'final bbbbbbb', 'pr merge']);
  assert.equal(r.checkedSha, B);
  assert.equal(r.finalSha, B);
  // 옛 검사 SHA(A) 로는 merge 를 부르지 않았다 — merge 는 두 번째 check 뒤에 한 번
  assert.equal(calls.filter((c) => c === 'merge').length, 1);
  assert.ok(calls.indexOf('merge') > calls.lastIndexOf('check:b'));
});

test('landOne — 열린 PR 의 원격 머리가 뒤처지면 push 로 맞춘 뒤에야 merge 한다', async () => {
  // 로컬은 A 인데 PR 머리는 옛 커밋 B. 첫 read 는 뒤처진 PR, push 뒤 read 는 맞춰진 PR.
  const { calls, deps } = fakeLand({ heads: [A], prs: [open(B), open(A)] });
  const r = await landOne(lw2, { ready: true }, lopts, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(stepNames(r), ['check aaaaaaa', 'pr 있음', 'push aaaaaaa', 'final aaaaaaa', 'pr merge']);
  assert.ok(calls.indexOf('push') < calls.indexOf('merge'));
});

test('landOne — 충돌 해소가 커밋을 바꾸면 그 HEAD 로 다시 검사한 뒤에만 merge 한다', async () => {
  // 검사는 A, PR 머리도 A(충돌). 충돌 루프가 머지 커밋 B 를 만들어 밀었다 — 그 뒤 로컬·PR 머리 모두 B.
  const { calls, deps } = fakeLand({
    heads: [A, A, B],
    prs: [open(A, { mergeable: 'CONFLICTING' }), open(B)],
    conflict: async () => (calls.push('resolved'), { pr: open(B) }),
  });
  const r = await landOne(lw2, { ready: true }, lopts, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(stepNames(r), ['check aaaaaaa', 'pr 있음', '재판정 bbbbbbb', 'check bbbbbbb', 'final bbbbbbb', 'pr merge']);
  assert.equal(r.checkedSha, B);
  assert.ok(calls.indexOf('merge') > calls.indexOf('resolved'));
  assert.ok(calls.indexOf('merge') > calls.lastIndexOf('check:b'));
});

test('landOne — 재판정에서 자격이 안 나오면(트리 더러움 등) 머지하지 않는다', async () => {
  const { calls, deps } = fakeLand({ heads: [A, B], prs: [open(A), open(B)], recheck: { ready: false, reason: '작업 트리가 더러움 — 커밋 안 된 변경이 있다' } });
  const r = await landOne(lw2, { ready: true }, lopts, deps);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'recheck');
  assert.ok(!calls.includes('merge'));
  assert.match(r.steps.at(-1).detail, /더러움/);
});

test('landOne — 재검사가 실패하면 머지하지 않는다', async () => {
  const { calls, deps } = fakeLand({ heads: [A, A, B], prs: [open(A), open(B)], checkFail: false });
  // 첫 검사는 통과, 두 번째(B)부터 실패하게
  let n = 0;
  deps.check = () => {
    const sha = deps.head();
    n++;
    return n === 1 ? { ok: true, sha, detail: 'npm test' } : { ok: false, sha, detail: 'npm test: 1 failing' };
  };
  const r = await landOne(lw2, { ready: true }, lopts, deps);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'check');
  assert.ok(!calls.includes('merge'));
  assert.equal(r.steps.at(-1).step, 'check bbbbbbb');
});

test('landOne — 원격이 계속 뒤처지면 상한 뒤 접는다, merge 없이', async () => {
  const { calls, deps } = fakeLand({ heads: [A], prs: [open(B)] }); // read 가 매번 옛 머리 B
  const r = await landOne(lw2, { ready: true }, lopts, deps);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'final');
  assert.ok(!calls.includes('merge'));
  assert.equal(r.steps.at(-1).step, 'final');
});

test('landOne — 이미 머지된 것은 검사·게이트 없이 정리만', async () => {
  const { calls, deps } = fakeLand();
  const r = await landOne(lw2, { ready: true, merged: true, pr: 3 }, lopts, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['cleanup']);
});
