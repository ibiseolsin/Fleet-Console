#!/usr/bin/env node
/**
 * sp-sync — Orca(Claude Code) 작업 진행사항을 Super Productivity로 단방향 동기화.
 *
 * 모델:
 *   SP 프로젝트   = Orca 프로젝트(= git repo 루트 폴더명)
 *   SP 태스크     = 그 세션이 실제로 진행한 작업
 *                   - 그 프로젝트의 **미완 태스크** 중 하나에 해당하면 → 거기 붙는다 (새로 안 만듦)
 *                   - 해당하는 것이 없으면                          → 백로그에 새로 만든다 (due 없음)
 *                 후보를 마감일로 거르지 않는다 — 예전에는 "오늘 마감"만 후보로 삼았는데
 *                 오늘 마감이 늘 0개라 매칭이 한 번도 발동하지 못했다 (`docs/hooks-cards.md`).
 *   태스크 notes  = git 커밋 로그 + 완료된 작업 항목 누적
 *
 * 판정 시점은 세션 '시작'이 아니라 '실작업이 생긴 뒤'다. 첫 프롬프트는 무슨 일을 할지
 * 정해지기 전이라 제목으로도 판정 근거로도 최악이기 때문. 커밋/작업항목이 없는 세션은
 * 아무것도 만들지 않는다.
 *
 * 모든 명령은 실패해도 exit 0 (훅이 절대 작업을 막지 않도록).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normPath, config, repoRoot, clean, state, log, api, git, currentBranch, todayStr, projectTitleFor, mutateState, token, HOME, ensureDir } from './lib/common.mjs';
import { hookInput, sweepWorktrees, refreshCandidates, ensureSession, patchSession, updateCard, worktreeRoot, pruneSessions, flushNotes, flushIfTurnClosed, newSessionEntry, worktreeDirs, writeSettings, writeAgentsMd, agentsMdState, orphanDrops, writeGitHooks, handoffToBackground, sessionIdFromEnv, writeDrop, writeCodexHooks, codexHooksState, renderCodexHooks, linkedWorktreeCopy, ensureCodexWritableRoot, codexHomeDir } from './lib/hooks.mjs';
import { argValues, wake, parseWakeAt, WAKE_TEXT } from './lib/wake.mjs';
import { maybeTriggerCycle, fleetSlices, renderSlices, fleetDispatch, fleetHandoff, fleetLand, fleetCycle, fleetTrigger, fleetPrecheck, cycleTriggerCheck, fleetPauseSet, fleetAgentSet, fleetStatus, renderFleet, projectHere } from './lib/fleet.mjs';
import { tasksReview, tasksDrift, tasksToday, tasksAgenda, tasksApply, applyValues, positionalArg } from './lib/tasks.mjs';
import { renderTasksReview, renderTasksDrift, renderTasksToday, renderTasksAgenda, renderApply } from './lib/tasks-render.mjs';
import { runWorker } from './lib/worker.mjs';
import { allLimits } from './lib/limits.mjs';
import { held as heldResources } from './lib/resources.mjs';

// ---------- 명령 ----------
/**
 * `tasks` 의 하위 명령 넷. 이름 하나에 **무엇을 부르고 무엇으로 그리고 `--apply` 가 있는가**를
 * 한 줄로 묶는다 — 셋을 따로 분기하면 하나를 더할 때 세 곳을 고쳐야 한다.
 *
 * `--days` 는 그 표의 기준을 바꾼다: 회수는 조용 기준(`staleDays`), 표류는 방치 기준(`driftDays`),
 * 편성은 표류 위에 얹히므로 방치 기준만 받는다(회수 기준은 기본값 그대로). `agenda` 는 셋을 한
 * 사슬로 태우므로 편성과 같은 플래그를 쓴다.
 *
 * `apply` 는 SP 에 쓸 키다 — `'done'` 은 `{isDone:true}`, `'due'` 는 `{dueDay:<오늘>}`.
 * 읽기 전용인 둘은 `noApply` 에 "그럼 어디로 가야 하나"를 적어 둔다.
 */
const TASK_SUBS = {
  review: { run: (arg, days) => tasksReview(arg, { staleDays: days }), render: renderTasksReview, apply: 'done' },
  drift: {
    run: (arg, days) => tasksDrift(arg, { driftDays: days }),
    render: renderTasksDrift,
    noApply: 'tasks drift --apply 는 없다 — 표류의 처방은 마감을 잡는 것이라 tasks today --apply 로 간다',
  },
  today: { run: (arg, days, max) => tasksToday(arg, { driftDays: days, max }), render: renderTasksToday, apply: 'due' },
  agenda: {
    run: (arg, days, max) => tasksAgenda(arg, { driftDays: days, max }),
    render: renderTasksAgenda,
    noApply: 'tasks agenda --apply 는 없다 — 표 밑 줄대로 tasks review --apply / tasks today --apply 로 간다',
  },
};

// `card` 가 받는 필드. 규칙 문서(`~/orca/CLAUDE.md` 복귀 카드 표)와 같아야 한다.
const CARD_FIELDS = new Set(['now', 'wait', 'next', 'task']);

/** `card` 의 stdin. 훅의 `readStdin` 은 JSON 파싱 실패를 `{}` 로 삼키므로 여기서는 원문을 받아 직접 판정한다. */
function readStdinText() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

