/**
 * wake — Orca 터미널 입출력(`orca terminal …` 화면 읽기·지시 전송·제출 확인)과, 한도 초기화 뒤에
 * "이어서 진행해"를 보내는 `wake` 명령. 공용 모듈에만 의존한다. fleet 의 파견·착륙이 여기의
 * 터미널 헬퍼를 쓴다.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config, sleep, clean, log, HOME, normPath } from './common.mjs';

// ---------- 절전(Agent sleep) ----------
/**
 * Orca 실험 기능 "Agent sleep"(설정 `experimentalAgentHibernation`)이 잠재운 에이전트 창을 찾는다 (슬라이스 28,
 * `notes/2026-09-07-agent-hibernation-실측.md`).
 *
 * 잠든 창은 **PTY 가 죽고 목록에서 사라진다** — `terminal list` 에 안 나오고 `worktree ps` 는 `inactive` ·
 * `liveTerminalCount 0` 으로, 창을 닫은 워크스페이스와 CLI 로는 구별이 안 된다. 유일한 흔적이 앱 상태 파일
 * `orca-data.json` 의 `workspaceSession.sleepingAgentSessionsByPaneKey` 다: 잠들 때 세션(`providerSession` —
 * Claude 세션 id)을 `origin: 'worktree-sleep'` 으로 캡처해 두고, 사람이 그 탭을 열면 `claude --resume` 으로
 * 되살린다. 살아 있는 창도 같은 표에 `origin: 'live'` 로 들어 있으므로 **`live` 가 아닌 것만** 잠든 것이다.
 *
 * **읽기만 한다** — 앱이 이 파일을 통째로 메모리에 들고 있다가 덮어쓴다(`CLAUDE.md`). 못 읽으면 빈 표 —
 * 절전을 안 켠 환경·옛 Orca 에서는 그게 정상이고, 호출부는 "잠듦"을 모르면 예전 판정("창이 없음")으로 돈다.
 *
 * 돌려주는 것: 워크트리 경로(`normPath`) → 잠든 창 목록 `[{ agent, state, capturedAt, sessionId, origin }]`.
 */
const ORCA_DATA_FILE = join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'orca', 'profiles', 'local-default', 'orca-data.json');

function sleepingAgents(file = config().orcaDataFile || ORCA_DATA_FILE) {
  const out = new Map();
  let table;
  try {
    table = JSON.parse(readFileSync(file, 'utf8'))?.workspaceSession?.sleepingAgentSessionsByPaneKey;
  } catch {
    return out;
  }
  for (const e of Object.values(table || {})) {
    if (!e || e.origin === 'live') continue;
    // worktreeId 는 `<repo id>::<경로>` 다.
    const path = String(e.worktreeId || '').split('::').slice(1).join('::');
    if (!path) continue;
    const k = normPath(path);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ agent: e.agent || null, state: e.state || null, capturedAt: e.capturedAt || null, sessionId: e.providerSession?.id || null, origin: e.origin || null });
  }
  return out;
}

/** `terminal send`/`switch` 가 잠든(또는 죽은) 창이라 거부한 것인가. 실측(2026-09-07): send 는 `terminal_not_writable`, switch 는 `terminal_exited`. */
const isGoneError = (msg) => /terminal_not_writable|terminal_exited|terminal_gone|terminal_handle_stale/.test(String(msg || ''));

// ---------- wake ----------
/**
 * 한도에 걸린 Orca 세션을 초기화 시각 **뒤에** 깨운다.
 *
 * Orca 임베디드 터미널의 Claude Code 는 한도 초기화 후 스스로 이어가지 않는다
 * (`coordinator/notes/auto-continue-experiment.md`). 그래서 초기화 시각에 맞춰 지정 터미널들에
 * "이어서 진행해"를 보낸다. **초기화 전에는 절대 보내지 않는다** — 문서상 대기 중에 들어온
 * 직접 프롬프트는 자동 대기의 취소 사유라, 일찍 보내면 깨우기는커녕 남은 가능성마저 끊는다.
 * 그래서 보내기 직전에 시계를 한 번 더 본다. 잠들었다 깬 프로세스가 setTimeout 을 일찍 끝내는
 * 경우를 막는 것이다.
 *
 * 보낸 뒤 화면을 읽어 입력창에 글이 남아 있지 않은지 확인한다. 작업 중인 세션에 보낸 send 는
 * 큐에 안 들어가고 튕기므로, "보냈다"와 "제출됐다"는 다른 사실이다.
 */
