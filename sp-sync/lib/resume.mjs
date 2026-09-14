/**
 * resume — 한도 해제 뒤 **같은 워크스페이스**를 자동으로 다시 굴린다 (슬라이스 43). common·wake·limits 에만 의존한다.
 *
 * **왜 따로 두나.** 한도에 막힌 워크스페이스는 인계(`cycleHandoffPlan`)가 상대 에이전트에게 넘기지만, 넘기지
 * 못하는 길이 넷이다 — 초기화 임박이라 대기, 상대도 막힘, 상대가 없음(`fleetFallback` 에 없거나 비어 있음),
 * 인계 불가(창이 닫힘·턴이 열린 채). 그 넷은 회차가 "다음에 다시 본다" 고만 하고 끝나는데, 정작 초기화가 지나면
 * `limitStuckOf` 가 null 이라 그 워크스페이스는 "유휴인데 미체크" 로만 보이고 아무도 손대지 않는다 — 두 에이전트가
 * 같이 막히면 그 프로젝트가 영영 멈춘다(9단계 결정, 2026-09-09). 그래서 **막혀 있는 동안** 항목을 적어 두고,
 * 초기화가 지난 뒤의 회차가 그 항목을 보고 같은 창을 깨운다.
 *
 * 저장소는 `~/.sp-sync/fleet-resume.<safeName(프로젝트)>.json`:
 *
 *   { "slice12": { "workspace": "C:/…/workspaces/SP-sync/slice12", "slice": 12, "agent": "claude",
 *                  "terminal": "term_…", "resetsAt": 1757…, "attempts": 0, "at": 1757…, "reason": "…" } }
 *
 * 키는 워크스페이스 이름(`sliceN`)이다. 시각은 전부 밀리초(`limits.mjs` 가 통일한 값 그대로).
 * 읽고-고치고-쓰기는 전용 락(`fleet-resume.lock/`) 안에서만 한다 — `fleet-resources.json` 과 같은 방식이다.
 *
 * 적는 자리와 지우는 자리:
 *  - 적기 — 회차의 인계 단계(`cycleHandoff`)가, 한도에 막혔는데 인계가 **실행되지 않은** 워크스페이스마다.
 *    이미 있으면 `resetsAt`·`reason` 만 갱신한다(`attempts` 는 이어진다).
 *  - 지우기 — 슬라이스 체크·워크스페이스 소멸·시도 소진·**인계 실행** 때. 인계 뒤에 남으면 상대 에이전트가
 *    도는 창에 옛 에이전트의 재개가 들어간다.
 *
 * 판정(`resumePlan`)은 부수효과가 없고 실행(`resumeOne`)이 따로다 — `dispatchPlan`·`handoffPlan` 과 같은 관례.
 * 재개는 인계가 아니다: `handoffPlan` 의 "이미 같은 에이전트" 거부는 그대로고, 재개는 그 거부에 걸리는 바로 그
 * 경우(같은 에이전트가 같은 창에서 이어감)를 맡는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, clean, isWaiting, log, normPath, parsePlanSlices, readJson, safeName, sliceInPlan, withDirLock, writeJson } from './common.mjs';
import { WAKE_TEXT, orcaJson, wakeOne } from './wake.mjs';
import { stillReached } from './limits.mjs';

const RESUME_LOCK = join(DIR, 'fleet-resume.lock');

/** 바깥과 닿는 자리. 테스트가 임시 폴더로 갈아 끼운다 — 실제 `~/.sp-sync` 를 건드리지 않고 항목을 확인하려고. */
const RESUME_DEPS = {
  file: (project) => join(DIR, 'fleet-resume.' + safeName(project) + '.json'),
  lock: () => RESUME_LOCK,
};

function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 항목 하나의 모양을 고정한다. 없는 칸은 null — 옛 파일의 빠진 칸이 `undefined` 로 새지 않게. */
function shapeEntry(name, v) {
  if (!v || typeof v !== 'object') return null;
  return {
    name,
    workspace: v.workspace || null,
    slice: v.slice ?? null,
    agent: v.agent || 'claude',
    terminal: v.terminal || null,
    resetsAt: v.resetsAt || null,
    attempts: Number.isFinite(Number(v.attempts)) ? Number(v.attempts) : 0,
    at: v.at || null,
    reason: v.reason || '',
  };
}