const CMDS = {
  // UserPromptSubmit: 세션 기록만 시작한다. 태스크는 아직 만들지 않는다.
  async prompt() {
    const c = config();
    const h = hookInput();
    if (!h.session_id) return;
    const cwd = h.cwd || process.cwd();
    // **턴 시작을 맨 먼저 찍는다.** 이 값(`turnStartedAt`)이 착륙의 "턴 진행 중" 판정이고,
    // 직전 Stop 이 띄운 회차가 지금 이 순간에도 돌고 있다 — 아래 두 줄(훅 안전망 · SP 왕복
    // 2.5초)이 먼저 오면 그 몇 초 동안 이 창이 유휴로 읽혀 `worktree rm --force` 를 맞는다.
    // 뒤의 두 줄은 이 세션의 어떤 값도 안 쓰므로 순서를 바꿔도 잃는 게 없다.
    //
    // 짧은 프롬프트("ok", "ㅇㅇ", "계속")여도 **세션 기록은 만든다.** 예전에는 통째로 물러났는데,
    // 그러면 그 창은 state.json 에 없는 창이 되고 repos 매핑도 못 차지한다 — 그 뒤에 낸 커밋이
    // 옆 창 세션에 붙었다. 태스크가 생기는 걸 막는 일은 resolveSessionTask 가 커밋·작업항목
    // 유무로 이미 하고 있으므로(0순위 규칙) 여기서 또 막을 이유가 없다.
    // 다만 제목 재료로는 못 쓸 잡음이라 firstPrompt 만 비워 둔다.
    const prompt = clean(h.prompt || '', 9999);
    // 직접 Codex 세션(`--agent codex` 훅)은 `agent` 를 적는다 — 래퍼가 `init` 으로 하는 것과 같은 자리.
    // Claude 는 안 적는다(부재 = claude).
    const agent = h._agent || null;
    ensureSession(h.session_id, cwd, prompt.length < c.minPromptLen ? '' : prompt, { init: agent ? (e) => (e.agent = agent) : null });
    // 안전망: post-checkout이 안 돈 워크트리가 있으면 여기서 메운다
    try {
      sweepWorktrees(repoRoot(cwd));
    } catch {}
    // 세션이 카드에 태스크를 적을 수 있도록 후보 목록을 미리 받아둔다.
    await refreshCandidates(cwd);
  },

  // PostToolUse(TodoWrite): 완료된 작업 항목을 세션에 모아둔다.
  // 서브태스크로 만들지 않는다 — 계획 태스크의 하위 목록은 사용자가 설계한 것이라 건드리면 안 된다.
  async todos() {
    const h = hookInput();
    const todos = h.tool_input?.todos;
    if (!Array.isArray(todos) || !h.session_id) return;
    if (!state().sessions[h.session_id]) return;
    const done = todos
      .filter((t) => t.status === 'completed')
      .map((t) => clean(t.content, 200))
      .filter(Boolean);
    if (!done.length) return;
    patchSession(h.session_id, (e) => {
      for (const d of done) if (!e.todos.includes(d)) e.todos.push(d);
    });
  },

  // Stop: 여기서 판정하고 기록한다. 턴마다 불리지만 판정은 한 번만 일어난다.
  //
  // `given` 을 주면 stdin 대신 그 객체를 훅 입력으로 쓴다 — 헤드리스 워커(`CMDS.worker`)가
  // 프로세스 종료를 턴 끝으로 보고 여기를 그대로 부른다. **두 워커가 한 함수를 쓴다**:
  // 카드·status.md·회차 트리거·SP 노트가 에이전트에 따라 갈리면 안 된다.
  async stop(given) {
    const c = config();
    const h = given || hookInput();
    // 카드가 먼저다. SP 태스크가 안 생기는 세션(질문만 하고 끝난 세션)도 복귀 카드는 필요하다.
    const card = await updateCard(h);
    // **턴 끝을 회차보다 먼저 찍는다** (슬라이스 23). 아래 트리거가 띄우는 회차는 이 값을 유휴
    // 판정에 쓰므로(`turnStateFor`), 나중에 찍으면 워커가 띄운 회차가 자기 자신을 "턴 진행 중"
    // 으로 보고 그냥 지나친다 — 다음 턴이 없어 그 워크스페이스는 30분 안전망까지 방치된다.
    //
    // Stop 은 턴마다 온다 = 그 창이 아직 살아 있다는 가장 확실한 신호이기도 하다. `patchSession`
    // 이 같이 찍는 `seenAt` 이 그 몫이다 — taskId 가 이미 붙은 세션은 아래 판정도 notes 추가도
    // 건너뛰는 턴이 많아 seenAt 이 며칠씩 안 올랐고, 그러다 정리에 잘리면 태스크가 하나 더 생겼다.
    try {
      const prev = h.session_id ? state().sessions[h.session_id] : null;
      const wt = prev && !prev.worktree ? worktreeRoot(h.cwd || h._cwd || process.cwd()) : null;
      if (prev) patchSession(h.session_id, (e) => {
        e.turnEndedAt = Date.now();
        if (wt) e.worktree = wt;
      });
    } catch (e) {
      log('턴 끝 기록 실패: ' + clean(e.message, 120));
    }
    // 이 턴이 착륙·push 거리를 만들었으면 회차를 바로 부른다 (슬라이스 20). 자식은 분리되고
    // 여기서 기다리지 않는다 — SP 기록도 카드도 이 판정에 매이지 않는다.
    maybeTriggerCycle(h, card);
    // 카드 파일을 치우는 자리에서 세션 기록도 같이 치운다. 절대 던지지 않는다.
    try {
      pruneSessions(c.sessionKeepDays, h.session_id);
    } catch (e) {
      log('세션 기록 정리 실패: ' + clean(e.message, 120));
    }
    if (!h.session_id) return;
    // 판정 + 아직 안 쓴 줄 붙이기. 커밋 훅도 같은 함수를 쓴다 (`flushIfTurnClosed`) —
    // 턴이 어느 쪽으로 끝났느냐에 따라 notes 가 달라지면 안 된다.
    const r = await flushNotes(h.session_id);
    if (!r) return;
    const sess = r.sess;

    if (c.trackTime) {
      const elapsed = Date.now() - sess.startedAt;
      if (elapsed >= 60000) await api('PATCH', '/tasks/' + sess.taskId, { timeSpent: elapsed }).catch(() => {});
    }
  },

  // git post-commit: 커밋을 세션에 모아둔다. 보통은 여기까지고 SP 로 보내는 건 곧 올 `Stop` 이
  // 한다 — 다만 그 세션의 **턴이 이미 닫혀 있으면** 다음 Stop 이 없으므로 여기서 SP 까지 간다
  // (`flushIfTurnClosed`, 슬라이스 10). `git commit` 이 느려지지는 않는다: 이 명령은 진입점에서
  // detached 백그라운드 워커로 넘어간 뒤에 돈다(`handoffToBackground`).
  async commit() {
    // git log는 실제로 커밋이 일어난 워크트리에서 읽어야 한다.
    // root(메인 저장소)에서 읽으면 워크트리가 아니라 메인 브랜치의 HEAD가 나온다.
    const h = hookInput();
    const here = h._cwd || process.cwd();
    const root = repoRoot(here);
    try {
      sweepWorktrees(root);
    } catch {}
    const raw = git(['log', '-1', '--format=%h %s'], here);
    if (!raw) return;
    const branch = currentBranch(here);
    const line =
      branch && !/^(main|master)$/.test(branch)
        ? `${raw.split(' ')[0]} (${branch}) ${raw.split(' ').slice(1).join(' ')}`
        : raw;

    // 커밋한 창을 먼저 믿는다. git 훅은 `git commit` 을 부른 셸의 자식이라
    // 그 세션의 CLAUDE_CODE_SESSION_ID 를 물려받는다.
    //
    // repos 매핑은 저장소당 한 칸뿐이라, 한 워크트리에 창이 여럿이면 **가장 최근에 프롬프트를
    // 넣은 창**이 그 칸을 차지한다. 그래서 작업 창이 커밋해도 옆 질문 창에 붙는 일이 실제로
    // 일어났다 (2026-08-26에 확인). 환경변수 쪽이 정확하므로 그게 있으면 그걸 쓴다.
    // Codex 세션의 셸은 `CODEX_THREAD_ID` 를 물려주고, 세션 키는 `codex-` 접두어다 (`sessionIdFromEnv`).
    const envSid = sessionIdFromEnv()?.id || null;
    const inRepo = (s) => {
      const k = normPath(s?.cwd);
      const r = normPath(root);
      return k === r || k.startsWith(r + '/');
    };
    const sid =
      envSid && inRepo(state().sessions[envSid]) ? envSid : state().repos[root.toLowerCase()];
    if (sid && state().sessions[sid]) {
      // 락을 못 잡으면 patchSession 이 null 을 돌린다. 그때도 성공 로그를 찍으면 사후 조사가
      // 엉뚱한 곳을 본다 — 커밋이 사라진 게 아니라 "들어갔다"고 적혀 있으니까.
      const ok = patchSession(sid, (e) => {
        if (!e.commits.includes(line)) e.commits.push(line);
      });
      log((ok ? 'commit -> session ' : 'commit 기록 실패(락) -> session ') + sid + (sid === envSid ? ' (env)' : ' (repos)') + ': ' + line);
      // 턴이 닫힌 세션이면 여기서 직접 SP 로 보낸다 — 그 세션에는 다음 Stop 이 없다.
      const done = await flushIfTurnClosed(sid);
      if (done?.added?.length) log('commit(턴 닫힘) -> ' + done.sess.taskId + ': ' + done.added.length + '줄');
      return;
    }

    // 세션 밖에서 커밋한 경우: 그날의 커밋을 하나로 모아 판정한다.
    // repos 매핑은 건드리지 않는다 (진짜 세션이 시작되면 그쪽이 주인이어야 한다).
    const key = 'commits:' + root.toLowerCase() + ':' + todayStr();
    const entry = newSessionEntry(root, ''); // projectTitleFor 는 config 를 읽으므로 락 밖에서
    mutateState((s2) => {
      if (!s2.sessions[key]) s2.sessions[key] = entry;
      const e = s2.sessions[key];
      if (!e.commits.includes(line)) e.commits.push(line);
    });

    // 세션이 아예 없으니 턴 개념도 없다 — 늘 그 자리에서 보낸다. 붙이는 것은 방금 들어온 줄
    // 하나가 아니라 **아직 안 쓴 커밋 전부**다(`flushNotes`). 판정이 도는 동안(모델 호출이라
    // 수십 초다) 들어온 커밋은 그때 taskId 가 없어 물러난 뒤 다시 훑는 턴이 이 경로에는 없다.
    const done = await flushNotes(key);
    if (done) log('commit -> ' + done.sess.taskId + ': ' + line);
  },

  // 진단
  async doctor() {
    const c = config();
    const tk = token();
    console.log('SP endpoint  : http://' + c.host + ':' + c.port);
    console.log('token        : ' + (tk ? '찾음 (' + tk.length + '자)' : '못 찾음'));
    try {
      const res = await fetch('http://' + c.host + ':' + c.port + '/health', {
        signal: AbortSignal.timeout(c.timeoutMs),
      });
      console.log('/health      : ' + res.status + ' ' + (res.ok ? 'OK' : 'FAIL'));
    } catch {
      console.log('/health      : 연결 실패 — Super Productivity 데스크톱 앱을 실행하세요');
      return;
    }
    const projects = await api('GET', '/projects');
    const arr = Array.isArray(projects) ? projects : projects?.projects || [];
    console.log('SP 프로젝트  : ' + (arr.map((p) => p.title).join(', ') || '(없음)'));

    // 인자로 경로를 주면 그 위치가 어느 SP 프로젝트로 잡히는지 보여준다
    const probe = process.argv[3] ? resolve(process.argv[3]) : null;
    if (probe) {
      const root = repoRoot(probe);
      const title = projectTitleFor(root);
      const hit = arr.find((p) => (p.title || '').toLowerCase() === title.toLowerCase());
      console.log('\n--- 경로 진단 ---');
      console.log('작업 위치     : ' + probe);
      console.log('브랜치        : ' + (currentBranch(probe) || '(없음)'));
      console.log('메인 저장소   : ' + root);
      const miss = c.fallback === 'skip' ? ' ✗ (SP에 없음 → 기록 안 함)' : ' ✗ (SP에 없음 → Inbox 폴백)';
      console.log('SP 프로젝트   : ' + title + (hit ? ' ✓' : miss));
      return;
    }

    // 캐시에 든 프로젝트 id 가 아직 살아 있는지 확인한다.
    // 죽은 id 가 남아 있으면 태스크는 생성되는데 SP 화면에 안 보인다 (유령 프로젝트).
    const cached = state().projectIds || {};
    const dead = Object.entries(cached).filter(([, id]) => !arr.some((p) => p.id === id));
    if (dead.length) {
      console.log('\n⚠ 죽은 프로젝트 캐시: ' + dead.map(([n, id]) => n + ' -> ' + id).join(', '));
      console.log('  이 이름으로 만든 태스크는 SP 화면에 안 보입니다.');
      console.log('  고치기: node sp-sync.mjs forget ' + dead.map(([n]) => '"' + n + '"').join(' '));
    }

    // 세션 id 없이 떨궈진 카드 — 그 턴의 복귀 카드가 통째로 사라진 흔적이다. 지우지 않는다
    // (`orphanDrops` 머리 주석: 생산자는 이 도구가 아니라 규칙 문서의 카드 스니펫이다).
    const orphans = orphanDrops();
    if (orphans.length) {
      console.log('\n⚠ 고아 drop 카드 ' + orphans.length + '개: ' + orphans.join(', '));
      console.log('  세션 id 없이 쓰인 카드입니다 — 어느 세션에도 안 붙습니다.');
      console.log('  카드 스니펫이 CLAUDE_CODE_SESSION_ID 를 못 읽은 것이니, 그 세션 환경을 보세요.');
    }

    // 직접 Codex 세션의 훅 — Orca 탭의 codex 가 읽는 홈에 있고 사람이 신뢰했는가 (슬라이스 45)
    console.log(renderCodexHooks(codexHooksState()));

    const orcaDir = join(HOME, 'orca', 'projects');
    if (existsSync(orcaDir)) {
      const mine = readdirSync(orcaDir, { withFileTypes: true })
        // '.' 로 시작하는 폴더(.git, .obsidian 같은 것)는 프로젝트가 아니다. 세면
        // "SP 에 없는 프로젝트" 경고에 껴서 있지도 않은 누락을 만들라고 시킨다.
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => projectTitleFor(join(orcaDir, d.name)));
      const missing = mine.filter((m) => !arr.some((p) => (p.title || '').toLowerCase() === m.toLowerCase()));
      console.log('Orca 프로젝트: ' + mine.join(', '));
      if (missing.length) {
        console.log('\n⚠ SP에 없는 프로젝트: ' + missing.join(', '));
        console.log('  SP API로는 프로젝트를 만들 수 없습니다. SP 앱에서 같은 이름으로 한 번만 만들어 주세요.');
        console.log(
          c.fallback === 'skip'
            ? '  (fallback=skip 이라 만들기 전까지 그 프로젝트 작업은 기록되지 않습니다)'
            : "  (안 만들면 '[프로젝트명] 제목' 형태로 Inbox에 들어갑니다)"
        );
      }

      // 헤드리스 워커가 읽는 생성본이 원본과 맞는지. 최신인 것은 세지만 이름은 안 낸다.
      const states = readdirSync(orcaDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, ...agentsMdState(join(orcaDir, d.name)) }));
      const say = { user: '사용자 작성 — 갱신 안 함', stale: 'CLAUDE.md 가 바뀜 — 다음 훅에서 갱신', missing: '없음 — 다음 훅에서 생성' };
      const odd = states.filter((x) => say[x.kind]);
      console.log(
        '\nAGENTS.md    : 최신 ' + states.filter((x) => x.kind === 'current').length + '개' + (odd.length ? '' : ' (전부)')
      );
      for (const x of odd) console.log('  ' + x.name + ': ' + say[x.kind]);
    }
  },

  // 캐시된 프로젝트 id 를 지운다 (다음 세션에 다시 조회한다)
  async forget() {
    const names = process.argv.slice(3);
    const s = state();
    if (!names.length) {
      console.log('캐시된 프로젝트: ' + (Object.keys(s.projectIds).join(', ') || '(없음)'));
      console.log('사용법: node sp-sync.mjs forget <프로젝트명> [...]  |  forget --all');
      return;
    }
    if (names[0] === '--all') {
      mutateState((x) => (x.projectIds = {}));
      console.log('프로젝트 id 캐시를 모두 비웠습니다.');
      return;
    }
    mutateState((x) => {
      for (const n of names) {
        // 캐시 키는 소문자다(resolveProjectId). 글자 그대로 비교하면 대소문자만 다른
        // 이름을 줬을 때 "캐시에 없음"이 나오고 죽은 id 가 그대로 남는다.
        const k = String(n).toLowerCase();
        if (x.projectIds[k]) {
          delete x.projectIds[k];
          console.log('✓ 캐시 삭제: ' + n);
        } else {
          console.log('- 캐시에 없음: ' + n);
        }
      }
    });
  },

  // 프로젝트에 훅 설치
  async install() {
    const target = process.argv[3] ? resolve(process.argv[3]) : process.cwd();
    // 조용히 성공했다고 말하지 않는다. 예전엔 없는 경로를 받아도 repoRoot()가 catch로 빠져
    // 그 경로를 그대로 돌려줬고, 한 개도 설치하지 않은 채 '설치 완료'를 찍었다.
    // 2026-08-26에 Orca 설정 스크립트가 실제로 이 구멍에 빠졌다.
    if (!existsSync(target)) {
      throw new Error(
        `경로가 없습니다: ${target}
  Orca 설정 스크립트라면 셸이 $ORCA_WORKTREE_PATH 를 치환하지 못한 것이다.
  Windows 셸은 이 문법을 모른다 — 인자를 빼고 install 만 쓰면 현재 위치를 쓴다.`
      );
    }
    const root = repoRoot(target);
    if (!existsSync(join(root, '.git'))) {
      throw new Error(`git 저장소가 아닙니다: ${target}
  (본체로 잡힌 곳: ${root})`);
    }

    // 1) 메인 저장소 + 기존 워크트리 전부에 세션/투두 훅
    const dirs = worktreeDirs(root).filter((d) => existsSync(d));
    if (!dirs.length) throw new Error('설치할 워크트리가 없습니다: ' + root);
    for (const d of dirs) console.log('✓ ' + writeSettings(d));

    // 2) 헤드리스 에이전트가 읽는 AGENTS.md (CLAUDE.md 두 층을 이어 붙인 것).
    //    원본이 바뀌었으면 다시 쓰고, 사람이 쓴 파일은 그대로 둔다 (`agentsMdState`).
    for (const d of dirs) {
      const before = agentsMdState(d).kind;
      const f = writeAgentsMd(d);
      if (f) console.log('✓ ' + f + (before === 'stale' ? '  (CLAUDE.md 가 바뀌어 갱신)' : '  (CLAUDE.md 에서 생성)'));
      else if (before === 'user') console.log('- ' + join(d, 'AGENTS.md') + '  (사용자 작성 — 갱신 안 함)');
      else if (before === 'current') console.log('- ' + join(d, 'AGENTS.md') + '  (최신 — 그대로)');
    }

    // 3) 저장소 공용 git 훅 (post-commit = 커밋 기록, post-checkout = 새 워크트리 자동 설치)
    for (const h of writeGitHooks(root)) console.log('✓ ' + h + '  (워크트리 전체 공유)');

    // 4) 직접 Codex 세션의 훅 — 저장소가 아니라 codex 홈 하나에(명령이 Orca 밖에서는 스스로 물러난다).
    //    신뢰는 codex 화면에서 사람이 한 번 — 아래 상태 줄이 그걸 말한다.
    //    워크트리 사본에서 돌렸으면 건너뛴다 — 전역 파일에 착륙 뒤 사라질 경로가 박힌다(`linkedWorktreeCopy`).
    const copy = linkedWorktreeCopy(dirs, root);
    if (copy) console.log('- codex 훅 건너뜀: 워크트리 사본에서 실행 (' + copy + ') — 본체에서 install');
    else {
      const cx = writeCodexHooks();
      const cxState = codexHooksState();
      const ok = cxState.events.every((e) => e.trusted);
      console.log((ok ? '✓ ' : '! ') + cx.file + '  (codex prompt/stop 훅, 배열 끝에' + (cx.changed.length ? '; 정의가 바뀌어 옛 신뢰 지움: ' + cx.changed.join(', ') : '') + ')');
      if (!ok) console.log('  ' + renderCodexHooks(cxState));
      // `card` 가 ~/.sp-sync 에 쓰려면 codex 샌드박스가 그 폴더를 허용해야 한다
      const wr = ensureCodexWritableRoot();
      console.log((wr === 'present' ? '- ' : '✓ ') + join(codexHomeDir(), 'config.toml') + '  (sandbox_workspace_write.writable_roots 에 ~/.sp-sync' + (wr === 'present' ? ' — 이미 있음' : ' 추가') + ')');
    }

    console.log('\n설치 완료: ' + root + ' → SP 프로젝트 "' + projectTitleFor(root) + '"');
    if (dirs.length > 1) console.log('워크트리 ' + (dirs.length - 1) + '개 포함.');
    console.log('새 워크트리는 post-checkout 훅이 자동으로 설치합니다.');
  },

  // 함대 상태: 살아 있는 터미널 · 마지막 카드 · 마감을 프로젝트별 한 표로
  async fleet() {
    const sub = process.argv[3];
    if (sub === 'slices') {
      // 프로젝트 이름은 플래그가 아닌 첫 인자다. `--json` 같은 플래그와 섞이지 않게 걸러 낸다.
      const arg = process.argv.slice(4).find((a) => !a.startsWith('--'));
      const r = fleetSlices(arg);
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ at: Date.now(), ...r }, null, 2));
        return;
      }
      process.stdout.write(renderSlices(r));
      return;
    }
    if (sub === 'dispatch') {
      const c = config();
      // 값 플래그의 값이 위치 인자(프로젝트 이름)로 밀리면 엉뚱한 프로젝트를 파견한다 — `handoff` 와 같은 자리.
      const valueFlags = new Set(['--max', '--max-total', '--base', '--model', '--hard-model', '--start-pct']);
      let arg = null;
      for (let i = 4; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (valueFlags.has(a)) {
          i++;
          continue;
        }
        if (!a.startsWith('--')) {
          arg = a;
          break;
        }
      }
      const max = Number(argValues('--max')[0] || c.fleetMaxWorkspaces);
      if (!Number.isFinite(max) || max < 1) throw new Error('--max 는 1 이상의 수여야 합니다');
      // 모든 프로젝트를 합친 상한 (슬라이스 42). `--max-total 0` 으로 끌 수 있다 — 한 프로젝트만 몰아
      // 돌리는 손 실행에서 전역 상한이 걸리면 사유만 늘고 할 수 있는 일이 없다.
      const maxTotal = Number(argValues('--max-total')[0] ?? c.fleetMaxWorkspacesTotal);
      if (!Number.isFinite(maxTotal) || maxTotal < 0) throw new Error('--max-total 은 0 이상의 수여야 합니다 (0 은 끔)');
      await fleetDispatch(arg, {
        max,
        maxTotal,
        dryRun: process.argv.includes('--dry-run'),
        json: process.argv.includes('--json'),
        base: argValues('--base')[0] || null,
        model: argValues('--model')[0] || c.fleetModel,
        hardModel: argValues('--hard-model')[0] || c.fleetHardModel,
        readyMs: c.fleetReadyMs,
        createMs: c.fleetCreateMs,
        // 재파견 판정의 마지막 재료(TUI 유휴)를 재는 대기. 착륙과 같은 값을 쓴다.
        idleMs: c.fleetIdleMs,
        // 한도 임박 게이트의 손잡이. 기본은 config 의 `fleetLimitStartPct` — dry-run 으로 "지금
        // 한도로는 무엇이 보류되나"를 확인할 때 설정 파일을 안 건드리고 낮춰 본다.
        startPct: argValues('--start-pct')[0] ?? null,
      });
      return;
    }
    if (sub === 'handoff') {
      const c = config();
      // 위치 인자는 프로젝트·슬라이스 둘이다. 값 플래그의 값(`--to codex`, 검증용 `--prompt ...`)
      // 을 위치 인자로 세면 프로젝트 이름이 codex 로 밀리므로 이 명령에서 아는 값 플래그를 건너뛴다.
      const valueFlags = new Set(['--to', '--prompt', '--model', '--hard-model']);
      const positional = [];
      for (let i = 4; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (valueFlags.has(a)) {
          i++;
          continue;
        }
        if (!a.startsWith('--')) positional.push(a);
      }
      const number = positional[1];
      if (!/^\d+$/.test(String(number || '')) || Number(number) < 1)
        throw new Error('사용법: node sp-sync.mjs fleet handoff <프로젝트> <슬라이스> --to <에이전트> [--dry-run] [--prompt <문장>]');
      const to = argValues('--to')[0];
      if (!to) throw new Error('--to <에이전트>가 필요합니다');
      await fleetHandoff(positional[0], {
        slice: Number(number),
        to,
        prompt: argValues('--prompt')[0] || null,
        dryRun: process.argv.includes('--dry-run'),
        json: process.argv.includes('--json'),
        model: argValues('--model')[0] || c.fleetModel,
        hardModel: argValues('--hard-model')[0] || c.fleetHardModel,
        readyMs: c.fleetReadyMs,
        createMs: c.fleetCreateMs,
      });
      return;
    }
    if (sub === 'land') {
      const c = config();
      const arg = process.argv.slice(4).find((a) => !a.startsWith('--'));
      await fleetLand(arg, {
        dryRun: process.argv.includes('--dry-run'),
        json: process.argv.includes('--json'),
        base: argValues('--base')[0] || null,
        // 워커가 push 승인을 묻는 대기처럼, 사용자가 이미 답한 대기를 넘긴다. 무시해도 보고에는 남는다.
        ignoreWait: process.argv.includes('--ignore-wait'),
        check: argValues('--check')[0] || null,
        checks: c.fleetChecks || {},
        idleMs: c.fleetIdleMs,
        // 급할 때 조용함 기준을 낮추는 손잡이. 기본은 config 의 fleetQuietMs.
        quietMs: Number(argValues('--quiet-ms')[0] ?? c.fleetQuietMs),
        conflictMs: c.fleetConflictMs,
        conflictTries: c.fleetConflictTries,
        // 헤드리스 충돌 턴이 래퍼 탭을 새로 여는 대기 (파견의 `terminal create` 와 같은 값).
        createMs: c.fleetCreateMs,
        ghMs: c.fleetGhMs,
        checkMs: c.fleetCheckMs,
      });
      return;
    }
    if (sub === 'cycle') {
      const c = config();
      const max = Number(argValues('--max')[0] || c.fleetMaxWorkspaces);
      if (!Number.isFinite(max) || max < 1) throw new Error('--max 는 1 이상의 수여야 합니다');
      await fleetCycle({
        projects: argValues('--project'),
        dryRun: process.argv.includes('--dry-run'),
        json: process.argv.includes('--json'),
        // dry-run 은 기본으로 보고를 안 쓴다. 회차 기록에 "안 한 일"이 섞이면 이력이 못 믿을 것이 된다.
        write: process.argv.includes('--write'),
        land: {
          base: argValues('--base')[0] || null,
          // **`--ignore-wait` 를 기본으로 켜지 않는다** (2026-08-30 결정). 이 흐름의 워커는 push
          // 승인을 `wait` 에 적지 않기로 규칙을 고쳤으므로, 대기가 차 있으면 진짜 결정거리다.
          ignoreWait: process.argv.includes('--ignore-wait'),
          idleMs: c.fleetIdleMs,
          quietMs: c.fleetQuietMs,
          conflictMs: c.fleetConflictMs,
          conflictTries: c.fleetConflictTries,
          createMs: c.fleetCreateMs,
          ghMs: c.fleetGhMs,
          checkMs: c.fleetCheckMs,
          checks: c.fleetChecks || {},
        },
        dispatch: { max, maxTotal: Number(argValues('--max-total')[0] ?? c.fleetMaxWorkspacesTotal), base: argValues('--base')[0] || null, model: argValues('--model')[0] || c.fleetModel, hardModel: argValues('--hard-model')[0] || c.fleetHardModel, readyMs: c.fleetReadyMs, createMs: c.fleetCreateMs, idleMs: c.fleetIdleMs, startPct: argValues('--start-pct')[0] ?? null },
      });
      return;
    }
    if (sub === 'precheck') {
      // Orca 자동화 "coordinator 회차" 의 precheck 명령 자리 (슬라이스 38). 회차를 돌리고 종료 코드로
      // 깨울지 답한다 — 0 깨움 / 1 변화 없음. coordinator 의 cycle-precheck.mjs 가 하던 일이다.
      const r = await fleetPrecheck({ projects: argValues('--project'), dryRun: process.argv.includes('--dry-run'), json: process.argv.includes('--json') });
      // 숫자를 돌려주면 진입점이 그대로 종료 코드로 쓴다 (`passthrough`) — Orca 가 이 코드로 깨울지 정한다.
      return r.code;
    }
    if (sub === 'trigger') {
      // --here: 현재 폴더의 프로젝트만 돈다 (`--project <이름>` 과 같음). Orca 전역 빠른 명령용 —
      // 이름 없이 치면 전체 회차(안전망)라, 빠른 명령에 그대로 두면 창마다 전체가 돈다.
      const here = process.argv.includes('--here');
      const named = argValues('--project')[0] || null;
      if (here && named) throw new Error('--here 와 --project 는 같이 줄 수 없습니다');
      await fleetTrigger({ dryRun: process.argv.includes('--dry-run'), json: process.argv.includes('--json'), project: here ? projectHere(process.cwd()) : named });
      return;
    }
    if (sub === 'check') {
      // 판정만 본다 — 지금 이 폴더의 턴이 회차를 부를 자격이 되는가. `--here` 는 그 기본 동작의
      // 이름일 뿐이다(빠른 명령 네 개가 같은 꼴이 되도록) — `--path` 를 주면 그쪽이 이긴다.
      const r = cycleTriggerCheck(argValues('--path')[0] || process.cwd(), null);
      if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else console.log((r.trigger ? '자격 있음 — ' : '자격 없음 — ') + r.reason);
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      const arg = process.argv.slice(4).find((a) => !a.startsWith('--'));
      // --here: 현재 폴더의 프로젝트. Orca 전역 빠른 명령이 워크트리마다 새 탭에서 이 한 줄을 치는 용도.
      const r = fleetPauseSet(arg, { off: sub === 'resume', here: process.argv.includes('--here') });
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ at: Date.now(), ...r }, null, 2));
        return;
      }
      if (r.changed) console.log((sub === 'pause' ? '자동 회차에서 뺌: ' : '자동 회차에 다시 넣음: ') + r.name);
      else if (r.name) console.log(r.name + ' — 이미 ' + (sub === 'pause' ? '빠져 있음' : '들어 있음'));
      console.log(r.list.length ? '일시 제외 중: ' + r.list.join(', ') : '일시 제외 중인 프로젝트 없음');
      return;
    }
    if (sub === 'agent') {
      // fleet agent [<프로젝트>|--here] [<에이전트>] — 프로젝트의 워커 에이전트를 보거나 바꾼다.
      // --here 면 첫 위치 인자가 에이전트, 아니면 <프로젝트> <에이전트> 순.
      const pos = process.argv.slice(4).filter((a) => !a.startsWith('--'));
      const here = process.argv.includes('--here');
      const r = fleetAgentSet(here ? '' : pos[0], here ? pos[0] : pos[1], { here });
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ at: Date.now(), ...r }, null, 2));
        return;
      }
      const show = (v) => v + (v === 'claude' ? ' (기본값)' : '');
      if (r.project && r.changed) console.log('워커 에이전트 바꿈: ' + r.project + ' — ' + show(r.prev) + ' → ' + show(r.agent));
      else if (r.project) console.log('워커 에이전트: ' + r.project + ' — ' + show(r.agent) + (r.prev === r.agent && pos.length > (here ? 0 : 1) ? ' (이미 그대로)' : ''));
      const keys = Object.keys(r.map);
      console.log(keys.length ? '기본값(claude)이 아닌 프로젝트: ' + keys.map((k) => k + '=' + r.map[k]).join(', ') : '모든 프로젝트가 기본값(claude)');
      return;
    }
    if (sub !== 'status')
      throw new Error(
        '사용법: node sp-sync.mjs fleet <status|slices <프로젝트>|dispatch <프로젝트> [--max N] [--start-pct N]|handoff <프로젝트> <슬라이스> --to <에이전트>|land <프로젝트>|cycle [--project 이름]...|precheck [--project 이름]...|trigger [--project 이름|--here]|check [--path 경로|--here]|pause [<프로젝트>|--here]|resume [<프로젝트>|--here]|agent [<프로젝트>|--here] [<에이전트>]> [--dry-run] [--json]\n' +
          '  dispatch·cycle 은 --max-total N 으로 전역 동시 상한(fleetMaxWorkspacesTotal, 0 은 끔)을 덮는다\n' +
          '  dispatch·cycle 은 단독 실행에서도 본체를 origin 과 맞춘다(push 포함) — 워커가 옛 PLAN.md 를 받으면 안 되기 때문. --dry-run 은 안 맞춘다'
      );
    const rows = await fleetStatus();
    // 한도는 프로젝트가 아니라 **계정** 것이라 표와 따로 한 칸에 싣는다 (표에는 그 프로젝트가
    // 쓰는 에이전트 것만 들어간다).
    const limits = allLimits();
    // 잡혀 있는 공유 자원도 프로젝트가 아니라 계정 것이다 (슬라이스 42) — 표와 따로 한 칸에 싣는다.
    const held = heldResources();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ at: Date.now(), limits, held, projects: rows }, null, 2));
      return;
    }
    if (!rows.length) {
      console.log('살아 있는 Orca 터미널 없음');
      return;
    }
    process.stdout.write(renderFleet(rows, limits, held));
  },

  // SP 일정 정리. review = 완료 회수, drift = 표류 감지, today = 오늘 편성, agenda = 셋을 한 화면에.
  // --apply 없이는 SP 에 안 쓴다.
  async tasks() {
    const sub = process.argv[3];
    if (!TASK_SUBS[sub])
      throw new Error('사용법: node sp-sync.mjs tasks <review|drift|today|agenda> [<프로젝트>] [--days N] [--max N] [--json] | tasks <review|today> --apply <id>... [--dry-run]');
    const { run, render, apply, noApply } = TASK_SUBS[sub];
    // 쓰는 길 둘. review 는 완료 처리(`apply: 'done'`), today 는 마감일을 오늘로(`apply: 'due'`).
    // 나머지 둘은 읽기 전용이라 `--apply` 가 어디로 가야 하는지 `noApply` 로 일러 준다.
    const applyIds = apply ? applyValues(process.argv.slice(4)) : [];
    if (applyIds.length) {
      const r = await tasksApply(applyIds, { dryRun: process.argv.includes('--dry-run'), due: apply === 'due' ? todayStr() : undefined });
      if (process.argv.includes('--json')) console.log(JSON.stringify({ at: Date.now(), ...r }, null, 2));
      else process.stdout.write(renderApply(r));
      return;
    }
    if (noApply && process.argv.includes('--apply')) throw new Error(noApply);
    // 프로젝트 이름은 플래그도 플래그의 값도 아닌 첫 인자다 (`fleet slices` 와 같은 자리).
    const arg = positionalArg(process.argv.slice(4));
    const num = (flag) => {
      const v = argValues(flag)[0];
      if (v !== undefined && (!/^\d+$/.test(v) || Number(v) < 0)) throw new Error(flag + ' 는 0 이상의 수여야 합니다');
      return v === undefined ? undefined : Number(v);
    };
    const r = await run(arg, num('--days'), num('--max'));
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    process.stdout.write(render(r));
  },

  // 한도 초기화 뒤 지정 터미널들을 깨운다
  async wake() {
    const at = parseWakeAt(argValues('--at')[0]);
    await wake({
      at,
      terminals: argValues('--terminal'),
      text: argValues('--text')[0] || WAKE_TEXT,
      dryRun: process.argv.includes('--dry-run'),
      json: process.argv.includes('--json'),
    });
  },

  /**
   * 헤드리스 워커의 한 턴 (`worker --agent codex --slice 6`).
   *
   * 파견이 터미널에 이 명령을 띄우면, 래퍼가 지시 문장을 만들어 에이전트를 명령줄로 부르고
   * 프로세스가 끝나면 `CMDS.stop` 을 그대로 부른다 — TUI 워커의 `Stop` 훅과 같은 자리다.
   * 여기가 `worker.mjs`(hooks 까지만 안다)와 `fleet`(회차 트리거)을 잇는 지점이다.
   *
   * 종료 코드는 에이전트 것을 그대로 돌려준다 — 아래 실행부가 이 반환값으로 끝난다.
   */
  // 세션이 턴 끝에 복귀 카드를 떨구는 명령 (슬라이스 45). `~/orca/CLAUDE.md` 의 `node -e` 조각은
  // `CLAUDE_CODE_SESSION_ID` 만 읽어 Codex 세션에서는 `undefined.json` 고아 카드가 되거나 거부된다 —
  // 여기서는 `sessionIdFromEnv` 가 세션 종류에 맞는 키를 고른다. 카드는 `--json '{…}'` 또는 stdin.
  async card() {
    const raw = argValues('--json')[0] ?? readStdinText();
    let card;
    try {
      card = JSON.parse(raw);
    } catch (e) {
      throw new Error('카드 JSON 을 못 읽었다 (--json 또는 stdin): ' + clean(e.message, 120));
    }
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('카드는 {now, wait, next, task} 객체여야 한다');
    const unknown = Object.keys(card).filter((k) => !CARD_FIELDS.has(k));
    if (unknown.length) throw new Error('모르는 카드 필드: ' + unknown.join(', ') + ' (허용: ' + [...CARD_FIELDS].join(', ') + ')');
    if (typeof card.now !== 'string' || !card.now.trim()) throw new Error('카드 now 는 빈 문자열일 수 없다');
    for (const k of ['wait', 'next', 'task']) if (card[k] !== undefined && typeof card[k] !== 'string') throw new Error('카드 ' + k + ' 는 문자열이어야 한다');
    const sid = sessionIdFromEnv();
    if (!sid) throw new Error('세션 id 를 환경에서 못 골랐다 (CLAUDE_CODE_SESSION_ID · CODEX_THREAD_ID · CODEX_SESSION_ID 모두 없음)');
    writeDrop(sid.id, card);
    if (process.argv.includes('--json')) return; // 조용히. 훅 안·규칙 조각에서 부르는 자리다
    console.log('카드 저장: ' + sid.id + (sid.agent ? ' (' + sid.agent + ', ' + sid.source + ')' : ''));
  },

  async worker() {
    const agent = argValues('--agent')[0];
    if (!agent) throw new Error('사용법: node sp-sync.mjs worker --agent <이름> --slice N [--prompt <문장>] [--hard] [--force]');
    return await runWorker(
      {
        agent,
        slice: argValues('--slice')[0] || null,
        prompt: argValues('--prompt')[0] || null,
        // `[어려움]` 슬라이스. 프로필의 `{hard}` 자리가 이때만 펼쳐진다.
        hard: process.argv.includes('--hard'),
        // 같은 워크트리에 열린 래퍼 턴이 있어도 띄운다 (`openWrapperTurn`). 사람이 알고 쓰는 자리다.
        force: process.argv.includes('--force'),
        cwd: process.cwd(),
      },
      { onTurnEnd: (h) => CMDS.stop(h) }
    );
  },

  // post-checkout 훅 / 안전망: 훅이 없는 워크트리에만 설치
  async sweep() {
    const root = repoRoot(process.cwd());
    const added = sweepWorktrees(root);
    if (process.stdout.isTTY) {
      console.log(added.length ? '설치: ' + added.join(', ') : '모든 워크트리에 이미 설치됨');
    }
  },
};


