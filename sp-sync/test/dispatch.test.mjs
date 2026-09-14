// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchPlan, sliceCommandFor, renderDispatch, workerCommand, strayBlock, closeExtraTabs, turnStateFor } from '../sp-sync.mjs';
// 슬라이스 4(헤드리스 파견) — 진입점은 손대지 않았다. 새 헬퍼는 모듈에서 바로 가져온다.
import { dispatchOne, headlessOf, dispatchCommand } from '../lib/fleet.mjs';
// 진입점은 이번 슬라이스에서 손대지 않는다(2 와 병렬) — 새 헬퍼는 모듈에서 바로 가져온다.
// 프로필은 `config()` 가 아니라 **기본값**을 본다 — 사용자 config.json 이 codex 를 손보면
// 테스트가 그 값에 흔들린다.
import { agentArgv, agentProfile, agentTable, DEFAULT_CONFIG, parsePlanSlices } from '../lib/common.mjs';

const s = (number, tags = [], extra = {}) => ({ number, title: 't' + number, tags, decision: null, done: false, workspace: null, ...extra });
const ws = (name, slice, terminals = ['t-' + name]) => ({ name, path: 'C:/w/' + name, branch: 'u/' + name, slice, lastActivityAt: null, terminals });
const plan = (slices, workspaces = [], max = 3) => dispatchPlan({ slices, workspaces, max });
const byNo = (p) => Object.fromEntries(p.map((x) => [x.slice.number, x]));

test('아무것도 안 돌면 첫 미체크 하나가 뜬다 — 태그가 없어도', () => {
  const p = plan([s(1), s(2)]);
  assert.equal(p[0].eligible, true);
  assert.equal(p[0].reason, '활성 워크스페이스 0개');
  // 태그 없는 것이 떴으면 그 회차는 그것만 — 측정 슬라이스가 흐려지면 안 된다
  assert.equal(p[1].eligible, false);
  assert.match(p[1].reason, /1번이 혼자 돌아야 함/);
});

test('[병렬 가능] 은 여럿이 같이 뜬다', () => {
  const p = plan([s(1, ['parallel']), s(2, ['parallel']), s(3, ['parallel'])]);
  assert.deepEqual(p.map((x) => x.eligible), [true, true, true]);
});

test('동시 상한을 넘지 않는다 — 이미 떠 있는 것도 센다', () => {
  const p = plan([s(1, ['parallel']), s(2, ['parallel']), s(3, ['parallel'])], [ws('slice9', 9)], 2);
  assert.deepEqual(p.map((x) => x.eligible), [true, false, false]);
  assert.match(p[1].reason, /동시 상한 2개/);
});

test('[결정 필요] 는 건너뛰고 보고하되 뒤를 막지 않는다', () => {
  const p = byNo(plan([s(1, ['decision'], { decision: 'push 승인' }), s(2, ['parallel'])]));
  assert.equal(p[1].eligible, false);
  assert.match(p[1].reason, /결정 필요: push 승인/);
  assert.equal(p[2].eligible, true); // 그 앞에서 멈추지 않는다
});

test('이미 그 번호로 워크스페이스가 떠 있으면 건너뛴다', () => {
  const running = ws('slice1', 1);
  const p = byNo(plan([s(1, ['parallel'], { workspace: running }), s(2, ['parallel'])], [running]));
  assert.equal(p[1].eligible, false);
  assert.match(p[1].reason, /이미 돌고 있음 \(slice1\)/);
  assert.equal(p[2].eligible, true);
});

test('태그 없는 슬라이스가 이미 돌고 있으면 이번 회차는 아무것도 안 띄운다', () => {
  // 측정 슬라이스(태그 없음)가 도는 중에 [병렬 가능] 이 옆에 붙으면 측정이 흐려진다
  const running = ws('slice1', 1);
  const p = byNo(plan([s(1, [], { workspace: running }), s(2, ['parallel'])], [running]));
  assert.equal(p[2].eligible, false);
  assert.match(p[2].reason, /1번이 혼자 돌아야 함 \(병렬 태그 없음\)/);
});

test('[어려움] 도 병렬 태그가 없으면 혼자일 때만', () => {
  assert.equal(plan([s(1, ['hard'])], [])[0].eligible, true);
  const p = plan([s(1, ['hard'])], [ws('slice9', 9)]);
  assert.equal(p[0].eligible, false);
  assert.match(p[0].reason, /병렬 태그가 없어 혼자일 때만/);
});

test('창이 하나도 없는 워크스페이스는 자원으로 안 센다 — 붙으면 다시 보류', () => {
  // 사람이 손으로 만든 브랜치 워크스페이스(2026-08-30 project-b `plan15b`) 가 태그 없는 다음
  // 슬라이스를 막던 것. 폴더만 남은 워크스페이스는 모델도 마이크도 안 쓴다.
  const dead = ws('slice9', 9, []);
  const p = plan([s(1)], [dead]);
  assert.equal(p[0].eligible, true);
  assert.equal(p[0].reason, '활성 워크스페이스 0개');
  // 같은 워크스페이스에 창이 하나라도 붙으면 다시 보류다.
  const alive = ws('slice9', 9, ['t1']);
  const q = plan([s(1)], [alive]);
  assert.equal(q[0].eligible, false);
  assert.match(q[0].reason, /병렬 태그가 없어 혼자일 때만 \(지금 1개\)/);
});

test('체크된 슬라이스는 판정 표에 아예 안 나온다', () => {
  const p = plan([s(1, ['parallel'], { done: true }), s(2, ['parallel'])]);
  assert.deepEqual(p.map((x) => x.slice.number), [2]);
});

test('상한을 올려도 안 뜰 슬라이스에는 상한이 아니라 태그를 이유로 적는다', () => {
  const p = plan([s(1, ['parallel']), s(2)], [], 99);
  assert.match(p[1].reason, /병렬 태그가 없어/);
});