const WAKE_TEXT = '이어서 진행해';

/**
 * `--at` 문자열을 시각(ms)으로. 받는 꼴:
 *   HH:MM              오늘 그 시각. 이미 지났으면 내일 — 한도 초기화는 언제나 앞에 있다
 *   YYYY-MM-DDTHH:MM   그날 그 시각(로컬)
 *   +90m / +2h         지금부터
 *   now                지금 (이미 초기화가 지난 세션을 바로 깨울 때)
 */
function parseWakeAt(str, now = Date.now()) {
  const v = String(str || '').trim();
  if (!v) throw new Error('--at 이 없습니다 (HH:MM | YYYY-MM-DDTHH:MM | +90m | now)');
  if (v === 'now') return now;
  let m = v.match(/^\+(\d+)\s*([mh])$/i);
  if (m) return now + Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3600000 : 60000);
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(now);
    let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2]).getTime();
    if (t <= now) t += 86400000;
    return t;
  }
  throw new Error('--at 형식을 모릅니다: ' + v);
}

/**
 * 화면으로 제출 여부를 가른다. Claude Code 는 제출된 입력을 위 이력에 `❯ 글` 로 남기고,
 * 입력창은 구분선 사이의 **마지막** `❯` 줄이다.
 *   'submitted'  제출된 흔적이 있다 — 이력에 `❯ 그 글` 이 있거나 진행 표시가 있다
 *   'stuck'      그 글이 입력창(또는 Orca draft)에 남아 있다
 *   'unknown'    입력창을 못 찾았거나, 비어 있는데 제출 흔적이 없다
 *
 * **빈 입력창을 제출로 보지 않는다** (2026-08-30). 워크스페이스를 막 만든 창은 Orca 의
 * `Waiting for setup…` 화면이라 입력창 자체가 없고, 보낸 글은 Orca 입력창(draft)에 남아
 * 화면 어디에도 안 나온다. 옛 판정은 그 빈 화면을 `submitted` 로 읽어 미제출 6건을
 * "지시 보냄"으로 보고했다. 제출은 흔적으로만 인정한다.
 */
function hasProgress(arr) {
  return arr.some(
    (l) =>
      /^\s*●/.test(l) || // 응답 줄
      /esc to interrupt/i.test(l) || // 작업 중 안내
      /^\s*[·✢✳✻✽*∗✶]\s*\S.*…/.test(l) || // 스피너 ("· Combobulating… (6m 20s)")
      /[▓░█▒]\s*([1-9]\d*)%/.test(l) // 컨텍스트 > 0%
  );
}

/** 화면에 Claude 입력 프롬프트가 떴는가. Orca 의 `Waiting for setup…` 화면에는 없다. */
function hasClaudePrompt(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  return arr.some((l) => /^\s*❯/.test(l)) || arr.some((l) => /Claude Code v\d/.test(l));
}

function checkSubmitted(lines, text, draft) {
  const arr = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  const norm = (x) => String(x || '').replace(/\s+/g, '');
  const head = norm(text).slice(0, 10);
  // Orca 입력창(draft)에 남은 글은 화면에 안 보인다. 남아 있으면 그 자체가 미제출 신호다.
  if (head && norm(draft).includes(head)) return 'stuck';
  let last = -1;
  for (let i = 0; i < arr.length; i++) if (/^\s*[❯>]/.test(arr[i])) last = i;
  if (last < 0) return 'unknown';
  let box = arr[last].replace(/^\s*[❯>]\s?/, '');
  for (let i = last + 1; i < arr.length && /^\s+\S/.test(arr[i]) && !/^[─-]{5,}/.test(arr[i]); i++) box += ' ' + arr[i].trim();
  box = box.trim();
  if (head && norm(box).includes(head)) return 'stuck';
  // 이력에 남은 `❯ 그 글` 이 가장 빠르고 확실한 제출 증거다 (입력창 줄은 뺀다).
  for (let i = 0; i < last; i++) if (/^\s*[❯>]/.test(arr[i]) && norm(arr[i]).includes(head)) return 'submitted';
  return hasProgress(arr) ? 'submitted' : 'unknown';
}

