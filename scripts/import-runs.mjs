#!/usr/bin/env node
/**
 * 회차 기록 반입 (슬라이스 5) — 운영 기록을 익명화해 `data/runs/` 로 들여온다.
 *
 *   node scripts/import-runs.mjs                 # 로컬 설정의 source 에서 반입
 *   node scripts/import-runs.mjs --from <dir>    # 다른 폴더에서
 *   node scripts/import-runs.mjs --dry           # 쓰지 않고 숫자만 본다
 *
 * **실명·제외 목록은 이 파일에 없다.** `anonymize.local.json`(git 무시)에서 읽는다
 * (`ANONYMIZATION.md §5`). 설정이 없으면 그 사실을 말하고 멈춘다 — 기본값으로 조용히
 * 들여오면 익명화를 건너뛴 기록이 커밋된다.
 *
 * 규칙 셋을 코드로 옮긴 것이다:
 *
 *  §1 제외는 이름만 지우는 것이 아니라 **그 프로젝트에 관한 내용 자체를** 빼는 것 →
 *     제외 이름이 한 칸이라도 든 표 행은 통째로 지운다. 못 알아본 줄도 지우고 **보고한다**.
 *  §3 행을 지웠으면 **요약 숫자를 다시 센다** → 착륙·파견·막힘·결정 필요는 남은 표 행에서
 *     다시 세고, 회차가 제외 프로젝트뿐이었으면 그 회차를 통째로 뺀다.
 *  §4 결과에 금칙어가 **0건**임을 쓰기 전에 확인한다. 하나라도 남으면 아무것도 쓰지 않는다.
 *
 * 회차 형식은 sp-sync 의 `renderCycleReport` 가 쓴 것이다 — 여기서는 파싱해 **다시 그린다.**
 * 줄을 골라 지우는 것보다 안전하다: 지우고 남은 표 머리글·구분선이 떠도는 일이 없고,
 * 못 알아본 줄은 `notes` 로 남아 형식이 바뀌면 드러난다 (`src/fleet/runs.mjs` 와 같은 태도).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CONFIG = join(REPO, 'anonymize.local.json');
const OUT_DIR = join(REPO, 'data', 'runs');

/** 회차 파일만 본다. 나머지(점검 노트)는 회차 기록이 아니다 — `src/fleet/runs.mjs` 와 같은 조건. */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})-cycle\.md$/;
const HEAD_RE = /^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+회차(\s*\(dry-run\))?\s*$/;
/** 표 넷. `renderCycleReport` 가 내는 순서 그대로 다시 그린다. */
const SECTIONS = ['착륙', '파견', '막힘', '결정 필요'];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1] ?? '';
};
const has = (name) => args.includes(name);

const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

function loadConfig() {
  if (!existsSync(CONFIG)) {
    console.error('익명화 설정이 없다: ' + CONFIG);
    console.error('ANONYMIZATION.md §5 — 실명·제외 목록은 로컬 전용 파일에 둔다. 만든 뒤 다시 돌린다.');
    process.exit(2);
  }
  const c = JSON.parse(readFileSync(CONFIG, 'utf8'));
  for (const k of ['exclude', 'replace', 'paths', 'forbidden']) {
    if (!c[k] || !c[k].length) {
      console.error('익명화 설정에 `' + k + '` 가 비어 있다.');
      process.exit(2);
    }
  }
  return c;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ─── 익명화 원시 연산 ─────────────────────────────────────────────────────── */

/** 제외 이름이 하나라도 들었나. 대소문자 변형을 포함한다 (`ANONYMIZATION.md §4`). */
function makeExcluded(list) {
  const re = new RegExp(list.map(esc).join('|'), 'i');
  return (text) => re.test(String(text || ''));
}

/** 치환 — 긴 이름부터 (`…-biz` 가 `…` 보다 먼저여야 한다). 경로 마스킹도 같은 표로 한다. */
function makeSubstitute(replace, paths) {
  const pairs = [...paths, ...replace].map(([from, to]) => [new RegExp(esc(from), 'g'), to]);
  return (text) => pairs.reduce((s, [re, to]) => s.replace(re, to), String(text));
}

/* ─── 회차 파싱 ────────────────────────────────────────────────────────────── */

const cells = (line) =>
  line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

const isDivider = (line) => /^\|[\s|:-]+\|$/.test(line);

/**
 * 회차 한 절 → `{ head, summary, notes, sections }`.
 * 표에도 요약에도 안 잡힌 줄은 `notes` 다 (⚠ · 본체 · 재개 · 건너뜀 · 동기화만).
 */
function parseRun(head, lines) {
  const run = { head, summary: null, notes: [], sections: {} };
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line === '---') continue;
    if (!run.summary && line.startsWith('프로젝트 ')) {
      run.summary = line;
      continue;
    }
    const th = line.match(/^\*\*(.+?)\*\*(?:\s+—\s+없음)?\s*$/);
    if (th) {
      section = th[1];
      run.sections[section] = { header: null, rows: [] };
      continue;
    }
    if (line.startsWith('|') && section) {
      const s = run.sections[section];
      if (!s.header) {
        s.header = cells(line);
        if (isDivider(lines[i + 1] || '')) i++;
        continue;
      }
      if (isDivider(line)) continue;
      s.rows.push(cells(line));
      continue;
    }
    run.notes.push(line);
  }
  return run;
}

