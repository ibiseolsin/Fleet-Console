// node --test sp-sync/test/*.test.mjs
// 슬라이스 16 — 지시 없는 워크스페이스 재파견 + 회차 도중 회차 코드가 머지되는 것
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { undispatched, undispatchedCheck, dispatchPlan, redispatchOne, renderDispatch, renderCycleReport, selfHash, sliceCommandFor } from '../sp-sync.mjs';
// 진입점은 이번 슬라이스에서 손대지 않는다(4·6 과 병렬) — 새 헬퍼는 모듈에서 바로 가져온다.
import { claudeTerminal } from '../lib/fleet.mjs';

const facts = (over = {}) => ({ terminals: true, commits: 0, statusMd: false, screen: 'unknown', screenSource: null, screenError: null, idle: true, ...over });

// --- 판정: 무엇 하나라도 "일한 흔적"이면 손대지 않는다 ---

test('창·커밋·status.md·화면·유휴가 다 비어야 재파견 대상', () => {
  assert.equal(undispatched(facts()).stalled, true);
  assert.match(undispatched(facts()).why, /지시 미전송/);
});

test('일한 흔적이 하나라도 있으면 재파견하지 않는다 — 사유가 무엇인지도 남는다', () => {
  const cases = [
    [{ terminals: false }, /창이 없음/],
    [{ commits: 2 }, /커밋 2개/],
    [{ statusMd: true }, /status\.md/],
    [{ screen: 'submitted' }, /화면에 지시·진행 흔적/],
    [{ screenError: 'orca 안 뜸' }, /화면을 못 읽음: orca 안 뜸/],
    // 슬라이스 27 — 렌더된 화면 대신 누적 스트림이 오면 "흔적 없음" 이 근거가 못 된다
    [{ screenSource: 'screen-unavailable' }, /스트림 폴백/],
    [{ screenSource: 'screen-unavailable', screen: 'stuck' }, /스트림 폴백/],
    [{ idle: false }, /작업 중/],
  ];
  for (const [over, re] of cases) {
    const r = undispatched(facts(over));
    assert.equal(r.stalled, false, JSON.stringify(over));
    assert.match(r.why, re);
  }
});

test('스트림 폴백이어도 제출 흔적이 잡혔으면 그것은 흔적이다', () => {
  const r = undispatched(facts({ screenSource: 'screen-unavailable', screen: 'submitted' }));
  assert.equal(r.stalled, false);
  assert.match(r.why, /화면에 지시·진행 흔적/);
});

test('글이 입력창에 남은 창은 재파견하되 그 사실을 사유에 적는다', () => {
  // 2026-08-30 의 실제 모양 — `Waiting for setup…` 화면에 보낸 글이 Orca draft 에 남았다
  const r = undispatched(facts({ screen: 'stuck' }));
  assert.equal(r.stalled, true);
  assert.match(r.why, /입력창에 남아 있음/);
});

// --- 재료 모으기: 실제 git 저장소로 커밋 수를 센다 ---

const gitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-redis-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', windowsHide: true });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a');
  g('add', '-A');
  g('commit', '-qm', 'first');
  return { dir, g };
};
const wsOf = (dir, over = {}) => ({ name: 'slice9', path: dir, branch: 'slice9', slice: 9, terminals: ['t1'], ...over });
const io = (lines, draft = '') => ({ read: () => ({ lines, draft }) });

