/**
 * tasks-render — `tasks` 의 표 그리기. 판정은 하지 않는다.
 *
 * `tasks.mjs` 가 600줄을 넘어 갈라낸 것이라, 경계는 **"사람이 볼 글자를 만드는가"** 하나다.
 * 수집(`collectTasks`)·판정(`reviewVerdict`·`driftVerdict`·`todayVerdict`)은 저쪽에 남고,
 * 여기 함수들은 그쪽이 낸 결과 객체 하나를 받아 문자열을 낸다 — 그래서 SP·git·설정을 안 읽는다.
 * 의존은 한 방향이다: `common ← tasks ← tasks-render`.
 *
 * 표 셋(회수·표류·편성)은 **머리줄 → 표 → `!` 오류줄 → id 목록 → `--apply` 줄** 이라는 같은
 * 뼈대를 쓴다. 그 뼈대를 `table`·`errorLines`·`idLines` 셋으로 두어, 칸 채우는 규칙 하나를
 * 고칠 때 세 곳을 따라다니지 않게 했다. 표마다 다른 것은 열 정의·정렬·머리줄 문구뿐이다.
 *
 * 공통 규칙 둘:
 *   - **id 는 칸에 넣지 않고 표 밑에 따로 적는다.** `--apply` 에 그대로 붙일 수 있어야 하는데
 *     21자를 표에 넣으면 정작 읽어야 할 근거가 잘린다.
 *   - **상대 시간을 쓰지 않는다** (`mdy`). 표를 파일에 붙여 두면 "어제" 가 거짓말이 된다.
 */
import { fitCell } from './common.mjs';
import { mdy } from './tasks.mjs';

/** 열 정의(`[머리글, 너비, 값]`)로 머리줄·구분선·본문을 낸다. 오른쪽 여백은 잘라낸다. */
function table(cols, rows) {
  const line = (cells) => cells.map(([v, w]) => fitCell(v, w)).join('  ').replace(/\s+$/, '');
  const L = [line(cols.map(([h, w]) => [h, w])), cols.map(([, w]) => '-'.repeat(w)).join('  ')];
  for (const t of rows) L.push(line(cols.map(([, w, f]) => [f(t), w])));
  return L;
}

/**
 * 수집이 남긴 `error`(SP 에 같은 이름 프로젝트가 없음 등)를 표 밑에 `!` 줄로.
 * 조용히 빼면 "왜 안 뜨지" 가 되므로 세 표가 다 붙인다. 없으면 빈 줄도 안 낸다.
 */
function errorLines(projects) {
  const bad = projects.filter((p) => p.error);
  return bad.length ? ['', ...bad.map((p) => '  ! ' + p.project + ' — ' + p.error)] : [];
}

/** `--apply` 에 그대로 붙일 id 목록. 회수·편성이 같은 모양을 쓴다. */
function idLines(head, rows) {
  return [head, ...rows.map((t) => '  ' + t.id + '  ' + t.project + ' — ' + t.title)];
}

/** 표 안의 날짜. 시각이 없으면 `?` — 해시를 못 찾은 커밋이 그렇다. */
function mdy2(ms) {
  return ms ? mdy(ms) : '?';
}

const COLS = [
  ['', 4, (t) => (t.suggest ? ' ✓' : '')],
  ['프로젝트', 19, (t) => t.project],
  ['태스크', 30, (t) => t.title],
  ['마감', 9, (t) => t.when],
  ['마지막 귀속 커밋', 22, (t) => (t.last ? mdy2(t.last.at) + ' ' + t.last.hash.slice(0, 7) : '')],
  ['근거', 46, (t) => t.reason],
];

/** 완료 회수 표. 제안이 위로 오고 그 안에서는 오래 조용한 것이 위 — 회수할 것을 먼저 보라는 순서다. */
function renderTasksReview(r) {
  const rows = r.projects.flatMap((p) => p.tasks.map((t) => ({ project: p.project, ...t })));
  rows.sort((a, b) => Number(b.suggest) - Number(a.suggest) || (b.quietDays ?? -1) - (a.quietDays ?? -1) || a.project.localeCompare(b.project));
  const L = [
    '완료 회수 — 미완 ' + r.open + '개 · 제안 ' + r.suggested.length + '개 · 조용 기준 ' + r.staleDays + '일',
    '',
    ...table(COLS, rows),
    ...errorLines(r.projects),
    '',
  ];
  if (!r.suggested.length) {
    L.push('완료를 제안할 태스크 없음.');
    return L.join('\n') + '\n';
  }
  L.push(...idLines('제안 ' + r.suggested.length + '개 (id 는 --apply 에 그대로 붙인다):', r.suggested));
  L.push('');
  L.push('완료 처리: node sp-sync.mjs tasks review --apply ' + r.suggested.map((t) => t.id).join(' '));
  L.push('(--apply 없이는 SP 에 아무것도 쓰지 않는다. 하위 목록·마감일은 --apply 도 건드리지 않는다.)');
  return L.join('\n') + '\n';
}

const DRIFT_COLS = [
  ['', 4, (t) => (t.drift ? ' ✓' : '')],
  ['프로젝트', 19, (t) => t.project],
  ['태스크', 30, (t) => t.title],
  ['만든 날', 8, (t) => mdy2(t.created)],
  ['마지막 활동', 12, (t) => mdy2(t.lastActAt)],
  ['방치', 6, (t) => (t.idleDays === null ? '?' : t.idleDays + '일')],
  ['하위', 5, (t) => (t.subsOpen ? t.subsOpen + '개' : '')],
  ['근거', 42, (t) => t.reason],
];