/** 파일 한 장 → 회차 배열. 회차가 없으면 빈 배열. */
function parseFile(text) {
  const lines = String(text).split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => {
    if (HEAD_RE.test(l)) heads.push(i);
  });
  return heads.map((i, k) => parseRun(lines[i].trim(), lines.slice(i + 1, k + 1 < heads.length ? heads[k + 1] : lines.length)));
}

/* ─── 요약 줄 ──────────────────────────────────────────────────────────────── */

/**
 * `프로젝트 3(a, b, c) · 착륙 0 · 파견 1(실패 1) · 막힘 0 · 결정 필요 2 · 인계 1`
 * → `{ projects, segments }`. 표 넷 밖의 칸(재개·인계)은 **문장 그대로** 들고 간다 —
 * 표가 없어 다시 셀 수 없다. 그런 회차에서 행을 지웠으면 아래 `warnings` 로 올린다.
 */
function parseSummary(line) {
  const parts = String(line).split('·').map((s) => s.trim());
  const m = parts[0].match(/^프로젝트\s+\d+\(([^)]*)\)$/);
  const projects = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const segments = parts.slice(1).map((p) => {
    const c = p.match(/^(.+?)\s+(\d+)(\(.*\))?$/);
    return c ? { key: c[1], count: Number(c[2]), tail: c[3] || '', raw: p } : { key: null, raw: p };
  });
  return { projects, segments };
}

function renderSummary(projects, segments) {
  const head = '프로젝트 ' + projects.length + '(' + projects.join(', ') + ')';
  return [head, ...segments.map((s) => s.raw)].join(' · ');
}

/* ─── 회차 하나를 익명화 ───────────────────────────────────────────────────── */

function anonymizeRun(run, excluded) {
  const report = { rowsDropped: 0, notesDropped: [], recounted: [], warnings: [] };
  const { projects, segments } = parseSummary(run.summary || '');
  const kept = projects.filter((p) => !excluded(p));
  if (!kept.length) return { drop: true, report };

  // §1 — 제외 이름이 한 칸이라도 든 행은 통째로 지운다.
  const sections = {};
  for (const name of SECTIONS) {
    const s = run.sections[name] || { header: null, rows: [] };
    const rows = s.rows.filter((r) => !r.some((c) => excluded(c)));
    report.rowsDropped += s.rows.length - rows.length;
    sections[name] = { header: s.header, rows };
  }
  // 표 넷 밖의 절이 있으면 그 사실을 올린다 — 조용히 버리지 않는다.
  for (const name of Object.keys(run.sections)) {
    if (!SECTIONS.includes(name)) report.warnings.push('모르는 절: ' + name);
  }

  // 노트 줄 — 이름이 든 것만 손댄다. 괄호 목록이면 이름만 빼고, 그 밖이면 줄을 지운다.
  const notes = [];
  for (const line of run.notes) {
    if (!excluded(line)) {
      notes.push(line);
      continue;
    }
    const paren = line.match(/^(.*\()([^)]*)(\).*)$/);
    if (paren) {
      const names = paren[2].split(',').map((s) => s.trim()).filter((s) => s && !excluded(s));
      if (names.length && !excluded(paren[1] + paren[3])) {
        notes.push(paren[1] + names.join(', ') + paren[3]);
        continue;
      }
    }
    report.notesDropped.push(line);
  }

  // §3 — 남은 표 행으로 요약 숫자를 다시 센다. 수가 그대로면 원문을 그대로 둔다
  //      (`파견 0(실패 1)` 처럼 괄호가 붙은 칸을 잃지 않으려고).
  const out = segments.map((seg) => {
    if (!seg.key || !SECTIONS.includes(seg.key)) return seg;
    const n = sections[seg.key].rows.length;
    if (n === seg.count) return seg;
    report.recounted.push(seg.key + ' ' + seg.count + '→' + n);
    return { ...seg, count: n, tail: '', raw: seg.key + ' ' + n };
  });
  // 표 넷 밖의 칸(재개·인계)은 표가 없어 다시 셀 수 없다. 그 회차에서 제외 프로젝트의 행을
  // 지웠다면 그 수가 지운 쪽의 것인지 알 수 없으므로 **칸을 지운다** — §3 은 안 맞는 숫자를
  // 그대로 두지 말라고 한다. 확인할 수 없는 수를 남기는 것보다 없는 편이 맞다. 지운 것은 보고한다.
  const kept2 = out.filter((s) => !(s.key && !SECTIONS.includes(s.key) && report.rowsDropped));
  for (const s of out) {
    if (!kept2.includes(s)) report.warnings.push('행을 지운 회차라 다시 셀 수 없어 뺀 칸: ' + s.raw);
  }

  return { drop: false, run: { head: run.head, summary: renderSummary(kept, kept2), notes, sections }, report };
}

