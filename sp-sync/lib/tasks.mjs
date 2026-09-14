/**
 * tasks — SP 일정 정리. 프로젝트별 미완 태스크에 **근거**를 붙여 표를 낸다.
 *
 *   `tasks review` — 완료 회수. 커밋 기록상 끝난 것 같은 태스크에 완료를 제안한다.
 *   `tasks drift`  — 표류 감지. 마감을 안 잡아 둔 채 오래 방치된 태스크를 들춘다.
 *   `tasks today`  — 오늘 편성. 오늘 할 것 후보를 순위대로 몇 개만 골라 낸다.
 *
 * 셋은 **재료를 공유한다**(`collectTasks`) — SP 조회와 git 조회를 표마다 되풀이하지 않는다.
 * 수집은 판정을 모르고, 판정(`reviewVerdict`·`driftVerdict`·`todayVerdict`)은 순수 함수다.
 * 판정 셋은 **한 줄로 얹힌다**: 회수 → 표류(회수의 `suggest` 를 쓴다) → 편성(둘의
 * `suggest`·`drift` 를 쓴다). 그래서 `tasksToday` 는 `tasksDrift` 위에 선다.
 *
 * **표 그리기는 이 파일에 없다** — `tasks-render.mjs` 로 나가 있다(`common ← tasks ← tasks-render`).
 * 여기는 재료와 판정까지고, 사람이 볼 글자를 만드는 것은 저쪽이다.
 *
 * 완료 회수의 근거 셋 (PLAN.md 3단계 슬라이스 6):
 *   1. 마지막 귀속 커밋 — 태스크 notes 에 훅이 쌓아 둔 `- <해시> <제목>` 줄. 해시를 그 프로젝트
 *      본체에서 조회해 **시각**을 얻는다. notes 는 SP 에 남으므로 세션 기록(7일)보다 오래 간다.
 *   2. 세션 기록이 남아 있는가 — `state.json` 에서 그 taskId 에 붙은 세션의 마지막 활동.
 *      계획은 "그 뒤 세션 유무" 였지만 그건 뜻이 없다 — 커밋을 낸 세션이 곧 notes 를 쓰므로
 *      그 세션의 활동은 늘 커밋보다 나중이라 거의 모든 태스크에 붙는다. 뜻이 있는 것은 기록이
 *      **아직 남아 있는가**(7일 뒤 지워진다)뿐이라, 조용 기간은 커밋과 세션 중 나중 것부터 센다.
 *   3. PLAN.md 단계 종료 — 그 프로젝트 본체 계획의 현재 단계에 미체크가 0인가.
 *
 * 표류의 근거는 `driftVerdict` 주석에 있다.
 *
 * **기본은 읽기 전용이다.** SP 로 가는 요청은 `GET /projects`·`GET /tasks` 뿐이고,
 * 쓰기는 `--apply <id>…` 를 명시했을 때만, 그 태스크에만, 키 하나로 일어난다 (`tasksApply`):
 * `review --apply` 는 `{isDone:true}`, `today --apply` 는 `{dueDay:<오늘>}`.
 * 하위 목록·notes·태그는 어떤 경로로도 건드리지 않는다 — 사용자가 설계한 것이다
 * (`docs/tasks.md` "일정 관리": 자동 실행 없음, 승인 뒤 적용).
 *
 * 판정 자체는 하지 않는다. 사람이 볼 표를 만들 뿐이고, SP 를 고치는 것은 사용자의 `--apply` 다.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, api, clean, config, fitCell, log, normTitle, projectTitleFor, resolveProjectId, sliceNumberOf, state, todayStr } from './common.mjs';
import { parsePlanSlices } from './fleet.mjs';

const DAY = 86400000;
const DUE_LABEL = { today: '오늘', overdue: '지남', future: '예정', none: '마감없음' };

/**
 * notes 에서 커밋 줄을 캐낸다. 훅이 쓰는 모양은 `- <해시> <제목>` 이고, 기본 브랜치가 아니면
 * `- <해시> (<브랜치>) <제목>` 이다. 완료 작업 항목(`- ☑ …`)과 사람이 손으로 적은 줄은 빠진다.
 *
 * 해시는 7자 이상 40자 이하 16진수 — `- 2026-08-30 회의` 같은 줄이 걸리지 않게 **줄 전체**가
 * 그 모양으로 시작하는지 본다. 오래된 것이 앞이다 (훅이 push 순서로 덧붙인다).
 */
