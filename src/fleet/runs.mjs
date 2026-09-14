/**
 * 회차 기록 읽기 (슬라이스 3) — `fleet_report` 의 재료.
 *
 * 기록은 sp-sync 의 `renderCycleReport` 가 쓴 **마크다운**이다. 날짜별 파일 하나에 회차를
 * 덧붙이는 꼴이라(`<runsDir>/YYYY-MM-DD-cycle.md`), 파일 하나에 회차가 여럿 들어 있다.
 * 여기서는 그것을 도구가 낼 수 있는 구조로 되읽는다 — **쓰지 않는다.**
 *
 * 한 회차의 모양 (`renderCycleReport` 와 같은 순서):
 *
 *     ## 2026-09-10 07:33 회차
 *     프로젝트 3(atlas, beacon, cobalt) · 착륙 1 · 파견 2 · 막힘 3 · 결정 필요 2
 *     ⚠ … / 본체 — … / 재개 — … / 건너뜀 — …        (있을 때만. 회차가 한 일의 꼬리표)
 *     **착륙** … 표 넷 (착륙 · 파견 · 막힘 · 결정 필요)
 *     ---
 *
 * 파서가 지켜야 하는 것 하나 — **못 읽은 줄을 버리지 않는다.** 표에도 요약에도 안 잡힌 줄은
 * `notes` 로 남긴다. 기록 형식이 바뀌면 그 사실이 결과에 드러나야지, 조용히 빈 회차가 되면 안 된다.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 파일 이름 → 날짜. 회차 제목의 날짜와 어긋날 수 있어(자정 넘긴 회차) 둘 다 싣는다. */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})-cycle\.md$/;
const HEAD_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+회차(\s*\(dry-run\))?\s*$/;
/** `착륙 1` · `파견 2(실패 1)` · `일시 제외 1(coordinator)` — 이름과 수, 그리고 괄호 안. */
const COUNT_RE = /([가-힣A-Za-z ]+?)\s+(\d+)(?:\(([^)]*)\))?/g;
const TABLE_HEAD_RE = /^\*\*(.+?)\*\*(?:\s+—\s+없음)?\s*$/;

/** `| a | b |` → `['a','b']`. `\|` 는 칸 안의 파이프다 (`mdTable` 이 그렇게 이스케이프한다). */
const cells = (line) =>
  line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());

const isDivider = (line) => /^\|[\s|:-]+\|$/.test(line);

/** 요약 줄 → `{ 착륙: 1, 파견: 2, … }` + 괄호 안의 꼬리. 이름은 기록에 적힌 그대로 둔다. */
function parseSummary(line) {
  const counts = {};
  const notes = {};
  for (const m of line.matchAll(COUNT_RE)) {
    const key = m[1].trim();
    if (!key) continue;
    counts[key] = Number(m[2]);
    if (m[3]) notes[key] = m[3];
  }
  return { counts, detail: notes };
}

/** 표 한 장 → 객체 배열. 머리글을 열쇠로 쓴다 — 표마다 열이 달라 위치로 읽으면 안 된다. */
function parseTable(lines, i) {
  const head = cells(lines[i]);
  if (!isDivider(lines[i + 1] || '')) return { rows: [], next: i };
  const rows = [];
  let j = i + 2;
  for (; j < lines.length && lines[j].startsWith('|'); j++) {
    const c = cells(lines[j]);
    rows.push(Object.fromEntries(head.map((h, k) => [h, c[k] ?? ''])));
  }
  return { rows, next: j };
}

/** 회차 한 절 → 객체. `lines` 는 `## …` 줄 **뒤**부터다. */
function parseCycle(head, lines) {
  const [, date, time, dry] = head;
  const out = {
    id: date + 'T' + time,
    date,
    time,
    dryRun: !!dry,
    projects: [],
    counts: {},
    detail: {},
    notes: [],
    tables: {},
  };
  let table = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line === '---') continue;
    // 요약 줄은 회차마다 하나, 늘 맨 앞이다. 프로젝트 이름은 괄호 안에 있다.
    if (!Object.keys(out.counts).length && line.startsWith('프로젝트 ')) {
      const names = line.match(/^프로젝트\s+\d+\(([^)]*)\)/);
      out.projects = names ? names[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      Object.assign(out, parseSummary(line));
      continue;
    }
    const th = line.match(TABLE_HEAD_RE);
    if (th) {
      table = th[1];
      out.tables[table] = [];
      continue;
    }
    if (line.startsWith('|') && table) {
      const { rows, next } = parseTable(lines, i);
      out.tables[table] = rows;
      i = next - 1;
      continue;
    }
    // 표에도 요약에도 안 잡힌 줄 — ⚠ · 본체 · 재개 · 건너뜀 · 동기화만 · 한 바퀴 더.
    out.notes.push(line);
  }
  return out;
}

/** 파일 한 장 → 그 안의 회차들. 회차가 없으면 빈 배열(점검 노트만 있는 파일). */
function parseRunsFile(text, file = null) {
  const lines = String(text).split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => {
    const m = l.match(HEAD_RE);
    if (m) heads.push([i, m]);
  });
  return heads.map(([i, m], k) => ({ ...parseCycle(m, lines.slice(i + 1, k + 1 < heads.length ? heads[k + 1][0] : lines.length)), file, seq: k + 1 }));
}

/**
 * 회차 기록을 날짜 범위로 읽는다. **없는 날짜면 빈 결과** (`PRD.md §4`) — 오류가 아니다.
 *
 *   dir    기록 폴더 (`<repo>/sandbox/runs`)
 *   from/to `YYYY-MM-DD`, 양끝 포함. 문자열 비교로 거른다 (ISO 날짜라 사전순 = 시간순)
 *   limit  최신부터 몇 개까지. 기본 20
 */
function readRuns({ dir, from = null, to = null, limit = 20, project = null } = {}) {
  const out = { dir, from, to, runs: [], files: 0, total: 0, missing: !existsSync(dir) };
  if (out.missing) return out;
  const files = readdirSync(dir)
    .map((n) => [n, (n.match(FILE_RE) || [])[1]])
    .filter(([, d]) => d && (!from || d >= from) && (!to || d <= to))
    .sort((a, b) => (a[1] < b[1] ? 1 : -1)); // 최신 날짜 먼저
  const runs = [];
  for (const [name] of files) {
    out.files++;
    const parsed = parseRunsFile(readFileSync(join(dir, name), 'utf8'), name);
    runs.push(...parsed);
  }
  // 파일 안에서는 오래된 회차가 먼저 쌓인다 — 전체를 최신순으로 다시 세운다.
  runs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const picked = project ? runs.filter((r) => r.projects.includes(project)) : runs;
  out.total = picked.length;
  out.runs = picked.slice(0, Math.max(0, limit));
  return out;
}

/**
 * 회차 하나를 가리키는 주소. 제목의 날짜·시각은 **겹친다** — 한 파일 안에 같은 분의 회차가 둘
 * 있는 날이 있다(반입한 241개 중 2쌍). 파일 이름과 그 안의 순번으로 짓는다.
 */
const runSlug = (run) => String(run.file || "").replace(/-cycle.md$/, "") + "-" + (run.seq || 1);

export { parseRunsFile, readRuns, runSlug };
