/**
 * 회차별 시간·토큰 (슬라이스 6) — `/eval` 화면과 확인 스크립트가 읽는 쪽.
 *
 * 기존 측정치는 **프로젝트·주 단위**라 회차별이 없다 (`PLAN.md` 슬라이스 6의 함정 메모).
 * 그래서 `scripts/import-usage.mjs` 가 회차 시각 범위로 두 가지를 새로 묶는다:
 *
 *   시간  — 플릿 로그의 줄 시각. 회차 제목 시각(시작)부터 보고를 쓴 줄(끝)까지가 한 회차이고,
 *          그 사이의 실행 줄(착륙·재개·인계·파견)이 구간을 가른다.
 *   토큰  — 에이전트 세션 기록의 assistant 메시지. 회차 시각 범위로 묶는다.
 *
 * 이 파일은 **읽기만** 한다. 계측 파일이 없으면 `null` 이다 — 원본(로컬 로그·세션 기록)이 없는
 * 기계에서도 화면이 떠야 하기 때문이다 (`data/usage/cycles.json` 은 반입해 커밋한 결과물이다).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE_FILE = join(REPO, 'data', 'usage', 'cycles.json');

/**
 * 단계 이름과 순서. sp-sync 의 회차가 도는 순서 그대로다 —
 * 본체 동기화 → 착륙 → 재개 → 인계 → 파견 (`sp-sync/lib/fleet.mjs` 의 `cycleProject`).
 *
 * **구간은 그것을 끝낸 로그 줄의 이름을 쓴다.** 플릿 로그는 단계가 *끝날 때* 한 줄을 남기지
 * 시작할 때는 안 남긴다. 그래서 `파견 3분` 은 "파견 줄 앞의 3분" 이고 거기에는 그 파견을 하기
 * 전의 관찰·판정이 얼마간 섞여 있다. 못 가른 것을 가른 척하지 않으려고 이름을 그렇게 지었다.
 *
 * 마지막 구간이 `관찰·기록` 인 것도 같은 이유다 — 마지막 실행 줄부터 보고를 쓴 줄까지는
 * 남은 프로젝트의 관찰·판정과 보고 쓰기가 함께 들어 있고, 아무 실행도 없던 회차는 통째로 이것이다.
 */
const STAGES = ['착륙', '재개', '인계', '파견', '관찰·기록'];

/** 토큰 네 갈래. 캐시 읽기가 대개 전체의 대부분이라 따로 세지 않으면 나머지가 안 보인다. */
const TOKEN_KEYS = ['in', 'out', 'cacheCreate', 'cacheRead'];

/** 계측 파일. 없으면 `null` — 부른 쪽이 "계측 없음" 을 그린다. */
function readUsage(file = USAGE_FILE) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 회차 slug → 계측 한 줄. `/runs/<slug>` 상세가 쓴다. */
function usageOf(usage, slug) {
  if (!usage) return null;
  return usage.cycles.find((c) => c.slug === slug) || null;
}

/** 그 회차에서 가장 오래 걸린 단계. 시간이 없으면 `null`. */
function slowestStage(cycle) {
  if (!cycle || !cycle.stages) return null;
  const rows = Object.entries(cycle.stages).filter(([, ms]) => ms > 0);
  if (!rows.length) return null;
  return rows.sort((a, b) => b[1] - a[1])[0];
}

/** 단계별 합계 — 회차 전체를 가로질러 어느 단계가 병목인지 (`PRD.md §6` 비용·시간 패널). */
function stageTotals(cycles) {
  const total = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let counted = 0;
  for (const c of cycles) {
    if (!c.stages) continue;
    counted++;
    for (const [k, ms] of Object.entries(c.stages)) total[k] = (total[k] || 0) + ms;
  }
  const sum = Object.values(total).reduce((a, b) => a + b, 0);
  return {
    counted,
    sum,
    rows: STAGES.map((s) => ({ stage: s, ms: total[s] || 0, pct: sum ? ((total[s] || 0) / sum) * 100 : 0 })),
  };
}

/** `93000` → `1분 33초`. 표에 초 단위 숫자를 그대로 쓰면 회차끼리 비교가 안 된다. */
function fmtMs(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + '초' : Math.floor(s / 60) + '분 ' + String(s % 60) + '초';
}

/** `1234567` → `1.23M`. 회차별 토큰은 자릿수가 갈려서 그대로 쓰면 표가 안 읽힌다. */
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

const tokenSum = (t) => (t ? TOKEN_KEYS.reduce((a, k) => a + (t[k] || 0), 0) : 0);

export { STAGES, TOKEN_KEYS, USAGE_FILE, fmtMs, fmtTokens, readUsage, slowestStage, stageTotals, tokenSum, usageOf };