function noteCommits(notes) {
  const out = [];
  for (const l of String(notes || '').split(/\r?\n/)) {
    const m = /^- ([0-9a-f]{7,40})\s+(?:\(([^)]+)\)\s+)?(.*)$/.exec(l.trim());
    if (m) out.push({ hash: m[1], branch: m[2] || '', subject: m[3] || '' });
  }
  return out;
}

/** 던지지 않는 git. 커밋 하나를 못 찾는 것이 표 전체를 죽이면 안 된다. */
function gitTry(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

/**
 * notes 의 커밋 중 **그 저장소에서 실제로 찾아지는 마지막 것**. 뒤에서부터 본다.
 *
 * 뒤 몇 개가 안 찾아질 수 있다: 워크스페이스에서 낸 커밋이 rebase 로 해시가 바뀌었거나, 그
 * 워크스페이스가 머지 없이 지워졌을 때다. 그때 "근거 없음"으로 떨어뜨리면 활발한 태스크가
 * 조용한 것으로 보인다. 본체는 워크트리와 객체 저장소를 공유하므로 머지 전 커밋도 찾아진다.
 */
function lastCommitOf(root, commits, limit = 5) {
  const list = commits.slice(-limit).reverse();
  for (const c of list) {
    const t = gitTry(['show', '-s', '--format=%ct', c.hash], root);
    if (/^\d+$/.test(t)) return { ...c, at: Number(t) * 1000, found: true };
  }
  const last = commits[commits.length - 1];
  return last ? { ...last, at: null, found: false } : null;
}

/**
 * 완료 제안 판정. 근거를 받아 제안 여부와 그 사유 한 줄을 낸다. 순수 함수다 — 규칙이 바뀌면
 * 여기만 본다. **막는 조건이 먼저다**: 하위가 남아 있거나 근거가 없으면 아무리 조용해도 제안하지 않는다.
 */
function reviewVerdict(ev, opts = {}) {
  const now = opts.now || Date.now();
  const staleDays = opts.staleDays ?? config().tasksStaleDays;
  const { subsOpen = 0, lastAt = null, lastFound = true, sessionAt = null, phaseDone = false } = ev;
  const bits = [];
  if (lastAt) {
    bits.push('커밋 ' + mdy(lastAt));
    if (!lastFound) bits.push('해시 못 찾음');
  }
  // "그 뒤 세션" 이라고 쓰지 않는다 — 커밋을 낸 세션 자신이 notes 를 쓰므로 그 세션의 활동은
  // 늘 커밋보다 나중이다. 뜻이 있는 것은 **세션 기록이 남아 있는가**뿐이다(7일 지나면 지워진다).
  if (sessionAt) bits.push('세션 ' + mdy(sessionAt));
  else if (lastAt) bits.push('세션 기록 없음');

  if (subsOpen > 0) return { suggest: false, quietDays: null, reason: '하위 ' + subsOpen + '개 미완' + (bits.length ? ' · ' + bits.join(' · ') : '') };
  if (!lastAt) return { suggest: false, quietDays: null, reason: '귀속 커밋 없음 — 근거 없음' };

  const quiet = Math.floor((now - Math.max(lastAt, sessionAt || 0)) / DAY);
  bits.push(quiet + '일 조용');
  if (phaseDone) bits.push('PLAN 단계 끝');
  // 단계가 끝난 프로젝트는 조용 기간을 안 본다 — 계획이 "여기까지" 라고 말하는 것이
  // 시간보다 강한 근거다. 그래도 하루는 둔다 (방금 체크한 슬라이스로 표가 시끄러워지지 않게).
  const need = phaseDone ? 1 : staleDays;
  if (quiet < need) return { suggest: false, quietDays: quiet, reason: bits.join(' · ') };
  return { suggest: true, quietDays: quiet, reason: bits.join(' · ') };
}

/** 8/30 · 어제 것도 날짜로 — 표에서 상대 시간은 파일에 박제되면 거짓말이 된다(status.md 와 같은 이유). */
function mdy(ms) {
  const d = new Date(ms);
  return d.getMonth() + 1 + '/' + d.getDate();
}

/** `~/orca/projects` 의 프로젝트 폴더들. 후보 파일이 생기는 것과 같은 집합이다. */
function orcaProjectRoots(dir = join(HOME, 'orca', 'projects')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => join(dir, d.name));
}

/** 본체 PLAN.md 의 현재 단계. 파일이 없거나 체크박스가 없으면 null — 근거로 쓰지 않는다. */
function planPhaseOf(root) {
  try {
    const p = parsePlanSlices(readFileSync(join(root, 'PLAN.md'), 'utf8'));
    if (!p.phase || !p.slices.length) return null;
    const open = p.slices.filter((s) => !s.done).length;
    return { title: p.phase.title, open, done: p.slices.length - open };
  } catch {
    return null;
  }
}

