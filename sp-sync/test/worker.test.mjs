// node --test sp-sync/test/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// **이 파일만 홈을 갈아끼운다.** 래퍼는 `~/.sp-sync/` 에 세션 기록과 카드를 쓰므로 진짜 홈에서
// 돌리면 사용자의 state.json 과 SP 기록을 건드린다. `os.homedir()` 는 Windows 에서 `USERPROFILE`
// 을 읽고 그 값은 **모듈이 로드될 때** 굳으므로, 바꾼 뒤에 동적 import 한다 — 그래서 이 파일에는
// 정적 import 가 없다. (`node --test` 는 파일마다 프로세스를 따로 띄우므로 옆 테스트에 안 샌다.)
const HOME = mkdtempSync(join(tmpdir(), 'sp-worker-home-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const DIR = join(HOME, '.sp-sync');
const DROP = join(DIR, 'drop');
mkdirSync(DROP, { recursive: true });

const { runWorker, agentProfile, buildAgentArgs, quoteWinArg, spawnSpec, workerSessionId, openWrapperTurn, EXIT_BUSY, EXIT_NOSESSION } = await import('../sp-sync.mjs');
const { updateCard, ensureSession } = await import('../lib/hooks.mjs');

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
});

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const sessionOf = (id) => readJson(join(DIR, 'state.json')).sessions[id];
const cardOf = (id) => readJson(join(DIR, 'cards', id + '.json'));

// ---------- 프로필 ----------
test('agentProfile — 표에 없는 이름은 던진다 (파견이 그 슬라이스만 보류한다)', () => {
  const cfg = { fleetAgents: { codex: { cmd: 'codex', args: [] } } };
  assert.equal(agentProfile('codex', cfg).cmd, 'codex');
  assert.throws(() => agentProfile('opencode', cfg), /모르는 에이전트: opencode/);
  assert.throws(() => agentProfile(null, cfg), /모르는 에이전트/);
  // 이름만 있고 명령이 없는 프로필도 못 띄운다 — 조용히 빈 명령을 spawn 하면 안 된다.
  assert.throws(() => agentProfile('x', { fleetAgents: { x: {} } }), /모르는 에이전트: x/);
});

test('buildAgentArgs — {path}·{prompt} 치환과 {hard} 펼치기', () => {
  const codex = {
    cmd: 'codex',
    args: ['exec', '{hard}', '-C', '{path}', '-s', 'workspace-write', '{prompt}'],
    hard: ['-m', 'gpt-5.1-codex-max'],
  };
  // 표준 모델: {hard} 토큰은 흔적 없이 사라진다
  assert.deepEqual(buildAgentArgs(codex, { path: 'C:/w/slice6', prompt: '슬라이스 6 진행' }), [
    'exec', '-C', 'C:/w/slice6', '-s', 'workspace-write', '슬라이스 6 진행',
  ]);
  // [어려움]: 그 자리에서 배열로 펼쳐진다
  assert.deepEqual(buildAgentArgs(codex, { path: 'C:/w/slice6', prompt: 'p', hard: true }), [
    'exec', '-m', 'gpt-5.1-codex-max', '-C', 'C:/w/slice6', '-s', 'workspace-write', 'p',
  ]);
  // agy 는 프롬프트가 -p 의 값이고 hard 가 맨 뒤다 — 자리표시자를 쓰는 이유
  const agy = { cmd: 'agy', args: ['-p', '{prompt}', '--print-timeout', '4h', '{hard}'], hard: ['--model', 'gemini-3.1-pro-high'] };
  assert.deepEqual(buildAgentArgs(agy, { path: 'C:/w', prompt: '슬라이스 7 진행', hard: true }), [
    '-p', '슬라이스 7 진행', '--print-timeout', '4h', '--model', 'gemini-3.1-pro-high',
  ]);
});

test('workerSessionId — 파일 이름이 되므로 안전한 글자만', () => {
  const id = workerSessionId('codex', Date.parse('2026-09-01T14:35:12Z'), 0.123456);
  assert.match(id, /^codex-20260901T143512-[a-z0-9]+$/);
});

