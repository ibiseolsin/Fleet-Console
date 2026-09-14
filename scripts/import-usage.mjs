#!/usr/bin/env node
/**
 * 회차별 시간·토큰 반입 (슬라이스 6) — 기존 측정치에 없던 것을 새로 묶는다.
 *
 *   node scripts/import-usage.mjs           # 로컬 설정의 로그·세션 기록에서
 *   node scripts/import-usage.mjs --dry     # 쓰지 않고 숫자만
 *
 * **왜 새로 만드나.** 운영 저장소에 있는 토큰 사용량 요약은 **프로젝트·주 단위**라 회차별이
 * 없다 (`PLAN.md` 슬라이스 6의 함정 메모). 회차 기록(`data/runs/`) 자체에도 시간이 없다 —
 * sp-sync 의 `renderCycleReport` 는 소요 시간을 적지 않는다. 그래서 두 원본을 회차 시각
 * 범위로 묶는다:
 *
 *   시간   플릿 로그(`~/.sp-sync/log.txt`) — 줄마다 UTC 시각이 붙어 있다.
 *          회차 제목의 시각이 **시작**(`fleetCycle` 의 `out.at`)이고, 보고를 파일에 붙인 줄
 *          (`fleet cycle 프로젝트 N → …-cycle.md`)이 **끝**이다. 그 사이의 실행 줄
 *          (착륙·재개·인계·파견)이 구간을 가른다.
 *   토큰   에이전트 세션 기록(`~/.claude/projects/<…>/<세션>.jsonl`)의 assistant 메시지.
 *          줄마다 `timestamp` · `cwd` · `message.usage` 가 있다. 회차 시각 범위로 묶는다.
 *
 * **익명화** (`ANONYMIZATION.md`) — `import-runs.mjs` 와 같은 태도다:
 *
 *  §1 제외 프로젝트의 세션은 **통째로 버린다.** 경로에 이름이 한 조각이라도 들면 그 줄을 안 센다.
 *  §2 프로젝트별은 **비중(%)만** 낸다. 절대치는 회차 단위(플릿 전체 합)로만 — 로컬 매핑 파일의
 *     "측정치" 항목이 정한 것이다. 경로·사용자명은 결과에 한 글자도 싣지 않는다(수만 싣는다).
 *  §3 제외를 뺀 뒤 **비중을 다시 계산한다.** 뺀 몫을 남겨 두지 않는다.
 *  §4 쓰기 **전에** 금칙어를 스캔한다. 하나라도 남으면 아무것도 쓰지 않는다.
 *
 * 회차 목록은 `data/runs/`(이미 익명화된 것)에서 읽는다. 원본 회차 기록을 다시 열지 않으므로
 * 이 스크립트가 늘리는 것은 **수뿐**이다.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuns, runSlug } from '../src/fleet/runs.mjs';
import { STAGES } from '../src/fleet/usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CONFIG = join(REPO, 'anonymize.local.json');
const RUNS_DIR = join(REPO, 'data', 'runs');
const OUT_DIR = join(REPO, 'data', 'usage');
const OUT_FILE = join(OUT_DIR, 'cycles.json');
const REPORT_FILE = join(REPO, 'data', 'usage-report.md');

/** 회차 하나가 이보다 오래 걸렸으면 짝이 잘못 맞은 것으로 본다. sp-sync 는 540초에 "안 끝남" 을 찍는다. */
const MAX_CYCLE_MS = 30 * 60 * 1000;
/** 회차 시작에서 이보다 멀어진 세션 기록은 그 회차의 몫으로 안 본다 — 긴 공백 뒤의 작업이 앞 회차에 붙는 것을 막는다. */
const MAX_ATTRIBUTE_MS = 6 * 60 * 60 * 1000;

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i < 0 ? null : args[i + 1] ?? '';
};
const has = (n) => args.includes(n);
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function loadConfig() {
  if (!existsSync(CONFIG)) {
    console.error('익명화 설정이 없다: ' + CONFIG);
    console.error('ANONYMIZATION.md §5 — 실명·제외 목록은 로컬 전용 파일에 둔다. 만든 뒤 다시 돌린다.');
    process.exit(2);
  }
  const c = JSON.parse(readFileSync(CONFIG, 'utf8'));
  for (const k of ['exclude', 'replace', 'forbidden']) {
    if (!c[k] || !c[k].length) {
      console.error('익명화 설정에 `' + k + '` 가 비어 있다.');
      process.exit(2);
    }
  }
  return c;
}

