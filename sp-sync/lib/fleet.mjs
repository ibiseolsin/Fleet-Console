/**
 * fleet — 팀장 세션(coordinator)의 회차가 쓰는 명령들: status(한 표), slices(PLAN.md 파싱·워크스페이스 매칭),
 * dispatch(파견), handoff(멈춘 워커를 상대 에이전트로 인계), land(착륙), cycle(한 바퀴), precheck(회차를 돌리고 팀장을 깨울지 판정),
 * trigger(Stop 훅이 띄우는 회차 precheck), check(그 턴이 회차를 부를 자격이 되는지 판정만), pause/resume(자동 회차에서 프로젝트 빼기).
 * 공용·훅(카드·status.md 읽기)·wake(Orca 터미널 입출력)·limits·resources·resume 에 의존한다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, rmdirSync, rmSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { join, basename, resolve, dirname, isAbsolute } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normPath, normTitle, config, clean, fitCell, git, log, repoRoot, projectTitleFor, planCounts, isWaiting, HOME, state, currentBranch, sleep, readJson, CONFIG_FILE, writeJson, CODE_FILES, DIR, NODE, SELF, agentTable, TURN_STALE_MS, SLICE_TAGS, parsePlanSlices, safeName, sliceInPlan, sliceModel, sliceNumberOf } from './common.mjs';
import { BOARD_DUE_ORDER, BOARD_DUE, hhmm, readCards, pickCards, readCandidates, tabTitle, cardStamp, worktreeRoot, cardUnder } from './hooks.mjs';
import { orcaJson, TERMINAL_IO, checkSubmitted, readScreen, hasClaudePrompt, screenUnavailable, sendInstruction, sleepingAgents, wakeOne } from './wake.mjs';
import { allLimits, limitText, modelLimit, stillReached, LIMIT_AGENTS } from './limits.mjs';
import { held as heldResources, heldText, isOwn, release as releaseResources, reserve as reserveResources, sweep as sweepResources } from './resources.mjs';
import { RESUME_IO, bump as bumpResume, drop as dropResume, entries as resumeEntries, noteStuck, resumeLine, resumeOne, resumePlan, resumeRowText } from './resume.mjs';

// ---------- fleet ----------
/**
 * 팀장 세션(coordinator)의 회차 1단계 — "지금 어느 창에서 무슨 일이 어디까지 됐나"를 명령 하나로.
 * 살아 있는 Orca 터미널을 **메인 저장소 폴더명**(= SP 프로젝트명)으로 묶고, 그 프로젝트의
 * 마지막 복귀 카드와 candidates 의 마감을 옆에 붙인다.
 *
 * 카드 고르는 규칙은 status.md 와 같다(pickCards). 다만 status.md 는 워크트리 하나의 카드를
 * 보고 여기는 프로젝트 전체(워크트리 전부)의 카드를 본다 — 팀장이 알고 싶은 건 창이 아니라
 * 프로젝트가 어디까지 왔나이기 때문이다.
 *
 * 마감은 **읽기만 한다.** SP 에 쓰는 경로는 이 명령에 없다.
 */
function listTerminals(io = TERMINAL_IO) {
  const list = io.list();
  return Array.isArray(list) ? list : [];
}

/** 던지지 않는 git. 판정 중에는 한 명령의 실패가 회차를 죽이면 안 된다. */
function gitTry(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (e) {
    return { ok: false, out: '', detail: clean(e.message, 200) };
  }
}

/** 그 저장소의 기본 브랜치. `origin/HEAD` 가 없으면 `main` 으로 놓는다. 착륙과 파견이 같은 답을 쓴다. */
function baseBranchOf(root, override) {
  return override || gitTry(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root).out.split('/').pop() || 'main';
}

/**
 * 본체가 `origin/<기본 브랜치>` 보다 앞서 있는가 — **파견 전에 본다.**
 *
 * 새 워크스페이스는 원격에서 갈라지므로, 본체 PLAN.md 를 고치고 push 하지 않으면 그 변경이
 * 워크스페이스에 **없다.** 2026-08-30 에 두 모양으로 다 터졌다: (a) 본체에만 있는 새 슬라이스가
 * 워크스페이스에 없는 채로 "슬라이스 N 진행"이 갔고(slice10), (b) 착륙으로 이미 머지된 슬라이스가
 * 옛 본체 PLAN 에서 미체크로 읽혀 `slice10-2` 로 다시 떴다. 둘 다 원인은 하나 — 본체가 앞서 있다는 것.
 *
 * **push 는 하지 않는다.** 원격은 공유 상태라 이 자리에서 자동으로 밀 것이 아니다 (착륙의 push 는
 * 사용자가 그 흐름에 한해 허용한 것이고, 본체 push 는 거기 포함되지 않는다). 막고 보고만 한다.
 *
 * 판정 전에 `fetch` 한다 — 옛 remote-tracking ref 로 재면 이미 push 한 커밋이 앞선 것으로 보여
 * 파견이 헛되이 막힌다. 읽지 못하면(원격 없음, `origin/<base>` 없음) **막지 않는다** — 한 번도
 * fetch 안 한 저장소가 영영 파견 못 하게 되는 쪽이 더 나쁘다. 사유는 결과에 남긴다.
 */
function unpushedAhead(root, baseOverride) {
  const baseBranch = baseBranchOf(root, baseOverride);
  if (!gitTry(['remote'], root).out) return { hasRemote: false, baseBranch, ahead: 0 };
  gitTry(['fetch', 'origin', baseBranch], root);
  const r = gitTry(['log', '--oneline', '-n', '20', 'origin/' + baseBranch + '..HEAD'], root);
  if (!r.ok) return { hasRemote: true, baseBranch, ahead: 0, error: 'origin/' + baseBranch + ' 을 못 읽음: ' + r.detail };
  const commits = r.out.split('\n').filter(Boolean);
  return { hasRemote: true, baseBranch, ahead: commits.length, commits };
}

const MAIN_DIVERGED_TEXT = '본체 갈라짐 — 사용자가 풀어야';

/**
 * 회차가 프로젝트를 다루기 **전에** 본체를 origin 과 맞춘다 (2026-08-31 사용자 결정,
 * `~/orca/CLAUDE.md` "본체는 사용자의 작업 브랜치다").
 *
 * 본체는 읽기 전용 참조가 아니라 사용자가 직접 커밋하는 작업 브랜치다. 그런데 사용자 세션은
 * push 를 하지 않는다(까먹고, 물으면 토큰을 쓴다) — 그래서 그 push 를 회차가 맡는다. 슬라이스
 * 12 는 "앞서면 파견을 막고 사람에게 올린다"였는데, 그러면 매 회차가 사람을 기다리며 헛돈다.
 *
 *   (a) 앞섬        → `git push`. **트리가 더러워도 한다** — push 는 커밋된 것만 올리므로
 *                     작업 중인 파일은 그대로다
 *   (b) 뒤짐        → `git pull --ff-only`. 단 트리가 더러우면 미룬다 (ff 가 파일을 건드린다)
 *   (c) 갈라짐      → 막는다. 이 프로젝트의 착륙·파견을 통째로 건너뛴다 — 어느 쪽을 버릴지는
 *                     사람만 정할 수 있고, 그 사이에 머지가 들어가면 더 꼬인다
 *   (d) push 실패   → 같이 막는다. 원격이 앞서 있거나 인증이 끊긴 것이라 다음 단계가 헛돈다
 *
 * **기본 브랜치에 있을 때만 한다.** 사용자가 다른 브랜치에 올라가 있으면 그건 "로컬에만 두는
 * 커밋" 자리다 (`~/orca/CLAUDE.md`) — 건드리지 않고 지나간다.
 *
 * dry-run 은 판정만 하고 아무것도 쓰지 않는다.
 */
function syncMain(root, { base, dryRun } = {}) {
  const u = unpushedAhead(root, base); // fetch 까지 여기서 한다
  const r = { baseBranch: u.baseBranch, hasRemote: u.hasRemote, ahead: u.ahead, behind: 0, dirty: false, commits: u.commits || [], action: 'none', block: null, detail: '', text: '', dryRun: !!dryRun };
  if (!u.hasRemote) return { ...r, action: 'skip', detail: '원격 없음' };
  if (u.error) return { ...r, action: 'skip', detail: u.error };
  const branch = gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], root).out;
  r.branch = branch;
  if (branch !== u.baseBranch) return { ...r, action: 'skip', detail: '본체가 ' + (branch || '?') + ' 에 있음 — 기본 브랜치(' + u.baseBranch + ')가 아니라 지나간다' };
  const back = gitTry(['rev-list', '--count', 'HEAD..origin/' + u.baseBranch], root);
  r.behind = back.ok ? Number(back.out) || 0 : 0;
  r.dirty = !!gitTry(['status', '--porcelain'], root).out;
  const ref = 'origin/' + u.baseBranch;
  if (r.ahead && r.behind) {
    r.action = 'diverged';
    r.block = MAIN_DIVERGED_TEXT + ' (' + ref + ' 보다 ' + r.ahead + ' 앞 · ' + r.behind + ' 뒤)';
    r.text = r.block;
    return r;
  }
  if (r.ahead) {
    r.action = 'push';
    r.text = 'push ' + r.ahead + ' 커밋 → ' + ref + (dryRun ? ' (예정)' : '');
    if (dryRun) return r;
    const p = gitTry(['push', 'origin', u.baseBranch], root);
    if (!p.ok) {
      r.action = 'push-failed';
      r.block = '본체 push 실패 — ' + p.detail;
      r.text = r.block;
    }
    return r;
  }
  if (r.behind) {
    if (r.dirty) {
      r.action = 'ff-deferred';
      r.text = '트리가 더러워 ff 미룸 (' + ref + ' 보다 ' + r.behind + ' 뒤)';
      return r;
    }
    r.action = 'ff';
    r.text = 'ff ' + r.behind + ' 커밋 ← ' + ref + (dryRun ? ' (예정)' : '');
    if (dryRun) return r;
    const p = gitTry(['pull', '--ff-only'], root);
    if (!p.ok) {
      // 막지는 않는다 — 뒤진 본체로 파견하면 옛 PLAN 을 읽지만, 착륙 끝의 ff 가 한 번 더 기회를
      // 준다. 사람이 볼 수 있게 보고에만 올린다.
      r.action = 'ff-failed';
      r.detail = p.detail;
      r.text = '본체 ff 실패 — ' + p.detail;
    }
    return r;
  }
  return r;
}

/** 터미널의 worktreePath 를 프로젝트명으로. 같은 경로를 두 번 git 으로 풀지 않는다. */
function fleetProjectOf(path, cache) {
  const k = normPath(path);
  if (cache.has(k)) return cache.get(k);
  const root = existsSync(path) ? repoRoot(path) : resolve(path);
  const v = { name: projectTitleFor(root), root };
  cache.set(k, v);
  return v;
}

/** 프로젝트 마감 요약. 가장 급한 태스크 하나와 딱지별 개수. */
function fleetDue(tasks) {
  const count = {};
  for (const t of tasks) count[t.when] = (count[t.when] || 0) + 1;
  const sorted = tasks.slice().sort((a, b) => (BOARD_DUE_ORDER[a.when] ?? 9) - (BOARD_DUE_ORDER[b.when] ?? 9));
  const top = sorted.find((t) => t.due) || null;
  return { open: tasks.length, count, nearest: top ? { id: top.id, title: top.title, due: top.due, when: top.when } : null };
}

function fleetDueText(d) {
  if (!d.open) return '';
  const parts = [];
  for (const w of ['지남', '오늘', '예정']) if (d.count[w]) parts.push(BOARD_DUE[w] + ' ' + d.count[w]);
  if (d.nearest) parts.unshift(String(d.nearest.due).slice(0, 10));
  return parts.length ? parts.join(' · ') : '마감 없음 ' + d.open;
}


/**
 * 프로젝트의 예상 완료. **표에만 낸다** — SP 에 쓰지 않고, 마감도 읽기만 한다.
 *
 * 남은 양 = 그 프로젝트 `PLAN.md` 의 미체크 슬라이스(`- [ ]`) 수.
 * 속도   = PLAN.md 의 git 이력에서 체크 수가 **늘어난** 커밋들 사이의 평균 간격(실측).
 *          그런 커밋이 둘 미만이면 실측이 없으므로 "회차당 1슬라이스"(fleetRoundHours)로 놓는다.
 * 예상   = **지금과 마지막 활동 중 늦은 것**(카드 시각과 최근 커밋 중 늦은 것) + 남은 수 × 속도.
 *          기준점을 마지막 활동으로만 잡으면 며칠 멈춘 프로젝트의 예상이 **과거**로 나온다 —
 *          "이미 끝났어야 한다"는 값이라 마감과의 차이가 실제보다 크게 늦은 쪽으로 벌어지고,
 *          `⚠ 마감보다 늦음` 이 멈춘 프로젝트 전부에 붙어 정작 급한 것을 가린다 (슬라이스 44).
 *
 * 근거를 같이 돌려준다. 값만 보면 실측인지 가정인지 모르고, 가정이면 회차 길이가 통째로 추정이다.
 * PLAN.md 가 없으면 null — 슬라이스 단위가 없는 프로젝트의 진행은 여기서 재지 않는다.
 */