test('지시 문구 — 프로젝트 스킬이든 전역 스킬이든 있으면 축약형', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-dispatch-'));
  const home = mkdtempSync(join(tmpdir(), 'spsync-home-'));
  try {
    // 둘 다 없으면 고정 문장. 실제 홈에 전역 스킬이 깔려 있으므로 홈을 빈 폴더로 갈아 끼운다.
    assert.equal(sliceCommandFor(dir, 8, home), 'PRD.md, PLAN.md 읽고 슬라이스 8 진행. 끝나면 PLAN.md 체크하고 커밋.');
    // (1) 프로젝트에만 있는 경로
    mkdirSync(join(dir, '.claude', 'skills', 'slice'), { recursive: true });
    assert.equal(sliceCommandFor(dir, 8, home), '/slice 8');
    // (2) 전역에만 있는 경로 — 스킬 없는 프로젝트에도 축약형이 가야 한다
    rmSync(join(dir, '.claude'), { recursive: true, force: true });
    mkdirSync(join(home, '.claude', 'skills', 'slice'), { recursive: true });
    assert.equal(sliceCommandFor(dir, 8, home), '/slice 8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('표에 판정과 이유가 슬라이스마다 나온다', () => {
  const p = plan([s(1, ['parallel']), s(2)]);
  const out = renderDispatch({
    project: 'P',
    phase: { title: '2단계' },
    max: 3,
    active: 0,
    dryRun: true,
    decisions: p.map((x) => ({ number: x.slice.number, title: x.slice.title, tags: x.slice.tags, eligible: x.eligible, reason: x.reason })),
    dispatched: [],
  });
  assert.match(out, /\(dry-run\) 활성 0 · 상한 3/);
  assert.match(out, /1 .*파견 .*병렬 가능/);
  assert.match(out, /2 .*보류 .*혼자일 때만/);
  assert.match(out, /파견 대상 1개/);
});

// 슬라이스 13 — 워커 모델을 사용자 기본값에 맡기지 않는다
const models = { model: 'opus[1m]', hardModel: 'fable' };

test('보통 슬라이스도 모델을 못 박는다 — `claude` 만 띄우지 않는다', () => {
  assert.equal(workerCommand(s(1), models), 'claude --model opus[1m]');
  assert.equal(workerCommand(s(2, ['parallel']), models), 'claude --model opus[1m]');
});

test('[어려움] 만 최상위 모델로 뜬다', () => {
  assert.equal(workerCommand(s(3, ['hard']), models), 'claude --model fable');
  assert.equal(workerCommand(s(4, ['hard', 'parallel']), models), 'claude --model fable');
});

test('모델이 비면 `--model undefined` 대신 어느 설정이 빈 것인지 알리고 던진다', () => {
  assert.throws(() => workerCommand(s(5), { hardModel: 'fable' }), /fleetModel/);
  assert.throws(() => workerCommand(s(6, ['hard']), { model: 'opus' }), /fleetHardModel/);
});

// 슬라이스 21 — `[선행: N, M]` 부분 의존
test('선행 중 하나라도 미완이면 자격이 없고, 사유에 그 번호가 난다', () => {
  const p = byNo(plan([s(3, ['parallel']), s(5, ['parallel']), s(7, ['deps'], { deps: [3, 5] })]));
  assert.equal(p[7].eligible, false);
  assert.equal(p[7].reason, '선행 미완: 3, 5번');
});

test('선행이 전부 [x] 이면 다른 슬라이스가 도는 중이어도 뜬다 — [병렬 가능] 을 함축한다', () => {
  // 4번이 [병렬 가능] 로 돌고 있다. 7번은 선행 3번만 끝나면 되므로 같이 뜨다 —
  // 태그가 없었다면 '병렬 태그가 없어 혼자일 때만' 로 막혔을 자리다.
  const running = ws('slice4', 4);
  const args = [s(3, [], { done: true }), s(4, ['parallel'], { workspace: running }), s(7, ['deps'], { deps: [3] })];
  const p = byNo(plan(args, [running]));
  assert.equal(p[7].eligible, true);
  assert.equal(p[7].reason, '선행 3번 완료');
  // 같은 자리에 태그가 없으면 막힌다
  const q = byNo(plan([args[0], args[1], s(7)], [running]));
  assert.equal(q[7].eligible, false);
  assert.match(q[7].reason, /병렬 태그가 없어 혼자일 때만/);
});

test('태그 없는 슬라이스가 도는 중이면 선행이 다 끝나도 막힌다', () => {
  const running = ws('slice1', 1);
  const p = byNo(plan([s(1, [], { workspace: running }), s(3, [], { done: true }), s(7, ['deps'], { deps: [3] })], [running]));
  assert.equal(p[7].eligible, false);
  assert.match(p[7].reason, /1번이 혼자 돌아야 함/);
});

test('계획에 없는 선행 번호(접힌 지난 단계)는 안 막고 사유에만 적는다', () => {
  const p = byNo(plan([s(7, ['deps'], { deps: [2, 4] })]));
  assert.equal(p[7].eligible, true);
  assert.equal(p[7].reason, '선행 2, 4번 완료 (2, 4번은 계획에 없음)');
});

test('모르는 태그는 판정 사유에 남는다 — 조용히 무시하지 않는다', () => {
  const p = plan([s(1, ['parallel'], { unknownTags: ['오타태그'] })]);
  assert.equal(p[0].eligible, true);
  assert.match(p[0].reason, /병렬 가능 · 모르는 태그: \[오타태그\]/);
});

// 슬라이스 24 — 이름을 못 읽는 창이 살아 있으면 새 파견을 보류한다
test('미분류 활성 창이 있으면 [병렬 가능] 도 보류되고 사유에 창 이름·브랜치가 난다', () => {
  // 2026-08-31 Project A: 사용자가 브랜치 `dev/catshark` 창에서 슬라이스 1 을
  // 하고 있었는데 파견이 slice1 워크스페이스를 두 번 새로 만들었다.
  const hand = { name: 'catshark', path: 'C:/w/catshark', branch: 'dev/catshark', slice: null, terminals: ['t1'] };
  const p = byNo(plan([s(1, ['parallel']), s(2, ['parallel'])], [hand]));
  for (const n of [1, 2]) {
    assert.equal(p[n].eligible, false);
    assert.match(p[n].reason, /미분류 창 catshark \(브랜치 dev\/catshark\) 이 살아 있음/);
    assert.match(p[n].reason, /창을 닫으면 풀린다/);
  }
  // 브랜치를 `sliceN` 으로 바꾸면 그 창은 슬라이스 1 로 잡히고 나머지는 원래 규칙대로 뜬다.
  const named = { ...hand, branch: 'dev/slice1', slice: 1 };
  const q = byNo(plan([s(1, ['parallel'], { workspace: named }), s(2, ['parallel'])], [named]));
  assert.equal(q[1].eligible, false);
  assert.match(q[1].reason, /이미 돌고 있음 \(catshark\)/);
  assert.equal(q[2].eligible, true);
  assert.equal(q[2].reason, '병렬 가능');
});

test('창이 없는 미분류는 안 막는다 — 재파견도 안 막는다', () => {
  // 폴더만 남은 미분류는 아무 자원도 안 쓴다 (슬라이스 18 과 같은 잣대)
  assert.equal(strayBlock([{ name: 'plan15b', branch: 'u/plan15b', slice: null, terminals: [] }]), null);
  assert.equal(strayBlock([{ name: 'slice3', branch: 'u/slice3', slice: 3, terminals: ['t1'] }]), null);
  // 재파견은 새 창을 안 만드므로 미분류 창이 있어도 간다
  const hand = { name: 'catshark', path: 'C:/w/catshark', branch: 'u/catshark', slice: null, terminals: ['t1'] };
  const running = { ...ws('slice1', 1), stalled: { stalled: true, why: '지시가 안 들어감' } };
  const p = byNo(plan([s(1, [], { workspace: running }), s(2, ['parallel'])], [running, hand]));
  assert.equal(p[1].eligible, true);
  assert.match(p[1].reason, /재파견 — 지시가 안 들어감/);
  assert.equal(p[2].eligible, false);
  assert.match(p[2].reason, /미분류 창 catshark/);
});

// 슬라이스 7 — 파견 뒤 여분 탭 닫기
const term = (handle, worktreePath, extra = {}) => ({ handle, worktreePath, connected: true, orphaned: false, ...extra });
const tabIo = (list, closeFails = () => false) => {
  const closed = [];
  return {
    closed,
    list: () => list,
    close: (h) => {
      if (closeFails(h)) throw new Error('close 실패 ' + h);
      closed.push(h);
    },
  };
};

test('같은 워크스페이스의 다른 창만 닫는다 — Claude 창과 남의 워크스페이스는 그대로', () => {
  const io = tabIo([
    term('claude', 'C:/w/slice7'),
    term('term1', 'C:\\w\\slice7/'), // 구분자·끝 슬래시가 달라도 같은 워크스페이스다
    term('pwsh', 'C:/w/slice7'),
    term('남', 'C:/w/slice5'),
    term('죽은', 'C:/w/slice7', { connected: false }),
    term('고아', 'C:/w/slice7', { orphaned: true }),
  ]);
  const r = closeExtraTabs('C:/w/slice7', 'claude', io);
  assert.deepEqual(io.closed, ['term1', 'pwsh']);
  assert.deepEqual(r.failed, []);
  assert.match(r.detail, /여분 탭 2개 닫음/);
});

test('닫기가 실패해도 던지지 않고, 나머지는 계속 닫고, 보고에 한 줄 남는다', () => {
  // 완료 기준의 "닫기가 실패해도 `/slice N` 은 전송된다" — dispatchOne 은 이 함수의 반환만
  // 실어 나르므로, 여기서 안 던지면 지시 전송까지 그대로 간다.
  const io = tabIo([term('claude', 'C:/w/slice7'), term('term1', 'C:/w/slice7'), term('pwsh', 'C:/w/slice7')], (h) => h === 'term1');
  const r = closeExtraTabs('C:/w/slice7', 'claude', io);
  assert.deepEqual(io.closed, ['pwsh']); // 첫 실패가 다음 창을 막지 않는다
  assert.deepEqual(r.closed, ['pwsh']);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].handle, 'term1');
  assert.match(r.detail, /탭 1개 못 닫음: close 실패 term1/);
});

