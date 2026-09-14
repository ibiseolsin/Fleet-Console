// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fleetPrecheck, precheckVerdict, precheckText, seenFileFor, saveSeen, cycleChildEnv, noteInReport, decisionItems, RECOVERY_FAILED_TYPES } from '../sp-sync.mjs';
import { spawnCycle } from '../lib/fleet.mjs';

const AT = new Date(2026, 8, 9, 10, 0).getTime();

/** 결정 항목 하나짜리 회차 결과. `decisions` 는 회차가 `decisionItems` 로 실어 두는 것과 같은 꼴이다. */
const cycle = (projects) => ({ at: AT, dryRun: false, projects: projects.map((p) => ({ ...p, decisions: decisionItems({ projects: [p] }) })) });
const waitP = (name = 'P', slice = 9, text = '이걸 할지') => ({ project: name, land: { landed: [], checks: [{ name: 'slice' + slice, slice, waiting: text }] } });
const seenOf = (v) => v.byProject; // 이번 결과가 다음 회차의 seenBy

test('새 키 1개 → 0 (깨움)', () => {
  const v = precheckVerdict(cycle([waitP()]), {});
  assert.equal(v.code, 0);
  assert.equal(v.wake, true);
  assert.deepEqual(v.fresh.map((i) => i.key), ['wait:P:9']);
  assert.deepEqual(v.resolved, []);
  assert.equal(v.byProject.P.keys['wait:P:9'].since, AT);
});

test('같은 키 반복 → 1. 사유 문장이 바뀌어도 키가 같으면 미해결 그대로(since 유지)', () => {
  const first = precheckVerdict(cycle([waitP()]), {});
  const again = precheckVerdict({ ...cycle([waitP('P', 9, '새 카드의 다른 문구')]), at: AT + 1 }, seenOf(first));
  assert.equal(again.code, 1);
  assert.deepEqual(again.fresh, []);
  assert.equal(again.byProject.P.keys['wait:P:9'].since, AT, '처음 나타난 시각을 이어받는다');
  assert.equal(again.byProject.P.keys['wait:P:9'].reason, '새 카드의 다른 문구', '문구는 최신으로');
});

test('해소만 → 1, 해소 목록에 남는다', () => {
  const first = precheckVerdict(cycle([waitP()]), {});
  const v = precheckVerdict(cycle([{ project: 'P', land: { landed: [], checks: [] } }]), seenOf(first));
  assert.equal(v.code, 1);
  assert.deepEqual(v.resolved.map((r) => r.key), ['wait:P:9']);
  assert.deepEqual(v.byProject.P.keys, {}, '다음 집합은 비어 있다');
});

test('착륙·파견 성공만 → 1 (보고만 쓰고 모델 호출 0)', () => {
  const v = precheckVerdict(
    cycle([{ project: 'P', land: { landed: [{ name: 'slice8', ok: true, pr: 13 }], checks: [] }, dispatch: { dispatched: [{ name: 'slice10', ok: true, text: '/slice 10' }], decisions: [] } }]),
    {}
  );
  assert.equal(v.code, 1);
  assert.equal(v.landed, 1);
  assert.equal(v.dispatched, 1);
});

test('dispatch-failed → 0, 같은 키가 이어져도 매번 0 (자동 회복 실패)', () => {
  const failed = { project: 'P', dispatch: { dispatched: [{ name: 'slice10', slice: 10, ok: false, stage: 'create', detail: 'orca 오류', text: '/slice 10' }], decisions: [] } };
  const first = precheckVerdict(cycle([failed]), {});
  assert.equal(first.code, 0);
  assert.equal(first.dispatched, 0, '실패는 파견 수에 안 든다');
  const again = precheckVerdict(cycle([failed]), seenOf(first));
  assert.equal(again.code, 0, '같은 키라도 회복 실패는 깨운다');
  assert.deepEqual(again.fresh, []);
  assert.deepEqual(again.failed.map((i) => i.key), ['dispatch-failed:P:10']);
});

test('회복 실패 유형 — 착륙 실패·충돌·본체 갈라짐도 반복돼도 0', () => {
  assert.deepEqual([...RECOVERY_FAILED_TYPES].sort(), ['conflict', 'dispatch-failed', 'land-failed', 'sync-diverged']);
  const landFail = { project: 'P', land: { landed: [{ name: 'slice8', slice: 8, ok: false, stage: 'push' }], checks: [] } };
  const first = precheckVerdict(cycle([landFail]), {});
  assert.equal(precheckVerdict(cycle([landFail]), seenOf(first)).code, 0);
  const diverged = { project: 'P', sync: { block: '본체 갈라짐 — 사용자가 풀어야', commits: [] }, error: '본체 갈라짐', syncBlocked: true };
  const d1 = precheckVerdict(cycle([diverged]), {});
  assert.equal(precheckVerdict(cycle([diverged]), seenOf(d1)).code, 0);
});