/**
 * 표류 표. 오래 방치된 것이 위다. `--apply` 가 없다 — 표류의 처방은 마감일이고, 그건 사용자가
 * SP 에서 잡거나(아직) 끝난 것이면 `tasks review --apply` 로 회수한다.
 */
function renderTasksDrift(r) {
  const rows = r.candidates.slice().sort((a, b) => (b.idleDays ?? -1) - (a.idleDays ?? -1) || a.project.localeCompare(b.project));
  const ex = Object.entries(r.excluded).map(([k, n]) => k + ' ' + n);
  const L = [
    '표류 — 마감 없는 후보 ' + rows.length + '개 · 표류 ' + r.drifting.length + '개 · 방치 기준 ' + r.driftDays + '일' +
      (ex.length ? ' (제외: ' + ex.join(' · ') + ')' : ''),
    '',
    ...table(DRIFT_COLS, rows),
    ...errorLines(r.projects),
    '',
  ];
  if (!r.drifting.length) {
    L.push('표류로 볼 태스크 없음.');
    return L.join('\n') + '\n';
  }
  L.push(...idLines('표류 ' + r.drifting.length + '개:', r.drifting));
  L.push('');
  L.push('처방은 마감일이다 — SP 앱에서 잡거나, 이미 끝난 것이면 tasks review --apply 로 회수한다.');
  L.push('(이 표는 SP 에 아무것도 쓰지 않는다.)');
  return L.join('\n') + '\n';
}

const TODAY_COLS = [
  ['순위', 5, (t) => String(t.rank)],
  ['프로젝트', 19, (t) => t.project],
  ['태스크', 32, (t) => t.title],
  ['마감', 11, (t) => t.due || ''],
  ['하위', 5, (t) => (t.subsOpen ? t.subsOpen + '개' : '')],
  ['근거', 26, (t) => t.reason],
];

/**
 * 오늘 편성 표. 뽑힌 것만 세운다 — 후보 전부를 세우면 "오늘 할 다섯"이 그 안에 묻힌다.
 * 회수·표류와 반대다: 저 둘은 "왜 안 올랐나"까지가 재료지만, 편성은 다섯 줄을 보고 바로
 * 시작하라는 표다. 빠진 것은 머리줄에 수로만, "이미 오늘"은 표 밑에 줄로만 남긴다.
 */
function renderTasksToday(r) {
  const ex = Object.entries(r.excluded)
    .filter(([k]) => k !== '이미 오늘' && k !== '워커 진행 중')
    .map(([k, n]) => k + ' ' + n);
  const L = [
    '오늘 편성 — 후보 ' +
      r.candidates.length +
      '개 · 제안 ' +
      r.picked.length +
      '개 (최대 ' +
      r.max +
      ') · 오늘 ' +
      r.today +
      (r.already.length ? ' · 이미 오늘 ' + r.already.length + '개' : '') +
      (r.workers ? ' · 워커 진행 중 ' + r.workers + '개' : '') +
      (ex.length ? ' (제외: ' + ex.join(' · ') + ')' : ''),
    '',
    ...table(TODAY_COLS, r.picked),
  ];
  if (r.already.length) {
    L.push('');
    L.push('이미 오늘 ' + r.already.length + '개 (제안 수에 안 센다):');
    for (const t of r.already) L.push('  ' + t.project + ' — ' + t.title);
  }
  L.push(...errorLines(r.projects));
  L.push('');
  if (!r.picked.length) {
    L.push('오늘 편성을 제안할 태스크 없음.');
    return L.join('\n') + '\n';
  }
  L.push(...idLines('제안 ' + r.picked.length + '개 (id 는 --apply 에 그대로 붙인다):', r.picked));
  L.push('');
  // 그대로 붙여 넣으면 도는 줄이다. 일부만 잡으려면 위 목록에서 id 를 골라 지운다.
  L.push('마감일을 오늘로: node sp-sync.mjs tasks today --apply ' + r.picked.map((t) => t.id).join(' '));
  return L.join('\n') + '\n';
}

/** 세 표를 순서대로. 사이는 빈 줄 하나 — 표마다 제 머리줄과 `--apply` 줄을 이미 달고 나온다. */
function renderTasksAgenda(r) {
  return [renderTasksReview(r.review), renderTasksDrift(r.drift), renderTasksToday(r.today)].join('\n');
}

/** `--apply` 의 결과. 쓴 것·실패·건너뜀을 한 줄씩 — 회수(완료)와 편성(마감일)이 같은 모양이다. */
function renderApply(r) {
  const L = [];
  const ok = r.due ? '✓ 마감 ' + r.due + ' ' : '✓ 완료 ';
  for (const t of r.done) L.push((r.dryRun ? '· (dry-run) ' : ok) + t.title + '  ' + t.id);
  for (const t of r.failed) L.push('✗ 실패 ' + t.title + '  ' + t.id + ' — ' + t.error);
  for (const s of r.skip) L.push('- 건너뜀 ' + s.value + ' — ' + s.why);
  if (!L.length) L.push('적용할 것이 없다.');
  return L.join('\n') + '\n';
}

export { renderApply, renderTasksAgenda, renderTasksDrift, renderTasksReview, renderTasksToday };
