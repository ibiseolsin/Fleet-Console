#!/usr/bin/env node
/**
 * 사고 사례 반입 (슬라이스 10) — 운영 저장소의 규칙 근거 표를 익명화해 들여오고,
 * 원인 단계별로 분류한다 (`PRD.md §9` 실패 사례 분석).
 *
 *   node scripts/import-incidents.mjs           # data/eval/incidents.json 을 쓴다
 *   node scripts/import-incidents.mjs --dry     # 쓰지 않고 표만
 *   node scripts/import-incidents.mjs --from <파일>
 *
 * **익명화는 이번이 세 번째다** — 코드(슬라이스 1) · 회차 기록(슬라이스 5) · 사고 사례(여기).
 * 규칙은 `ANONYMIZATION.md`, 실명·제외 목록은 `anonymize.local.json`(git 무시)에서 읽는다.
 * 설정이 없으면 아무것도 반입하지 않고 멈춘다 — `scripts/import-runs.mjs` 와 같은 태도다.
 *
 * §1 제외는 이름만 지우는 것이 아니라 **그 행을 통째로** 빼는 것이고,
 * §3 표본이 줄면 **줄어든 수를 그대로** 적는다 — 원래 수를 적고 각주로 빼지 않는다.
 * §4 결과에 금칙어가 하나라도 남으면 **아무것도 쓰지 않는다.**
 *
 * 분류는 **사람이 읽고 붙인 라벨**이다. 규칙이 아니라 판단이므로 아래 표에 번호로만 적고,
 * 근거 문장은 반입한 원문(익명화본)이 진다. 표에 없는 번호는 `미분류` 로 세어 보고한다 —
 * 원본에 행이 늘면 조용히 빠지지 않고 드러나야 한다.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CONFIG = join(REPO, 'anonymize.local.json');
const OUT = join(REPO, 'data', 'eval', 'incidents.json');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const fromArg = args.indexOf('--from') < 0 ? null : args[args.indexOf('--from') + 1];
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

/** 원인 단계 넷 (`PRD.md §9`). 다섯째는 두지 않는다 — 안 맞으면 `미분류` 로 남긴다. */
const STAGES = ['관찰', '판정', '실행', '사람 개입 설계'];

/**
 * 번호 → 분류. `사고` 는 실제로 잘못된 결과가 났거나 진행이 멈춘 것이고, `사고 아님` 은
 * 같은 표에 섞여 있는 사용자 결정·점검 결과·기능 설명이다 (검토 R10: 표 행 수 ≠ 사고 수).
 * `stage` 는 **원인이 어느 단계에서 생겼나**이지 어디서 드러났나가 아니다.
 */
