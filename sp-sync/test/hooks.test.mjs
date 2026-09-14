// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cardUnder, linkedWorktreeCopy, writeAgentsMd, agentsMdState, orphanDrops, writeDrop } from '../sp-sync.mjs';
import { workspaceStatusFor, boardCheckpoint, worktreeModelFor, writeSettings, sessionIdFromEnv, tagHookInput, agentSessionKey, dropId, writeCodexHooks, codexHooksState, renderCodexHooks, insideOrca, ensureCodexWritableRoot } from '../lib/hooks.mjs';
import { config } from '../lib/common.mjs';

// 실제 값은 Windows 절대경로(역슬래시)다. String.raw 로 그대로 쓴다.
const WS = String.raw`C:\Users\me\orca\workspaces\Proj\slice1`;

// ---------- cardUnder ----------
// status.md(collectCards)와 착륙 판정(cardForWorkspace)이 이 하나를 같이 쓴다.
test('cardUnder — 그 워크트리에서 난 카드', () => {
  const under = cardUnder(WS);
  assert.equal(under({ cwd: WS }), true);
  // 하위 폴더에서 돌린 세션도 그 워크스페이스 것이다. 예전에는 착륙만 이걸 못 봐서,
  // 하위 폴더 창이 적은 `대기` 를 못 읽고 답을 기다리는 워커를 착륙시킬 수 있었다.
  assert.equal(under({ cwd: WS + String.raw`\sp-sync` }), true);
  // 구분자·끝 슬래시·대소문자는 normPath 가 편다.
  assert.equal(under({ cwd: 'c:/users/me/orca/workspaces/proj/slice1/' }), true);
});

test('cardUnder — 이름이 겹치는 이웃 워크트리는 남이다', () => {
  const under = cardUnder(WS);
  // slice1 로 slice10 을 잡으면 안 된다 — 경계에 `/` 를 요구하는 이유다.
  assert.equal(under({ cwd: WS + '0' }), false);
  assert.equal(under({ cwd: String.raw`C:\Users\me\orca\workspaces\Proj\slice2` }), false);
  assert.equal(under({ cwd: String.raw`C:\Users\me\orca\projects\Proj` }), false);
});

// ---------- linkedWorktreeCopy ----------
const MAIN = 'C:/Users/me/orca/projects/Proj';
const DIRS = [MAIN, 'C:/Users/me/orca/workspaces/Proj/slice1', 'C:/Users/me/orca/workspaces/Proj/slice2'];

test('linkedWorktreeCopy — 워크스페이스 사본으로 돌리면 그 워크트리를 돌려준다', () => {
  // 이 사본이 훅을 깔면 저장소 전체의 훅이 그 워크스페이스 경로를 가리키게 되고,
  // 착륙이 폴더를 지우는 순간 다 죽는다. sweepWorktrees 는 이걸 보고 물러난다.
  assert.equal(
    linkedWorktreeCopy(DIRS, MAIN, 'C:/Users/me/orca/workspaces/Proj/slice1/sp-sync/sp-sync.mjs'),
    'C:/Users/me/orca/workspaces/Proj/slice1'
  );
});

test('linkedWorktreeCopy — 본체 사본과 남의 저장소는 안 걸린다', () => {
  // 본체에서 도는 정상 경로
  assert.equal(linkedWorktreeCopy(DIRS, MAIN, MAIN + '/sp-sync/sp-sync.mjs'), null);
  // 다른 프로젝트에 설치하는 경우 — SELF 는 그 저장소의 워크트리 어디에도 없다
  const other = 'C:/Users/me/orca/projects/Other';
  assert.equal(linkedWorktreeCopy([other], other, MAIN + '/sp-sync/sp-sync.mjs'), null);
  // 이름만 겹치는 이웃 폴더
  assert.equal(linkedWorktreeCopy(DIRS, MAIN, 'C:/Users/me/orca/workspaces/Proj/slice10/sp-sync/sp-sync.mjs'), null);
});

// ---------- writeAgentsMd ----------
// 헤드리스 에이전트(codex·antigravity)는 CLAUDE.md 가 아니라 AGENTS.md 를 읽는다.
// 규칙을 두 벌 관리하지 않으려고 CLAUDE.md 두 층을 이어 붙여 만든다.
const gitCmd = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