// ---------- Windows 배치 셔임 ----------
test('spawnSpec — .cmd 셔임은 cmd.exe 를 거친다 (Node 는 셸 없이 못 띄운다)', { skip: process.platform !== 'win32' }, () => {
  const spec = spawnSpec('C:/npm/codex.cmd', ['exec', 'a b']);
  assert.match(spec.file, /cmd\.exe$/i);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(spec.args[3], '""C:/npm/codex.cmd" "exec" "a b""');
  assert.equal(spec.verbatim, true);
  // 진짜 실행 파일은 그대로 — 따옴표 문제가 아예 없는 길이다
  const exe = spawnSpec(process.execPath, ['-v']);
  assert.equal(exe.file, process.execPath);
  assert.equal(exe.verbatim, false);
});

test('quoteWinArg — 캐럿을 붙이지 않는다 (셔임의 %* 가 그대로 넘긴다)', () => {
  assert.equal(quoteWinArg('a & b'), '"a & b"');
  assert.equal(quoteWinArg('C:/a b/c'), '"C:/a b/c"');
  assert.equal(quoteWinArg('back\\'), '"back\\\\"'); // 끝 역슬래시는 겹친다
});

// ---------- 한 턴 (진짜로 자식을 띄운다) ----------
const fake = (js, tail = []) => ({ cmd: process.execPath, args: ['-e', js, ...tail] });

test('가짜 에이전트 한 턴 — 턴 경계·agent·카드·종료 코드', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sp-worker-ws-'));
  const id = 'codex-test-drop';
  // 자식이 스스로 카드를 떨군다 — 규칙 문서의 스니펫과 같은 자리(세션 id 는 env 로 받는다).
  // 받은 인자도 카드에 실어 프롬프트·{path} 치환이 실제로 자식까지 갔는지 본다.
  const js =
    "const fs=require('fs'),p=" +
    JSON.stringify(DROP) +
    "+'/'+process.env.CLAUDE_CODE_SESSION_ID+'.json';" +
    "fs.writeFileSync(p,JSON.stringify({now:'ARGV '+process.argv.slice(1).join(' | ')}));process.exit(3)";

  const before = Date.now();
  const code = await runWorker(
    { agent: 'codex', slice: 7, cwd },
    { sessionId: id, profile: fake(js, ['{prompt}', '{path}']), onTurnEnd: (h) => updateCard(h) }
  );

  assert.equal(code, 3, '에이전트 종료 코드를 그대로 돌려준다');

  const s = sessionOf(id);
  assert.equal(s.agent, 'codex', '헤드리스 표시 — 착륙·미파견 판정이 이걸 본다');
  // 래퍼는 저장소의 "마지막 프롬프트 창" 자리를 차지하지 않는다 — 차지하면 래퍼가 죽은 뒤 본체에서 손으로 낸
  // 커밋이 이 세션에 붙어 SP 로 가는 통로를 잃는다 (2026-09-02, 커밋 4건).
  assert.equal(Object.values(readJson(join(DIR, 'state.json')).repos || {}).includes(id), false, '래퍼 세션은 repos 에 안 오른다');
  assert.ok(s.turnStartedAt >= before && s.turnEndedAt >= s.turnStartedAt, '턴 경계가 둘 다 찍힌다');

  const card = cardOf(id);
  // 프롬프트는 래퍼가 만든 고정 문장이고, {path} 는 워크스페이스 경로다
  assert.match(card.now, /^ARGV PRD\.md, PLAN\.md 읽고 슬라이스 7 진행\. 끝나면 PLAN\.md 체크하고 커밋\. \| /);
  assert.ok(card.now.includes(cwd), '{path} 가 자식까지 갔다');
  assert.equal(existsSync(join(DROP, id + '.json')), false, 'drop 카드는 읽히면서 지워진다');
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

test('카드를 안 쓴 에이전트 — 래퍼가 합성한다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sp-worker-ws-'));
  const id = 'codex-test-nodrop';
  const code = await runWorker(
    { agent: 'codex', prompt: '한 줄로 답해라', cwd },
    { sessionId: id, profile: fake('process.exit(0)'), onTurnEnd: (h) => updateCard(h) }
  );
  assert.equal(code, 0);
  // 합성 카드가 없으면 status.md 도 Orca 코멘트도 그 턴을 통째로 놓친다 (헤드리스에는
  // 2순위인 "답변 본문 긁기" 가 없다).
  assert.equal(cardOf(id).now, 'codex 종료 (exit 0) · 커밋 0개');
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