test('즉시 종료한 헤드리스 워커는 파견 성공에 안 세고 막힘으로 깨운다', () => {
  const v = precheckVerdict(cycle([{ project: 'P', dispatch: { dispatched: [{ name: 'slice10', slice: 10, ok: true, outcome: 'exited', submit: '래퍼 즉시 종료', text: 'worker' }], decisions: [] } }]), {});
  assert.equal(v.dispatched, 0);
  assert.equal(v.code, 0);
});

test('인계 성공·인계 대기는 새로 생겨도 안 깨우고, 막힘은 처음 한 번은 깨운다', () => {
  const handoff = { project: 'P', handoff: { rows: [{ name: 'slice5', slice: 5, from: 'claude', to: 'codex', action: 'handoff' }, { name: 'slice6', slice: 6, from: 'claude', action: 'wait', waitMin: 30 }] } };
  const v = precheckVerdict(cycle([handoff]), {});
  assert.equal(v.code, 1, '회차가 스스로 한 일');
  assert.equal(Object.keys(v.byProject.P.keys).length, 2, '집합에는 남는다');
  const blocked = { project: 'P', land: { landed: [], checks: [{ name: 'slice7', slice: 7, blocked: true, reason: '유휴인데 7번이 미체크 — 막힘' }] } };
  const b1 = precheckVerdict(cycle([blocked]), {});
  assert.equal(b1.code, 0, '막힘이 처음 생기면 알린다');
  assert.equal(precheckVerdict(cycle([blocked]), seenOf(b1)).code, 1, '같은 막힘이 이어지면 안 알린다');
});

test('결정 표에 오르는 상황은 전부 최초 1회 통지된다 (coordinator 점검 #3 표)', () => {
  const cases = [
    { project: 'P', dispatch: { dispatched: [], decisions: [], phaseDone: true, active: 0, phase: { title: '8단계' } } },
    { project: 'P', dispatch: { dispatched: [], decisions: [], planSyntax: '중복 번호 3' } },
    { project: 'P', dispatch: { dispatched: [], decisions: [{ number: 4, title: '넷', eligible: false, reason: '한도 임박 — 40% 남음' }] } },
    { project: 'P', dispatch: { dispatched: [], decisions: [], planBlock: 'PLAN.md 미커밋 변경' } },
    { project: 'P', dispatch: { dispatched: [], decisions: [{ number: 5, title: '다섯', eligible: false, reason: '모르는 에이전트: gemini' }] } },
  ];
  for (const p of cases) {
    const v = precheckVerdict(cycle([p]), {});
    assert.equal(v.code, 0, JSON.stringify(p.dispatch));
    assert.equal(precheckVerdict(cycle([p]), seenOf(v)).code, 1, '반복은 통지 안 함 ' + JSON.stringify(p.dispatch));
  }
});

test('다른 회차가 도는 중이라 건너뛴 프로젝트는 지난 집합을 건드리지 않는다', () => {
  const first = precheckVerdict(cycle([waitP('P'), waitP('Q', 3)]), {});
  const v = precheckVerdict({ at: AT + 1, projects: [{ project: 'P', cycleRunning: '프로젝트별 회차가 도는 중' }, { ...cycle([waitP('Q', 3)]).projects[0] }] }, seenOf(first));
  assert.equal(v.code, 1);
  assert.equal(v.byProject.P, undefined, 'P 는 이번 결과에 없다 — 파일도 안 바뀐다');
  assert.deepEqual(v.resolved, [], 'P 의 항목이 해소로 잘못 읽히지 않는다');
});

test('저절로 풀리는 파견 보류(동시 상한·선행 미완)는 항목이 아니라 안 깨운다', () => {
  const v = precheckVerdict(cycle([{ project: 'P', dispatch: { dispatched: [], decisions: [{ number: 4, title: '넷', eligible: false, reason: '선행 미완: 3번' }, { number: 5, title: '다섯', eligible: false, reason: '동시 상한 3' }] } }]), {});
  assert.equal(v.code, 1);
});