/** 그 태스크에 붙은 세션들의 마지막 활동 시각. 세션 기록은 7일이라 그보다 오래된 태스크는 null 이다. */
function sessionActivity(sessions, taskId) {
  let at = 0;
  for (const e of Object.values(sessions)) {
    if (e?.taskId !== taskId) continue;
    at = Math.max(at, e.seenAt || 0, e.turnEndedAt || 0, e.startedAt || 0);
  }
  return at || null;
}

/**
 * **지금 워커가 돌리는 중인** 태스크 id 들. 세션 기록의 `worktree` 가 `sliceN` 워크스페이스이고
 * 그 폴더가 **아직 디스크에 있는** 것뿐이다.
 *
 * 폴더 유무를 같이 보는 이유: 착륙이 `worktree rm` 으로 워크스페이스를 지운 뒤에도 세션 기록은
 * 7일 남는다(2026-09-08 실측: `sliceN` 기록 96개). 기록만 보면 지난 한 주에 워커가 한 번이라도
 * 붙은 태스크가 전부 "진행 중"이 돼 오늘 편성에서 통째로 빠진다.
 *
 * 폴더 확인을 주입할 수 있게 열어 둔다(`opts.exists`) — 테스트가 가짜 세션으로 판정만 보게.
 */
function workerTaskIds(sessions, opts = {}) {
  const exists = opts.exists || ((p) => existsSync(p));
  const out = new Set();
  for (const e of Object.values(sessions || {})) {
    if (!e?.taskId || !e.worktree) continue;
    if (sliceNumberOf(e.worktree) === null) continue;
    if (!exists(e.worktree)) continue;
    out.add(e.taskId);
  }
  return out;
}

/**
 * 표들이 같이 쓰는 재료 수집. **읽기만 한다** — SP 는 `GET` 둘, git 은 `show -s`, 나머지는 로컬 파일이다.
 *
 * 대상은 `~/orca/projects` 의 프로젝트(= 후보 파일이 생기는 집합)다. 이름을 주면 그 하나만.
 * SP 에 대응 프로젝트가 없는 폴더는 `error` 한 줄로 남기고 넘어간다 — 조용히 빼면 "왜 안 뜨지"가 된다.
 *
 * **판정은 하지 않는다.** 여기서 나온 재료 하나를 `reviewVerdict`·`driftVerdict` 가 각자 읽으므로
 * 표가 둘이어도 SP 조회(`GET /tasks` 한 번)와 태스크당 git 조회는 한 번뿐이다.
 */
async function collectTasks(arg, opts = {}) {
  const now = opts.now || Date.now();
  const want = String(arg || '').trim().toLowerCase();
  const roots = orcaProjectRoots().filter((r) => !want || projectTitleFor(r).toLowerCase() === want || r.toLowerCase().endsWith('\\' + want));
  if (want && !roots.length) throw new Error('프로젝트를 못 찾음: ' + arg);

  const all = await api('GET', '/tasks');
  const arr = Array.isArray(all) ? all : [];
  const byId = new Map(arr.map((t) => [t.id, t]));
  const today = todayStr();
  const sessions = state().sessions;
  const workers = workerTaskIds(sessions, opts);

  const projects = [];
  for (const root of roots) {
    const name = projectTitleFor(root);
    let projectId = null;
    try {
      projectId = await resolveProjectId(name);
    } catch (e) {
      projects.push({ project: name, root, plan: null, tasks: [], error: 'SP 조회 실패: ' + clean(e.message, 80) });
      continue;
    }
    if (!projectId) {
      projects.push({ project: name, root, plan: null, tasks: [], error: 'SP 에 같은 이름 프로젝트가 없음' });
      continue;
    }
    const plan = planPhaseOf(root);
    const phaseDone = !!plan && plan.open === 0;
    const tasks = arr
      .filter((t) => !t.isDone && !t.parentId && t.projectId === projectId)
      .map((t) => {
        const commits = noteCommits(t.notes);
        const last = lastCommitOf(root, commits);
        return {
          id: t.id,
          title: t.title,
          due: t.dueDay || null,
          when: DUE_LABEL[!t.dueDay ? 'none' : t.dueDay === today ? 'today' : t.dueDay < today ? 'overdue' : 'future'],
          subsOpen: (t.subTaskIds || []).map((i) => byId.get(i)).filter((x) => x && !x.isDone).length,
          commits: commits.length,
          last: last ? { hash: last.hash, subject: last.subject, at: last.at, found: last.found } : null,
          sessionAt: sessionActivity(sessions, t.id),
          // 지금 워커가 돌리는 중인가. 오늘 편성이 "사람 오늘 할 일" 에서 빼는 재료다 (`workerTaskIds`).
          worker: workers.has(t.id),
          // SP 가 주는 시각. `created` 는 전 태스크에 있고 `modified` 는 일부에만 있다 (2026-09-08 실측,
          // 미완 최상위 67개 중 61개). 훅의 notes 덧붙임도 `modified` 를 올려 커밋 근거와 겹치지만,
          // 어느 쪽이든 "활동" 이라 표류 판정에는 해가 없다.
          created: t.created || null,
          modified: t.modified || null,
          repeat: !!t.repeatCfgId,
        };
      });
    projects.push({ project: name, root, projectId, plan, phaseDone, tasks, error: null });
  }
  return { at: now, today, projects, all: arr, byId, sessions };
}