function slicePace(root) {
  const c = config();
  let lines;
  try {
    lines = git(['log', '--format=%H %ct', '-n', String(c.fleetPaceCommits), '--', 'PLAN.md'], root).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  // 오래된 것부터 훑으며 체크 수가 늘어난 커밋의 시각만 모은다.
  const events = [];
  let prev = -1;
  for (const l of lines.reverse()) {
    const [h, ts] = l.split(' ');
    let done;
    try {
      done = planCounts(git(['show', h + ':PLAN.md'], root)).done;
    } catch {
      continue;
    }
    if (prev >= 0 && done > prev) events.push(Number(ts) * 1000);
    prev = done;
  }
  if (events.length < 2) return null;
  const span = events[events.length - 1] - events[0];
  return { msPerSlice: span / (events.length - 1), samples: events.length };
}

function fleetEta(root, lastActiveAt, now = Date.now()) {
  const c = config();
  const f = join(root, 'PLAN.md');
  if (!existsSync(f)) return null;
  const { open, done } = planCounts(readFileSync(f, 'utf8'));
  // 미체크 0 = 이 단계가 끝났다. 남은 양이 없으니 "지금" 이 아니라 예상 자체가 없다 — `at` 을
  // null 로 둬 예상·차이 열과 ⚠ 를 통째로 비운다. 안 그러면 마감이 지난 프로젝트가 다 끝났는데도
  // `⚠ 마감보다 늦음` 을 달고 표 맨 위에 앉는다. 속도 실측(git 이력 훑기)도 돌리지 않는다.
  if (!open) return { open, done, at: null, msPerSlice: null, measured: false, basis: '미체크 0 — 단계 끝' };
  const pace = slicePace(root);
  const msPerSlice = pace ? pace.msPerSlice : c.fleetRoundHours * 3600000;
  const basis = pace
    ? `미체크 ${open} × 실측 ${(pace.msPerSlice / 3600000).toFixed(1)}h/슬라이스 (체크 ${pace.samples}회)`
    : `미체크 ${open} × 가정 회차당 1슬라이스 (${c.fleetRoundHours}h)`;
  // 지금보다 뒤진 기준점은 쓰지 않는다 — 남은 일을 지금부터 하는 것이지 지난주부터 하는 게 아니다.
  const from = Math.max(now, lastActiveAt || 0);
  return { open, done, at: from + open * msPerSlice, msPerSlice, measured: !!pace, basis, from };
}

/** 마감(YYYY-MM-DD, 그날 끝)과 예상의 차이. 마감이나 예상(미체크 0)이 없으면 null — 빈 칸이다. */
/** 예상은 미래다. cardStamp 는 과거용이라 내일 05:06 을 오늘 05:06 으로 읽히게 한다. */
function etaStamp(ts) {
  const d = new Date(ts);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  if (diff <= 0) return hhmm(ts);
  if (diff === 1) return '내일 ' + hhmm(ts);
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + hhmm(ts);
}

function fleetGap(due, eta) {
  if (!due || !eta || eta.at == null) return null;
  const end = new Date(String(due).slice(0, 10) + 'T23:59:59');
  return end.getTime() - eta.at;
}

/**
 * 지금 도는 단계의 번호 — `## 9단계 — 재개·자원…` → 9. `parsePlanSlices` 가 고른 절은 **첫 미체크 절**
 * 이라 접힌 `## 8단계 완료 …` 가 아니라 "지금 하는 단계" 다. 제목이 번호로 시작하지 않으면
 * (`## 나중에`) null — 연결할 근거가 없다.
 */
function planStageNumber(plan) {
  const m = String(plan?.phase?.title || '').match(/^(\d+)단계/);
  return m ? Number(m[1]) : null;
}

/**
 * 이 태스크가 지금 단계의 것인가 (슬라이스 44). 제목 **어디든** `N단계` 가 있고 그 번호가 현재 단계와
 * 같으면 연결이다 — 실제 제목이 `SP-sync 8단계 자동 머지`·`8단계 계획 검토`·`PLAN 1단계 검토` 로
 * 앞뒤가 제각각이라(2026-09-09 `~/.sp-sync/candidates/`) 자리를 고정하면 절반이 안 걸린다.
 *
 * **지난 단계의 태스크는 연결이 아니다.** 8단계 마감이 안 닫힌 채 9단계를 도는 프로젝트에서 그 마감으로
 * 지금 예상을 재면, 이미 끝난 일의 마감이 지금 일을 늦은 것으로 만든다.
 * `plan` 은 `parsePlanSlices` 결과나 단계 번호 하나 — 표 한 줄마다 다시 파싱하지 않게 둘 다 받는다.
 */
function linkTaskToStage(task, plan) {
  const stage = typeof plan === 'number' ? plan : planStageNumber(plan);
  if (stage == null) return false;
  for (const m of String(task?.title || '').matchAll(/(\d+)단계/g)) if (Number(m[1]) === stage) return true;
  return false;
}

/**
 * `차이` 칸의 값과 그 근거 (슬라이스 44). **현재 단계에 연결된 마감 태스크가 있을 때만** 낸다.
 *
 * 예전에는 그 프로젝트의 **가장 급한** 태스크 마감을 그대로 썼다. 그 태스크가 지금 단계와 무관하면
 * (지난 단계의 잔여물, 계획과 별개의 일) 두 열이 다른 단위를 재는 셈이라 차이가 뜻을 잃는다 —
 * 마감은 `그 일`, 예상은 `이 단계` 다. 연결이 없으면 `산정 불가` 로 **비워서** 낸다: 뜻 없는 숫자보다
 * 낫고, 마감·예상 열은 그대로 보이므로 참고 신호는 잃지 않는다.
 *
 * 연결된 것이 여럿이면 **가장 이른 마감**으로 잰다 — 가장 급한 태스크가 연결되지 않아도 연결된 다른
 * 마감 태스크가 있으면 그것으로 낸다.
 */
function fleetGapOf(tasks, plan, eta) {
  if (!plan) return { gap: null, task: null, why: 'PLAN.md 없음' };
  const stage = planStageNumber(plan);
  if (stage == null) return { gap: null, task: null, why: '현재 단계 제목에 번호가 없음' };
  if (!eta || eta.at == null) return { gap: null, task: null, why: eta ? eta.basis : '예상 없음' };
  const linked = (tasks || [])
    .filter((t) => t.due && linkTaskToStage(t, stage))
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  if (!linked.length) return { gap: null, task: null, why: stage + '단계 마감 태스크 없음' };
  return { gap: fleetGap(linked[0].due, eta), task: linked[0], why: null };
}

/** 표 `차이` 칸 — 연결이 없으면 `산정 불가`. */
function gapText(gap) {
  if (gap == null) return '산정 불가';
  return (gap < 0 ? '-' : '+') + (Math.abs(gap) / 86400000).toFixed(1) + 'd';
}

/**
 * 표의 줄 순서 — **차이 음수(마감보다 늦음) → 양수 → 산정 불가.** 팀장이 제일 먼저 볼 것이 맨 위다.
 * 같은 갈래 안에서는 차이가 작은(더 늦은/여유가 적은) 것이 위, 산정 불가끼리는 옛 잣대(마감 딱지)를
 * 쓰고, 그마저 같으면 최근에 움직인 창이 위다.
 */
function sortFleetRows(rows) {
  const rank = (r) => (r.gap == null ? 2 : r.gap < 0 ? 0 : 1);
  const urgency = (r) => (r.due?.nearest ? BOARD_DUE_ORDER[r.due.nearest.when] ?? 9 : 9);
  const last = (r) => Math.max(r.card?.at || 0, ...r.terminals.map((t) => t.lastOutputAt || 0));
  return rows.sort(
    (a, b) => rank(a) - rank(b) || (rank(a) === 2 ? urgency(a) - urgency(b) : a.gap - b.gap) || last(b) - last(a),
  );
}

/** 그 본체의 PLAN.md 파싱 결과. 없으면 null — 슬라이스 단위가 없는 프로젝트다. */
function planOf(root) {
  const f = join(root, 'PLAN.md');
  if (!existsSync(f)) return null;
  try {
    return parsePlanSlices(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function lastCommitAt(root) {
  try {
    return Number(git(['log', '-1', '--format=%ct'], root)) * 1000 || null;
  } catch {
    return null;
  }
}

async function fleetStatus() {
  const cfg = config();
  // 한도는 **계정 단위**라 프로젝트마다 다시 읽을 것이 없다 — 한 번 읽어 표에 나눠 붙인다.
  const limits = allLimits();
  const cache = new Map();
  const groups = new Map();
  for (const t of listTerminals()) {
    if (t.connected === false || t.orphaned) continue;
    const { name, root } = fleetProjectOf(t.worktreePath, cache);
    if (!groups.has(name)) groups.set(name, { project: name, root, terminals: [] });
    groups.get(name).terminals.push({
      handle: t.handle,
      title: t.title || '',
      worktreePath: t.worktreePath,
      branch: t.branch || null,
      lastOutputAt: t.lastOutputAt || null,
    });
  }
  const rows = [];
  for (const g of groups.values()) {
    g.terminals.sort((a, b) => (b.lastOutputAt || 0) - (a.lastOutputAt || 0));
    // 카드의 project 는 세션 훅이 같은 repoRoot 로 구한 값이라 여기 이름과 같다. 옛 카드에
    // project 가 없으면 cwd 로 다시 푼다.
    const cards = readCards((x) => (x.project || fleetProjectOf(x.cwd, cache).name) === g.project);
    const card = pickCards(cards)[0] || null;
    const tasks = readCandidates(g.project);
    const due = fleetDue(tasks);
    const eta = fleetEta(g.root, Math.max(card?.at || 0, lastCommitAt(g.root) || 0) || null);
    // 차이는 **현재 단계에 연결된 마감 태스크**로만 낸다 (슬라이스 44). 단계 번호를 알아야 하므로
    // 여기서 PLAN.md 를 한 번 더 읽는다 — `fleetEta` 는 체크 수만 세느라 절을 안 본다.
    const plan = planOf(g.root);
    const gapInfo = fleetGapOf(tasks, plan, eta);
    // 그 프로젝트의 **기본** 에이전트다. 슬라이스 태그(`[에이전트: X]`)가 이기지만 여기서는
    // PLAN.md 를 안 읽는다 — `fleet status` 는 창 목록만 보는 명령이고, 태그별 실제 한도는
    // 표 밑의 요약(전 에이전트)에 그대로 다 있다.
    const agent = (cfg.fleetProjectAgent || {})[g.project] || 'claude';
    rows.push({
      ...g,
      agent,
      limit: limits[agent] || null,
      eta,
      stage: planStageNumber(plan),
      gap: gapInfo.gap,
      gapTask: gapInfo.task,
      gapWhy: gapInfo.why,
      card: card
        ? {
            now: card.now || '',
            wait: isWaiting(card.wait) ? card.wait : '',
            next: card.next || '',
            task: card.task || null,
            at: card.at,
            terminal: card.terminal || null,
            tabTitle: card.tabTitle || null,
            commits: card.commits || [],
          }
        : null,
      tasks,
      due,
      // 한도 해제 뒤 재개를 기다리는 워크스페이스 (슬라이스 43). 표 밑 근거 줄에만 나온다.
      resume: resumeEntries(g.project),
    });
  }
  return sortFleetRows(rows);
}

/**
 * 표 밑의 한도 요약 한 덩어리. 표의 `한도` 칸은 그 프로젝트가 쓰는 에이전트 것뿐이라,
 * "지금 어느 쪽에 여유가 있나"(= 막힌 워크스페이스를 누가 이어받을 수 있나)는 여기서 본다.
 * 읽을 줄 모르는 에이전트와 묵은 캐시는 `모름` 이다 — 모르면 막지 않는다는 규칙 그대로다.
 */
function renderLimits(limits) {
  const L = ['한도'];
  for (const a of LIMIT_AGENTS) {
    const l = limits[a];
    const reset = l && l.resetsAt ? '  초기화 ' + hhmm(l.resetsAt) : '';
    L.push('  ' + fitCell(a, 12) + '  ' + limitText(l) + reset + (l && stillReached(l) ? '  ⚠ 참' : ''));
  }
  return L;
}

/** 예약을 쥔 시간 — `12분` · `3시간` · `2일`. 표 밑 한 줄에만 쓰므로 눈금은 셋이면 족하다. */
function sinceText(at) {
  const min = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (min < 60) return min + '분';
  if (min < 60 * 24) return Math.round(min / 60) + '시간';
  return Math.round(min / (60 * 24)) + '일';
}

function renderFleet(rows, limits = allLimits(), held = heldResources()) {
  const c = config();
  const cols = [
    ['프로젝트', 18, (r) => r.project],
    ['창', 4, (r) => String(r.terminals.length)],
    ['카드', 11, (r) => (r.card ? cardStamp(r.card.at) : '')],
    ['지금', c.fleetFieldMax, (r) => r.card?.now || ''],
    ['대기', c.fleetFieldMax, (r) => r.card?.wait || ''],
    ['다음', c.fleetFieldMax, (r) => r.card?.next || ''],
    // 그 프로젝트를 도는 에이전트의 한도. 값이 계정 단위라 여러 줄에 같은 값이 반복될 수 있지만,
    // "이 프로젝트가 지금 막혀 있나"를 프로젝트 줄에서 바로 읽는 것이 표의 목적이다.
    ['한도', 28, (r) => (r.agent === 'claude' ? '' : r.agent + ' ') + limitText(r.limit)],
    ['마감', 26, (r) => fleetDueText(r.due)],
    ['예상', 13, (r) => (r.eta?.at ? etaStamp(r.eta.at) + (r.gap != null && r.gap < 0 ? ' !' : '') : '')],
    // 빈 칸이 아니라 `산정 불가` 다 (슬라이스 44) — 빈 칸은 "여유가 없다"로도 "못 쟀다"로도 읽힌다.
    ['차이', 10, (r) => gapText(r.gap)],
  ];
  const line = (cells) => cells.map(([v, w]) => fitCell(v, w)).join('  ').replace(/\s+$/, '');
  const L = [line(cols.map(([h, w]) => [h, w])), cols.map(([, w]) => '-'.repeat(w)).join('  ')];
  for (const r of rows) L.push(line(cols.map(([, w, f]) => [f(r), w])));
  L.push('');
  L.push(...renderLimits(limits), '');
  // 잡혀 있는 공유 자원 (슬라이스 42). 프로젝트 줄에는 안 들어간다 — 자원은 프로젝트가 아니라 실물에
  // 매인 것이라, "폰을 지금 누가 쥐고 있나"는 표 하나 밑의 한 줄이 제자리다. 비어 있으면 줄이 안 는다.
  const heldRows = Object.values(held || {});
  if (heldRows.length) L.push('점유 자원', ...heldRows.map((h) => '  ' + heldText(h) + (h.since ? ' (' + sinceText(h.since) + ')' : '')), '');
  // 창 목록은 표 밑에. 팀장이 지시를 보낼 대상은 프로젝트가 아니라 터미널 핸들이다.
  // `*` 는 카드를 쓴 창.
  for (const r of rows) {
    L.push(r.project + (r.card?.task ? '  [' + r.card.task + ']' : ''));
    // 예상의 근거는 표에 안 들어간다(칸이 없다). 값만 보면 실측인지 가정인지 모른다.
    if (r.eta) L.push('    예상 ' + (r.eta.at ? etaStamp(r.eta.at) + ' — ' : '') + r.eta.basis + (r.gap != null && r.gap < 0 ? '  ⚠ 마감보다 늦음' : ''));
    // 차이의 근거 — 어느 태스크로 쟀는지, 못 쟀으면 왜 (슬라이스 44). `산정 불가` 만 보면
    // "태스크 제목에 `N단계` 를 넣으면 계산된다"는 대처가 안 보인다.
    L.push('    차이 ' + (r.gapWhy ? '산정 불가 (' + r.gapWhy + ')' : '기준 ' + clean(r.gapTask?.title, 40) + ' (' + String(r.gapTask?.due).slice(0, 10) + ')'));
    // 왜 안 움직이나 — 사람 결정을 기다리는 시간과, 한도가 풀리면 저절로 이어질 시각.
    const stalled = [];
    if (r.card?.wait && r.card.at) stalled.push('대기 ' + sinceText(r.card.at) + ' (카드 at 기준)');
    const nextResume = (r.resume || []).map((e) => e.resetsAt).filter(Boolean).sort((a, b) => a - b)[0];
    if (nextResume) stalled.push('다음 재개 ' + hhmm(nextResume));
    if (stalled.length) L.push('    ' + stalled.join(' · '));
    // 재개 예약 — 한도에 막혀 적어 둔 워크스페이스. 초기화 시각과 시도 수가 곧 "언제 저절로 이어지나" 다.
    for (const e of r.resume || []) L.push('    ' + resumeLine(e, c.fleetResumeMax));
    for (const t of r.terminals) {
      const mark = r.card && r.card.terminal === t.handle ? '*' : ' ';
      L.push('  ' + mark + ' ' + t.handle + '  ' + fitCell(t.title, 30) + '  ' + (t.lastOutputAt ? cardStamp(t.lastOutputAt) : ''));
    }
  }
  return L.join('\n') + '\n';
}

// ---------- fleet slices ----------
// PLAN.md 슬라이스 파서(`SLICE_TAGS`·`parseSliceLine`·`parsePlanSlices`·`sliceInPlan`·`sliceNumberOf`)는
// `common.mjs` 에 있다 — Stop 훅도 같은 판정으로 워크스페이스 카드 상태를 정하는데 `hooks` 는
// `fleet` 을 import 하지 못하기 때문이다(의존 방향 `common ← hooks ← fleet`). 여기서 다시 내보내므로
// `sp-sync.mjs`·`tasks.mjs` 의 import 는 그대로다.

/**
 * 파견이 만드는 워크스페이스 폴더의 부모 — `~/orca/workspaces/<본체 폴더명>/`.
 * `resolveProjectRoot` 가 `~/orca/projects` 를 그대로 쓰는 것과 같은 전제다(형제 폴더).
 */
function workspacesDirOf(root, home = HOME) {
  return join(home, 'orca', 'workspaces', basename(repoRoot(root)));
}

/**
 * 그 폴더를 지워도 되는가. **되면 null, 안 되면 사유 문자열**이다.
 * 판정만 하고 파일 시스템에 손대지 않는다 — 재료를 넘겨받으므로 테스트가 Orca·git 없이 부른다.
 *
 * 네 겹으로 막는다. 재귀 삭제라 하나라도 헐거우면 남의 작업이 사라진다:
 *   1) **워크스페이스 폴더 바로 밑**이어야 한다 — 본체·홈·프로젝트 폴더는 애초에 후보가 아니다
 *   2) 이름이 `sliceN`(또는 Orca 가 덧붙인 `sliceN-M`)이어야 한다 — 파견이 만든 것만 파견이 치운다
 *   3) 안에 `.git` 이 있으면 살아 있는 링크드 워크트리다
 *   4) git 이나 Orca 의 워크트리 목록에 있으면 창이 붙어 있을 수 있다
 * 넷을 다 통과하면 git 도 Orca 도 모르는 고아 — 남은 것은 무시된 산출물(`node_modules`)이나
 * 이미 머지된 파일의 죽은 사본뿐이다.
 */
function staleWorkspaceReason({ path, workspacesDir, orcaPaths = [], gitPaths = [], hasDotGit = false }) {
  const p = normPath(path);
  const base = normPath(workspacesDir);
  if (!base || !p.startsWith(base + '/')) return '워크스페이스 폴더 밖';
  const rest = p.slice(base.length + 1);
  if (rest.includes('/')) return '워크스페이스 바로 밑이 아님';
  if (!/^slice[-_]?\d+(-\d+)?$/i.test(rest)) return '파견이 만든 이름이 아님';
  if (hasDotGit) return '.git 이 있음 — 살아 있는 워크트리';
  if (gitPaths.some((x) => normPath(x) === p)) return 'git worktree 목록에 있음';
  if (orcaPaths.some((x) => normPath(x) === p)) return 'Orca 워크트리 목록에 있음';
  return null;
}

/** `staleWorkspacePlan`·`removeWorkspaceDir` 이 바깥과 닿는 자리. 테스트가 갈아 끼운다. */
const WORKSPACE_DEPS = {
  orcaPaths: () => {
    try {
      return (orcaJson(['worktree', 'list']).worktrees || []).map((w) => w.path || w.git?.path).filter(Boolean);
    } catch {
      // 목록을 못 읽으면 **아무것도 안 지운다.** 빈 배열로 떨어지면 살아 있는 워크스페이스가
      // 고아로 보여 통째로 날아간다 — 모를 때는 남기는 쪽이 맞다.
      return null;
    }
  },
  gitPaths: (root) => {
    // 폴더가 이미 사라진 등록을 먼저 턴다 — 안 털면 그 경로가 "git 이 알고 있음"으로 남아
    // 고아 판정이 영영 안 선다. prune 은 폴더가 없는 등록만 지운다.
    gitTry(['worktree', 'prune'], root);
    const r = gitTry(['worktree', 'list', '--porcelain'], root);
    if (!r.ok) return null;
    return r.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim());
  },
  list: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  },
  // 워크스페이스 폴더의 부모. 주입해 두는 것은 테스트가 임시 폴더로 갈아 끼우기 위해서다 —
  // `workspacesDirOf` 는 진짜 `HOME` 과 `repoRoot`(git 호출)를 탄다.
  dir: (root) => workspacesDirOf(root),
  hasDotGit: (p) => existsSync(join(p, '.git')),
  exists: (p) => existsSync(p),
  // `maxRetries` 는 Windows 때문이다 — 방금 닫힌 창의 셸이 폴더를 잠깐 쥐고 있으면 EBUSY 가 난다.
  rm: (p) => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
};

/**
 * 그 프로젝트의 워크스페이스 폴더에 남은 **고아 폴더** 목록. 부수효과가 없다 —
 * dry-run 과 실제 쓸기가 같은 함수를 쓴다 (`landCheck` 와 같은 잣대).
 *
 * Orca 나 git 목록을 못 읽으면 **빈 계획**을 낸다. 모르면 안 지운다.
 */
function staleWorkspacePlan(root, deps = WORKSPACE_DEPS) {
  const dir = deps.dir(root);
  const orcaPaths = deps.orcaPaths();
  const gitPaths = deps.gitPaths(root);
  if (!orcaPaths || !gitPaths) {
    return { dir, stale: [], kept: [], detail: '목록을 못 읽어 건너뜀 (Orca 또는 git)' };
  }
  const stale = [];
  const kept = [];
  for (const name of deps.list(dir)) {
    const path = join(dir, name);
    const why = staleWorkspaceReason({ path, workspacesDir: dir, orcaPaths, gitPaths, hasDotGit: deps.hasDotGit(path) });
    if (!why) stale.push({ name, path });
    // 이름이 아예 다른 폴더는 파견과 무관하다 — 보고에 올려 봐야 줄만 는다.
    else if (why !== '파견이 만든 이름이 아님') kept.push({ name, why });
  }
  return { dir, stale, kept, detail: '' };
}

/**
 * 고아 폴더를 지운다. **판정을 다시 하지 않는다** — `staleWorkspacePlan` 이 이미 했다.
 * 하나가 실패해도 나머지는 계속 지운다(Windows 의 EBUSY 는 흔하다).
 */
function sweepStaleWorkspaces(plan, deps = WORKSPACE_DEPS) {
  const removed = [];
  const failed = [];
  for (const s of plan.stale || []) {
    try {
      deps.rm(s.path);
      if (deps.exists(s.path)) failed.push({ name: s.name, detail: '지웠는데 남아 있음' });
      else removed.push(s.name);
    } catch (e) {
      failed.push({ name: s.name, detail: clean(e.message, 120) });
    }
  }
  return { removed, failed };
}

/**
 * 워크스페이스 폴더 하나를 지운다 — 착륙이 `orca worktree rm` 뒤에 부른다.
 * 판정을 여기서 한 번 더 한다(같은 `staleWorkspaceReason`): 착륙은 회차 밖에서도 불리고,
 * `worktree rm` 이 실패했는데 폴더를 지우면 살아 있는 워크트리가 사라진다.
 */
function removeWorkspaceDir(path, root, deps = WORKSPACE_DEPS) {
  if (!deps.exists(path)) return { ok: true, detail: '' };
  const orcaPaths = deps.orcaPaths();
  const gitPaths = deps.gitPaths(root);
  if (!orcaPaths || !gitPaths) return { ok: false, detail: '목록을 못 읽어 건너뜀 (Orca 또는 git)' };
  const why = staleWorkspaceReason({
    path,
    workspacesDir: deps.dir(root),
    orcaPaths,
    gitPaths,
    hasDotGit: deps.hasDotGit(path),
  });
  if (why) return { ok: false, detail: why };
  const r = sweepStaleWorkspaces({ stale: [{ name: basename(path), path }] }, deps);
  return r.removed.length ? { ok: true, detail: '' } : { ok: false, detail: r.failed[0]?.detail || '' };
}

/**
 * 프로젝트 이름(또는 경로) → PLAN.md 를 읽을 폴더.
 *
 * **이름을 주면 본체**(`~/orca/projects/<프로젝트>`)다 — 파견은 본체 계획을 근거로 삼는다.
 * **경로를 주면 그 경로 그대로**다. 워크트리에는 그 세션이 방금 체크한 PLAN.md 가 있고,
 * 본체 것은 머지 전까지 옛날 것이라 착륙 판정("슬라이스 N 이 `[x]` 인가")은 워크트리를 봐야 한다.
 * 그 폴더에 PLAN.md 가 없으면 본체로 올라간다 — 프로젝트 안 아무 데서나 이름 없이 부를 수 있게.
 *
 * **구분자가 없는 맨 이름은 이름으로 먼저 찾는다.** 경로부터 보면 지금 위치에 이름이 겹치는
 * 폴더가 있을 때 그쪽으로 샌다 — Windows 는 대소문자를 안 가려서 본체 `SP-sync/` 안에서
 * `SP-sync` 가 코드 폴더 `sp-sync/` 로 걸렸고, 거기 PLAN.md 가 없으니 위로 올라가 엉뚱한
 * 폴더가 프로젝트 루트가 됐다. 이름으로 못 찾으면 그때 경로로 본다 (2026-08-30).
 */
function resolveProjectRoot(arg, dir = join(HOME, 'orca', 'projects')) {
  const a = String(arg || '').trim();
  if (!a) throw new Error('프로젝트 이름이 필요합니다');
  const want = a.toLowerCase();
  const dirs = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    : [];
  const looksPath = isAbsolute(a) || /[\\/]/.test(a) || a === '.' || a === '..';
  const hit = looksPath
    ? null
    : dirs.find((d) => d.name.toLowerCase() === want || projectTitleFor(join(dir, d.name)).toLowerCase() === want);
  if (hit) return join(dir, hit.name);
  if (existsSync(a)) {
    const p = resolve(a);
    return existsSync(join(p, 'PLAN.md')) ? p : repoRoot(p);
  }
  throw new Error('프로젝트를 못 찾음: ' + a + ' (있는 것: ' + dirs.map((d) => d.name).join(', ') + ')');
}

/**
 * 그 프로젝트의 살아 있는 워크스페이스. 본체와 아카이브는 뺀다.
 * 브랜치는 **git 에서 다시 읽는다** — Orca 의 `branch` 는 워크스페이스를 만든 시점 값이라
 * 세션이 브랜치를 바꾸면 어긋난다 (2026-08-30 실측: tuskfish 가 Orca 목록에는 옛 이름으로 남아 있었다).
 */
/**
 * 그 프로젝트의 Orca repoId. **파견 전에 반드시 이걸로 저장소를 못 박는다.**
 * `orca worktree create` 에 `--repo` 를 안 주면 **지금 활성인 저장소**에 만들어진다 — 2026-08-30
 * 에 project-b 파견이 SP-sync 에 `slice10` 을 만들고 거기 세션에 "슬라이스 10 진행"을 보냈다.
 * 못 찾으면 던진다. 엉뚱한 저장소에 만드는 것보다 아무것도 안 하는 게 낫다.
 */
function repoIdOf(root) {
  const want = normPath(repoRoot(root));
  for (const w of orcaJson(['worktree', 'list']).worktrees || []) {
    if (w.isMainWorktree && normPath(w.path || w.git?.path) === want && w.repoId) return w.repoId;
  }
  throw new Error('Orca 저장소 id 를 못 찾음: ' + want + ' (Orca 에 등록된 저장소인지 확인하세요)');
}

/** `projectWorkspaces` 가 읽는 바깥 것들. 테스트가 가짜 목록을 넣는다 — 잠든 워크스페이스 판정을 창 없이 확인하려고. */
const WORKSPACE_IO = {
  terminals: () => listTerminals(),
  worktrees: () => orcaJson(['worktree', 'list']).worktrees || [],
  sessions: () => state().sessions || {},
  sleeping: () => sleepingAgents(),
  projectOf: fleetProjectOf,
  branchOf: (path) => (existsSync(path) && currentBranch(path)) || null,
};

function projectWorkspaces(root, io = WORKSPACE_IO) {
  const cache = new Map();
  const target = io.projectOf(root, cache).name;
  let terminals = [];
  try {
    terminals = io.terminals().filter((t) => t.connected !== false && !t.orphaned);
  } catch {
    terminals = []; // 창 목록은 덤이다. Orca 가 안 뜨면 슬라이스 표는 그대로 낸다.
  }
  // 한 번만 읽는다. 못 읽으면 빈 객체 — 모든 창이 "훅 기록 없음"이 되어 옛 판정으로 떨어진다.
  let sessions = {};
  try {
    sessions = io.sessions();
  } catch {}
  // 절전으로 잠든 창 (슬라이스 28). 잠든 창은 `terminals` 에 없다 — 이 표가 "창이 없는 것"과 "잠든 것"을 가르는
  // 유일한 재료다. 못 읽으면 빈 표라 모든 워크스페이스가 예전처럼 "창이 없음"으로 판정된다.
  let sleeping = new Map();
  try {
    sleeping = io.sleeping();
  } catch {}
  const out = [];
  for (const w of io.worktrees()) {
    if (w.isMainWorktree || w.isArchived) continue;
    const path = w.path || w.git?.path;
    if (!path || io.projectOf(path, cache).name !== target) continue;
    const branch = io.branchOf(path) || String(w.branch || '').replace(/^refs\/heads\//, '');
    const mine = terminals.filter((t) => normPath(t.worktreePath) === normPath(path));
    const asleep = sleeping.get(normPath(path)) || [];
    out.push({
      name: basename(path),
      path,
      branch,
      slice: sliceNumberOf(branch, path),
      lastActivityAt: w.lastActivityAt || null,
      // 창 중 **가장 최근** 출력. 훅 기록이 없는 창에서만 착륙 판정에 쓴다 (landCheck).
      lastOutputAt: Math.max(0, ...mine.map((t) => t.lastOutputAt || 0)) || null,
      // 훅이 찍은 턴 경계. 착륙의 "정말 손을 뗐나" 판정의 원천이다 (슬라이스 23).
      turn: turnStateFor(path, sessions),
      terminals: mine.map((t) => t.handle),
      // 잠든 에이전트 창들. 비어 있으면 null — 창이 없는 것과 같은 모양이 되게.
      sleeping: asleep.length ? asleep : null,
    });
  }
  return out;
}

/**
 * 그 워크스페이스가 **잠들어 있는가** — 살아 있는 창은 없고 절전 기록만 있다. 살아 있는 창이 하나라도 있으면
 * 잠든 것이 아니다(옛 절전 기록이 남은 채 사람이 새 창을 연 경우). 사유 문구는 한 곳에서만 만든다.
 */
function sleepingOf(w) {
  if (!w || (w.terminals || []).length || !w.sleeping || !w.sleeping.length) return null;
  const s = w.sleeping[0];
  return { ...s, text: '잠듦(' + (s.agent || '?') + (s.state ? ' ' + s.state : '') + (s.capturedAt ? ' ' + hhmm(s.capturedAt) : '') + ')' };
}
const SLEEP_WAKE_HINT = 'CLI 로 못 깨움 — 사람이 Orca 에서 탭을 열어야 함';

/**
 * **모든 프로젝트를 합친** 활성 워크스페이스 수 — 전역 상한(`fleetMaxWorkspacesTotal`)의 재료다 (슬라이스 42).
 * 잣대는 `activeCount` 그대로: 창이 하나라도 살아 있는 워크스페이스만 센다.
 *
 * `projectWorkspaces` 는 프로젝트별이라 `cycleProjects([])` 전부에 돌린다 — Orca 워크트리 목록을 통째로 세지
 * 않는 이유는 `~/orca/projects` 밖의 저장소(사용자가 그냥 열어 둔 것)까지 세면 상한이 엉뚱하게 차기 때문이다.
 * Orca 호출은 한 번뿐이다: `io` 를 한 번 읽어 프로젝트마다 그 값을 다시 쓴다.
 *
 * 세는 함수는 **하나뿐이어야 한다** — 회차(`fleetCycle` 이 한 번 세어 `ctx` 로 나른다)와 단독 `fleet dispatch`
 * 가 다른 값을 보면 dry-run 이 낸 사유가 실제와 갈린다.
 */
function globalActiveCount({ projects, io = WORKSPACE_IO } = {}) {
  const names = projects || cycleProjects([]);
  // 바깥 목록은 한 번만 읽는다. 프로젝트마다 `orca worktree list` 를 새로 부르면 프로젝트 수만큼 느려진다.
  const once = (f) => {
    let v;
    let got = false;
    return (...a) => {
      if (!got) {
        v = f(...a);
        got = true;
      }
      return v;
    };
  };
  const memo = { ...io, terminals: once(io.terminals), worktrees: once(io.worktrees), sessions: once(io.sessions), sleeping: once(io.sleeping) };
  const seen = new Set();
  let n = 0;
  for (const name of names) {
    let ws = [];
    try {
      ws = projectWorkspaces(repoRoot(resolveProjectRoot(name)), memo);
    } catch {
      continue; // 이름을 못 푸는 프로젝트는 없는 셈 친다 — 상한을 세다가 회차가 죽으면 안 된다
    }
    for (const w of ws) {
      const k = normPath(w.path);
      if (seen.has(k)) continue;
      seen.add(k);
      if ((w.terminals || []).length) n++;
    }
  }
  return n;
}

/**
 * 슬라이스마다 **어느 에이전트로 띄울지**를 정한다 (슬라이스 1). 순서는 하나뿐이다:
 * `[에이전트: X]` 태그 → 프로젝트 기본값(`fleetProjectAgent`) → `claude`(지금 동작 그대로).
 *
 * 파서가 태그에 적힌 이름만 주고(`s.agent`) 채우는 것은 여기다 — 그래서 `fleet slices` 표와
 * 파견 판정이 **같은 값**을 본다. 프로필에 없는 이름은 여기서 `agentUnknown` 으로 표시만 하고
 * 막지는 않는다: 무엇을 보류할지는 `dispatchPlan` 이 정한다 (판정과 표시를 안 섞는다).
 */
function resolveAgents(slices, { projectAgent, agents } = {}) {
  const table = agents || {};
  return (slices || []).map((s) => {
    const name = s.agent || projectAgent || 'claude';
    return { ...s, agent: name, agentUnknown: name !== 'claude' && !table[name] };
  });
}

/**
 * `fleet slices <프로젝트>` — PLAN.md 의 **현재 단계** 슬라이스 목록과 지금 떠 있는
 * 워크스페이스를 이어 붙인다. 파견(`fleet dispatch`)·착륙(`fleet land`)이 "무엇이 남았고
 * 무엇이 이미 돌고 있나"를 여기서 받는다.
 *
 * 읽기만 한다 — PLAN.md 도 워크트리도 건드리지 않는다. 그래서 `--dry-run` 이 없다.
 *
 * **현재 단계 = 미체크 슬라이스가 있는 첫 `##` 절.** 전역 규칙상 끝난 단계는 "N단계 완료"
 * 한 줄로 접히고(체크박스가 사라진다), 앞으로의 단계·"나중에"·"안 할 것" 절은 체크박스 없는
 * 줄거리다. 그래서 체크박스의 유무만으로 갈린다 — 절 제목의 낱말("단계")에 기대지 않는다.
 * 프로젝트마다 제목 짓는 법이 다르기 때문이다 (SP-sync 는 첫 단계 제목이 `## 슬라이스` 다).
 */
function fleetSlices(arg, cfg = config()) {
  const root = resolveProjectRoot(arg);
  const f = join(root, 'PLAN.md');
  if (!existsSync(f)) throw new Error('PLAN.md 가 없습니다: ' + f);
  const parsed = parsePlanSlices(readFileSync(f, 'utf8'));
  const ws = projectWorkspaces(root);
  const project = projectTitleFor(repoRoot(root));
  const slices = resolveAgents(parsed.slices, {
    projectAgent: (cfg.fleetProjectAgent || {})[project],
    agents: agentTable(cfg),
  }).map((s) => ({
    ...s,
    workspace: (s.number != null && ws.find((w) => w.slice === s.number)) || null,
  }));
  // 워크스페이스에도 **계획상의** 에이전트를 붙인다 — 파견·착륙의 미파견 판정이 "이 창은 헤드리스로
  // 띄운 것" 을 래퍼 기록이 없을 때도 알아야 한다 (`headlessOf`). 세션 기록의 이름은 `turn.agent` 다.
  for (const s of slices) if (s.workspace) s.workspace.agent = s.agent;
  return {
    // 프로젝트 이름은 **메인 저장소 폴더명**이다 — root 가 워크트리면 폴더명이 워크스페이스 이름이다
    project,
    root,
    plan: f,
    phase: parsed.phase,
    phases: parsed.phases,
    // 체크박스인데 슬라이스로 안 읽힌 줄 수. 슬라이스가 0 일 때만 뜻이 있다 (구문 어긋남).
    strayChecks: parsed.strayChecks,
    // 계획 오류(`planErrors`) — **파일 전체**의 것이다. 파견은 슬라이스에 붙은 `errors` 만 보고,
    // 이 목록은 사람이 읽는 표(`renderSlices`)와 `--json` 몫이다.
    errors: parsed.errors,
    // 선행 판정은 파일 전체를 본다 — 다른 절에 미체크로 있는 선행을 "끝난 것"으로 읽으면 안 된다.
    allSlices: parsed.allSlices,
    slices,
    workspaces: ws,
    // 슬라이스에 안 붙은 워크스페이스 — 지난 단계 번호이거나 브랜치가 `sliceN` 이 아닌 창이다.
    unmatched: ws.filter((w) => !slices.some((s) => s.workspace === w)),
  };
}

function renderSlices(r) {
  const tagText = (s) =>
    s.tags
      // 에이전트는 제 열이 따로 있다 — 태그 열에도 쓰면 같은 이름이 두 번 나오고 그만큼
      // 다른 태그가 잘린다.
      .filter((k) => k !== 'agent')
      .map((k) => {
        const label = SLICE_TAGS.find((t) => t.key === k).label;
        if (k === 'decision' && s.decision) return label + ': ' + s.decision;
        if (k === 'deps') return label + ': ' + (s.deps || []).join(', ');
        if (k === 'resources') return label + ': ' + (s.resources || []).join(', ');
        return label;
      })
      .join(' · ');
  const cols = [
    ['번호', 5, (s) => (s.number == null ? '-' : String(s.number))],
    ['', 4, (s) => (s.done ? '[x]' : '[ ]')],
    ['워크스페이스', 14, (s) => (s.workspace ? s.workspace.name : '')],
    // `claude` 는 빈 칸이다 — 거의 모든 줄이 claude 인데 다 적으면 눈이 다른 것을 못 찾는다.
    // 모르는 이름에는 `?` 를 붙여 표에서 바로 보이게 한다 (파견은 그 줄만 보류한다).
    ['에이전트', 14, (s) => (!s.agent || s.agent === 'claude' ? '' : s.agent + (s.agentUnknown ? ' ?' : ''))],
    ['태그', 24, tagText],
    ['제목', 50, (s) => s.title],
  ];
  const line = (cells) => cells.map(([v, w]) => fitCell(v, w)).join('  ').replace(/\s+$/, '');
  const L = [r.project + '  —  ' + (r.phase?.title || '(단계 없음)'), ''];
  L.push(line(cols.map(([h, w]) => [h, w])), cols.map(([, w]) => '-'.repeat(w)).join('  '));
  for (const s of r.slices) L.push(line(cols.map(([, w, f]) => [f(s), w])));
  if (r.workspaces.length) {
    L.push('');
    for (const w of r.workspaces)
      L.push(
        '  ' + fitCell(w.name, 14) + fitCell(w.branch, 32) + (w.terminals.join(' ') || '창 없음') + (r.unmatched.includes(w) ? '  (슬라이스 밖)' : '')
      );
  }
  const open = r.slices.filter((s) => !s.done);
  L.push(
    '',
    '미체크 ' + open.length + ' · 워크스페이스 ' + r.workspaces.length + ' · 결정 대기 ' + open.filter((s) => s.tags.includes('decision')).length
  );
  // 계획 오류는 표 밑에 줄줄이 낸다 — **파견이 보는 것과 같은 목록**이다 (`planErrors`).
  // 조용히 넘기면 오타가 영영 안 보이고, 여기 한 줄이 곧 "이 슬라이스는 안 뜬다"는 뜻이다.
  const errs = r.errors || r.slices.flatMap((s) => s.errors || []);
  if (errs.length) {
    L.push('', '계획 오류 ' + errs.length + '건 — 그 슬라이스는 파견되지 않는다:');
    for (const e of errs) L.push('  ' + (e.slice == null ? '?' : e.slice) + '번 (' + e.line + '줄) ' + e.kind + ' — ' + e.detail);
  }
  return L.join('\n') + '\n';
}

// ---------- fleet dispatch ----------
/**
 * `fleet dispatch <프로젝트> [--max N]` — 자격 있는 슬라이스에 워크스페이스를 띄우고 지시까지 보낸다.
 *
 * 사람이 하던 "① 워크스페이스 만들고 `/slice N` 보내기"를 그대로 옮긴 것이다. 판단은 안 한다 —
 * 무엇을 띄울지는 PLAN.md 의 태그와 지금 떠 있는 워크스페이스 수만으로 갈린다.
 *
 * 순서가 전부다. Claude(슬라이스 26): **`worktree create --agent claude --prompt` → 그 워크트리의 새 훅 기록
 * 대기** — 설정 훅 완료 → Claude 기동 → 첫 프롬프트는 Orca 가 순서대로 하고, 파견은 그 결과(훅 기록)만 본다.
 * 헤드리스: **생성 → 훅 파일이 생길 때까지 대기 → 래퍼 실행.** 시간으로 기다리지 않는다(60초 sleep 같은 것).
 * 2026-08-30 실측에서 즉시 지시한 워크스페이스는 sp-sync 훅이 깔리기 전에 세션이 떠서 복귀 카드를 한 번도
 * 안 썼다 — Claude Code 는 `.claude/settings.local.json` 을 세션 시작 때 **한 번만** 읽기 때문이다. 그래서
 * `--agent` 파견은 저장소 설정의 "agent 를 시작하기 전에 설정이 완료될 때까지 기다리세요"(`wait-for-setup`)
 * 가 전제다 — 안 켜져 있으면 훅 없이 뜨고, 그러면 훅 기록이 안 생겨 파견이 "session 실패" 로 드러낸다.
 */
const SLICE_PROMPT = 'PRD.md, PLAN.md 읽고 슬라이스 {N} 진행. 끝나면 PLAN.md 체크하고 커밋.';

/**
 * 그 프로젝트에서 슬라이스 N 을 시키는 말. `/slice` 스킬이 있으면 축약형, 없으면 전역 규칙의
 * 고정 문장 그대로. 스킬이 없는 프로젝트에 `/slice 8` 을 보내면 세션이 그냥 못 알아듣는다.
 *
 * **전역 스킬(`~/.claude/skills/slice`)도 센다.** 스킬은 프로젝트 것과 전역 것이 똑같이
 * 불리는데, 프로젝트 폴더만 보던 동안에는 2026-08-30 에 전역으로 깔아 둔 스킬이 있어도
 * 스킬 없는 프로젝트에 고정 문장이 갔다. 하는 일은 같으므로 달라지는 건 지시 문구뿐이다.
 */
function sliceCommandFor(root, n, home = HOME) {
  const has = (d) => !!d && existsSync(join(d, '.claude', 'skills', 'slice'));
  return has(root) || has(home) ? '/slice ' + n : SLICE_PROMPT.replace('{N}', String(n));
}

/**
 * 워크스페이스는 있는데 워커가 **지시를 한 번도 못 받은** 상태인가 (슬라이스 16).
 *
 * 회차가 중간에 끊기거나(Orca precheck 상한 600초) 지시가 미제출로 남으면 이 모양이 된다 —
 * 2026-08-30 21:00 회차의 SP-sync 3건이 전부 빈 `❯` 에 컨텍스트 0% 였다. 그때는 `dispatchPlan`
 * 이 "이미 돌고 있음"으로 건너뛰고 `landCheck` 는 "유휴인데 미체크 — 막힘"으로 보고만 해서
 * **아무도 지시를 다시 안 보냈다.**
 *
 * 재료를 다 받아 순수하게 판단한다. 순서는 `undispatchedCheck` 가 싼 것부터 모으는 순서와 같고,
 * 여기서는 어느 재료에서 걸렸는지를 말로 돌려준다. **하나라도 "일한 흔적"이면 손대지 않는다** —
 * 반쯤 한 일 위에 같은 지시를 덧보내는 것이 아무것도 안 하는 것보다 나쁘다.
 */
function undispatched(f) {
  // 헤드리스 워커(4단계)에는 화면·유휴가 재료가 아니다 — 지시는 명령줄에 실려 래퍼가 뜬 순간 들어갔고,
  // 래퍼가 턴 경계를 세션 기록에 찍는다. 그래서 **턴 기록이 있으면 파견된 것**이고, 턴이 끝났는데
  // 미체크면 빈 창이 아니라 막힘이다 — 재파견하지 않는다(다시 띄우면 반쯤 한 일 위에 같은 지시가 겹친다).
  // 기록이 없으면 래퍼가 뜨지 못한 것이라 이것도 사람 몫이다. 창이 없어도 판정은 같다 — 프로세스가
  // 끝난 탭은 셸 프롬프트로 남지만(2026-09-02 실측) 사람이 닫을 수 있고, 끝났다는 사실은 기록에 있다.
  if (f.headless) {
    const t = f.turn || {};
    const who = '헤드리스(' + f.headless + ')';
    const tail = (f.commits ? ' · 커밋 ' + f.commits + '개' : '') + (f.terminals ? '' : ' · 창 없음');
    if (t.active) return { stalled: false, why: who + ' 작업 중 — 래퍼 턴 진행 중' + tail };
    if (t.stale) return { stalled: false, why: who + ' 래퍼 턴이 안 끝난 채 오래됨 — 사람이 볼 것' + tail };
    if (!t.known) return { stalled: false, why: who + ' 인데 래퍼 턴 기록이 없음 — 래퍼가 뜨지 못한 듯, 사람이 볼 것' + tail };
    return { stalled: false, why: who + ' 턴 끝남 — 미체크면 막힘, 재파견하지 않음' + tail };
  }
  // 잠든 창(절전)은 지시를 이미 받고 턴을 끝낸 창이다 — 빈 창이 아니므로 재파견하지 않는다. 깨우는 길이 CLI 에
  // 없어(슬라이스 28 실측: `send` 는 `terminal_not_writable`, `switch` 는 `terminal_exited`) 사람 몫으로 올린다.
  if (!f.terminals) return { stalled: false, why: f.sleeping ? f.sleeping.text + ' — ' + SLEEP_WAKE_HINT : '창이 없음' };
  if (f.commits) return { stalled: false, why: '커밋 ' + f.commits + '개 — 일한 흔적이 있다' };
  if (f.statusMd) return { stalled: false, why: 'status.md 가 있음 — 턴을 한 번은 돌았다' };
  if (f.screenError) return { stalled: false, why: '화면을 못 읽음: ' + f.screenError };
  // 렌더된 화면 대신 누적 스트림이 왔으면(`screen-unavailable`) 지시 흔적이 없다는 것이 근거가
  // 못 된다 — 재그리기가 글자 단위로 겹쳐 `❯ 그 글` 이 통째로 뭉개진다(슬라이스 27 실측 근거는
  // `terminal read --help` 의 `cclclecleaclear`). 모르는 채로 같은 지시를 덧보내는 것이
  // 아무것도 안 하는 것보다 나쁘다는 이 함수의 전제를 그대로 따른다.
  if (f.screenSource === 'screen-unavailable' && f.screen !== 'submitted')
    return { stalled: false, why: '화면을 못 읽음 (스트림 폴백) — 지시 흔적을 못 가림' };
  // `submitted` 는 이력의 `❯ 그 글` 이거나 진행 흔적(●·스피너·컨텍스트 >0%)이다. 둘 중 하나면
  // 지시는 이미 들어갔다 — 커밋이 없는 이유는 다른 데 있고, 그건 사람이 볼 몫이다.
  if (f.screen === 'submitted') return { stalled: false, why: '화면에 지시·진행 흔적이 있다' };
  if (!f.idle) return { stalled: false, why: '작업 중 (TUI 유휴 아님)' };
  return {
    stalled: true,
    why: '지시 미전송 — 커밋 0 · status.md 없음 · 화면에 지시 흔적 없음' + (f.screen === 'stuck' ? ' (글이 입력창에 남아 있음)' : ''),
  };
}

/**
 * 위 판정의 재료를 모은다. **싼 것부터** 본다 — git 로그·파일 하나, 그 다음 화면, 마지막이
 * 유휴 대기(창마다 몇 초)다. 일하는 워크스페이스는 거의 언제나 커밋이나 화면 흔적에서 걸리므로
 * 유휴 대기까지 가는 일은 드물다.
 *
 * `opts.idle` 로 이미 아는 유휴 값을 넣을 수 있다 — 착륙은 방금 그걸 재고 온다.
 */
function undispatchedCheck(w, opts, io = TERMINAL_IO) {
  const terminals = (w.terminals || []).length > 0;
  // 헤드리스면 세션 기록(`turnStateFor`)이 전부다 — 화면도 `tui-idle` 도 안 읽는다. git 로그는 보고용이다.
  const headless = headlessOf(w);
  if (headless) {
    const ahead = gitTry(['log', '--oneline', opts.baseRef + '..HEAD'], w.path);
    const commits = ahead.ok ? ahead.out.split('\n').filter(Boolean).length : 0;
    return undispatched({ terminals, headless, turn: w.turn || { known: false }, commits });
  }
  const f = { terminals, sleeping: sleepingOf(w), commits: 0, statusMd: false, screen: null, screenSource: null, screenError: null, idle: true };
  if (!f.terminals) return undispatched(f);
  const ahead = gitTry(['log', '--oneline', opts.baseRef + '..HEAD'], w.path);
  // base 를 못 읽으면 "커밋이 있다"로 본다. 모르는 채로 지시를 덧보내지 않는다.
  f.commits = ahead.ok ? ahead.out.split('\n').filter(Boolean).length : 1;
  if (f.commits) return undispatched(f);
  f.statusMd = existsSync(join(w.path, 'status.md'));
  if (f.statusMd) return undispatched(f);
  for (const h of w.terminals) {
    let s;
    try {
      s = io.read(h);
    } catch (e) {
      f.screenError = clean(e.message, 120);
      return undispatched(f);
    }
    // 한 창이라도 렌더된 화면을 못 받았으면 그 사실을 남긴다 — 아래 판정이 "흔적 없음" 을
    // "못 읽음" 과 가르는 재료다.
    if (screenUnavailable(s.source)) f.screenSource = 'screen-unavailable';
    const r = checkSubmitted(s.lines, opts.text || '', s.draft);
    // 창이 여럿이면 한 창이라도 지시가 들어가 있으면 들어간 것이다.
    if (r === 'submitted') return undispatched({ ...f, screen: 'submitted' });
    if (r === 'stuck') f.screen = 'stuck';
  }
  f.idle = opts.idle != null ? !!opts.idle : w.terminals.some((h) => isIdle(h, opts.idleMs));
  return undispatched(f);
}

/**
 * 자원(모델 호출·마이크·API 쿼터)을 실제로 쓰고 있는 워크스페이스 수.
 *
 * **창이 하나도 없으면 안 센다** (슬라이스 18). 슬라이스에 안 붙은 창도 자원을 쓰므로 워크스페이스
 * 수를 그대로 셌는데, 사람이 손으로 만든 브랜치 워크스페이스(2026-08-30 project-b `plan15b`:
 * 커밋 1개·PR 없음·창 0개)까지 세어져 태그 없는 다음 슬라이스가 "병렬 태그가 없어 혼자일 때만
 * (지금 1개)" 로 영영 막혔다. 폴더만 남은 워크스페이스는 아무 호출도 안 하므로 측정도 안 흐린다.
 *
 * 착륙 판정(`landCheck` "창이 없음")과 `sliceN` 아닌 브랜치의 "미분류" 보고는 그대로 둔다 —
 * 그 폴더가 사람이 풀 몫이라는 신호까지 같이 지우면 안 된다.
 */
function activeCount(workspaces) {
  return workspaces.filter((w) => (w.terminals || []).length > 0).length;
}

/**
 * 이름을 못 읽는 워크스페이스에 **창이 살아 있으면** 그 프로젝트의 새 파견을 전부 보류한다.
 *
 * 워크스페이스↔슬라이스 매칭은 브랜치·폴더 끝이 `sliceN` 일 때뿐이다(`sliceNumberOf`). 사용자가
 * 손으로 만든 창(브랜치 `dev/catshark`)에서 슬라이스 1 을 진행 중이었는데, 파견은 그 창을
 * "미분류"로 보고만 하고 슬라이스 1 이 `[병렬 가능]` 이라 활성 창 수와 무관하게 자격을 줘 slice1
 * 워크스페이스를 두 번 새로 만들었다 (2026-08-31 15:18·15:37 Project A).
 *
 * **사실이 사유보다 먼저다** — 이름을 못 읽는 창이 살아 있으면 사람이 그 프로젝트에서 뭔가를
 * 하는 중이고, 그게 어느 슬라이스인지는 도구가 알 방법이 없다. 모르면 안 만드는 편이 낫다.
 *
 * 막는 것은 **새 워크스페이스를 만드는 파견뿐**이다. 재파견(지시 못 받은 창에 지시만 다시
 * 보내는 것)은 창을 안 만드니 그대로 간다. 창이 없는(터미널 0) 미분류 워크스페이스도 안 막는다 —
 * 폴더만 남은 것은 아무도 안 쓰고 있다 (슬라이스 18 과 같은 잣대).
 */
function strayBlock(workspaces) {
  const live = (workspaces || []).filter((w) => w.slice == null && (w.terminals || []).length > 0);
  if (!live.length) return null;
  const list = live.map((w) => w.name + ' (브랜치 ' + (w.branch || '?') + ')').join(', ');
  return (
    '미분류 창 ' + list + ' 이 살아 있음 — 어느 슬라이스인지 모른다. ' +
    '브랜치를 `<user>/sliceN` 으로 바꾸거나 창을 닫으면 풀린다'
  );
}

const PLAN_DIRTY_TEXT = 'PLAN.md 미커밋 변경 — 커밋(`/plan-review`)이 파견 신호';

/**
 * 본체 `PLAN.md` 가 HEAD 와 다르면(수정됐는데 커밋 안 됨) 새 파견을 접는 사유. 아니면 null.
 *
 * 파견은 **작업 트리의** PLAN.md 를 읽는다(`fleetSlices`). 전역 규칙은 "PLAN.md 커밋이 곧 파견 신호" —
 * 계획을 저장만 하고 `/plan-review` 가 새 세션에서 검토·커밋하는 게 게이트다. 그런데 회차는 다른 이유
 * (다른 파일의 커밋으로 본체가 앞섬, 다른 워커의 착륙)로도 뜨므로, 미검토 계획이 그대로 파견됐다 —
 * 2026-09-03 slice6, 2026-09-08 slice13 (둘 다 워크스페이스의 PLAN.md 에는 그 번호가 없어
 * 워커가 헛돌았다). 미추적 PLAN.md(첫 계획)는 HEAD 에 없으니 비교할 것이 없다 — 막지 않는다.
 * 재파견(이미 뜬 창에 지시만 다시)은 막지 않는다 — `strayBlock` 과 같은 자리.
 */
function planDirtyBlock(root) {
  const st = gitTry(['status', '--porcelain', '--', 'PLAN.md'], root);
  if (!st.ok || !st.out) return null;
  if (/^\?\?/.test(st.out)) return null;
  return PLAN_DIRTY_TEXT;
}

/**
 * 지금 이 슬라이스를 띄우면 **시작하자마자 한도에 걸리는가**. 걸리면 사유, 아니면 null.
 * 부수효과 없음 — `dispatchPlan` 이 판정에, dry-run 이 미리보기에 같은 함수를 쓴다.
 *
 * 5시간 창만 본다. 7일 창은 며칠에 걸친 이야기라 "지금 띄울까"의 재료가 아니고, 그걸로 막으면
 * 하루 종일 아무것도 안 뜨는 회차가 된다 — 7일이 정말 찬 경우는 `reached` 로 착륙·인계 쪽이 잡는다.
 * `[어려움]` Claude 슬라이스는 **Fable 의 모델 한도도** 본다: 5시간·7일이 여유여도 Fable 만 막힐
 * 수 있고(2026-09-02 실물: 5시간 65%·7일 29%·Fable 45%), 그 슬라이스는 Fable 로 뜬다.
 *
 * **모르면 막지 않는다** (슬라이스 11 과 같은 잣대) — 묵은 캐시나 읽는 법이 없는 에이전트
 * (antigravity)를 "찼다"로 읽으면 자동 회차가 조용히 아무것도 안 하는 쪽으로 고장 난다.
 */
function limitStartHold(slice, limits, { startPct, hardModel } = {}) {
  const pct = Number(startPct);
  if (!Number.isFinite(pct) || pct <= 0) return null; // 0·음수는 게이트 끔
  const agent = slice.agent || 'claude';
  const l = (limits || {})[agent];
  if (!l) return null;
  const over = [];
  if (l.pct5h != null && l.pct5h >= pct) over.push('5시간 ' + Math.round(l.pct5h) + '%');
  if (agent === 'claude' && (slice.tags || []).includes('hard') && hardModel) {
    const m = modelLimit(l, hardModel);
    if (m && m.pct >= pct) over.push(hardModel + ' ' + Math.round(m.pct) + '%');
  }
  if (!over.length) return null;
  return '한도 임박 — ' + agent + ' ' + over.join(' · ') + ' (fleetLimitStartPct ' + pct + '%)';
}

/**
 * 무엇을 띄울지 고른다. **부수효과가 없다** — `--dry-run` 과 실제 파견이 같은 함수를 쓴다.
 * 그래야 dry-run 이 낸 이유가 실제로 일어날 일과 같다는 게 보장된다.
 *
 * 자격 (원본 §2):
 *  - 이미 그 번호로 워크스페이스가 떠 있으면 건너뛴다
 *  - `[결정 필요]` 는 건너뛰고 **보고한다.** 그 앞에서 멈추지는 않는다 — 뒤가 `[병렬 가능]` 이면 간다
 *  - `[선행: N, M]` 은 그 번호들이 모두 `[x]` 일 때만. 그 외의 미완 앞 슬라이스와는 독립이라
 *    `[병렬 가능]` 을 함축한다. **완료 여부는 파일 전체(`allSlices`)로 본다** — 다른 절에 미체크로
 *    있는 선행을 "현재 단계에 없으니 끝난 것"으로 읽으면(8단계를 7단계 앞에 둔 지금 같은 배치)
 *    순서가 뒤집힌다. 파일 어디에도 없는 번호는 `parsePlanSlices` 가 계획 오류로 잡는다
 *  - **계획 오류가 있는 슬라이스는 안 띄운다** (`s.errors` — 모르는 태그·중복 번호·없는 선행).
 *    오류를 "기본값으로 해석"하지 않는다: 오타 하나가 조용히 승인 대기를 실행으로 바꿨다 (coordinator #2)
 *  - `[병렬 가능]` 이거나, 그 프로젝트에 활성 워크스페이스가 0개일 때만
 *  - 이름이 `sliceN` 이 아닌 워크스페이스에 창이 살아 있으면 **새 파견은 전부 보류**한다 (`strayBlock`)
 *  - `[자원: 폰]` 이 말하는 이름을 **다른 (프로젝트, 슬라이스)가 쥐고 있으면** 보류한다 (`held`, 슬라이스 42).
 *    프로젝트를 넘어 배타다 — 폰은 한 대뿐이라 옆 프로젝트가 잡았어도 이쪽이 못 쓴다
 *  - 프로젝트당 동시 N개(기본 3), 번호 순. 그 위에 **모든 프로젝트를 합친** 상한(`maxTotal`)이 있다 —
 *    한도도 기계도 계정 단위라, 프로젝트별 상한만으로는 프로젝트 수만큼 곱해진다
 *
 * **태그 없는 슬라이스는 혼자 돈다** — 뜰 때 혼자일 뿐 아니라, 도는 동안 다른 것도 안 띄운다.
 * 원본이 이 규칙에 건 목적이 "측정 슬라이스는 옆 워크트리의 호출에 흐려지면 안 된다"이므로,
 * 나중에 `[병렬 가능]` 이 옆에 붙는 걸 막지 않으면 규칙이 반만 지켜진다.
 *
 * `block` 이 오면 그 프로젝트는 이번에 아무것도 안 띄우고 그 사유를 미체크 슬라이스마다 적는다
 * (본체 미push 등, 슬라이스별이 아니라 저장소 통째의 사정). 이미 도는 창은 그대로 보고한다 —
 * 사실이 사유보다 먼저다.
 */
function dispatchPlan({ slices, workspaces, max, block, limitHold, planDirty = null, allSlices = null, held = {}, project = null, total = null, maxTotal = null }) {
  let active = activeCount(workspaces);
  // 모든 프로젝트를 합친 활성 수. 회차는 한 번 세어 `ctx` 로 나르고(`globalActiveCount`), 단독 파견은
  // 자기가 센다. 안 넘어오면 이 프로젝트 것만으로 떨어진다 — 손으로 지은 입력용 테스트가 그 자리다.
  let totalActive = Number.isFinite(total) ? total : active;
  const capTotal = Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : null;
  // 예약 표는 **이 판정 안에서 자란다.** 이번에 띄우기로 한 슬라이스가 잡을 자원을 여기 얹지 않으면
  // 같은 계획의 뒤 슬라이스가 같은 폰을 집는다 — 실제 예약(`reserve`)은 워크스페이스가 생긴 뒤라
  // 그 사이에 판정이 끝나기 때문이다. `active++` 와 같은 자리다.
  const heldNow = { ...(held || {}) };
  // 이름을 못 읽는 창이 살아 있으면 새로 만들지 않는다 (슬라이스 24). 재파견은 아래에서 지나간다.
  const stray = strayBlock(workspaces);
  const depsOf = (s) => s.deps || [];
  // `[선행: N]` 은 그 번호들과만 의존한다 — 나머지와 독립이므로 `[병렬 가능]` 과 같은 자리다.
  const isParallel = (s) => s.tags.includes('parallel') || depsOf(s).length > 0;
  // 지금 도는 것 중 `[병렬 가능]` 이 아닌 게 있으면 이번 회차는 아무것도 안 띄운다.
  const solo = slices.find((s) => s.workspace && !isParallel(s));
  let soloBlock = solo ? '' + solo.number + '번이 혼자 돌아야 함 (병렬 태그 없음)' : null;
  // **순서 막힘** — 비병렬 슬라이스가 이번에 뜨지 못하면(한도·결정 필요·모르는 에이전트·번호 없음)
  // 그 뒤의 비병렬 슬라이스도 뜨지 않는다. 태그 없는 슬라이스는 "앞 것이 다 끝난 뒤" 가 전제라,
  // 앞이 보류인데 뒤가 "활성 워크스페이스 0개" 로 뜨면 순서가 뒤집힌다 — 2026-09-04 Community
  // Warming 에서 9·10번이 `[어려움]` 한도 게이트로 보류되자 11번이 먼저 나갔다(워커가 스스로 멈춤).
  // `soloBlock` 은 이미 **뜬** 창에서만 세워져 이 구멍을 못 막았다. `[병렬 가능]`·`[선행]` 은
  // 앞 슬라이스와 독립을 선언한 것이므로 이 막힘을 받지 않는다.
  let orderBlock = null;
  const out = [];
  // 선행의 완료 여부는 **파일 전체**로 본다 (`parsePlanSlices` 의 `allSlices`). 안 넘어오면 현재
  // 단계로 떨어진다 — 손으로 슬라이스를 지어 부르는 테스트가 그 자리다.
  const universe = allSlices && allSlices.length ? allSlices : slices;
  for (const s of slices) {
    if (s.done) continue;
    // 모르는 태그는 파서가 건너뛰었다. 사유에 붙여 오타가 보고에 드러나게 한다.
    // (파서를 거친 슬라이스는 아래 계획 오류에서 이미 걸린다 — 이 꼬리는 손으로 지은 입력용이다.)
    const un = (s.unknownTags || []).length ? ' · 모르는 태그: [' + s.unknownTags.join('] [') + ']' : '';
    const no = (reason) => {
      out.push({ slice: s, eligible: false, reason: reason + un });
      if (!orderBlock && !s.workspace && !isParallel(s)) orderBlock = (s.number != null ? s.number + '번' : '앞의 비병렬 슬라이스') + '이 먼저 (보류 중: ' + reason + ')';
    };
    // **계획 오류는 무엇보다 먼저다** — 그 줄을 못 믿으니 태그가 말하는 자격도 못 믿는다.
    // 그 슬라이스만 막고 프로젝트는 안 막는다: 뒤의 `[병렬 가능]` 은 그대로 뜬다.
    if ((s.errors || []).length) {
      const why = '계획 오류: ' + s.errors.map((e) => e.detail).join(' · ');
      out.push({ slice: s, eligible: false, reason: why + (s.workspace ? ' — ' + s.workspace.name + ' 재파견 보류' : '') });
      // 순서 막힘은 `isParallel` 을 안 본다 — `[병렬 가능]`·`[선행]` 주장 자체가 오류일 수 있어서다
      // (`[선행: 999]` 는 독립을 선언한 셈이 된다). 뒤의 비병렬은 세운다.
      if (!orderBlock && !s.workspace) orderBlock = (s.number != null ? s.number + '번' : '앞의 슬라이스') + '이 먼저 (보류 중: ' + why + ')';
      continue;
    }
    if (s.workspace) {
      // 창은 있는데 지시를 못 받은 워크스페이스는 **재파견 대상**이다 (슬라이스 16). 새로
      // 띄우는 게 아니라 있는 창에 지시만 보내므로 상한·병렬 태그는 안 본다 — 그 자리는
      // 이미 `active` 에 세어져 있다.
      const st = s.workspace.stalled;
      if (!st || !st.stalled) {
        no('이미 돌고 있음 (' + s.workspace.name + ')' + (st && st.why ? ' — ' + st.why : ''));
        continue;
      }
      // 본체가 앞서 있으면 이 워크스페이스의 PLAN.md 에도 그 슬라이스가 없을 수 있다.
      if (block) {
        no(block + ' — ' + s.workspace.name + ' 재파견 보류');
        continue;
      }
      out.push({ slice: s, eligible: true, redispatch: s.workspace, reason: '재파견 — ' + st.why + un });
      continue;
    }
    if (block) {
      no(block);
      continue;
    }
    if (stray) {
      no(stray);
      continue;
    }
    // 본체 PLAN.md 가 커밋 전이면 새로 띄우지 않는다 — 검토 전 계획이 나간다 (`planDirtyBlock`).
    if (planDirty) {
      no(planDirty);
      continue;
    }
    // 번호가 없으면 워크스페이스 이름(`sliceN`)도 지시(`/slice N`)도 못 만든다. 막지 않으면
    // `slicenull` 을 만들고 "슬라이스 null 진행"을 보낸다 — `S1.` 꼴 제목을 쓰는 프로젝트에서
    // 실제로 나왔다 (2026-08-30). 번호 매김을 고치는 건 그 프로젝트 몫이라 여기선 보고만 한다.
    if (s.number == null) {
      no('제목에 번호가 없어 워크스페이스 이름을 못 정함 (`**N. 제목**` 꼴이어야 한다)');
      continue;
    }
    // 프로필에 없는 에이전트 이름은 **그 슬라이스만** 보류한다 (모르는 태그와 같은 경로).
    // 오타 하나가 조용히 `claude` 로 떨어지면 헤드리스로 돌 슬라이스가 TUI 로 뜬다.
    if (s.agentUnknown) {
      no('모르는 에이전트: ' + s.agent + ' — config.json 의 fleetAgents 에 없다');
      continue;
    }
    if (s.tags.includes('decision')) {
      no('결정 필요' + (s.decision ? ': ' + s.decision : '') + ' — 사용자 결정 뒤에');
      continue;
    }
    // `[선행: N, M]` — 부분 의존. **파일 어느 절에서든** 미체크인 선행이 하나라도 있으면 자격이 없다.
    // 파일 어디에도 없는 번호는 접힌 지난 단계의 것일 때만 여기까지 온다 (그 외는 위 계획 오류가
    // 걸렀다). 그것도 사유에 "계획에 없음"으로 적어 접힌 범위가 맞는지 눈에 보이게 한다.
    const deps = depsOf(s);
    const undoneDeps = deps.filter((n) => universe.some((x) => x.number === n && !x.done));
    if (undoneDeps.length) {
      no('선행 미완: ' + undoneDeps.join(', ') + '번');
      continue;
    }
    const missingDeps = deps.filter((n) => !universe.some((x) => x.number === n));
    // 한도 임박은 **태그·상한보다 먼저** 본다 (슬라이스 13). 자리가 나도 띄우면 안 되는 것이라,
    // "혼자 돌아야 함"·"상한을 채움"으로 적으면 자리만 비면 뜰 것처럼 읽힌다.
    const hold = limitHold ? limitHold(s) : null;
    if (hold) {
      no(hold);
      continue;
    }
    // 공유 자원 예약 (슬라이스 42). 한도와 같은 급이다 — 자리가 나도 띄우면 안 되는 것이라, 태그·상한보다
    // 먼저 본다. 자기 예약(같은 프로젝트·슬라이스)은 안 막는다: 폴더가 사라졌는데 회수가 아직 안 돈 자리다.
    const taken = (s.resources || []).map((n) => heldNow[normTitle(n)]).find((h) => h && !isOwn(h, { project, slice: s.number }));
    if (taken) {
      no('자원 점유: ' + heldText(taken));
      continue;
    }
    if (soloBlock) {
      no(soloBlock);
      continue;
    }
    // 태그 규칙을 상한보다 먼저 본다. 상한을 올려도 안 뜰 슬라이스에 "상한을 채움"이라고
    // 적으면, 상한만 올리면 될 것처럼 읽힌다.
    const parallel = isParallel(s);
    if (!parallel && orderBlock) {
      no(orderBlock);
      continue;
    }
    if (!parallel && active > 0) {
      no('병렬 태그가 없어 혼자일 때만 (지금 ' + active + '개)');
      continue;
    }
    if (active >= max) {
      no('동시 상한 ' + max + '개를 채움');
      continue;
    }
    // 전역 상한은 프로젝트별 상한 **뒤**다 — 둘 다 찼으면 그 프로젝트가 제 몫을 다 쓴 것이 먼저 할 말이다.
    if (capTotal && totalActive >= capTotal) {
      no('전역 상한 ' + capTotal + ' (현재 ' + totalActive + ')');
      continue;
    }
    const why = deps.length
      ? '선행 ' + deps.join(', ') + '번 완료' + (missingDeps.length ? ' (' + missingDeps.join(', ') + '번은 계획에 없음)' : '')
      : parallel
        ? '병렬 가능'
        : '활성 워크스페이스 0개';
    out.push({ slice: s, eligible: true, reason: why + un });
    active++;
    totalActive++;
    for (const n of s.resources || []) heldNow[normTitle(n)] = { name: n, project, slice: s.number, workspace: null, since: Date.now() };
    if (!parallel) soloBlock = '' + s.number + '번이 혼자 돌아야 함 (이번에 띄움)';
  }
  return out;
}

/**
 * 훅이 깔릴 때까지 기다린다. 준비 신호의 **절반** 이다 — 시간이 아니라 파일이다.
 * Orca 설정 스크립트가 `sp-sync install` 을 돌려 이 파일을 만든다(약 1분).
 */
async function waitForHooks(path, timeoutMs) {
  const f = join(path, '.claude', 'settings.local.json');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(f)) return true;
    await sleep(2000);
  }
  return false;
}

/**
 * 준비 신호의 **나머지 절반**: 화면에 Claude 프롬프트(`❯`)가 떴는가.
 *
 * `tui-idle` 만으로는 부족하다 (2026-08-30, project-b slice14 로 확정). 워크스페이스를 막 만든
 * 창에는 Orca 의 `Waiting for setup to finish before starting agent...` 만 떠 있고 Claude 는
 * 아직 없다. 그 화면에서 `tui-idle` 은 즉시 통과하기도 하고(2026-08-30 미제출 6건) 시간 초과로
 * 실패하기도 한다(21:47 실측) — 시점에 따라 갈린다는 것 자체가 그 신호로는 못 가른다는 뜻이다.
 * 통과해 버리면 지시가 Claude 가 뜨기 **전에** 들어가 글자는 Orca 입력창(draft)에 남고 Enter 는 사라진다.
 */
async function waitForPrompt(handle, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = '';
  let unread = false;
  while (Date.now() < until) {
    try {
      const s = readScreen(handle);
      if (hasClaudePrompt(s.lines)) return { ok: true };
      // 렌더된 화면을 못 받았으면 `❯` 가 없다는 것도 근거가 못 된다 — 스트림에는 재그리기가
      // 겹쳐 쌓여 프롬프트 줄이 통째로 뭉개진다(슬라이스 27). 사유에 그대로 적는다.
      unread = screenUnavailable(s.source);
      last = clean((s.lines || []).filter((l) => l.trim()).slice(-1)[0] || '', 120);
    } catch (e) {
      unread = false;
      last = clean(e.message, 120);
    }
    await sleep(2000);
  }
  const why = unread ? '화면을 못 읽음 (스트림 폴백) — ❯ 유무를 못 가림' : '화면에 ❯ 프롬프트가 안 떴음';
  return { ok: false, detail: why + ' (마지막 줄: ' + last + ')' };
}

/**
 * worktree create 의 결과 모양이 Orca 판올림으로 바뀌어도 경로·id·핸들만 건져낸다.
 * 핸들은 `--agent` 로 띄운 에이전트 창(`agentTerminalHandle`)이 우선이고, 옛 런타임은 `startupTerminal.handle`
 * 에만 있다(`--help` 09-04). 에이전트 없이 만들면 기본 터미널의 핸들이 오는데 그건 안 쓴다 — 헤드리스는
 * 래퍼 창을 따로 연다.
 */
function newWorktreeOf(res) {
  const w = res?.worktree || res;
  const path = w?.path || w?.git?.path;
  if (!path) throw new Error('worktree create 결과에서 경로를 못 찾음: ' + clean(JSON.stringify(res), 300));
  return { id: w.id || null, path, handle: res?.agentTerminalHandle || res?.startupTerminal?.handle || null };
}

/** 터미널 명령 한 줄에 넣을 경로. 공백이 있으면 따옴표로 싼다 (Windows 경로에 흔하다). */
const quoteArg = (v) => (/[\s"]/.test(v) ? '"' + v + '"' : v);

/**
 * 그 슬라이스의 워커를 **터미널 명령 한 줄로** 띄울 때의 명령. 에이전트에 따라 두 갈래다.
 *
 * **`claude`(TUI)**: `claude --model <모델>`. `[어려움]` 만 최상위 모델, 나머지는 표준이다(`sliceModel`).
 * **모델을 빼고 `claude` 만 띄우지 않는다** — 그러면 사용자의 Claude Code 기본값
 * (`~/.claude/settings.json` 의 `model`)을 따라가고, 파견은 그 값이 무엇인지 모른다.
 * 새 파견(슬라이스 26)은 이 명령을 안 쓴다 — Orca 가 `worktree create --agent claude` 로 띄우고 모델은
 * `install` 이 워크트리 설정에 박는다(`dispatchCommand`). 여기 남은 쓰임은 **인계**(`handoffOne` — 있는
 * 워크스페이스에 터미널을 하나 더 여는 자리)뿐이다.
 *
 * **헤드리스**: 에이전트 명령(`codex exec …`)을 여기서 직접 띄우지 않고 **래퍼**
 * (`sp-sync.mjs worker --agent X --slice N`)를 띄운다. Claude 에 묶여 있던 나머지 — 턴 경계
 * 기록·복귀 카드·status.md·회차 방아쇠 — 는 전부 `Stop` 훅이 하던 일이고, 헤드리스에는 그
 * 훅이 없다. 래퍼가 그 역할을 대신하고 에이전트를 자식으로 돌린다 (프로필 표는 `fleetAgents`,
 * 실제 인자 조립은 `agentArgv`). 프롬프트도 래퍼가 안에서 만든다 — 여기서 명령 한 줄에 실으면
 * 셸 따옴표 문제가 생긴다. `[어려움]` 은 래퍼에 `--hard` 로 넘긴다 — 프로필의 `{hard}` 자리가
 * 그때만 펼쳐진다(codex 는 추론 강도 xhigh). 모델을 바꿔 보내는 Claude 쪽과 달리 에이전트는
 * 그대로고 강도만 오른다: 실측(`notes/2026-09-02-codex-xhigh-실측.md`)에서 xhigh 가 답이 정해진
 * 과제의 정답을 다 찾았고, 대가는 비용이 아니라 시간(기본의 6배)이었다.
 */
function workerCommand(slice, { model, hardModel, agents } = {}) {
  const agent = slice.agent || 'claude';
  if (agent !== 'claude') {
    // 모르는 이름은 여기까지 오지 않는다(`dispatchPlan` 이 보류한다). 그래도 손으로 부를 때를
    // 위해 한 번 더 본다 — 없는 프로필로 래퍼를 띄우면 워크스페이스만 만들고 즉시 죽는다.
    if (!(agents || agentTable())[agent]) throw new Error('모르는 에이전트: ' + agent + ' (config.json 의 fleetAgents 에 없다)');
    const hard = slice.tags.includes('hard') ? ['--hard'] : [];
    return [...wrapperPrefix(agent), '--slice', String(slice.number), ...hard].join(' ');
  }
  return 'claude --model ' + requireModel(slice, { model, hardModel });
}

/** 그 슬라이스의 Claude 모델. 빈 값이면 `claude --model undefined` 가 되어 터미널만 죽으니 여기서 잡는다. */
function requireModel(slice, { model, hardModel } = {}) {
  const m = sliceModel(slice, { fleetModel: model, fleetHardModel: hardModel });
  if (!m) throw new Error('띄울 모델이 비어 있음 (config.json 의 ' + (slice.tags.includes('hard') ? 'fleetHardModel' : 'fleetModel') + ')');
  return m;
}

/**
 * **파견**이 그 슬라이스를 띄우는 명령 — 파견 표·회차 보고의 "명령" 열이 이 값이다.
 *
 * 헤드리스는 `workerCommand`(래퍼) 그대로. Claude 는 슬라이스 26 부터 터미널 명령이 아니라 `orca worktree create
 * --agent claude --prompt "<지시>"` 다 — 생성·설정 훅 대기·Claude 기동·첫 프롬프트를 Orca 가 한 명령에 한다
 * (2026-09-04 실측, `notes/2026-09-04-worktree-create-agent-실측.md`). 모델은 그 명령에 실을 자리가 없어
 * `install` 이 워크트리 `.claude/settings.local.json` 의 `model` 로 박는다(`hooks.mjs` 의 `worktreeModelFor` —
 * 같은 `sliceModel` 판정). 여기서 모델을 한 번 더 세는 것은 빈 값을 미리 잡고 표에 드러내기 위해서다.
 * 회차의 `--model`/`--hard-model` 은 이 표시와 인계에만 닿고 `--agent` 파견의 실제 모델은 `config.json` 이다.
 */
function dispatchCommand(slice, text, opts = {}) {
  if ((slice.agent || 'claude') !== 'claude') return workerCommand(slice, opts);
  const m = requireModel(slice, opts);
  return 'orca worktree create --agent claude --prompt ' + quoteArg(text || '') + '  (모델 ' + m + ' — install 이 settings.local.json 에)';
}

/**
 * 래퍼 명령의 앞부분 — `& node sp-sync.mjs worker --agent X`. 슬라이스 파견(`--slice N`)과 착륙의 충돌 턴
 * (`--prompt <문장>`)이 같이 쓴다.
 *
 * **PowerShell 문법이다.** Orca 는 `terminal create --command` 의 그 줄을 워크스페이스 탭의 셸(이 기계에서는
 * pwsh)에 넘기는데, 공백이 든 경로(`C:/Program Files/nodejs/node.exe`)를 따옴표로만 싸면 PowerShell 은 그것을
 * 문자열 식으로 읽고 `ParserError: Unexpected token` 으로 죽는다 — 래퍼는 뜨지도 못한다 (2026-09-02 실측,
 * 세 워커가 따로 재현). 호출 연산자 `&` 를 앞에 두면 따옴표 경로도 한글 프롬프트도 토막 없이 자식 argv 에
 * 닿는다. 프롬프트 안의 `"`·`$`·백틱은 안 다룬다 — 충돌 문장(`conflictText`)에는 없고, 슬라이스 지시는
 * 래퍼가 안에서 만든다(`workerPromptCommand` 가 거른다).
 */
function wrapperPrefix(agent) {
  return ['&', quoteArg(NODE.replace(/\\/g, '/')), quoteArg(SELF.replace(/\\/g, '/')), 'worker', '--agent', agent];
}

/**
 * 헤드리스 워커에게 **한 문장을 시키는** 래퍼 명령 (`worker --agent X --prompt "<문장>"`). 착륙의 충돌
 * 턴이 쓴다 — TUI 에는 `deps.send` 로 REPL 에 쳐 넣지만 헤드리스에는 REPL 이 없어 새 프로세스가 곧
 * 새 턴이다. 수동 인계도 같은 길을 쓰며 `[어려움]` 이면 `hard` 를 받아 래퍼의 `--hard` 로 싣는다.
 * 문장은 터미널 명령줄에 실리므로 큰따옴표·`%`·`$` 가 들어가면 안 된다(`quoteWinArg` 머리 주석).
 * 충돌 문구(`conflictText`)와 고정 인계 문구(`handoffPrompt`)에는 그런 글자가 없다.
 */
function workerPromptCommand(agent, prompt, agents, hard = false) {
  if (!(agents || agentTable())[agent]) throw new Error('모르는 에이전트: ' + agent + ' (config.json 의 fleetAgents 에 없다)');
  if (/["%$]/.test(prompt)) throw new Error('래퍼 프롬프트에 쓸 수 없는 글자(" % $)가 있음: ' + clean(prompt, 80));
  return [...wrapperPrefix(agent), '--prompt', quoteArg(prompt), ...(hard ? ['--hard'] : [])].join(' ');
}

/**
 * 파견이 남긴 **여분 탭을 닫아 Claude 탭만 남긴다** (슬라이스 7).
 *
 * 파견된 워크스페이스에는 탭이 여럿 뜬다. 헤드리스(2026-09-01 실측)는 셋 — Orca 가 `worktree create` 때
 * 만드는 기본 터미널("Terminal 1"), 설정 스크립트(`sp-sync.mjs install`)가 돈 pwsh 탭, 파견이
 * `terminal create --command "<래퍼>"` 로 연 탭. `--agent claude` 파견(슬라이스 26)은 둘 — 에이전트 창이
 * 곧 기본 터미널이고 설정 pwsh 탭이 남는다. 사용자가 워크스페이스를 눌러도 정작 일하는 창이 바로 안 보인다.
 *
 * **설정 스크립트가 끝난 뒤에만 부른다** — TUI 는 훅 기록(`waitForSession`)이 생긴 뒤(Orca 가 설정을 끝내고
 * Claude 를 띄운 뒤라 확실하다), 헤드리스는 훅 파일 + 틈(`HEADLESS_SETTLE_MS`) 뒤. 도는 중에 닫으면 install 이
 * 중간에 끊긴다. 그 시점의 기본 터미널은 셸 프롬프트만 뜬 빈 껍데기라 잃는 것이 없다.
 *
 * **던지지 않는다.** 탭 정리는 덤이고 지시 전송이 본디 일이다 — 목록 조회든 닫기든 실패하면
 * 그 사실만 적어 돌려주고 파견은 그대로 간다.
 */
function closeExtraTabs(path, keep, io = TERMINAL_IO) {
  let list;
  try {
    list = listTerminals(io);
  } catch (e) {
    return { closed: [], failed: [], detail: '탭 정리 못 함 — 목록 조회 실패: ' + clean(e.message, 120) };
  }
  // 같은 워크스페이스의, 남길 창이 아닌, 살아 있는 창만. `keep` 이 비어 있으면 아무것도 안 닫는다 —
  // 남길 창을 모르는 채로 닫으면 방금 띄운 Claude 창까지 닫는다.
  const others = keep
    ? list.filter((t) => t.connected !== false && !t.orphaned && normPath(t.worktreePath) === normPath(path) && t.handle !== keep)
    : [];
  const closed = [];
  const failed = [];
  for (const t of others) {
    try {
      io.close(t.handle);
      closed.push(t.handle);
    } catch (e) {
      failed.push({ handle: t.handle, detail: clean(e.message, 120) });
    }
  }
  const parts = [];
  if (closed.length) parts.push('여분 탭 ' + closed.length + '개 닫음');
  if (failed.length) parts.push('탭 ' + failed.length + '개 못 닫음: ' + failed.map((f) => f.detail).join(' · '));
  return { closed, failed, detail: parts.join(' · ') };
}

/**
 * 파견의 준비·제출 신호 — **훅 기록**이다 (슬라이스 26).
 *
 * `worktree create --agent claude --prompt` 는 Orca 가 설정 훅(`install`)을 끝낸 뒤 Claude 를 띄우고 첫 프롬프트를
 * 넣는다(2026-09-04 실측 — 설정 탭이 끝난 5초 뒤 첫 프롬프트). 그 프롬프트가 들어가면 `prompt` 훅이 세션 기록에
 * 그 워크트리의 `turnStartedAt` 을 찍는다. 그래서 화면(`❯`)·`tui-idle`·제출 확인 대신 세션 기록 하나를 본다 —
 * 기록이 생겼다는 것은 **훅이 깔린 채 떴고 지시가 제출됐다**는 뜻이라, 옛 경로의 두 실패(훅 없이 뜸·미제출)를
 * 한 자리에서 잡는다. `since` 보다 앞선 기록은 안 센다 — 지난 단계의 같은 번호 워크스페이스 기록이 7일간 남는다.
 * 못 기다리면 여기서 지시를 다시 보내지 않는다 — 그건 다음 회차의 재파견(`undispatchedCheck`) 몫이다.
 * `state()` 가 반쯤 쓰인 파일에 던지면 그 번은 건너뛰고 다시 본다.
 */
async function waitForSession(path, since, timeoutMs) {
  const want = normPath(path);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const hit = Object.values(state().sessions || {}).find((e) => normPath(e.worktree) === want && (e.turnStartedAt || 0) >= since);
      if (hit) return { ok: true, session: hit.firstPrompt || '' };
    } catch {}
    await sleep(2000);
  }
  return { ok: false, detail: '훅 기록이 안 생김 (' + Math.round(timeoutMs / 1000) + '초) — 세션이 훅 없이 떴거나 프롬프트 미제출. 지시는 다음 회차가 재파견한다' };
}

/**
 * `dispatchOne` 이 바깥(Orca·git·시계)과 닿는 자리. 테스트가 갈아 끼운다 — Orca 없이 "헤드리스는
 * create 만 부르고 프롬프트·유휴·전송은 안 탄다"를 확인하려고. 실제 값은 전부 위의 함수들이다.
 */
const DISPATCH_DEPS = {
  // 같은 이름의 폴더가 워크스페이스 폴더 밑에 이미 있으면 그 경로. 못 알아내면 null — 만든 뒤의 이름 확인이 받는다.
  nameTaken: (root, name) => {
    try {
      const p = join(workspacesDirOf(root), name);
      return existsSync(p) ? p : null;
    } catch {
      return null;
    }
  },
  createWorktree: (args, ms) => newWorktreeOf(orcaJson(['worktree', 'create', ...args], ms)),
  waitForSession,
  createTerminal: (args, ms) => {
    const t = orcaJson(['terminal', 'create', ...args], ms);
    return t?.terminal?.handle || t?.handle || null;
  },
  waitForHooks,
  waitForPrompt,
  // 헤드리스 파견 직후 "정말 떴는가"를 보는 재료 (`watchHeadlessStart`).
  sessions: () => state().sessions || {},
  waitIdle: (handle, ms) => orcaJson(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(ms)], ms + 15000),
  closeExtraTabs: (path, keep) => closeExtraTabs(path, keep),
  send: (handle, text) => sendInstruction(handle, text),
  projectOf: (path) => fleetProjectOf(path, new Map()).name,
  sleep,
  // 이름이 밀린 워크스페이스를 되돌릴 때만 쓴다 (아래 `dispatchOne` 의 이름 확인).
  removeWorktree: (repoId, path, ms) => orcaJson(['worktree', 'rm', '--worktree', 'id:' + repoId + '::' + path, '--force'], ms),
  removeDir: (path, root) => removeWorkspaceDir(path, root),
  // 워크스페이스 카드의 보드 상태. 실패해도 파견은 그대로 간다 — 표시일 뿐이다.
  setStatus: (path, status, ms) => orcaJson(['worktree', 'set', '--worktree', 'path:' + path, '--workspace-status', status], ms),
};

// 헤드리스 파견이 훅 파일을 본 뒤 래퍼를 띄우기까지 두는 틈. 훅 파일(`settings.local.json`)은 `install` 의
// **마지막** 쓰기가 아니다 — git 훅과 AGENTS.md(슬라이스 3)가 그 뒤 몇 ms 에 써진다. TUI 는 Claude 가
// 뜨는 몇 초가 그 틈을 덮지만, 래퍼는 곧바로 에이전트를 띄우고 에이전트는 뜨자마자 AGENTS.md 를 읽는다.
// 여분 탭(설정 스크립트가 도는 pwsh)을 닫는 것도 이 뒤다 — 도는 중에 닫으면 install 이 중간에 끊긴다.
const HEADLESS_SETTLE_MS = 3000;

// 래퍼를 띄운 뒤 "정말 떴는가"를 세션 기록으로 보는 창. 래퍼는 에이전트를 spawn 하기 **전에**
// 기록을 쓰므로 보통 첫 폴링에서 끝난다 — 이 상한을 다 쓰는 것은 기록이 아예 안 생긴 때뿐이다.
const HEADLESS_EXIT_WATCH_MS = 15000;
const HEADLESS_WATCH_POLL_MS = 1500;

/**
 * 헤드리스 래퍼를 띄운 **직후** 세션 기록으로 시작을 확인한다 (coordinator 점검 #6).
 *
 * 파견은 래퍼를 띄우는 것까지다 — 래퍼가 exit 75(겹친 턴)나 CLI 부재로 곧바로 죽어도 `terminal
 * create` 는 성공으로 돌아온다. 그러면 그 슬라이스는 "파견됨"으로 남아 아무도 안 보고, 다음
 * 회차는 활성 워크스페이스가 있다고 여겨 다시 안 띄운다. 래퍼는 spawn 전에 기록을 쓰고 끝날 때
 * `turnEndedAt`·`exitCode` 를 찍으므로(`lib/worker.mjs`) 기록 하나로 셋이 갈린다:
 * 도는 중 · 이미 끝남(`known && !active`) · 아직 없음.
 *
 * **없음을 죽음으로 읽지 않는다.** 기록이 안 생기면 "기록 미확인"만 붙이고 시작으로 둔다 —
 * 느린 기계에서 이 창을 넘길 수 있고, 죽었다고 세면 다음 회차가 그 폴더를 헛되이 다시 만든다.
 * `since` 보다 앞선 기록은 안 본다: 같은 이름의 지난 워크스페이스 기록이 state 에 7일 남는다.
 */
async function watchHeadlessStart(path, since, timeoutMs, deps) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let sessions = {};
    try {
      sessions = deps.sessions();
    } catch {} // 반쯤 쓰인 state.json — 다음 폴링에서 다시 읽는다
    const fresh = Object.fromEntries(Object.entries(sessions || {}).filter(([, e]) => (e.turnStartedAt || 0) >= since));
    const t = turnStateFor(path, fresh);
    if (t.known && !t.active) return { exited: { exitCode: t.exitCode ?? null }, note: ' — 즉시 종료' + (t.exitCode == null ? '' : ' exit ' + t.exitCode) };
    if (t.known || t.stale) return { exited: null, note: '' };
    if (Date.now() >= until) return { exited: null, note: ' (기록 미확인)' };
    await deps.sleep(Math.min(HEADLESS_WATCH_POLL_MS, Math.max(0, until - Date.now())));
  }
}