/** 저장소를 읽는다. 깨졌거나 없으면 빈 표 — 항목을 못 읽는 것은 "재개할 것이 없다" 로 떨어진다. */
function readAll(project, deps = RESUME_DEPS) {
  const raw = readJson(deps.file(project), null);
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const e = shapeEntry(k, v);
    if (e) out[k] = e;
  }
  return out;
}

/**
 * 저장소를 쓴다. **던지지 않는다** — 회차 한가운데서 불리므로 파일 하나를 못 썼다고 회차가 죽으면 안 된다.
 * 실패는 로그로 남기고 다음 회차가 다시 적는다(막혀 있는 동안은 매 회차 적히므로 잃는 것이 없다).
 */
function save(project, table, deps) {
  try {
    const out = {};
    for (const [k, e] of Object.entries(table)) {
      const { name, ...rest } = e;
      out[k] = rest;
    }
    writeJson(deps.file(project), out);
    return true;
  } catch (e) {
    log('fleet-resume 저장 실패: ' + (e.code || e.message));
    return false;
  }
}

/** 그 프로젝트의 재개 항목 전부. **락을 안 잡는다** — 판정용 읽기라, 그 사이에 바뀌면 다음 회차가 본다. */
function entries(project, deps = RESUME_DEPS) {
  return Object.values(readAll(project, deps));
}

/**
 * 막힌 워크스페이스를 적는다(있으면 갱신). 돌려주는 것은 저장된 항목이다.
 *
 * 갱신은 `resetsAt`·`reason`·`terminal`·`agent` 만이다 — `attempts`·`at` 은 시도의 기록이라 막힘이 이어진다고
 * 되돌리지 않는다. 그래야 "두 번 깨웠는데 또 막혔다" 가 세 번째 시도로 이어지지 않고 사람에게 간다.
 */
function noteStuck(project, e, deps = RESUME_DEPS) {
  const name = e.name || (e.slice != null ? 'slice' + e.slice : null);
  if (!name || !e.workspace) return null;
  let saved = null;
  withDirLock(deps.lock(), () => {
    const table = readAll(project, deps);
    const prev = table[name];
    saved = shapeEntry(name, {
      ...(prev || { attempts: 0, at: e.at || Date.now() }),
      workspace: e.workspace,
      slice: e.slice ?? prev?.slice ?? null,
      agent: e.agent || prev?.agent || 'claude',
      terminal: e.terminal || prev?.terminal || null,
      resetsAt: e.resetsAt ?? prev?.resetsAt ?? null,
      reason: e.reason || prev?.reason || '',
    });
    table[name] = saved;
    save(project, table, deps);
  });
  return saved;
}

/** 시도 하나를 센다 — `attempts + 1`, `at` 은 지금. 항목이 없으면 아무것도 안 한다(그 사이 지워진 것). */
function bump(project, name, { now = Date.now() } = {}, deps = RESUME_DEPS) {
  let saved = null;
  withDirLock(deps.lock(), () => {
    const table = readAll(project, deps);
    if (!table[name]) return;
    table[name] = { ...table[name], attempts: table[name].attempts + 1, at: now };
    saved = table[name];
    save(project, table, deps);
  });
  return saved;
}

/** 항목을 지운다. 있었으면 true. */
function drop(project, name, deps = RESUME_DEPS) {
  let had = false;
  withDirLock(deps.lock(), () => {
    const table = readAll(project, deps);
    if (!(name in table)) return;
    had = true;
    delete table[name];
    save(project, table, deps);
  });
  return had;
}

/** 워크스페이스 `PLAN.md` 에서 그 번호가 체크됐는가. 파일이 없거나 번호가 없으면 null(모름). */
function planDoneAt(path, n) {
  const f = join(path || '', 'PLAN.md');
  if (!path || !existsSync(f)) return null;
  try {
    const s = sliceInPlan(parsePlanSlices(readFileSync(f, 'utf8')), n);
    return s ? !!s.done : null;
  } catch {
    return null;
  }
}