/**
 * 판정 하나를 프로젝트별 태스크에 씌운다. 판정 셋이 같은 모양으로 얹히는 자리다 —
 * `verdict(태스크, 프로젝트)` 가 낸 것을 태스크에 합쳐 넣는다.
 *
 * `error` 가 붙은 프로젝트는 **그대로 통과시킨다**. SP 에 대응 프로젝트가 없어 `tasks` 가 빈
 * 것이라 판정할 재료가 없고, 표는 그 줄을 `!` 로 따로 보인다.
 */
function withVerdicts(projects, verdict) {
  return projects.map((p) => (p.error ? p : { ...p, tasks: p.tasks.map((t) => ({ ...t, ...verdict(t, p) })) }));
}

/** 범주로 빠진 것을 사유별로 센다. 표 머리줄이 "(제외: 반복 3 · 완료 제안 5)" 로 보여 준다. */
function countExcluded(rows) {
  const out = {};
  for (const t of rows) if (t.excluded) out[t.excluded] = (out[t.excluded] || 0) + 1;
  return out;
}

/** 프로젝트별 태스크를 프로젝트 이름을 단 한 줄짜리 목록으로 편다. 표·집계가 같이 쓴다. */
function flatRows(projects) {
  return projects.flatMap((p) => (p.error ? [] : p.tasks.map((t) => ({ project: p.project, ...t }))));
}

/**
 * 완료 회수 표. 수집한 재료에 `reviewVerdict` 를 씌운 것뿐이다.
 * `opts.collected` 로 이미 수집한 것을 넘기면 SP 를 다시 부르지 않는다 (표 여럿을 한 번에 낼 때).
 */
async function tasksReview(arg, opts = {}) {
  const staleDays = opts.staleDays ?? config().tasksStaleDays;
  const base = opts.collected || (await collectTasks(arg, opts));
  const projects = withVerdicts(base.projects, (t, p) =>
    reviewVerdict(
      { subsOpen: t.subsOpen, lastAt: t.last?.at || null, lastFound: !!t.last?.found, sessionAt: t.sessionAt, phaseDone: p.phaseDone },
      { now: base.at, staleDays }
    )
  );
  const suggested = flatRows(projects).filter((t) => t.suggest);
  // `today` 를 그대로 물려준다 — 오늘 편성이 "마감이 이미 오늘인가"를 여기서 읽는다.
  // 다시 `todayStr()` 을 부르면 자정을 낀 한 바퀴에서 표마다 다른 날을 쓰게 된다.
  return { at: base.at, today: base.today, staleDays, projects, suggested, open: projects.reduce((n, p) => n + p.tasks.length, 0) };
}

/**
 * 표류 판정. 순수 함수다 — 규칙이 바뀌면 여기만 본다.
 *
 * 표류 = **마감을 안 잡아 둔 채 오래 아무 일도 없는 태스크**. 완료 회수와 묻는 것이 다르다 —
 * 회수는 "끝난 것 같다"(귀속 커밋이 있고 그 뒤로 조용하다), 표류는 "잊혔다"(마감도 활동도 없다).
 *
 * **범주로 빠지는 것 셋이 기간보다 먼저다.**
 *   - 마감 있음 — 표류의 정의가 "마감 없음" 이다. 마감이 있으면 SP 오늘 보기가 이미 들춘다.
 *   - 반복 태스크(`repeatCfgId`) — 마감이 없어도 SP 가 주기마다 되살리므로 방치가 아니다.
 *   - 완료 제안 대상 — **회수가 먼저다.** 같은 태스크가 두 표에 오르면 뭘 먼저 할지 헷갈린다.
 * 하위가 남은 계획 태스크는 **빼지 않는다** — 표류는 거기가 더 흔하다(하위만 쌓고 마감을 안 잡는다).
 *
 * 마지막 활동은 셋 중 **나중 것**이다: `modified`(없으면 `created`) · 마지막 귀속 커밋 · 세션 활동.
 * `created` 는 전 태스크에 있으므로 활동이 아예 없는 일은 없다 — 만든 뒤 손대지 않은 것도
 * "만든 날부터 방치" 로 센다. 그래도 `null` 갈래를 두는 것은 SP 가 그 칸을 안 줄 때를 위해서다.
 */