/**
 * 한 슬라이스를 실제로 띄운다. 던지지 않는다 — 한 슬라이스의 실패가 다음 것을 막으면 안 된다.
 * 실패해도 **워크스페이스는 지우지 않는다.** 사람이 보고 이어받거나 지우는 편이 낫다.
 *
 * 에이전트에 따라 두 갈래다. **TUI(`claude`)**(슬라이스 26): 이름 확인 → `worktree create --agent claude
 * --prompt "/slice N"` → 카드 상태 → **훅 기록 대기**(`waitForSession`) → 여분 탭 닫기. 생성·설정 훅 대기·
 * Claude 기동·첫 프롬프트를 Orca 가 하고, 모델은 `install` 이 워크트리 설정에 박는다(`dispatchCommand`). 예전의
 * 여섯 단계(훅 파일 → 터미널 → 화면의 `❯` → `tui-idle` → 전송 → 재전송)는 없다 — `waitForPrompt`·`sendInstruction`
 * 은 재파견·충돌 루프·`wake`·인계가 그대로 쓴다. **헤드리스**(4단계): 워크스페이스 → 훅 파일 → 터미널
 * (`--command "<래퍼>"`) → 여분 탭 닫기로 **끝**이다 — 지시는 명령줄에 실려 이미 들어갔고, 준비 신호·유휴·제출
 * 확인은 REPL 의 것이라 여기엔 없으며, 턴 경계·카드는 래퍼가 찍는다(`lib/worker.mjs`). 프로세스가 끝나도 탭은
 * 셸 프롬프트로 남는다 (2026-09-02 실측 — `cmd /c exit 3` 뒤 탭 유지·`connected: true`·`wait --for exit` 는
 * 셸이 살아 있어 시간 초과). 그래서 끝났는지는 창이 아니라 세션 기록(`turnStateFor`)으로 읽는다 — 파견의 미파견
 * 판정과 착륙 둘 다.
 */
async function dispatchOne(slice, opts, deps = DISPATCH_DEPS) {
  const name = 'slice' + slice.number;
  const agent = slice.agent || 'claude';
  const headless = agent !== 'claude';
  // 지시 문구. 워크스페이스가 아직 없으니 본체에서 스킬 유무를 본다 — 스킬 폴더는 추적되는 파일이라 같다.
  const text = headless ? null : sliceCommandFor(opts.root, slice.number);
  let command;
  try {
    command = dispatchCommand(slice, text, opts);
  } catch (e) {
    return { slice: slice.number, name, agent, ok: false, stage: 'model', detail: e.message };
  }
  const step = { slice: slice.number, name, agent, command };
  // **이름 밀림은 create 앞에서 막는다.** 같은 이름의 폴더가 남아 있으면 Orca 가 `slice4-2` 로 비켜 만드는데,
  // 그 이름은 `sliceNumberOf` 에 안 걸려 착륙도 재파견도 그 워크스페이스를 못 찾는다. 예전에는 만든 뒤 창을
  // 열기 전에 잡아 되돌렸는데(2026-09-02: SP-sync 3·4, CW 4), `--agent` 는 create 순간에 창이 열려 되돌려도
  // `strayBlock` 이 걸려 그 프로젝트의 **새 파견이 전부** 멈춘다. 막고 있던 폴더는 다음 회차의 쓸기
  // (`staleWorkspacePlan`)가 치운다. 못 알아냈으면(null) 만든 뒤의 확인이 받는다.
  const taken = deps.nameTaken(opts.root, name);
  if (taken) return { ...step, ok: false, stage: 'name', detail: '같은 이름의 폴더가 남아 있음: ' + taken + ' — 만들지 않음 (다음 회차의 쓸기가 치운다)' };
  // 저장소를 못 박는다. `--repo` 없이는 지금 활성인 저장소에 만들어진다 (2026-08-30 사고).
  const repo = ['--repo', 'id:' + opts.repoId];
  const since = Date.now();
  let wt;
  try {
    // TUI 는 `--agent claude --prompt` 로 Orca 가 띄운다. `--setup run` 은 설정 훅(`install`)을 강제하는 것 —
    // 저장소 정책이 `run-by-default` 여도 명시한다. 헤드리스는 에이전트 없이 만들고 래퍼 창을 따로 연다.
    wt = headless
      ? deps.createWorktree([...repo, '--name', name, '--no-parent'], opts.createMs)
      : deps.createWorktree([...repo, '--name', name, '--no-parent', '--setup', 'run', '--agent', 'claude', '--prompt', text], opts.createMs);
    // 이름이 밀렸으면 도로 지운다 — 위의 확인이 못 알아낸 경우의 안전망이다. TUI 는 창이 이미 열렸으므로
    // 워크트리와 함께 닫힌다.
    if (basename(wt.path) !== name) {
      const got = basename(wt.path);
      try {
        deps.removeWorktree(opts.repoId, wt.path, opts.createMs);
        deps.removeDir(wt.path, opts.root);
      } catch {}
      return { ...step, ...wt, ok: false, stage: 'name', detail: '이름이 밀림: ' + got + ' (원한 것: ' + name + ') — 같은 이름의 폴더가 남아 있다' };
    }
    // 보드 카드를 `in-progress` 로. **이름 확인 뒤**다 — 밀린 이름은 바로 위에서 지우므로
    // 그 워크스페이스에 상태를 찍어봐야 사라진다. 실패는 로그만 남긴다: 카드 색은 표시일 뿐이라
    // 이걸로 파견을 접으면 잃는 것이 더 크다. Orca 는 이 값을 스스로 바꾸지 않는다
    // (2026-09-04 실측 — `notes/2026-09-04-워크스페이스-카드-상태-실측.md`).
    try {
      deps.setStatus(wt.path, 'in-progress', opts.createMs);
    } catch (e) {
      log('워크스페이스 상태(in-progress) 설정 실패: ' + clean(e.message, 200));
    }
    if (headless) {
      // 훅 파일을 먼저 기다린다 — git 훅(커밋을 세션에 붙인다)과 AGENTS.md 가 같은 스크립트에서 나온다.
      if (!(await deps.waitForHooks(wt.path, opts.readyMs))) {
        return { ...step, ...wt, ok: false, stage: 'hooks', detail: '.claude/settings.local.json 이 안 생김 — 지시 안 보냄' };
      }
      await deps.sleep(HEADLESS_SETTLE_MS);
      wt.handle = deps.createTerminal(['--worktree', 'id:' + wt.id, '--title', name, '--command', command], opts.createMs);
    }
  } catch (e) {
    return { ...step, ...(wt || {}), ok: false, stage: 'create', detail: clean(e.message, 300) };
  }
  // 만들어진 자리가 맞는지 한 번 더 본다. 틀렸으면 보고한다 — 엉뚱한 저장소의 세션에 "슬라이스 N 진행"이
  // 들어가면 그 세션이 없는 슬라이스를 찾아 헤맨다. (둘 다 이 시점에 이미 떠 있다 — 사람이 그 창을 닫을 몫이다.)
  const made = deps.projectOf(wt.path);
  if (made !== opts.project) {
    return { ...step, ...wt, ok: false, stage: 'repo', detail: '엉뚱한 저장소에 생성됨: ' + made + ' (원한 것: ' + opts.project + ')' };
  }
  if (!wt.handle) return { ...step, ...wt, ok: false, stage: 'terminal', detail: '터미널 핸들을 못 받음' };
  if (headless) {
    const tabs = deps.closeExtraTabs(wt.path, wt.handle);
    // 래퍼는 **띄우는 것까지**가 파견이라 곧바로 죽어도 여기까지는 성공으로 온다. 그래서 세션
    // 기록을 잠깐 더 본다 — 안 보면 exit 75(겹친 턴)·CLI 부재로 즉시 끝난 워커가 "파견됨"으로
    // 남아 아무도 안 본다 (coordinator 점검 #6). `text` 에 래퍼 명령을 싣는다 — 파견 표·회차 보고의
    // "지시" 열이 그 값을 쓴다.
    const seen = await watchHeadlessStart(wt.path, since, opts.exitWatchMs ?? HEADLESS_EXIT_WATCH_MS, deps);
    return { ...step, ...wt, text: command, tabs, ok: true, stage: 'create', submit: '래퍼 실행 (' + agent + ')' + seen.note, exited: seen.exited, detail: '' };
  }
  // 준비·제출 신호 하나: 이 워크트리의 새 훅 기록. 설정 훅이 끝난 뒤에야 Claude 가 뜨므로 기록이 있으면
  // 설정 스크립트(여분 탭)도 끝나 있다 — 그래서 탭 정리는 이 뒤다.
  const ready = await deps.waitForSession(wt.path, since, opts.readyMs);
  if (!ready.ok) return { ...step, ...wt, text, ok: false, stage: 'session', detail: ready.detail };
  const tabs = deps.closeExtraTabs(wt.path, wt.handle);
  return { ...step, ...wt, text, tabs, ok: true, stage: 'session', submit: 'Orca 가 제출 · 훅 기록 확인', detail: '' };
}

/**
 * 지시를 보낼 창을 고른다. **파견된 워크스페이스에는 창이 셋이다** — Orca 가 만드는 기본
 * 터미널("Terminal 1"), 설정 스크립트가 돈 pwsh 탭, 파견이 연 Claude 탭. `terminals[0]` 은
 * Orca 목록 순서일 뿐이라 셸 탭에 `/slice 3` 을 쳐 넣을 수 있다 — 그러면 지시는 어디에도
 * 안 들어가고 재파견은 "미제출"로 끝난다.
 *
 * 그래서 화면을 보고 **Claude 프롬프트(`❯`)가 뜬 창**을 고른다 (`hasClaudePrompt` — 파견의
 * 준비 신호와 같은 잣대).
 *
 * 창이 여럿인데 하나도 안 맞으면 **null 이다 — 첫 창으로 떨어지지 않는다.** 모르는 채로 보내면
 * 셸 탭에 지시가 쳐 넣어져 어디에도 안 들어가고, 부른 쪽은 "보냈다"로 세고 넘어간다. 못 골랐다고
 * 말하는 편이 낫다. 창이 하나뿐이면 고를 것이 없으므로 화면을 읽지 않고 그 창이다.
 */
function claudeTerminal(terminals, io = TERMINAL_IO) {
  const list = terminals || [];
  // 하나뿐이면 고를 것이 없다 — 화면을 읽지 않는다 (창당 orca 호출 하나를 아낀다).
  if (list.length < 2) return list[0] || null;
  for (const h of list) {
    try {
      if (hasClaudePrompt(io.read(h).lines)) return h;
    } catch {}
  }
  return null;
}

/**
 * 이미 있는 워크스페이스에 지시를 다시 보낸다 (슬라이스 16). **워크스페이스를 만들지 않는다** —
 * 폴더도 세션도 이미 있고, 없는 것은 지시뿐이다. 제출 확인은 파견과 같은 길을 쓴다
 * (`sendInstruction` — 보내고 화면으로 확인, 안 되면 한 번만 재전송).
 */
async function redispatchOne(slice, w, io = TERMINAL_IO) {
  const step = { slice: slice.number, name: w.name, path: w.path, redispatch: true };
  // 헤드리스에는 REPL 이 없다 — 보낼 입력창이 없고, 래퍼를 다시 띄우면 반쯤 한 일 위에 같은 지시가
  // 겹친다. `undispatchedCheck` 가 헤드리스를 재파견 대상으로 내지 않으므로 여기까지 오지 않지만,
  // 손으로 부르거나 판정이 어긋났을 때 셸 탭에 `/slice N` 을 쳐 넣는 것만은 막는다.
  const headless = headlessOf(w) || (slice.agent && slice.agent !== 'claude' ? slice.agent : null);
  if (headless) return { ...step, ok: false, stage: 'headless', detail: '헤드리스(' + headless + ') 워크스페이스는 재파견하지 않음 — REPL 이 없다' };
  const handle = claudeTerminal(w.terminals, io);
  if (!handle) {
    // 잠든 창은 보낼 곳이 없다 — CLI 로 못 깨운다 (슬라이스 28). 사람이 탭을 열면 `claude --resume` 으로 돌아온다.
    const asleep = sleepingOf(w);
    return {
      ...step,
      ok: false,
      stage: 'terminal',
      detail: (w.terminals || []).length
        ? '창은 ' + w.terminals.length + '개인데 Claude 창을 못 고름 (화면에 ❯ 가 없다)'
        : asleep
          ? asleep.text + ' — ' + SLEEP_WAKE_HINT
          : '창이 없음',
    };
  }
  const text = sliceCommandFor(w.path, slice.number);
  const r = await sendInstruction(handle, text, io);
  return {
    ...step,
    handle,
    text,
    ok: r.result === 'submitted',
    stage: 'send',
    submitted: r.result,
    // 보고에서 첫 파견과 구별된다 — 같은 슬라이스가 두 번 뜬 것처럼 읽히면 안 된다.
    submit: '재파견 · ' + r.submit,
    resent: r.resent,
    detail: r.detail || '',
  };
}

