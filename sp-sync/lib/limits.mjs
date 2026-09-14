/**
 * limits — 에이전트별 **사용 한도를 읽기만** 한다. 어느 쪽에도 쓰지 않고 네트워크도 안 탄다:
 * 두 CLI 가 이미 자기 캐시·기록에 적어 둔 값을 그대로 주워 같은 모양으로 돌려줄 뿐이다.
 *
 *   Claude   `~/.claude/usage-cache/data.json`  — 상태줄이 갱신하는 공유 캐시.
 *            `fiveHour`·`sevenDay` 와 **모델별 `scoped`**(Fable 은 7일 한도가 따로 있다 —
 *            `[어려움]` 이 Fable 로 뜨므로 5시간·7일이 여유여도 Fable 만 막힐 수 있다.
 *            2026-09-02 실물: 5시간 65%·7일 29%·Fable 45%).
 *   codex    `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — 턴마다 쌓이는 기록의
 *            `payload.rate_limits`(`primary`=5시간, `secondary`=7일; codex 0.152 실측).
 *
 * **codex 는 워크트리별로 찾지 않는다.** 한도는 계정 단위이고, 첫 요청부터 막힌 턴의 rollout 에는
 * `rate_limits` 가 아예 없어서 그 워크트리 기록만 보면 못 읽는다. 그래서 최근 rollout 몇 개를
 * 다 열어 **기록 시각이 가장 늦은** `rate_limits` 를 쓰고, 어느 워크트리 것인지(`session_meta.cwd`)는
 * 부가 정보로만 싣는다. 파일 이름·mtime 순으로 첫 파일에서 멈추면 안 된다 — 이름은 세션 시작
 * 시각이고, mtime 은 Windows 에서 codex 가 쓰는 동안 갱신되지 않는다(2026-09-03 Project A
 * slice8: 16:00 에 시작해 16:24 에 100%·막힘을 기록한 파일의 mtime 이 16:00:33 그대로였고, 16:10 에
 * 시작한 다른 세션의 83% 를 집어 "한도 막힘" 이 안 잡혔다).
 *
 * **모르면 `null` 이다 — 막지 않는다.** 값이 없거나 묵었으면(`limitStaleMin`) 부르는 쪽이
 * "여유" 로 본다. Claude 캐시는 Claude 세션의 상태줄이 갱신하므로 Claude 창이 하나도 없으면
 * 곧 묵는다 — 그걸 "한도 참" 으로 읽으면 자동 회차가 조용히 아무것도 안 하는 쪽으로 고장 난다.
 *
 * 의존은 `common` 하나뿐이고 `worker`(래퍼가 턴 끝에 세션 기록에 남긴다)와 `fleet`(착륙 사유·
 * `fleet status` 표)이 이걸 쓴다: `common ← limits ← worker/fleet`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, config } from './common.mjs';

const CLAUDE_USAGE_FILE = join(HOME, '.claude', 'usage-cache', 'data.json');
const CODEX_SESSIONS_DIR = join(HOME, '.codex', 'sessions');

/**
 * 시각을 **밀리초로 통일한다.** 원본이 섞여 있다 — Claude 캐시의 `resetsAt` 과 codex 의
 * `resets_at` 은 초(소수점까지 있다), `fetchedAt` 은 밀리초다. 안 맞추면 묵은 캐시 판정에서
 * 3만 배 차이가 조용히 섞여, "37년 전 값" 이나 "56년 뒤 초기화" 같은 것이 나온다.
 * 경계는 1e11 — 그보다 작으면 초다(밀리초로 1e11 은 1973년, 초로 1e11 은 5138년이라 겹치지 않는다).
 */
function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n < 1e11 ? n * 1000 : n);
}

/** `{ pct, resetsAt }` 한 칸. 퍼센트가 없으면 그 창은 없는 것이다. */
function win(pct, resetsAt) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return null;
  return { pct: p, resetsAt: toMs(resetsAt) };
}