/**
 * 재개 판정. **부수효과 없음** — dry-run 과 실제 회차가 같은 답을 쓴다.
 *
 * `ctx`:
 *   now         판정 시각
 *   limits      `allLimits()` — 에이전트별 지금 한도. 모르면(null) 여유로 본다("모르면 막지 않는다")
 *   workspaces  `projectWorkspaces()` — 창·턴 기록. 항목의 `workspace` 와 경로로 맞춘다
 *   slices      본체 PLAN.md 의 슬라이스(선택) — 본체에서 이미 체크됐으면(머지됨) 항목은 지운다
 *   cards       `normPath(워크스페이스)` → 마지막 복귀 카드. `wait` 가 차 있으면 사람이 답할 차례라 깨우지 않는다
 *   idle        `(handle) => boolean` — TUI 창이 지금 유휴인가(`tui-idle`). 헤드리스는 턴 기록으로 본다
 *   live        살아 있는 창 핸들 집합(선택). 없으면 그 워크스페이스의 창 목록이 곧 살아 있는 것이다
 *   sliceDone   `(path, n) => boolean|null` — 워크스페이스 PLAN.md 체크 여부. 기본은 파일을 읽는다
 *   max         시도 상한(`fleetResumeMax`)
 *
 * 갈래는 다섯이다:
 *   drop       항목을 지운다 — 체크됨·워크스페이스 없음
 *   exhausted  시도 소진 — 결정 항목("사람이 볼 것"), 항목은 지운다
 *   wait       아직 아니다 — 초기화 전·한도 여전·작업 중·카드 wait. 항목은 남긴다
 *   blocked    깨울 수 없다 — 창이 없음(닫혔거나 잠듦). 항목은 남기고 사람에게 알린다
 *   resume     깨운다
 */
function resumePlan(list, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const max = Math.max(1, Number(ctx.max) || 2);
  const done = ctx.sliceDone || planDoneAt;
  const rows = [];
  for (const e of list || []) {
    const row = { ...e, number: e.slice, path: e.workspace };
    const at = (action, reason, extra = {}) => rows.push({ ...row, ...extra, action, reason });
    const w = (ctx.workspaces || []).find((x) => normPath(x.path) === normPath(e.workspace || ''));
    // 본체에서 체크됐으면 머지된 것이다 — 워크스페이스가 아직 있어도(착륙 전 정리) 재개할 일이 없다.
    const main = (ctx.slices || []).find((s) => s.number === e.slice);
    if (main?.done) {
      at('drop', e.slice + '번이 본체 PLAN.md 에서 체크됨');
      continue;
    }
    if (!w) {
      at('drop', '워크스페이스가 없음');
      continue;
    }
    if (done(w.path, e.slice) === true) {
      at('drop', e.slice + '번이 워크스페이스 PLAN.md 에서 체크됨');
      continue;
    }
    if (e.attempts >= max) {
      at('exhausted', '재개 ' + e.attempts + '회 실패 — 사람이 볼 것' + (e.reason ? ' (' + clean(e.reason, 80) + ')' : ''));
      continue;
    }
    if (e.resetsAt && e.resetsAt > now) {
      at('wait', '초기화 전 (' + hhmm(e.resetsAt) + ')');
      continue;
    }
    const l = (ctx.limits || {})[e.agent];
    if (l && stillReached(l, now)) {
      at('wait', e.agent + ' 한도 여전히 참' + (l.resetsAt ? ' (초기화 ' + hhmm(l.resetsAt) + ')' : ''));
      continue;
    }
    const card = (ctx.cards || {})[normPath(w.path)];
    if (card && isWaiting(card.wait)) {
      at('wait', '워커가 결정을 기다림: ' + clean(card.wait, 80));
      continue;
    }
    const turn = w.turn || { known: false };
    if (e.agent !== 'claude') {
      // 헤드리스 — 창이 아니라 턴 기록이 유휴의 원천이다 (`landCheck` 와 같은 잣대). 열린 턴이면 작업 중.
      if (turn.active) at('wait', e.agent + ' 래퍼 턴 진행 중');
      else if (turn.stale) at('blocked', e.agent + ' 래퍼 턴이 안 끝난 채 오래됨 — 사람이 볼 것');
      else at('resume', e.agent + ' 래퍼 새 턴 (' + (e.attempts + 1) + '/' + max + ')');
      continue;
    }
    // TUI — 적어 둔 창이 살아 있으면 그 창, 아니면 그 워크스페이스의 살아 있는 창.
    const alive = (h) => !!h && (ctx.live ? ctx.live.has(h) : (w.terminals || []).includes(h));
    const handle = alive(e.terminal) ? e.terminal : (w.terminals || []).find(alive) || null;
    if (!handle) {
      at('blocked', '창이 없음 — 닫혔거나 잠듦, CLI 로 못 깨움 (Orca 에서 탭을 열어야 함)');
      continue;
    }
    if (turn.known && turn.active) {
      at('wait', '턴 진행 중', { handle });
      continue;
    }
    if (ctx.idle && !ctx.idle(handle)) {
      at('wait', '작업 중 (TUI 유휴 아님)', { handle });
      continue;
    }
    at('resume', '"' + WAKE_TEXT + '" 전송 (' + (e.attempts + 1) + '/' + max + ')', { handle });
  }
  return rows;
}