// 테스트가 쓰는 공개 이름 — 모듈에서 그대로 재수출한다 (`../sp-sync.mjs` 에서 import).
export { planCounts, repoRoot } from './lib/common.mjs';
export { renderBoard, cardUnder, linkedWorktreeCopy, writeAgentsMd, agentsMdState, orphanDrops, writeDrop } from './lib/hooks.mjs';
export { parseWakeAt, checkSubmitted, hasClaudePrompt, sendInstruction, readScreen, screenUnavailable, sleepingAgents, isGoneError, wakeOne } from './lib/wake.mjs';
export { allLimits, claudeLimit, codexLimit, lastRateLimits, limitOf, limitText, modelLimit, newestRollouts, stillReached, toMs, windowReached } from './lib/limits.mjs';
export { EXIT_BUSY, EXIT_NOSESSION, agentProfile, buildAgentArgs, openWrapperTurn, quoteWinArg, resolveBin, runWorker, sessionSaved, spawnSpec, workerSessionId } from './lib/worker.mjs';
export { reviewVerdict, driftVerdict, todayVerdict, pickToday, workerTaskIds, daysBetween, noteCommits, applyTargets, applyValues, positionalArg, tasksAgenda, tasksReview, tasksDrift, tasksToday, lastCommitOf, planPhaseOf } from './lib/tasks.mjs';
export { RESOURCE_DEPS, RESOURCES_FILE, held, heldText, isOwn, release, reserve, sweep } from './lib/resources.mjs';
export { RESUME_DEPS, RESUME_IO, bump as bumpResume, drop as dropResume, entries as resumeEntries, noteStuck, planDoneAt, resumeLine, resumeOne, resumePlan, resumeRowText } from './lib/resume.mjs';
export { renderTasksReview, renderTasksDrift, renderTasksToday, renderTasksAgenda } from './lib/tasks-render.mjs';
export { RESUME_RUN_DEPS, cycleResume, stuckWorkspaces, isNoDispatch, globalActiveCount, sinceText, cycleProject, limitBlock, limitStartHold, limitStuckOf, cycleHandoff, cycleHandoffPlan, handoffRowText, renderLimits, turnStateFor, cycleTriggerCheck, cycleRunning, cycleRunningFor, cycleResultFiles, acquireTriggerLock, releaseTriggerLock, fleetTrigger, fleetPrecheck, precheckVerdict, precheckText, seenFileFor, saveSeen, cycleChildEnv, noteInReport, RECOVERY_FAILED_TYPES, triggerLaunchPlan, renderTrigger, outputQuiet, workerCommand, workerPromptCommand, unpushedAhead, syncMain, baseBranchOf, conflictText, waitForPrompt, fleetEta, fleetGap, fleetGapOf, gapText, planStageNumber, linkTaskToStage, sortFleetRows, renderFleet, parsePlanSlices, sliceNumberOf, renderSlices, strayBlock, planDirtyBlock, dispatchPlan, sliceCommandFor, renderDispatch, handoffPrompt, handoffPlan, handoffOne, fleetHandoff, renderHandoff, landCheck, landOne, mergeGate, runCheck, LAND_DEPS, renderLand, renderCycleReport, decisionItems, cycleProjects, splitPaused, conflictLoop, resolveProjectRoot, projectHere, nextProjectAgent, undispatched, undispatchedCheck, selfHash, redispatchOne, closeExtraTabs, projectWorkspaces, sleepingOf, WORKSPACE_IO } from './lib/fleet.mjs';

