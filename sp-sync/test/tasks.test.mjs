// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewVerdict, driftVerdict, todayVerdict, pickToday, workerTaskIds, daysBetween, noteCommits, applyTargets, applyValues, renderTasksReview, renderTasksDrift, renderTasksToday, renderTasksAgenda, tasksAgenda, tasksReview, tasksDrift, tasksToday } from '../sp-sync.mjs';

const DAY = 86400000;
const now = new Date(2026, 8, 1, 16, 0).getTime(); // 2026-09-01 16:00 로컬
const ago = (d) => now - d * DAY;

test('제안 — 커밋이 오래 조용하고 하위가 없으면 근거와 함께 오른다', () => {
  const v = reviewVerdict({ lastAt: ago(9), sessionAt: null }, { now, staleDays: 7 });
  assert.equal(v.suggest, true);
  assert.equal(v.quietDays, 9);
  assert.match(v.reason, /커밋 8\/23/);
  assert.match(v.reason, /세션 기록 없음/);
  assert.match(v.reason, /9일 조용/);
});

test('막는 조건이 먼저다 — 하위 미완·귀속 커밋 없음은 아무리 조용해도 제안하지 않는다', () => {
  const subs = reviewVerdict({ subsOpen: 3, lastAt: ago(30), sessionAt: null }, { now, staleDays: 7 });
  assert.equal(subs.suggest, false);
  assert.match(subs.reason, /하위 3개 미완/);

  const none = reviewVerdict({ subsOpen: 0, lastAt: null, sessionAt: ago(30) }, { now, staleDays: 7 });
  assert.equal(none.suggest, false);
  assert.match(none.reason, /귀속 커밋 없음/);
});

test('조용 기간은 커밋과 세션 중 나중 것부터 센다 — 커밋 뒤 세션이 있으면 아직 진행 중', () => {
  const v = reviewVerdict({ lastAt: ago(9), sessionAt: ago(1) }, { now, staleDays: 7 });
  assert.equal(v.suggest, false);
  assert.equal(v.quietDays, 1);
  assert.match(v.reason, /세션 8\/31/);
});

test('PLAN 단계가 끝났으면 조용 기준을 하루로 내린다 (당일 체크는 제외)', () => {
  const done = reviewVerdict({ lastAt: ago(2), sessionAt: null, phaseDone: true }, { now, staleDays: 7 });
  assert.equal(done.suggest, true);
  assert.match(done.reason, /PLAN 단계 끝/);

  const today = reviewVerdict({ lastAt: ago(0), sessionAt: null, phaseDone: true }, { now, staleDays: 7 });
  assert.equal(today.suggest, false);
});

test('notes 에서 커밋 줄만 캐낸다 — 작업 항목·날짜 줄은 커밋이 아니다', () => {
  const notes = ['- 1a066b1 락 안에서만 고친다', '- 5c2eb72 (slice2) 모듈로 쪼갠다', '- ☑ 테스트 통과', '- 2026-08-30 회의', '메모'].join('\n');
  const c = noteCommits(notes);
  assert.deepEqual(
    c.map((x) => [x.hash, x.branch]),
    [
      ['1a066b1', ''],
      ['5c2eb72', 'slice2'],
    ]
  );
  assert.equal(c[1].subject, '모듈로 쪼갠다');
});

const tasks = [
  { id: 'aaa', title: '완료 회수', isDone: false },
  { id: 'bbb', title: '이미 끝난 것', isDone: true },
  { id: 'ccc', title: '하위 항목', isDone: false, parentId: 'aaa' },
  { id: 'ddd', title: '같은 제목', isDone: false },
  { id: 'eee', title: '같은  제목', isDone: false },
];

test('--apply 는 id·제목을 받고, 하위·이미 완료·모호한 제목은 건드리지 않는다', () => {
  const r = applyTargets(tasks, ['aaa', 'bbb', 'ccc', '같은 제목', '없는 것', '아무거나']);
  assert.deepEqual(r.apply.map((t) => t.id), ['aaa']);
  assert.deepEqual(
    r.skip.map((s) => [s.value, s.why]),
    [
      ['bbb', '이미 완료'],
      ['ccc', '하위 태스크 — 손대지 않는다'],
      ['같은 제목', '제목이 2개에 걸림 — id 로 지정한다'],
      ['없는 것', '못 찾음'],
      ['아무거나', '못 찾음'],
    ]
  );
});