/* ─── 회차 ─────────────────────────────────────────────────────────────────── */

/**
 * 회차 제목의 날짜·시각은 **이 기계의 지역 시각**이다 (`cycleStamp` 이 그렇게 쓴다).
 * 로그와 세션 기록은 UTC 라서, 여기서 한 번만 지역 시각으로 읽어 epoch 으로 맞춘다.
 */
const startOf = (run) => new Date(run.date + 'T' + run.time + ':00').getTime();

function loadCycles() {
  const data = readRuns({ dir: RUNS_DIR, limit: Number.MAX_SAFE_INTEGER });
  // `readRuns` 가 최신 먼저로 준다. 그 차례를 `order` 로 들고 가야 결과 파일도 같은 차례가 된다 —
  // slug 로 정렬하면 `…-9` 가 `…-13` 보다 뒤로 가서 목록이 뒤죽박죽이 된다.
  return data.runs
    .map((r, order) => ({
      order,
      slug: runSlug(r),
      file: r.file,
      date: r.date,
      time: r.time,
      projects: r.projects,
      startMs: startOf(r),
      endMs: null,
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

/* ─── 로그 → 회차의 끝과 구간 ──────────────────────────────────────────────── */

const LOG_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+(.*)$/;
/** 보고를 회차 파일에 붙인 줄 = 회차의 끝. 임시 폴더로 간 것은 sp-sync 자체 테스트라 뺀다. */
const END_RE = /^fleet cycle 프로젝트 \d+ → (.+)$/;
/** 실행 줄. 각 줄은 그 단계가 **끝났음**을 뜻한다 (`src/fleet/usage.mjs` 의 STAGES 머리말). */
const MARKS = [
  [/^fleet land /, '착륙'],
  [/^fleet cycle 재개 /, '재개'],
  [/^fleet cycle 인계 /, '인계'],
  [/^fleet dispatch /, '파견'],
];

function readLog(file) {
  const ends = [];
  const marks = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(LOG_RE);
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (!Number.isFinite(ms)) continue;
    const body = m[2];
    const e = body.match(END_RE);
    if (e) {
      const path = e[1].replace(/\\/g, '/');
      if (/\/Temp\//i.test(path)) continue;
      const name = basename(path);
      if (/^\d{4}-\d{2}-\d{2}-cycle\.md$/.test(name)) ends.push({ ms, name });
      continue;
    }
    for (const [re, stage] of MARKS) {
      if (re.test(body)) {
        marks.push({ ms, stage });
        break;
      }
    }
  }
  return { ends, marks };
}

/**
 * 끝 줄을 회차에 붙인다. 같은 회차 파일 안에서, **시작이 그 줄보다 앞선 것 중 가장 최근**의
 * 아직 안 짝지어진 회차다. 프로젝트마다 회차가 따로 돌아 서로 겹치므로(하나가 도는 중에 다른
 * 프로젝트의 회차가 시작한다) 가장 최근 것부터 보는 것이 겹친 회차를 제대로 가른다.
 */
function matchEnds(cycles, ends) {
  const byFile = new Map();
  for (const c of cycles) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  let matched = 0;
  let orphan = 0;
  for (const e of [...ends].sort((a, b) => a.ms - b.ms)) {
    const list = byFile.get(e.name) || [];
    let hit = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.startMs > e.ms) continue;
      if (e.ms - c.startMs > MAX_CYCLE_MS) break; // 더 오래된 회차는 더 멀다
      if (c.endMs != null) continue;
      hit = c;
      break;
    }
    if (!hit) {
      orphan++;
      continue;
    }
    hit.endMs = e.ms;
    matched++;
  }
  return { matched, orphan };
}

/** 구간을 나눈다. `[앞 줄, 이 줄]` 이 이 줄의 단계다. 마지막 구간(마지막 실행 → 보고)이 `관찰·기록`. */
function splitStages(cycle, marks) {
  const stages = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let prev = cycle.startMs;
  for (const m of marks) {
    if (m.ms <= prev || m.ms > cycle.endMs) continue;
    stages[m.stage] += m.ms - prev;
    prev = m.ms;
  }
  stages['관찰·기록'] += Math.max(0, cycle.endMs - prev);
  return stages;
}

/* ─── 세션 기록 → 토큰 ─────────────────────────────────────────────────────── */

/** 경로에서 프로젝트를 집는다. 실제 경로(`~/orca/workspaces/<이름>/sliceN`)와 납작해진 임시 경로 둘 다. */
function projectOf(cwd) {
  const s = String(cwd || '').replace(/\\/g, '/');
  const real = s.match(/\/orca\/(?:workspaces|projects)\/([^/]+)/);
  if (real) return real[1];
  const flat = s.match(/orca-(?:workspaces|projects)-(.+?)-(?:slice\d+|[0-9a-f]{8}-)/);
  if (flat) return flat[1];
  return null;
}

/**
 * 토큰 네 갈래. 캐시 읽기가 대개 전체의 대부분이라(`PLAN.md` 토큰 예산 절 — total 의 96%)
 * 합쳐 세면 나머지가 안 보인다.
 */
function tokensOf(u) {
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
}

const addTokens = (a, b) => {
  a.in += b.in;
  a.out += b.out;
  a.cacheCreate += b.cacheCreate;
  a.cacheRead += b.cacheRead;
};

const zero = () => ({ in: 0, out: 0, cacheCreate: 0, cacheRead: 0 });

/**
 * 세션 기록을 한 줄씩 흘려 읽는다. 폴더가 1GB 를 넘어 통째로 못 올린다.
 * **`requestId` 로 중복을 거른다** — 세션을 이어 열면(`--resume`) 앞 대화가 새 파일에 다시 쓰여
 * 같은 요청이 두 번 세어진다.
 */
async function* sessionRecords(dir, excluded, sinceMs, untilMs, stat) {
  const seen = new Set();
  for (const d of readdirSync(dir)) {
    if (excluded(d)) {
      stat.excludedDirs++;
      continue;
    }
    const sub = join(dir, d);
    let files = [];
    try {
      files = readdirSync(sub).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(sub, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      // 마지막으로 쓰인 시각이 창 시작보다 앞이면 그 파일에는 볼 줄이 없다.
      if (st.mtimeMs < sinceMs) {
        stat.skippedFiles++;
        continue;
      }
      stat.files++;
      const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          stat.badLines++;
          continue;
        }
        const u = rec?.message?.usage;
        if (!u || rec.type !== 'assistant') continue;
        const ms = Date.parse(rec.timestamp || '');
        if (!Number.isFinite(ms) || ms < sinceMs || ms > untilMs) continue;
        const key = rec.requestId || rec.uuid;
        if (key) {
          if (seen.has(key)) {
            stat.dupes++;
            continue;
          }
          seen.add(key);
        }
        const cwd = rec.cwd || d;
        // §1 — 제외 프로젝트의 세션은 통째로 버린다. 경로에 이름이 한 조각이라도 들면 안 센다.
        if (excluded(cwd) || excluded(d)) {
          stat.excludedRecords++;
          continue;
        }
        yield { ms, project: projectOf(cwd), model: rec.message?.model || '?', session: rec.sessionId || f, tokens: tokensOf(u) };
      }
    }
  }
}

/* ─── 반입 보고서 ──────────────────────────────────────────────────────────── */

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');
const kMs = (ms) => (ms < 60000 ? Math.round(ms / 1000) + '초' : Math.floor(ms / 60000) + '분 ' + Math.round((ms % 60000) / 1000) + '초');

function renderReport(t) {
  const L = [
    '# 회차별 시간·토큰 반입 보고',
    '',
    '`scripts/import-usage.mjs` 가 낸다 — **손으로 고치지 않는다.** 다시 반입하면 다시 쓰인다.',
    '규칙은 [`ANONYMIZATION.md`](../ANONYMIZATION.md), 실명·제외 목록은 로컬 전용 파일에 있다 (§5).',
    '',
    '## 왜 새로 쟀나',
    '',
    '회차 기록(`data/runs/`)에는 시간이 없고, 운영 저장소의 토큰 요약은 **프로젝트·주 단위**라',
    '회차별이 없다. 그래서 플릿 로그의 줄 시각과 에이전트 세션 기록을 **회차 시각 범위로** 묶었다.',
    '',
    '## 숫자',
    '',
    '| | |',
    '|---|---|',
    '| 회차 (`data/runs/`) | ' + t.cycles + '개 |',
    '| **시간이 붙은 회차** | **' + t.timed + '개** |',
    '| 로그의 회차 끝 줄 중 짝을 못 찾은 것 | ' + t.orphan + '개 |',
    '| **토큰이 붙은 회차** | **' + t.tokened + '개** |',
    '| 읽은 세션 파일 | ' + t.files + '개 (시각 범위 밖이라 건너뛴 파일 ' + t.skippedFiles + '개) |',
    '| 센 메시지 | ' + t.messages + '개 |',
    '| 제외 프로젝트라 버린 메시지 | ' + t.excludedRecords + '개 (폴더 ' + t.excludedDirs + '개) |',
    '| 세션을 이어 열어 중복된 메시지 | ' + t.dupes + '개 (`requestId` 로 걸렀다) |',
    '| 어느 회차에도 안 붙은 메시지 | ' + t.unattributed + '개 (' + pct(t.unattributed, t.messages) + '%) |',
    '| 금칙어 스캔 | **0건** |',
    '',
    '## 시간을 어떻게 갈랐나',
    '',
    '플릿 로그는 단계가 **끝날 때** 한 줄을 남기지 시작할 때는 안 남긴다. 그래서 구간은',
    '"앞 줄 다음부터 이 줄까지" 이고 이름은 **그 줄의 단계**를 쓴다 — `파견 3분` 은 파견 줄 앞의',
    '3분이고 거기에는 그 파견을 하기 전의 관찰·판정이 얼마간 섞여 있다. 마지막 구간(마지막 실행',
    '줄 → 보고를 쓴 줄)이 `관찰·기록` 이고, 아무 실행도 없던 회차는 통째로 이것이다.',
    '',
    '**회차 시작은 분 단위다** — 회차 제목이 `HH:MM` 까지만 적는다. 그래서 소요 시간은 최대 59초',
    '길게 나오고, 그 오차는 첫 구간에 얹힌다. 초 단위 시작 시각은 어디에도 안 남아 있다.',
    '',
    '| 단계 | 합계 | 비중 |',
    '|---|---|---|',
  ];
  for (const [stage, ms] of t.stageRows) L.push('| ' + stage + ' | ' + kMs(ms) + ' | ' + pct(ms, t.stageSum) + '% |');
  L.push('');
  L.push('가장 오래 걸린 단계: **' + t.slowest + '**.');
  L.push('');
  L.push('## 토큰을 어떻게 묶었나');
  L.push('');
  L.push('세션 기록의 assistant 메시지 하나는 **그 시각 이전에 시작한 회차 중 가장 최근이면서**');
  L.push('**그 프로젝트를 다룬** 회차에 붙는다. 그런 회차가 없거나 ' + Math.round(MAX_ATTRIBUTE_MS / 3600000) + '시간을 넘게 떨어져 있으면');
  L.push('안 붙인다 (위 표의 "어느 회차에도 안 붙은 메시지"). 플릿이 다루지 않는 저장소의 세션이 여기 들어온다.');
  L.push('');
  L.push('| 갈래 | 합계 | 비중 |');
  L.push('|---|---|---|');
  for (const [k, n] of t.tokenRows) L.push('| ' + k + ' | ' + n.toLocaleString('en-US') + ' | ' + pct(n, t.tokenSum) + '% |');
  L.push('');
  L.push('## 프로젝트별 — 비중만');
  L.push('');
  L.push('절대치를 안 적는 것은 로컬 매핑 파일의 "측정치" 항목이 정한 것이다 (`ANONYMIZATION.md §2`).');
  L.push('**제외 프로젝트를 뺀 뒤 다시 계산한 비중**이다 (§3) — 뺀 몫을 남겨 두지 않았다.');
  L.push('회차 기록에 이름이 안 나오는 저장소는 `기타` 로 묶는다 (반입이 새 이름을 공개하지 않는다).');
  L.push('');
  L.push('| 프로젝트 | 토큰 비중 |');
  L.push('|---|---|');
  for (const [name, n] of t.projectRows) L.push('| ' + name + ' | ' + pct(n, t.projectSum) + '% |');
  L.push('');
  L.push('## 모델별 — 비중만');
  L.push('');
  L.push('| 모델 | 토큰 비중 |');
  L.push('|---|---|');
  for (const [name, n] of t.modelRows) L.push('| `' + name + '` | ' + pct(n, t.projectSum) + '% |');
  L.push('');
  L.push('## 반입하지 않은 것');
  L.push('');
  L.push('- 세션의 **내용** — 프롬프트·응답·파일 이름은 한 글자도 안 읽는다. 시각·경로·`usage` 만 본다.');
  L.push('- 프로젝트별·세션별 **절대치** — 비중만 낸다 (§2).');
  L.push('- 제외 프로젝트의 세션 — 통째로 뺐다 (§1).');
  L.push('');
  return L.join('\n');
}

/* ─── 반입 ─────────────────────────────────────────────────────────────────── */

async function main() {
  const cfg = loadConfig();
  const logFile = expand(flag('--log') || cfg.log || join(homedir(), '.sp-sync', 'log.txt'));
  const sessionsDir = expand(flag('--sessions') || cfg.sessions || join(homedir(), '.claude', 'projects'));
  for (const [what, p] of [['플릿 로그', logFile], ['세션 기록 폴더', sessionsDir]]) {
    if (!existsSync(p)) {
      console.error(what + '이 없다: ' + p + '  — 설정의 log · sessions 또는 --log · --sessions');
      process.exit(2);
    }
  }
  const excludeRe = new RegExp(cfg.exclude.map(esc).join('|'), 'i');
  const excluded = (text) => excludeRe.test(String(text || ''));
  const subs = cfg.replace.map(([from, to]) => [new RegExp(esc(from), 'g'), to]);
  const substitute = (s) => subs.reduce((x, [re, to]) => x.replace(re, to), String(s));

  const cycles = loadCycles();
  if (!cycles.length) {
    console.error('회차가 없다: ' + RUNS_DIR + '  — 먼저 npm run import:runs');
    process.exit(2);
  }
  // 회차 기록에 이미 나오는 이름만 그대로 쓴다. 그 밖은 `기타` — 반입이 새 이름을 공개하지 않는다.
  const publicNames = new Set(cycles.flatMap((c) => c.projects));

  const { ends, marks } = readLog(logFile);
  const { matched, orphan } = matchEnds(cycles, ends);
  marks.sort((a, b) => a.ms - b.ms);
  for (const c of cycles) {
    if (c.endMs == null) continue;
    c.stages = splitStages(
      c,
      marks.filter((m) => m.ms > c.startMs && m.ms <= c.endMs)
    );
    c.ms = c.endMs - c.startMs;
  }

  const stat = { files: 0, skippedFiles: 0, badLines: 0, dupes: 0, excludedDirs: 0, excludedRecords: 0, messages: 0, unattributed: 0 };
  const since = cycles[0].startMs;
  const until = cycles[cycles.length - 1].startMs + MAX_ATTRIBUTE_MS;
  const byProject = new Map();
  const byModel = new Map();
  for (const c of cycles) {
    c.tokens = zero();
    c.messages = 0;
    c.sessions = new Set();
  }

  for await (const rec of sessionRecords(sessionsDir, excluded, since, until, stat)) {
    stat.messages++;
    const raw = rec.project ? substitute(rec.project) : null;
    const name = raw && publicNames.has(raw) ? raw : '기타';
    const total = rec.tokens.in + rec.tokens.out + rec.tokens.cacheCreate + rec.tokens.cacheRead;
    byProject.set(name, (byProject.get(name) || 0) + total);
    byModel.set(rec.model, (byModel.get(rec.model) || 0) + total);
    // 그 시각 이전에 시작한 회차 중 가장 최근이면서 그 프로젝트를 다룬 것.
    let hit = null;
    for (let i = cycles.length - 1; i >= 0; i--) {
      const c = cycles[i];
      if (c.startMs > rec.ms) continue;
      if (rec.ms - c.startMs > MAX_ATTRIBUTE_MS) break;
      if (c.projects.includes(name)) {
        hit = c;
        break;
      }
    }
    if (!hit) {
      stat.unattributed++;
      continue;
    }
    addTokens(hit.tokens, rec.tokens);
    hit.messages++;
    hit.sessions.add(rec.session);
  }

  const out = {
    builtAt: new Date().toISOString(),
    note: '회차별 시간·토큰. 규칙과 숫자는 data/usage-report.md. 프로젝트별은 비중만 낸다 (ANONYMIZATION.md §2).',
    stages: STAGES,
    cycles: cycles
      .filter((c) => c.endMs != null || c.messages > 0)
      .map((c) => ({
        order: c.order,
        slug: c.slug,
        date: c.date,
        time: c.time,
        ms: c.ms ?? null,
        stages: c.stages || null,
        tokens: c.messages ? c.tokens : null,
        messages: c.messages,
        sessions: c.sessions.size,
      }))
      .sort((a, b) => a.order - b.order),
  };

  const stageTotal = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const c of cycles) for (const [k, v] of Object.entries(c.stages || {})) stageTotal[k] += v;
  const stageSum = Object.values(stageTotal).reduce((a, b) => a + b, 0);
  const tokenTotal = zero();
  for (const c of cycles) addTokens(tokenTotal, c.tokens);
  const projectRows = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
  const projectSum = projectRows.reduce((a, [, n]) => a + n, 0);

  const tally = {
    cycles: cycles.length,
    timed: matched,
    orphan,
    tokened: cycles.filter((c) => c.messages > 0).length,
    ...stat,
    stageRows: STAGES.map((s) => [s, stageTotal[s]]),
    stageSum,
    slowest: STAGES.slice().sort((a, b) => stageTotal[b] - stageTotal[a])[0],
    tokenRows: [
      ['입력', tokenTotal.in],
      ['출력', tokenTotal.out],
      ['캐시 생성', tokenTotal.cacheCreate],
      ['캐시 읽기', tokenTotal.cacheRead],
    ],
    tokenSum: tokenTotal.in + tokenTotal.out + tokenTotal.cacheCreate + tokenTotal.cacheRead,
    projectRows,
    projectSum,
    modelRows: [...byModel.entries()].sort((a, b) => b[1] - a[1]),
  };
  const report = renderReport(tally);

  // §4 — 쓰기 **전에** 금칙어를 확인한다. 하나라도 남으면 아무것도 쓰지 않는다.
  const forbidden = new RegExp(cfg.forbidden, 'gi');
  const hits = [];
  for (const [what, text] of [
    ['cycles.json', JSON.stringify(out)],
    ['usage-report.md', report],
  ])
    for (const m of text.matchAll(forbidden)) hits.push(what + ': ' + m[0]);
  if (hits.length) {
    console.error('금칙어가 ' + hits.length + '건 남았다 — 아무것도 쓰지 않는다.');
    for (const h of hits.slice(0, 20)) console.error('  ' + h);
    process.exit(1);
  }

  if (!has('--dry')) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(out, null, 1) + '\n', 'utf8');
    writeFileSync(REPORT_FILE, report, 'utf8');
  }

  console.log(
    [
      '회차 ' + tally.cycles + '개 → 시간 ' + tally.timed + '개 · 토큰 ' + tally.tokened + '개' + (has('--dry') ? ' (dry — 쓰지 않았다)' : ''),
      '세션 파일 ' + stat.files + '개 · 메시지 ' + stat.messages + '개 (중복 ' + stat.dupes + ' · 제외 ' + stat.excludedRecords + ' · 미귀속 ' + stat.unattributed + ')',
      '가장 오래 걸린 단계: ' + tally.slowest + ' (' + pct(stageTotal[tally.slowest], stageSum) + '%)',
      '짝을 못 찾은 회차 끝 줄 ' + orphan + '개 · 금칙어 스캔 0건',
    ].join('\n')
  );
}

await main();