test('커밋이 없고 status.md 도 없고 화면도 빈 창 → 지시 미전송', () => {
  const { dir } = gitRepo();
  try {
    // `HEAD..HEAD` 가 비어 있으므로 "base 대비 커밋 0" 과 같은 상태다
    const r = undispatchedCheck(wsOf(dir), { baseRef: 'HEAD', idle: true, text: '/slice 9' }, io(['', '❯', '']));
    assert.equal(r.stalled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('커밋이 하나라도 있으면 재파견하지 않는다', () => {
  const { dir } = gitRepo();
  try {
    const r = undispatchedCheck(wsOf(dir), { baseRef: 'HEAD~0^', idle: true, text: '/slice 9' }, io(['❯']));
    // 첫 커밋이라 `HEAD~0^` 은 없다 — 못 읽으면 "커밋이 있다"로 보는 안전쪽 기본값
    assert.equal(r.stalled, false);
    assert.match(r.why, /커밋 1개/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status.md 가 있으면 턴을 돌았다는 뜻이라 재파견하지 않는다', () => {
  const { dir } = gitRepo();
  try {
    writeFileSync(join(dir, 'status.md'), '# 지금');
    const r = undispatchedCheck(wsOf(dir), { baseRef: 'HEAD', idle: true, text: '/slice 9' }, io(['❯']));
    assert.equal(r.stalled, false);
    assert.match(r.why, /status\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('이력에 그 지시가 이미 있으면 재파견하지 않는다 — 같은 말을 매 회차 다시 보내지 않는다', () => {
  const { dir } = gitRepo();
  try {
    const screen = io(['❯ /slice 9', '● 읽는 중…', '', '❯']);
    assert.equal(undispatchedCheck(wsOf(dir), { baseRef: 'HEAD', idle: true, text: '/slice 9' }, screen).stalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('창이 없으면 화면도 git 도 안 본다', () => {
  const r = undispatchedCheck(wsOf('C:/nope', { terminals: [] }), { baseRef: 'HEAD' }, io([]));
  assert.equal(r.stalled, false);
  assert.match(r.why, /창이 없음/);
});

test('화면을 못 읽으면 손대지 않는다', () => {
  const { dir } = gitRepo();
  try {
    const bad = { read: () => { throw new Error('orca terminal read 실패'); } };
    const r = undispatchedCheck(wsOf(dir), { baseRef: 'HEAD', idle: true, text: '/slice 9' }, bad);
    assert.equal(r.stalled, false);
    assert.match(r.why, /화면을 못 읽음/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 파견 판정에 재파견이 끼어든다 ---

const s = (number, tags = [], extra = {}) => ({ number, title: 't' + number, tags, decision: null, done: false, workspace: null, ...extra });
const ws = (name, slice, stalled) => ({ name, path: 'C:/w/' + name, branch: 'u/' + name, slice, terminals: ['t1'], stalled });
const STALLED = { stalled: true, why: '지시 미전송 — 커밋 0 · status.md 없음 · 화면에 지시 흔적 없음' };
const WORKING = { stalled: false, why: '커밋 3개 — 일한 흔적이 있다' };

test('지시 없는 워크스페이스는 재파견 대상이 된다 — 새로 띄우지 않는다', () => {
  const w = ws('slice9', 9, STALLED);
  const p = dispatchPlan({ slices: [s(9, [], { workspace: w })], workspaces: [w], max: 3 });
  assert.equal(p[0].eligible, true);
  assert.equal(p[0].redispatch, w); // 워크스페이스를 만들지 않고 이 창에 보낸다
  assert.match(p[0].reason, /^재파견 —/);
});

test('이미 커밋이 있는 워크스페이스는 재파견되지 않는다', () => {
  const w = ws('slice9', 9, WORKING);
  const p = dispatchPlan({ slices: [s(9, [], { workspace: w })], workspaces: [w], max: 3 });
  assert.equal(p[0].eligible, false);
  assert.match(p[0].reason, /이미 돌고 있음 \(slice9\) — 커밋 3개/);
});

test('상한이 찼어도 재파견은 나간다 — 그 자리는 이미 세어져 있다', () => {
  const w = ws('slice9', 9, STALLED);
  const p = dispatchPlan({ slices: [s(9, [], { workspace: w })], workspaces: [w], max: 1 });
  assert.equal(p[0].eligible, true);
});

test('본체가 앞서 있으면 재파견도 보류한다 — 그 창의 PLAN.md 에 슬라이스가 없을 수 있다', () => {
  const w = ws('slice9', 9, STALLED);
  const p = dispatchPlan({ slices: [s(9, [], { workspace: w })], workspaces: [w], max: 3, block: '본체가 origin/master 보다 2 커밋 앞섬 — push 필요' });
  assert.equal(p[0].eligible, false);
  assert.match(p[0].reason, /push 필요 — slice9 재파견 보류/);
});

test('판정을 안 한 워크스페이스(체크된 슬라이스 등)는 예전대로 "이미 돌고 있음"', () => {
  const w = ws('slice9', 9, undefined);
  const p = dispatchPlan({ slices: [s(9, [], { workspace: w })], workspaces: [w], max: 3 });
  assert.equal(p[0].eligible, false);
  assert.equal(p[0].reason, '이미 돌고 있음 (slice9)');
});

// --- 실제 재전송 ---

test('재파견은 있는 창에 지시를 보내고 보고에 "재파견"으로 적힌다', async () => {
  const calls = [];
  const fake = {
    send: (h, text) => calls.push('send:' + h + ':' + text),
    // 입력창은 화면 맨 아래 빈 ❯ 다. 위의 '❯ /slice 9' 는 이력이고, 그게 제출 증거다.
    read: () => ({ lines: ['❯ /slice 9', '● 읽는 중…', '', '❯'], draft: '' }),
    sleep: async () => {},
  };
  const d = await redispatchOne(s(9), ws('slice9', 9, STALLED), fake);
  assert.equal(d.ok, true);
  assert.equal(d.redispatch, true);
  assert.equal(d.submit, '재파견 · 제출 확인');
  // 지시 문구는 그 워크스페이스에 /slice 스킬이 있느냐로 갈린다 — 여기서 다시 못 박지 않는다
  assert.deepEqual(calls, ['send:t1:' + sliceCommandFor('C:/w/slice9', 9)]);
});

test('창이 없으면 아무것도 안 보낸다', async () => {
  const calls = [];
  const fake = { send: () => calls.push('send'), read: () => ({ lines: [], draft: '' }), sleep: async () => {} };
  const d = await redispatchOne(s(9), { ...ws('slice9', 9, STALLED), terminals: [] }, fake);
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'terminal');
  assert.deepEqual(calls, []);
});

test('표의 판정 열이 파견과 재파견을 가른다', () => {
  const out = renderDispatch({
    project: 'P',
    max: 3,
    active: 1,
    dryRun: true,
    decisions: [
      { number: 9, title: 't9', tags: [], eligible: true, reason: '재파견 — 지시 미전송', redispatch: 'slice9' },
      { number: 10, title: 't10', tags: ['parallel'], eligible: true, reason: '병렬 가능', redispatch: null },
    ],
    dispatched: [],
  });
  assert.match(out, /9 .*재파견 .*지시 미전송/);
  assert.match(out, /10 .*파견 .*병렬 가능/);
});

// --- 회차 도중 회차 코드가 머지되는 것 ---

test('해시는 읽을 수 있고 부를 때마다 같다', () => {
  const h = selfHash();
  assert.match(h, /^[0-9a-f]{40}$/);
  assert.equal(selfHash(), h);
});

test('착륙이 코드를 바꾼 회차는 파견 0건으로 끝나고 사유가 보고에 남는다', () => {
  const out = renderCycleReport({
    at: new Date(2026, 7, 30, 22, 0).getTime(),
    dryRun: false,
    projects: [
      { project: 'SP-sync', land: { landed: [{ name: 'slice11', ok: true, pr: 2, ff: true }], checks: [] }, dispatchSkipped: '회차 코드 갱신됨 — 파견은 다음 회차' },
      { project: 'coordinator', dispatchSkipped: '회차 코드 갱신됨 — 파견은 다음 회차' },
    ],
  });
  assert.match(out, /⚠ 회차 코드 갱신됨 — 파견은 다음 회차 \(SP-sync, coordinator\)/);
  assert.match(out, /· 파견 0 ·/); // 건너뛴 것이 파견 건수로 세어지면 "0건" 이 흐려진다
  assert.match(out, /\*\*파견\*\* — 없음/);
  assert.match(out, /머지됨 #2/); // 착륙은 그대로 보고된다
});

test('코드가 그대로면 그 줄이 안 나온다', () => {
  const out = renderCycleReport({ at: Date.now(), dryRun: false, projects: [{ project: 'P', dispatch: { dispatched: [], decisions: [] } }] });
  assert.doesNotMatch(out, /회차 코드 갱신됨/);
});

test('회차 보고의 파견 표에 재파견이 첫 파견과 구별되어 실린다', () => {
  const out = renderCycleReport({
    at: Date.now(),
    dryRun: false,
    projects: [{ project: 'P', dispatch: { decisions: [], dispatched: [{ name: 'slice9', ok: true, redispatch: true, submit: '재파견 · 제출 확인', text: '/slice 9' }] } }],
  });
  assert.match(out, /\| P \| slice9 \| 재파견 · 제출 확인 \| \/slice 9 \|/);
});

test('dry-run 은 재파견 예정을 워크스페이스 이름으로 적는다', () => {
  const out = renderCycleReport({
    at: Date.now(),
    dryRun: true,
    projects: [{ project: 'P', dispatch: { dispatched: [], decisions: [{ number: 9, title: 't', eligible: true, reason: '재파견 — 지시 미전송', redispatch: 'slice9' }] } }],
  });
  assert.match(out, /\| P \| slice9 \| 예정 \| 재파견 — 지시 미전송 \|/);
});

// --- 슬라이스 3: 지시는 Claude 창으로 간다 ---
// 파견된 워크스페이스에는 창이 셋이다 — Orca 기본 터미널, 설정 스크립트가 돈 pwsh, Claude.
// `terminals[0]` 은 Orca 목록 순서일 뿐이라 셸 탭에 `/slice 9` 를 쳐 넣을 수 있었다.

const SHELL = ['PS C:/Users/u/slice9> ', ''];
const CLAUDE = ['❯ /slice 9', '● 읽는 중…', '', '❯'];

test('창이 여럿이면 Claude 프롬프트가 뜬 창을 고른다', () => {
  const screens = { t1: SHELL, t2: SHELL, t3: CLAUDE };
  const seen = [];
  const fake = { read: (h) => (seen.push(h), { lines: screens[h], draft: '' }) };
  assert.equal(claudeTerminal(['t1', 't2', 't3'], fake), 't3');
  assert.deepEqual(seen, ['t1', 't2', 't3']);
});

test('창이 하나면 화면을 읽지 않는다 — 고를 것이 없다', () => {
  const fake = { read: () => { throw new Error('읽으면 안 된다'); } };
  assert.equal(claudeTerminal(['t1'], fake), 't1');
  assert.equal(claudeTerminal([], fake), null);
});

test('창이 여럿인데 하나도 안 맞으면 null — 첫 창으로 떨어지지 않는다', () => {
  // 모르는 채로 첫 창에 보내면 셸 탭에 지시가 쳐 넣어지고 부른 쪽은 "보냈다"로 센다
  assert.equal(claudeTerminal(['t1', 't2'], { read: () => ({ lines: SHELL, draft: '' }) }), null);
  assert.equal(claudeTerminal(['t1', 't2'], { read: () => { throw new Error('orca 안 뜸'); } }), null);
});

test('Claude 창을 못 고르면 재파견은 아무것도 안 보내고 그렇게 보고한다', async () => {
  const calls = [];
  const fake = {
    send: (h, text) => calls.push('send:' + h + ':' + text),
    read: () => ({ lines: SHELL, draft: '' }),
    sleep: async () => {},
  };
  const d = await redispatchOne(s(9), { ...ws('slice9', 9, STALLED), terminals: ['t1', 't2'] }, fake);
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'terminal');
  assert.match(d.detail, /Claude 창을 못 고름/);
  assert.deepEqual(calls, []);
});

test('재파견은 셸 탭이 아니라 Claude 창에 보낸다', async () => {
  const calls = [];
  const screens = { t1: SHELL, t2: CLAUDE };
  const fake = {
    send: (h, text) => calls.push('send:' + h + ':' + text),
    read: (h) => ({ lines: screens[h], draft: '' }),
    sleep: async () => {},
  };
  const d = await redispatchOne(s(9), { ...ws('slice9', 9, STALLED), terminals: ['t1', 't2'] }, fake);
  assert.equal(d.handle, 't2');
  assert.equal(d.ok, true);
  assert.deepEqual(calls, ['send:t2:' + sliceCommandFor('C:/w/slice9', 9)]);
});

// --- 4단계 슬라이스 4: 헤드리스 워크스페이스의 미파견 판정과 재파견 제외 ---
// 헤드리스에는 화면도 REPL 도 없다. 지시는 명령줄에 실려 래퍼가 뜬 순간 들어갔고, 래퍼가 턴 경계를
// 세션 기록에 찍는다 — "턴 기록 있음 = 파견됨". 턴이 끝났는데 미체크면 막힘이지 빈 창이 아니다.

const HL = (turn, over = {}) => ({ terminals: true, headless: 'codex', turn, commits: 0, ...over });

test('헤드리스는 턴 기록으로만 가른다 — 진행 중·끝남·기록 없음·묵음 전부 재파견 대상이 아니다', () => {
  const cases = [
    [HL({ known: true, active: true }), /헤드리스\(codex\) 작업 중/],
    [HL({ known: true, active: false }), /헤드리스\(codex\) 턴 끝남 — 미체크면 막힘, 재파견하지 않음/],
    [HL({ known: false }), /래퍼 턴 기록이 없음 — 래퍼가 뜨지 못한 듯/],
    [HL({ known: false, stale: true }), /래퍼 턴이 안 끝난 채 오래됨/],
  ];
  for (const [f, re] of cases) {
    const r = undispatched(f);
    assert.equal(r.stalled, false, JSON.stringify(f));
    assert.match(r.why, re);
  }
  // 커밋 수는 보고에만 붙는다 — 판정 재료가 아니다
  assert.match(undispatched(HL({ known: true, active: false }, { commits: 2 })).why, /커밋 2개/);
});

test('창이 0개여도 턴 기록이 있으면 끝난 헤드리스 워커다 — 빈 창으로 읽지 않는다', () => {
  // 실측(2026-09-02)에서는 프로세스가 끝나도 탭이 셸 프롬프트로 남지만, 사람이 닫을 수 있다.
  const r = undispatched(HL({ known: true, active: false }, { terminals: false }));
  assert.equal(r.stalled, false);
  assert.match(r.why, /턴 끝남.*창 없음/);
});

test('헤드리스 워크스페이스는 화면을 읽지 않는다 — 셸 프롬프트를 빈 ❯ 로 오독하면 안 된다', () => {
  const { dir } = gitRepo();
  try {
    const bad = { read: () => { throw new Error('화면을 읽으면 안 된다'); } };
    // 세션 기록에 agent 가 있는 경우
    const recorded = wsOf(dir, { turn: { known: true, active: false, agent: 'codex' } });
    let r = undispatchedCheck(recorded, { baseRef: 'HEAD', text: '/slice 9' }, bad);
    assert.equal(r.stalled, false);
    assert.match(r.why, /헤드리스\(codex\) 턴 끝남/);
    // 기록은 없고 계획(슬라이스 태그)만 헤드리스인 경우 — 래퍼가 못 뜬 것이라 사람 몫
    const planned = wsOf(dir, { turn: { known: false }, agent: 'antigravity' });
    r = undispatchedCheck(planned, { baseRef: 'HEAD', text: '/slice 9' }, bad);
    assert.equal(r.stalled, false);
    assert.match(r.why, /헤드리스\(antigravity\) 인데 래퍼 턴 기록이 없음/);
    // 창이 0개 + 기록 있음 = 끝난 헤드리스 워커
    r = undispatchedCheck(wsOf(dir, { terminals: [], turn: { known: true, active: false, agent: 'codex' } }), { baseRef: 'HEAD' }, bad);
    assert.equal(r.stalled, false);
    assert.match(r.why, /턴 끝남.*창 없음/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('헤드리스 워크스페이스는 파견 판정에서 "이미 돌고 있음" 으로 남고 재파견 대상이 아니다', () => {
  const w = ws('slice6', 6, { stalled: false, why: '헤드리스(codex) 턴 끝남 — 미체크면 막힘, 재파견하지 않음' });
  const p = dispatchPlan({ slices: [s(6, ['agent'], { agent: 'codex', workspace: w })], workspaces: [w], max: 3 });
  assert.equal(p[0].eligible, false);
  assert.match(p[0].reason, /이미 돌고 있음 \(slice6\) — 헤드리스\(codex\) 턴 끝남/);
});

test('재파견은 헤드리스에 적용되지 않는다 — 기록으로든 계획으로든 REPL 에 아무것도 안 보낸다', async () => {
  const calls = [];
  const fake = { send: () => calls.push('send'), read: () => ({ lines: CLAUDE, draft: '' }), sleep: async () => {} };
  // 세션 기록이 헤드리스
  let d = await redispatchOne(s(6), { ...ws('slice6', 6, STALLED), turn: { known: true, active: false, agent: 'codex' } }, fake);
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'headless');
  assert.match(d.detail, /헤드리스\(codex\).*재파견하지 않음/);
  // 계획(슬라이스 태그)이 헤드리스
  d = await redispatchOne(s(6, ['agent'], { agent: 'antigravity' }), ws('slice6', 6, STALLED), fake);
  assert.equal(d.stage, 'headless');
  assert.match(d.detail, /antigravity/);
  assert.deepEqual(calls, []);
  // claude 는 그대로 간다
  d = await redispatchOne(s(9, [], { agent: 'claude' }), ws('slice9', 9, STALLED), fake);
  assert.equal(d.ok, true);
  assert.deepEqual(calls, ['send']);
});