/* ─── 다시 그리기 ──────────────────────────────────────────────────────────── */

function renderRun(run) {
  const L = [run.head, '', run.summary, ''];
  for (const line of run.notes) L.push(line, '');
  for (const name of SECTIONS) {
    const s = run.sections[name];
    if (!s.rows.length) {
      L.push('**' + name + '** — 없음', '');
      continue;
    }
    L.push('**' + name + '**', '');
    L.push('| ' + s.header.join(' | ') + ' |');
    L.push('|' + s.header.map(() => '---').join('|') + '|');
    for (const r of s.rows) L.push('| ' + r.join(' | ') + ' |');
    L.push('');
  }
  L.push('---', '');
  return L.join('\n');
}

/* ─── 반입 보고서 ──────────────────────────────────────────────────────────── */

/**
 * `data/import-report.md` — 공개 전 승인에 낼 근거다 (`ANONYMIZATION.md §0`).
 * **이 파일도 공개된다.** 제외한 프로젝트의 이름을 여기 적지 않는다. 치환된 이름은 이미
 * 반입한 기록에 그대로 있으므로 적어도 된다.
 */
function renderReport(t, warnings, written, cfg) {
  const to = [...new Set(cfg.replace.map(([, x]) => x))].sort();
  const L = [
    '# 회차 기록 반입 보고',
    '',
    '`scripts/import-runs.mjs` 가 낸다 — **손으로 고치지 않는다.** 다시 반입하면 다시 쓰인다.',
    '규칙은 [`ANONYMIZATION.md`](../ANONYMIZATION.md), 실명·제외 목록은 로컬 전용 파일에 있다 (§5).',
    '',
    '## 숫자',
    '',
    '| | |',
    '|---|---|',
    '| 원본 회차 파일 | ' + t.files + '개 |',
    '| 반입한 파일 | ' + t.filesOut + '개 |',
    '| 원본 회차 | ' + t.runs + '개 |',
    '| **반입한 회차** | **' + t.runsOut + '개** |',
    '| 통째로 뺀 회차 (제외 프로젝트뿐) | ' + t.runsDropped + '개 |',
    '| 지운 표 행 | ' + t.rowsDropped + '개 |',
    '| 지운 줄 (본체 동기화·경고) | ' + t.notesDropped + '개 |',
    '| 다시 센 요약 칸 | ' + t.recounted + '개 |',
    '| 금칙어 스캔 | **0건** |',
    '',
    '## 무엇을 했나',
    '',
    '- **치환** — 포함하기로 한 프로젝트의 이름을 ' + to.map((x) => '`' + x + '`').join(' · ') + ' 로 일관되게 바꿨다. 내용은 남겼다 (§1).',
    '- **제외** — 제외 목록의 프로젝트는 이름이 한 칸이라도 든 표 행을 통째로 지웠다. 이름만 지우지 않았다 (§1).',
    '- **요약 재계산** — 행을 지운 회차는 착륙·파견·막힘·결정 필요를 남은 표 행에서 다시 셌다 (§3).',
    '- **통째로 뺀 회차** — 그 회차가 본 프로젝트가 제외 목록뿐이었던 것 (§3).',
    '- **경로** — 사용자명이 든 절대경로를 `~/…` 로 바꿨다 (§2).',
    '',
    '표 넷 밖의 요약 칸(재개·인계)은 표가 없어 다시 셀 수 없다. 그 칸이 있는 회차에서 제외 프로젝트의',
    '행을 지웠다면 그 수가 어느 쪽 것인지 알 수 없으므로 **칸을 지웠다** — 확인할 수 없는 숫자를',
    '남기는 것보다 없는 편이 §3 에 맞다.',
    '',
    '## 반입한 파일',
    '',
  ];
  for (const [name] of written) L.push('- `data/runs/' + name + '`');
  L.push('', '## 사람이 볼 것', '');
  if (!warnings.length) L.push('없음.');
  for (const w of warnings) L.push('- ' + w);
  L.push('');
  L.push('## 반입하지 않은 것');
  L.push('');
  L.push('- 회차가 없는 점검 노트 파일 (`*-cycle.md` 가 아닌 것) — 회차 기록이 아니다.');
  L.push('- 원본 저장소의 히스토리 — 스냅샷으로 들여온다 (§2).');
  L.push('');
  return L.join('\n');
}

