#!/usr/bin/env node
/**
 * 계측 파일이 스스로 모순되지 않는지 (슬라이스 6).
 *
 *   node scripts/usage-check.mjs
 *
 * 반입(`import-usage.mjs`)은 원본(플릿 로그·세션 기록)이 있는 기계에서만 돌지만, **커밋된
 * 결과물**(`data/usage/cycles.json`)은 어디서나 확인할 수 있어야 한다. 화면이 그 파일 하나를
 * 그대로 그리므로, 파일이 회차 목록과 어긋나면 화면도 같이 어긋난다.
 *
 * 보는 것 다섯:
 *  1) 모든 회차 slug 가 `data/runs/` 의 회차와 짝이 맞는다 (없는 회차를 그리지 않는다).
 *  2) 단계 시간의 합 = 그 회차의 소요 시간 (구간을 흘리거나 겹쳐 세지 않았다).
 *  3) 시간·토큰이 음수가 아니고 회차 상한(30분) 안이다.
 *  4) 프로젝트별 **절대치**가 파일에 없다 (`ANONYMIZATION.md §2` — 비중만 낸다).
 *  5) 반입 보고서가 있다 (공개 전 승인에 낼 근거, §0).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuns, runSlug } from '../src/fleet/runs.mjs';
import { STAGES, readUsage } from '../src/fleet/usage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(REPO, 'data', 'usage-report.md');
const MAX_CYCLE_MS = 30 * 60 * 1000;

const fails = [];
const check = (ok, what, detail = '') => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + what + (detail ? ' — ' + detail : ''));
  if (!ok) fails.push(what);
};

const usage = readUsage();
if (!usage) {
  console.error('계측 파일이 없다 — npm run import:usage 로 반입한다 (원본이 있는 기계에서만).');
  process.exit(2);
}

const runs = readRuns({ dir: join(REPO, 'data', 'runs'), limit: Number.MAX_SAFE_INTEGER }).runs;
const slugs = new Set(runs.map(runSlug));
const timed = usage.cycles.filter((c) => c.ms != null);
const tokened = usage.cycles.filter((c) => c.tokens);

console.log('계측 — 회차 ' + usage.cycles.length + '개 (시간 ' + timed.length + ' · 토큰 ' + tokened.length + ') · 회차 기록 ' + slugs.size + '개');

const orphans = usage.cycles.filter((c) => !slugs.has(c.slug));
check(!orphans.length, '모든 회차가 기록과 짝이 맞는다', orphans.length ? '짝 없음 ' + orphans.slice(0, 3).map((c) => c.slug).join(', ') : usage.cycles.length + '개');

const badStages = timed.filter((c) => {
  const sum = Object.values(c.stages || {}).reduce((a, b) => a + b, 0);
  return sum !== c.ms;
});
check(!badStages.length, '단계 시간의 합 = 회차 소요', badStages.length ? '어긋남 ' + badStages.length + '개' : timed.length + '개 전부');

const unknown = timed.filter((c) => Object.keys(c.stages || {}).some((k) => !STAGES.includes(k)));
check(!unknown.length, '모르는 단계 이름이 없다', STAGES.join(' · '));

const badMs = timed.filter((c) => !(c.ms >= 0 && c.ms <= MAX_CYCLE_MS));
check(!badMs.length, '소요가 0 이상 30분 이하', badMs.length ? '벗어남 ' + badMs.length + '개' : '최대 ' + Math.round(Math.max(...timed.map((c) => c.ms)) / 1000) + '초');

const badTok = tokened.filter((c) => Object.values(c.tokens).some((n) => !(Number.isFinite(n) && n >= 0)));
check(!badTok.length, '토큰이 음수가 아니다', badTok.length ? '벗어남 ' + badTok.length + '개' : tokened.length + '개 전부');

// §2 — 프로젝트별 절대치는 내지 않는다. 회차 단위 합계(플릿 전체)만 파일에 있어야 한다.
const text = JSON.stringify(usage);
const leaked = usage.cycles.some((c) => c.byProject || c.projects || c.project);
check(!leaked && !/"byProject"/.test(text), '프로젝트별 절대치가 파일에 없다', '회차 단위 합계만 (ANONYMIZATION.md §2)');

check(existsSync(REPORT), '반입 보고서가 있다', 'data/usage-report.md');
if (existsSync(REPORT)) {
  const r = readFileSync(REPORT, 'utf8');
  check(/금칙어 스캔 \| \*\*0건\*\*/.test(r), '보고서에 금칙어 스캔 0건이 적혀 있다');
  check(/토큰 비중/.test(r) && !/토큰 합계 \|/.test(r.split('## 프로젝트별')[1] || ''), '프로젝트별은 비중만 적혀 있다');
}

console.log('');
if (fails.length) {
  console.error('실패 ' + fails.length + '건: ' + fails.join(' · '));
  process.exit(1);
}
console.log('통과 — 계측 파일이 회차 기록과 맞고, 프로젝트별 절대치는 없다.');