function driftVerdict(ev, opts = {}) {
  const now = opts.now || Date.now();
  const driftDays = opts.driftDays ?? config().tasksDriftDays;
  const { due = null, repeat = false, suggest = false, created = null, modified = null, lastAt = null, sessionAt = null } = ev;
  const touched = modified || created || null;
  const lastActAt = Math.max(touched || 0, lastAt || 0, sessionAt || 0) || null;
  const idleDays = lastActAt === null ? null : Math.floor((now - lastActAt) / DAY);

  const bits = [];
  if (touched) bits.push((modified ? '수정 ' : '생성 ') + mdy(touched));
  if (lastAt) bits.push('커밋 ' + mdy(lastAt));
  if (sessionAt) bits.push('세션 ' + mdy(sessionAt));
  const why = (head) => head + (bits.length ? ' · ' + bits.join(' · ') : '');
  const out = (drift, excluded, reason) => ({ drift, excluded, idleDays, lastActAt, reason });

  if (due) return out(false, '마감 있음', why('마감 ' + due));
  if (repeat) return out(false, '반복', why('반복 태스크'));
  if (suggest) return out(false, '완료 제안', why('완료 제안 대상 — 회수가 먼저다'));
  if (lastActAt === null) return out(false, null, '활동 기록 없음');
  // 방치 일수는 근거에 안 넣는다 — 표에 제 칸이 있고, 넣으면 그만큼 날짜 조각이 잘린다.
  return out(idleDays >= driftDays, null, bits.join(' · '));
}

/**
 * 표류 표. 완료 회수 판정을 재료로 쓰므로(`suggest`) `tasksReview` 위에 얹는다 —
 * `opts.review` 로 이미 낸 회수 결과를 넘기면 SP·git 을 다시 부르지 않는다.
 */
async function tasksDrift(arg, opts = {}) {
  const driftDays = opts.driftDays ?? config().tasksDriftDays;
  const r = opts.review || (await tasksReview(arg, opts));
  const projects = withVerdicts(r.projects, (t) =>
    driftVerdict(
      { due: t.due, repeat: t.repeat, suggest: t.suggest, created: t.created, modified: t.modified, lastAt: t.last?.at || null, sessionAt: t.sessionAt },
      { now: r.at, driftDays }
    )
  );
  const rows = flatRows(projects);
  // 표에 세우는 것은 **후보**(범주로 안 빠진 것)뿐이다. 마감 있음·반복·완료 제안까지 다 세우면
  // 방치 일수를 견줄 수 없는 줄이 표의 대부분이 된다 — 빠진 것은 머리줄에 수로만 남긴다.
  const candidates = rows.filter((t) => !t.excluded);
  return {
    at: r.at,
    today: r.today,
    driftDays,
    staleDays: r.staleDays,
    projects,
    candidates,
    drifting: candidates.filter((t) => t.drift),
    excluded: countExcluded(rows),
    open: r.open,
  };
}

/**
 * 오늘 편성 판정. 순수 함수다 — 규칙이 바뀌면 여기만 본다.
 *
 * 묻는 것이 앞의 둘과 다르다. 회수는 "끝난 것 같다", 표류는 "잊혔다", 편성은 **"오늘 이걸 해라"** 다.
 * 그래서 앞의 둘이 낸 판정(`suggest`·`drift`)을 재료로 쓴다.
 *
 * **범주로 빠지는 것이 순위보다 먼저다.**
 *   - 완료 제안 대상 — 회수가 먼저다(표류와 같은 이유). 끝난 것에 오늘 마감을 잡을 일이 없다.
 *   - 반복 태스크 — SP 가 주기마다 되살리므로 사람이 오늘로 당길 것이 아니다.
 *   - 워커 진행 중 — 워커가 이미 돌리고 있다. 사람의 오늘 할 일이 아니다(`workerTaskIds`).
 *     **이 제외가 순위 (2)·(3) 보다 먼저다** — 워커가 붙은 계획 태스크가 (3) 에 오르면
 *     (3) 은 "일이 도는 프로젝트"를 다시 보여 줄 뿐이다. 걸러내야 (3) 이 "미체크가 남았는데
 *     워커가 없는 프로젝트"(pause·결정 대기·선행 미완)를 사람에게 들추는 자리가 된다.
 *   - 이미 오늘 — 편성할 것이 남아 있지 않다. 표 밑에 줄로만 보이고 제안 수에는 안 센다.
 *
 * 순위 넷 (`rank`, 작을수록 먼저):
 *   1 마감 지남 · 2 세션 기록(7일)이 붙은 진행 중 · 3 미체크가 남은 프로젝트의 계획 태스크 · 4 표류
 * `order` 는 **같은 순위 안의** 정렬 키다(작을수록 위). 뽑기(`pickToday`)가 프로젝트를 섞기 전에 쓴다.
 */