async function fleetDispatch(arg, { max, dryRun, json, quiet, model, hardModel, agents, readyMs, createMs, idleMs, base, sync, slices, limits, startPct, maxTotal, total, held }) {
  const r = slices || fleetSlices(arg);
  const cfg = config();
  // 한도는 **계정 단위**라 슬라이스마다 다시 읽을 것이 없다 — 한 번 읽어 판정에 나눠 쓴다.
  // 테스트와 회차가 값을 넣어 줄 수 있다(회차는 인계 단계에서 이미 읽었다).
  const limitTable = limits || allLimits();
  const startAt = startPct ?? cfg.fleetLimitStartPct;
  const limitHold = (s) => limitStartHold(s, limitTable, { startPct: startAt, hardModel: hardModel || cfg.fleetHardModel });
  // 에이전트 프로필 표. 진입점이 안 넘겨도 여기서 읽는다 — 파견의 판정(모르는 이름 보류)과
  // 명령(래퍼)이 같은 표를 봐야 dry-run 이 실제와 같은 결과를 낸다.
  const agentsTable = agents || agentTable();
  // 본체를 origin 과 맞춘다 — 여기서 읽은 PLAN.md 는 본체 것이고 새 워크스페이스는 origin 에서
  // 갈라지므로, 둘이 다르면 워커가 옛 계획을 받는다. 회차가 불렀으면 착륙 앞에서 이미 했고 그
  // 결과를 넘겨받는다. 남는 막힘은 갈라짐과 push 실패뿐이다 — 사람만 풀 수 있는 둘 (슬라이스 19).
  const sm = sync || syncMain(repoRoot(r.root), { base, dryRun });
  const block = sm.block;
  // 지시를 못 받은 채 서 있는 워크스페이스 찾기. **dry-run 에서도 본다** — 미리 보는 것이
  // dry-run 의 용도이므로, 여기서 건너뛰면 회차가 무엇을 할지가 dry-run 과 달라진다.
  const baseRef = (sm.hasRemote ? 'origin/' : '') + sm.baseBranch;
  for (const w of r.workspaces) {
    const s = r.slices.find((x) => x.workspace === w);
    if (!s || s.done) continue; // 체크된 슬라이스는 착륙 몫이다
    // 같은 회차의 착륙이 이미 쟀으면 그 값을 쓴다 — 창당 5초 유휴 대기를 두 번 하지 않는다.
    if (!w.stalled) w.stalled = undispatchedCheck(w, { baseRef, idleMs, text: sliceCommandFor(w.path, s.number) });
  }
  // 본체 PLAN.md 가 커밋 전이면 새 파견을 접는다 — dry-run 도 같은 판정을 보여 준다.
  const planDirty = planDirtyBlock(repoRoot(r.root));
  // 공유 자원 예약과 전역 활성 수 (슬라이스 42). 회차가 부르면 한 바퀴에 한 번 센 값을 넘겨받고,
  // 손으로 부르면 여기서 읽는다 — 둘이 같은 값을 봐야 dry-run 이 실제와 같은 사유를 낸다.
  const heldTable = held || heldResources();
  const capTotal = Number(maxTotal ?? cfg.fleetMaxWorkspacesTotal);
  const totalActive = Number.isFinite(total) ? total : globalActiveCount();
  const plan = dispatchPlan({
    slices: r.slices,
    workspaces: r.workspaces,
    max,
    block,
    limitHold,
    planDirty,
    allSlices: r.allSlices,
    held: heldTable,
    project: r.project,
    total: totalActive,
    maxTotal: capTotal,
  });
  const picked = plan.filter((p) => p.eligible);
  // 그 슬라이스가 뜬다면 어떤 명령인가. 판정과 무관하게 계산한다 — dry-run 이 보류된 헤드리스
  // 슬라이스의 래퍼 명령까지 보여 주는 자리라서. 못 만들면(모르는 에이전트·빈 모델) null.
  const commandOf = (s) => {
    try {
      return dispatchCommand(s, sliceCommandFor(r.root, s.number), { model, hardModel, agents: agentsTable });
    } catch {
      return null;
    }
  };
  const out = {
    at: Date.now(),
    project: r.project,
    root: r.root,
    phase: r.phase,
    max,
    active: activeCount(r.workspaces),
    // 전역 상한의 재료. `--json` 에 싣는다 — "왜 자리가 남았는데 안 떴나"를 되짚는 유일한 자리다.
    maxTotal: capTotal,
    totalActive,
    // 지금 잡혀 있는 공유 자원. 표 아래 한 줄과 `--json` 이 쓴다.
    held: Object.values(heldTable),
    sync: sm,
    block,
    // 이름을 못 읽는 창이 살아 있어 새 파견을 접었다 (슬라이스 24). `block` 과 달리 재파견은 간다.
    createBlock: strayBlock(r.workspaces),
    // 본체 PLAN.md 미커밋 — 새 파견을 접었다 (재파견은 간다). 사람이 커밋하면 풀린다.
    planBlock: planDirty,
    // 현재 단계의 슬라이스가 전부 체크됐다 — 파견할 것이 없어 회차가 조용히 0건이 되는 상태.
    // 전역 워크플로우의 "단계 끝 → 최상위 모델로 다음 단계 재계획"을 누군가 불러야 한다 (슬라이스 10)
    phaseDone: r.slices.length > 0 && r.slices.every((s) => s.done),
    // 체크박스는 있는데 슬라이스로 한 줄도 안 읽혔다 — 구문이 어긋난 계획이다. 이러면 파견이
    // 조용히 0건이 되고 표도 비어서 아무도 눈치채지 못한다 (Project A 2026-08-30).
    // 구문을 넓혀 받아 주지는 않는다 (형식이 둘이 되면 셋이 된다) — 사람에게 올린다.
    planSyntax:
      r.slices.length === 0 && r.strayChecks > 0
        ? 'PLAN.md 구문이 안 맞음 — 체크박스 ' + r.strayChecks + '줄이 슬라이스로 안 읽힘 (`- [ ] **N. 제목**` 꼴이어야 한다)'
        : null,
    dryRun: !!dryRun,
    // 워크스페이스 폴더에 남은 고아. **판정은 dry-run 에서도 하고 삭제는 실제 파견에서만 한다.**
    // 이것이 있으면 Orca 가 `slice4-2` 로 비켜 만들고 그 워크스페이스는 영영 착륙하지 못한다.
    stale: staleWorkspacePlan(repoRoot(r.root)),
    decisions: plan.map((p) => ({
      number: p.slice.number,
      title: p.slice.title,
      tags: p.slice.tags,
      deps: p.slice.deps || [],
      resources: p.slice.resources || [],
      unknownTags: p.slice.unknownTags || [],
      // 계획 오류 — 회차 보고가 "왜 이 슬라이스가 영영 안 뜨나"를 되짚는 자리다.
      errors: p.slice.errors || [],
      // 어느 에이전트로 뜨는가. `claude` 도 그대로 싣는다 — 표는 비워도 --json 은 채운다
      // (회차 보고가 "이건 헤드리스였다"를 나중에 되짚는 유일한 자리다).
      agent: p.slice.agent || 'claude',
      command: commandOf(p.slice),
      eligible: p.eligible,
      reason: p.reason,
      // 재파견은 새 워크스페이스를 안 만든다. dry-run 보고가 "새로 띄운다"로 읽히면 안 된다.
      redispatch: p.redispatch ? p.redispatch.name : null,
    })),
    dispatched: [],
  };
  if (!dryRun && picked.length) {
    // 저장소 id 를 **띄우기 전에** 한 번 푼다. 못 풀면 아무것도 안 만든다.
    // 재파견만 있는 회차는 워크스페이스를 안 만드므로 이 조회 자체가 필요 없다.
    const repoId = picked.some((p) => !p.redispatch) ? repoIdOf(r.root) : null;
    out.repoId = repoId;
    // 이름을 비워 두고 시작한다 — 만들기 직전이어야 방금 착륙한 것까지 걷힌다.
    // 재파견만 있는 회차는 워크스페이스를 안 만드니 건드리지 않는다.
    if (repoId) {
      out.swept = sweepStaleWorkspaces(out.stale);
      if (out.swept.removed.length) log('fleet dispatch ' + r.project + ' 고아 폴더 ' + out.swept.removed.join(', ') + ' 삭제');
    }
    for (const p of picked) {
      const d = p.redispatch
        ? await redispatchOne(p.slice, p.redispatch)
        : await dispatchOne(p.slice, { model, hardModel, agents: agentsTable, readyMs, createMs, repoId, project: r.project, root: repoRoot(r.root) });
      // **시도가 아니라 결과**를 한 낱말로 남긴다 — 회차 보고·통지가 이 값으로 센다
      // (coordinator 점검 #6). `exited` 는 래퍼가 곧바로 죽은 것이고(`watchHeadlessStart`),
      // 재파견은 워크스페이스를 안 만들므로 보내졌으면 그대로 `started` 다.
      d.outcome = !d.ok ? 'failed' : d.exited ? 'exited' : 'started';
      // **워크스페이스가 생긴 직후에 자원을 잡는다** (슬라이스 42). 실패한 파견도 폴더는 남을 수 있으므로
      // 경로가 있으면 잡는다 — 사람이 그 폴더에서 이어받는 동안에도 자원은 그쪽 것이다. 재파견은 이미
      // 자기 예약을 쥐고 있는 것이 보통이지만, 없으면(회수가 앞서 돌았거나 예약 전에 뜬 창) 여기서 잡는다.
      const wsPath = d.path || p.redispatch?.path || null;
      if ((p.slice.resources || []).length && wsPath) {
        d.resources = reserveResources({ names: p.slice.resources, project: r.project, slice: p.slice.number, workspace: wsPath });
        if (!d.resources.ok) log('fleet dispatch ' + r.project + ' slice' + p.slice.number + ' 자원 예약 실패 — ' + (d.resources.conflicts || []).map(heldText).join(' · '));
      }
      out.dispatched.push(d);
      // 탭 정리는 파견의 성패와 별개다 — 성공 줄에도 실패 줄에도 같은 꼬리로 붙인다.
      const tail = d.tabs?.detail ? ' · ' + d.tabs.detail : '';
      log('fleet dispatch ' + r.project + ' slice' + d.slice + ' ' + dispatchResultText(d) + tail);
      if (!json && !quiet) console.log('  ' + d.name + '  ' + dispatchResultText(d) + (d.ok ? ' — ' + d.text : '') + tail);
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  else if (!quiet) process.stdout.write(renderDispatch(out));
  return out;
}

function renderDispatch(o) {
  const L = [
    o.project + '  —  ' + (o.phase?.title || '(단계 없음)'),
    (o.dryRun ? '(dry-run) ' : '') + '활성 ' + o.active + ' · 상한 ' + o.max + (o.maxTotal ? ' · 전역 ' + (o.totalActive ?? '?') + '/' + o.maxTotal : ''),
    '',
  ];
  // 막힘 사유를 표 위에 한 줄로 먼저 낸다 — 슬라이스마다 같은 말이 반복되는 표만 보면
  // "왜 하나도 안 뜨나"를 표에서 읽어내야 한다.
  if (o.block) L.push('⚠ ' + o.block + ' — 이번 회차 파견 없음', '');
  if (o.createBlock) L.push('⚠ ' + o.createBlock + ' — 새 파견 없음 (재파견은 그대로)', '');
  if (o.planBlock) L.push('⚠ ' + o.planBlock + ' — 새 파견 없음 (재파견은 그대로)', '');
  // 본체를 못 읽어 동기화를 건너뛴 사정(원격 없음·`origin/<base>` 못 읽음·다른 브랜치). 예전에는
  // 여기서 `o.unpushed` 를 봤는데 그 열쇠는 출력에 없어 **한 번도 뜨지 않는 죽은 가지**였다.
  // 다른 ⚠ 와 `else` 로 묶지 않는다 — 미분류 창 보류가 이 줄을 삼키면 안 된다.
  if (o.sync?.action === 'skip' && o.sync.detail) L.push('⚠ 본체 동기화 건너뜀 — ' + o.sync.detail, '');
  // **`dispatch` 는 본체를 origin 과 맞춘다 — push 까지 한다** (2026-09-01 결정, 슬라이스 3).
  // 회차가 부르면 착륙 앞에서 이미 했고, 손으로 부르면 여기서 한다: 파견이 읽는 PLAN.md 는
  // 본체 것이고 새 워크스페이스는 origin 에서 갈라지므로, 안 맞추면 워커가 옛 계획을 받는다
  // (2026-08-30 에 두 모양으로 다 터졌다 — `unpushedAhead` 주석). 한 줄로 무엇을 했는지 남긴다.
  if (!o.block && o.sync?.text) L.push('본체 — ' + o.sync.text, '');
  if (o.planSyntax) L.push('⚠ ' + o.planSyntax, '');
  // 잡혀 있는 공유 자원. 평소에는 0개라 아무 줄도 안 는다 — 있으면 "왜 자원 점유로 보류됐나"의 근거다.
  if (o.held?.length) L.push('점유 자원 — ' + o.held.map(heldText).join(' · '), '');
  // 고아 폴더는 한 줄로만 낸다 — 평소에는 0개라 아무 줄도 안 는다. dry-run 에서는 "지운다"가
  // 아니라 "지울 것"으로 적는다: 이 명령은 dry-run 에서 파일을 안 지운다.
  const staleNames = (o.swept?.removed || []).concat(o.swept ? [] : (o.stale?.stale || []).map((x) => x.name));
  if (staleNames.length) L.push((o.swept ? '고아 폴더 삭제 — ' : '(dry-run) 지울 고아 폴더 — ') + staleNames.join(', '), '');
  if (o.swept?.failed?.length) L.push('⚠ 고아 폴더를 못 지움 — ' + o.swept.failed.map((f) => f.name + ': ' + f.detail).join(' · '), '');
  if (o.stale?.kept?.length) L.push('남긴 폴더 — ' + o.stale.kept.map((k) => k.name + ' (' + k.why + ')').join(' · '), '');
  const cols = [
    ['번호', 5, (d) => String(d.number)],
    ['판정', 7, (d) => (d.eligible ? (d.redispatch ? '재파견' : '파견') : '보류')],
    // `fleet slices` 와 같은 잣대 — claude 는 빈 칸이다 (거의 모든 줄이 claude 다).
    ['에이전트', 12, (d) => (!d.agent || d.agent === 'claude' ? '' : d.agent)],
    ['이유', 44, (d) => d.reason],
    ['제목', 40, (d) => d.title],
  ];
  const line = (cells) => cells.map(([v, w]) => fitCell(v, w)).join('  ').replace(/\s+$/, '');
  L.push(line(cols.map(([h, w]) => [h, w])), cols.map(([, w]) => '-'.repeat(w)).join('  '));
  for (const d of o.decisions) L.push(line(cols.map(([, w, f]) => [f(d), w])));
  // 헤드리스 슬라이스는 래퍼 명령을 그대로 보여 준다 — dry-run 은 "무엇이 뜰지"를 미리 보는 자리이고,
  // 프로필(`fleetAgents`)을 손본 뒤 확인할 곳이 여기뿐이다. 보류된 것도 적는다 (뜨면 이 명령이다).
  const cmds = o.decisions.filter((d) => d.agent && d.agent !== 'claude' && d.command);
  if (o.dryRun && cmds.length) {
    L.push('', '헤드리스 래퍼 명령:');
    for (const d of cmds) L.push('  slice' + d.number + '  ' + d.command);
  }
  const n = o.decisions.filter((d) => d.eligible).length;
  // "띄운 것" 이라고 쓰지 않는다 — 재파견은 있는 창에 지시만 보내지 워크스페이스를 안 만든다.
  const re = o.dispatched.filter((d) => d.redispatch).length;
  // 즉시 종료한 래퍼는 "보낸 것"이 아니다 — 시도 수로 세면 create 실패·즉시 종료가 정상으로 읽힌다.
  const started = o.dispatched.filter((d) => (d.outcome ? d.outcome === 'started' : d.ok)).length;
  L.push('', o.dryRun ? '파견 대상 ' + n + '개 (dry-run 이라 안 띄움)' : '보낸 것 ' + started + '/' + n + (re ? ' (재파견 ' + re + ')' : ''));
  return L.join('\n') + '\n';
}

// ---------- fleet handoff ----------
const HANDOFF_PROMPT = '슬라이스 {N} 이어받기. 워크트리의 미커밋 변경과 PLAN.md 인계 메모를 먼저 읽고 이어서 진행.';

function handoffPrompt(n) {
  return HANDOFF_PROMPT.replace('{N}', String(n));
}

/**
 * `fleet handoff` 의 판정. **부수효과가 없다** — dry-run 과 실제 인계가 같은 답을 쓴다.
 *
 * 인계는 새 워크스페이스를 만들지 않고, 이미 멈춘 워커의 폴더에 다른 에이전트 턴 하나를 연다.
 * 그래서 대상 폴더뿐 아니라 살아 있는 창과 끝난 턴 기록이 모두 있어야 한다. 창이 없으면 어디에
 * 띄울지 Orca 쪽 식별자가 없고, 기록이 없으면 현재 에이전트와 턴 종료 여부를 추측하게 된다.
 * `stale` 은 유휴가 아니라 **끝을 못 찍은 열린 턴**이므로 인계하지 않는다.
 */
function handoffPlan({ number, slice, workspace, to, agents, now = Date.now() }) {
  const n = Number(number ?? slice?.number);
  const base = {
    number: Number.isInteger(n) ? n : null,
    name: workspace?.name || (Number.isInteger(n) ? 'slice' + n : ''),
    path: workspace?.path || null,
    from: workspace?.turn?.agent || null,
    to: String(to || '').trim() || null,
    hard: !!slice?.tags?.includes('hard'),
  };
  const at = (reason) => ({ ...base, eligible: false, reason });
  if (!Number.isInteger(n) || n < 1) return at('슬라이스 번호가 필요함');
  if (!slice) return at('PLAN.md 현재 단계에 ' + n + '번이 없음');
  if (slice.done) return at(n + '번은 이미 완료됨');
  if (!base.to) return at('--to <에이전트>가 필요함');
  if (base.to !== 'claude' && !(agents || {})[base.to]) return at('대상 에이전트 ' + base.to + ' 가 config.json 의 fleetAgents 에 없음');
  if (!workspace) return at('slice' + n + ' 워크스페이스가 없음');
  if (!(workspace.terminals || []).length) return at('slice' + n + ' 에 살아 있는 창이 없음');
  const turn = workspace.turn;
  // turnStateFor 는 TUI 도 `agent: claude` 를 명시한다. 이름이 없다는 것은 훅/래퍼 기록을 못
  // 읽었다는 뜻이지 계획상의 에이전트를 대신 믿을 자리가 아니다.
  if (!turn?.agent) return at('slice' + n + ' 의 턴 기록이 없음');
  if (turn.agent === base.to) return at('이미 ' + base.to + ' 에이전트임');
  if (turn.active) return at('현재 ' + turn.agent + ' 턴 진행 중 — 끝난 뒤 인계');
  if (turn.stale || !turn.known) return at('현재 ' + turn.agent + ' 턴이 아직 열려 있음 — 끝을 확인할 수 없음');
  const lim = limitBlock(turn, now);
  return {
    ...base,
    eligible: true,
    limit: lim || null,
    reason: lim
      ? turn.agent + ' 한도 막힘 — ' + base.to + ' 인계 가능'
      : turn.agent + ' 턴 종료 — ' + base.to + ' 인계 가능',
  };
}

/** 인계 실행의 Orca·터미널 손. 테스트가 가짜로 갈아 끼운다. */
const HANDOFF_DEPS = {
  createTerminal: (path, title, command, ms) => {
    const t = orcaJson(['terminal', 'create', '--worktree', 'path:' + path, '--title', title, '--command', command], ms);
    return t?.terminal?.handle || t?.handle || null;
  },
  waitForPrompt,
  waitIdle: (handle, ms) => orcaJson(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(ms)], ms + 15000),
  closeExtraTabs: (path, keep) => closeExtraTabs(path, keep),
  send: (handle, text) => sendInstruction(handle, text),
  // 재개 항목(슬라이스 43). 회차의 인계 단계가 막힌 워크스페이스를 적고, 인계가 실행되면 지운다.
  noteStuck: (project, e) => noteStuck(project, e),
  dropResume: (project, name) => dropResume(project, name),
  pickTerminal: (terminals) => claudeTerminal(terminals),
};

/**
 * 같은 워크스페이스에 상대 에이전트의 첫 턴을 연다. Claude 는 파견과 같은 TUI 준비·제출 경로,
 * 헤드리스는 `worker --prompt` 래퍼 경로다. `[어려움]` 은 각각 Fable 과 래퍼 `--hard` 로 보존한다.
 */
async function handoffOne(slice, decision, opts, deps = HANDOFF_DEPS) {
  const text = opts.prompt || handoffPrompt(slice.number);
  const to = decision.to;
  const headless = to !== 'claude';
  let command;
  try {
    command = headless
      ? workerPromptCommand(to, text, opts.agents, decision.hard)
      : workerCommand({ ...slice, agent: 'claude' }, opts);
  } catch (e) {
    return { ...decision, ok: false, stage: 'command', detail: clean(e.message, 300) };
  }
  const step = { ...decision, command, text };
  let handle;
  try {
    handle = deps.createTerminal(decision.path, 'slice' + slice.number + ' 인계 ' + to, command, opts.createMs);
  } catch (e) {
    return { ...step, ok: false, stage: 'terminal', detail: clean(e.message, 300) };
  }
  if (!handle) return { ...step, ok: false, stage: 'terminal', detail: '터미널 핸들을 못 받음' };
  if (headless) {
    const tabs = deps.closeExtraTabs(decision.path, handle);
    return { ...step, handle, tabs, ok: true, stage: 'create', submit: '래퍼 실행 (' + to + ')' };
  }
  const ready = await deps.waitForPrompt(handle, opts.readyMs);
  if (!ready.ok) return { ...step, handle, ok: false, stage: 'prompt', detail: ready.detail };
  const tabs = deps.closeExtraTabs(decision.path, handle);
  try {
    deps.waitIdle(handle, opts.readyMs);
  } catch (e) {
    return { ...step, handle, tabs, ok: false, stage: 'idle', detail: clean(e.message, 300) };
  }
  const sent = await deps.send(handle, text);
  return {
    ...step,
    handle,
    tabs,
    ok: sent.result === 'submitted',
    stage: 'send',
    submitted: sent.result,
    submit: sent.submit,
    resent: sent.resent,
    detail: sent.detail || '',
  };
}

async function fleetHandoff(arg, { slice: number, to, prompt, dryRun, json, model, hardModel, agents, readyMs, createMs, slices, deps } = {}) {
  const r = slices || fleetSlices(arg);
  const table = agents || agentTable();
  const slice = r.slices.find((s) => s.number === Number(number));
  const workspace = r.workspaces.find((w) => w.slice === Number(number));
  const decision = handoffPlan({ number, slice, workspace, to, agents: table });
  const out = {
    at: Date.now(),
    project: r.project,
    phase: r.phase,
    dryRun: !!dryRun,
    decision,
    handoff: null,
  };
  if (!dryRun && decision.eligible) {
    out.handoff = await handoffOne(
      slice,
      decision,
      { prompt, model, hardModel, agents: table, readyMs, createMs },
      deps || HANDOFF_DEPS
    );
    const tail = out.handoff.tabs?.detail ? ' · ' + out.handoff.tabs.detail : '';
    log(
      'fleet handoff ' +
        r.project +
        ' slice' +
        number +
        ' ' +
        (out.handoff.ok ? out.handoff.submit : out.handoff.stage + ' 실패: ' + out.handoff.detail) +
        tail
    );
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  else process.stdout.write(renderHandoff(out));
  return out;
}

function renderHandoff(o) {
  const d = o.decision;
  const cols = [
    ['번호', 5, String(d.number ?? '-')],
    ['현재', 12, d.from || ''],
    ['대상', 12, d.to || ''],
    ['판정', 7, d.eligible ? '인계' : '보류'],
    ['이유', 52, d.reason],
  ];
  const line = (cells) => cells.map(([v, w]) => fitCell(v, w)).join('  ').replace(/\s+$/, '');
  const L = [o.project + '  —  ' + (o.phase?.title || '(단계 없음)'), o.dryRun ? '(dry-run)' : '', ''];
  L.push(line(cols.map(([h, w]) => [h, w])), cols.map(([, w]) => '-'.repeat(w)).join('  '));
  L.push(line(cols.map(([, w, v]) => [v, w])));
  if (o.handoff) {
    const tail = o.handoff.tabs?.detail ? ' · ' + o.handoff.tabs.detail : '';
    L.push('', o.handoff.ok ? '보낸 것 1/1 — ' + o.handoff.submit + tail : '보낸 것 0/1 — ' + o.handoff.stage + ' 실패: ' + o.handoff.detail + tail);
  } else {
    L.push('', o.dryRun && d.eligible ? '인계 대상 1개 (dry-run 이라 안 띄움)' : '보낸 것 0/' + (d.eligible ? 1 : 0));
  }
  return L.filter((v, i) => v !== '' || i !== 1).join('\n') + '\n';
}

// ---------- 회차의 인계 단계 ----------
/**
 * 그 워크스페이스가 **한도 때문에** 서 있는가. 막고 있는 한도, 아니면 null. 부수효과 없음.
 *
 * 재료가 둘인 것은 두 종류의 워커가 다르게 죽기 때문이다:
 * - **헤드리스** — 래퍼가 턴 끝에 종료 코드와 그때의 한도를 세션 기록에 남기므로 `landCheck` 가
 *   이미 `limit` 을 실어 준다(`limitBlock` 이 `stillReached` 로 지금 다시 본 값이다).
 * - **Claude TUI** — 종료 코드가 없다. 한도에 걸린 창은 그냥 "유휴인데 미체크" 로 보일 뿐이라,
 *   지금 그 계정의 한도가 실제로 차 있는지를 보는 수밖에 없다. 그래서 착륙이 막힘으로 본 창
 *   (`blocked`)에 한해 **지금 읽은 한도**를 근거로 삼는다.
 *
 * 뒤쪽은 우연의 일치를 섞을 수 있다 — 트리가 더러워 막힌 창이 마침 한도 100% 인 순간. 그래도
 * 넘기는 편이 낫다: 그 계정으로는 어차피 아무 턴도 못 돌고, 인계 지시는 "미커밋 변경과 인계
 * 메모를 먼저 읽고 이어서" 이므로 반쯤 한 일 위에 덧칠하지 않는다.
 */
function limitStuckOf(check, workspace, limits, now = Date.now()) {
  if (!check || !check.blocked) return null; // 자격이 났거나 사람 몫(브랜치 이름·대기)은 건드리지 않는다
  // **어느 쪽이든 지금 다시 본다** (`stillReached`). `check.limit` 은 `landCheck` 가 이미 걸러
  // 주지만 그건 착륙이 잰 시각의 답이고, 여기 `now` 는 인계를 정하는 시각이다 — 잣대를 한 군데로
  // 모아 두지 않으면 초기화가 지난 창을 "영영 막힘"으로 넘기는 길이 다시 생긴다 (슬라이스 11).
  if (check.limit) return stillReached(check.limit, now) ? check.limit : null;
  const from = workspace?.turn?.agent;
  const l = from ? (limits || {})[from] : null;
  return l && stillReached(l, now) ? l : null;
}

/**
 * 회차의 **인계 단계 판정** — 착륙 뒤·파견 앞에 한 번. **부수효과 없음**이라 dry-run 과 실제
 * 회차가 같은 답을 쓴다 (`dispatchPlan`·`landCheck` 와 같은 규칙).
 *
 * 갈래는 셋이다:
 * - **인계** — 한도에 막혔고, 상대(`fleetFallback[from]`)에게 여유가 있다. `handoffPlan` 이
 *   자격을 한 번 더 보고(창·기록·턴), 통과한 것만 실제로 띄운다.
 * - **대기** — 초기화가 `fleetLimitWaitMin` 안이거나 상대도 막혔다. 워크스페이스 하나가 통째로
 *   다른 손에 가는 값을 30분 아끼자고 치르지 않는다. Claude 창은 `wake` 로, 헤드리스는 다음
 *   회차의 판정으로 이어진다.
 * - **인계 불가** — 막혔는데 `handoffPlan` 이 거부했다(창이 닫혔다·턴이 열린 채다). 보고만 한다.
 *
 * **`fleetFallback` 이 비어 있으면 아무 줄도 안 낸다** — 기본값이고, 그때는 지금까지처럼 막힘
 * 표에만 오른다. 상대의 한도를 **모르면 여유로 본다**(슬라이스 11 의 "모르면 막지 않는다") —
 * 대신 사유에 `(상대 한도 모름)` 을 붙여 보고에서 구분되게 한다.
 */
function cycleHandoffPlan({ checks, workspaces, slices, limits, fallback, waitMin, agents, now = Date.now() }) {
  const fb = fallback || {};
  if (!Object.keys(fb).length) return [];
  const wait = Math.max(0, Number(waitMin) || 0) * 60000;
  const rows = [];
  for (const c of checks || []) {
    const w = (workspaces || []).find((x) => normPath(x.path) === normPath(c.path));
    const stuck = limitStuckOf(c, w, limits, now);
    if (!stuck) continue;
    const from = w?.turn?.agent || stuck.agent || null;
    const to = fb[String(from)];
    if (!to) continue; // 상대가 정해져 있지 않으면 자동 인계 대상이 아니다 — 막힘 표에 이미 있다
    const slice = (slices || []).find((s) => s.number === c.slice) || null;
    const row = { name: c.name, path: c.path, number: c.slice, from, to, limit: stuck };
    const left = stuck.resetsAt ? stuck.resetsAt - now : null;
    if (left != null && left > 0 && left <= wait) {
      rows.push({ ...row, action: 'wait', reason: '한도 초기화 임박 (' + hhmm(stuck.resetsAt) + ', ' + Math.round(left / 60000) + '분 뒤) — 인계 대신 대기' });
      continue;
    }
    const tl = (limits || {})[to];
    if (tl && stillReached(tl, now)) {
      rows.push({ ...row, action: 'wait', reason: '상대 ' + to + ' 도 한도 막힘' + (tl.resetsAt ? ' (초기화 ' + hhmm(tl.resetsAt) + ')' : '') + ' — 대기' });
      continue;
    }
    const unknown = tl ? '' : ' (상대 한도 모름)';
    const decision = handoffPlan({ number: c.slice, slice, workspace: w, to, agents, now });
    if (!decision.eligible) {
      rows.push({ ...row, action: 'blocked', decision, reason: decision.reason });
      continue;
    }
    rows.push({ ...row, action: 'handoff', decision, hard: decision.hard, reason: decision.reason + unknown });
  }
  return rows;
}

/**
 * 판정한 인계를 실제로 띄운다. dry-run 이면 판정만 돌려준다 — 회차의 다른 단계와 같은 규칙이다.
 * 실행 자체는 손 명령과 **같은 `handoffOne`** 이다: 인계가 두 갈래로 갈리면 손으로 확인한 것이
 * 자동 경로의 근거가 되지 못한다.
 */
async function cycleHandoff(snap, land, opts = {}, deps = HANDOFF_DEPS) {
  const rows = cycleHandoffPlan({
    checks: land?.checks || [],
    workspaces: snap?.workspaces || [],
    slices: snap?.slices || [],
    limits: opts.limits,
    fallback: opts.fallback,
    waitMin: opts.waitMin,
    agents: opts.agents,
    now: opts.now,
  });
  const out = { rows, dryRun: !!opts.dryRun };
  if (opts.dryRun) return out;
  for (const r of rows) {
    if (r.action !== 'handoff') continue;
    const slice = (snap?.slices || []).find((s) => s.number === r.number);
    r.result = await handoffOne(slice, r.decision, opts, deps);
    log('fleet cycle 인계 ' + r.name + ' ' + r.from + ' → ' + r.to + ' ' + (r.result.ok ? r.result.submit : r.result.stage + ' 실패: ' + r.result.detail));
  }
  // **막혀 있는 동안 재개 항목을 적는다** (슬라이스 43). 인계가 실행된 것은 지운다 — 남으면 상대 에이전트가
  // 도는 창에 옛 에이전트의 재개가 들어간다. 인계 판정이 낸 줄이 없는 것(상대가 없음·`fleetFallback` 비어 있음)도
  // 여기서 잡는다: 그 두 길은 인계 표에 아무 줄도 안 내지만 막힌 것은 같다.
  const project = opts.project || snap?.project || null;
  out.noted = [];
  if (project)
    for (const s of stuckWorkspaces({ checks: land?.checks || [], workspaces: snap?.workspaces || [], limits: opts.limits, now: opts.now })) {
      const r = rows.find((x) => normPath(x.path) === normPath(s.path));
      if (r?.action === 'handoff' && r.result?.ok) {
        deps.dropResume(project, s.name);
        continue;
      }
      let terminal = null;
      try {
        terminal = s.agent === 'claude' && s.terminals.length ? deps.pickTerminal(s.terminals) : s.terminals[0] || null;
      } catch {}
      const reason = r ? handoffRowText(r) : '상대 에이전트 없음 (fleetFallback)';
      const e = deps.noteStuck(project, { name: s.name, workspace: s.path, slice: s.slice, agent: s.agent, terminal, resetsAt: s.limit?.resetsAt || null, reason });
      if (e) out.noted.push({ name: s.name, slice: s.slice, agent: s.agent, resetsAt: e.resetsAt, attempts: e.attempts, reason });
    }
  return out;
}

/**
 * 한도 때문에 서 있는 워크스페이스 전부 — `limitStuckOf` 가 참인 것. 순수 함수다. 인계 판정(`cycleHandoffPlan`)이
 * 상대가 없어 줄을 안 내는 것까지 포함하므로, 재개 항목의 원천은 인계 표가 아니라 이것이다.
 */
function stuckWorkspaces({ checks, workspaces, limits, now = Date.now() }) {
  const out = [];
  for (const c of checks || []) {
    const w = (workspaces || []).find((x) => normPath(x.path) === normPath(c.path));
    const stuck = limitStuckOf(c, w, limits, now);
    if (!stuck) continue;
    out.push({ name: c.name, path: c.path, slice: c.slice, agent: w?.turn?.agent || stuck.agent || 'claude', terminals: w?.terminals || [], limit: stuck });
  }
  return out;
}

// ---------- 회차의 재개 단계 (슬라이스 43) ----------
/**
 * 재개 **실행**의 손. 테스트가 가짜로 갈아 끼운다. 이름이 `LAND_DEPS`·`HANDOFF_DEPS` 와 같은 꼴인 것은
 * 같은 것이기 때문이다 — `resume.mjs` 의 `RESUME_DEPS` 는 그 모듈의 **파일 IO** 표라 다른 것이다.
 */
const RESUME_RUN_DEPS = {
  ...RESUME_IO,
  createTerminal: (path, title, command, ms) => HANDOFF_DEPS.createTerminal(path, title, command, ms),
  closeExtraTabs: (path, keep) => closeExtraTabs(path, keep),
  entries: (project) => resumeEntries(project),
  bump: (project, name) => bumpResume(project, name),
  drop: (project, name) => dropResume(project, name),
  liveTerminals: () => new Set(listTerminals().filter((t) => t.connected !== false && !t.orphaned).map((t) => t.handle)),
  cardOf: (path) => cardForWorkspace(path),
  idle: (handle, ms) => isIdle(handle, ms),
};

/**
 * 회차의 **재개 단계** — 착륙 뒤·인계 앞. 지난 회차들이 적어 둔 항목(`fleet-resume.<프로젝트>.json`)을 읽어
 * `resumePlan` 으로 판정하고, `resume` 갈래만 실제로 깨운다. dry-run 은 판정만.
 *
 * 인계 **앞**인 이유: 초기화가 지나 한도가 풀린 워크스페이스는 `limitStuckOf` 가 null 이라 인계 판정에 안 걸린다 —
 * 그 자리를 이 단계가 맡는다. 파견 **앞**이라야 깨운 워크스페이스가 그 회차의 활성 수에 그대로 세어진다.
 * 헤드리스는 파견과 같은 래퍼 명령(`workerCommand` — `[어려움]` 이면 `--hard`)을 같은 폴더에 새 창으로 띄운다.
 * 시도마다 `attempts`·`at` 을 올린다(성패 무관 — 실패도 시도다). `drop`·`exhausted` 는 항목을 지운다.
 */
async function cycleResume(snap, opts = {}, deps = RESUME_RUN_DEPS) {
  const project = opts.project || snap?.project || null;
  const list = project ? deps.entries(project) : [];
  const out = { rows: [], dryRun: !!opts.dryRun };
  if (!list.length) return out;
  const cards = {};
  for (const e of list) if (e.workspace) cards[normPath(e.workspace)] = deps.cardOf(e.workspace);
  let live = null;
  if (list.some((e) => e.agent === 'claude')) {
    try {
      live = deps.liveTerminals();
    } catch {} // 창 목록을 못 읽으면 워크스페이스의 창 목록으로 떨어진다 (`resumePlan`)
  }
  out.rows = resumePlan(list, {
    now: opts.now,
    limits: opts.limits,
    workspaces: snap?.workspaces || [],
    slices: snap?.slices || [],
    cards,
    live,
    idle: (h) => deps.idle(h, opts.idleMs || config().fleetIdleMs),
    max: opts.max,
  });
  if (opts.dryRun) return out;
  for (const r of out.rows) {
    if (r.action === 'drop' || r.action === 'exhausted') {
      deps.drop(project, r.name);
      log('fleet cycle 재개 항목 삭제 ' + r.name + ' — ' + r.reason);
      continue;
    }
    if (r.action !== 'resume') continue;
    const slice = (snap?.slices || []).find((s) => s.number === r.number) || { number: r.number, tags: [] };
    const command = (row) => workerCommand({ ...slice, agent: row.agent }, opts);
    r.result = await resumeOne(r, { ...deps, command, createMs: opts.createMs });
    const e = deps.bump(project, r.name);
    if (e) r.attempts = e.attempts;
    log('fleet cycle 재개 ' + r.name + ' (' + r.agent + ') ' + (r.result.ok ? r.result.submit : r.result.stage + ' 실패: ' + r.result.detail) + ' · 시도 ' + (e ? e.attempts : '?'));
  }
  return out;
}

/** 회차 보고의 결정 표 한 칸. 세 갈래가 첫 낱말로 갈린다. */
function handoffRowText(r) {
  if (r.action === 'wait') return '대기 — ' + r.reason;
  if (r.action !== 'handoff') return '인계 불가 — ' + r.reason;
  const res = r.result ? ' · ' + (r.result.ok ? r.result.submit : r.result.stage + ' 실패: ' + (r.result.detail || '')) : '';
  return '인계 → ' + r.to + ' — ' + r.reason + res;
}

// ---------- fleet land ----------
/**
 * `fleet land <프로젝트>` — 끝난 워크스페이스를 PR·머지·정리까지 태워 보낸다.
 *
 * **자동 push·머지는 2026-08-30 에 사용자가 이 흐름에 한해 허용했다** (전역 "push 는 매번 확인"의
 * 예외). 그래서 조건이 두 겹이다: 워커가 PLAN.md 를 체크했고(= 완료 기준을 실행으로 확인했다는
 * 워커의 선언) **그리고** 커밋이 있고 트리가 깨끗할 때만. 하나라도 어긋나면 손대지 않고 보고만 한다.
 *
 * 판정에 쓰는 PLAN.md 는 **워크스페이스 것**이다 — 워커가 방금 체크한 파일이고, 본체 것은 머지
 * 전까지 옛날 것이다.
 *
 * **막힌 것에는 재전송하지 않는다** (coordinator 규칙). 유휴인데 미체크면 그냥 보고한다 — 워커가
 * 멈춘 이유는 사람이 봐야 하고, 같은 지시를 다시 보내면 반쯤 한 일 위에 덧칠된다.
 */
/** 그 워크스페이스가 마지막으로 쓴 복귀 카드. `wait` 가 차 있으면 착륙 대상에서 뺀다. */
function cardForWorkspace(path) {
  // 하위 폴더에서 돌린 세션의 카드도 이 워크스페이스 것이다 — status.md 와 같은 잣대(cardUnder).
  return readCards(cardUnder(path))[0] || null;
}

/**
 * TUI 가 지금 유휴인가. 작업 중이면 대기가 시간 초과로 실패한다 — 그걸 "작업 중"으로 읽는다.
 *
 * **재그리기에 안 속는다** (2026-09-07 실측, `notes/2026-09-07-tui-idle-화면읽기-실측.md`).
 * 턴이 열려 있는 창 37회 — 50초짜리 단일 도구 호출 중 12회, 짧은 도구 호출 사이의 5~8초 공백을
 * 덮은 20회 포함 — 이 **전부** 시간 초과였고, 턴이 닫힌 창 12회는 전부 0.4~1.9초에 통과했다.
 * 스피너가 계속 다시 그려도 `tui-idle` 은 그것을 유휴로 읽지 않는다. `outputQuiet` 머리 주석이
 * 근거로 삼던 "도구 호출 사이의 짧은 유휴에도 통과한다"는 그래서 **사실이 아니다** — 그 주석을
 * 같이 고쳤다.
 *
 * 다만 **Claude 가 안 뜬 창**은 여전히 못 가른다: Orca 의 `Waiting for setup…` 화면에서 `tui-idle`
 * 은 통과하기도 시간 초과가 되기도 한다(2026-08-30 project-b slice14). 그래서 파견의 준비 신호는
 * 이것이 아니라 `waitForPrompt`(화면의 `❯`)고, 훅 기록 없는 창의 착륙 판정에서 `outputQuiet` 이
 * 남는 이유도 그것이다.
 */
function isIdle(handle, timeoutMs) {
  try {
    orcaJson(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs)], timeoutMs + 10000);
    return true;
  } catch {
    return false;
  }
}