function orcaJson(args, timeout = 15000) {
  const out = execFileSync(config().orcaBin, [...args, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout,
  });
  const j = JSON.parse(out);
  if (!j || j.ok === false) throw new Error((j && (j.error?.message || j.error)) || 'orca ' + args.join(' ') + ' 실패');
  return j.result;
}

/** `readScreen` 이 두드리는 것들. 테스트가 갈아 끼운다 — 창 없이 폴백 처리를 확인하려고. */
const READ_IO = { json: orcaJson, log };

/**
 * 지금 화면과 Orca 입력창(draft). draft 는 화면(tail)에 안 들어간다 — 따로 받아야 보인다.
 *
 * **`source` 를 같이 돌린다** (슬라이스 27). `--screen` 은 렌더된 화면을 달라는 뜻이지만 Orca 가
 * 못 그리면 조용히 **누적 스트림**으로 떨어지고(`source: 'screen-unavailable'`), 그 스트림에는
 * 재그리기가 글자 단위로 겹쳐 쌓인다 — `clear` 한 번이 `cclclecleaclear` 로 온다(`terminal read --help`).
 * 그 문자열이 그대로 `hasClaudePrompt`·`checkSubmitted` 에 들어가면 판정이 조용히 어긋나므로,
 * 폴백을 로그에 남기고 호출부가 "화면을 못 읽었다"를 **모른 채 판정하지 않게** 값으로 실어 보낸다.
 * `source` 가 없는 것은 이 필드가 없던 옛 런타임이다 — 그건 폴백으로 보지 않는다(`null`).
 */
function readScreen(handle, io = READ_IO) {
  const t = io.json(['terminal', 'read', '--terminal', handle, '--screen'])?.terminal || {};
  const source = t.source || null;
  if (source === 'screen-unavailable') io.log('readScreen ' + handle + ' screen-unavailable — 누적 스트림으로 폴백');
  return { lines: t.tail || [], draft: t.draft || '', source };
}

/** 화면을 못 읽고 스트림으로 떨어졌는가. 그 판정은 어디서든 같은 한 줄이어야 한다. */
const screenUnavailable = (source) => source === 'screen-unavailable';

/**
 * 터미널을 두드리는 동작들. 테스트가 갈아 끼운다 — 판정과 재전송 횟수를 창 없이 확인하려고.
 * `close` 는 **`--tab`** 이다: 판(pane)만 닫으면 빈 탭이 남아 탭 수가 그대로다.
 */
const TERMINAL_IO = {
  send: (handle, text, enter) => orcaJson(['terminal', 'send', '--terminal', handle, ...(enter ? ['--enter'] : []), '--text', text]),
  read: (handle) => readScreen(handle),
  list: () => orcaJson(['terminal', 'list']).terminals || [],
  // `--tab` 은 탭이 실제로 지워질 때까지 기다린다 — 15초로는 모자랄 수 있어 넉넉히 준다.
  close: (handle) => orcaJson(['terminal', 'close', '--terminal', handle, '--tab'], 30000),
  sleep: (ms) => sleep(ms),
};

/**
 * 한 터미널에 보내고 화면으로 제출을 확인한다. 던지지 않는다 — 한 창의 실패가 다음 창을 막으면 안 된다.
 * 확인은 한 번이 아니라 짧게 여러 번 본다 — 제출 직후 흔적(`❯ 그 글`·스피너)이 뜨는 데 시간이 걸린다.
 */
async function wakeOne(handle, text, io = TERMINAL_IO) {
  try {
    io.send(handle, text, true);
  } catch (e) {
    // 잠든 창(Agent sleep)은 PTY 가 죽어 `terminal_not_writable` 로 거부된다. CLI 로는 못 깨운다 — 사람이
    // Orca 에서 그 탭을 열어야 `claude --resume` 이 돈다 (슬라이스 28). 그 대처가 사유에 드러나야 한다.
    const gone = isGoneError(e.message) ? ' — 잠들었거나 죽은 창, CLI 로 못 깨움 (Orca 에서 탭을 열어야 함)' : '';
    return { handle, sent: false, result: 'error', detail: clean(e.message, 200) + gone };
  }
  const c = config();
  let result = 'unknown';
  let detail = '';
  let source = null;
  for (let i = 0; i < c.fleetSubmitTries; i++) {
    // 화면이 갱신될 틈. 바로 읽으면 방금 친 글이 아직 입력창에 있다.
    await io.sleep(c.fleetSubmitWaitMs);
    let s;
    try {
      s = io.read(handle);
    } catch (e) {
      detail = clean(e.message, 200);
      continue;
    }
    detail = '';
    source = s.source || null;
    result = checkSubmitted(s.lines, text, s.draft);
    if (result === 'submitted' || result === 'stuck') break;
  }
  // 화면을 못 읽었으면 `unknown` 은 "제출 흔적이 없다"가 아니라 "볼 수가 없었다"다. 둘은 대처가
  // 다르므로(재전송할 일이 아니라 사람이 볼 일) 사유에 그대로 드러낸다.
  if (result === 'unknown' && screenUnavailable(source)) detail = detail || '화면을 못 읽음 (스트림 폴백)';
  return { handle, sent: true, result, detail, source };
}