function todayVerdict(ev, opts = {}) {
  const today = opts.today || todayStr();
  const { due = null, repeat = false, suggest = false, worker = false, sessionAt = null, planOpen = 0, subsOpen = 0, drift = false, idleDays = null } = ev;
  const out = (rank, order, reason, excluded = null) => ({ rank, order, reason, excluded });

  if (suggest) return out(null, 0, '완료 제안 대상 — 회수가 먼저다', '완료 제안');
  if (repeat) return out(null, 0, '반복 태스크', '반복');
  if (worker) return out(null, 0, '워커가 돌리는 중 — 사람 오늘 할 일이 아니다', '워커 진행 중');
  if (due && due === today) return out(null, 0, '마감 오늘', '이미 오늘');

  if (due && due < today) {
    const n = daysBetween(due, today);
    // 오래 지난 것이 위다 — 음수로 뒤집어 `order` 오름차순 하나로 정렬이 끝나게.
    return out(1, -(n ?? 0), '지남 ' + (n === null ? '?' : n) + '일');
  }
  if (sessionAt) return out(2, -sessionAt, '세션 ' + mdy(sessionAt));
  // 계획 태스크 = 하위가 남은 것. 그 프로젝트의 현재 단계에 미체크가 남아 있을 때만 오른다.
  if (planOpen > 0 && subsOpen > 0) return out(3, -planOpen, 'PLAN 미체크 ' + planOpen);
  if (drift) return out(4, -(idleDays ?? 0), '표류 ' + (idleDays === null ? '?' : idleDays) + '일');
  return out(null, 0, '오늘 할 근거 없음');
}

/** `2026-09-01` → `2026-09-08` 은 7. 못 읽으면 null — 마감 문자열은 SP 가 주는 대로다. */
function daysBetween(fromDay, toDay) {
  const p = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
  };
  const a = p(fromDay);
  const b = p(toDay);
  return a === null || b === null ? null : Math.round((b - a) / DAY);
}

/**
 * 순위대로, **같은 순위 안에서는 프로젝트를 돌아가며** `max` 개까지 뽑는다. 순수 함수다.
 *
 * 돌아가며 뽑는 이유: 한 프로젝트가 다섯 자리를 다 먹으면 나머지 프로젝트는 오늘 보이지 않는다
 * (2026-09-08 실측 — 한 프로젝트에 마감 지남이 7개다). 순위를 무시하지는 않는다 —
 * 1순위가 남아 있는 동안 2순위는 한 줄도 안 오르고, 각 프로젝트 안에서는 `order` 순 그대로다.
 * 프로젝트를 도는 차례는 그 순위에서 **가장 강한 줄을 낸 프로젝트**부터다(Map 삽입 순서).
 */
function pickToday(rows, max) {
  const picked = [];
  for (const rank of [1, 2, 3, 4]) {
    if (picked.length >= max) break;
    const inRank = rows
      .filter((r) => r.rank === rank)
      .sort((a, b) => a.order - b.order || String(a.project).localeCompare(String(b.project)) || String(a.title).localeCompare(String(b.title)));
    const queues = new Map();
    for (const r of inRank) {
      if (!queues.has(r.project)) queues.set(r.project, []);
      queues.get(r.project).push(r);
    }
    const qs = [...queues.values()];
    while (picked.length < max && qs.some((q) => q.length)) {
      for (const q of qs) {
        if (!q.length) continue;
        picked.push(q.shift());
        if (picked.length >= max) break;
      }
    }
  }
  return picked;
}

/**
 * 오늘 편성 표. 표류 판정을 재료로 쓰므로(`drift`) `tasksDrift` 위에 얹는다 —
 * `opts.drift` 로 이미 낸 표류 결과를 넘기면 SP·git 을 다시 부르지 않는다.
 */