test('목록 조회가 실패해도 던지지 않는다 — 아무것도 안 닫고 사유만 낸다', () => {
  const io = { list: () => { throw new Error('orca 가 안 뜸'); }, close: () => assert.fail('닫으면 안 된다') };
  const r = closeExtraTabs('C:/w/slice7', 'claude', io);
  assert.deepEqual(r.closed, []);
  assert.match(r.detail, /목록 조회 실패: orca 가 안 뜸/);
});

test('남길 창을 모르면 아무것도 안 닫는다 — 방금 띄운 Claude 창까지 닫으면 안 된다', () => {
  const io = tabIo([term('term1', 'C:/w/slice7'), term('pwsh', 'C:/w/slice7')]);
  const r = closeExtraTabs('C:/w/slice7', null, io);
  assert.deepEqual(io.closed, []);
  assert.equal(r.detail, '');
});

// --- 4단계 슬라이스 1: 헤드리스 에이전트 ---
const agents = { codex: { cmd: 'codex' }, antigravity: { cmd: 'agy' } };

test('프로필에 없는 에이전트 이름은 그 슬라이스만 보류한다 — 조용히 claude 로 떨어지면 안 된다', () => {
  const p = byNo(plan([s(1, ['agent', 'parallel'], { agent: 'opencode', agentUnknown: true }), s(2, ['parallel'])]));
  assert.equal(p[1].eligible, false);
  assert.match(p[1].reason, /모르는 에이전트: opencode/);
  assert.equal(p[2].eligible, true); // 그 앞에서 멈추지 않는다
});