// ---------- 겹친 래퍼 턴 거부 ----------
// 착륙은 헤드리스를 "가장 최근 래퍼 턴 하나"로 가르므로(land.test '턴 상태 — 헤드리스는 가장 최근 래퍼 턴이
// 판정이다'), 한 워크트리에 래퍼 턴을 겹쳐 띄우면 짧은 쪽이 끝나는 순간 본 턴이 "끝남"으로 읽힌다.
// 2026-09-02 slice7 에서 실제로 겹쳤고 트리가 더러워 안 지워졌을 뿐이다.
test('openWrapperTurn — 같은 워크트리의 안 끝난 래퍼 턴만 잡는다', () => {
  const now = 1_000_000_000;
  const W = 'C:/w/slice7';
  const open = { agent: 'codex', worktree: W, turnStartedAt: now - 60000, turnEndedAt: null };
  assert.equal(openWrapperTurn(W, { a: open }, now), 'a');
  // 끝난 턴은 안 잡는다 — 슬라이스 턴이 끝난 뒤의 충돌 해소 턴(착륙이 띄운다)이 이 길로 뜬다
  assert.equal(openWrapperTurn(W, { a: { ...open, turnEndedAt: now - 1000 } }, now), null);
  // 묵은 열린 턴(죽은 래퍼)은 무시 — 착륙의 TURN_STALE_MS 와 같은 잣대. 안 그러면 손 실행이 영영 막힌다
  assert.equal(openWrapperTurn(W, { a: { ...open, turnStartedAt: now - 3600001 } }, now), null);
  assert.equal(openWrapperTurn(W, { a: { ...open, turnStartedAt: now - 3599999 } }, now), 'a');
  // TUI 창과 옆 워크스페이스는 안 센다. 경로 비교는 구분자·대소문자를 접는다
  assert.equal(openWrapperTurn(W, { a: { ...open, agent: 'claude' } }, now), null);
  assert.equal(openWrapperTurn(W, { a: { ...open, agent: undefined } }, now), null);
  assert.equal(openWrapperTurn(W, { a: { ...open, worktree: 'C:/w/slice8' } }, now), null);
  assert.equal(openWrapperTurn('c:\\w\\slice7\\', { a: open }, now), 'a');
});

test('겹친 래퍼 턴 — 래퍼가 띄우지 않고 exit 75, --force 면 띄운다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sp-worker-ws-'));
  const marker = join(cwd, 'spawned');
  const js = "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'1');process.exit(0)";
  const sessions = () => ({ busy: { agent: 'codex', worktree: cwd, turnStartedAt: Date.now() - 5000, turnEndedAt: null } });
  const code = await runWorker({ agent: 'codex', prompt: '한 줄', cwd }, { sessionId: 'codex-test-busy', profile: fake(js), sessions });
  assert.equal(code, EXIT_BUSY);
  assert.equal(existsSync(marker), false, '자식을 띄우지 않는다');
  assert.equal(sessionOf('codex-test-busy'), undefined, '세션 기록도 안 만든다 — 만들면 그게 또 하나의 열린 래퍼 턴이다');
  const forced = await runWorker({ agent: 'codex', prompt: '한 줄', cwd, force: true }, { sessionId: 'codex-test-forced', profile: fake(js), sessions });
  assert.equal(forced, 0);
  assert.equal(existsSync(marker), true);
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

// ---------- 세션 기록을 못 남기면 안 띄운다 ----------
// 기록 없이 자식이 뜨면 셋이 어긋난다: 착륙이 옛 기록/기록 없음으로 판정하고, 자식이 낸 커밋이
// env 로 세션을 못 찾아 "세션 밖 커밋"으로 떨어지며, 턴 경계가 없어 회차가 창을 유휴로 읽는다.
// (2026-09-02 codex 실측에서 기본·xhigh 가 공통으로 찾은 구멍)
test('ensureSession init — agent 표시가 첫 저장부터 기록에 있다 (락 쓰기 한 번)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sp-worker-ws-'));
  const id = 'codex-test-init';
  const e = ensureSession(id, cwd, '지시', { claimRepo: false, init: (x) => (x.agent = 'codex') });
  assert.equal(e.agent, 'codex');
  // 디스크에도 그 한 번의 쓰기로 들어가 있다 — 두 번으로 나누면 둘째가 실패한 순간
  // agent 없는 기록이 남고 착륙이 그 워크스페이스를 TUI 로 읽는다
  assert.equal(sessionOf(id).agent, 'codex');
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