/**
 * 그 창이 지금 차 있는가.
 *
 * **초기화 시각이 이미 지났으면 그 퍼센트는 옛것이다.** 기록된 값을 그대로 믿으면 한 번
 * 100% 를 찍은 창이 영영 "막힘" 으로 남아 그 에이전트에 다시는 파견이 안 간다 — 래퍼가
 * 세션 기록에 박아 둔 `limit` 은 그 턴이 끝난 순간의 사진이라 시간이 지나면 낡는다.
 */
function windowReached(w, now) {
  if (!w) return false;
  if (w.resetsAt && w.resetsAt <= now) return false;
  return w.pct >= 100;
}

/**
 * 두 형식이 합류하는 자리 — 여기서만 `{ pct5h, pct7d, resetsAt, reached, models }` 를 만든다.
 * `resetsAt` 은 **지금 막고 있는 창**의 초기화 시각이다(막힌 것이 없으면 5시간 창의 것) —
 * 착륙 사유 "한도 막힘 — 초기화 HH:MM" 이 그 한 값을 쓴다.
 */
function shape({ agent, source, fetchedAt, fiveHour, sevenDay, models = {}, reachedType = null, cwd = null }, now) {
  const scoped = Object.values(models);
  const blocking = [fiveHour, sevenDay, ...scoped].filter((w) => windowReached(w, now));
  const resets = blocking.map((w) => w.resetsAt).filter(Boolean);
  return {
    agent,
    source,
    fetchedAt,
    pct5h: fiveHour ? fiveHour.pct : null,
    pct7d: sevenDay ? sevenDay.pct : null,
    resetsAt: resets.length ? Math.min(...resets) : (fiveHour && fiveHour.resetsAt) || (sevenDay && sevenDay.resetsAt) || null,
    // `reachedType` 은 codex 가 직접 "막혔다" 고 적어 준 것이다(`rate_limit_reached_type`).
    // 퍼센트가 99 로 반올림돼 있어도 이 값이 있으면 막힌 것이다.
    reached: blocking.length > 0 || !!reachedType,
    reachedType,
    windows: { fiveHour, sevenDay },
    models,
    cwd,
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function staleMsOf(opts, cfg) {
  if (opts.staleMs != null) return Number(opts.staleMs);
  return Math.max(0, Number((cfg || config()).limitStaleMin) || 0) * 60000;
}

/**
 * Claude — 상태줄이 갱신하는 공유 캐시 하나를 읽는다. `fetchedAt`(밀리초)이 곧 신선도다.
 * `scoped` 의 모델 한도는 이름 그대로 `models` 에 싣는다 — Fable 만 막히는 경우가 실제로 있다.
 */
function claudeLimit(opts = {}) {
  const now = opts.now ?? Date.now();
  const raw = readJsonFile(opts.file || CLAUDE_USAGE_FILE);
  if (!raw || typeof raw !== 'object') return null;
  const fetchedAt = toMs(raw.fetchedAt);
  const stale = staleMsOf(opts);
  if (!fetchedAt || (stale && now - fetchedAt > stale)) return null;
  const fiveHour = win(raw.fiveHour?.percent, raw.fiveHour?.resetsAt);
  const sevenDay = win(raw.sevenDay?.percent, raw.sevenDay?.resetsAt);
  if (!fiveHour && !sevenDay) return null;
  const models = {};
  for (const m of Array.isArray(raw.scoped) ? raw.scoped : []) {
    const w = win(m?.percent, m?.resetsAt);
    if (m?.name && w) models[String(m.name)] = { ...w, active: m.active !== false };
  }
  return shape({ agent: 'claude', source: opts.file || CLAUDE_USAGE_FILE, fetchedAt, fiveHour, sevenDay, models }, now);
}

/**
 * 최신 rollout 파일 몇 개. 폴더가 `YYYY/MM/DD` 라 이름 내림차순이 곧 날짜 내림차순이고,
 * 그렇게 모은 뒤 **mtime 으로 다시 세운다** — 이름은 세션이 시작한 시각이라, 오래 도는 세션이
 * 방금 쓴 줄을 이름만으로는 못 찾는다. 다만 mtime 도 완전하지는 않으므로(머리 주석) 이 순서는
 * "어느 파일을 열어 볼까" 의 후보 고르기일 뿐이고, 최종 선택은 `codexLimit` 이 기록 시각으로 한다.
 */
function newestRollouts(dir, max) {
  const out = [];
  const walk = (d) => {
    if (out.length >= max) return;
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const f of ents.filter((e) => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)).map((e) => e.name).sort().reverse()) {
      if (out.length >= max) return;
      out.push(join(d, f));
    }
    for (const sub of ents.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()) {
      walk(join(d, sub));
      if (out.length >= max) return;
    }
  };
  walk(dir);
  const mt = (f) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  return out.sort((a, b) => mt(b) - mt(a));
}