// ---------- 실행 ----------
// 테스트가 import 하면 여기서 멈춘다. 직접 실행했을 때만 명령을 돈다.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
// 재귀 가드: 판정용 claude -p가 띄우는 세션도 훅을 발동시킨다. 그 자식들이 다시
// sp-sync를 부르면 무한 루프가 되므로, 표식이 있으면 아무것도 하지 않고 끝낸다.
if (process.env.SP_SYNC_INTERNAL) process.exit(0);

const cmd = process.argv[2];
ensureDir();
if (!CMDS[cmd]) {
  console.log('사용법: node sp-sync.mjs <prompt|todos|stop|commit|sweep|doctor [경로]|install [경로]|forget [프로젝트명]|fleet status [--json]|fleet slices <프로젝트> [--json]|fleet dispatch <프로젝트> [--max N] [--start-pct N] [--dry-run]|fleet handoff <프로젝트> <슬라이스> --to <에이전트> [--dry-run] [--prompt <문장>]|fleet land <프로젝트> [--dry-run] [--ignore-wait] [--quiet-ms N]|fleet cycle [--project 이름]... [--dry-run]|fleet precheck [--project 이름]... [--dry-run]|fleet trigger [--project 이름]|fleet check|tasks agenda [<프로젝트>] [--max N] [--days N]|tasks review [<프로젝트>] [--days N] [--apply <id>...]|tasks drift [<프로젝트>] [--days N]|tasks today [<프로젝트>] [--max N] [--days N] [--apply <id>...]|card --json <{now,wait,next,task}> (또는 stdin)|worker --agent <이름> --slice N [--prompt <문장>] [--hard] [--force]|wake --at <시각> --terminal <핸들>... [--text ..] [--dry-run]>');
  process.exit(cmd ? 1 : 0);
}
// Claude Code 훅으로 불린 명령은 SP 응답을 기다리지 않고 백그라운드로 넘긴다.
// (훅이 오래 걸리면 Claude Code가 타임아웃으로 잘라버린다)
const DEFERRABLE = new Set(['prompt', 'todos', 'stop', 'commit']);
if (DEFERRABLE.has(cmd) && !process.argv.includes('--bg')) {
  try {
    handoffToBackground(cmd, cmd === 'commit' ? {} : undefined);
  } catch (e) {
    log('handoff 실패 ' + cmd + ': ' + e.message);
  }
  process.exit(0);
}