const LABELS = {
  1: ['사고 아님', null, '사용자 결정'],
  2: ['사고', '판정', '완료 신호가 사람 규율에만 기대 미확인 슬라이스가 머지됐다'],
  4: ['사고', '판정', '병렬 자격 판정에 "같은 파일" 조건이 없어 착륙이 줄줄이 충돌했다'],
  5: ['사고', '판정', '병렬 자격 판정에 공유 자원 조건이 없어 측정이 오염됐다'],
  6: ['사고 아님', null, '기능 도입 — 부분 의존을 적을 태그가 없었다'],
  7: ['사고', '사람 개입 설계', '사람 호출 통로(카드 `wait`)에 승인 요청을 적어 착륙이 영영 멈췄다'],
  8: ['사고', '관찰', '카드 없이 선택지를 띄워 관찰 재료가 비었고 착륙이 "막힘" 으로 오판했다'],
  9: ['사고 아님', null, '사용자 결정'],
  10: ['사고', '실행', '실행 환경에 `HOME` 이 없어 카드가 엉뚱한 폴더로 새어 나갔다'],
  11: ['사고 아님', null, '사용자 결정'],
  12: ['사고', '사람 개입 설계', '같은 항목이 회차마다 다시 올라와 세션이 반복해 떴다 (헛호출)'],
  13: ['사고', '실행', '실행 환경에 `HOME` 이 없어 원격 별칭을 못 풀고 push 가 죽었다'],
  14: ['사고', '사람 개입 설계', '조정 세션이 사용자 판단을 대신해 계획에 없는 지시를 보냈다'],
  15: ['사고', '관찰', '관찰 결과 대신 코드를 읽은 예측을 보고해 두 번 틀렸다'],
  16: ['사고', '사람 개입 설계', '같은 경고가 매 회차 되풀이돼 사람이 볼 것이 묻혔다 (헛호출)'],
  17: ['사고 아님', null, '운영 결정 — 손으로 돌린 착륙을 분류기가 막았다'],
  18: ['사고 아님', null, '점검 결과 — 설계 당시 문서가 실제와 다름'],
  19: ['사고 아님', null, '점검 결과 — 금지선 대조'],
  20: ['사고 아님', null, '기능 설명 — precheck 의 프로젝트 한정 실행'],
  21: ['사고', '실행', '한도에 걸린 세션이 스스로 안 이어가고, 초기화 전 재개는 대기를 취소시켰다'],
  22: ['사고', '사람 개입 설계', '접기 담당이 규칙에 없어 끝난 계획 590줄이 파견마다 다시 읽혔다'],
  23: ['사고', '실행', '세션 재사용 설정 탓에 자동 회차 턴이 사용자 세션에 쌓였다'],
  24: ['사고', '사람 개입 설계', '도중 준비물을 `[결정 필요]` 로 적어 파견이 통째로 건너뛰었다'],
  25: ['사고', '판정', '파견 트리거가 커밋만 봐서 검토 전 계획이 파견됐다'],
  26: ['사고', '실행', '워커 셋의 서브에이전트가 겹쳐 떠 기계가 멈출 만큼 느려졌다'],
  27: ['사고', '실행', '규칙 사본이 갱신되지 않아 옛 규칙대로 도는 세션이 있었다'],
  28: ['사고 아님', null, '점검 결과 — 토큰 실측'],
  29: ['사고 아님', null, '사용자 요청 — 리뷰 비용 기록'],
  30: ['사고', '실행', '포트만 보고 조작하면 다른 앱·다른 워크트리에 쓰기가 갈 수 있었다'],
};

/* ─── 설정 ─────────────────────────────────────────────────────────────────── */

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

const cfg = loadConfig();
const excluded = ((re) => (t) => re.test(String(t || '')))(new RegExp(cfg.exclude.map(esc).join('|'), 'i'));
const substitute = ((pairs) => (t) => pairs.reduce((s, [re, to]) => s.replace(re, to), String(t)))(
  [...cfg.paths, ...cfg.replace].map(([from, to]) => [new RegExp(esc(from), 'g'), to])
);

/* ─── 반입 ─────────────────────────────────────────────────────────────────── */

const src = expand(fromArg || cfg.incidentSource || '');
if (!src || !existsSync(src)) {
  console.error('사고 사례 원본이 없다: ' + (src || '(설정에 incidentSource 가 없다)'));
  process.exit(2);
}

/** `| 3 | 2026-08-30 | … |` — 번호로 시작하는 표 행만. 머리글·구분선·본문은 아니다. */
const ROW_RE = /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/;

const rows = [];
for (const line of readFileSync(src, 'utf8').split(/\r?\n/)) {
  const m = line.trim().match(ROW_RE);
  if (m) rows.push({ n: Number(m[1]), date: m[2], text: m[3] });
}
if (!rows.length) {
  console.error('표 행을 하나도 못 읽었다 — 원본 형식이 바뀌었나: ' + src);
  process.exit(1);
}

const dropped = rows.filter((r) => excluded(r.n + ' ' + r.date + ' ' + r.text));
const kept = rows
  .filter((r) => !dropped.includes(r))
  .map((r) => {
    const [kind, stage, why] = LABELS[r.n] || ['미분류', null, null];
    return { n: r.n, date: substitute(r.date), kind, stage, why, text: substitute(r.text) };
  });