/**
 * 그 rollout 의 **마지막 쓸모 있는** `rate_limits` 한 줄. 뒤에서부터 보므로 대개 몇 줄만 파싱한다.
 * 한 줄도 없으면 null — 첫 요청부터 막힌 턴이 그 모양이다(그래서 부르는 쪽이 다음 파일로 간다).
 *
 * "쓸모 있는" = `primary`·`secondary`·`rate_limit_reached_type` 중 하나라도 있는 것. codex 는 한도에
 * 막혀 죽기 직전에 `limit_id: "premium"` 인 크레딧 잔액 기록(`primary`·`secondary` 모두 null)을
 * 마지막으로 남긴다 — 그걸 그대로 받으면 창이 하나도 없어 null 로 떨어지고, 바로 윗줄의
 * 100% 기록이 묻힌다(2026-09-03 Project A slice8).
 */
function lastRateLimits(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s || !s.includes('"rate_limits"')) continue;
    try {
      const rec = JSON.parse(s);
      // codex 0.152 는 `payload.rate_limits`(`token_count` 이벤트) 다. `payload.info` 밑도 같이
      // 보는 것은 판올림에 한 칸 여유를 두는 것뿐이다 — 둘 다 없으면 그 줄은 그냥 넘어간다.
      const rl = rec?.payload?.rate_limits || rec?.payload?.info?.rate_limits;
      if (rl && (rl.primary || rl.secondary || rl.rate_limit_reached_type)) return { rl, at: Date.parse(rec.timestamp) || null };
    } catch {} // 반쯤 쓰인 마지막 줄 — 그 위 줄로 계속 간다
  }
  return null;
}

/** 그 rollout 이 어느 폴더에서 돈 턴인지. 첫 줄의 `session_meta` 에 있다 — 부가 정보다. */
function rolloutCwd(file) {
  try {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0];
    return JSON.parse(first)?.payload?.cwd || null;
  } catch {
    return null;
  }
}

/**
 * codex — 최신 rollout `limitCodexScan` 개를 **다 열어** 각 파일의 마지막 `rate_limits` 를 모으고,
 * 그중 **기록 시각(`timestamp`)이 가장 늦은** 것을 쓴다. 파일 순서로 첫 것에서 멈추지 않는다 —
 * 머리 주석의 slice8 사고처럼 나중에 시작한 짧은 세션이 먼저 시작한 긴 세션의 최신 기록을 가린다.
 * 기록에 시각이 없으면 mtime 으로 대신한다. `limitCodexScan` 개 안에 하나도 없으면 최근에 성공한
 * 턴 자체가 없다는 뜻이라 더 파고들어도 나오는 건 어차피 묵은 값이다.
 */
function codexLimit(opts = {}) {
  const now = opts.now ?? Date.now();
  const cfg = opts.config || config();
  const stale = staleMsOf(opts, cfg);
  const scan = Number(opts.scan ?? cfg.limitCodexScan) || 12;
  let best = null;
  for (const file of newestRollouts(opts.dir || CODEX_SESSIONS_DIR, scan)) {
    const hit = lastRateLimits(file);
    if (!hit) continue;
    const fetchedAt = hit.at || (() => {
      try {
        return statSync(file).mtimeMs;
      } catch {
        return null;
      }
    })();
    if (!fetchedAt) continue;
    if (!best || fetchedAt > best.fetchedAt) best = { file, hit, fetchedAt };
  }
  if (!best) return null;
  if (stale && now - best.fetchedAt > stale) return null; // 가장 늦은 기록이 묵었으면 나머지는 더 묵었다
  const { file, hit, fetchedAt } = best;
  const fiveHour = win(hit.rl.primary?.used_percent, hit.rl.primary?.resets_at);
  const sevenDay = win(hit.rl.secondary?.used_percent, hit.rl.secondary?.resets_at);
  if (!fiveHour && !sevenDay) return null;
  return shape(
    { agent: 'codex', source: file, fetchedAt, fiveHour, sevenDay, reachedType: hit.rl.rate_limit_reached_type || null, cwd: rolloutCwd(file) },
    now
  );
}