const isDiag = cmd === 'doctor' || cmd === 'install' || cmd === 'fleet' || cmd === 'wake' || cmd === 'tasks' || cmd === 'worker' || cmd === 'card';
const startedAt = Date.now();
let failed = false;
// 에이전트의 종료 코드를 그대로 물려받을 명령(`worker`)이 쓰는 자리. 훅 명령은 늘 0 이다.
let passthrough = null;
CMDS[cmd]()
  .then((r) => {
    if (typeof r === 'number') passthrough = r;
  })
  .catch((e) => {
    failed = true;
    log('ERR ' + cmd + ': ' + e.message);
    if (isDiag) console.error('오류: ' + e.message);
  })
  .finally(() => {
    const ms = Date.now() - startedAt;
    if (!isDiag && ms > 3000) log('SLOW ' + cmd + ': ' + ms + 'ms');
    // 여기서 process.exit()를 바로 부르면, 판정에 쓴 claude 자식 프로세스의
    // 핸들이 아직 닫히는 중이라 Windows libuv 가 어서션으로 죽는다.
    // exitCode 만 세우고 이벤트 루프가 스스로 끝나게 둔다.
    // 훅으로 불린 명령은 실패해도 0으로 끝낸다 — 훅 실패는 Claude Code 쪽을 시끄럽게 한다.
    // 진단 명령(install/doctor)만 실패를 알린다. Orca 설정 스크립트가 이걸 보고 멈춘다.
    const code = passthrough !== null ? passthrough : failed && isDiag ? 1 : 0;
    process.exitCode = code;
    const bail = setTimeout(() => process.exit(code), 3000);
    bail.unref();
  });
}