/** §4 — 하나라도 남으면 아무것도 쓰지 않는다. */
const leftovers = [];
for (const r of kept) {
  const hit = (r.text + ' ' + r.date).match(new RegExp(cfg.forbidden, 'gi'));
  if (hit) leftovers.push(r.n + ': ' + [...new Set(hit)].join(', '));
}

const stageRows = STAGES.map((stage) => ({
  stage,
  n: kept.filter((r) => r.stage === stage).length,
  cases: kept.filter((r) => r.stage === stage).map((r) => r.n),
}));
const incidents = kept.filter((r) => r.kind === '사고');
const notIncidents = kept.filter((r) => r.kind === '사고 아님');
const unlabeled = kept.filter((r) => r.kind === '미분류');

const out = {
  builtAt: new Date().toISOString(),
  note:
    '운영 저장소의 규칙 근거 표를 익명화해 들여온 것. 만든 것은 scripts/import-incidents.mjs (npm run import:incidents). ' +
    '원인 단계 라벨은 사람이 읽고 붙였다 — 근거는 각 행의 원문(익명화본).',
  source: { rows: rows.length, dropped: dropped.length, kept: kept.length, maxN: Math.max(...rows.map((r) => r.n)) },
  counts: {
    incidents: incidents.length,
    notIncidents: notIncidents.length,
    unlabeled: unlabeled.length,
    byKindNote: '표 행 수 ≠ 사고 수. 같은 표에 사용자 결정·점검 결과·기능 설명이 섞여 있다.',
  },
  stages: stageRows,
  notIncidentReasons: notIncidents.map((r) => ({ n: r.n, why: r.why })),
  cases: kept,
  anonymization: {
    droppedRows: dropped.map((r) => r.n),
    droppedWhy: '제외 목록 프로젝트의 이름이 든 행 — ANONYMIZATION.md §1 (이름만 지우지 않고 통째로 뺀다)',
    forbiddenHits: leftovers.length,
  },
};

/* ─── 출력 ─────────────────────────────────────────────────────────────────── */

console.log('# 사고 사례 반입 — ' + src.replace(homedir(), '~').replace(/\\/g, '/'));
console.log('원본 표 ' + rows.length + '행 (최대 번호 ' + out.source.maxN + ') · 제외로 뺀 행 ' + dropped.length + ' → 반입 ' + kept.length + '행\n');
console.log('| 갈래 | 수 |');
console.log('|---|---|');
console.log('| 사고 | ' + incidents.length + ' |');
console.log('| 사고 아님 (사용자 결정·점검 결과·기능 설명) | ' + notIncidents.length + ' |');
if (unlabeled.length) console.log('| **미분류 (라벨 표에 없는 번호)** | ' + unlabeled.length + ' |');

console.log('\n| 원인 단계 | 건수 | 번호 |');
console.log('|---|---|---|');
for (const s of stageRows) console.log(`| ${s.stage} | ${s.n} | ${s.cases.join(', ')} |`);

if (unlabeled.length) console.log('\n라벨 없는 번호: ' + unlabeled.map((r) => r.n).join(', ') + ' — LABELS 에 추가한다.');
if (dropped.length) console.log('\n제외로 뺀 행: ' + dropped.map((r) => r.n).join(', ') + ' (§1 — 이름만 지우지 않는다)');

if (leftovers.length) {
  console.error('\n금칙어가 남았다 — 아무것도 쓰지 않는다 (§4):');
  for (const l of leftovers) console.error('  ' + l);
  process.exit(1);
}
console.log('\n금칙어 스캔: 0건 (' + kept.length + '행)');

if (!dry) {
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('→ ' + OUT.replace(REPO, '').replace(/\\/g, '/').replace(/^\//, ''));
}