async function tasksToday(arg, opts = {}) {
  const max = opts.max ?? config().tasksTodayMax;
  const d = opts.drift || (await tasksDrift(arg, opts));
  const projects = withVerdicts(d.projects, (t, p) =>
    todayVerdict(
      {
        due: t.due,
        repeat: t.repeat,
        suggest: t.suggest,
        worker: t.worker,
        sessionAt: t.sessionAt,
        planOpen: p.plan?.open || 0,
        subsOpen: t.subsOpen,
        drift: t.drift,
        idleDays: t.idleDays,
      },
      { today: d.today }
    )
  );
  const rows = flatRows(projects);
  const candidates = rows.filter((t) => t.rank);
  const excluded = countExcluded(rows);
  return {
    at: d.at,
    today: d.today,
    max,
    projects,
    candidates,
    picked: pickToday(candidates, max),
    already: rows.filter((t) => t.excluded === '이미 오늘'),
    workers: excluded['워커 진행 중'] || 0,
    excluded,
    open: d.open,
    driftDays: d.driftDays,
    staleDays: d.staleDays,
  };
}

/**
 * 세션 진입용 한 화면. 완료 회수 → 표류 → 오늘 편성 셋을 **한 번의 수집**으로 잇는다.
 *
 * 표 셋은 이미 서로 얹혀 있으므로(회수 → 표류 → 편성) 여기서 하는 일은 그 사슬을 한 번만
 * 태우고 셋을 다 들고 나오는 것뿐이다 — 개별 명령을 셋 다 치면 SP 조회가 세 번이고 git 조회도
 * 세 벌이다. **판정도 표도 새로 만들지 않는다**: 같은 재료면 개별 명령과 같은 제안이 나온다.
 *
 * 표 밑의 `--apply` 줄도 개별 명령 그대로다 — 회수는 `tasks review --apply`,
 * 편성은 `tasks today --apply`. 그래서 `tasks agenda --apply` 는 없다.
 */
async function tasksAgenda(arg, opts = {}) {
  const collected = opts.collected || (await collectTasks(arg, opts));
  const review = await tasksReview(arg, { ...opts, collected });
  const drift = await tasksDrift(arg, { ...opts, review });
  const today = await tasksToday(arg, { ...opts, drift });
  // `today` 는 편성 표이고 날짜는 `day` 다 — 표 안에서는 `today` 가 날짜라 이름이 겹친다.
  return { at: collected.at, day: collected.today, review, drift, today };
}

/**
 * 값을 받는 플래그. 이 뒤의 한 칸은 값이라 위치 인자(프로젝트 이름)가 아니다 —
 * 안 걸러내면 `tasks review --days 3` 의 `3` 이 프로젝트 이름으로 읽힌다.
 * **값 플래그를 새로 만들면 여기에 넣는다** (`fleet dispatch --max 3` 이 `3` 을 프로젝트로 읽는 함정이 이것이다).
 */
const VALUE_FLAGS = new Set(['--days', '--max']);

/**
 * 하위 명령 이름. 위치 인자를 고를 때 건너뛴다 (`tasks drift SP-sync` 의 `SP-sync` 가 프로젝트다).
 * **하위 명령을 더하면 `sp-sync.mjs` 의 `TASK_SUBS` 와 여기 둘 다에 넣는다** — 저쪽이 무엇을
 * 부를지를, 여기가 그 이름이 프로젝트가 아님을 안다. 거꾸로 import 하지 않으려고 나눠 둔 것이다.
 */
const SUBCOMMANDS = new Set(['review', 'drift', 'today', 'agenda']);

/** `tasks <하위명령> [<프로젝트>]` 의 위치 인자. 플래그도, 플래그의 값도, 하위 명령도 아닌 첫 낱말. */
function positionalArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (SUBCOMMANDS.has(a)) continue;
    return a;
  }
  return undefined;
}

/**
 * `--apply` 뒤에 오는 값들. **한 번 쓰고 여러 개를 잇는 것**(`--apply a b c`)과 플래그를
 * 반복하는 것(`--apply a --apply b`) 둘 다 받는다 — 표가 찍어 주는 줄이 앞의 모양이라
 * 그것부터 되어야 하고, 다른 플래그와 같은 버릇으로 쓰는 사람도 막히면 안 된다.
 * 다음 `--플래그`에서 끊는다.
 */
function applyValues(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--apply') continue;
    for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(argv[j]);
  }
  return out;
}