// 오늘 편성 쪽(`--due`)에서만 더 막는 둘 — 반복 태스크와 이미 그 날짜인 것.
const dueTasks = [
  { id: 'n1', title: '오늘로 당길 것', isDone: false, dueDay: '2026-08-30' },
  { id: 'n2', title: '마감 없는 것', isDone: false },
  { id: 'n3', title: '반복하는 것', isDone: false, repeatCfgId: 'rc1' },
  { id: 'n4', title: '이미 오늘인 것', isDone: false, dueDay: '2026-09-01' },
  { id: 'n5', title: '끝난 것', isDone: true },
];

test('today --apply 는 반복·이미 오늘을 건너뛴다', () => {
  const r = applyTargets(dueTasks, ['n1', 'n2', 'n3', 'n4', 'n5'], { due: '2026-09-01' });
  assert.deepEqual(r.apply.map((t) => t.id), ['n1', 'n2']);
  assert.deepEqual(
    r.skip.map((s) => [s.value, s.why]),
    [
      ['n3', '반복 태스크 — SP 가 주기로 되살린다'],
      ['n4', '이미 2026-09-01'],
      ['n5', '이미 완료'],
    ]
  );
});

test('review --apply 는 반복·마감일을 그대로 지나간다 (due 없음)', () => {
  const r = applyTargets(dueTasks, ['n1', 'n3', 'n4'], {});
  assert.deepEqual(r.apply.map((t) => t.id), ['n1', 'n3', 'n4']);
  assert.deepEqual(r.skip, []);
  // 인자를 아예 안 준 옛 호출도 그대로다
  assert.deepEqual(applyTargets(dueTasks, ['n3']).apply.map((t) => t.id), ['n3']);
});

test('today --apply 도 기존 넷은 그대로 막는다', () => {
  const r = applyTargets(tasks, ['ccc', 'bbb', '같은 제목', '없는 것', 'aaa', 'aaa'], { due: '2026-09-01' });
  assert.deepEqual(r.apply.map((t) => t.id), ['aaa']);
  assert.deepEqual(r.skip.map((s) => s.why), [
    '하위 태스크 — 손대지 않는다',
    '이미 완료',
    '제목이 2개에 걸림 — id 로 지정한다',
    '못 찾음',
    '중복 지정',
  ]);
});

test('--apply 는 값을 잇는 것과 플래그를 반복하는 것 둘 다 받는다', () => {
  assert.deepEqual(applyValues(['review', '--apply', 'a', 'b', '--json']), ['a', 'b']);
  assert.deepEqual(applyValues(['review', '--apply', 'a', '--apply', 'b']), ['a', 'b']);
  assert.deepEqual(applyValues(['review', '--json']), []);
});

const review = {
  at: now,
  staleDays: 7,
  open: 2,
  projects: [
    {
      project: 'SP-sync',
      root: 'C:\\x',
      plan: { title: '3단계', open: 6, done: 2 },
      phaseDone: false,
      error: null,
      tasks: [
        { id: 'keep1', title: '진행 중인 것', when: '예정', suggest: false, quietDays: 0, reason: '커밋 9/1 · 0일 조용', last: { hash: '5c2eb72abc', at: now } },
        { id: 'oldTaskId0000000000', title: '오래된 것', when: '마감없음', suggest: true, quietDays: 9, reason: '커밋 8/23 · 세션 기록 없음 · 9일 조용', last: { hash: '4079020def', at: ago(9) } },
      ],
    },
    { project: 'project-c', root: 'C:\\y', plan: null, tasks: [], error: 'SP 에 같은 이름 프로젝트가 없음' },
  ],
  suggested: [{ project: 'SP-sync', id: 'oldTaskId0000000000', title: '오래된 것', reason: '커밋 8/23 · 세션 기록 없음 · 9일 조용' }],
};

test('표 — 제안이 위에 오고 근거·id·적용 명령이 같이 뜬다', () => {
  const s = renderTasksReview(review);
  const lines = s.split('\n');
  const iSug = lines.findIndex((l) => l.includes('오래된 것'));
  const iKeep = lines.findIndex((l) => l.includes('진행 중인 것'));
  assert.ok(iSug > 0 && iSug < iKeep, '제안이 표 위쪽에 온다');
  assert.match(lines[iSug], /✓/);
  assert.doesNotMatch(lines[iKeep], /✓/);
  assert.match(s, /8\/23 4079020/); // 마지막 귀속 커밋 칸
  assert.match(s, /세션 기록 없음/); // 근거 칸
  assert.match(s, /oldTaskId0000000000/); // 붙여 넣을 id 는 표 밑에
  assert.match(s, /--apply oldTaskId0000000000/);
  assert.match(s, /! project-c — SP 에 같은 이름 프로젝트가 없음/);
});