/**
 * 마지막 화면 출력이 `quietMs` 이상 전인가. **훅 기록이 없는 창에만** 쓴다 (`landCheck`).
 *
 * 예전 근거는 "`tui-idle` 은 도구 호출 사이의 짧은 유휴에도 통과한다" 였는데 **2026-09-07 실측에서
 * 거짓으로 드러났다**(`isIdle` 머리 주석 — 열린 턴 37/37 시간 초과). 그런데도 이 조건을 남기는
 * 것은 근거가 바뀌었기 때문이다: 훅 기록이 없는 창은 정의상 **Claude 가 떴는지조차
 * 모르는 창**이고, 바로 그 화면(Orca 의 `Waiting for setup…`)에서 `tui-idle` 이 통과한다는 것은
 * 2026-08-30 project-b slice14 로 이미 확인된 사실이다. 틀리는 방향의 값이 비대칭이라 그대로 둔다 —
 * 잘못 "유휴"면 `worktree rm --force` 가 살아 있는 세션을 죽이고, 잘못 "작업 중"이면 회차 한 번을
 * 건너뛰고 30분 뒤 다시 본다. 사람이 Orca 에서 창을 열기만 해도 이 값이 올라가는 것(2026-08-31)은
 * 그 한 번을 건너뛰는 비용으로 받는다.
 *
 * 값을 모르면(창 목록에 `lastOutputAt` 이 없거나 `quietMs` 가 0) **통과시킨다** — 알 수 없다는
 * 이유로 착륙을 영영 막으면, 자동 회차가 조용히 아무것도 안 하는 쪽으로 고장 난다.
 */
function outputQuiet(lastOutputAt, quietMs, now = Date.now()) {
  if (!lastOutputAt || !quietMs) return { quiet: true, ago: null };
  const ago = now - lastOutputAt;
  return { quiet: ago >= quietMs, ago };
}

// `TURN_STALE_MS`(묵은 턴 기준)는 common 에 있다 — 래퍼의 겹침 거부와 같은 잣대.

/**
 * 그 워크스페이스가 지금 턴 중인가. 재료는 **sp-sync 훅**이다 — `prompt`(UserPromptSubmit)가
 * 턴 시작(`turnStartedAt`), `Stop` 이 턴 끝(`turnEndedAt`)을 세션 기록에 찍는다 (슬라이스 23).
 *
 * `lastOutputAt`(PTY 에 바이트가 나온 시각)은 **작업과 재그리기를 구분 못 한다**. ① Stop 훅은
 * 워커의 마지막 출력 직후에 회차를 띄우므로 워커가 띄운 회차는 그 워커 자신을 늘 "방금까지
 * 출력"으로 보고 넘겼다. ② 사람이 Orca 에서 창을 열기만 해도 xterm 이 붙으면서 TUI 가 화면을
 * 다시 그려 값이 올라갔다 — 끝난 지 37분 된 세션이 그렇게 찍혔다 (2026-08-31 실측). 훅은 둘 다에
 * 반응하지 않는다: 화면이 몇 번 다시 그려지든 `Stop` 뒤에 `prompt` 가 없으면 그 창은 유휴다.
 *
 * 한 폴더에 창이 여럿이면 **하나라도 턴 중이면 턴 중**이다 — 곁가지 질문 창이라도 사람이 뭔가
 * 하는 중이고, 착륙은 그 폴더를 통째로 지운다.
 *
 * 훅 기록이 아예 없거나(훅 설치 전에 뜬 창, 옛 세션) 안 끝난 턴만 묵어 있으면 `known: false` 를
 * 돌린다 — 호출부가 옛 판정(`outputQuiet`)으로 떨어진다.
 *
 * **헤드리스 워커**(4단계)는 훅 대신 래퍼(`worker`)가 같은 두 시각을 찍고 세션 기록에 `agent`
 * (`codex`·`antigravity`)를 남긴다. 그 이름을 `agent` 로 같이 돌린다 — 파견·착륙이 "이 워크스페이스는
 * 헤드리스"를 아는 자리다. 화면(`❯`)·`tui-idle` 은 셸 프롬프트에서 뜻이 없으므로 그쪽 판정은 이
 * 값을 보고 갈라진다. 한 폴더에 TUI 와 래퍼 기록이 섞이는 것은 **인계 뒤의 정상 모양**이다.
 * 그래서 종류는 가장 최근에 시작한 기록으로 가르고, TUI 가 최근이면 `agent: 'claude'` 도
 * 명시한다. 예전처럼 래퍼 기록이 하나라도 있다는 이유로 영원히 헤드리스로 보면 codex → Claude
 * 인계 뒤의 착륙·충돌 해소가 다시 codex 경로로 샌다(2026-09-02 slice6 실측에서 드러난 구멍).
 */
function turnStateFor(path, sessions, now = Date.now()) {
  const want = normPath(path);
  // `cwd` 가 아니라 `worktree` 다 — `cwd` 는 본체 경로라 한 프로젝트의 워크스페이스가 전부 같다.
  const mine = Object.values(sessions || {}).filter((e) => normPath(e.worktree) === want && (e.turnStartedAt || e.turnEndedAt));
  if (!mine.length) return { known: false };
  const isOpen = (e) => (e.turnStartedAt || 0) > (e.turnEndedAt || 0);
  const isLive = (e) => isOpen(e) && now - e.turnStartedAt < TURN_STALE_MS;
  // **가장 최근 기록의 종류가 현재 에이전트다.** 인계는 워크트리를 그대로 두므로 옛 에이전트의
  // 기록이 같은 경로에 남는다. `agent` 가 없는 옛 TUI 기록도 TUI 로 센다.
  const newest = [...mine].sort((a, b) => (b.turnStartedAt || b.turnEndedAt || 0) - (a.turnStartedAt || a.turnEndedAt || 0))[0];
  const newestHeadless = newest.agent && newest.agent !== 'claude';
  if (newestHeadless) {
    // **헤드리스는 가장 최근 래퍼 턴 하나가 판정이다.** 래퍼는 턴마다 새 세션을 만들므로 그 기록이
    // 곧 "지금 도는가"다. 같은 경로에 옛 기록(지난 단계의 같은 번호 워크스페이스·앞 턴)이 섞여 있으면
    // 아래 합산 판정은 묵은 래퍼 턴을 "끝난 턴도 있으니 유휴"로 삼킨다 — 2026-09-02 slice6 실측.
    // 다만 곁가지 TUI 창이 턴 중이면 그건 그대로 턴 중이다 — 사람이 그 폴더에서 뭔가 하는 중이다.
    const h = newest;
    // 래퍼가 턴 끝에 남긴 재료도 같이 싣는다 — **자식 종료 코드**와 그 순간의 **한도**.
    // 착륙이 "그냥 죽었다" 와 "한도에 막혀 죽었다" 를 가르는 자리가 여기뿐이다(`limitBlock`).
    // 없을 때는 키 자체를 안 넣는다 — 옛 기록(4단계 래퍼)에는 둘 다 없고, 그때의 판정 모양이
    // 그대로 유지돼야 한다.
    const tag = { agent: h.agent };
    if (h.exitCode != null) tag.exitCode = h.exitCode;
    if (h.limit) tag.limit = h.limit;
    const liveTui = mine.filter((e) => !(e.agent && e.agent !== 'claude') && isLive(e));
    if (isLive(h) || liveTui.length) return { known: true, active: true, startedAt: Math.max(...[h, ...liveTui].filter(isLive).map((e) => e.turnStartedAt)), ...tag };
    if (isOpen(h)) return { known: false, stale: true, ...tag };
    return { known: true, active: false, endedAt: h.turnEndedAt || null, ...tag };
  }
  // 최근 기록이 TUI 면 TUI 규칙으로 돈다. 끝난 옛 래퍼 턴은 빼되, 아직 실제로 도는 래퍼 턴은
  // 안전을 위해 작업 중으로 센다 — 겹친 프로세스가 있는데 워크트리를 지우면 안 된다.
  const tui = mine.filter((e) => !(e.agent && e.agent !== 'claude'));
  const liveHeadless = mine.filter((e) => e.agent && e.agent !== 'claude' && isLive(e));
  const open = tui.filter(isOpen);
  const live = open.filter(isLive);
  if (live.length || liveHeadless.length)
    return { known: true, active: true, startedAt: Math.max(...[...live, ...liveHeadless].map((e) => e.turnStartedAt)), agent: 'claude' };
  // 안 끝난 턴만 있는데 전부 묵었다 = 훅이 끊긴 창이다. 여기서 "유휴"라고 하면 산 창을 지울 수 있다.
  if (open.length === tui.length) return { known: false, stale: true, agent: 'claude' };
  return { known: true, active: false, endedAt: Math.max(0, ...tui.map((e) => e.turnEndedAt || 0)) || null, agent: 'claude' };
}

/**
 * 그 워크스페이스가 헤드리스 워커의 것이면 에이전트 이름, 아니면 null. 재료는 둘이다:
 * **사실**(세션 기록의 `agent` — 래퍼가 실제로 떴다)이 먼저고, 없으면 **계획**(그 슬라이스의
 * `[에이전트: X]`·프로젝트 기본값 — `fleetSlices` 가 워크스페이스에 `agent` 로 붙인다). 계획만
 * 있고 기록이 없으면 래퍼가 뜨지 못한 것인데, 그때 TUI 판정(화면·`tui-idle`)으로 떨어지면 셸
 * 프롬프트를 "빈 창"으로 읽어 `/slice N` 을 셸에 쳐 넣는다 — 그래서 계획만 있어도 헤드리스로 본다.
 */
/**
 * 그 래퍼 턴이 **한도에 막혀** 끝났으면 그때 읽은 한도, 아니면 null. 부수효과 없음.
 *
 * 조건이 둘인 이유: 한도가 차 있다는 사실만으로는 그 턴이 그것 때문에 죽었다고 말할 수 없고
 * (막히기 직전까지 일을 끝낸 턴도 100% 로 끝난다), 종료 코드만으로는 왜 죽었는지 모른다.
 * 둘이 같이여야 "이 워크스페이스는 상대 에이전트가 이어받아야 한다" 로 읽을 수 있다.
 *
 * 기록된 `reached` 를 그대로 믿지 않고 `stillReached` 로 **지금** 다시 본다 — 세션 기록의
 * `limit` 은 그 턴이 끝난 순간의 사진이라, 안 그러면 한 번 막힌 워크스페이스가 창이 초기화된
 * 뒤에도 영영 막힘으로 남아 아무도 이어받지 못한다.
 */
function limitBlock(turn, now = Date.now()) {
  if (!turn || turn.exitCode == null || turn.exitCode === 0) return null;
  return stillReached(turn.limit, now) ? turn.limit : null;
}

function headlessOf(w) {
  const recorded = w?.turn?.agent;
  // `claude` 도 **기록된 사실**이다. 여기서 null 로 끝내지 않고 계획으로 떨어지면, codex 계획을
  // Claude 가 이어받은 뒤에도 충돌 루프가 codex 래퍼를 다시 띄운다. 기록이 계획보다 먼저다.
  if (recorded) return recorded === 'claude' ? null : recorded;
  const planned = w?.agent;
  return planned && planned !== 'claude' ? planned : null;
}

/**
 * 착륙 자격을 본다. **부수효과 없음** — dry-run 과 실제 착륙이 같은 판정을 쓴다.
 * 반환 `ready` 가 true 인 것만 PR·머지로 간다.
 */
function landCheck(w, opts) {
  const base = { name: w.name, path: w.path, branch: w.branch, slice: w.slice };
  const at = (reason, blocked = true) => ({ ...base, ready: false, blocked, reason });
  // 착륙도 파견도 이 창을 못 다룬다 — 어느 표에도 안 오르면 영영 방치된다 (`slice10-2`).
  // `blocked` 는 아니다(워커가 막힌 게 아니라 이름이 규칙 밖이다). 사람이 풀 몫으로 따로 표시한다.
  if (w.slice == null)
    return { ...at('브랜치가 sliceN 이 아니라 어느 슬라이스인지 모름', false), attention: '브랜치 `' + (w.branch || '?') + '` 가 sliceN 꼴이 아니라 어느 슬라이스인지 모름 — 착륙 판정 밖이다' };
  if (!existsSync(w.path)) return at('워크스페이스 폴더가 없음', false);

  // 워커가 사용자 결정을 기다리는 중이면 건드리지 않는다. 사람이 답할 몫이다.
  //
  // **다만 워커는 전역 규칙 때문에 거의 항상 "PR 올릴까요(push 는 확인 필요)"를 대기에 적는다.**
  // 그 승인은 이 흐름에 한해 사용자가 이미 줬으므로(2026-08-30), 그대로 두면 land 가 영영 안 돈다.
  // 그렇다고 대기 문장을 기계가 분류하면 그 안에 섞인 진짜 결정거리까지 삼킨다 — 실제로 slice10
  // 의 대기에는 push 승인과 "사촌 노트북 memory 정리"가 한 줄에 같이 있었다. 그래서 무시는
  // **명시 플래그로만** 하고, 무시했을 때도 그 문장을 결과에 실어 보고한다.
  const card = cardForWorkspace(w.path);
  const waiting = card && isWaiting(card.wait) ? clean(card.wait, 120) : null;
  if (waiting && !opts.ignoreWait) return { ...at('워커가 결정을 기다림: ' + waiting, false), waiting };
  if (waiting) base.waiting = waiting;

  // **헤드리스 워커**(4단계)는 세션 기록(`turnStateFor`)만으로 유휴를 가른다 — `known && !active`.
  // 창 유무·`tui-idle`·마지막 출력 시각은 셸 프롬프트에서 뜻이 없다: 프로세스가 끝나도 탭은 셸로
  // 남고(2026-09-02 실측) 사람이 그 탭을 닫아도 끝났다는 사실은 기록에 있다. 턴이 열려 있으면 작업
  // 중이고, `TURN_STALE_MS` 를 넘겨 열려 있으면(`stale`) 래퍼가 턴 끝을 못 찍은 것 — 창이 죽었거나
  // 래퍼가 멈춘 것이라 사람이 볼 몫이다. 기록이 아예 없으면 래퍼가 뜨지 못한 것이고 그것도 사람 몫.
  const headless = headlessOf(w);
  if (headless) {
    const t = w.turn || { known: false };
    const who = '헤드리스(' + headless + ')';
    if (t.active) return at(who + ' 작업 중 — 래퍼 턴 진행 중', false);
    if (t.stale) return at(who + ' 래퍼가 안 끝남 — 턴이 ' + Math.round(TURN_STALE_MS / 60000) + '분 넘게 열려 있음, 사람이 볼 것');
    if (!t.known) return at(who + ' 인데 래퍼 턴 기록이 없음 — 래퍼가 뜨지 못한 듯, 사람이 볼 것');
    const res = landCheckWork(w, opts, base, at);
    // **한도 막힘** — 래퍼가 0 아닌 코드로 끝났고 그때 읽은 한도가 지금도 차 있다. 자격이
    // 안 나온 이유를 그것으로 바꿔 적는다: 사람이 보기에 "미체크 막힘" 과 겉모습이 같지만
    // 원인이 다르고, 대처도 다르다(사람 몫이 아니라 상대 에이전트가 이어받을 자리다 — 슬라이스 12·13).
    // 이미 자격이 난 것(체크·커밋·깨끗함)은 건드리지 않는다 — 막판에 한도가 찼어도 일은 끝났다.
    const lim = limitBlock(t, opts.now);
    if (lim && !res.ready)
      return { ...res, blocked: true, limit: lim, reason: who + ' 한도 막힘 — 초기화 ' + (lim.resetsAt ? hhmm(lim.resetsAt) : '모름') + ' (exit ' + t.exitCode + ')' };
    return res;
  }

  // **잠든 워크스페이스는 유휴다** (슬라이스 28). Orca 의 절전(Agent sleep)은 에이전트가 done 이고 설정한 시간만큼
  // 조용한 창만 재우고 PTY 를 죽이므로, 잠들었다는 사실이 곧 "손을 뗐다"다. 잠든 창은 `terminals` 에 없어서
  // 예전엔 바로 아래 "창이 없음"에 걸렸고(사람 몫), 그걸 넘겨도 `isIdle` 이 빈 목록에서 false 라 "작업 중"으로
  // 떨어졌다 — 두 관문을 다 지나야 한다. 훅 기록이 "턴 진행 중"이라고 하면 그쪽이 이긴다(잠든 뒤 턴이 열릴 수는
  // 없으니 그건 훅이 끊긴 기록이고, 틀리는 값의 비용이 비대칭이다 — `outputQuiet` 머리 주석).
  const asleep = sleepingOf(w);
  if (asleep) base.sleeping = asleep.text;
  if (!w.terminals.length && !asleep) return at('창이 없음 — 유휴인지 확인 불가', false);
  // 훅 기록이 없는 창은 Claude 가 떴는지조차 모르는 창이라 `tui-idle` 만 믿을 수 없다
  // (`outputQuiet` 머리 주석 — `Waiting for setup…` 화면이 통과한다). 그 틈에 착륙하면
  // `worktree rm --force` 가 아직 살아 있는 세션을 죽인다 (2026-08-30 slice10).
  // **유휴 대기보다 먼저** 본다 — 파일 한 번 읽은 값이라 창마다 5초씩 기다릴 이유가 없다.
  // 그래서 `작업 중 (TUI 유휴 아님)` 은 "조용한 지 오래인데 아직 도는 중"(긴 테스트·긴 사고)만 남는다.
  // 유휴의 원천은 **훅**이다 (`turnStateFor`). 화면이 다시 그려지는 것과 무관하므로, 워커가
  // 자기 Stop 훅으로 띄운 회차가 곧바로 자기 자신을 착륙시킨다 — Stop 이 곧 턴 끝이라 기다릴
  // 것이 없다. 훅 기록이 없는 창만 옛 판정(마지막 출력이 조용한가)으로 떨어진다.
  const turn = w.turn || { known: false };
  if (turn.known) {
    if (turn.active) return at('턴 진행 중 (프롬프트 뒤 Stop 이 아직 없음)', false);
  } else {
    const q = outputQuiet(w.lastOutputAt, opts.quietMs);
    const why = turn.stale ? '훅 턴이 안 끝난 채 오래됨' : '훅 기록 없음';
    if (!q.quiet) return at('방금까지 출력 — 다음 회차 (' + Math.round(q.ago / 1000) + '초 전) (' + why + ' — 출력 시각으로 판정)', false);
  }
  if (!asleep && !w.terminals.some((h) => isIdle(h, opts.idleMs))) return at('작업 중 (TUI 유휴 아님)', false);
  const res = landCheckWork(w, opts, base, at);
  // 잠든 워크스페이스의 사유 앞에 그 사실을 붙인다 — 미체크 막힘이면 사람이 탭을 열어야 이어갈 수 있다는 뜻이고,
  // 자격이 났으면 창 없이 착륙시켰다는 기록이다.
  if (asleep) res.reason = asleep.text + ' · ' + res.reason + (res.ready ? '' : ' — ' + SLEEP_WAKE_HINT);
  return res;
}

/**
 * `landCheck` 의 뒷부분 — **유휴가 확정된 뒤** 워커가 남긴 것을 본다: 체크·트리·커밋. TUI 와
 * 헤드리스가 유휴를 다르게 재고(앞부분) 여기서 합류한다. 부수효과 없음은 그대로다.
 */
function landCheckWork(w, opts, base, at) {
  // 워커가 체크했는가. 이것이 "완료 기준을 실행으로 확인했다"는 유일한 선언이다.
  const planFile = join(w.path, 'PLAN.md');
  if (!existsSync(planFile)) return at('워크스페이스에 PLAN.md 가 없음');
  // **모든 절에서** 찾는다 — 이 워커가 자기 절의 마지막 슬라이스를 체크했으면 현재 단계는
  // 이미 다음 절이고, 거기에는 자기 번호가 없다 (`sliceInPlan`).
  const s = sliceInPlan(parsePlanSlices(readFileSync(planFile, 'utf8')), w.slice);
  if (!s) return at('워크스페이스 PLAN.md 에 ' + w.slice + '번이 없음');
  if (!s.done) {
    // **막힌 것과 지시를 못 받은 것은 다르다** (슬라이스 16). 워커가 반쯤 하다 멈춘 것에는
    // 재전송하지 않지만(coordinator 규칙), 애초에 지시가 안 들어간 창은 막힌 게 아니라 빈 창이다.
    // 여기서는 판정만 하고 보내지는 않는다 — 지시는 파견의 몫이다 (회차는 착륙 → 파견 순).
    // 유휴는 방금 위에서 쟀으므로 다시 안 잰다.
    const st = undispatchedCheck(w, { baseRef: opts.baseRef, idle: true, text: sliceCommandFor(w.path, w.slice) });
    // `stalled` 는 같은 회차의 파견이 다시 재지 않게 넘기는 재료다 (fleetLand 가 스냅샷에 옮긴다).
    if (st.stalled) return { ...at('지시 미전송 — 파견이 다시 보낸다 (재파견 대상)', false), undispatched: st.why, stalled: st };
    return { ...at('유휴인데 ' + w.slice + '번이 미체크 — 막힘 (재전송하지 않음)'), stalled: st };
  }

  if (gitTry(['status', '--porcelain'], w.path).out) return at('작업 트리가 더러움 — 커밋 안 된 변경이 있다');
  const base2 = opts.baseRef;
  const ahead = gitTry(['log', '--oneline', base2 + '..HEAD'], w.path);
  if (!ahead.ok) return at(base2 + ' 을 못 읽음: ' + ahead.detail);
  if (!ahead.out) {
    // 커밋이 base 에 이미 다 들어가 있다. 머지까지 됐는데 정리만 남은 것일 수 있다 —
    // 머지 뒤에 회차가 끊기면 이 상태로 남는다. 그러면 자격 없음이 아니라 "정리만" 이다.
    // **그 PR 의 head 가 지금 HEAD 여야 한다** (`prIsForHead`). 브랜치 이름은 단계마다 되풀이되므로
    // (`slice5` 가 3단계에도 4단계에도 있다) `gh pr view` 는 옛 단계의 머지된 PR 을 돌려줄 수 있다 —
    // 그걸 믿으면 방금 만든 빈 워크스페이스를 "정리만 남음"으로 읽고 지운다 (2026-09-02 사고의 한쪽).
    const merged = prOf(w.path);
    if (merged && merged.state === 'MERGED' && prIsForHead(merged, gitTry(['rev-parse', 'HEAD'], w.path).out)) {
      return { ...base, ready: true, merged: true, pr: merged.number, reason: '이미 머지됨(#' + merged.number + ') — 정리만 남음' };
    }
    return at(base2 + ' 대비 커밋이 없음' + (merged && merged.state === 'MERGED' ? ' (옛 PR #' + merged.number + ' 은 다른 작업의 것)' : ''));
  }
  return { ...base, ready: true, reason: '체크 완료 · 커밋 ' + ahead.out.split('\n').length + '개 · 깨끗함', commits: ahead.out.split('\n') };
}

function ghJson(args, cwd, timeout = 60000) {
  const out = execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout });
  return JSON.parse(out);
}

/**
 * 그 브랜치의 PR 상태. 없으면 null.
 *
 * **열린 PR 이 없으면 `gh pr view` 는 같은 이름의 가장 최근 PR — 머지·닫힌 것 — 을 돌려준다.**
 * 브랜치 이름이 `sliceN` 이라 단계가 바뀌면 같은 이름이 되풀이되므로, 그 값이 이번 작업의 것이라는
 * 보장이 없다. 부르는 쪽이 `state`(`landOne` — OPEN 만 이어 쓴다)나 `headRefOid`(`landCheck` — 지금
 * HEAD 와 같아야 머지된 것으로 친다)로 거른다. 2026-09-02 SP-sync slice5: 3단계에서 머지된 #22 를
 * 4단계의 같은 이름 브랜치 것으로 읽어 "pr 있음 → pr merge → 정리" 로 워크스페이스를 지웠다 — 커밋은
 * 한 번도 안 올라간 채로. 03:11부터 07:14까지 여섯 워커의 슬라이스 5 커밋이 그렇게 버려졌다
 * (`git fsck --unreachable` 로 되찾았다).
 */
function prOf(path) {
  try {
    return ghJson(['pr', 'view', '--json', 'number,state,mergeable,mergeStateStatus,url,headRefOid'], path);
  } catch {
    return null;
  }
}

/** 그 PR 의 head 커밋이 지금 HEAD 인가. 둘 중 하나라도 모르면 아니다 — 모르는 채로 "머지됨"이라 하지 않는다. */
function prIsForHead(pr, headSha) {
  const a = String(pr?.headRefOid || '').trim();
  const b = String(headSha || '').trim();
  return !!a && !!b && a === b;
}

/**
 * 충돌을 워커에게 풀게 하는 말. **기본 브랜치를 못 박지 않는다** — `origin/main` 고정이던 동안
 * SP-sync·coordinator(`master`) 워커는 없는 브랜치를 머지하라는 말을 받았다.
 * 착륙의 base 판정(`baseBranchOf`)은 맞게 잡고 있었으므로 어긋난 것은 문장뿐이었다.
 */
const conflictText = (baseBranch) => 'origin/' + (baseBranch || 'main') + ' 머지해 충돌 풀고 커밋';

/**
 * 헤드리스 래퍼 턴이 **끝났는가** — `since` 이후에 시작한 래퍼 세션(`agent` 가 있는 것)이 그
 * 워크스페이스에 있고 `turnEndedAt` 이 찍혔으면 끝이다. `terminal wait --for exit` 를 못 쓰는
 * 이유는 셸이다: 래퍼가 끝나도 탭은 pwsh 프롬프트로 살아 있어 exit 대기가 시간 초과한다
 * (2026-09-02 실측). 래퍼가 턴 끝을 세션 기록에 찍으므로 그것을 본다 — `turnStateFor` 와 같은 재료.
 * `since` 를 받는 이유는 **앞 턴**이다 — 슬라이스 턴은 이미 끝나 있어 그것만 보면 열자마자 "끝남"이다.
 */
function headlessTurnDone(path, since, sessions) {
  const want = normPath(path);
  return Object.values(sessions || {}).some(
    (e) => e.agent && e.agent !== 'claude' && normPath(e.worktree) === want && (e.turnStartedAt || 0) >= since && (e.turnEndedAt || 0) >= (e.turnStartedAt || 0)
  );
}

/** 래퍼 턴이 끝날 때까지 세션 기록을 폴링한다. 상한을 넘기면 false. */
async function waitHeadlessTurn(path, since, timeoutMs, deps) {
  const until = deps.now() + timeoutMs;
  for (;;) {
    let sessions = {};
    try {
      sessions = deps.sessions();
    } catch {} // 반쯤 쓰인 state.json — 다음 폴링에서 다시 읽는다
    if (headlessTurnDone(path, since, sessions)) return true;
    if (deps.now() >= until) return false;
    await deps.sleep(Math.min(HEADLESS_POLL_MS, Math.max(0, until - deps.now())));
  }
}
const HEADLESS_POLL_MS = 5000;

/** 충돌 루프가 쓰는 바깥 손. 테스트는 이것들을 가짜로 갈아 끼운다. TUI 는 앞 다섯, 헤드리스는 뒤 넷을 쓴다. */
const CONFLICT_DEPS = {
  send: wakeOne,
  idle: isIdle,
  push: (path) => gitTry(['push', 'origin', 'HEAD'], path),
  read: prOf,
  // 지시가 갈 창. 재파견과 같은 잣대다 — 워크스페이스에는 셸 탭도 같이 떠 있다.
  pick: (terminals, io) => claudeTerminal(terminals, io),
  // 헤드리스: 새 턴 = 새 래퍼 프로세스. 창은 path 로 고른다(착륙 스냅샷에는 워크트리 id 가 없다).
  createTerminal: (path, title, command, ms) => {
    const t = orcaJson(['terminal', 'create', '--worktree', 'path:' + path, '--title', title, '--command', command], ms);
    return t?.terminal?.handle || t?.handle || null;
  },
  sessions: () => state().sessions || {},
  sleep,
  now: Date.now,
};

/**
 * 충돌을 워커에게 풀리고, **푼 것을 밀고**, PR 을 다시 읽는다 — 이 셋이 한 시도다.
 *
 * **push 가 이 자리에 있어야 한다.** 워커는 push 를 하지 않는 것이 규칙이라(`~/orca/CLAUDE.md`)
 * 워커가 머지 커밋을 만들어도 원격은 충돌 그대로다. 밀지 않고 PR 을 다시 읽으면 언제나
 * CONFLICTING 이 나와, 재시도 상한을 다 쓰고 "사용자 결정 필요"로 끝난다 — 워커는 이미 풀었는데.
 * 2026-08-30 slice15 에서 그대로 일어났다: 같은 지시가 두 번 왔고 두 번 다 풀 것이 없었다.
 *
 * **push 실패도 시도 1회로 센다.** 여기서 건너뛰고 다시 보내면 상한이 무의미해지고, 워커에게는
 * 이미 푼 충돌을 다시 풀라는 말이 계속 간다. 실패 사유는 `steps` 에 남아 보고로 나간다.
 *
 * **헤드리스**(4단계)는 REPL 이 없어 `deps.send` 로 쳐 넣을 곳이 없다. 대신 같은 문장을 `--prompt` 로
 * 실은 래퍼를 `terminal create --command` 로 새로 띄우고(새 프로세스 = 새 턴), 유휴 대신 세션 기록의
 * 턴 끝(`waitHeadlessTurn`)을 기다린다. 상한 안에 안 끝나면 **그 자리에서 접는다**(`timedOut`) —
 * 한 번 더 띄우면 아직 도는 래퍼 위에 같은 지시가 겹친다. 다음 회차의 `landCheck` 가 그 턴을
 * "작업 중"으로 보고, 끝난 뒤 다시 여기로 온다(푼 것이 있으면 그 턴은 풀 것 없이 끝난다).
 */
async function conflictLoop(w, pr, opts, step, deps = CONFLICT_DEPS) {
  const headless = headlessOf(w);
  for (let i = 0; pr?.mergeable === 'CONFLICTING' && i < opts.conflictTries; i++) {
    if (headless) {
      const since = deps.now();
      let command;
      let h = null;
      try {
        command = workerPromptCommand(headless, conflictText(opts.baseBranch), opts.agents);
        h = deps.createTerminal(w.path, w.name + ' 충돌', command, opts.createMs);
      } catch (e) {
        step('충돌 해소', false, '래퍼 못 띄움: ' + clean(e.message, 200));
        return { pr, noTerminal: true };
      }
      if (!h) {
        step('충돌 해소', false, '래퍼 못 띄움: 터미널 핸들을 못 받음');
        return { pr, noTerminal: true };
      }
      step('충돌 해소 ' + (i + 1) + '회', true, '헤드리스(' + headless + ') 래퍼 턴 열음: ' + command);
      if (!(await waitHeadlessTurn(w.path, since, opts.conflictMs, deps))) {
        step('충돌 대기 ' + (i + 1) + '회', false, '래퍼 턴이 ' + Math.round(opts.conflictMs / 1000) + '초 안에 안 끝남 — 다음 회차에');
        return { pr, timedOut: true };
      }
    } else {
      // 못 고르면 **보내지 않는다.** 워커가 아직 도는 중이면 화면에 `❯` 가 없는데, 그때 첫 창으로
      // 떨어지면 셸 탭에 머지 지시가 들어가고 그 헛시도가 재시도 상한을 깎는다 (2026-09-01 리뷰).
      const h = (deps.pick || CONFLICT_DEPS.pick)(w.terminals, deps.io);
      if (!h) {
        // 잠든 창(절전)이면 "창이 없음"이 아니라 "사람이 열어야 함"이다 — 깨우는 CLI 가 없다 (슬라이스 28).
        const asleep = sleepingOf(w);
        step('충돌 해소', false, (w.terminals || []).length ? 'Claude 창을 못 골라 못 보냄' : asleep ? asleep.text + ' — 못 보냄, ' + SLEEP_WAKE_HINT : '창이 없어 못 보냄');
        return { pr, noTerminal: true, sleeping: !!asleep };
      }
      const sent = await deps.send(h, conflictText(opts.baseBranch));
      step('충돌 해소 ' + (i + 1) + '회', sent.sent, sent.result);
      // 워커가 풀 때까지 기다린다. 유휴가 되면 끝난 것이다.
      await deps.idle(h, opts.conflictMs);
    }
    const pushed = await deps.push(w.path);
    step('충돌 push ' + (i + 1) + '회', !!pushed.ok, pushed.ok ? w.branch : pushed.detail);
    pr = (await deps.read(w.path)) || pr;
  }
  return { pr };
}

/** 보고에 적는 짧은 SHA. 모르면 `?` — 빈 칸으로 두면 "검사했음"처럼 읽힌다. */
const sha7 = (s) => String(s || '').trim().slice(0, 7) || '?';

/**
 * 프로젝트별 검사 명령(`fleetChecks`)을 **지금 HEAD 에서** 돌리고 그 SHA 를 결과에 붙인다.
 * 검사가 설정돼 있지 않아도 SHA 는 적는다 — 머지 직전 게이트(`mergeGate`)가 "검사한 것과 같은
 * 커밋인가"를 이 값으로 재므로, 검사가 없을 때도 "자격 판정을 본 커밋" 은 남아야 한다.
 * SHA 를 못 읽으면 빈 값이고, 게이트는 빈 값을 절대 `merge` 로 내지 않는다.
 */
function runCheck(w, opts) {
  const sha = gitTry(['rev-parse', 'HEAD'], w.path).out;
  if (!opts.check) return { ok: true, sha, detail: '검사 명령 없음 — SHA 만 기록' };
  try {
    execFileSync(opts.check, {
      cwd: w.path,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: opts.checkMs,
    });
    return { ok: true, sha, detail: opts.check };
  } catch (e) {
    return { ok: false, sha, detail: opts.check + ': ' + clean(e.stdout || e.message, 300) };
  }
}

/**
 * 머지 직전 게이트 — **순수 함수.** 로컬 HEAD·PR 의 원격 머리·검사한 SHA 셋이 같을 때만 `merge`.
 *
 * 착륙은 검사 → push/PR → 충돌 해소 순이라, 검사한 뒤에도 커밋이 바뀔 자리가 둘 있다: 워커가 검사 뒤에
 * 커밋을 더 얹는 것, 충돌 해소가 머지 커밋을 만드는 것. 열린 PR 을 이어 쓸 때는 push 를 건너뛰므로
 * 원격 머리가 로컬보다 뒤처진 채일 수도 있다. 2026-09-08 SP-sync slice30 은 `check → push → PR →
 * 충돌 해소 → push → merge` 로 갔다 — 머지된 것이 검사한 것과 같다는 보증이 없었다(coordinator 점검 #1).
 *
 * 우선순위: 로컬≠검사 → `recheck` (그 HEAD 로 자격 판정과 검사를 다시 한다) · PR 머리≠로컬 → `push`
 * (밀고 다시 읽는다) · 셋이 같음 → `merge`. **모르는 값은 절대 `merge` 가 아니다** — SHA 를 못 읽은 채
 * 머지하면 게이트가 없는 것과 같다.
 */
function mergeGate({ localHead, prHead, checkedSha }) {
  const l = String(localHead || '').trim();
  const p = String(prHead || '').trim();
  const c = String(checkedSha || '').trim();
  if (!l) return { action: 'recheck', why: '로컬 HEAD 를 모름' };
  if (!c) return { action: 'recheck', why: '검사한 SHA 가 없음' };
  if (l !== c) return { action: 'recheck', why: '로컬 ' + sha7(l) + ' ≠ 검사 ' + sha7(c) };
  if (!p) return { action: 'push', why: 'PR 머리를 모름' };
  if (p !== l) return { action: 'push', why: 'PR 머리 ' + sha7(p) + ' ≠ 로컬 ' + sha7(l) };
  return { action: 'merge', why: '로컬 = PR = 검사 ' + sha7(l) };
}

/**
 * 게이트가 `recheck`/`push` 를 내면 맞춘 뒤 다시 재는데, 그 횟수 상한. 워커가 계속 커밋을 얹거나 원격이
 * 계속 뒤처지면 끝이 없다 — 그건 "지금 착륙할 상태가 아님" 이라 다음 회차로 넘긴다.
 */
const FINAL_GATE_TRIES = 3;

/** `landOne` 이 쓰는 바깥 손. 테스트는 이것들을 가짜로 갈아 끼워 step 이름까지 단언한다. */
const LAND_DEPS = {
  head: (path) => gitTry(['rev-parse', 'HEAD'], path).out,
  check: runCheck,
  read: prOf,
  // 첫 push 만 `-u` — 이후는 같은 브랜치라 추적이 이미 있다.
  push: (path, first) => gitTry(first ? ['push', '-u', 'origin', 'HEAD'] : ['push', 'origin', 'HEAD'], path),
  create: (path, opts) =>
    execFileSync('gh', ['pr', 'create', '--fill', '--base', opts.baseBranch], {
      cwd: path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: opts.ghMs,
    }),
  merge: (path, number, opts) =>
    execFileSync('gh', ['pr', 'merge', String(number), '--merge'], {
      cwd: path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: opts.ghMs,
    }),
  conflict: (w, pr, opts, step) => conflictLoop(w, pr, opts, step),
  // 재판정은 자격 판정과 **같은 함수** — `[x]`·트리 깨끗·`wait` 빔·유휴를 그 HEAD 로 다시 본다.
  recheck: (w, opts) => landCheck(w, { idleMs: opts.idleMs, quietMs: opts.quietMs, baseRef: opts.baseRef, ignoreWait: opts.ignoreWait }),
  cleanup: (w, r, step, opts) => landCleanup(w, r, step, opts),
};