/** 재개 실행의 손. fleet 가 헤드리스의 래퍼 명령(`workerCommand`)과 터미널 생성을 얹어 준다. */
const RESUME_IO = {
  wake: (handle, text) => wakeOne(handle, text),
  createTerminal: (path, title, command, ms) => {
    const t = orcaJson(['terminal', 'create', '--worktree', 'path:' + path, '--title', title, '--command', command], ms);
    return t?.terminal?.handle || t?.handle || null;
  },
  closeExtraTabs: null,
};

/**
 * 판정 한 줄을 실제로 깨운다. 던지지 않는다 — 한 워크스페이스의 실패가 다음 것을 막으면 안 된다.
 * TUI 는 `wakeOne(handle, WAKE_TEXT)` — `wake` 명령과 **같은 길**이다(2026-09-09 실측, `notes/2026-09-09-wake-실측.md`).
 * 헤드리스는 파견과 같은 래퍼 명령을 같은 폴더에 새 창으로 띄운다(`io.command` — fleet 의 `workerCommand`).
 */
async function resumeOne(row, io = RESUME_IO) {
  const headless = row.agent !== 'claude';
  if (headless) {
    const command = typeof io.command === 'function' ? io.command(row) : io.command;
    if (!command) return { ok: false, stage: 'command', detail: '래퍼 명령이 없음' };
    let handle;
    try {
      handle = io.createTerminal(row.path, row.name + ' 재개 ' + row.agent, command, io.createMs);
    } catch (e) {
      return { ok: false, stage: 'terminal', command, detail: clean(e.message, 300) };
    }
    if (!handle) return { ok: false, stage: 'terminal', command, detail: '터미널 핸들을 못 받음' };
    const tabs = io.closeExtraTabs ? io.closeExtraTabs(row.path, handle) : null;
    return { ok: true, stage: 'create', handle, command, tabs, submit: '래퍼 실행 (' + row.agent + ')' };
  }
  const sent = await io.wake(row.handle, WAKE_TEXT);
  return {
    ok: sent.result === 'submitted',
    stage: 'send',
    handle: row.handle,
    text: WAKE_TEXT,
    submitted: sent.result,
    submit: sent.result === 'submitted' ? '제출 확인' : '미제출: ' + sent.result,
    detail: sent.detail || '',
  };
}

/** 회차 보고 한 칸. 갈래가 첫 낱말로 갈린다. */
function resumeRowText(r) {
  if (r.action === 'resume') {
    const res = r.result ? ' · ' + (r.result.ok ? r.result.submit : r.result.stage + ' 실패: ' + (r.result.detail || '')) : '';
    return '재개 — ' + r.reason + res;
  }
  if (r.action === 'exhausted') return '재개 포기 — ' + r.reason;
  if (r.action === 'blocked') return '재개 불가 — ' + r.reason;
  if (r.action === 'drop') return '재개 항목 삭제 — ' + r.reason;
  return '재개 대기 — ' + r.reason;
}

/** `fleet status` 근거 줄 — `재개 예약 slice12 14:30 (1/2)`. */
function resumeLine(e, max = 2) {
  return '재개 예약 ' + e.name + (e.resetsAt ? ' ' + hhmm(e.resetsAt) : '') + ' (' + e.attempts + '/' + max + ')';
}

export { RESUME_DEPS, RESUME_IO, bump, drop, entries, noteStuck, planDoneAt, resumeLine, resumeOne, resumePlan, resumeRowText };