test('표 — 제안이 없으면 적용 명령을 아예 안 낸다', () => {
  const none = { ...review, suggested: [], projects: [{ ...review.projects[0], tasks: [review.projects[0].tasks[0]] }] };
  const s = renderTasksReview(none);
  assert.match(s, /완료를 제안할 태스크 없음/);
  assert.doesNotMatch(s, /--apply/);
});

// --- 표류 (tasks drift) ---------------------------------------------------
// 판정 재료는 `collectTasks` 가 주는 태스크 한 줄이다. 여기서는 그 모양만 흉내 낸다.
const drifted = { created: ago(40), modified: ago(20) };

test('표류 — 마감 없이 오래 방치되면 오른다. 마지막 활동은 셋 중 나중 것이다', () => {
  const v = driftVerdict(drifted, { now, driftDays: 14 });
  assert.equal(v.drift, true);
  assert.equal(v.excluded, null);
  assert.equal(v.idleDays, 20);
  assert.equal(v.lastActAt, ago(20));
  assert.match(v.reason, /수정 8\/12/);
  assert.doesNotMatch(v.reason, /방치/); // 방치 일수는 표에 제 칸이 있다

  const later = driftVerdict({ ...drifted, lastAt: ago(3), sessionAt: ago(1) }, { now, driftDays: 14 });
  assert.equal(later.drift, false);
  assert.equal(later.idleDays, 1);
  assert.match(later.reason, /수정 8\/12 · 커밋 8\/29 · 세션 8\/31/);
});

test('표류 — modified 가 없으면 created 로 센다', () => {
  const v = driftVerdict({ created: ago(30) }, { now, driftDays: 14 });
  assert.equal(v.drift, true);
  assert.equal(v.idleDays, 30);
  assert.match(v.reason, /생성 8\/2/);

  const none = driftVerdict({}, { now, driftDays: 14 });
  assert.equal(none.drift, false);
  assert.equal(none.idleDays, null);
  assert.match(none.reason, /활동 기록 없음/);
});

test('표류 — 범주로 빠지는 셋은 아무리 방치돼도 후보가 아니다', () => {
  const due = driftVerdict({ ...drifted, due: '2026-09-30' }, { now, driftDays: 14 });
  assert.equal(due.drift, false);
  assert.equal(due.excluded, '마감 있음');
  assert.match(due.reason, /마감 2026-09-30/);

  const rep = driftVerdict({ ...drifted, repeat: true }, { now, driftDays: 14 });
  assert.equal(rep.excluded, '반복');

  const sug = driftVerdict({ ...drifted, suggest: true }, { now, driftDays: 14 });
  assert.equal(sug.excluded, '완료 제안');
  assert.match(sug.reason, /회수가 먼저다/);
});

test('표류 — 기간이 안 찼으면 후보로는 남되 표류는 아니다', () => {
  const v = driftVerdict({ created: ago(40), modified: ago(13) }, { now, driftDays: 14 });
  assert.equal(v.drift, false);
  assert.equal(v.excluded, null); // 표에는 오른다 — 견줄 수 있는 줄이다
  assert.equal(v.idleDays, 13);
});

test('표류 — 하위가 남은 계획 태스크도 후보다 (회수와 반대다)', () => {
  const v = driftVerdict({ ...drifted, subsOpen: 7 }, { now, driftDays: 14 });
  assert.equal(v.drift, true);
  assert.equal(reviewVerdict({ subsOpen: 7, lastAt: ago(20) }, { now, staleDays: 7 }).suggest, false);
});

const drift = {
  at: now,
  driftDays: 14,
  excluded: { '마감 있음': 2, 반복: 1 },
  projects: [
    { project: 'Project X', error: null, tasks: [] },
    { project: 'project-c', error: 'SP 에 같은 이름 프로젝트가 없음', tasks: [] },
  ],
  candidates: [
    { project: 'Project X', id: 'freshTaskId00000000', title: '최근 것', created: ago(30), lastActAt: ago(2), idleDays: 2, subsOpen: 0, drift: false, excluded: null, reason: '수정 8/30' },
    { project: 'Project X', id: 'driftTaskId00000000', title: '방치된 것', created: ago(40), lastActAt: ago(25), idleDays: 25, subsOpen: 6, drift: true, excluded: null, reason: '수정 8/7' },
  ],
  drifting: [{ project: 'Project X', id: 'driftTaskId00000000', title: '방치된 것' }],
};