/**
 * 한 워크스페이스를 실제로 착륙시킨다. 던지지 않는다 — 한 창의 실패가 다음 창을 막으면 안 된다.
 * 머지까지 갔으면 워크스페이스를 지우고 본체를 ff 한다.
 *
 * 순서: 검사(`runCheck`, HEAD₀) → push/PR(**열린 PR 이 있어도** 원격 머리가 로컬과 다르면 push) →
 * 충돌 해소(`conflictLoop`) → **최종 게이트**(`mergeGate`) → 게이트가 `merge` 를 낼 때만 `gh pr merge`.
 * 검사한 SHA 는 `r.checkedSha` 에, 게이트를 통과한 SHA 는 `r.finalSha` 에 남고 `steps` 에 `check <sha7>`·
 * `final <sha7>` 줄이 선다. 검사 명령이 없어도 SHA 일치 확인은 한다.
 */
async function landOne(w, c, opts, deps = LAND_DEPS) {
  const r = { name: w.name, slice: w.slice, path: w.path, steps: [] };
  const step = (s, ok, detail) => {
    r.steps.push({ step: s, ok, detail: detail || '' });
    if (!opts.json && !opts.quiet) console.log('  ' + w.name + '  ' + s + (ok ? ' ✓' : ' ✗') + (detail ? '  ' + detail : ''));
    return ok;
  };
  // 이미 머지된 것은 정리만 한다. 검사·PR·머지를 다시 시도하면 안 된다.
  if (c.merged) {
    r.pr = c.pr;
    step('이미 머지됨', true, '#' + c.pr);
    return await deps.cleanup(w, r, step, opts);
  }
  // 검사 — 그 HEAD 를 적어 둔다. 자동 머지를 허용한 만큼 한 겹 더 두는 자리이고(`fleetChecks`), 명령이
  // 없어도 "어느 커밋을 봤나" 는 남긴다 — 아래 최종 게이트의 재료다.
  const check = () => {
    const res = deps.check(w, opts);
    r.checkedSha = res.sha;
    return step('check ' + sha7(res.sha), res.ok, res.detail);
  };
  if (!check()) return { ...r, ok: false, stage: 'check' };

  let pr = await deps.read(w.path);
  // **열린 PR 만 이어 쓴다.** 같은 이름의 옛 PR(머지·닫힘)을 이번 것으로 알면 `pr merge` 가 "이미 머지됨"으로
  // 실패하고, 아래의 재조회가 그 MERGED 를 성공으로 읽어 워크스페이스를 지운다 — 커밋은 한 번도 안 올라간
  // 채로 (2026-09-02 SP-sync slice5, 3단계 PR #22 — 여섯 번 되풀이됐다). 옛 것은 보고에 남기고 새로 만든다.
  if (pr && pr.state !== 'OPEN') {
    step('옛 PR 무시', true, '#' + pr.number + ' ' + pr.state + ' — 같은 이름 브랜치의 다른 작업');
    pr = null;
  }
  if (!pr) {
    // **push 를 따로 한다.** `gh pr create --fill` 은 대화형일 때만 "push 할까요?"를 묻고,
    // 비대화형에서는 "you must first push the current branch" 로 그냥 죽는다 (2026-08-30 실측).
    const push = await deps.push(w.path, true);
    if (!step('push ' + sha7(r.checkedSha), push.ok, push.ok ? w.branch : push.detail)) return { ...r, ok: false, stage: 'push' };
    try {
      deps.create(w.path, opts);
    } catch (e) {
      step('pr create', false, clean(e.stderr || e.message, 300));
      return { ...r, ok: false, stage: 'pr-create' };
    }
    pr = await deps.read(w.path);
    if (!pr) {
      step('pr create', false, 'PR 을 만들었지만 다시 읽지 못함');
      return { ...r, ok: false, stage: 'pr-create' };
    }
    step('pr create', true, '#' + pr.number);
  } else {
    step('pr 있음', true, '#' + pr.number);
    // 열린 PR 을 이어 쓸 때는 push 가 없어서 원격 머리가 로컬보다 뒤처진 채일 수 있다 — 지난 회차가 PR 을
    // 만든 뒤 워커가 커밋을 더 얹은 경우. 그대로 두면 충돌 판정과 머지가 옛 머리를 본다. 먼저 맞춘다.
    const local = deps.head(w.path);
    if (!prIsForHead(pr, local)) {
      const push = await deps.push(w.path, false);
      if (!step('push ' + sha7(local), push.ok, push.ok ? 'PR 머리 ' + sha7(pr.headRefOid) + ' 가 뒤처져 있었음' : push.detail))
        return { ...r, ok: false, stage: 'push' };
      pr = (await deps.read(w.path)) || pr;
    }
  }
  r.pr = pr.number;
  r.url = pr.url;

  // 충돌이면 그 세션에 고정 프롬프트를 보내 풀게 한다. 2회 실패면 사용자 결정으로.
  const cl = await deps.conflict(w, pr, opts, step);
  pr = cl.pr;
  if (cl.noTerminal) return { ...r, ok: false, stage: 'conflict', needsUser: true };
  // 헤드리스 래퍼 턴이 상한 안에 안 끝난 것 — 사람 몫이 아니라 다음 회차 몫이다 (`conflictLoop`).
  if (cl.timedOut) return { ...r, ok: false, stage: 'conflict' };
  if (pr.mergeable === 'CONFLICTING') {
    step('충돌', false, opts.conflictTries + '회 시도 후에도 CONFLICTING — 사용자 결정 필요');
    return { ...r, ok: false, stage: 'conflict', needsUser: true };
  }

  // **최종 게이트.** 검사한 것·로컬·원격 PR 머리가 같을 때만 머지한다 (`mergeGate`). 어긋나면 맞추고 다시 잰다:
  // 로컬이 검사 뒤에 바뀌었으면(워커의 추가 커밋·충돌 해소 머지 커밋) 그 HEAD 로 자격 판정과 검사를 다시,
  // 원격이 뒤처졌으면 push 뒤 재조회. 상한(`FINAL_GATE_TRIES`)을 넘기면 이번 회차는 접는다.
  for (let i = 0; ; i++) {
    const localHead = deps.head(w.path);
    const g = mergeGate({ localHead, prHead: pr?.headRefOid, checkedSha: r.checkedSha });
    if (g.action === 'merge') {
      r.finalSha = localHead;
      step('final ' + sha7(localHead), true, g.why);
      break;
    }
    if (i >= FINAL_GATE_TRIES) {
      step('final', false, g.why + ' — ' + i + '회 맞춘 뒤에도 안 맞음, 다음 회차에');
      return { ...r, ok: false, stage: 'final' };
    }
    if (g.action === 'recheck') {
      const again = deps.recheck(w, opts);
      if (!step('재판정 ' + sha7(localHead), !!again.ready, again.reason)) return { ...r, ok: false, stage: 'recheck', recheck: again };
      if (!check()) return { ...r, ok: false, stage: 'check' };
      continue;
    }
    // push — 원격 머리가 로컬과 다르다.
    const push = await deps.push(w.path, false);
    if (!step('push ' + sha7(localHead), push.ok, push.ok ? g.why : push.detail)) return { ...r, ok: false, stage: 'push' };
    pr = (await deps.read(w.path)) || pr;
  }

  // **`--delete-branch` 를 쓰지 않는다.** gh 가 머지 뒤 로컬 정리로 기본 브랜치를 체크아웃하려
  // 드는데, `main` 은 본체 워크트리가 이미 쓰고 있어서 "'main' is already used by worktree at …"
  // 로 죽는다 (2026-08-30 실측). **그때 API 머지는 이미 끝나 있다** — 그래서 실패로 보이면
  // 상태를 다시 읽어 MERGED 면 성공으로 친다. 브랜치 정리는 아래에서 따로 한다.
  try {
    deps.merge(w.path, pr.number, opts);
  } catch (e) {
    const again = await deps.read(w.path);
    // **같은 번호**여야 한다 — 같은 이름의 옛 머지 PR 이 여기서도 성공으로 읽힐 수 있다.
    if (again?.state !== 'MERGED' || again.number !== pr.number) {
      step('pr merge', false, clean(e.stderr || e.message, 300));
      return { ...r, ok: false, stage: 'merge' };
    }
  }
  step('pr merge', true, '#' + pr.number);
  return await deps.cleanup(w, r, step, opts);
}

/** 머지 뒤 정리: 워크스페이스 삭제 → 원격·로컬 브랜치 삭제 → 본체 ff. */
async function landCleanup(w, r, step, opts) {
  // Orca 가 머지 후 자동으로 지우면 이미 없다. 없으면 지운 것으로 친다.
  // **목록을 못 읽어도 던지지 않는다** — 여기는 머지가 이미 끝난 자리라, orca 가 잠깐 안 뜬 것
  // 때문에 예외가 나면 `landOne` 을 뚫고 나가 회차 보고에 그 프로젝트가 통째로 "실패"로 남는다.
  // 모르면 남아 있다고 보고 지우기를 시도한다 — 실패는 아래에서 한 줄로 보고된다.
  let stillThere = true;
  try {
    stillThere = (orcaJson(['worktree', 'list']).worktrees || []).some((x) => normPath(x.path) === normPath(w.path));
  } catch {}
  if (stillThere) {
    try {
      orcaJson(['worktree', 'rm', '--worktree', 'id:' + opts.repoId + '::' + w.path, '--force'], opts.ghMs);
      step('worktree rm', true);
    } catch (e) {
      step('worktree rm', false, clean(e.message, 200));
    }
  } else {
    step('worktree rm', true, 'Orca 가 이미 정리함');
  }
  // **폴더까지 지운다.** `orca worktree rm` 은 git 등록과 추적 파일만 걷어내고 폴더는 남긴다 —
  // 무시된 산출물(`node_modules`)이 있으면 그것까지, 없어도 빈 폴더가 남는다. 그 껍데기가
  // 다음 단계에서 같은 번호의 파견을 막는다: 슬라이스 번호는 단계마다 1로 되감기는데 Orca 는
  // 이름이 겹치면 `slice4-2` 로 비켜 만들고, 그 이름은 `sliceNumberOf` 에 안 걸려 **영영 착륙하지
  // 못하며** 창이 살아 있는 동안 그 프로젝트의 새 파견까지 `strayBlock` 으로 멈춘다
  // (2026-09-02: SP-sync 3·4 와 CW 4 가 그렇게 나서 사람이 손으로 머지했다).
  // 여기는 PR 이 이미 머지된 자리라 남은 것은 무시된 산출물뿐이다. 실패해도 착륙은 성공이다.
  const rmDir = removeWorkspaceDir(w.path, opts.root);
  step('폴더 삭제', rmDir.ok, rmDir.detail);
  // 폴더가 사라졌으면 그 워크스페이스가 쥔 공유 자원을 놓는다 (슬라이스 42). **삭제 성패와 무관하게**
  // 부른다 — 머지가 이미 끝난 자리라 그 슬라이스는 폰을 다 쓴 것이고, 놓지 않으면 폴더 하나가 안 지워진
  // 것 때문에 그 자원이 다음 회차까지 죽는다(회수는 폴더가 있으면 안 걷는다).
  const rel = releaseResources({ workspace: w.path });
  if (rel.released.length) step('자원 해제', true, rel.released.join(', '));
  // 브랜치 정리는 워크트리가 사라진 뒤에만 된다 — 체크아웃 중인 브랜치는 못 지운다.
  // 실패해도 착륙 자체는 성공이다(원격이 자동 삭제로 설정돼 있을 수도 있다).
  const rm = gitTry(['push', 'origin', '--delete', w.branch], opts.root);
  const rmLocal = gitTry(['branch', '-D', w.branch], opts.root);
  step('브랜치 삭제', rm.ok || rmLocal.ok, [rm.ok ? '원격' : '', rmLocal.ok ? '로컬' : ''].filter(Boolean).join('·') || rm.detail);
  // 본체 ff. **기본 브랜치에 서 있을 때만 한다** — 다른 브랜치면 `pull --ff-only` 가 엉뚱하게 그
  // 브랜치를 그 upstream 에서 ff 하려 든다. 거기는 "로컬에만 두는 커밋" 자리다 (`syncMain` 과 같은 잣대).
  //
  // **더러움은 안 본다.** `syncMain` 은 ff 를 미루지만 여기서 같이 미루면 안 된다 — 이 ff 가
  // 방금 머지한 `- [x]` 를 본체 PLAN.md 로 가져오는 유일한 통로이고, 그게 끊기면 **같은 회차의
  // 파견이 옛 PLAN.md 를 읽어 방금 착륙시킨 슬라이스를 다시 띄운다** (`slice10-2` 와 같은 사고).
  // 본체는 사용자의 작업 브랜치라 웬만하면 더러운데, `pull --ff-only` 는 덮어쓸 파일이 있을 때만
  // 거부하므로 상관없는 수정이 있는 트리는 그대로 ff 된다 — 그래서 거는 것이 맞다 (2026-09-01 리뷰).
  const branch = gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], opts.root).out;
  if (branch !== opts.baseBranch) {
    const why = '본체가 ' + (branch || '?') + ' 에 있음 (기본 브랜치 ' + opts.baseBranch + ' 아님)';
    step('본체 pull --ff-only', true, '건너뜀 — ' + why);
    return { ...r, ok: true, ff: false, ffSkipped: why };
  }
  const pull = gitTry(['pull', '--ff-only'], opts.root);
  step('본체 pull --ff-only', pull.ok, pull.ok ? '' : pull.detail);
  return { ...r, ok: true, ff: pull.ok };
}

async function fleetLand(arg, opts) {
  // 회차는 착륙과 파견에 **같은 스냅샷**을 넘긴다 (`opts.slices`) — 한 바퀴에 orca 목록·state·
  // 워크스페이스별 git 을 두 번 훑을 이유가 없다. 손으로 부르면 여기서 한 번 읽는다.
  const r = opts.slices || fleetSlices(arg);
  const root = repoRoot(r.root);
  // 원격이 없으면 PR 을 만들 수 없다. 먼저 말해 준다 — gh 오류로 알게 하지 않는다.
  // `opts.sync` 는 회차가 방금 돌린 `syncMain` 의 결과다. 거기서 이미 fetch 했고 기본 브랜치도
  // 같은 잣대로 골랐으므로 다시 재지 않는다 — 회차 한 바퀴의 fetch 가 둘에서 하나로 준다.
  const hasRemote = opts.sync ? !!opts.sync.hasRemote : !!gitTry(['remote'], root).out;
  const baseBranch = opts.sync ? opts.sync.baseBranch : baseBranchOf(root, opts.base);
  const baseRef = hasRemote ? 'origin/' + baseBranch : baseBranch;
  if (hasRemote && !opts.sync) gitTry(['fetch', 'origin', baseBranch], root); // 판정 전에 최신 base 를 받는다

  // 프로젝트별 check 명령은 여기서 고른다 — 이름을 SP 프로젝트명으로 푸는 건 fleetSlices 가 하므로.
  const check = opts.check || (opts.checks || {})[r.project] || null;
  const checks = r.workspaces.map((w) => landCheck(w, { idleMs: opts.idleMs, quietMs: opts.quietMs, baseRef, ignoreWait: opts.ignoreWait }));
  // 착륙이 잰 "지시 미전송" 재료를 스냅샷에 남긴다 — 같은 회차의 파견이 창당 5초 유휴 대기를
  // 다시 하지 않게. 같은 재료(baseRef·지시 문구)로 재는 판정이라 값이 갈릴 일이 없다.
  for (let i = 0; i < r.workspaces.length; i++) if (checks[i].stalled) r.workspaces[i].stalled = checks[i].stalled;
  const out = {
    at: Date.now(),
    project: r.project,
    root,
    baseBranch,
    baseRef,
    hasRemote,
    dryRun: !!opts.dryRun,
    checks,
    landed: [],
  };
  const ready = checks.filter((c) => c.ready);
  if (!opts.dryRun && ready.length) {
    if (!hasRemote) {
      out.error = '원격(origin)이 없어 PR 을 만들 수 없습니다: ' + root;
    } else {
      const repoId = repoIdOf(root);
      for (const c of ready) {
        const w = r.workspaces.find((x) => x.path === c.path);
        const d = await landOne(w, c, { ...opts, check, root, repoId, baseBranch, baseRef });
        out.landed.push(d);
        log('fleet land ' + r.project + ' ' + w.name + ' ' + (d.ok ? 'ok' : d.stage + ' 실패'));
      }
    }
  }
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else if (!opts.quiet) process.stdout.write(renderLand(out));
  return out;
}

/** 착륙 뒤 본체 ff 결과 한 마디. 안 한 것(다른 브랜치·더러움)과 실패를 가른다. */
function ffText(d) {
  return d.ff ? '본체 ff' : d.ffSkipped ? '본체 ff 건너뜀 — ' + d.ffSkipped : '본체 ff 실패';
}

function renderLand(o) {
  const L = [
    o.project + '  —  착륙 (base ' + o.baseRef + (o.hasRemote ? '' : ', 원격 없음') + ')',
    (o.dryRun ? '(dry-run) ' : '') + '워크스페이스 ' + o.checks.length + ' · 자격 ' + o.checks.filter((c) => c.ready).length,
    '',
  ];
  if (o.error) L.push('⚠ ' + o.error, '');
  if (o.checks.length) {
    const cols = [
      ['워크스페이스', 14, (c) => c.name],
      ['번호', 5, (c) => (c.slice == null ? '-' : String(c.slice))],
      ['판정', 6, (c) => (c.ready ? '착륙' : c.blocked ? '막힘' : '제외')],
      ['이유', 60, (c) => c.reason],
    ];
    const line = (cells) => cells.map(([v, w]) => fitCell(v, w)).join('  ').replace(/\s+$/, '');
    L.push(line(cols.map(([h, w]) => [h, w])), cols.map(([, w]) => '-'.repeat(w)).join('  '));
    for (const c of o.checks) L.push(line(cols.map(([, w, f]) => [f(c), w])));
  } else {
    L.push('활성 워크스페이스 없음');
  }
  if (!o.dryRun && o.landed.length) {
    L.push('');
    for (const d of o.landed) L.push('  ' + d.name + '  ' + (d.ok ? '머지됨 #' + d.pr + ' · ' + ffText(d) : d.stage + ' 실패'));
  }
  const needUser = (o.landed || []).filter((d) => d.needsUser);
  if (needUser.length) L.push('', '사용자 결정 필요: ' + needUser.map((d) => d.name).join(', '));
  return L.join('\n') + '\n';
}

// ---------- fleet cycle ----------
/**
 * `fleet cycle [--project …]` — 한 회차: **착륙 → 파견 → 보고**.
 *
 * 순서가 뒤바뀌면 안 된다. 착륙이 먼저여야 끝난 워크스페이스가 자리를 비우고, 그 자리에 파견이
 * 들어간다. 파견을 먼저 하면 동시 상한이 이미 찬 것으로 보여 그 회차는 아무것도 안 띄운다.
 *
 * **모델을 안 부른다.** 그래서 Windows 작업 스케줄러로 30분마다 돌릴 수 있다 — Orca automation
 * 은 회차마다 모델 세션을 띄우므로 이 용도엔 맞지 않다. 팀장 세션은 여기 쌓인 보고를 읽을 뿐이다.
 *
 * 한 프로젝트가 실패해도 다음 프로젝트로 간다. 회차가 통째로 죽으면 다음 30분까지 아무 기록도
 * 안 남는데, 그게 제일 나쁜 결과다.
 */
function cycleProjects(names) {
  if (names.length) return names;
  // 안 주면 `~/orca/projects` 밑에서 PLAN.md 가 있는 것 전부. 슬라이스 단위로 도는 프로젝트만이
  // 파견·착륙의 대상이다.
  const dir = join(HOME, 'orca', 'projects');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(dir, d.name, 'PLAN.md')))
    .map((d) => d.name);
}

/**
 * 일시 제외 목록으로 회차 대상을 가른다. **`--project` 로 직접 준 이름에도 건다** — 스위치가
 * 경로에 따라 다르게 들으면 "빼 뒀다"를 믿을 수 없다. 다시 돌리려면 `fleet resume` 이다.
 * 이름은 대소문자를 안 가리고 앞뒤 공백을 턴다 — 손으로 config.json 에 적어 넣을 수 있는 값이다.
 */
function splitPaused(names, pause) {
  const run = [];
  const paused = [];
  for (const n of names) (isPaused(n, pause) ? paused : run).push(n);
  return { names: run, paused };
}

/**
 * 이 프로젝트가 일시 제외 목록에 있는가. **비교는 한 곳에서만 한다** — 트리거는 정확 일치로,
 * 회차는 대소문자를 무시하고 보던 동안 `fleet pause sp-sync` 한 번으로 회차는 멈추고 트리거는
 * 계속 뜨는 어긋남이 있었다. 손으로 config.json 에 적어 넣는 값이라 느슨한 쪽으로 맞춘다.
 */
const pauseKey = (v) => String(v == null ? '' : v).trim().toLowerCase();

function isPaused(name, pause) {
  const k = pauseKey(name);
  return !!k && (Array.isArray(pause) ? pause : []).some((v) => pauseKey(v) === k);
}

/**
 * 이 프로젝트가 **파견 제외**(`fleetNoDispatch`) 인가 — 슬라이스를 나눠 주지는 않지만 본체
 * 동기화(push/ff)는 해 주는 저장소. `isPaused` 와 같은 느슨한 비교를 쓴다(대소문자·공백 무시).
 *
 * 예전에는 이름 `'coordinator'` 이 `fleetPrecheck` 와 `cycleTriggerCheck` 에 그대로 박혀 있었고,
 * 그 둘이 "회차 대상이 아님" 으로 통째로 걸러 **동기화까지** 빠졌다 — 팀장이 직접 커밋하는
 * 저장소인데 세션은 push 를 안 하므로 본체가 15 커밋 밀린 채 있었다 (슬라이스 41).
 * 파견 제외와 동기화 제외는 다른 것이다: 후자는 `fleetPause` 다.
 */
function isNoDispatch(name, list) {
  return isPaused(name, list);
}

/**
 * 지금 이 폴더가 속한 프로젝트 이름. `fleet pause|resume --here` 가 쓴다 — Orca 빠른 명령은
 * 현재 워크트리에서 새 탭을 열어 명령을 그대로 치는 것이라 명령 문자열에 프로젝트명을 끼워 넣을
 * 자리가 없다(변수 치환 없음, 2026-09-03 실측). 그래서 전역 빠른 명령 하나가 모든 프로젝트를 덮으려면
 * 명령 쪽이 현재 폴더로 프로젝트를 알아내야 한다.
 *
 * 워크스페이스에서 불러도 `repoRoot` 가 git 공용 디렉터리로 본체까지 올라가므로 같은 이름이 나온다.
 * **본체가 `~/orca/projects/<프로젝트>` 바로 밑이 아니면 거부한다** — 회차가 다루는 프로젝트는 그것뿐이라,
 * 다른 저장소(orca-windows, ~/dev)에서 누른 빠른 명령이 엉뚱한 이름을 `fleetPause` 에 남기면 안 된다.
 */
function projectHere(cwd = process.cwd(), dir = join(HOME, 'orca', 'projects')) {
  const root = repoRoot(cwd);
  if (normPath(dirname(root)) !== normPath(dir))
    throw new Error('프로젝트 폴더가 아님: ' + cwd + ' (' + dir + ' 밑의 프로젝트나 그 워크스페이스 안에서만)');
  return basename(root);
}

/**
 * `fleet pause|resume [<프로젝트>|--here]` — 자동 회차에서 잠깐 빼고 넣는다. 이름을 안 주면 지금 목록만
 * 보여 준다. `--here` 는 현재 폴더의 프로젝트(`projectHere`) — Orca 전역 빠른 명령용이다.
 * 판단이 없는 일이라 모델 세션 없이 터미널 한 줄로 끝나는 것이 목적이다.
 *
 * **없는 프로젝트는 거부한다.** 오타가 조용히 배열에 남으면 그 이름은 아무것도 안 막으면서
 * 목록에는 계속 보인다 — 스위치를 켜 뒀다고 믿는 동안 파견이 계속 들어간다.
 *
 * 저장할 때 `config()` 가 아니라 **파일 원본**을 읽는다. 기본값이 병합된 객체를 되쓰면 지금
 * 기본값이 통째로 config.json 에 박혀, 나중에 기본값을 고쳐도 이 파일이 옛 값을 이긴다.
 */
function fleetPauseSet(arg, { off = false, here = false, cwd = process.cwd() } = {}) {
  const raw = readJson(CONFIG_FILE, {});
  const list = (Array.isArray(raw.fleetPause) ? raw.fleetPause : []).map(String).filter(Boolean);
  const a = String(arg || '').trim();
  if (here && a) throw new Error('--here 와 프로젝트 이름은 같이 줄 수 없습니다');
  if (!a && !here) return { list, changed: false };
  const name = here ? projectHere(cwd) : basename(resolveProjectRoot(a)); // 없는 이름·프로젝트 밖이면 여기서 던진다
  const had = isPaused(name, list);
  const next = off ? list.filter((v) => pauseKey(v) !== pauseKey(name)) : had ? list : [...list, name];
  const changed = off ? had : !had;
  if (changed) writeJson(CONFIG_FILE, { ...raw, fleetPause: next });
  return { list: next, changed, name };
}

/**
 * `fleetProjectAgent` 맵에서 한 프로젝트의 워커 에이전트를 바꾼 **다음 맵**. 부수효과 없음 —
 * `fleetAgentSet` 이 파일에 쓰고, 테스트는 이것만 본다.
 *
 * - `claude` 는 기본값이라 **키를 지운다** — 값으로 남기면 "비어 있으면 claude" 라는 설정 주석과
 *   두 모양이 생긴다. 돌려주는 `agent` 는 그래도 `claude` 다.
 * - 키 비교는 `normTitle`(대소문자·공백 무시) — 손으로 적어 둔 옛 키(`project a`)가 새 키와
 *   나란히 남으면 어느 쪽을 읽을지 파견마다 갈린다.
 * - 이름은 `claude` 이거나 `fleetAgents` 프로필에 있어야 한다. 모르는 이름을 넣으면 그 프로젝트의
 *   슬라이스가 전부 "모르는 에이전트" 로 보류된다 — 여기서 거부한다.
 */
function nextProjectAgent(map, project, agent, agents) {
  const want = String(agent || '').trim();
  if (!want) throw new Error('에이전트 이름이 필요합니다 (claude, ' + Object.keys(agents || {}).join(', ') + ')');
  if (want !== 'claude' && !(agents || {})[want])
    throw new Error('모르는 에이전트: ' + want + ' (되는 것: claude, ' + Object.keys(agents || {}).join(', ') + ')');
  const cur = { ...(map || {}) };
  const key = normTitle(project);
  const oldKeys = Object.keys(cur).filter((k) => normTitle(k) === key);
  const prev = oldKeys.length ? String(cur[oldKeys[0]]) : 'claude';
  for (const k of oldKeys) delete cur[k];
  if (want !== 'claude') cur[project] = want;
  return { map: cur, project, agent: want, prev, changed: prev !== want };
}

/**
 * `fleet agent [<프로젝트>|--here] [<에이전트>]` — 프로젝트의 워커 에이전트(`fleetProjectAgent`)를
 * 보거나 바꾼다. 키는 `fleet slices` 표 머리와 같은 `projectTitleFor` 값이다 — 파견이 그 이름으로
 * 읽으므로(`fleetSlices`) 폴더명과 다른 별칭 프로젝트는 폴더명으로 넣으면 안 걸린다.
 * `--here` 는 `pause` 와 같은 뜻(`projectHere`) — Orca 전역 빠른 명령용. 저장은 `fleetPauseSet` 과
 * 같은 이유로 파일 원본에 한다.
 */
function fleetAgentSet(arg, agent, { here = false, cwd = process.cwd() } = {}) {
  const raw = readJson(CONFIG_FILE, {});
  const map = { ...(raw.fleetProjectAgent || {}) };
  const a = String(arg || '').trim();
  if (here && a) throw new Error('--here 와 프로젝트 이름은 같이 줄 수 없습니다');
  if (!a && !here) return { map, changed: false };
  const root = here ? join(HOME, 'orca', 'projects', projectHere(cwd)) : resolveProjectRoot(a);
  const project = projectTitleFor(repoRoot(root));
  if (!String(agent || '').trim()) {
    const k = Object.keys(map).find((k) => normTitle(k) === normTitle(project));
    return { map, changed: false, project, agent: k ? String(map[k]) : 'claude', prev: k ? String(map[k]) : 'claude' };
  }
  const r = nextProjectAgent(map, project, agent, agentTable(config()));
  if (r.changed) writeJson(CONFIG_FILE, { ...raw, fleetProjectAgent: r.map });
  return r;
}

/**
 * 지금 도는 코드(진입점 + `lib/` 모듈 전부, `CODE_FILES`)의 내용 해시. 회차 **도중** 착륙이 이 도구 자신을 갱신했는지 보는 데 쓴다.
 *
 * SP-sync 는 자기 자신을 자동화하므로 착륙이 `sp-sync.mjs` 를 본체에 머지하는 일이 생긴다.
 * 그런데 회차는 한 프로세스라 파일이 바뀌어도 **그 회차의 파견은 시작할 때 읽은 옛 코드로** 돈다.
 * 2026-08-30 22:00 회차가 그랬다: 착륙이 슬라이스 11(제출 확인·재전송) 수정을 머지한 바로 그
 * 회차의 파견이 옛 코드로 slice12 에 지시를 보내 `Waiting for setup…` 화면에 넣었고, 옛 판정이
 * 그것을 "지시 보냄"으로 보고했다.
 *
 * 읽지 못하면 `null` — 그때는 갱신을 주장하지 않는다. 모르는 것을 근거로 파견을 막으면
 * 회차가 조용히 아무것도 안 하는 쪽으로 고장 난다.
 */
function selfHash() {
  try {
    const h = createHash('sha1');
    for (const f of CODE_FILES) h.update(readFileSync(f));
    return h.digest('hex');
  } catch {
    return null;
  }
}

const CODE_CHANGED_TEXT = '회차 코드 갱신됨 — 파견은 다음 회차';

/**
 * 착륙은 됐는데 본체 ff 가 **실패**했으면 이 회차의 파견은 건너뛴다. 파견은 본체 PLAN.md 를
 * 다시 읽는데, 그 파일에 방금 머지된 `- [x]` 가 없어 같은 슬라이스를 다시 띄운다 — 2026-09-04
 * slice2 가 PR 머지 12초 뒤 재생성됐다(본체에 손 커밋이 있어 `pull --ff-only` 가 갈라짐으로
 * 거부). `landCleanup` 주석이 이 시나리오를 적어 두고도 막는 코드가 없었다 — `fleetDispatch` 는 착륙
 * **전**에 잰 `sync.block` 만 본다. 다음 회차는 `syncMain` 이 갈라짐을 보고 프로젝트를 통째로 막는다.
 * `ffSkipped`(본체가 다른 브랜치)는 정상이라 여기서 안 막는다 — `CODE_CHANGED_TEXT` 와 같은 자리에 실린다.
 */
function landStaleBlock(land) {
  const bad = (land?.landed || []).filter((d) => d.ok && !d.ff && !d.ffSkipped);
  if (!bad.length) return null;
  return '착륙 뒤 본체 ff 실패 — 본체 PLAN.md 가 옛것이라 파견은 다음 회차 (' + bad.map((d) => d.name).join(', ') + ')';
}

/** 회차 보고가 쌓이는 파일. 날짜별 하나에 회차를 덧붙인다. */
function cycleReportPath() {
  const c = config();
  const d = new Date();
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return join(c.cycleRunsDir.replace(/^~/, HOME), day + '-cycle.md');
}

/** `2026-08-30 16:45` — 회차 제목용. 로캘로 찍으면 "16시 45분 26초"로 몸집이 커진다. */
function cycleStamp(ts) {
  const d = new Date(ts);
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
}

/** 표 한 장. 줄이 없으면 "없음" 한 줄 — 빈 표를 붙이면 훑는 비용만 는다. */
function mdTable(title, head, rows) {
  if (!rows.length) return '**' + title + '** — 없음\n';
  const esc = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return (
    '**' + title + '**\n\n' +
    '| ' + head.join(' | ') + ' |\n' +
    '|' + head.map(() => '---').join('|') + '|\n' +
    rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |').join('\n') +
    '\n'
  );
}

/**
 * 파견 보류 사유 → 결정 항목 유형. **저절로 풀리는 보류**(프로젝트별·전역 동시 상한·자원 점유·선행 미완·이미 돌고 있음)는
 * 여기 없다 — 올리면 결정 표가 그것으로 차고 통지가 매 회차 울린다. 남은 넷은 시간이 지나도
 * 안 풀린다: 사용자 결정 대기, 한도 임박(7일 창), 계획 오류, 프로필에 없는 에이전트.
 */
const DISPATCH_HOLD_TYPES = [
  ['결정 필요', 'decision-tag'],
  ['한도 임박', 'limit-hold'],
  ['계획 오류', 'plan-error'],
  ['모르는 에이전트', 'unknown-agent'],
];
const dispatchHoldType = (reason) => (DISPATCH_HOLD_TYPES.find(([k]) => String(reason || '').startsWith(k)) || [])[1] || null;

/** 파견 한 줄의 결과 문구. 표와 결정 항목이 같은 문장을 쓴다. */
function dispatchResultText(d) {
  if (d.outcome === 'exited') return d.submit || '즉시 종료';
  if (d.ok) return d.submit || '지시 보냄';
  return [d.stage + ' 실패', d.submit, d.detail].filter(Boolean).join(' — ');
}

/**
 * 회차 결과 → **결정 항목** 목록. 순수 함수다 — 같은 결과에는 늘 같은 목록이 나온다.
 *
 * 회차가 낸 "사람이 볼 차례"를 여기 한 곳에서 센다. 예전에는 보고의 표(`renderCycleReport`)와
 * 통지 판정(coordinator precheck)이 각각 세어, 단계 완료·구문 오류·한도 보류·PLAN 미커밋·모르는
 * 에이전트처럼 **표에는 오르는데 통지에는 안 잡히는** 상황이 다섯 있었다 (coordinator 점검 #3).
 * 표도 통지도 이 목록만 본다 — 상황을 하나 더 볼 자리는 이 함수 하나다.
 *
 * 항목 하나 = `{key, type, project, slice, what, reason, needsUser, blocked}`.
 *   `key`       `type:project:슬라이스` — **회차 사이 비교의 단위**다. 같은 상황이 이어지면 같은
 *               키가 나고 풀리면 사라진다. 슬라이스 번호를 모르는 것(프로젝트 사정·이름이
 *               규칙 밖인 워크스페이스)은 워크스페이스 이름이나 빈 칸이 그 자리에 온다.
 *   `needsUser` 사람이 손대야 풀린다. 다음 회차가 저절로 다시 보는 것(막힘·인계 성공·인계 대기)은
 *               false — 통지가 "새로 생긴 결정" 과 "그냥 도는 중" 을 가르는 재료다 (슬라이스 38).
 *   `blocked`   막힘 표 줄(워크스페이스가 섰다). 나머지가 결정 필요 표 줄이다.
 */
function decisionItems(out) {
  const items = [];
  for (const p of out?.projects || []) {
    const project = p.project;
    const add = (type, at, what, reason, o = {}) =>
      items.push({
        key: type + ':' + project + ':' + (at == null ? '' : at),
        type,
        project,
        slice: typeof at === 'number' ? at : null,
        what,
        reason: clean(reason, 300),
        needsUser: o.needsUser !== false,
        blocked: !!o.blocked,
      });
    // 착륙 실패. 성패 자체는 착륙 표가 적고 여기 줄은 "왜 사람이 봐야 하나"다 — 충돌은 워커가
    // 정해진 횟수를 시도한 뒤에도 안 풀린 것이고, 나머지(push·PR·머지)도 저절로 안 풀린다.
    for (const d of p.land?.landed || [])
      if (!d.ok)
        add(d.stage === 'conflict' ? 'conflict' : 'land-failed', d.slice ?? d.name, d.name, d.stage + ' 실패' + (d.needsUser ? ' — 사용자 결정 필요' : ''));
    for (const c of p.land?.checks || []) {
      // 막힘은 다음 회차가 다시 본다 — 사람 몫은 아니지만 **항목으로는 남긴다**: 같은 막힘이
      // 회차마다 이어지는지를 키로 세는 자리가 여기뿐이다.
      if (c.blocked) add('land-blocked', c.slice ?? c.name, c.name, c.reason, { needsUser: false, blocked: true });
      if (c.waiting) add('wait', c.slice ?? c.name, c.name + ' (워커 대기)', c.waiting);
      // 막힘도 대기도 아닌데 사람이 풀어야 하는 것 (브랜치 이름이 규칙 밖 등). 이 줄이 없으면
      // 그 워크스페이스는 어느 표에도 안 올라 조용히 남는다.
      if (c.attention) add('stray', c.slice ?? c.name, c.name, c.attention);
    }
    // 한도 인계 (슬라이스 13). 막힘 줄에는 그 워크스페이스가 **왜 섰는지**가 이미 있고, 여기
    // 줄은 "그래서 회차가 무엇을 했나"다 — 넘겼는지, 기다리는지, 넘기지 못했는지. 표를 새로
    // 만들지 않고 결정 표에 얹는다: 표가 다섯이 되면 회차 보고를 훑는 비용이 는다. 넘긴 것과
    // 기다리는 것은 회차가 스스로 한 일이라 사람 몫이 아니다 — 넘기지 **못한** 것만 사람 몫이다.
    for (const h of p.handoff?.rows || [])
      add('handoff-' + h.action, h.slice ?? h.name, h.name + ' (' + h.from + ')', handoffRowText(h), { needsUser: h.action === 'blocked' });
    // 재개 (슬라이스 43). 성공은 파견처럼 회차가 한 일이라 항목이 아니다(요약 줄이 센다). 대기·삭제도 아니다.
    // 시도 소진은 사람 몫이고, 창이 없어 못 깨우는 것도 사람이 탭을 열어야 풀린다. 전송 실패는 다음 회차가 다시
    // 시도하므로 사람 몫은 아니지만 결정 표에는 남긴다 — 두 번 실패하면 위의 소진으로 온다.
    for (const r of p.resume?.rows || []) {
      if (r.action === 'exhausted' || r.action === 'blocked') add('resume-' + r.action, r.slice ?? r.name, r.name + ' (' + r.agent + ')', resumeRowText(r));
      else if (r.action === 'resume' && r.result && !r.result.ok) add('resume-failed', r.slice ?? r.name, r.name + ' (' + r.agent + ')', resumeRowText(r), { needsUser: false });
    }
    // 파견 실패·즉시 종료는 **막힘**이다 (coordinator 점검 #6: 9월 8일 create 실패 회차가 "파견 1 ·
    // 막힘 0 · 결정 필요 0" 이라 정상 진행으로 읽혔다). 보내려던 지시도 같이 남긴다 — 사람이
    // 이어받을 때 그것부터 본다.
    for (const d of p.dispatch?.dispatched || [])
      if (!d.ok || d.outcome === 'exited')
        add('dispatch-failed', d.slice ?? d.name, d.name, dispatchResultText(d) + (d.text ? ' · 보내려던 것: ' + d.text : ''), { blocked: true });
    for (const d of p.dispatch?.decisions || []) {
      // 번호 없는 제목은 아래에서 프로젝트당 한 줄로 묶는다.
      if (d.eligible || d.number == null) continue;
      const type = dispatchHoldType(d.reason);
      if (type) add(type, d.number, d.number + '번 ' + d.title, d.reason);
    }
    // 번호 없는 제목은 매 회차 조용히 건너뛴다 — 프로젝트가 고치지 않으면 영영 파견되지 않는다.
    // **프로젝트당 한 줄**로 묶는다. 한 프로젝트에서 5건이 나왔고, 슬라이스마다 적으면 결정 표가
    // 그것만으로 차서, 정작 봐야 할 다른 줄이 묻힌다 (2026-08-30).
    const noNumber = (p.dispatch?.decisions || []).filter((d) => !d.eligible && d.number == null);
    if (noNumber.length)
      add(
        'no-number',
        null,
        '번호 없는 슬라이스 ' + noNumber.length + '개',
        '제목에 번호가 없어 영영 파견되지 않음 (`- [ ] **N. 제목**` 꼴이어야 한다) — 예: ' + clean(noNumber[0].title, 40)
      );
    // 이름을 못 읽는 창 때문에 새 파견을 접었다. 슬라이스마다 같은 사유가 붙으므로 **프로젝트당
    // 한 줄**로 올린다 — 사람이 브랜치를 고치거나 창을 닫아야 풀린다 (슬라이스 24).
    if (p.dispatch?.createBlock) add('stray', null, '미분류 창', p.dispatch.createBlock);
    // 본체 PLAN.md 가 커밋 전이라 새 파견을 접었다 — 커밋할 사람에게 한 줄로 올린다.
    if (p.dispatch?.planBlock) add('plan-dirty', null, 'PLAN.md 미커밋', p.dispatch.planBlock);
    if (p.dispatch?.planSyntax) add('plan-syntax', null, 'PLAN.md 구문', p.dispatch.planSyntax);
    // 본체 동기화가 사람 손을 부르는 두 경우 — 갈라짐과 ff 실패. 슬라이스가 아니라 저장소의
    // 사정이라 슬라이스 줄이 아니라 프로젝트당 한 줄이다. 이 줄이 없으면 그 프로젝트가 통째로
    // 건너뛴 회차가 "할 것이 없었다"로 읽힌다 (앞섬은 이제 회차가 push 로 푼다 — 슬라이스 19).
    const sync = p.sync || p.dispatch?.sync;
    if (sync?.block) add('sync-diverged', null, '본체 동기화', sync.block + (sync.commits?.length ? ' (' + sync.commits[0] + ' …)' : ''));
    else if (sync?.action === 'ff-failed' || sync?.action === 'ff-deferred') add('sync-ff', null, '본체 동기화', sync.text);
    // 단계 끝 — 미체크 0 이면 파견이 조용히 0건이라 아무도 재계획을 부르지 않는다. 활성 워크스페이스가
    // 남아 있으면(착륙 전) 아직 아니다 — 다 착륙한 뒤 한 번만 올린다. 착륙이 파견보다 먼저 돌므로
    // 여기의 active 는 이번 회차 착륙 뒤의 값이다.
    if (p.dispatch?.phaseDone && !p.dispatch.active)
      add(
        'stage-done',
        null,
        '현재 단계 끝' + (p.dispatch.phase?.title ? ' (' + p.dispatch.phase.title + ')' : ''),
        '다음 단계 재계획 필요 — 최상위 모델 plan mode 로 PLAN.md 갱신'
      );
    // 동기화 막힘은 바로 위에서 이미 항목이 됐다 — 또 실으면 같은 사실이 두 줄이 된다.
    if (p.error && !p.syncBlocked) add('project-error', null, '-', p.error, { needsUser: false, blocked: true });
  }
  return items;
}