test('판정 한 줄 — 깨움 사유·해소·보고 경로', () => {
  const first = precheckVerdict(cycle([waitP('P'), waitP('Q', 3)]), {});
  const line = precheckText(first, { projects: ['P', 'Q'], paused: ['R'], report: 'runs/x.md' });
  assert.match(line, /^프로젝트 P, Q \(일시 제외 R\) · 착륙 0 · 파견 0 · 깨움 — 새 2\(P slice9 \(워커 대기\), Q slice3 \(워커 대기\)\) · 보고 runs\/x\.md$/);
  const v = precheckVerdict(cycle([{ project: 'P' }, { project: 'Q' }]), seenOf(first));
  assert.match(precheckText(v, { projects: ['P', 'Q'] }), /안 깨움 — 새 결정 없음 · 해소 2\(/);
});

test('지난 집합 파일은 프로젝트별이고 유니코드 이름을 보존한다', () => {
  assert.notEqual(seenFileFor('가계부', '/d'), seenFileFor('자격증', '/d'));
  assert.equal(seenFileFor('Project X', '/d'), join('/d', 'fleet-seen.Project_X.json'));
});

test('원자 갱신 — 같은 폴더의 pid 임시 파일에 쓰고 rename, 임시 파일은 안 남는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-seen-'));
  try {
    const file = join(dir, 'sub', 'fleet-seen.P.json');
    const order = [];
    const io = {
      mkdirSync: (p, o) => (order.push('mkdir'), mkdirSync(p, o)),
      writeFileSync: (p, d, e) => (order.push('write ' + p), writeFileSync(p, d, e)),
      renameSync: (a, b) => {
        order.push('rename ' + a + ' → ' + b);
        assert.equal(dirname(a), dirname(b), '임시 파일은 목적 파일과 같은 폴더');
        return renameSync(a, b);
      },
    };
    const { tmp } = saveSeen(file, { keys: { a: 1 } }, io);
    assert.equal(tmp, file + '.' + process.pid + '.tmp');
    assert.deepEqual(order, ['mkdir', 'write ' + tmp, 'rename ' + tmp + ' → ' + file]);
    assert.equal(existsSync(tmp), false);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { keys: { a: 1 } });
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['fleet-seen.P.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('회차 자식 환경 — HOME·USERPROFILE 을 채우고 ssh 설정이 있으면 GIT_SSH_COMMAND', () => {
  const e = cycleChildEnv({ PATH: 'x' }, 'C:\\Users\\me', { sshExe: 'C:/Git/ssh.exe', exists: () => true });
  assert.equal(e.HOME, 'C:\\Users\\me');
  assert.equal(e.USERPROFILE, 'C:\\Users\\me');
  assert.equal(e.GIT_SSH_COMMAND, '"C:/Git/ssh.exe" -F "C:/Users/me/.ssh/config"');
  assert.equal(cycleChildEnv({ GIT_SSH_COMMAND: 'mine' }, '/h', { exists: () => true }).GIT_SSH_COMMAND, 'mine', '이미 있으면 안 덮는다');
  assert.equal(cycleChildEnv({}, '/h', { exists: () => false }).GIT_SSH_COMMAND, undefined);
});