test('락을 못 잡으면 자식을 안 띄우고 EXIT_NOSESSION', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sp-worker-ws-'));
  const marker = join(cwd, 'spawned');
  const js = "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'1');process.exit(0)";
  const id = 'codex-test-nolock';
  // 남이 쥔 락을 흉내낸다. 방금 만든 디렉터리라 LOCK_STALE_MS(10초) 안이고, 래퍼는
  // LOCK_WAIT_MS(3초)를 기다린 뒤 물러난다 — 진짜 경합과 같은 길이다.
  const lock = join(DIR, 'state.lock');
  mkdirSync(lock, { recursive: true });
  try {
    const code = await runWorker({ agent: 'codex', prompt: '한 줄', cwd }, { sessionId: id, profile: fake(js) });
    assert.equal(code, EXIT_NOSESSION);
    assert.notEqual(code, 0);
    assert.notEqual(code, EXIT_BUSY, '겹침 거부와 다른 값이어야 사람이 원인을 가른다');
    assert.equal(existsSync(marker), false, '자식을 띄우지 않는다');
    assert.equal(sessionOf(id), undefined, '기록도 안 남는다 — 반쯤 남은 기록이 더 나쁘다');
  } finally {
    rmSync(lock, { recursive: true, force: true, maxRetries: 3 });
  }
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

// ---------- 턴 끝의 한도·종료 코드 ----------
// 착륙이 "그냥 죽었다" 와 "한도에 막혀 죽었다" 를 가르는 재료다. 지금까지는 로그와 합성 카드에만
// 있어서 기계가 읽을 것이 없었다 (슬라이스 11).
// 이 파일은 홈을 임시 폴더로 갈아끼웠으므로 codex rollout 도 그 밑에서 찾는다 — 주입 없이
// **진짜 경로로** 읽히는지까지 본다(주입만 하면 `limitOf` 를 아예 안 부르는 실수가 안 잡힌다).
function fakeRollout({ at = Date.now() - 60000, primary = 100, secondary = 13, resets = Date.now() + 3600000 } = {}) {
  const day = join(HOME, '.codex', 'sessions', '2026', '09', '03');
  mkdirSync(day, { recursive: true });
  const f = join(day, 'rollout-' + at + '-x.jsonl');
  writeFileSync(
    f,
    [
      JSON.stringify({ timestamp: new Date(at - 1000).toISOString(), type: 'session_meta', payload: { cwd: 'C:/w/slice12' } }),
      JSON.stringify({
        timestamp: new Date(at).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: primary, window_minutes: 300, resets_at: resets / 1000 },
            secondary: { used_percent: secondary, window_minutes: 10080, resets_at: (Date.now() + 5e8) / 1000 },
            rate_limit_reached_type: null,
          },
        },
      }),
    ].join('\n') + '\n'
  );
  return f;
}

test('턴 끝에 exitCode 와 그때의 한도가 세션 기록에 남는다 (rollout 을 실제로 읽는다)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sp-worker-ws-'));
  const id = 'codex-test-limit';
  const rollout = fakeRollout({ primary: 100 });
  const code = await runWorker({ agent: 'codex', prompt: '한 줄', cwd }, { sessionId: id, profile: fake('process.exit(7)') });
  assert.equal(code, 7);
  const s = sessionOf(id);
  assert.equal(s.exitCode, 7, '"그냥 죽었다" 와 "한도에 막혀 죽었다" 를 가르는 첫 재료');
  assert.equal(s.limit.pct5h, 100);
  assert.equal(s.limit.pct7d, 13);
  assert.equal(s.limit.reached, true);
  assert.equal(s.limit.agent, 'codex', '그 에이전트의 한도를 읽는다');
  rmSync(rollout, { force: true });
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

test('한도를 모르면 null 이 남는다 — 모른다는 이유로 막지 않는다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sp-worker-ws-'));
  const id = 'codex-test-limit-null';
  await runWorker({ agent: 'codex', prompt: '한 줄', cwd }, { sessionId: id, profile: fake('process.exit(0)'), limitOf: () => null });
  const s = sessionOf(id);
  assert.equal(s.exitCode, 0);
  assert.equal(s.limit, null);
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

test('띄울 것이 없으면 시작도 안 한다', async () => {
  await assert.rejects(
    () => runWorker({ agent: 'codex' }, { profile: fake('process.exit(0)') }),
    /--slice <번호> 나 --prompt <문장>/
  );
});