/**
 * 회차 결과 → 마크다운 한 절. 표는 넷이다 (원본 §2 보고):
 * 착륙 / 파견 / 막힘 / 결정 필요. 사람이 읽는 것은 뒤의 둘이다 — 앞의 둘은 "잘 돌았다"는 기록이고,
 * 뒤의 둘이 "네가 볼 차례다"이기 때문이다. 뒤의 둘은 `decisionItems` 하나에서 나온다 — 보고와
 * 통지가 같은 목록을 봐야 "표에는 있는데 안 깨우는" 구멍이 안 생긴다 (coordinator 점검 #3).
 */
function renderCycleReport(o) {
  const landed = [];
  const dispatched = [];
  let handoffs = 0;
  let failed = 0;
  let exited = 0;
  const resumed = [];
  for (const p of o.projects) {
    for (const d of p.land?.landed || [])
      landed.push([p.project, d.name, d.ok ? '머지됨 #' + d.pr : d.stage + ' 실패', d.ok ? ffText(d) : (d.needsUser ? '사용자 결정 필요' : '')]);
    handoffs += (p.handoff?.rows || []).length;
    // 재개 절의 재료 — 실제로 깨운 것(dry-run 은 예정). 대기·삭제는 안 싣는다: 회차마다 같은 줄이 되풀이된다.
    for (const r of p.resume?.rows || []) if (r.action === 'resume' && (r.result?.ok || o.dryRun)) resumed.push(p.project + ': ' + resumeRowText(r) + (o.dryRun ? ' (예정)' : ''));
    // 파견 표는 **시작한 것**만 싣는다. 실패·즉시 종료는 막힘 표로 간다 — 시도 수를 파견 건수로
    // 세면 create 실패 회차가 "파견 1" 로 읽힌다 (coordinator 점검 #6).
    for (const d of p.dispatch?.dispatched || []) {
      if (!d.ok) failed++;
      else if (d.outcome === 'exited') exited++;
      else dispatched.push([p.project, d.name, dispatchResultText(d), d.text]);
    }
    // dry-run 은 안 띄우므로 dispatched 가 비어 있다. 그렇다고 파견 표를 비워 두면 "될 일이
    // 없다"로 읽힌다 — 회차를 미리 보려고 돌리는 것이 dry-run 이므로 예정을 적는다.
    if (o.dryRun)
      for (const d of p.dispatch?.decisions || [])
        if (d.eligible) dispatched.push([p.project, d.redispatch || 'slice' + d.number, '예정', d.reason]);
  }
  // 한 프로젝트가 두 바퀴 돌았으면(`round: 2`, 슬라이스 39) 항목이 둘이다 — 행(착륙·파견)은 둘 다 싣고,
  // 결정은 **마지막 바퀴**만 본다(`precheckVerdict` 와 같은 잣대): 첫 바퀴의 막힘이 둘째 바퀴에서
  // 풀렸으면 사라지고, 이어졌으면 한 줄이다.
  const latest = new Map();
  for (const p of o.projects) latest.set(p.project, p);
  const items = decisionItems({ projects: [...latest.values()] });
  const decisions = items.filter((i) => !i.blocked).map((i) => [i.project, i.what, i.reason]);
  const blocked = items.filter((i) => i.blocked).map((i) => [i.project, i.what, i.slice == null ? '-' : String(i.slice), i.reason]);
  const names = [...new Set(o.projects.map((p) => p.project))];
  const L = [
    '## ' + cycleStamp(o.at) + ' 회차' + (o.dryRun ? ' (dry-run)' : ''),
    '',
    '프로젝트 ' + names.length + '(' + names.join(', ') + ') · 착륙 ' + landed.length +
      // 파견은 **시작한 것**의 수다. 실패·즉시 종료는 괄호로 따로 적는다 — 0 이면 괄호가 안 붙어
      // 정상 회차의 요약 줄은 예전 그대로다.
      ' · 파견 ' + dispatched.length +
      (failed || exited ? '(' + [failed ? '실패 ' + failed : null, exited ? '즉시 종료 ' + exited : null].filter(Boolean).join(', ') + ')' : '') +
      ' · 막힘 ' + blocked.length + ' · 결정 필요 ' + decisions.length +
      // 인계는 결정 표 안에 있지만 요약에 따로 센다 — 회차가 워크스페이스 하나를 다른 에이전트에
      // 넘긴 것은 "결정 필요 3" 안에 묻히면 안 되는 사건이다. 0 이면 줄이 안 는다.
      (handoffs ? ' · 인계 ' + handoffs : '') +
      // 재개도 같은 이유로 따로 센다 — 한도가 풀려 회차가 창을 깨운 것은 파견과 같은 급의 변화다. 0 이면 줄이 안 는다.
      (resumed.length ? ' · 재개 ' + resumed.length : '') +
      // 빼 둔 프로젝트는 요약에 이름을 적는다. 안 적으면 그 프로젝트는 "회차가 돌았는데 할 일이
      // 없었다"와 구별되지 않아, 스위치를 켜 둔 걸 잊은 채 몇 회차가 지나간다.
      (o.paused?.length ? ' · 일시 제외 ' + o.paused.length + '(' + o.paused.join(', ') + ')' : ''),
    '',
  ];
  // 파견 0건이 "할 일이 없었다"로 읽히면 안 된다. 표가 아니라 ⚠ 한 줄로 낸다 — 표에 넣으면
  // 파견 건수에 세어져 "0건으로 끝났다"는 사실 자체가 흐려진다.
  const skipped = o.projects.filter((p) => p.dispatchSkipped);
  // 사유가 프로젝트마다 다를 수 있다(코드 갱신은 회차 전체, 착륙 뒤 ff 실패는 그 프로젝트만) — 사유별 한 줄.
  for (const why of [...new Set(skipped.map((p) => p.dispatchSkipped))])
    L.push('⚠ ' + why + ' (' + skipped.filter((p) => p.dispatchSkipped === why).map((p) => p.project).join(', ') + ')', '');
  // 파견 제외 프로젝트 — 동기화만 하고 착륙·파견은 안 했다. 착륙·파견 표에 한 줄도 안 오르므로
  // 안 적으면 "회차가 돌았는데 할 일이 없었다" 와 구별되지 않는다 (`fleetPause` 의 요약 줄과 같은 이유).
  // 실제로 push·ff 를 했으면 바로 아래 "본체 —" 줄에 그 내용이 나온다.
  const syncOnly = o.projects.filter((p) => p.syncOnly);
  if (syncOnly.length) L.push('동기화만 — ' + syncOnly.map((p) => p.project).join(', ') + ' (fleetNoDispatch: 파견·착륙·인계 안 함)', '');
  // 본체에 실제로 손댄 것(push·ff)은 표가 아니라 한 줄로 남긴다 — 잘 돌아간 기록이라 표를
  // 만들 만큼은 아니지만, 사용자의 커밋이 언제 올라갔는지는 나중에 되짚을 일이 있다.
  const touched = o.projects.filter((p) => p.sync && ['push', 'ff'].includes(p.sync.action));
  if (touched.length) L.push('본체 — ' + touched.map((p) => p.project + ': ' + p.sync.text).join(' · '), '');
  // 재개 — 한도가 풀린 워크스페이스를 같은 창에서 다시 굴린 기록 (슬라이스 43). 잘 돌아간 기록이라 표가 아니라
  // 한 줄이다. 소진·불가·전송 실패는 결정 표에 있다(`decisionItems`).
  if (resumed.length) L.push('재개 — ' + resumed.join(' · '), '');
  // 다른 회차가 이미 다루는 중이라 지나간 프로젝트. 막힘이 아니라 정상이므로 표가 아니라 한 줄이지만,
  // 안 적으면 그 프로젝트가 "할 일이 없었다"로 읽힌다.
  const busy = o.projects.filter((p) => p.cycleRunning);
  if (busy.length) L.push('건너뜀 — ' + busy.map((p) => p.project + ': ' + p.cycleRunning + (p.pending ? ' (요청을 남김 — 그 회차가 끝에서 한 바퀴 더 돈다)' : '')).join(' · '), '');
  // 회차 도중 들어온 요청으로 한 바퀴 더 돈 프로젝트 — 위 표에 같은 이름이 두 번 나오는 이유.
  const again = o.projects.filter((p) => p.round > 1);
  if (again.length) L.push('한 바퀴 더 — ' + again.map((p) => p.project).join(', ') + ' (회차 중 들어온 요청)', '');
  L.push(
    mdTable('착륙', ['프로젝트', '워크스페이스', '결과', '비고'], landed),
    mdTable('파견', ['프로젝트', '워크스페이스', '결과', '지시'], dispatched),
    mdTable('막힘', ['프로젝트', '워크스페이스', '번호', '이유'], blocked),
    mdTable('결정 필요', ['프로젝트', '무엇', '내용'], decisions)
  );
  return L.join('\n') + '\n---\n\n';
}

/**
 * 회차 한 바퀴 안에서 프로젝트 하나 — 본체 동기화 → 착륙 → 재개 → 인계 → 파견. 실행 잠금은 잡은 채로 불린다
 * (`fleetCycle`). `ctx.out.codeChanged` 는 회차 전체에 걸리는 플래그라 여기서 켠다.
 *
 * **`fleetNoDispatch` 프로젝트는 동기화에서 끝난다** (`p.syncOnly`, 슬라이스 41) — 착륙·인계·파견을
 * 건너뛴다. 슬라이스 단위로 돌지 않는 저장소라 나눠 줄 것도 거둘 것도 없지만, 사용자가 거기 쌓은
 * 커밋은 회차가 올려야 한다. 보고에는 "동기화만" 한 줄로 남는다 (`renderCycleReport`).
 */
async function cycleProject(name, ctx) {
  const { opts, c, base, limits, codeAt, out } = ctx;
  // 단계 함수는 테스트 자리다(`ctx.deps.runLand` 등) — 회차 **순서**(착륙 → 재개 → 인계 → 파견)를 Orca 없이 확인하려고.
  const run = { runLand: fleetLand, runResume: cycleResume, runHandoff: cycleHandoff, runDispatch: fleetDispatch, ...(ctx.deps || {}) };
  const p = { project: name };
  try {
    // 본체 동기화가 제일 먼저다 — 착륙은 본체에 머지하고 파견은 본체 PLAN.md 를 읽으므로,
    // 둘 다 origin 과 맞춰진 본체에서 시작해야 한다 (슬라이스 19).
    const root = repoRoot(resolveProjectRoot(name));
    p.project = projectTitleFor(root);
    p.sync = syncMain(root, { base, dryRun: opts.dryRun });
    if (p.sync.block) {
      // 갈라짐·push 실패는 사람 몫이다. 그 사이에 착륙이 머지를 얹으면 더 꼬이므로 이
      // 프로젝트는 통째로 건너뛴다. `p.error` 에 실어야 coordinator precheck 의 "볼 것"에 잡힌다.
      p.error = p.sync.block;
      p.syncBlocked = true;
      log('fleet cycle ' + name + ' 건너뜀 — ' + p.sync.block);
      return p;
    }
    // 파견 제외 프로젝트는 여기서 끝. 착륙할 워크스페이스도, 읽을 슬라이스도 없다.
    if (isNoDispatch(basename(root), c.fleetNoDispatch)) {
      p.syncOnly = true;
      log('fleet cycle ' + name + ' 동기화만 (fleetNoDispatch) — ' + (p.sync.text || p.sync.detail || '할 것 없음'));
      return p;
    }
    // 착륙이 먼저다 — 자리를 비워야 파견이 그 자리에 들어간다.
    // 슬라이스 스냅샷(PLAN.md · orca 워크스페이스 목록 · state · 워크스페이스별 git)은 한 번만
    // 읽어 착륙·파견이 나눠 쓴다. **착륙이 실제로 뭔가 내렸으면 다시 읽는다** — 그 워크스페이스는
    // 지워졌고, 옛 목록을 그대로 쓰면 파견이 빈 자리를 "아직 돌고 있음"으로 보고 안 띄운다.
    const snap = fleetSlices(name);
    p.land = await run.runLand(name, { ...opts.land, dryRun: opts.dryRun, json: false, quiet: true, slices: snap, sync: p.sync });
    // **착륙 뒤·인계 앞** — 한도가 풀린 워크스페이스를 같은 창에서 다시 굴린다 (슬라이스 43). 인계보다 앞인
    // 이유는 `cycleResume` 머리 주석에.
    p.resume = await run.runResume(snap, {
      ...opts.dispatch,
      dryRun: opts.dryRun,
      limits,
      agents: agentTable(c),
      max: c.fleetResumeMax,
      idleMs: opts.land?.idleMs,
      project: snap.project,
    });
    // **착륙 뒤·파견 앞** — 한도에 막힌 워크스페이스를 상대 에이전트에게 넘긴다 (슬라이스 13).
    // 이 자리인 이유: 착륙이 자격 있는 것을 다 내린 **뒤**라야 남은 막힘이 진짜 막힘이고,
    // 파견 **앞**이라야 이어받은 워크스페이스가 그 회차의 활성 수에 그대로 세어진다.
    // 코드 갱신(`selfHash`) 게이트는 여기 안 건다 — 인계는 워크스페이스를 만들지 않고 이미 있는
    // 폴더에 턴 하나를 열 뿐이며, 그 래퍼는 어차피 그 시점의 디스크에서 코드를 읽는다.
    p.handoff = await run.runHandoff(snap, p.land, {
      ...opts.dispatch,
      dryRun: opts.dryRun,
      limits,
      fallback: c.fleetFallback,
      waitMin: c.fleetLimitWaitMin,
      agents: agentTable(c),
      project: snap.project,
    });
    // 파견을 새 프로세스로 다시 띄우는 방법도 있으나, 30분 뒤 회차가 어차피 새 코드로 도므로
    // 미루는 쪽이 단순하다. 한 번 켜지면 이 회차의 **모든** 프로젝트에 걸린다.
    const now = selfHash();
    if (!out.codeChanged && codeAt && now && now !== codeAt) {
      out.codeChanged = true;
      log('fleet cycle ' + CODE_CHANGED_TEXT);
    }
    const stale = landStaleBlock(p.land);
    if (out.codeChanged) p.dispatchSkipped = CODE_CHANGED_TEXT;
    else if (stale) {
      p.dispatchSkipped = stale;
      log('fleet cycle ' + name + ' ' + stale);
    } else
      p.dispatch = await run.runDispatch(name, {
        ...opts.dispatch,
        dryRun: opts.dryRun,
        json: false,
        quiet: true,
        sync: p.sync,
        slices: (p.land?.landed || []).length ? null : snap,
        limits,
        // 공유 자원과 전역 활성 수는 **회차가 한 번 세어 나른다** (슬라이스 42). 같은 회차 안에서 앞
        // 프로젝트가 잡은 것을 뒤 프로젝트가 봐야 하므로, 파견이 끝날 때마다 `ctx` 를 갱신한다.
        held: ctx.held || {},
        total: ctx.total,
        maxTotal: c.fleetMaxWorkspacesTotal,
      });
    // 이번 파견이 잡은 예약과 띄운 창을 `ctx` 에 반영한다. 다시 세지 않는다 — 회차 한 바퀴에 Orca 목록을
    // 프로젝트 수만큼 다시 읽을 이유가 없고, 방금 띄운 것은 여기서 정확히 안다.
    //
    // **dry-run 은 띄운 것이 없으므로 띄울 것(`eligible`)으로 같은 갱신을 한다** (슬라이스 46). 안 하면
    // 앞 프로젝트가 집을 자원·자리를 뒤 프로젝트가 못 봐, 같은 자원을 쓰는 두 프로젝트가 dry-run 에서만
    // 둘 다 "파견 예정" 으로 나온다 — "판정이 실제와 같다"(`dispatchPlan`)는 회차 단위에서도 지켜야 한다.
    if (p.dispatch) {
      const rows = opts.dryRun
        ? (p.dispatch.decisions || []).filter((d) => d.eligible).map((d) => ({ slice: d.number, redispatch: d.redispatch, names: d.resources || [], path: null, ok: true }))
        : (p.dispatch.dispatched || []).map((d) => ({ slice: d.slice, redispatch: d.redispatch, names: d.resources?.reserved || [], path: d.path || null, ok: d.ok }));
      ctx.total = (ctx.total || 0) + rows.filter((r) => r.ok && !r.redispatch).length;
      if (!ctx.held) ctx.held = {};
      for (const r of rows)
        for (const n of r.names) ctx.held[normTitle(n)] = { name: n, project: p.dispatch.project, slice: r.slice, workspace: r.path, since: Date.now() };
    }
    // 이름은 폴더명으로 받았지만 보고에는 SP 프로젝트명으로 적는다 (별칭이 있을 수 있다).
    p.project = p.land?.project || p.dispatch?.project || name;
  } catch (e) {
    p.error = clean(e.message, 300);
    log('fleet cycle ' + name + ' 실패: ' + p.error);
  }
  return p;
}

/**
 * 회차 한 바퀴. 프로젝트마다 **실행 잠금**(`acquireRunLock`)을 잡고 `cycleProject` → 놓는다. 못 잡으면
 * 그 프로젝트는 건너뛰되 요청을 `fleet-pending` 에 남긴다(`p.cycleRunning`·`p.pending`) — 도는 쪽이 끝에서
 * 한 바퀴 더 돈다. 모든 프로젝트를 한 번 돈 뒤, 도는 동안 pending 이 생긴 프로젝트를 **한 번만** 더
 * 돈다(`round: 2` 항목이 같은 결과 JSON 에 추가된다 — 보고·precheck 가 두 바퀴를 다 본다. 두 항목의
 * 합치기는 `renderCycleReport`(행은 둘 다, 결정은 마지막 바퀴)와 `precheckVerdict`(키는 마지막 바퀴, 건수는 합)).
 *
 * `--dry-run` 은 락은 잡되(도는 회차와 겹쳐 읽지 않게) pending 은 **쓰지도 소비하지도 않는다** — 진단이
 * 운영 상태를 바꾸면 안 된다 (coordinator 점검 #12).
 *
 * `opts.deps` 는 테스트 자리 — `runProject`(진짜 `cycleProject` 대신), `lockDir`, `pendingDir`, `isAlive`, `reportPath`.
 */
async function fleetCycle(opts) {
  const c = config();
  const deps = opts.deps || {};
  const { names, paused } = splitPaused(cycleProjects(opts.projects), c.fleetPause);
  const out = { at: Date.now(), dryRun: !!opts.dryRun, projects: [], paused };
  // 회차 시작 때의 코드. 착륙이 이 파일을 바꾸면 남은 파견은 옛 코드로 도는 셈이라 미룬다.
  const codeAt = selfHash();
  // 한도는 **계정 단위**다 — 한 바퀴에 한 번만 읽어 인계 판정과 파견 게이트가 같은 값을 본다.
  // 프로젝트마다 다시 읽으면 앞 프로젝트의 인계가 같은 회차의 뒤 프로젝트 판정을 흔든다.
  const limits = opts.limits || (deps.runProject ? null : allLimits());
  const base = opts.land?.base || opts.dispatch?.base || null;
  // 공유 자원 회수는 **회차 시작에 한 번**이다 (슬라이스 42) — 폴더가 사라진 예약(착륙이 중간에 죽었거나
  // 사람이 손으로 지운 것)을 여기서 걷지 않으면 그 자원이 영영 잡힌 채로 남는다. `--dry-run` 은 운영
  // 상태를 안 바꾼다(`fleetCycle` 의 pending 과 같은 잣대).
  // `--dry-run` 은 회수 **목록**은 내되 파일을 안 고친다 — 진단이 운영 상태를 바꾸면 안 되지만, 걷힐 예약을
  // 계속 잡힌 것으로 보면 dry-run 만 "자원 점유" 로 보류해 진단과 실행이 갈린다.
  out.resourcesSwept = sweepResources({ dryRun: opts.dryRun });
  const heldNow = heldResources();
  for (const x of out.resourcesSwept.removed || []) delete heldNow[normTitle(x.name)];
  // 전역 상한의 재료도 한 바퀴에 한 번 센다. 프로젝트마다 다시 세면 앞 프로젝트의 파견이 뒤 프로젝트
  // 판정을 흔든다 — 판정이 흔들리는 건 한도(`limits`)와 같은 이유다.
  const ctx = { opts, c, base, limits, codeAt, out, held: heldNow, total: deps.runProject ? 0 : globalActiveCount() };
  const runProject = deps.runProject || cycleProject;
  const lockOpts = { maxMs: c.fleetTriggerLockMs, base: deps.lockDir, isAlive: deps.isAlive };
  const pendingDir = deps.pendingDir;
  // 잠금 안에서 한 바퀴. 시작할 때 pending 을 지운다 — 이 바퀴가 그 요청을 만족시킨다.
  const oneRound = async (name, round) => {
    const lock = acquireRunLock(name, { ...lockOpts, now: Date.now() });
    if (!lock.ok) return { locked: lock };
    try {
      if (!opts.dryRun) takePending(name, pendingDir);
      const p = await runProject(name, ctx);
      if (round > 1) p.round = round;
      return { p };
    } finally {
      releaseRunLock(name, deps.lockDir);
    }
  };
  const ran = new Set();
  for (const name of names) {
    const r = await oneRound(name, 1);
    if (r.p) {
      out.projects.push(r.p);
      ran.add(name);
      continue;
    }
    // 다른 회차가 다루는 중 — 정상 상황이라 `p.error` 가 아니다. 요청은 남긴다: 도는 쪽이 끝에서 한 바퀴 더 돈다.
    const p = { project: name, cycleRunning: r.locked.reason };
    if (!opts.dryRun) {
      leavePending(name, '회차 요청이 도는 회차와 겹침 — ' + r.locked.reason, { dir: pendingDir });
      p.pending = true;
    }
    log('fleet cycle ' + name + ' 건너뜀 — ' + p.cycleRunning + (p.pending ? ' · 요청을 남김' : ''));
    out.projects.push(p);
  }
  // 한 바퀴 더 — 이번 회차가 그 프로젝트를 다루는 **동안** 들어온 요청(pending). 1회 한정: 둘째 바퀴 중에
  // 또 들어온 것은 다음 회차가 시작하며 소비한다. 락을 못 잡으면 그 요청은 새 소유자가 시작하며 소비한다.
  if (!opts.dryRun)
    for (const name of names) {
      if (!ran.has(name) || !readJson(pendingFile(name, pendingDir), null)) continue;
      const r = await oneRound(name, 2);
      if (!r.p) continue;
      log('fleet cycle ' + name + ' 한 바퀴 더 — 회차 중 들어온 요청');
      out.projects.push(r.p);
    }
  // **결과 JSON 에 결정 항목을 프로젝트별로 싣는다.** 통지 판정(precheck)은 이 배열만 보면 된다 —
  // 보고 마크다운을 다시 파싱하거나 제 나름의 집계를 두면 표와 통지가 또 갈린다 (coordinator 점검 #3).
  for (const p of out.projects) p.decisions = decisionItems({ projects: [p] });
  const report = renderCycleReport(out);
  const f = deps.reportPath || cycleReportPath();
  if (!opts.dryRun || opts.write) {
    try {
      mkdirSync(dirname(f), { recursive: true });
      appendFileSync(f, report, 'utf8');
      out.report = f;
    } catch (e) {
      out.reportError = clean(e.message, 200);
    }
  }
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else if (!opts.quiet) {
    process.stdout.write(report);
    console.log(out.report ? '보고: ' + out.report : out.reportError ? '보고 실패: ' + out.reportError : '(dry-run 이라 보고를 안 씀 — 쓰려면 --write)');
  }
  log('fleet cycle 프로젝트 ' + out.projects.length + (out.report ? ' → ' + out.report : ''));
  return out;
}

// ---------- fleet precheck ----------
/**
 * 통지 판정 — Orca 자동화 "coordinator 회차" 의 precheck 를 이 도구가 한다 (슬라이스 38).
 *
 * 회차 자체(본체 동기화 → 착륙 → 인계 → 파견 → 보고)는 모델 없이 여기서 돈다. 종료 코드가 0 이면
 * Orca 가 팀장 세션을 깨워 보고를 읽게 하고, 1 이면 "건너뜀" 으로 기록하고 아무도 안 깨운다.
 * 예전에는 coordinator 저장소의 `scripts/cycle-precheck.mjs` 가 회차 결과를 **제 나름대로 집계**해
 * 비교했고, 그래서 보고의 결정 표에는 오르는데 통지에는 안 잡히는 상황이 다섯 있었다(coordinator
 * 점검 #3). 이제 회차 결과 JSON 의 프로젝트별 `decisions`(= `decisionItems`)만 본다 — 표와 통지가
 * 같은 목록이다.
 *
 * 0 이 나는 때는 둘뿐이다 (coordinator 점검 #6 "새 사용자 결정·자동 회복 실패 때만 모델을 부른다"):
 *   - **새 키**가 생겼다 — 지난 회차의 집합에 없던 결정 항목. 같은 상황이 회차마다 이어지면 같은
 *     키라 한 번만 알린다(2026-08-30 20:01·20:30 두 회차가 같은 대기 항목을 두 번 적었다). 사유
 *     문장이 바뀌어도(워커가 새 카드를 써 `wait` 문구가 달라짐) 키가 같으면 미해결 그대로다 —
 *     풀리기 전까지 유지된다.
 *   - **자동 회복 실패** — 파견 실패·착륙 실패·충돌 미해결·본체 갈라짐(`RECOVERY_FAILED_TYPES`).
 *     회차가 무언가를 시도해 실패한 것이라 같은 키가 이어져도 매번 알린다 — 조용히 넘기면 그
 *     프로젝트가 통째로 서 있는데 아무도 모른다.
 * 착륙·파견이 **성공만** 한 회차는 보고 파일만 쓰고 1 이다 — 정상 진행을 모델이 다시 설명하는
 * 비용이 "채팅에는 결정만" 이라는 목적보다 컸다(coordinator 점검 #6). 해소된 키는 보고에 "해소" 줄로
 * 남기되 깨우지 않는다.
 *
 * 지난 집합은 **프로젝트별** 파일 `~/.sp-sync/fleet-seen.<safeName>.json` 이다 — 공유 파일 하나에
 * 병합하면 프로젝트별 회차 둘이 동시에 끝날 때 한쪽의 갱신이 다른 쪽에 덮인다. 임시 파일에 쓰고
 * rename 으로 바꿔 넣는다(`saveSeen`) — 쓰다 죽으면 옛 파일이 그대로 남지, 반쪽짜리가 남지 않는다.
 * 이번에 안 돈 프로젝트(일시 제외, 다른 회차가 도는 중)의 파일은 손대지 않는다.
 *
 * coordinator 스크립트에서 **옮기지 않은 것**: 지난 자동 회차 세션 닫기(`closeStaleCoordinatorTerminals`) —
 * coordinator 탭 사정이라 그쪽 래퍼에 남긴다. 전환은 사용자 몫이다: `fleetPrecheck` 를 `'builtin'` 으로
 * 두면 `fleet trigger` 가 이 함수를 부르고, Orca 자동화의 precheck 명령을 `sp-sync.mjs fleet precheck`
 * 로 바꾸면 시계 회차도 이쪽이다. 기본값은 그대로 coordinator 경로다.
 */

/** 이 유형은 같은 키가 이어져도 매번 깨운다 — 회차가 시도해 실패한 것이라 "지난 회차와 같음" 이 곧 방치다. */
const RECOVERY_FAILED_TYPES = new Set(['dispatch-failed', 'land-failed', 'conflict', 'sync-diverged']);

/** 프로젝트별 지난 집합 파일. `safeName` 은 유니코드를 남긴다 — ASCII slug 는 '가계부'·'자격증'을 같은 파일로 만든다 (coordinator 점검 #12). */
function seenFileFor(project, dir = DIR) {
  return join(dir, 'fleet-seen.' + safeName(project) + '.json');
}

/**
 * 원자 갱신 — 같은 폴더의 임시 파일에 쓰고 rename. rename 은 같은 볼륨 안에서 통째로 바뀌므로 읽는 쪽이
 * 반쪽을 볼 수 없다. 임시 이름에 pid 를 넣어 두 프로세스가 같은 임시 파일을 안 다툰다.
 * 반환은 `{file, tmp}` — 테스트가 임시 경로가 어디였는지 단언한다.
 */
function saveSeen(file, data, io = { writeFileSync, renameSync, mkdirSync }) {
  const tmp = file + '.' + process.pid + '.tmp';
  io.mkdirSync(dirname(file), { recursive: true });
  io.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  io.renameSync(tmp, file);
  return { file, tmp };
}

/**
 * 회차 결과 + 지난 집합 → 통지 판정. **순수 함수** — 파일도 시계도 안 본다.
 *
 * `seenBy` 는 `{프로젝트명: {keys: {키: {...}}}}`. 결과의 `byProject` 가 다음 회차의 `seenBy` 다 —
 * 이번에 돈 프로젝트만 들어 있고, 항목마다 `since`(처음 나타난 회차 시각)는 지난 값을 이어받는다.
 *
 * 깨우는 새 키: 사람 몫(`needsUser`)이거나 막힘(`blocked`)인 것. 인계 성공·인계 대기는 둘 다 아니라
 * — 회차가 스스로 한 일이고 다음 회차가 다시 본다 — 새로 생겨도 안 깨운다. 막힘은 사람 몫이 아니라도
 * **처음 생겼을 때 한 번은** 알린다: 워커가 멈춘 채 아무도 모르는 상태를 막는 자리가 여기뿐이다.
 */
function precheckVerdict(out, seenBy = {}) {
  const at = out?.at || 0;
  const byProject = {};
  const fresh = [];
  const resolved = [];
  const failed = [];
  let landed = 0;
  let dispatched = 0;
  let resumed = 0;
  // 두 바퀴 돈 프로젝트(`round: 2`, 슬라이스 39)는 항목이 둘이다 — 건수는 합치고 **키는 마지막 바퀴**로
  // 본다: 첫 바퀴의 막힘이 둘째 바퀴에서 풀렸으면 이미 해소된 것이고, 두 바퀴 다 있으면 한 번만 센다.
  const latest = new Map();
  for (const p of out?.projects || []) {
    // 다른 회차가 다루는 중이라 지나간 프로젝트 — 결정 항목이 비어 있는 건 "다 풀렸다" 가 아니다.
    if (p.cycleRunning) continue;
    latest.set(p.project, p);
    landed += (p.land?.landed || []).filter((d) => d.ok).length;
    dispatched += (p.dispatch?.dispatched || []).filter((d) => d.ok && d.outcome !== 'exited').length;
    // 재개 성공은 파견처럼 변화로 센다 (슬라이스 43) — 깨우지는 않는다(회차가 스스로 한 일).
    resumed += (p.resume?.rows || []).filter((r) => r.action === 'resume' && r.result?.ok).length;
  }
  for (const p of latest.values()) {
    const prev = seenBy[p.project]?.keys || {};
    const items = Array.isArray(p.decisions) ? p.decisions : decisionItems({ projects: [p] });
    const keys = {};
    for (const i of items) {
      keys[i.key] = { type: i.type, slice: i.slice, what: i.what, reason: i.reason, needsUser: i.needsUser, blocked: i.blocked, since: prev[i.key]?.since ?? at };
      if (!(i.key in prev) && (i.needsUser || i.blocked)) fresh.push(i);
      if (RECOVERY_FAILED_TYPES.has(i.type)) failed.push(i);
    }
    for (const k of Object.keys(prev)) if (!(k in keys)) resolved.push({ project: p.project, key: k, ...prev[k] });
    byProject[p.project] = { at, keys };
  }
  const wake = fresh.length > 0 || failed.length > 0;
  return { wake, code: wake ? 0 : 1, fresh, resolved, failed, byProject, landed, dispatched, resumed };
}

/** 판정 한 줄 — precheck 의 stdout 이자 회차 보고의 "통지" 줄. `fleetTrigger` 가 400자로 자르므로 앞이 요지다. */
function precheckText(v, { projects = [], paused = [], report = null } = {}) {
  const item = (i) => (i.project ? i.project + ' ' : '') + (i.what || i.key);
  const why = v.wake
    ? '깨움 — ' +
      [
        v.fresh.length ? '새 ' + v.fresh.length + '(' + v.fresh.map(item).join(', ') + ')' : null,
        v.failed.length ? '회복 실패 ' + v.failed.length + '(' + v.failed.map(item).join(', ') + ')' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '안 깨움 — 새 결정 없음';
  return (
    '프로젝트 ' + projects.join(', ') + (paused.length ? ' (일시 제외 ' + paused.join(', ') + ')' : '') +
    ' · 착륙 ' + v.landed + ' · 파견 ' + v.dispatched + (v.resumed ? ' · 재개 ' + v.resumed : '') + ' · ' + why +
    (v.resolved.length ? ' · 해소 ' + v.resolved.length + '(' + v.resolved.map(item).join(', ') + ')' : '') +
    (report ? ' · 보고 ' + report : '')
  );
}

/**
 * 회차 자식의 환경. Orca 호스트 서비스에는 HOME 이 없다 — git 은 견디지만 git 이 부르는 ssh 가
 * `~/.ssh/config` 를 못 찾아 원격 별칭(github-dev)을 못 풀고 착륙의 push 가 죽는다
 * (2026-08-30 20:30 회차 SP-sync slice10). 자식에게 HOME 과 ssh 설정 경로를 명시해 준다 — 전역
 * git 설정은 건드리지 않고 이 회차 안에서만 유효하다.
 */
function cycleChildEnv(env = process.env, home = HOME, { sshExe = 'C:/Program Files/Git/usr/bin/ssh.exe', exists = existsSync } = {}) {
  const e = { ...env, HOME: home, USERPROFILE: env.USERPROFILE || home };
  const sshConfig = join(home, '.ssh', 'config');
  if (!e.GIT_SSH_COMMAND && exists(sshExe) && exists(sshConfig)) e.GIT_SSH_COMMAND = '"' + sshExe + '" -F "' + sshConfig.split('\\').join('/') + '"';
  return e;
}

/** precheck 가 회차를 기다리는 상한. Orca 의 precheck 상한이 600초라 그 안에서 손을 뗀다 — 아래 `spawnCycle`. */
const PRECHECK_WAIT_MS = 540 * 1000;

/**
 * 회차를 **분리 자식**으로 띄우고 결과를 기다린다.
 *
 * **Orca 의 precheck 상한은 600초다.** 회차 최악치(워크스페이스 생성·준비 대기 각 300초 ×3, 검사 600초,
 * 충돌 대기 600초)는 그보다 길다. 600초에 Orca 가 이 프로세스를 죽이면 회차가 워크스페이스는 만들고
 * 지시는 못 보낸 채 끊기고, 다음 회차는 그 슬라이스를 "이미 돌고 있음" 으로 봐 영영 지시가 안 간다.
 * 그래서 자식은 끝까지 돌게 두고 여기서는 540초까지만 기다린다 — 그 안에 끝나면 결과로 판정하고,
 * 아니면 `null`(진행 중)을 돌려 사람이 보게 깨운다. 자식은 계속 돌아 보고 파일을 쓴다.
 *
 * 자식 stdout 은 `.part` 파일에 **직접** 쓰게 한다(파이프가 아니라 fd) — 부모가 죽어도 안 끊긴다.
 * 끝나면 `.part` 내용을 `.json` 으로 옮긴다. 이 순서를 `cycleRunningFor` 가 "도는 중" 판정에 쓴다
 * (`.part` 가 `.json` 보다 새것 = 도는 중). 시작 전에 옛 `.json` 을 지우는 것도 그래서다.
 *
 * `--dry-run` 은 결과 `.json`·`.part` 를 **건드리지 않는다** — stdout 을 파이프로 메모리에 받는다.
 * 진단이 "도는 중" 판정 파일을 바꾸면 운영 상태가 흔들린다(coordinator 점검 #12).
 */
async function spawnCycle({ projects, dryRun, files, waitMs = PRECHECK_WAIT_MS, node = NODE, self = SELF, env = cycleChildEnv() }) {
  const args = [self, 'fleet', 'cycle', '--json', ...(dryRun ? ['--dry-run'] : ['--write'])];
  for (const p of projects) args.push('--project', p);
  let child;
  const chunks = [];
  if (dryRun) {
    child = spawn(node, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: true, env });
    child.stdout.on('data', (b) => chunks.push(b));
  } else {
    try {
      unlinkSync(files.done);
    } catch {}
    mkdirSync(dirname(files.part), { recursive: true });
    const fd = openSync(files.part, 'w');
    child = spawn(node, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true, detached: true, env });
    closeSync(fd);
  }
  child.unref();
  const done = new Promise((res) => child.on('exit', (code) => res(code)));
  let timer;
  const wait = new Promise((res) => (timer = setTimeout(() => res('timeout'), waitMs)));
  const r = await Promise.race([done, wait]);
  clearTimeout(timer);
  if (r === 'timeout') return null;
  const raw = dryRun ? Buffer.concat(chunks).toString('utf8') : readFileSync(files.part, 'utf8');
  if (!dryRun) writeFileSync(files.done, raw);
  return JSON.parse(raw);
}