test('보고의 마지막 절 안에 통지 줄을 끼운다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-report-'));
  try {
    const f = join(dir, 'x.md');
    writeFileSync(f, '## 회차 1\n\n표\n---\n\n## 회차 2\n\n표2\n---\n\n', 'utf8');
    assert.equal(noteInReport(f, '통지 — 안 깨움'), true);
    assert.equal(readFileSync(f, 'utf8'), '## 회차 1\n\n표\n---\n\n## 회차 2\n\n표2\n\n통지 — 안 깨움\n---\n\n');
    assert.equal(noteInReport(join(dir, 'none.md'), 'x'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 회차 대신 가짜 결과를 주는 `fleetPrecheck` 한 바퀴 — 프로젝트 선택·지난 집합 파일·종료 코드가 이어지는지. */
test('fleet precheck — 프로젝트 선택(일시 제외만 뺌, 대소문자 무시)과 지난 집합 파일', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-precheck-'));
  try {
    const calls = [];
    const fake = (result) => async (o) => (calls.push(o), result);
    const base = { projects: ['coordinator', 'Demo', 'Paused'], pause: ['paused'], seenDir: dir };
    // 1) 새 대기 하나 → 0, 파일이 생긴다
    let r = await fleetPrecheck({ projects: ['demo', 'Nope'], quiet: true, deps: { ...base, spawnCycle: fake(cycle([waitP('Demo')])) } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.projects, ['Demo']);
    assert.deepEqual(r.missing, ['Nope']);
    assert.deepEqual(calls[0].projects, ['Demo']);
    assert.equal(calls[0].dryRun, false);
    assert.match(calls[0].files.done, /fleet-cycle-result\.Demo\.json$/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(seenFileFor('Demo', dir), 'utf8')).keys), ['wait:Demo:9']);
    // 2) 같은 결과 → 1
    r = await fleetPrecheck({ projects: ['Demo'], quiet: true, deps: { ...base, spawnCycle: fake(cycle([waitP('Demo')])) } });
    assert.equal(r.code, 1);
    assert.match(r.text, /안 깨움/);
    // 3) dry-run 은 지난 집합을 안 쓴다 — 해소된 결과를 줘도 파일이 그대로
    r = await fleetPrecheck({ projects: ['Demo'], dryRun: true, quiet: true, deps: { ...base, spawnCycle: fake(cycle([{ project: 'Demo' }])) } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.verdict.resolved, ['wait:Demo:9']);
    assert.equal(calls[2].dryRun, true);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(seenFileFor('Demo', dir), 'utf8')).keys), ['wait:Demo:9'], 'dry-run 뒤에도 파일은 그대로');
    // 4) 이름 없이 — 일시 제외만 뺀 전부, 전역 결과 파일. **파견 제외(coordinator)는 목록에 남는다**
    // (슬라이스 41): 회차가 그 프로젝트를 동기화만 하고 지나가므로, 여기서 지우면 매시 안전망
    // 회차가 coordinator 본체를 영영 안 올린다.
    r = await fleetPrecheck({ quiet: true, deps: { ...base, spawnCycle: fake(cycle([{ project: 'Demo' }])) } });
    assert.deepEqual(r.projects, ['coordinator', 'Demo']);
    assert.deepEqual(r.paused, ['Paused']);
    assert.match(calls[3].files.done, /fleet-cycle-result\.json$/);
    assert.equal(r.code, 1, '해소만');
    // 5) 회차가 죽거나 안 끝나면 0
    r = await fleetPrecheck({ projects: ['Demo'], quiet: true, deps: { ...base, spawnCycle: async () => { throw new Error('boom'); } } });
    assert.equal(r.code, 0);
    assert.match(r.text, /fleet cycle 실패: boom/);
    r = await fleetPrecheck({ projects: ['Demo'], quiet: true, deps: { ...base, spawnCycle: async () => null } });
    assert.equal(r.code, 0);
    assert.match(r.text, /540초 안에 안 끝남/);
    // 6) 돌릴 게 없으면 1 — 일시 제외 프로젝트만 지목한 경우
    r = await fleetPrecheck({ projects: ['Paused'], quiet: true, deps: { ...base, spawnCycle: async () => assert.fail('회차를 띄우면 안 된다') } });
    assert.equal(r.code, 1);
    assert.match(r.text, /돌릴 프로젝트가 없음/);
    // 7) 파견 제외 프로젝트를 지목하면 회차는 돈다 (그 안에서 동기화만) — 결정 0 이라 안 깨운다
    r = await fleetPrecheck({ projects: ['coordinator'], quiet: true, deps: { ...base, spawnCycle: fake(cycle([{ project: 'coordinator', syncOnly: true }])) } });
    assert.deepEqual(r.projects, ['coordinator']);
    assert.equal(r.code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 진짜 자식을 띄운다 — 회차 대신 인자를 JSON 으로 되돌리는 가짜 sp-sync.mjs. `.part` → `.json` 순서와 dry-run 의 무접촉을 본다. */
test('spawnCycle — 자식 stdout 을 .part 에 쓰고 끝나면 .json 으로, dry-run 은 둘 다 안 건드린다, 상한을 넘기면 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spsync-spawn-'));
  try {
    const self = join(dir, 'fake.mjs');
    writeFileSync(self, "const a = process.argv.slice(2); if (a.includes('--slow')) await new Promise((r) => setTimeout(r, 1500)); console.log(JSON.stringify({ at: 1, projects: [], argv: a }));", 'utf8');
    const files = { part: join(dir, 'r.json.part'), done: join(dir, 'r.json') };
    writeFileSync(files.done, 'old', 'utf8');
    const out = await spawnCycle({ projects: ['A', 'B'], dryRun: false, files, self, env: process.env });
    assert.deepEqual(out.argv, ['fleet', 'cycle', '--json', '--write', '--project', 'A', '--project', 'B']);
    assert.equal(JSON.parse(readFileSync(files.done, 'utf8')).at, 1, '옛 .json 을 지우고 새로 쓴다');
    assert.equal(readFileSync(files.part, 'utf8'), readFileSync(files.done, 'utf8'));
    const partAt = statSync(files.part).mtimeMs;
    const doneAt = statSync(files.done).mtimeMs;
    const dry = await spawnCycle({ projects: ['A'], dryRun: true, files, self, env: process.env });
    assert.deepEqual(dry.argv, ['fleet', 'cycle', '--json', '--dry-run', '--project', 'A']);
    assert.equal(statSync(files.part).mtimeMs, partAt, 'dry-run 은 .part 를 안 건드린다');
    assert.equal(statSync(files.done).mtimeMs, doneAt, 'dry-run 은 .json 을 안 건드린다');
    const slow = await spawnCycle({ projects: ['--slow'], dryRun: true, files, self, env: process.env, waitMs: 300 });
    assert.equal(slow, null, '상한을 넘기면 진행 중');
  } finally {
    await new Promise((r) => setTimeout(r, 1700)); // 느린 자식이 폴더를 놓을 때까지
    rmSync(dir, { recursive: true, force: true });
  }
});