test('헤드리스는 에이전트 명령이 아니라 래퍼를 띄운다 — 훅 역할을 그것이 대신한다', () => {
  const cmd = workerCommand(s(6, ['agent'], { agent: 'codex' }), { ...models, agents });
  assert.match(cmd, /sp-sync\.mjs"? worker --agent codex --slice 6$/);
  assert.doesNotMatch(cmd, /codex exec/); // 프로필 명령은 래퍼가 안에서 만든다
  // 에이전트가 claude 면 지금 그대로다
  assert.equal(workerCommand(s(7, [], { agent: 'claude' }), { ...models, agents }), 'claude --model opus[1m]');
});

// --- 5단계 슬라이스 8: [어려움] 헤드리스는 래퍼에 --hard 를 붙인다 ---
test('[어려움] 헤드리스 슬라이스는 래퍼 명령에 --hard 가 실린다 — 없으면 프로필의 {hard} 가 안 펼쳐진다', () => {
  const hard = workerCommand(s(12, ['hard', 'agent'], { agent: 'codex' }), { ...models, agents });
  assert.match(hard, /worker --agent codex --slice 12 --hard$/);
  // [어려움] 없는 같은 에이전트는 그대로다
  const plainCmd = workerCommand(s(13, ['agent'], { agent: 'codex' }), { ...models, agents });
  assert.doesNotMatch(plainCmd, /--hard/);
});

test('손으로 부를 때도 모르는 이름은 던진다 — 없는 프로필로 래퍼를 띄우면 워크스페이스만 남는다', () => {
  assert.throws(() => workerCommand(s(8, ['agent'], { agent: 'opencode' }), { ...models, agents }), /모르는 에이전트: opencode/);
});

test('[어려움] 이면 codex 는 추론 강도를, antigravity 는 모델을 올린다 (기본 프로필)', () => {
  const codex = DEFAULT_CONFIG.fleetAgents.codex;
  const normal = agentArgv(codex, { path: 'C:/w/slice6', prompt: '슬라이스 6 진행' });
  // 자리표시자가 채워지고, `{hard}` 는 흔적 없이 사라진다
  // `-a` 는 codex 0.152.0 exec 에 없다(파싱 오류로 exit 2, 2026-09-02 slice6 첫 파견) — common.mjs 주석
  assert.deepEqual(normal.args, ['exec', '-C', 'C:/w/slice6', '--approve-for-me', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'project_doc_max_bytes=131072', '슬라이스 6 진행']);
  // 강도 플래그는 **위치 인자(프롬프트) 앞**에 들어가야 한다 — 뒤에 붙이면 codex 가 안 읽는다
  const hard = agentArgv(codex, { path: 'C:/w/slice6', prompt: 'p', hard: true });
  assert.deepEqual(hard.args.slice(-3), ['-c', 'model_reasoning_effort="xhigh"', 'p']);

  const agy = DEFAULT_CONFIG.fleetAgents.antigravity;
  assert.equal(agentArgv(agy, { prompt: 'p' }).cmd, 'agy');
  assert.deepEqual(agentArgv(agy, { prompt: 'p' }).args, ['-p', 'p', '--dangerously-skip-permissions', '--print-timeout', '4h']);
  assert.deepEqual(agentArgv(agy, { prompt: 'p', hard: true }).args.slice(-2), ['--model', 'gemini-3.1-pro-high']);
});

test('모르는 프로필 이름은 null — 부르는 쪽이 보류한다', () => {
  assert.equal(agentProfile('opencode', { fleetAgents: agents }), null);
  assert.equal(agentProfile('claude', { fleetAgents: agents }), null); // claude 는 TUI 라 이 표에 없다
  assert.equal(agentProfile('codex', { fleetAgents: agents }).cmd, 'codex');
});

test('사용자가 프로필 하나를 손봐도 나머지가 안 사라진다 — 표는 키마다 합친다', () => {
  // 2026-09-01: 사용자 config.json 의 codex 한 줄이 fleetAgents 표 전체를 가려 antigravity 가
  // "모르는 에이전트" 가 됐다. `config()` 의 얕은 병합만으로는 표가 통째로 갈린다.
  const merged = agentTable({ fleetAgents: { codex: { cmd: 'codex', args: ['{prompt}'] } } });
  assert.deepEqual(merged.codex.args, ['{prompt}']); // 사용자 것이 이긴다
  assert.equal(merged.antigravity.cmd, 'agy'); // 기본 프로필은 남는다
});

// --- 4단계 슬라이스 4: 파견의 헤드리스 경로 ---
// 헤드리스는 `terminal create --command "<래퍼>"` 로 끝이다 — 준비 신호(`❯`)·`tui-idle`·지시 전송은
// REPL 의 것이라 타지 않는다. 여분 탭 닫기는 그대로.

const fakeDeps = (calls, over = {}) => ({
  // 경로는 **요청한 이름**을 따른다 — Orca 도 그렇게 만든다. 고정값으로 두면 이름이 밀린
  // 경우(`slice6-2`)와 정상을 구분하지 못한다.
  // `--agent` 로 만들면 에이전트 창 핸들이 같이 온다(`agentTerminalHandle`). 없이 만들면 null.
  createWorktree: (args) => (calls.push(['createWorktree', args]), { id: 'wt-1', path: 'C:/w/' + args[args.indexOf('--name') + 1], handle: args.includes('--agent') ? 'term-agent' : null }),
  createTerminal: (args) => (calls.push(['createTerminal', args]), 'term-1'),
  nameTaken: (root, name) => (calls.push(['nameTaken', name]), null),
  waitForHooks: async (path) => (calls.push(['waitForHooks', path]), true),
  waitForSession: async (path, since) => (calls.push(['waitForSession', path, since]), { ok: true, session: '/slice 7' }),
  waitForPrompt: async () => (calls.push(['waitForPrompt']), { ok: true }),
  waitIdle: () => calls.push(['waitIdle']),
  closeExtraTabs: (path, keep) => (calls.push(['closeExtraTabs', path, keep]), { closed: ['t0'], failed: [], detail: '여분 탭 1개 닫음' }),
  send: async () => (calls.push(['send']), { result: 'submitted', submit: '제출 확인', resent: 0 }),
  projectOf: () => 'SP-sync',
  sleep: async (ms) => calls.push(['sleep', ms]),
  setStatus: (path, status) => calls.push(['setStatus', path, status]),
  // 헤드리스 파견 직후의 "정말 떴는가" 확인 (`watchHeadlessStart`). 기본은 **도는 중**이다 —
  // 즉시 종료·기록 없음은 그 테스트가 따로 갈아 끼운다.
  sessions: () => (calls.push(['sessions']), { s1: { worktree: 'C:/w/slice6', agent: 'codex', turnStartedAt: Date.now() } }),
  ...over,
});
const dispatchOpts = { ...models, agents, repoId: 'repo-1', project: 'SP-sync', readyMs: 1, createMs: 1 };

test('헤드리스 파견은 create 만 부른다 — 프롬프트·유휴·전송은 타지 않고 여분 탭은 닫는다', async () => {
  const calls = [];
  const d = await dispatchOne(s(6, ['agent'], { agent: 'codex' }), dispatchOpts, fakeDeps(calls));
  assert.equal(d.ok, true);
  assert.equal(d.agent, 'codex');
  assert.equal(d.submit, '래퍼 실행 (codex)');
  const names = calls.map((c) => c[0]);
  assert.deepEqual(names, ['nameTaken', 'createWorktree', 'setStatus', 'waitForHooks', 'sleep', 'createTerminal', 'closeExtraTabs', 'sessions']);
  // 헤드리스는 에이전트 없이 만든다 — 래퍼 창을 따로 연다
  assert.ok(!calls[1][1].includes('--agent'));
  // 훅 파일은 헤드리스도 기다린다 — git 훅·AGENTS.md 가 같은 스크립트에서 나온다
  assert.equal(calls[3][1], 'C:/w/slice6');
  // 터미널 명령이 래퍼다. 보고의 "지시" 열(`text`)에도 그 명령이 실린다
  const args = calls[5][1];
  assert.equal(args[args.indexOf('--command') + 1], d.command);
  assert.match(d.command, /worker --agent codex --slice 6$/);
  assert.equal(d.text, d.command);
  assert.equal(d.tabs.detail, '여분 탭 1개 닫음');
  assert.equal(d.exited, null); // 세션 기록이 도는 중이면 즉시 종료가 아니다
});

// --- 슬라이스 37: 파견 직후의 시작 확인 (coordinator 점검 #6) ---
// 래퍼는 exit 75(겹친 턴)나 CLI 부재로 곧바로 죽어도 `terminal create` 는 성공으로 돌아온다.
// 그것을 "파견됨" 으로 세면 아무도 안 보고, 다음 회차는 활성 워크스페이스가 있다고 여겨 안 띄운다.

test('곧바로 끝난 래퍼는 시작이 아니라 즉시 종료로 남는다', async () => {
  const calls = [];
  // 기록 시각은 **부를 때** 찍는다 — `dispatchOne` 의 `since` 는 이 함수에 들어간 뒤에 잡히므로,
  // 미리 잡아 둔 값은 1ms 차이로 `since` 보다 앞서 "지난 워크스페이스의 옛 기록"으로 걸러진다.
  const d = await dispatchOne(s(6, ['agent'], { agent: 'codex' }), dispatchOpts, {
    ...fakeDeps(calls),
    sessions: () => {
      const t = Date.now();
      return { s1: { worktree: 'C:/w/slice6', agent: 'codex', turnStartedAt: t, turnEndedAt: t + 1, exitCode: 75 } };
    },
  });
  assert.equal(d.ok, true); // create 는 실제로 됐다 — 실패가 아니라 다른 결과다
  assert.deepEqual(d.exited, { exitCode: 75 });
  assert.equal(d.submit, '래퍼 실행 (codex) — 즉시 종료 exit 75');
});

test('기록이 안 생기면 죽은 것으로 읽지 않는다 — "기록 미확인"만 붙이고 시작으로 둔다', async () => {
  const calls = [];
  const d = await dispatchOne(s(6, ['agent'], { agent: 'codex' }), { ...dispatchOpts, exitWatchMs: 0 }, { ...fakeDeps(calls), sessions: () => ({}) });
  assert.equal(d.ok, true);
  assert.equal(d.exited, null);
  assert.equal(d.submit, '래퍼 실행 (codex) (기록 미확인)');
});

test('지난 워크스페이스의 옛 기록은 안 본다 — 같은 이름의 기록이 state 에 7일 남는다', async () => {
  const calls = [];
  const old = Date.now() - 3 * 86400000;
  const d = await dispatchOne(s(6, ['agent'], { agent: 'codex' }), { ...dispatchOpts, exitWatchMs: 0 }, {
    ...fakeDeps(calls),
    sessions: () => ({ s0: { worktree: 'C:/w/slice6', agent: 'codex', turnStartedAt: old, turnEndedAt: old + 1, exitCode: 0 } }),
  });
  assert.equal(d.exited, null); // 지난 단계의 종료를 이번 파견의 즉시 종료로 읽으면 안 된다
  assert.equal(d.submit, '래퍼 실행 (codex) (기록 미확인)');
});

// --- 6단계 슬라이스 26: claude 파견은 `worktree create --agent claude --prompt` 한 명령이다 ---
// 생성·설정 훅 대기·Claude 기동·첫 프롬프트를 Orca 가 하고(2026-09-04 실측, `notes/2026-09-04-worktree-create-agent-실측.md`),
// 파견은 훅 기록(세션 기록의 `turnStartedAt`)이 생기는 것만 기다린다. 화면의 `❯`·`tui-idle`·전송·재전송은 없다.

test('claude 파견은 create(--agent --prompt) → 훅 기록 대기 → 탭 닫기 — 프롬프트·유휴·전송·훅 파일 대기는 없다', async () => {
  const calls = [];
  const d = await dispatchOne(s(7), { ...dispatchOpts, root: 'C:/repo' }, fakeDeps(calls));
  assert.equal(d.ok, true);
  assert.equal(d.stage, 'session');
  assert.equal(d.submit, 'Orca 가 제출 · 훅 기록 확인');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['nameTaken', 'createWorktree', 'setStatus', 'waitForSession', 'closeExtraTabs']
  );
  const args = calls[1][1];
  assert.equal(args[args.indexOf('--agent') + 1], 'claude');
  assert.equal(args[args.indexOf('--prompt') + 1], d.text);
  assert.match(d.text, /(\/slice 7|슬라이스 7 진행)/); // 스킬 유무에 따라 둘 중 하나 — 기계마다 다르다
  assert.deepEqual(args.slice(args.indexOf('--setup'), args.indexOf('--setup') + 2), ['--setup', 'run']);
  assert.ok(!args.includes('--run-hooks')); // 옛 별칭 — 워크트리를 앱 전면에 띄운다
  // 훅 기록은 create 이후 시각부터 센다 — 지난 단계의 같은 번호 기록이 7일 남는다
  assert.equal(calls[3][1], 'C:/w/slice7');
  assert.equal(typeof calls[3][2], 'number');
  // 표의 명령은 새 모양이고 모델은 설정 파일 쪽이라고 적는다
  assert.match(d.command, /^orca worktree create --agent claude --prompt /);
  assert.match(d.command, /모델 opus\[1m\] — install 이 settings\.local\.json 에/);
});