/**
 * 회차 보고의 마지막 절에 "통지" 줄을 끼운다. 회차 자식이 방금 `\n---\n\n` 로 절을 닫았으므로, 그
 * 꼬리를 떼고 줄을 붙인 뒤 다시 닫는다 — 절 뒤에 그냥 덧붙이면 다음 회차의 절에 붙어 보인다.
 */
function noteInReport(file, line) {
  const tail = '\n---\n\n';
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!text.endsWith(tail)) return false;
  writeFileSync(file, text.slice(0, -tail.length) + '\n\n' + line + tail, 'utf8');
  return true;
}

/**
 * `fleet precheck [--project 이름]... [--dry-run] [--json]`.
 *
 * 프로젝트 선택: 이름을 주면 그것만(대소문자 무시 — Windows 폴더명), 안 주면 `PLAN.md` 가 있는
 * 워커 프로젝트 전부. **`fleetPause` 만 뺀다** — 빼 둔 프로젝트는 회차 자체를 안 돈다.
 * `fleetNoDispatch`(coordinator)는 **빼지 않는다**: 목록에 그대로 두고 회차(`cycleProject`)가 그
 * 프로젝트를 동기화만 하고 지나간다 (슬라이스 41). 결정 항목은 0 이라 통지도 안 뜬다 — 예전처럼
 * 목록에서 지우면 매시 안전망 회차가 coordinator 본체를 영영 안 올린다.
 *
 * 반환 `code` 가 곧 종료 코드다(0 깨움 / 1 변화 없음). 회차가 죽었거나 540초 안에 안 끝나도 0 —
 * 그건 사람이 봐야 한다.
 *
 * `deps` 는 테스트 자리다 — `spawnCycle`(회차 대신 가짜 결과), `projects`(폴더 목록 대신), `pause`,
 * `seenDir`(진짜 `~/.sp-sync` 에 지난 집합을 쓰면 안 된다).
 */
async function fleetPrecheck({ projects: wanted = [], dryRun = false, json = false, quiet = false, deps = {} } = {}) {
  const c = config();
  const spawnFn = deps.spawnCycle || spawnCycle;
  const out = { at: Date.now(), dryRun: !!dryRun, projects: [], paused: [], missing: [], code: 1, text: '' };
  const seenDir = deps.seenDir || DIR;
  const { names: all, paused } = splitPaused(deps.projects || cycleProjects([]), deps.pause ?? c.fleetPause);
  out.paused = paused;
  const lower = (v) => String(v).trim().toLowerCase();
  const projects = wanted.length ? wanted.map((w) => all.find((n) => lower(n) === lower(w))).filter(Boolean) : all;
  out.missing = wanted.filter((w) => !all.some((n) => lower(n) === lower(w)));
  out.projects = projects;
  const say = (s) => {
    out.text = s;
    if (!quiet && !json) console.log(s);
  };
  const finish = () => {
    log('fleet precheck' + (wanted.length ? ' ' + wanted.join(',') : '') + ': code ' + out.code + ' · ' + out.text);
    if (json) console.log(JSON.stringify(out, null, 2));
    return out;
  };
  if (out.missing.length && !quiet && !json) console.log('회차 대상이 아님(제외 중·PLAN.md 없음·폴더 없음): ' + out.missing.join(', '));
  if (!projects.length) {
    say(wanted.length ? '돌릴 프로젝트가 없음' : 'PLAN.md 가 있는 워커 프로젝트가 없음');
    return finish();
  }
  // 결과 파일은 지목한 프로젝트 것(`cycleResultFiles`) — 전역 파일에 쓰면 안전망 전체 회차의 "도는 중" 판정과 섞인다.
  const files = wanted.length ? cycleResultFiles(projects.map(safeName).join('+')) : cycleResultFiles(null);
  out.files = files;
  let cycle;
  try {
    cycle = await spawnFn({ projects, dryRun, files });
  } catch (e) {
    out.code = 0;
    say('fleet cycle 실패: ' + clean(e.message, 300));
    return finish();
  }
  if (!cycle) {
    out.code = 0;
    say('회차가 ' + Math.round(PRECHECK_WAIT_MS / 1000) + '초 안에 안 끝남 — 계속 도는 중. 보고는 끝난 뒤 runs/*-cycle.md 에 붙는다');
    return finish();
  }
  const seenBy = {};
  for (const p of cycle.projects || []) if (p.project && !p.cycleRunning) seenBy[p.project] = readJson(seenFileFor(p.project, seenDir), {});
  const v = precheckVerdict(cycle, seenBy);
  out.code = v.code;
  out.verdict = { wake: v.wake, fresh: v.fresh.map((i) => i.key), failed: v.failed.map((i) => i.key), resolved: v.resolved.map((i) => i.key), landed: v.landed, dispatched: v.dispatched };
  out.report = cycle.report || null;
  const text = precheckText(v, { projects: (cycle.projects || []).map((p) => p.project), paused: cycle.paused || [], report: cycle.report });
  if (!dryRun) {
    for (const [name, data] of Object.entries(v.byProject)) saveSeen(seenFileFor(name, seenDir), { project: name, ...data });
    if (cycle.report) noteInReport(cycle.report, '통지 — ' + text.replace(/ · 보고 .*$/, ''));
  }
  say(text);
  return finish();
}

// ---------- fleet trigger ----------
/**
 * 워커 턴이 끝나면 회차를 바로 부른다 (슬라이스 20).
 *
 * 30분 시계 회차만 있으면 5분짜리 슬라이스도 착륙·다음 파견까지 30분~1시간을 기다린다
 * (2026-08-31 사용자). 그래서 Stop 훅이 턴 끝마다 이 판정을 하고, 자격이 되면 회차 precheck 를
 * **분리 자식**으로 띄운다 — 훅은 기다리지 않고 바로 끝난다.
 *
 * 자격은 "회차가 지금 할 일이 있는가" 하나다:
 *   워크스페이스 — 슬라이스가 `[x]` + 트리 깨끗 + 카드 `wait` 빔 (= 착륙 신호. `landCheck` 와 같은 잣대)
 *   본체         — 기본 브랜치가 origin 보다 앞섬 (= 슬라이스 19 의 push 를 바로 타게)
 *
 * 그 밖의 턴에는 아무것도 안 띄운다. `fleetPause` 프로젝트는 뺀다 — 회차가 다루지 않는 저장소라
 * 띄워봐야 헛돈다.
 *
 * `fleetNoDispatch`(coordinator) 프로젝트는 **`kind: 'sync-only'`** 로 답한다 (슬라이스 41): 회차·precheck
 * 대신 본체 동기화만 하는 갈래다 (`fleetTrigger`). 팀장 세션을 깨우지도, 결과 파일·지난 집합을
 * 건드리지도 않는다 — 팀장의 제 턴 끝이 제 세션을 깨우는 고리가 생기면 안 된다. 조건은 본체
 * 갈래와 같다(기본 브랜치 + origin 보다 앞섬) — 그래야 매 턴이 아니라 올릴 것이 있는 턴에만 돈다.
 *
 * **fetch 하지 않는다.** 매 턴 네트워크를 타는 자리가 아니다. 원격 추적 ref 는 회차의 push 가
 * 갱신하므로 이 판정이 "앞섬"으로 읽으면 실제로 안 올라간 커밋이다 (사용자 세션은 push 를 하지 않는다).
 */
function cycleTriggerCheck(cwd, card, { home = HOME, config: c = config() } = {}) {
  const no = (reason) => ({ trigger: false, reason });
  if (!c.fleetTrigger) return no('fleetTrigger 꺼짐');
  const root = worktreeRoot(cwd);
  if (!root) return no('git 저장소가 아님');
  const main = repoRoot(root);
  // 회차가 도는 것은 `~/orca/projects/<프로젝트>` 뿐이다. ~/dev 등 밖의 저장소는 여기서 걸러진다.
  if (!normPath(main).startsWith(normPath(join(home, 'orca', 'projects')) + '/')) return no('Orca 프로젝트가 아님: ' + main);
  const project = basename(main.replace(/[\\/]+$/, ''));
  if (isPaused(project, c.fleetPause)) return no('자동 회차에서 일시 제외 중: ' + project);
  const noDispatch = isNoDispatch(project, c.fleetNoDispatch);
  // 파견 제외 프로젝트에는 PLAN.md 를 요구하지 않는다 — 슬라이스를 안 읽고 push 만 한다.
  if (!noDispatch && !existsSync(join(main, 'PLAN.md'))) return no('본체에 PLAN.md 가 없음');
  const head = gitTry(['rev-parse', 'HEAD'], root).out;
  const hit = (kind, reason, extra) => ({ trigger: true, kind, project, root, main, reason, rootKey: normPath(root), sig: kind + ':' + head, ...extra });

  // 본체가 origin 보다 앞서는가 — 본체 갈래와 sync-only 갈래가 같은 판정을 쓴다.
  const aheadOfOrigin = () => {
    const base = baseBranchOf(main);
    const branch = currentBranch(main);
    if (branch !== base) return { no: '기본 브랜치(' + base + ')가 아니라 ' + (branch || '?') + ' 에 있음' };
    const r = gitTry(['rev-list', '--count', 'origin/' + base + '..HEAD'], main);
    if (!r.ok) return { no: 'origin/' + base + ' 을 못 읽음' };
    const ahead = Number(r.out) || 0;
    return ahead ? { base, ahead } : { no: '본체가 origin/' + base + ' 과 같음' };
  };

  // 파견 제외 프로젝트 — 회차 대신 동기화만 (슬라이스 41). 워크스페이스는 회차가 안 다루므로 지나간다.
  if (noDispatch) {
    if (normPath(root) !== normPath(main)) return no('파견 제외 프로젝트라 워크스페이스는 회차가 안 다룸: ' + project);
    const a = aheadOfOrigin();
    if (a.no) return no(a.no);
    return hit('sync-only', project + ' 본체가 origin/' + a.base + ' 보다 ' + a.ahead + ' 앞섬 — 동기화만 (fleetNoDispatch)', { ahead: a.ahead });
  }

  if (normPath(root) !== normPath(main)) {
    const branch = currentBranch(root);
    const slice = sliceNumberOf(branch, root);
    if (slice == null) return no('브랜치가 sliceN 이 아니라 어느 슬라이스인지 모름: ' + (branch || '?'));
    const planFile = join(root, 'PLAN.md');
    if (!existsSync(planFile)) return no('워크스페이스에 PLAN.md 가 없음');
    let s;
    try {
      // 착륙과 같은 잣대 — 현재 단계뿐 아니라 모든 절에서 찾는다 (`sliceInPlan`).
      s = sliceInPlan(parsePlanSlices(readFileSync(planFile, 'utf8')), slice);
    } catch (e) {
      return no('PLAN.md 를 못 읽음: ' + clean(e.message, 80));
    }
    if (!s) return no('PLAN.md 에 ' + slice + '번이 없음');
    if (!s.done) return no(slice + '번이 아직 미체크');
    if (gitTry(['status', '--porcelain'], root).out) return no('작업 트리가 더러움 — 커밋 안 된 변경이 있다');
    if (card && isWaiting(card.wait)) return no('워커가 결정을 기다림: ' + clean(card.wait, 80));
    return hit('workspace', project + '/' + basename(root) + ' — ' + slice + '번 체크 완료 · 깨끗함', { slice });
  }

  const a = aheadOfOrigin();
  if (a.no) return no(a.no);
  return hit('main', project + ' 본체가 origin/' + a.base + ' 보다 ' + a.ahead + ' 앞섬', { ahead: a.ahead });
}

const TRIGGER_SEEN = join(DIR, 'fleet-trigger.json');
const TRIGGER_LOCK = join(DIR, 'fleet-trigger.lock');

/**
 * 회차 결과 파일. precheck 가 `--project <이름>` 을 받으면 그 프로젝트만 돌고 결과를
 * `fleet-cycle-result.<이름>.json` 으로 따로 쓴다 — 전역 파일에 쓰면 안전망(전체) 회차의
 * "도는 중" 판정과 섞인다.
 *
 * 이름 다듬기는 공용 `safeName` 하나다 (슬라이스 39) — 예전의 ASCII slug(`[^\w.-]` → `_`)는 '가계부'와
 * '자격증'을 같은 `___.json` 으로 만들어 두 프로젝트의 회차가 서로를 "도는 중"으로 읽었다 (coordinator 점검
 * #12). ASCII 이름에서는 두 규칙의 결과가 같으므로 coordinator 경로(`scripts/cycle-precheck.mjs` 의 `slug`)와
 * 안 어긋난다; 한글 이름 프로젝트는 내장 precheck(`fleetPrecheck: 'builtin'`)로 전환한 뒤에만 잠금이 맞는다.
 */
function cycleResultFiles(project) {
  const done = join(DIR, 'fleet-cycle-result' + (project ? '.' + safeName(project) : '') + '.json');
  return { part: done + '.part', done };
}
const CYCLE_RESULT = cycleResultFiles(null).done;
const CYCLE_PART = CYCLE_RESULT + '.part';

/**
 * 회차가 지금 도는 중인가. 회차 둘이 같은 워크스페이스를 착륙시키면 안 된다.
 *
 * precheck 는 회차 자식의 stdout 을 `.part` 에 직접 쓰고, 끝나면 그 내용을 `.json` 으로 옮긴다.
 * 그래서 **`.part` 가 `.json` 보다 새것**일 때만 도는 중이다 — 파일 유무만 보면 방금 끝난 회차가
 * 10분 동안 다음 트리거를 막아, 그 사이에 끝난 워커가 시계 회차까지 방치된다.
 * 상한을 넘긴 `.part` 는 죽은 회차로 보고 지나간다 (precheck 자체가 540초에 손을 뗀다).
 */
function cycleRunning(maxMs, now = Date.now(), files = { part: CYCLE_PART, done: CYCLE_RESULT }) {
  return (Array.isArray(files) ? files : [files]).some((one) => partFresh(one, maxMs, now));
}

/**
 * 프로젝트 하나에 대한 회차가 도는 중인가. **전역 파일과 그 프로젝트 파일을 둘 다 본다** —
 * 안전망의 전체 회차가 돌고 있으면 그 안에 이 프로젝트가 들어 있으므로 프로젝트별 회차도 안 띄운다.
 */
function cycleRunningFor(project, maxMs, now = Date.now()) {
  return cycleRunning(maxMs, now, [cycleResultFiles(null), cycleResultFiles(project)]);
}

function partFresh(files, maxMs, now) {
  let part;
  try {
    part = statSync(files.part).mtimeMs;
  } catch {
    return false;
  }
  if (now - part > maxMs) return false;
  let done = 0;
  try {
    done = statSync(files.done).mtimeMs;
  } catch {}
  return part > done;
}

// ---------- 프로젝트별 실행 잠금 · pending (슬라이스 39) ----------
/**
 * 회차 **실행** 잠금 — `fleet-run.lock/<safeName>/` 디렉터리, 안의 `owner.json` 에 소유 pid 와 시작 시각.
 *
 * `.part` 시각 비교(`cycleRunning`)는 "precheck 가 회차 자식을 띄웠나"의 힌트지 실행 권한이 아니었다:
 * 전체 회차는 `--project` 로 받은 프로젝트를 `asked` 로 보고 그 검사를 아예 건너뛰었고, coordinator 의
 * precheck 는 전체 회차에서도 프로젝트 전부를 `--project` 로 넘겼다 (coordinator 점검 #4). 이제 **모든 진입**
 * (전체·프로젝트별·손으로 친 `fleet cycle`)이 프로젝트를 다루기 직전에 이 락을 잡고 끝나면 놓는다 —
 * 같은 프로젝트의 착륙·파견은 어느 길로 들어와도 한 번에 하나다. 다른 프로젝트끼리는 독립이다.
 *
 * 살아 있음은 **pid 존재**로 본다(`isAlive`, 기본 `process.kill(pid, 0)`). 죽었거나 `fleetTriggerLockMs`
 * 를 넘긴 락은 묵은 것으로 보고 뺏는다 — 시간 상한은 매달린 회차(응답 없는 터미널을 기다리는 등)에
 * 프로젝트가 영영 잠기는 것을 막는 안전망이고, pid 검사는 죽은 회차의 락이 그 상한까지 프로젝트를
 * 묶는 것을 막는다. mkdir 이 원자라 두 회차가 같은 순간 들어와도 하나만 만든다(Windows 는 경합 때
 * EPERM 을 내므로 실패 종류를 가리지 않는다 — `state.lock`·트리거 락과 같다). 폴더는 생겼는데
 * `owner.json` 이 아직 없는 찰나는 "방금 잡힌 것"으로 본다 — 폴더 시각이 상한 안이면 거부.
 *
 * `base`·`pid`·`isAlive`·`now` 는 테스트 자리다 — 진짜 `~/.sp-sync` 에 락을 만들면 그 사이 실제 회차가 막힌다.
 */
const RUN_LOCK = join(DIR, 'fleet-run.lock');

function runLockPath(project, base = RUN_LOCK) {
  return join(base, safeName(project));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 있는데 권한이 없다(다른 사용자·서비스 계정) — 살아 있는 것이다.
    return e.code === 'EPERM';
  }
}

/** 락 안의 소유자. 없거나 못 읽으면 null. */
function runLockOwner(lock) {
  const o = readJson(join(lock, 'owner.json'), null);
  return o && typeof o === 'object' ? o : null;
}

function acquireRunLock(project, { maxMs, now = Date.now(), base = RUN_LOCK, pid = process.pid, isAlive = pidAlive } = {}) {
  const lock = runLockPath(project, base);
  const take = () => {
    mkdirSync(lock);
    writeJson(join(lock, 'owner.json'), { project, pid, at: now });
    return { ok: true, lock };
  };
  try {
    mkdirSync(base, { recursive: true });
  } catch {}
  try {
    return take();
  } catch {}
  // 누가 쥐고 있다. 살아 있는지 본다.
  const owner = runLockOwner(lock);
  let startedAt = owner?.at;
  if (!Number.isFinite(startedAt)) {
    try {
      startedAt = statSync(lock).mtimeMs;
    } catch {
      // 그 사이 놓였다 — 한 번 더 잡아 본다.
      try {
        return take();
      } catch {
        return { ok: false, lock, owner, reason: '프로젝트별 회차가 도는 중' };
      }
    }
  }
  const age = now - startedAt;
  const alive = owner ? isAlive(owner.pid) : true;
  if (alive && age <= maxMs) {
    const min = Math.max(0, Math.round(age / 60000));
    return { ok: false, lock, owner, reason: '프로젝트별 회차가 도는 중' + (owner ? ' (pid ' + owner.pid + ', ' + min + '분 전 시작)' : '') };
  }
  // 묵은 락 — 죽었거나 상한을 넘겼다. 뺏는다. 둘이 동시에 뺏으면 mkdir 이 한쪽만 통과시킨다.
  log('fleet run-lock ' + project + ' 묵은 락 회수 — ' + (owner ? 'pid ' + owner.pid + (alive ? ' 살아 있음' : ' 죽음') : '소유자 없음') + ', ' + Math.round(age / 1000) + '초');
  try {
    rmSync(lock, { recursive: true, force: true });
    return take();
  } catch {
    return { ok: false, lock, owner: runLockOwner(lock), reason: '프로젝트별 회차가 도는 중 (묵은 락을 다른 회차가 먼저 회수)' };
  }
}

function releaseRunLock(project, base = RUN_LOCK) {
  try {
    rmSync(runLockPath(project, base), { recursive: true, force: true });
  } catch {}
}

/**
 * 회차가 도는 중에 들어온 요청은 버리지 않고 `fleet-pending.<safeName>.json` 에 남긴다 (coordinator 점검 #5).
 * 그 프로젝트를 다루던 회차가 끝에서 이 파일을 보고 **한 바퀴 더**(1회 한정) 돈다 — 도는 회차의 관측 시점
 * 뒤에 끝난 워커도 30분 안전망까지 기다리지 않는다. 파일이 이미 있으면 덮는다(요청 하나면 충분하다).
 * 회차가 시작할 때도 지운다 — 지금 도는 이 바퀴가 그 요청을 만족시킨다.
 * `takePending` 은 읽고 **지운다** — 같은 요청으로 두 바퀴를 더 돌지 않는다.
 */
function pendingFile(project, dir = DIR) {
  return join(dir, 'fleet-pending.' + safeName(project) + '.json');
}

function leavePending(project, why, { dir = DIR, now = Date.now() } = {}) {
  const f = pendingFile(project, dir);
  mkdirSync(dir, { recursive: true });
  writeJson(f, { project, at: now, why: clean(why, 200), by: process.pid });
  return f;
}

function takePending(project, dir = DIR) {
  const f = pendingFile(project, dir);
  const data = readJson(f, null);
  if (!data) return null;
  try {
    unlinkSync(f);
  } catch {}
  return data;
}

/**
 * 회차를 띄우기 직전의 짧은 잠금. `.part` 는 precheck 가 켜지고 나서야 생기므로, 두 워커의 턴이
 * 같은 순간에 끝나면 둘 다 "도는 중 아님"으로 읽고 회차를 두 개 띄운다. 디렉터리 락으로 그 틈을 막는다.
 * Windows 는 경합 순간 EEXIST 가 아니라 EPERM 을 내므로 둘 다 "누가 쥐고 있다"로 본다 (state.lock 과 같다).
 *
 * **프로젝트별로 건다** (`fleet-trigger.lock/<이름>`, 전체 회차는 `_all`). 전역 락 하나였을 때는
 * A 의 트리거가 락을 쥔 동안 끝난 B 워커의 트리거가 통째로 버려졌고, B 는 다음 턴이 없어 다시
 * 부르지 못했다 (슬라이스 22). 프로젝트가 다르면 회차가 겹칠 일이 없다.
 */
function triggerLockPath(project, base = TRIGGER_LOCK) {
  return join(base, project ? safeName(project) : '_all');
}

/** `base` 는 테스트가 임시 폴더를 넣는 자리다 — 단위 테스트가 진짜 `~/.sp-sync` 에 락을 만들면 안 된다. */
function acquireTriggerLock(maxMs, now = Date.now(), project = null, base = TRIGGER_LOCK) {
  const lock = triggerLockPath(project, base);
  try {
    // 담는 폴더는 락이 아니다 — recursive 라 이미 있어도 안 던진다. 락은 그 안의 프로젝트 폴더다.
    mkdirSync(base, { recursive: true });
  } catch {}
  try {
    mkdirSync(lock);
    return true;
  } catch {}
  let age = Infinity;
  try {
    age = now - statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  if (age < maxMs) return false;
  try {
    rmdirSync(lock);
    mkdirSync(lock);
    return true;
  } catch {
    return false;
  }
}

function releaseTriggerLock(project = null, base = TRIGGER_LOCK) {
  try {
    rmdirSync(triggerLockPath(project, base));
  } catch {}
}

/**
 * 회차 트리거를 **터미널 밖에서** 띄우는 명령. 무엇을 어떻게 띄울지만 정한다 — 띄우는 건 `maybeTriggerCycle`.
 *
 * Orca 는 터미널 탭을 닫을 때 그 안에서 난 프로세스를 **Job Object 로 통째로** 죽인다 — `detached` 로 띄운
 * 손자까지 (2026-09-08 실측: 탭을 닫자 detached node 자식이 그 자리에서 사라졌다). 워커의 Stop 훅이 띄운
 * 회차는 그 워커를 착륙시키며 `orca worktree rm` 으로 **자기가 든 창을 닫으니 자기를 죽였다**: PR 머지·본체 ff
 * 까지 하고 파견·보고·잠금 해제 전에 사라져 `.part` 가 빈 채 남고, 10분 동안 "회차가 도는 중" 으로 다음
 * 트리거까지 막았다. 슬라이스 20 이후 워커발 트리거가 끝까지 돈 기록이 하나도 없고, 착륙 뒤 파견은 매시
 * 안전망 회차가 대신 해 왔다 (2026-09-08 SP-sync slice29 · Project A slice14).
 *
 * Node 의 spawn 은 CREATE_BREAKAWAY_FROM_JOB 을 못 준다. 그래서 Windows 에서는 WMI(`Win32_Process.Create`)로
 * 만든다 — 그 프로세스는 WMI 공급자 호스트 아래에서 나 터미널의 잡에 안 들어간다(같은 실험에서 탭을 닫아도
 * 살아남음). PowerShell 은 잡 안에서 1초쯤 돌고 끝나며 기다리지 않는다 — 그 1초 안에 창이 닫히는 일은 착륙
 * 시점(몇 분 뒤)과 겹치지 않는다. 항상 있는 `powershell.exe`(5.1)를 쓴다 — pwsh 는 스토어판 문제가 있었다.
 * 환경은 등록된 사용자 환경(PATH 에 orca·node·git·gh 있음, HOME 없음)이라, HOME 은 precheck 로 넘길 때
 * `fleetTrigger` 가 채운다. 다른 OS 는 그대로 분리 자식.
 */
function triggerLaunchPlan(project, { platform = process.platform, node = NODE, self = SELF } = {}) {
  const args = [self, 'fleet', 'trigger', '--project', project];
  if (platform !== 'win32') return { exe: node, args, viaWmi: false };
  // Windows 명령줄 규칙: 인자마다 큰따옴표, 안의 큰따옴표는 \" (앞의 백슬래시는 두 배), 끝 백슬래시도 두 배 —
  // Node 의 argv 파서가 그대로 되돌린다 (test/trigger-launch.test.mjs 가 실제 파서로 확인).
  const q = (v) => '"' + String(v).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  const cmdLine = [node, ...args].map(q).join(' ');
  // stdout 에 새 pid 하나, 종료 코드는 WMI ReturnValue(0 이 성공) — `maybeTriggerCycle` 이 둘로 성공을 판정한다.
  const ps = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '" + cmdLine.replace(/'/g, "''") + "' }; if ($r.ReturnValue -eq 0) { Write-Output $r.ProcessId }; exit [int]$r.ReturnValue";
  return { exe: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], viaWmi: true, cmdLine };
}

/** `triggerLaunchPlan` 을 실제로 띄운다. `{ok, pid?, reason?}` — 서명 기록은 이 결과를 본 뒤다 (`maybeTriggerCycle`). */
function launchTrigger(plan) {
  if (plan.viaWmi) {
    // WMI 호출은 기다린다(보통 2~5초, 트리거가 실제로 뜰 때만) — PowerShell 이 프로세스를 만들기 전에
    // 이 훅의 창이 닫히면 트리거가 통째로 사라진다. 기다렸다 돌아오면 그 뒤로는 창과 무관하다.
    const r = spawnSync(plan.exe, plan.args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    const pid = String(r.stdout || '').trim();
    if (r.status !== 0 || !/^\d+$/.test(pid)) {
      log('회차 트리거 실패(WMI ' + (r.status ?? r.error?.message) + '): ' + clean((r.stderr || r.stdout || '').trim(), 160));
      return { ok: false, reason: 'WMI 실패: ' + clean((r.stderr || '').trim(), 120) };
    }
    return { ok: true, pid: Number(pid) };
  }
  const child = spawn(plan.exe, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
  // 분리 자식의 기동 실패는 비동기로 온다 — 기다리지 않는 자리라 기록만 남긴다.
  child.on('error', (e) => log('회차 트리거 자식 오류: ' + clean(e.message, 160)));
  child.unref();
  return { ok: true };
}

/**
 * Stop 훅이 부른다. 자격이 되면 `fleet trigger` 를 터미널 밖의 분리 자식으로 띄우고 바로 돌아온다
 * (`triggerLaunchPlan` → `launchTrigger`). **절대 던지지 않는다** — 카드·SP 기록 경로를 막으면 안 된다.
 *
 * 같은 HEAD 로 두 번 띄우지 않는다. 착륙이 막힌(검사 실패 등) 워크스페이스나 push 가 실패하는
 * 본체는 조건이 계속 참이라, 그대로 두면 턴마다 회차가 뜬다. 서명(`fleet-trigger.json`)은 자식 기동을
 * **확인한 뒤**에만 적는다 — 먼저 적으면 기동 실패 뒤 같은 커밋의 다음 턴이 "이미 띄웠음" 에 걸려 그
 * 워크스페이스가 안전망까지 방치된다 (슬라이스 39, coordinator 점검 #5).
 *
 * 회차는 **이 턴이 난 프로젝트만** 돈다 (슬라이스 22). 전체를 돌면 A 의 회차가 도는 동안(최악 9분)
 * 끝난 B 워커의 트리거가 "회차가 도는 중"으로 버려지고, B 는 다음 턴이 없어 30분 안전망까지 방치된다.
 * 그 프로젝트의 회차가 이미 도는 중이면 버리지 않고 `fleet-pending` 에 남긴다 — 도는 회차가 끝에서
 * 한 바퀴 더 돈다 (슬라이스 39). 서명은 그때 안 적는다: 회차를 띄운 게 아니다.
 *
 * `deps` 는 테스트 자리 — `check`·`running`·`launch`·`seenFile`·`pendingDir`.
 */
function maybeTriggerCycle(h, card, deps = {}) {
  try {
    const c = config();
    const t = (deps.check || cycleTriggerCheck)(h.cwd || h._cwd || process.cwd(), card, { config: c });
    if (!t.trigger) return t;
    // sync-only 는 회차를 안 띄운다 — 실행 잠금도 결과 파일도 안 건드리므로 "도는 중" 도, pending 도
    // 볼 것이 없다 (슬라이스 41). 서명만으로 같은 HEAD 의 재실행을 막는다.
    const running = t.kind === 'sync-only' ? null : deps.running ? deps.running(t.project) : cycleRunningFor(t.project, c.fleetTriggerLockMs);
    if (running) {
      const f = leavePending(t.project, t.reason, { dir: deps.pendingDir });
      log('회차 트리거 보류(도는 중) → 요청을 남김: ' + t.reason);
      return { ...t, trigger: false, skipped: '회차가 도는 중 — 요청을 남김', pending: f };
    }
    const seenFile = deps.seenFile || TRIGGER_SEEN;
    const seen = readJson(seenFile, {});
    if (seen[t.rootKey] === t.sig) return { ...t, trigger: false, skipped: '같은 커밋으로 이미 띄웠음' };
    const r = (deps.launch || launchTrigger)(triggerLaunchPlan(t.project));
    if (!r.ok) return { ...t, trigger: false, reason: r.reason };
    seen[t.rootKey] = t.sig;
    writeJson(seenFile, seen);
    log('회차 트리거' + (r.pid ? '(WMI pid ' + r.pid + ')' : '') + ': ' + t.reason);
    return { ...t, spawned: true, ...(r.pid ? { pid: r.pid } : {}) };
  } catch (e) {
    log('회차 트리거 실패: ' + clean(e.message, 200));
    return { trigger: false, reason: '오류: ' + clean(e.message, 120) };
  }
}

/**
 * 회차 precheck 를 돌리고, 0 이 나오면 팀장 세션을 깨운다.
 *
 * 회차(착륙 → 파견 → 보고)는 precheck 안에서 모델 없이 돈다. `orca automations run` 은
 * **precheck 를 건너뛴다**(2026-08-31 실측, `precheckResult: null`) — 이미 돌렸으니 그게 맞다.
 * 세션은 보고를 읽기만 한다. 자동화 id 가 없으면 회차만 돌고 아무도 안 깨운다.
 *
 * `project` 를 주면 precheck 에 `--project <이름>` 을 넘겨 그 프로젝트만 돌린다 — 잠금·결과
 * 파일도 그 프로젝트 것이라 다른 프로젝트의 회차와 동시에 돈다 (슬라이스 22). 안 주면 전체(안전망).
 *
 * `fleetPrecheck` 가 `'builtin'` 이면 외부 스크립트 대신 이 도구의 `fleetPrecheck` 를 같은 프로세스에서
 * 부른다 (슬라이스 38). 판정·종료 코드의 뜻은 같다 — 0 이면 깨운다.
 */
async function fleetTrigger({ dryRun, json, project = null } = {}) {
  const c = config();
  // **precheck 를 부르기 전에 가른다** (슬라이스 41). 파견 제외 프로젝트는 회차도 precheck 도 안 탄다 —
  // 잠금·결과 파일·지난 집합을 안 건드리고, 팀장 세션도 안 깨운다. 할 일은 본체 동기화 하나뿐이다.
  if (project && isNoDispatch(project, c.fleetNoDispatch)) return syncOnlyTrigger(project, { dryRun, json });
  const out = { at: Date.now(), dryRun: !!dryRun, project, precheck: null, code: null, woke: false, automation: c.fleetAutomationId || null, skipped: null };
  const builtin = String(c.fleetPrecheck || '').trim() === 'builtin';
  const script = builtin ? 'builtin' : String(c.fleetPrecheck || '').replace(/^~/, HOME);
  out.script = script;
  const args = [...(project ? ['--project', project] : []), ...(dryRun ? ['--dry-run'] : [])];
  out.args = args;
  if (!builtin && !existsSync(script)) out.skipped = 'precheck 스크립트가 없음: ' + script;
  else if (cycleRunningFor(project, c.fleetTriggerLockMs)) {
    out.skipped = '회차가 도는 중';
    // 프로젝트를 지목한 요청은 남긴다 — 도는 회차가 끝에서 한 바퀴 더 돈다 (슬라이스 39). 전체(안전망)는 시계가 다시 온다.
    if (project && !dryRun) {
      out.pending = leavePending(project, 'fleet trigger 가 도는 회차와 겹침');
      out.skipped += ' — 요청을 남김';
    }
  } else if (!acquireTriggerLock(c.fleetTriggerLockMs, Date.now(), project)) out.skipped = '다른 트리거가 회차를 띄우는 중';
  if (!out.skipped) {
    try {
      if (builtin) {
        const r = await fleetPrecheck({ projects: project ? [project] : [], dryRun, quiet: true });
        out.code = r.code;
        out.precheck = clean(r.text, 400);
      } else {
        const r = spawnSync(NODE, [script, ...args], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: c.fleetTriggerLockMs,
          // Orca 호스트 서비스에는 HOME 이 없다 — precheck 가 그걸 자식에게 넘기므로 여기서도 챙긴다.
          env: { ...process.env, HOME, USERPROFILE: process.env.USERPROFILE || HOME },
        });
        out.code = r.status;
        out.precheck = clean(String(r.stdout || '').trim() || String(r.stderr || '').trim(), 400);
        if (r.error) out.precheck = 'precheck 실행 실패: ' + clean(r.error.message, 200);
      }
    } finally {
      releaseTriggerLock(project);
    }
    if (out.code === 0 && c.fleetAutomationId && !dryRun) {
      try {
        orcaJson(['automations', 'run', c.fleetAutomationId], 60000);
        out.woke = true;
      } catch (e) {
        out.wakeError = clean(e.message, 200);
      }
    }
  }
  const woke = out.woke ? ' · 팀장 깨움' : out.wakeError ? ' · 깨우기 실패: ' + out.wakeError : '';
  log('fleet trigger' + (project ? ' ' + project : '') + ': ' + (out.skipped || 'code ' + out.code + woke + ' · ' + out.precheck));
  if (json) console.log(JSON.stringify(out, null, 2));
  else if (process.stdout.isTTY) console.log(renderTrigger(out, c));
  return out;
}

/**
 * `fleetNoDispatch` 프로젝트의 트리거 — 본체 동기화(`syncMain`)만 하고 끝난다 (슬라이스 41).
 * `fleetTrigger` 와 같은 모양의 결과를 돌려주되 `kind: 'sync-only'` 로 표시하고 `code` 는 없다:
 * 깨울지 말지를 정하는 판정이 애초에 안 돈다.
 */
function syncOnlyTrigger(project, { dryRun, json } = {}) {
  const out = { at: Date.now(), dryRun: !!dryRun, project, kind: 'sync-only', code: null, woke: false, automation: null, skipped: null };
  try {
    const root = repoRoot(resolveProjectRoot(project));
    out.sync = syncMain(root, { dryRun });
    out.text = out.sync.text || out.sync.detail || '올릴 것 없음';
  } catch (e) {
    out.error = clean(e.message, 300);
    out.text = '동기화 실패: ' + out.error;
  }
  log('fleet trigger ' + project + ' 동기화만: ' + out.text);
  if (json) console.log(JSON.stringify(out, null, 2));
  else if (process.stdout.isTTY) console.log('[' + project + '] 동기화만 (fleetNoDispatch) — ' + out.text);
  return out;
}

function renderTrigger(out, c) {
  const who = out.project ? '[' + out.project + '] ' : '[전체] ';
  if (out.skipped) return who + '건너뜀 — ' + out.skipped;
  const head = who + 'precheck 종료 ' + out.code + (out.precheck ? ' · ' + out.precheck : '');
  if (out.code !== 0) return head + '\n변화 없음 — 팀장 세션을 깨우지 않는다';
  if (!c.fleetAutomationId) return head + '\nfleetAutomationId 가 비어 있어 깨우지 않는다 (회차는 돌았다)';
  if (out.dryRun) return head + '\n--dry-run — 깨우지 않는다';
  return head + '\n' + (out.woke ? '팀장 세션 깨움 (' + c.fleetAutomationId + ')' : '깨우기 실패: ' + out.wakeError);
}

export { RESUME_RUN_DEPS, cycleResume, stuckWorkspaces, isNoDispatch, syncOnlyTrigger, globalActiveCount, sinceText, DISPATCH_DEPS, HANDOFF_DEPS, LAND_DEPS, WORKSPACE_IO, projectWorkspaces, sleepingOf, acquireTriggerLock, acquireRunLock, releaseRunLock, runLockPath, pidAlive, pendingFile, leavePending, takePending, cycleProject, launchTrigger, baseBranchOf, claudeTerminal, closeExtraTabs, conflictLoop, conflictText, cycleProjects, cycleResultFiles, cycleRunning, cycleRunningFor, cycleTriggerCheck, cycleHandoff, decisionItems, cycleHandoffPlan, dispatchCommand, dispatchOne, dispatchPlan, fleetCycle, fleetDispatch, fleetEta, fleetGap, fleetGapOf, gapText, planStageNumber, linkTaskToStage, sortFleetRows, planOf, fleetHandoff, fleetLand, fleetPauseSet, fleetAgentSet, nextProjectAgent, fleetSlices, fleetStatus, fleetTrigger, fleetPrecheck, precheckVerdict, precheckText, seenFileFor, saveSeen, cycleChildEnv, noteInReport, spawnCycle, RECOVERY_FAILED_TYPES, PRECHECK_WAIT_MS, projectHere, handoffOne, handoffPlan, handoffPrompt, handoffRowText, headlessOf, headlessTurnDone, isPaused, landCheck, landOne, landStaleBlock, limitBlock, limitStartHold, limitStuckOf, maybeTriggerCycle, mergeGate, outputQuiet, parsePlanSlices, planDirtyBlock, prIsForHead, redispatchOne, releaseTriggerLock, removeWorkspaceDir, renderCycleReport, renderDispatch, renderFleet, renderHandoff, renderLand, renderLimits, renderSlices, renderTrigger, resolveAgents, resolveProjectRoot, runCheck, selfHash, sliceCommandFor, sliceInPlan, sliceNumberOf, splitPaused, staleWorkspacePlan, staleWorkspaceReason, strayBlock, sweepStaleWorkspaces, syncMain, triggerLaunchPlan, turnStateFor, undispatched, undispatchedCheck, unpushedAhead, waitForPrompt, waitForSession, waitHeadlessTurn, WORKSPACE_DEPS, workerCommand, workerPromptCommand, workspacesDirOf };