/**
 * `--apply` 로 받은 값들을 무엇에 적용할지 가른다. 순수 함수 — 실제 호출 전에 여기서 다 걸러낸다.
 *
 * 값은 태스크 id 또는 제목이다(카드의 `task` 와 같은 규칙). 두 쓰기 경로가 이 하나를 같이 쓴다 —
 * 완료 회수(`tasks review --apply`)와 오늘 편성(`tasks today --apply`).
 *
 * 어느 쪽이든 막는 것 넷: 못 찾음 / 이미 완료 / **하위 태스크** — 하위 목록은 사용자가 설계한
 * 것이라 이 도구가 손대지 않는다 / 중복 지정. 제목이 여럿에 걸리면 고르지 않고 막는다 —
 * 엉뚱한 태스크를 건드리는 것은 되돌리기 번거롭다.
 *
 * `opts.due` (쓸 마감일)가 있으면 **오늘 편성 경로**라 둘을 더 막는다. 회수에는 이 둘이 없다 —
 * 반복 태스크도 끝났으면 회수 대상이고, 마감일이 오늘인 것을 완료로 바꾸는 데는 문제가 없다.
 *   - 반복 태스크(`repeatCfgId`) — SP 가 주기마다 되살리므로 사람이 오늘로 당길 것이 아니다.
 *     표(`todayVerdict`)에서도 빠지지만, 손으로 id 를 적어 넣는 길이 있어 여기서도 막는다.
 *   - 이미 그 날짜 — 쓸 것이 없다. 실패가 아니라 건너뜀이다.
 */
function applyTargets(tasks, values, opts = {}) {
  const due = opts.due || null;
  const arr = Array.isArray(tasks) ? tasks : [];
  const apply = [];
  const skip = [];
  for (const raw of values) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const byId = arr.find((t) => t.id === v);
    const hits = byId ? [byId] : arr.filter((t) => normTitle(t.title) === normTitle(v));
    if (!hits.length) skip.push({ value: v, why: '못 찾음' });
    else if (hits.length > 1) skip.push({ value: v, why: '제목이 ' + hits.length + '개에 걸림 — id 로 지정한다' });
    else if (hits[0].isDone) skip.push({ value: v, why: '이미 완료', task: hits[0] });
    else if (hits[0].parentId) skip.push({ value: v, why: '하위 태스크 — 손대지 않는다', task: hits[0] });
    else if (due && hits[0].repeatCfgId) skip.push({ value: v, why: '반복 태스크 — SP 가 주기로 되살린다', task: hits[0] });
    else if (due && hits[0].dueDay === due) skip.push({ value: v, why: '이미 ' + due, task: hits[0] });
    else if (apply.some((t) => t.id === hits[0].id)) skip.push({ value: v, why: '중복 지정', task: hits[0] });
    else apply.push(hits[0]);
  }
  return { apply, skip };
}

/**
 * SP 에 쓴다. **이 함수만 쓴다**, 그리고 한 태스크당 키 하나만 보낸다.
 *
 *   `opts.due` 없음 — 완료 처리 `{isDone:true}` (`tasks review --apply`)
 *   `opts.due` 있음 — 마감일 `{dueDay:<그 날>}` (`tasks today --apply`)
 *
 * 하위 목록·notes·태그는 둘 다 그대로 둔다. 2026-09-09 실측으로 `PATCH {dueDay}` 가 다른 필드를
 * 건드리지 않고 갱신된 태스크를 그대로 돌려준다는 것을 확인했다
 * (`notes/2026-09-09-dueDay-patch-실측.md`). 날짜 검증은 SP 쪽에 없었으므로 — 과거 날짜도 받는다 —
 * 보내는 값은 호출하는 쪽이 `todayStr()` 하나로 고정한다.
 */
async function tasksApply(values, opts = {}) {
  const due = opts.due || null;
  const all = await api('GET', '/tasks');
  const arr = Array.isArray(all) ? all : [];
  const { apply, skip } = applyTargets(arr, values, { due });
  const done = [];
  const failed = [];
  for (const t of apply) {
    if (opts.dryRun) {
      done.push({ id: t.id, title: t.title, dryRun: true });
      continue;
    }
    try {
      await api('PATCH', '/tasks/' + t.id, due ? { dueDay: due } : { isDone: true });
      log('tasks apply: ' + (due ? '마감 ' + due : '완료 처리') + ' ' + t.id + ' ' + clean(t.title, 60));
      done.push({ id: t.id, title: t.title });
    } catch (e) {
      failed.push({ id: t.id, title: t.title, error: clean(e.message, 120) });
    }
  }
  return { done, failed, skip, due, dryRun: !!opts.dryRun };
}

export { applyTargets, applyValues, collectTasks, daysBetween, driftVerdict, lastCommitOf, mdy, noteCommits, pickToday, planPhaseOf, positionalArg, reviewVerdict, tasksAgenda, tasksApply, tasksDrift, tasksReview, tasksToday, todayVerdict, workerTaskIds };