test('[어려움] claude 파견의 표 명령은 최상위 모델을 적는다 — 설정 파일에 박히는 그 값', () => {
  assert.match(dispatchCommand(s(3, ['hard']), '/slice 3', models), /^orca worktree create --agent claude --prompt "\/slice 3"  \(모델 fable/);
  assert.match(dispatchCommand(s(1), '/slice 1', models), /\(모델 opus\[1m\]/);
  assert.throws(() => dispatchCommand(s(5), '/slice 5', { hardModel: 'fable' }), /fleetModel/);
  // 헤드리스는 그대로 래퍼 명령이다
  assert.match(dispatchCommand(s(6, ['agent'], { agent: 'codex' }), null, { ...models, agents }), /worker --agent codex --slice 6$/);
});

test('훅 기록이 안 생기면 실패로 보고하고 지시를 다시 보내지 않는다 — 재파견은 다음 회차 몫', async () => {
  const calls = [];
  const d = await dispatchOne(s(7), dispatchOpts, fakeDeps(calls, { waitForSession: async () => ({ ok: false, detail: '훅 기록이 안 생김' }) }));
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'session');
  assert.match(d.detail, /훅 기록이 안 생김/);
  assert.ok(!calls.some((c) => c[0] === 'send'));
  assert.ok(!calls.some((c) => c[0] === 'closeExtraTabs')); // 설정 스크립트가 아직 도는 중일 수 있다
});

test('같은 이름의 폴더가 이미 있으면 만들지 않는다 — --agent 는 create 순간 창이 열려 되돌려도 strayBlock 이 걸린다', async () => {
  const calls = [];
  const d = await dispatchOne(s(7), { ...dispatchOpts, root: 'C:/repo' }, fakeDeps(calls, { nameTaken: () => 'C:/w/slice7' }));
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'name');
  assert.match(d.detail, /같은 이름의 폴더가 남아 있음: C:\/w\/slice7/);
  assert.ok(!calls.some((c) => c[0] === 'createWorktree'));
});

test('헤드리스도 훅 파일이 안 생기면 래퍼를 안 띄운다', async () => {
  const calls = [];
  const d = await dispatchOne(s(6, ['agent'], { agent: 'codex' }), dispatchOpts, fakeDeps(calls, { waitForHooks: async () => false }));
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'hooks');
  assert.ok(!calls.some((c) => c[0] === 'createTerminal'));
});