/**
 * 파견 지시를 보내고, 제출이 확인 안 되면 **한 번만** 다시 보낸다 (coordinator 규칙 5).
 * 재전송 전에 입력창을 비운다 — 안 비우면 남아 있던 글에 이어 붙어 두 지시가 한 문장으로
 * 제출된다 (2026-08-30 slice10: `❯ PRD.md, … 커밋.git fetch 하고 …`).
 * `--enter` 만 따로 보내지 않는다 — 무엇이 제출될지 모르는 채로 Enter 를 치는 셈이라 금지다.
 */
async function sendInstruction(handle, text, io = TERMINAL_IO) {
  const first = await wakeOne(handle, text, io);
  if (!first.sent) return { ...first, submit: '전송 실패', resent: 0 };
  if (first.result === 'submitted') return { ...first, submit: '제출 확인', resent: 0 };
  try {
    // Ctrl+U — 입력창의 한 줄을 지운다. 빈 입력창에서는 아무 일도 안 한다.
    io.send(handle, '\u0015', false);
  } catch {}
  const second = await wakeOne(handle, text, io);
  return {
    ...second,
    resent: 1,
    submit: second.result === 'submitted' ? '재전송 1회' : '미제출(막힘): ' + second.result,
  };
}

function argValues(flag) {
  const out = [];
  const a = process.argv;
  for (let i = 3; i < a.length; i++) if (a[i] === flag && a[i + 1] !== undefined) out.push(a[++i]);
  return out;
}

async function wake({ at, terminals, text, dryRun, json }) {
  const say = (m) => {
    if (!json) console.log(m);
  };
  if (!terminals.length) throw new Error('--terminal 이 하나 이상 필요합니다');
  say('깨우기 예약: ' + new Date(at).toLocaleString('ko-KR', { hour12: false }) + ' · 창 ' + terminals.length + '개 · "' + text + '"');
  // 잠들었다 깨는 동안 setTimeout 이 실제 시간보다 짧게 끝날 수 있다. 1분 단위로 잘라 자고
  // 매번 시계를 다시 본다 — 초기화 전에 보내는 일은 없어야 한다.
  while (Date.now() < at) {
    const left = at - Date.now();
    if (!json && left > 60000 && Math.floor(left / 60000) % 30 === 0) say('  남은 시간 ' + Math.round(left / 60000) + '분');
    await sleep(Math.min(left, 60000));
  }
  if (Date.now() < at) throw new Error('시각 전에는 보내지 않습니다');
  if (dryRun) {
    const r = { at, sentAt: Date.now(), dryRun: true, results: terminals.map((handle) => ({ handle, sent: false, result: 'dry-run' })) };
    if (json) console.log(JSON.stringify(r, null, 2));
    else say('(dry-run) 보내지 않음: ' + terminals.join(', '));
    return r;
  }
  const results = [];
  for (const h of terminals) {
    const r = await wakeOne(h, text);
    results.push(r);
    say('  ' + h + '  ' + r.result + (r.detail ? '  ' + r.detail : ''));
    log('wake ' + h + ' ' + r.result);
  }
  const r = { at, sentAt: Date.now(), results };
  if (json) console.log(JSON.stringify(r, null, 2));
  return r;
}


export { ORCA_DATA_FILE, READ_IO, TERMINAL_IO, WAKE_TEXT, argValues, checkSubmitted, hasClaudePrompt, isGoneError, orcaJson, parseWakeAt, readScreen, screenUnavailable, sendInstruction, sleepingAgents, wake, wakeOne };