test('표류 표 — 오래 방치된 것이 위, 제외는 머리줄에 수로만, id 는 표 밑에', () => {
  const s = renderTasksDrift(drift);
  const lines = s.split('\n');
  const iDrift = lines.findIndex((l) => l.includes('방치된 것'));
  const iFresh = lines.findIndex((l) => l.includes('최근 것'));
  assert.ok(iDrift > 0 && iDrift < iFresh, '방치가 오래된 것이 위에 온다');
  assert.match(lines[iDrift], /✓/);
  assert.doesNotMatch(lines[iFresh], /✓/);
  assert.match(lines[iDrift], /25일/);
  assert.match(lines[iDrift], /6개/); // 하위 미완 수
  assert.match(s, /후보 2개 · 표류 1개 · 방치 기준 14일 \(제외: 마감 있음 2 · 반복 1\)/);
  assert.match(s, /driftTaskId00000000/);
  assert.match(s, /! project-c — SP 에 같은 이름 프로젝트가 없음/);
  // 표류의 처방은 마감일이지 완료가 아니다 — 자체 --apply 는 없고, 회수 쪽으로 넘기는 줄만 있다.
  assert.doesNotMatch(s, /drift --apply/);
  assert.match(s, /처방은 마감일이다/);
});

test('표류 표 — 표류가 없으면 id 목록을 아예 안 낸다', () => {
  const s = renderTasksDrift({ ...drift, candidates: [drift.candidates[0]], drifting: [] });
  assert.match(s, /표류로 볼 태스크 없음/);
  assert.doesNotMatch(s, /freshTaskId00000000/);
});

// --- 오늘 편성 (tasks today) ----------------------------------------------
// 판정 재료는 `collectTasks` 가 주는 태스크 한 줄 + 그 프로젝트의 PLAN 미체크 수다.
const todayDay = '2026-09-01'; // 위 `now` 와 같은 날
const dayOpts = { today: todayDay };

test('오늘 편성 — 순위 넷: 지남 · 세션 · PLAN 미체크 계획 태스크 · 표류', () => {
  const over = todayVerdict({ due: '2026-08-25' }, dayOpts);
  assert.equal(over.rank, 1);
  assert.match(over.reason, /지남 7일/);

  const sess = todayVerdict({ sessionAt: ago(2) }, dayOpts);
  assert.equal(sess.rank, 2);
  assert.match(sess.reason, /세션 8\/30/);

  const plan = todayVerdict({ planOpen: 3, subsOpen: 2 }, dayOpts);
  assert.equal(plan.rank, 3);
  assert.match(plan.reason, /PLAN 미체크 3/);

  const drift = todayVerdict({ drift: true, idleDays: 21 }, dayOpts);
  assert.equal(drift.rank, 4);
  assert.match(drift.reason, /표류 21일/);

  // 아무 데도 안 걸리면 후보가 아니다 — 빠진 것이 아니라 그냥 안 오른다.
  const nothing = todayVerdict({ due: '2026-09-30' }, dayOpts);
  assert.equal(nothing.rank, null);
  assert.equal(nothing.excluded, null);
});

test('오늘 편성 — 미체크가 남아도 하위 없는 태스크는 계획 태스크가 아니다', () => {
  assert.equal(todayVerdict({ planOpen: 3, subsOpen: 0 }, dayOpts).rank, null);
  assert.equal(todayVerdict({ planOpen: 0, subsOpen: 4 }, dayOpts).rank, null);
});

test('오늘 편성 — 제외 넷은 순위보다 먼저다. 워커 진행 중은 (2)·(3) 을 이긴다', () => {
  const sug = todayVerdict({ due: '2026-08-25', suggest: true }, dayOpts);
  assert.equal(sug.rank, null);
  assert.equal(sug.excluded, '완료 제안');

  const rep = todayVerdict({ due: '2026-08-25', repeat: true }, dayOpts);
  assert.equal(rep.excluded, '반복');

  // 세션도 붙어 있고 계획 태스크이기도 하지만, 워커가 돌리고 있으면 사람 오늘 할 일이 아니다.
  const wk = todayVerdict({ worker: true, sessionAt: ago(1), planOpen: 4, subsOpen: 3 }, dayOpts);
  assert.equal(wk.rank, null);
  assert.equal(wk.excluded, '워커 진행 중');

  const already = todayVerdict({ due: todayDay, sessionAt: ago(1) }, dayOpts);
  assert.equal(already.rank, null);
  assert.equal(already.excluded, '이미 오늘');
  assert.match(already.reason, /마감 오늘/);
});