// --- 2026-09-02: 이름이 밀린 워크스페이스 ---
// 같은 이름의 폴더가 남아 있으면 Orca 가 `slice6-2` 로 비켜 만든다. 그 이름은 `sliceNumberOf`
// 에 안 걸려 착륙도 재파견도 못 찾고, 창까지 열면 `strayBlock` 이 그 프로젝트의 파견을 멈춘다.

// --- 6단계 슬라이스 25: 워크스페이스 카드 상태 ---
// 파견이 만든 워크스페이스는 Orca 보드에서 `in-progress` 로 뜬다. Orca 가 이 값을 스스로
// 바꾸지 않는다는 것은 실측했다 (`notes/2026-09-04-워크스페이스-카드-상태-실측.md`).

test('파견은 워크트리를 만든 직후 카드 상태를 in-progress 로 찍는다', async () => {
  const calls = [];
  const d = await dispatchOne(s(7), dispatchOpts, fakeDeps(calls));
  assert.equal(d.ok, true);
  const names = calls.map((c) => c[0]);
  // create 바로 뒤 — 훅 기록 대기·탭 정리보다 앞이라 카드가 늦게 칠해지지 않는다 (이름 확인은 create 앞이다)
  assert.equal(names[0], 'nameTaken');
  assert.equal(names[1], 'createWorktree');
  assert.equal(names[2], 'setStatus');
  assert.deepEqual(calls[2], ['setStatus', 'C:/w/slice7', 'in-progress']);
});

test('상태 설정이 실패해도 파견은 그대로 간다 — 카드 색은 표시일 뿐이다', async () => {
  const calls = [];
  const d = await dispatchOne(
    s(7),
    dispatchOpts,
    fakeDeps(calls, { setStatus: () => { throw new Error('orca 가 안 뜸'); } })
  );
  assert.equal(d.ok, true);
  assert.equal(d.stage, 'session');
});

test('이름이 밀린 워크스페이스에는 상태를 안 찍는다 — 도로 지울 것이다', async () => {
  const calls = [];
  const d = await dispatchOne(
    s(6),
    { ...dispatchOpts, root: 'C:/repo' },
    fakeDeps(calls, {
      createWorktree: (args) => (calls.push(['createWorktree', args]), { id: 'wt-1', path: 'C:/w/slice6-2', handle: null }),
      removeWorktree: () => {},
      removeDir: () => {},
    })
  );
  assert.equal(d.stage, 'name');
  assert.ok(!calls.some((c) => c[0] === 'setStatus'));
});

test('이름이 밀리면 창을 안 열고, 방금 만든 워크스페이스를 도로 지운다', async () => {
  const calls = [];
  const d = await dispatchOne(
    s(6),
    { ...dispatchOpts, root: 'C:/repo' },
    fakeDeps(calls, {
      createWorktree: (args) => (calls.push(['createWorktree', args]), { id: 'wt-1', path: 'C:/w/slice6-2', handle: null }),
      removeWorktree: (repoId, path) => calls.push(['removeWorktree', repoId, path]),
      removeDir: (path, root) => calls.push(['removeDir', path, root]),
    })
  );
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'name');
  assert.match(d.detail, /이름이 밀림: slice6-2 \(원한 것: slice6\)/);
  // 창을 안 연다 — 창이 없으면 strayBlock 도 안 걸려 다음 회차가 그대로 돈다
  assert.ok(!calls.some((c) => c[0] === 'createTerminal'));
  assert.ok(!calls.some((c) => c[0] === 'send'));
  // 되돌린다: 워크트리와 폴더 둘 다
  assert.deepEqual(calls.filter((c) => c[0] === 'removeWorktree')[0], ['removeWorktree', 'repo-1', 'C:/w/slice6-2']);
  assert.deepEqual(calls.filter((c) => c[0] === 'removeDir')[0], ['removeDir', 'C:/w/slice6-2', 'C:/repo']);
});

test('되돌리기가 실패해도 던지지 않는다 — 보고는 그대로 나가야 한다', async () => {
  const calls = [];
  const d = await dispatchOne(
    s(6),
    { ...dispatchOpts, root: 'C:/repo' },
    fakeDeps(calls, {
      createWorktree: () => ({ id: 'wt-1', path: 'C:/w/slice6-2', handle: null }),
      removeWorktree: () => { throw new Error('orca 가 안 뜸'); },
      removeDir: () => {},
    })
  );
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'name');
});

test('이름이 맞으면 예전 그대로 간다 — 확인이 정상 경로를 막지 않는다', async () => {
  const calls = [];
  const d = await dispatchOne(s(6), { ...dispatchOpts, root: 'C:/repo' }, fakeDeps(calls));
  assert.equal(d.ok, true);
  assert.ok(!calls.some((c) => c[0] === 'removeWorktree'));
});

test('dry-run 표 아래에 헤드리스 래퍼 명령이 그대로 찍힌다 — 보류된 슬라이스도', () => {
  const decisions = [
    { number: 5, title: 't5', tags: ['hard'], agent: 'claude', command: 'claude --model fable', eligible: true, reason: '활성 워크스페이스 0개' },
    { number: 6, title: 't6', tags: ['agent'], agent: 'codex', command: 'node sp-sync.mjs worker --agent codex --slice 6', eligible: false, reason: '선행 미완: 5번' },
    { number: 7, title: 't7', tags: ['agent'], agent: 'antigravity', command: 'node sp-sync.mjs worker --agent antigravity --slice 7', eligible: false, reason: '선행 미완: 6번' },
  ];
  const out = renderDispatch({ project: 'P', max: 3, active: 0, dryRun: true, decisions, dispatched: [] });
  assert.match(out, /헤드리스 래퍼 명령:\n  slice6  node sp-sync\.mjs worker --agent codex --slice 6\n  slice7  node sp-sync\.mjs worker --agent antigravity --slice 7/);
  assert.doesNotMatch(out, /slice5  claude --model/); // claude 명령은 새 정보가 아니다
  // 실제 파견에서는 보낸 것 줄이 명령을 이미 싣는다 — 같은 명령을 두 번 안 적는다
  assert.doesNotMatch(renderDispatch({ project: 'P', max: 3, active: 0, dryRun: false, decisions, dispatched: [] }), /헤드리스 래퍼 명령/);
});