/** 가짜 홈: `~/orca/CLAUDE.md` 와 `~/orca/workspaces/Proj/slice1/CLAUDE.md`. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'spsync-agents-'));
  const ws = join(home, 'orca', 'workspaces', 'Proj', 'slice1');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(home, 'orca', 'CLAUDE.md'), '# Orca 공통 규칙\n\npush 는 스크립트가 한다.\n', 'utf8');
  writeFileSync(join(ws, 'CLAUDE.md'), '# Proj\n\n구조는 이렇다.\n', 'utf8');
  return { home, ws };
}

test('writeAgentsMd — CLAUDE.md 두 층을 순서대로 이어 붙인다', () => {
  const { home, ws } = fakeHome();
  try {
    const f = writeAgentsMd(ws, home);
    assert.equal(f, join(ws, 'AGENTS.md'));
    const text = readFileSync(f, 'utf8');
    // 머리 한 줄 → ~/orca/CLAUDE.md → 그 워크트리의 CLAUDE.md
    assert.match(text.split('\n')[0], /CLAUDE\.md 에서 생성/);
    const orcaAt = text.indexOf('# Orca 공통 규칙');
    const projAt = text.indexOf('# Proj');
    assert.ok(orcaAt > 0 && projAt > orcaAt, '상위 규칙이 프로젝트 규칙보다 앞이어야 한다: ' + text);
    // 치환 없이 그대로 들어간다
    assert.ok(text.includes('push 는 스크립트가 한다.'));
    assert.ok(text.includes('구조는 이렇다.'));

    // ~/orca 밖이면 프로젝트 층만 들어간다 — 상위 규칙이 그 저장소 것이 아니다.
    const out = mkdtempSync(join(tmpdir(), 'spsync-agents-out-'));
    writeFileSync(join(out, 'CLAUDE.md'), '# 남의 저장소\n', 'utf8');
    const g = writeAgentsMd(out, home);
    const outText = readFileSync(g, 'utf8');
    assert.ok(outText.includes('# 남의 저장소'));
    assert.ok(!outText.includes('# Orca 공통 규칙'));
    rmSync(out, { recursive: true, force: true });

    // CLAUDE.md 가 한 층도 없으면 만들지 않는다 — 머리 한 줄만 든 파일은 '규칙 없음'으로 읽힌다.
    const bare = mkdtempSync(join(tmpdir(), 'spsync-agents-bare-'));
    assert.equal(writeAgentsMd(bare, home), null);
    assert.equal(existsSync(join(bare, 'AGENTS.md')), false);
    rmSync(bare, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeAgentsMd — 사람이 쓴 파일은 손대지 않는다', () => {
  const { home, ws } = fakeHome();
  try {
    // 머리 표시가 없으면 우리 것이 아니다. 저장소가 추적하든 말든 덮으면 안 된다.
    writeFileSync(join(ws, 'AGENTS.md'), '사람이 쓴 규칙\n', 'utf8');
    assert.equal(agentsMdState(ws, home).kind, 'user');
    assert.equal(writeAgentsMd(ws, home), null);
    assert.equal(readFileSync(join(ws, 'AGENTS.md'), 'utf8'), '사람이 쓴 규칙\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// 이 슬라이스(40)가 고친 것: 예전에는 "있으면 손대지 않는다" 라 규칙을 고쳐도 워커는 몇 주 전
// 사본을 읽었다(2026-09-08 여섯 프로젝트 전부 9월 2~3일 생성본).
test('writeAgentsMd — 원본이 바뀌면 갱신하고, 같으면 파일을 안 건드린다', () => {
  const { home, ws } = fakeHome();
  const file = join(ws, 'AGENTS.md');
  try {
    assert.equal(agentsMdState(ws, home).kind, 'missing');
    assert.ok(writeAgentsMd(ws, home));
    const st1 = agentsMdState(ws, home);
    assert.equal(st1.kind, 'current');
    // 머리 한 줄에 원본 해시가 실린다
    assert.match(readFileSync(file, 'utf8').split('\n')[0], new RegExp('src:' + st1.hash + ' '));

    // 같은 해시 → 안 쓴다 (mtime 그대로). 매 턴 도는 sweepWorktrees 가 부르는 자리다.
    const before = statSync(file).mtimeMs;
    assert.equal(writeAgentsMd(ws, home), null);
    assert.equal(statSync(file).mtimeMs, before);

    // 원본 한 층이 바뀌면 stale → 다시 쓰고 새 내용이 들어간다
    writeFileSync(join(home, 'orca', 'CLAUDE.md'), '# Orca 공통 규칙\n\n규칙이 바뀌었다.\n', 'utf8');
    const st2 = agentsMdState(ws, home);
    assert.equal(st2.kind, 'stale');
    assert.notEqual(st2.hash, st1.hash);
    assert.ok(writeAgentsMd(ws, home));
    assert.ok(readFileSync(file, 'utf8').includes('규칙이 바뀌었다.'));
    assert.equal(agentsMdState(ws, home).kind, 'current');

    // `src:` 없는 옛 생성본도 갱신 대상이다 — 그게 이 슬라이스 전의 상태다.
    writeFileSync(file, '<!-- sp-sync 가 CLAUDE.md 에서 생성했다 — 고칠 것은 CLAUDE.md 다. -->\n\n옛 사본\n', 'utf8');
    assert.equal(agentsMdState(ws, home).kind, 'stale');
    assert.ok(writeAgentsMd(ws, home));
    assert.ok(!readFileSync(file, 'utf8').includes('옛 사본'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- drop 카드 세션 id ----------
// `undefined.json` 은 아무 세션에도 안 붙고, 다음 세션이 같은 이름을 쓰면 남의 카드를 읽는다.
test('writeDrop — 세션 id 가 없으면 던진다', () => {
  for (const bad of [undefined, null, '', '  ', 'undefined', 'null'])
    assert.throws(() => writeDrop(bad, { now: '뭔가' }), /CLAUDE_CODE_SESSION_ID/, '막아야 한다: ' + JSON.stringify(bad));
  // 고아 목록은 읽기 전용이라 아무 때나 불러도 안전하다(폴더가 없으면 빈 배열).
  assert.ok(Array.isArray(orphanDrops()));
  assert.ok(orphanDrops().every((f) => /(undefined|null)\.json$/i.test(f)));
});

// ---------- 세션 계약 (슬라이스 45) — 세션 종류 × id 출처 ----------
// 직접 Claude 는 CLAUDE_CODE_SESSION_ID 그대로, 직접 Codex 는 `codex-<id>` 접두어. 래퍼(`worker`)는
// CLAUDE_CODE_SESSION_ID 에 제 id 를 넣으므로 첫 줄로 잡힌다 — Codex 변수가 같이 있어도 래퍼가 이긴다.
test('sessionIdFromEnv — CLAUDE_CODE_SESSION_ID 가 먼저, 다음이 codex 접두어', () => {
  assert.deepEqual(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: 'abc-1' }), { id: 'abc-1', agent: null, source: 'CLAUDE_CODE_SESSION_ID' });
  assert.deepEqual(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: 'codex-20260909-x1', CODEX_THREAD_ID: 't-9' }), {
    id: 'codex-20260909-x1',
    agent: null,
    source: 'CLAUDE_CODE_SESSION_ID',
  });
  assert.deepEqual(sessionIdFromEnv({ CODEX_THREAD_ID: 't-9' }), { id: 'codex-t-9', agent: 'codex', source: 'CODEX_THREAD_ID' });
  assert.deepEqual(sessionIdFromEnv({ CODEX_SESSION_ID: 's-3' }), { id: 'codex-s-3', agent: 'codex', source: 'CODEX_SESSION_ID' });
  assert.deepEqual(sessionIdFromEnv({ CODEX_THREAD_ID: 't-9', CODEX_SESSION_ID: 's-3' }).source, 'CODEX_THREAD_ID');
  // 셸이 빈 변수를 'undefined' 글자로 넘기는 경우도 없는 것으로 본다 (dropId 와 같은 잣대)
  assert.equal(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: 'undefined', CODEX_THREAD_ID: '' }), null);
  assert.equal(sessionIdFromEnv({}), null);
  // 접두어 키는 파일 이름으로 그대로 쓸 수 있어야 한다
  assert.equal(agentSessionKey('codex', 'a/b'), 'codex-a/b');
  assert.equal(dropId(agentSessionKey('codex', 'a/b')), 'codex-a_b');
});

test('tagHookInput — --agent codex 면 stdin 의 session_id 에 접두어, 한 번만', () => {
  const d = tagHookInput({ session_id: 'u-1', cwd: 'x' }, ['node', 'sp', 'prompt', '--agent', 'codex']);
  assert.equal(d.session_id, 'codex-u-1');
  assert.equal(d._agent, 'codex');
  // 배경 워커가 같은 입력을 다시 받아도 두 번 안 붙는다
  assert.equal(tagHookInput(d, ['node', 'sp', 'prompt', '--agent', 'codex']).session_id, 'codex-u-1');
  // claude 또는 인자 없음 — 그대로
  assert.deepEqual(tagHookInput({ session_id: 'u-2' }, ['node', 'sp', 'prompt', '--agent', 'claude']), { session_id: 'u-2' });
  assert.deepEqual(tagHookInput({ session_id: 'u-2' }, ['node', 'sp', 'prompt']), { session_id: 'u-2' });
  // session_id 가 없으면 태그만 남는다 (Claude 쪽 훅과 같이 `prompt` 가 물러난다)
  assert.deepEqual(tagHookInput({}, ['node', 'sp', 'stop', '--agent', 'codex']), { _agent: 'codex' });
});

// `card` 명령 — 규칙 문서의 `node -e` 조각을 대신한다. 실제 `~/.sp-sync/drop/` 에 쓰므로 끝나면 지운다.
test('card — env 에서 세션 키를 골라 카드를 떨군다 (--json · stdin · 거부)', () => {
  const SELF = fileURLToPath(new URL('../sp-sync.mjs', import.meta.url));
  const drop = join(homedir(), '.sp-sync', 'drop');
  const env0 = { ...process.env };
  delete env0.CLAUDE_CODE_SESSION_ID;
  delete env0.CODEX_THREAD_ID;
  delete env0.CODEX_SESSION_ID;
  const run = (args, env, input) => execFileSync(process.execPath, [SELF, 'card', ...args], { env: { ...env0, ...env }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const id = 'sp-sync-test-' + process.pid;
  const files = [join(drop, id + '.json'), join(drop, 'codex-' + id + '.json')];
  try {
    run(['--json', JSON.stringify({ now: '한 것', wait: '', next: '다음' })], { CLAUDE_CODE_SESSION_ID: id });
    assert.deepEqual(JSON.parse(readFileSync(files[0], 'utf8')), { now: '한 것', wait: '', next: '다음' });
    // codex 세션 — 접두어 파일, stdin 으로
    const out = run([], { CODEX_THREAD_ID: id }, JSON.stringify({ now: '코덱스', task: 'T1' }));
    assert.match(out, /codex-sp-sync-test-\d+ \(codex, CODEX_THREAD_ID\)/);
    assert.deepEqual(JSON.parse(readFileSync(files[1], 'utf8')), { now: '코덱스', task: 'T1' });
    // 거부 — 세션 id 없음 / 모르는 필드 / now 비어 있음 / JSON 아님
    for (const [args, env, input, re] of [
      [['--json', '{"now":"x"}'], {}, undefined, /세션 id 를 환경에서 못 골랐다/],
      [['--json', '{"now":"x","foo":1}'], { CLAUDE_CODE_SESSION_ID: id }, undefined, /모르는 카드 필드: foo/],
      [['--json', '{"wait":"x"}'], { CLAUDE_CODE_SESSION_ID: id }, undefined, /now 는 빈 문자열일 수 없다/],
      [[], { CLAUDE_CODE_SESSION_ID: id }, 'not json', /카드 JSON 을 못 읽었다/],
    ])
      assert.throws(() => run(args, env, input), (e) => re.test(String(e.stderr)), '막아야 한다: ' + args.join(' ') + ' ' + JSON.stringify(input ?? null));
  } finally {
    for (const f of files) rmSync(f, { force: true });
  }
});

// ---------- 직접 Codex 세션의 훅 (슬라이스 45) ----------
// `~/.codex/hooks.json` 꼴: 이벤트마다 남의 항목이 있을 수 있다. 우리 것은 **끝에** 붙고, 다시 돌려도 하나뿐이어야 한다 —
// 중간에 끼우면 뒤 항목의 신뢰 키(경로:이벤트:매처번호:훅번호)가 어긋난다.
test('writeCodexHooks — 배열 끝에 한 번만, 다른 이벤트·남의 항목은 그대로, 정의가 바뀌면 옛 신뢰를 지운다', () => {
  const home = mkdtempSync(join(tmpdir(), 'sp-sync-codex-'));
  try {
    const other = (n) => ({ hooks: [{ type: 'command', command: 'powershell.exe -EncodedCommand OTHER' + n, timeout: 10 }] });
    const seed = { hooks: { PreToolUse: [other(1), { matcher: '*', ...other(2) }], SessionStart: [other(1)], UserPromptSubmit: [other(1)], Stop: [other(1)] } };
    writeFileSync(join(home, 'hooks.json'), JSON.stringify(seed));
    // 지웠다 다시 붙이는 꼴: 그 키(:1:0)로 낡은 신뢰 블록이 남아 있으면 처음 설치라도 지운다
    writeFileSync(join(home, 'config.toml'), "[hooks.state]\n[hooks.state.'" + join(home, 'hooks.json') + ":stop:1:0']\ntrusted_hash = \"sha256:old\"\n");
    const r = writeCodexHooks(home);
    assert.deepEqual(r, { file: join(home, 'hooks.json'), changed: ['UserPromptSubmit', 'Stop'] }, '처음 설치 = 그 자리의 정의가 새것');
    assert.ok(!readFileSync(join(home, 'config.toml'), 'utf8').includes(':stop:1:0'), '남아 있던 옛 신뢰 블록을 지웠다');
    const check = () => {
      const j = JSON.parse(readFileSync(r.file, 'utf8')).hooks;
      for (const [evt, sub] of [['UserPromptSubmit', 'prompt'], ['Stop', 'stop']]) {
        assert.equal(j[evt].length, 2, evt + ' 는 남의 것 하나 + 우리 하나');
        assert.deepEqual(j[evt][0], seed.hooks[evt][0], evt + ' 의 남의 항목은 그대로');
        const ours = j[evt][1].hooks[0];
        assert.equal(ours.type, 'command');
        // codex 는 Windows 에서 훅을 PowerShell 로 돌린다 — 따옴표로 시작하면 exit 1. & 가 앞에 있어야 한다
        assert.ok(ours.command.endsWith('sp-sync.mjs" ' + sub + ' --agent codex'), ours.command);
        assert.equal(ours.commandWindows, '& ' + ours.command);
        assert.ok(!ours.command.includes(String.fromCharCode(92)), '경로는 슬래시로: ' + ours.command);
      }
      assert.deepEqual(j.PreToolUse, seed.hooks.PreToolUse, '안 건드리는 이벤트');
      assert.deepEqual(j.SessionStart, seed.hooks.SessionStart);
    };
    check();
    assert.deepEqual(writeCodexHooks(home).changed, [], '다시 돌려도 같다 — 바뀐 정의 없음');
    check();
    // 상태: 설치됨·미신뢰 → config.toml 에 신뢰 블록이 생기면 신뢰됨. 키의 매처 번호는 우리 항목 자리(1).
    // codex 가 쓰는 블록에는 enabled 줄이 없을 수도 있다(실측) — trusted_hash 만 있으면 신뢰다.
    let st = codexHooksState(home);
    assert.deepEqual(st.events.map((e) => [e.event, e.installed, e.index, e.trusted]), [['UserPromptSubmit', true, 1, false], ['Stop', true, 1, false]]);
    assert.match(renderCodexHooks(st), /설치됨·미신뢰: UserPromptSubmit, Stop/);
    const key = (ev, i, enabled) => "[hooks.state.'" + join(home, 'hooks.json') + ':' + ev + ':' + i + ":0']\n" + (enabled === undefined ? '' : 'enabled = ' + enabled + '\n') + 'trusted_hash = "sha256:abc"\n\n';
    writeFileSync(join(home, 'config.toml'), 'model = "x"\n\n[hooks.state]\n' + key('user_prompt_submit', 1) + key('stop', 0, true) + '[projects."C:\\\\x"]\ntrust_level = "trusted"\n');
    st = codexHooksState(home);
    assert.deepEqual(st.events.map((e) => [e.event, e.trusted]), [['UserPromptSubmit', true], ['Stop', false]], 'stop 은 번호가 달라 미신뢰');
    assert.match(renderCodexHooks(st), /설치됨·미신뢰: Stop/);
    writeFileSync(join(home, 'config.toml'), '[hooks.state]\n' + key('user_prompt_submit', 1, true) + key('stop', 1, false));
    assert.deepEqual(codexHooksState(home).events.map((e) => e.trusted), [true, false], 'enabled = false 는 미신뢰');
    writeFileSync(join(home, 'config.toml'), '[hooks.state]\n' + key('user_prompt_submit', 1, true) + key('stop', 1, true) + '[tui]\ntheme = "x"\n');
    st = codexHooksState(home);
    assert.ok(st.events.every((e) => e.trusted));
    assert.match(renderCodexHooks(st), /^✓ codex 훅 설치됨·신뢰됨/);
    // 같은 자리에서 정의가 바뀌면(스크립트 경로 이동·명령 꼴 변경 — 옛 설치본이 남아 있는 꼴) 그 이벤트의 옛 신뢰
    // 블록만 지운다 — Orca 가 처음 한 번만 신뢰를 되돌려 쓰므로 낡은 해시가 남으면 탭마다 다시 묻는다(실측).
    // 자리가 바뀌는 경우(앞에 남의 항목이 끼어듦)는 키 자체가 새것이라 Orca 의 "처음" 경로를 타므로 여기 몫이 아니다.
    const j = JSON.parse(readFileSync(r.file, 'utf8'));
    j.hooks.Stop[1].hooks[0].timeout = 99; // 옛 정의라고 치자
    writeFileSync(r.file, JSON.stringify(j));
    assert.deepEqual(writeCodexHooks(home).changed, ['Stop']);
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.ok(toml.includes('user_prompt_submit:1:0'), '안 바뀐 이벤트의 신뢰는 남는다');
    assert.ok(!toml.includes(':stop:1:0'), '바뀐 이벤트의 옛 블록은 없다: ' + toml);
    assert.ok(toml.includes('[tui]\ntheme = "x"'), '다른 표는 그대로: ' + toml);
    assert.equal(JSON.parse(readFileSync(r.file, 'utf8')).hooks.Stop[1].hooks[0].timeout, 10, '정의는 현재 것으로 다시 썼다');
    assert.deepEqual(codexHooksState(home).events.map((e) => [e.index, e.trusted]), [[1, true], [1, false]]);
    // 파일이 아예 없으면 만든다 / 없음 보고
    const empty = join(home, 'fresh');
    assert.match(renderCodexHooks(codexHooksState(empty)), /^✗ codex 훅 없음/);
    writeCodexHooks(empty);
    assert.equal(JSON.parse(readFileSync(join(empty, 'hooks.json'), 'utf8')).hooks.Stop.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// card 가 ~/.sp-sync 에 쓰려면 codex 샌드박스가 그 폴더를 허용해야 한다(기본은 저장소 밖 EPERM, 실측).
test('ensureCodexWritableRoot — 표 없음/줄 없음/값 없음/있음 네 경우, 다른 내용은 그대로', () => {
  const home = mkdtempSync(join(tmpdir(), 'sp-sync-codex-wr-'));
  const dir = 'C:\\Users\\me\\.sp-sync';
  try {
    const t = join(home, 'config.toml');
    assert.equal(ensureCodexWritableRoot(home, dir), 'added', '파일도 없음');
    assert.match(readFileSync(t, 'utf8'), /\[sandbox_workspace_write\]\nwritable_roots = \["C:\/Users\/me\/.sp-sync"\]/);
    assert.equal(ensureCodexWritableRoot(home, dir), 'present');
    writeFileSync(t, 'model = "x"\n\n[sandbox_workspace_write]\nnetwork_access = true\n\n[tui]\ntheme = "y"\n');
    assert.equal(ensureCodexWritableRoot(home, dir), 'appended', '표는 있고 줄이 없음');
    let toml = readFileSync(t, 'utf8');
    assert.match(toml, /\[sandbox_workspace_write\]\nwritable_roots = \["C:\/Users\/me\/.sp-sync"\]\nnetwork_access = true\n\n\[tui\]\ntheme = "y"\n$/, toml);
    assert.equal(ensureCodexWritableRoot(home, dir), 'present');
    writeFileSync(t, '[sandbox_workspace_write]\nwritable_roots = ["D:/other"]\n[tui]\n');
    assert.equal(ensureCodexWritableRoot(home, dir), 'inserted', '줄은 있고 값이 없음');
    toml = readFileSync(t, 'utf8');
    assert.match(toml, /writable_roots = \["D:\/other", "C:\/Users\/me\/.sp-sync"\]\n\[tui\]/, toml);
    assert.equal(ensureCodexWritableRoot(home, dir), 'present');
    // 이미 백슬래시 꼴(리터럴 문자열)로 들어 있어도 같은 폴더로 본다
    writeFileSync(t, "[sandbox_workspace_write]\nwritable_roots = ['C:\\Users\\me\\.sp-sync']\n");
    assert.equal(ensureCodexWritableRoot(home, dir), 'present');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('insideOrca — projects/workspaces 밑만, 형제·상위는 아니다', () => {
  const home = 'C:/Users/me';
  assert.ok(insideOrca('C:/Users/me/orca/projects/Proj', home));
  assert.ok(insideOrca('C:\\Users\\me\\orca\\workspaces\\Proj\\slice3\\sub', home));
  assert.ok(!insideOrca('C:/Users/me/orca', home));
  assert.ok(!insideOrca('C:/Users/me/orca/projectsX/a', home));
  assert.ok(!insideOrca('C:/Users/me/dev/a', home));
  assert.ok(!insideOrca('', home));
});

test('writeAgentsMd — 링크된 워크트리에서도 트리를 안 더럽힌다', () => {
  // 착륙 판정이 '트리 깨끗'을 보므로, exclude 가 안 먹히면 파견된 워크스페이스가 전부 막힌다.
  // **파견이 만드는 것은 링크된 워크트리다.** 거기서 `--git-dir` 은 `.git/worktrees/<이름>` 을
  // 주는데 git 은 `info/exclude` 를 공용 폴더에서만 읽는다 — 옛 코드가 정확히 그 함정에 빠졌다
  // (2026-09-02 실측). 그래서 본체가 아니라 워크트리에서 재는 것이 이 테스트의 핵심이다.
  const { home } = fakeHome();
  const main = join(home, 'orca', 'projects', 'Proj');
  const linked = join(home, 'orca', 'workspaces', 'Proj', 'slice9');
  try {
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, 'CLAUDE.md'), '# Proj\n', 'utf8');
    gitCmd(['init', '--initial-branch=master'], main);
    gitCmd(['config', 'user.email', 't@t'], main);
    gitCmd(['config', 'user.name', 't'], main);
    gitCmd(['add', 'CLAUDE.md'], main);
    gitCmd(['commit', '-m', 'init'], main);
    gitCmd(['worktree', 'add', '-b', 'slice9', linked], main);

    assert.ok(writeAgentsMd(linked, home), '워크트리에 AGENTS.md 를 써야 한다');
    assert.equal(gitCmd(['status', '--porcelain'], linked).trim(), '', 'AGENTS.md 를 만들어도 워크트리는 깨끗해야 한다');
    // 공용 폴더 — git 이 실제로 읽는 자리다
    const ex = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(ex.split('\n').some((l) => l.trim() === 'AGENTS.md'), 'exclude 에 AGENTS.md: ' + ex);
    // 본체에서 만들어도 마찬가지고, 같은 줄을 두 번 넣지 않는다
    assert.ok(writeAgentsMd(main, home));
    assert.equal(gitCmd(['status', '--porcelain'], main).trim(), '');
    const ex2 = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(ex2.split('\n').filter((l) => l.trim() === 'AGENTS.md').length, 1);
  } finally {
    try {
      gitCmd(['worktree', 'remove', '--force', linked], main);
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});


// ---------- 워크스페이스 카드 상태 (6단계 슬라이스 25) ----------
// Orca 보드 카드의 상태를 파견(`in-progress`)과 Stop 훅(`in-review`)이 칠한다. 판정 함수는
// 파견·착륙과 같은 것 하나다 (`sliceNumberOf`·`parsePlanSlices`·`sliceInPlan`, common.mjs).

const PLAN_OPEN = ['## 6단계', '', '- [ ] **7. 일곱**', '- [ ] **8. 여덟**', ''].join('\n');
const PLAN_DONE = ['## 6단계', '', '- [x] **7. 일곱**', '- [ ] **8. 여덟**', ''].join('\n');
// 자기 절의 마지막을 체크하면 현재 단계가 다음 절로 넘어간다 — 그래도 찾아야 한다 (`sliceInPlan`)
const PLAN_ROLLED = ['## 6단계', '', '- [x] **7. 일곱**', '', '## 7단계', '', '- [ ] **9. 아홉**', ''].join('\n');

const statusDir = (name, plan) => {
  const parent = mkdtempSync(join(tmpdir(), 'sp-status-'));
  const d = join(parent, name);
  mkdirSync(d, { recursive: true });
  if (plan != null) writeFileSync(join(d, 'PLAN.md'), plan, 'utf8');
  return d;
};
const dropDir = (d) => rmSync(join(d, '..'), { recursive: true, force: true });

test('workspaceStatusFor — 미체크 슬라이스는 in-progress, 체크되면 in-review', () => {
  const open = statusDir('slice7', PLAN_OPEN);
  const done = statusDir('slice7', PLAN_DONE);
  const rolled = statusDir('slice7', PLAN_ROLLED);
  try {
    assert.equal(workspaceStatusFor(open), 'in-progress');
    assert.equal(workspaceStatusFor(done), 'in-review');
    assert.equal(workspaceStatusFor(rolled), 'in-review');
  } finally {
    for (const d of [open, done, rolled]) dropDir(d);
  }
});

test('workspaceStatusFor — 파견 워크스페이스가 아니면 null 이라 카드를 안 건드린다', () => {
  // 본체(기본 브랜치)와 손으로 판 이름. `sliceN` 이 아니면 어느 슬라이스인지 알 길이 없다.
  const main = statusDir('SP-sync', PLAN_OPEN);
  const stray = statusDir('review-fix', PLAN_OPEN);
  // PLAN.md 가 없으면 "아직 안 끝났다" — 없는 체크를 끝난 것으로 읽으면 안 된다
  const noplan = statusDir('slice7', null);
  try {
    assert.equal(workspaceStatusFor(main), null);
    assert.equal(workspaceStatusFor(stray), null);
    assert.equal(workspaceStatusFor(noplan), 'in-progress');
  } finally {
    for (const d of [main, stray, noplan]) dropDir(d);
  }
});

// ---------- 워크트리 설정의 모델 (6단계 슬라이스 26) ----------
// 파견이 `worktree create --agent claude --prompt` 로 바뀌어 `--model` 을 실을 명령줄이 없다. 그래서
// `install` 이 `sliceN` 워크트리의 `.claude/settings.local.json` 에 그 슬라이스의 모델을 박는다
// (`notes/2026-09-04-worktree-create-agent-실측.md` — settings 의 `model` 키가 배너에 그대로 뜨는 것을 실측).

const PLAN_HARD = ['## 6단계', '', '- [ ] **7. 일곱** [어려움]', '- [ ] **8. 여덟** [병렬 가능]', ''].join('\n');
const MODELS = { fleetModel: 'opus[1m]', fleetHardModel: 'fable' };

test('worktreeModelFor — [어려움] 은 최상위, 나머지는 표준, 파견 워크스페이스가 아니면 null', () => {
  const hard = statusDir('slice7', PLAN_HARD);
  const plain = statusDir('slice8', PLAN_HARD);
  const main = statusDir('SP-sync', PLAN_HARD);
  const unknown = statusDir('slice9', PLAN_HARD); // 계획에 없는 번호
  const noplan = statusDir('slice7', null);
  try {
    assert.equal(worktreeModelFor(hard, MODELS), 'fable');
    assert.equal(worktreeModelFor(plain, MODELS), 'opus[1m]');
    assert.equal(worktreeModelFor(main, MODELS), null);
    assert.equal(worktreeModelFor(unknown, MODELS), null);
    assert.equal(worktreeModelFor(noplan, MODELS), null);
    // 빈 설정이면 null — `--model undefined` 같은 값을 파일에 박지 않는다
    assert.equal(worktreeModelFor(hard, { fleetModel: 'opus' }), null);
  } finally {
    for (const d of [hard, plain, main, unknown, noplan]) dropDir(d);
  }
});

test('writeSettings — sliceN 워크트리에는 model 을 박고, 아니면 있던 model 을 손대지 않는다', () => {
  const hard = statusDir('slice7', PLAN_HARD);
  const main = statusDir('SP-sync', PLAN_HARD);
  try {
    // 실제 config() 를 읽는다 — 그 값이 곧 install 이 박을 값이다
    const cfg = config();
    writeSettings(hard);
    const h = JSON.parse(readFileSync(join(hard, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(h.model, cfg.fleetHardModel);
    assert.ok(h.hooks.Stop.length); // 훅은 그대로
    // 사용자가 둔 model 이 있는 본체는 그대로
    mkdirSync(join(main, '.claude'), { recursive: true });
    writeFileSync(join(main, '.claude', 'settings.local.json'), JSON.stringify({ model: 'haiku' }), 'utf8');
    writeSettings(main);
    const m = JSON.parse(readFileSync(join(main, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(m.model, 'haiku');
    // 다시 써도 같은 값 — 설정이 바뀌면 그때 바뀐다
    writeSettings(hard);
    assert.equal(JSON.parse(readFileSync(join(hard, '.claude', 'settings.local.json'), 'utf8')).model, cfg.fleetHardModel);
  } finally {
    for (const d of [hard, main]) dropDir(d);
  }
});

test('boardCheckpoint — 상태가 바뀐 턴만 매듭이고, 같은 값 연속이면 두 번째는 안 보낸다', () => {
  const card = { now: '작업 중', wait: '' };
  const sess = { commits: [], boardPushedCommits: 0, boardPushedWait: '', boardPushedStatus: '' };
  // 첫 턴 — 아직 아무것도 안 보냈으니 in-progress 가 매듭이다
  const first = boardCheckpoint(card, sess, 'in-progress');
  assert.equal(first.statusChanged, true);
  assert.equal(first.checkpoint, true);
  // 둘째 턴 — 같은 값. 커밋도 대기도 그대로면 orca.exe 를 띄울 이유가 없다
  const second = boardCheckpoint(card, { ...sess, boardPushedStatus: 'in-progress' }, 'in-progress');
  assert.equal(second.statusChanged, false);
  assert.equal(second.checkpoint, false);
  // 슬라이스를 체크한 턴 — in-review 로 바뀌었으니 다시 매듭
  const checked = boardCheckpoint(card, { ...sess, boardPushedStatus: 'in-progress' }, 'in-review');
  assert.equal(checked.statusChanged, true);
  assert.equal(checked.checkpoint, true);
  // 본체 세션(status null)에서는 상태가 매듭을 만들지 않는다 — 커밋·대기만 본다
  assert.equal(boardCheckpoint(card, sess, null).checkpoint, false);
  assert.equal(boardCheckpoint(card, { ...sess, commits: ['a'] }, null).checkpoint, true);
});