test('오늘 편성 — 워커 판정은 sliceN 워크스페이스이면서 폴더가 아직 있는 것뿐이다', () => {
  const sessions = {
    s1: { taskId: 'live', worktree: 'C:\\orca\\workspaces\\P\\slice30' },
    s2: { taskId: 'landed', worktree: 'C:\\orca\\workspaces\\P\\slice7' }, // 착륙이 지운 폴더
    s3: { taskId: 'main', worktree: 'C:\\orca\\projects\\P' }, // 본체 세션은 워커가 아니다
    s4: { taskId: null, worktree: 'C:\\orca\\workspaces\\P\\slice31' }, // 태스크가 아직 없는 세션
  };
  const ids = workerTaskIds(sessions, { exists: (p) => !p.endsWith('slice7') });
  assert.deepEqual([...ids], ['live']);
});

test('뽑기 — 순위가 먼저, 같은 순위 안에서는 프로젝트를 돌아가며', () => {
  const row = (project, rank, order, title) => ({ project, rank, order, title });
  const rows = [
    row('Project Y', 1, -20, 'v1'),
    row('Project Y', 1, -10, 'v2'),
    row('Project Y', 1, -5, 'v3'),
    row('SP-sync', 1, -8, 's1'),
    row('AI Study', 2, -3, 'a1'),
  ];
  const p = pickToday(rows, 5);
  assert.deepEqual(p.map((t) => t.title), ['v1', 's1', 'v2', 'v3', 'a1']);

  // 잘려도 순위는 지킨다 — 2순위는 1순위가 다 오른 뒤에만 자리를 얻는다.
  assert.deepEqual(pickToday(rows, 3).map((t) => t.title), ['v1', 's1', 'v2']);
  assert.deepEqual(pickToday(rows, 0), []);
});

const today = {
  at: now,
  today: todayDay,
  max: 5,
  open: 9,
  driftDays: 14,
  staleDays: 7,
  workers: 2,
  excluded: { '워커 진행 중': 2, '완료 제안': 1, '이미 오늘': 1 },
  projects: [
    { project: 'Project Y', error: null, tasks: [] },
    { project: 'project-c', error: 'SP 에 같은 이름 프로젝트가 없음', tasks: [] },
  ],
  candidates: [],
  picked: [
    { project: 'Project Y', id: 'overdueTaskId000000', title: '지난 것', rank: 1, due: '2026-08-25', subsOpen: 0, reason: '지남 7일' },
    { project: 'SP-sync', id: 'planTaskId000000000', title: '계획 태스크', rank: 3, due: null, subsOpen: 4, reason: 'PLAN 미체크 3' },
  ],
  already: [{ project: 'AI Study', id: 'todayTaskId00000000', title: '오늘 것', due: todayDay }],
};

test('오늘 편성 표 — 뽑힌 것만 세우고, 이미 오늘·워커는 세지 않고 따로 알린다', () => {
  const s = renderTasksToday(today);
  const lines = s.split('\n');
  assert.match(lines[0], /제안 2개 \(최대 5\)/);
  assert.match(lines[0], /이미 오늘 1개/);
  assert.match(lines[0], /워커 진행 중 2개/);
  assert.match(lines[0], /제외: 완료 제안 1/); // 이미 오늘·워커는 앞에서 말했으므로 제외 목록에 또 안 쓴다
  const iOver = lines.findIndex((l) => l.includes('지난 것'));
  assert.ok(iOver > 0);
  assert.match(lines[iOver], /지남 7일/);
  assert.match(lines[iOver], /2026-08-25/);
  assert.match(s, /이미 오늘 1개 \(제안 수에 안 센다\):/);
  assert.match(s, /AI Study — 오늘 것/);
  assert.doesNotMatch(lines[iOver], /todayTaskId/); // "이미 오늘" 은 표에 안 선다
  assert.match(s, /planTaskId000000000/); // 붙여 넣을 id 는 표 밑에
  assert.match(s, /tasks today --apply overdueTaskId000000 planTaskId000000000/);
  assert.doesNotMatch(s, /다음 슬라이스|아직 안 붙었다/); // 슬라이스 31 부터 그대로 붙여 넣으면 도는 줄이다
  assert.match(s, /! project-c — SP 에 같은 이름 프로젝트가 없음/);
});