/**
 * **기록된** 한도가 지금도 차 있는가. `reached` 는 읽던 그 순간의 답이고, 세션 기록의 `limit`
 * 은 래퍼가 턴 끝에 박아 둔 사진이다 — 몇 시간 뒤 착륙이 그 값을 그대로 믿으면 이미 초기화된
 * 창 때문에 그 워크스페이스가 영영 "한도 막힘" 으로 남아 아무도 이어받지 못한다.
 */
function stillReached(l, now = Date.now()) {
  if (!l) return false;
  const ws = [l.windows?.fiveHour, l.windows?.sevenDay, ...Object.values(l.models || {})];
  if (ws.some((w) => windowReached(w, now))) return true;
  // codex 가 직접 "막혔다" 고 적어 준 턴(`rate_limit_reached_type`). 그 창이 아직이면 유효하다.
  return !!l.reachedType && (!l.resetsAt || l.resetsAt > now);
}

/**
 * 그 한도의 **모델별 칸** 하나. 없으면 null.
 *
 * 이름을 대소문자로 안 가리고 `opus[1m]` 같은 꼬리도 뗀다 — 설정의 모델 이름(`fleetHardModel`
 * 은 `fable`)과 캐시의 `scoped[].name`(`Fable`)이 같은 것을 다르게 적기 때문이다. 여기서 못
 * 맞추면 `[어려움]` 슬라이스의 Fable 한도가 조용히 `모름` 으로 떨어져 게이트가 없는 것과 같아진다.
 */
function modelLimit(l, name) {
  const key = String(name || '').split('[')[0].trim().toLowerCase();
  if (!key) return null;
  for (const [k, v] of Object.entries(l?.models || {})) if (k.toLowerCase() === key) return v;
  return null;
}

/**
 * 한도를 읽을 줄 아는 에이전트. 나머지(antigravity …)는 `limitOf` 가 null 을 돌려주고
 * 부르는 쪽은 "모름 = 여유" 로 본다 — 읽는 법을 붙이는 날 여기 한 줄이 는다.
 */
const LIMIT_READERS = { claude: claudeLimit, codex: codexLimit };
const LIMIT_AGENTS = Object.keys(LIMIT_READERS);

/** 그 에이전트의 한도, 모르면 null. */
function limitOf(agent, opts = {}) {
  const read = LIMIT_READERS[String(agent || '')];
  return read ? read(opts) : null;
}

/** 읽을 줄 아는 에이전트 전부. `fleet status` 요약이 쓴다. */
function allLimits(opts = {}) {
  const out = {};
  for (const a of LIMIT_AGENTS) out[a] = limitOf(a, opts);
  return out;
}

/** 표 한 칸. 모르면 `모름` — 빈 칸으로 두면 "0%" 로 읽힌다. */
function limitText(l) {
  if (!l) return '모름';
  const parts = [];
  if (l.pct5h != null) parts.push('5h ' + Math.round(l.pct5h) + '%');
  if (l.pct7d != null) parts.push('7d ' + Math.round(l.pct7d) + '%');
  for (const [name, m] of Object.entries(l.models || {})) parts.push(name + ' ' + Math.round(m.pct) + '%');
  return (l.reached ? '참 · ' : '') + parts.join(' · ');
}

export {
  CLAUDE_USAGE_FILE,
  CODEX_SESSIONS_DIR,
  LIMIT_AGENTS,
  allLimits,
  claudeLimit,
  codexLimit,
  lastRateLimits,
  limitOf,
  limitText,
  modelLimit,
  newestRollouts,
  stillReached,
  toMs,
  windowReached,
};