test('세션 기록의 agent 가 워크스페이스를 헤드리스로 표시한다 — 계획은 그 다음이다', () => {
  const now = 1000000;
  const sessions = {
    a: { worktree: 'C:/w/slice6', agent: 'codex', turnStartedAt: now - 5000, turnEndedAt: now - 1000 },
    b: { worktree: 'C:/w/slice7', turnStartedAt: now - 5000, turnEndedAt: now - 1000 },
  };
  const t6 = turnStateFor('C:/w/slice6', sessions, now);
  assert.equal(t6.agent, 'codex');
  assert.equal(t6.active, false);
  assert.equal(turnStateFor('C:/w/slice7', sessions, now).agent, 'claude');
  // 기록이 이긴다. `claude` 기록도 계획의 codex 보다 먼저라 헤드리스가 아니다.
  assert.equal(headlessOf({ turn: t6, agent: 'claude' }), 'codex');
  assert.equal(headlessOf({ turn: { known: true, agent: 'claude' }, agent: 'codex' }), null);
  assert.equal(headlessOf({ turn: { known: false }, agent: 'antigravity' }), 'antigravity');
  assert.equal(headlessOf({ turn: { known: false }, agent: 'claude' }), null);
  assert.equal(headlessOf({}), null);
});

// 2026-09-04 Project A — 9·10번이 `[어려움]` 한도 게이트에 걸려 보류되자 태그 없는 11번이
// "활성 워크스페이스 0개" 로 먼저 나갔다. 보류된 비병렬 슬라이스는 뒤의 비병렬 슬라이스를 막아야 한다.
test('앞의 비병렬 슬라이스가 한도로 보류되면 뒤의 비병렬 슬라이스도 뜨지 않는다', () => {
  const hold = (s) => (s.tags.includes('hard') ? '한도 임박 — claude 5시간 98%' : null);
  const p = byNo(dispatchPlan({ slices: [s(9, ['hard']), s(10, ['hard']), s(11)], workspaces: [], max: 3, limitHold: hold }));
  assert.equal(p[9].eligible, false);
  assert.match(p[9].reason, /^한도 임박/);
  assert.equal(p[11].eligible, false);
  assert.match(p[11].reason, /^9번이 먼저 \(보류 중: 한도 임박/);
});

test('[결정 필요] 로 보류된 비병렬 슬라이스도 뒤를 막는다 — 같은 구멍', () => {
  const p = byNo(plan([s(1, ['decision'], { decision: '무엇' }), s(2)]));
  assert.equal(p[1].eligible, false);
  assert.equal(p[2].eligible, false);
  assert.match(p[2].reason, /^1번이 먼저 \(보류 중: 결정 필요: 무엇/);
});

test('보류된 비병렬 슬라이스 뒤라도 [병렬 가능]·[선행] 은 뜬다 — 앞과 독립을 선언한 것', () => {
  const hold = (s) => (s.tags.includes('hard') ? '한도 임박' : null);
  const p = byNo(dispatchPlan({ slices: [s(9, ['hard']), s(10), s(11, ['parallel']), s(12, [], { deps: [8] })], workspaces: [], max: 3, limitHold: hold }));
  assert.equal(p[10].eligible, false);
  assert.equal(p[11].eligible, true);
  assert.equal(p[11].reason, '병렬 가능');
  assert.equal(p[12].eligible, true);
});

// --- 슬라이스 36: 계획 오류가 있는 슬라이스는 파견되지 않는다 (coordinator 점검 #2) ---
// 판정은 파서(`planErrors`)가 하고 여기서는 붙어 온 `errors` 만 본다 — 그래야 검토용
// `fleet slices` 와 파견이 같은 목록을 본다. 손으로 지은 슬라이스에는 `errors` 가 없다.
const err = (kind, detail) => [{ slice: null, line: 0, kind, detail }];

test('계획 오류가 있는 슬라이스는 안 뜬다 — 오타를 기본값으로 해석하지 않는다', () => {
  const p = byNo(
    plan([
      s(1, ['parallel'], { errors: err('unknown-tag', '모르는 태그 [결정필요: 승인]') }),
      s(2, ['deps'], { deps: [999], errors: err('missing-prereq', '선행 999번이 계획에 없음') }),
      s(3, ['parallel']),
    ])
  );
  assert.equal(p[1].eligible, false);
  assert.equal(p[1].reason, '계획 오류: 모르는 태그 [결정필요: 승인]');
  assert.equal(p[2].eligible, false);
  assert.equal(p[2].reason, '계획 오류: 선행 999번이 계획에 없음');
  // 그 슬라이스만 막고 프로젝트는 안 막는다 — 뒤의 [병렬 가능] 은 그대로 뜬다
  assert.equal(p[3].eligible, true);
});

test('계획 오류 슬라이스는 뒤의 비병렬을 세운다 — 틀린 [선행] 은 독립 선언의 근거가 못 된다', () => {
  const p = byNo(plan([s(1, ['deps'], { deps: [999], errors: err('missing-prereq', '선행 999번이 계획에 없음') }), s(2)]));
  assert.equal(p[2].eligible, false);
  assert.ok(p[2].reason.startsWith('1번이 먼저 (보류 중: 계획 오류'));
});

test('계획 오류 슬라이스는 이미 창이 떠 있어도 재파견하지 않는다', () => {
  const running = ws('slice1', 1);
  running.stalled = { stalled: true, why: '지시 없음' };
  const p = byNo(plan([s(1, ['parallel'], { workspace: running, errors: err('dup-number', '번호 1 중복 — 2곳 (7줄, 8줄)') })], [running]));
  assert.equal(p[1].eligible, false);
  assert.ok(p[1].reason.includes('slice1 재파견 보류'));
});

test('선행 완료는 파일 전체로 본다 — 다른 절의 미체크 선행을 끝난 것으로 읽지 않는다', () => {
  // 8단계를 7단계 앞에 둔 지금 배치. 30번은 뒤 절에 미체크로 있다.
  const cur = [s(36, ['deps'], { deps: [30] })];
  const all = cur.concat([s(30)]);
  const p = byNo(dispatchPlan({ slices: cur, workspaces: [], max: 3, allSlices: all }));
  assert.equal(p[36].eligible, false);
  assert.equal(p[36].reason, '선행 미완: 30번');
  // 그 절에서 끝났으면 뜬다
  const done = byNo(dispatchPlan({ slices: cur, workspaces: [], max: 3, allSlices: cur.concat([s(30, [], { done: true })]) }));
  assert.equal(done[36].eligible, true);
});

test('점검 노트의 두 입력이 파서를 거치면 파견 불가다', () => {
  // coordinator 점검 #2 의 재현 표 그대로. 예전에는 둘 다 `eligible: true` 였다.
  const parsed = parsePlanSlices(
    ['## 8단계', '', '- [ ] **1. x** [결정필요: 승인]', '- [ ] **2. y** [선행: 999]', '- [ ] **3. z** [병렬 가능]'].join(String.fromCharCode(10))
  );
  const p = byNo(dispatchPlan({ slices: parsed.slices, workspaces: [], max: 3, allSlices: parsed.allSlices }));
  assert.equal(p[1].eligible, false);
  assert.ok(p[1].reason.startsWith('계획 오류'));
  assert.equal(p[2].eligible, false);
  assert.ok(p[2].reason.startsWith('계획 오류'));
  assert.equal(p[3].eligible, true);
});

test('중복 번호는 둘 다 보류한다 — 어느 쪽이 진짜인지 도구가 정할 일이 아니다', () => {
  const parsed = parsePlanSlices(
    ['## 8단계', '', '- [ ] **1. 먼저** [병렬 가능]', '- [ ] **1. 나중** [병렬 가능]', '- [ ] **2. 멀쩡** [병렬 가능]'].join(String.fromCharCode(10))
  );
  const d = dispatchPlan({ slices: parsed.slices, workspaces: [], max: 3, allSlices: parsed.allSlices });
  const dup = d.filter((x) => x.slice.number === 1);
  assert.equal(dup.length, 2);
  for (const x of dup) {
    assert.equal(x.eligible, false);
    assert.ok(x.reason.includes('번호 1 중복'));
  }
  // 프로젝트 전체는 안 막는다
  assert.equal(d.find((x) => x.slice.number === 2).eligible, true);
});

// ---------- 슬라이스 42 — 공유 자원 예약과 전역 동시 상한 ----------
const heldOf = (name, project, slice, workspace = 'C:/w/' + project + '/slice' + slice) => ({ [name]: { name, project, slice, workspace, since: 1 } });

test('남이 쥔 자원을 쓰는 슬라이스는 보류된다 — 프로젝트를 넘어 배타', () => {
  const p = dispatchPlan({
    slices: [s(1, ['parallel', 'resources'], { resources: ['폰'] }), s(2, ['parallel'])],
    workspaces: [],
    max: 3,
    project: 'SP-sync',
    held: heldOf('폰', 'project-b', 25),
  });
  const by = byNo(p);
  assert.equal(by[1].eligible, false);
  assert.equal(by[1].reason, '자원 점유: 폰 — project-b slice25');
  assert.equal(by[2].eligible, true); // 자원을 안 쓰는 슬라이스는 그대로 간다
});

test('자기 예약(같은 프로젝트·슬라이스)은 자기를 안 막는다', () => {
  const p = dispatchPlan({
    slices: [s(1, ['parallel', 'resources'], { resources: ['폰'] })],
    workspaces: [],
    max: 3,
    project: 'SP-sync',
    held: heldOf('폰', 'SP-sync', 1),
  });
  assert.equal(p[0].eligible, true);
});

test('자원 이름은 normTitle 로 접어 비교한다 — 공백·대소문자가 달라도 같은 것', () => {
  const p = dispatchPlan({
    slices: [s(1, ['parallel', 'resources'], { resources: ['Pixel 9'] })],
    workspaces: [],
    max: 3,
    project: 'SP-sync',
    held: { pixel9: { name: 'Pixel 9', project: 'G', slice: 25, workspace: 'C:/w/g', since: 1 } },
  });
  assert.equal(p[0].eligible, false);
  assert.match(p[0].reason, /자원 점유: Pixel 9 — G slice25/);
});

test('전역 상한을 넘지 않는다 — 다른 프로젝트가 이미 자리를 다 썼으면 보류', () => {
  const p = dispatchPlan({ slices: [s(1, ['parallel'])], workspaces: [], max: 3, total: 4, maxTotal: 4 });
  assert.equal(p[0].eligible, false);
  assert.equal(p[0].reason, '전역 상한 4 (현재 4)');
});

test('전역 상한은 이번 회차에 띄운 것도 센다', () => {
  const p = dispatchPlan({ slices: [s(1, ['parallel']), s(2, ['parallel'])], workspaces: [], max: 3, total: 3, maxTotal: 4 });
  assert.equal(p[0].eligible, true);
  assert.equal(p[1].eligible, false);
  assert.equal(p[1].reason, '전역 상한 4 (현재 4)');
});

test('프로젝트별 상한이 먼저다 — 둘 다 찼으면 "동시 상한" 으로 적는다', () => {
  const p = dispatchPlan({ slices: [s(1, ['parallel'])], workspaces: [ws('slice8', 8), ws('slice9', 9)], max: 2, total: 4, maxTotal: 4 });
  assert.match(p[0].reason, /동시 상한 2개/);
});

test('전역 상한은 재파견을 안 막는다 — 있는 창에 지시만 보내지 워크스페이스를 안 만든다', () => {
  const stalled = { ...ws('slice1', 1), stalled: { stalled: true, why: '지시 미전송' } };
  const p = dispatchPlan({
    slices: [s(1, ['parallel'], { workspace: stalled, resources: ['폰'] })],
    workspaces: [stalled],
    max: 3,
    total: 9,
    maxTotal: 4,
    project: 'SP-sync',
    held: heldOf('폰', 'project-b', 25),
  });
  assert.equal(p[0].eligible, true);
  assert.match(p[0].reason, /재파견/);
});

test('maxTotal 이 없으면(0·미지정) 전역 상한을 안 건다', () => {
  assert.equal(dispatchPlan({ slices: [s(1, ['parallel'])], workspaces: [], max: 3, total: 99 })[0].eligible, true);
  assert.equal(dispatchPlan({ slices: [s(1, ['parallel'])], workspaces: [], max: 3, total: 99, maxTotal: 0 })[0].eligible, true);
});

test('renderDispatch 가 전역 활성 수와 점유 자원을 낸다', () => {
  const out = renderDispatch({
    project: 'P',
    phase: { title: '9단계' },
    active: 1,
    max: 3,
    maxTotal: 4,
    totalActive: 3,
    held: [{ name: '폰', project: 'project-b', slice: 25, since: Date.now() }],
    decisions: [],
    dispatched: [],
  });
  assert.match(out, /활성 1 · 상한 3 · 전역 3\/4/);
  assert.match(out, /점유 자원 — 폰 — project-b slice25/);
});

test('같은 계획의 두 슬라이스가 같은 자원을 쓰면 둘째가 보류된다 — 판정 안에서 예약이 자란다', () => {
  // 실제 예약(`reserve`)은 워크스페이스가 생긴 뒤라, 판정이 자기 안에서 자라지 않으면 둘 다 뜬다.
  const p = byNo(
    dispatchPlan({
      slices: [s(1, ['parallel', 'resources'], { resources: ['실측'] }), s(2, ['parallel', 'resources'], { resources: ['실측'] })],
      workspaces: [],
      max: 3,
      project: 'SP-sync',
    })
  );
  assert.equal(p[1].eligible, true);
  assert.equal(p[2].eligible, false);
  assert.equal(p[2].reason, '자원 점유: 실측 — SP-sync slice1');
});