/* ─── 반입 ─────────────────────────────────────────────────────────────────── */

function main() {
  const cfg = loadConfig();
  const src = expand(flag('--from') || cfg.source || '');
  if (!src || !existsSync(src)) {
    console.error('원본 폴더가 없다: ' + (src || '(지정 안 됨)') + '  — --from <dir> 또는 설정의 source');
    process.exit(2);
  }
  const excluded = makeExcluded(cfg.exclude);
  const substitute = makeSubstitute(cfg.replace, cfg.paths);
  const forbidden = new RegExp(cfg.forbidden, 'gi');

  const files = readdirSync(src).filter((n) => FILE_RE.test(n)).sort();
  const tally = { files: files.length, filesOut: 0, runs: 0, runsOut: 0, runsDropped: 0, rowsDropped: 0, notesDropped: 0, recounted: 0 };
  const warnings = [];
  const written = [];

  for (const name of files) {
    const runs = parseFile(readFileSync(join(src, name), 'utf8'));
    tally.runs += runs.length;
    const out = [];
    for (const run of runs) {
      if (!run.summary) {
        warnings.push(name + ' — 요약 줄이 없는 회차: ' + run.head);
        continue;
      }
      const r = anonymizeRun(run, excluded);
      tally.rowsDropped += r.report.rowsDropped;
      tally.notesDropped += r.report.notesDropped.length;
      tally.recounted += r.report.recounted.length;
      for (const w of r.report.warnings) warnings.push(name + ' ' + run.head.replace(/^##\s*/, '') + ' — ' + w);
      if (r.drop) {
        tally.runsDropped++;
        continue;
      }
      out.push(renderRun(r.run));
      tally.runsOut++;
    }
    if (!out.length) continue;
    written.push([name, substitute(out.join('\n'))]);
    tally.filesOut++;
  }

  // §4 — 쓰기 **전에** 금칙어를 확인한다. 하나라도 남으면 아무것도 쓰지 않는다.
  const hits = [];
  for (const [name, text] of written) {
    for (const m of text.matchAll(forbidden)) hits.push(name + ': ' + m[0]);
  }
  if (hits.length) {
    console.error('금칙어가 ' + hits.length + '건 남았다 — 아무것도 쓰지 않는다.');
    for (const h of hits.slice(0, 20)) console.error('  ' + h);
    process.exit(1);
  }

  if (!has('--dry')) {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    for (const [name, text] of written) writeFileSync(join(OUT_DIR, name), text, 'utf8');
    writeFileSync(join(REPO, 'data', 'import-report.md'), renderReport(tally, warnings, written, cfg), 'utf8');
  }

  const L = [];
  L.push('원본 파일 ' + tally.files + '개 → 반입 ' + tally.filesOut + '개' + (has('--dry') ? ' (dry — 쓰지 않았다)' : ''));
  L.push('회차 ' + tally.runs + '개 → 반입 ' + tally.runsOut + '개 (제외 프로젝트뿐이라 뺀 회차 ' + tally.runsDropped + '개)');
  L.push('지운 표 행 ' + tally.rowsDropped + '개 · 지운 줄 ' + tally.notesDropped + '개 · 다시 센 요약 칸 ' + tally.recounted + '개');
  L.push('금칙어 스캔 0건');
  if (warnings.length) {
    L.push('');
    L.push('사람이 볼 것 ' + warnings.length + '건:');
    for (const w of warnings) L.push('  ' + w);
  }
  console.log(L.join('\n'));
  return tally;
}

main();