test('오늘 편성 표 — 제안이 없으면 id 목록도 적용 명령도 안 낸다', () => {
  const s = renderTasksToday({ ...today, picked: [], already: [], workers: 0, excluded: {} });
  assert.match(s, /오늘 편성을 제안할 태스크 없음/);
  assert.doesNotMatch(s, /--apply/);
});

test('날짜 차이 — 마감 문자열은 SP 가 주는 대로라 못 읽으면 null 이다', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-08'), 7);
  assert.equal(daysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(daysBetween('2026-09-01', '2026-09-01'), 0);
  assert.equal(daysBetween('', '2026-09-01'), null);
  assert.equal(daysBetween('2026-09-01T00:00:00Z', '2026-09-01'), null);
});

// agenda 는 표를 새로 만들지 않는다 — 같은 재료면 개별 명령과 같은 제안이 나와야 한다.
// 수집은 `collected` 로 주입한다 (SP·git 을 안 부른다).
const collected = () => ({
  at: now,
  today: todayDay,
  sessions: {},
  all: [],
  byId: new Map(),
  projects: [
    {
      project: 'Project Y',
      root: 'C:\\x\\Project Y',
      projectId: 'v1',
      plan: { open: 3 },
      phaseDone: false,
      error: null,
      tasks: [
        // 회수 제안 — 커밋이 오래 조용하고 하위가 없다
        { id: 'reviewTaskId0000000', title: '끝난 것', due: null, when: '마감없음', subsOpen: 0, commits: 1, last: { hash: 'abc1234', subject: 's', at: ago(20), found: true }, sessionAt: null, worker: false, created: ago(40), modified: null, repeat: false },
        // 오늘 편성 1순위 — 마감 지남
        { id: 'overdueTaskId000000', title: '지난 것', due: '2026-08-25', when: '지남', subsOpen: 0, commits: 0, last: null, sessionAt: null, worker: false, created: ago(30), modified: null, repeat: false },
      ],
    },
    {
      project: 'SP-sync',
      root: 'C:\\x\\SP-sync',
      projectId: 's1',
      plan: { open: 2 },
      phaseDone: false,
      error: null,
      tasks: [
        // 표류 — 마감도 커밋도 없고 오래 방치. 편성에서는 4순위(계획 태스크가 아니다)
        { id: 'driftTaskId00000000', title: '잊힌 것', due: null, when: '마감없음', subsOpen: 0, commits: 0, last: null, sessionAt: null, worker: false, created: ago(30), modified: null, repeat: false },
      ],
    },
  ],
});

test('agenda — 세 표가 개별 명령과 같은 제안을 낸다 (수집은 한 번)', async () => {
  const o = { collected: collected(), staleDays: 7, driftDays: 14, max: 5 };
  const ids = (arr) => arr.map((t) => t.id);

  const a = await tasksAgenda(null, o);
  const review = await tasksReview(null, { ...o, collected: collected() });
  const drift = await tasksDrift(null, { ...o, collected: collected() });
  const today = await tasksToday(null, { ...o, collected: collected() });

  assert.deepEqual(ids(a.review.suggested), ids(review.suggested));
  assert.deepEqual(ids(a.drift.drifting), ids(drift.drifting));
  assert.deepEqual(ids(a.today.picked), ids(today.picked));

  // 재료가 실제로 세 판정을 다 태웠는지 — 빈 표 셋이 같은 것으로 통과하지 않게
  assert.deepEqual(ids(a.review.suggested), ['reviewTaskId0000000']);
  assert.deepEqual(ids(a.drift.drifting), ['driftTaskId00000000']);
  assert.deepEqual(ids(a.today.picked), ['overdueTaskId000000', 'driftTaskId00000000']);
  assert.equal(a.day, todayDay);
});

test('agenda 표 — 세 표가 순서대로, 각 표의 --apply 줄은 제 것 그대로', async () => {
  const s = renderTasksAgenda(await tasksAgenda(null, { collected: collected(), staleDays: 7, driftDays: 14, max: 5 }));
  const iReview = s.indexOf('완료 회수 —');
  const iDrift = s.indexOf('표류 —');
  const iToday = s.indexOf('오늘 편성 —');
  assert.ok(iReview >= 0 && iReview < iDrift && iDrift < iToday);
  assert.match(s, /tasks review --apply reviewTaskId0000000/);
  assert.match(s, /tasks today --apply overdueTaskId000000 driftTaskId00000000/);
  assert.doesNotMatch(s, /tasks agenda --apply/); // agenda 에는 쓰는 길이 없다
});
