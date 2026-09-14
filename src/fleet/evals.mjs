/**
 * 평가 결과 읽기 (슬라이스 10) — `/eval` 화면이 네 표를 그리는 재료.
 *
 * 네 파일 다 스크립트가 만들어 커밋한 결과물이다. 화면은 **읽기만** 한다 — `data/usage/cycles.json`
 * 과 같은 꼴이고, 이유도 같다: 픽스처도 운영 기록도 없는 기계에서 링크만으로 화면이 떠야 한다.
 *
 *   data/eval/scenarios.json   `npm run eval`            시나리오 재생 일치 (슬라이스 8)
 *   data/eval/settings.json    `npm run eval:settings`   세팅 비교 (슬라이스 9)
 *   data/eval/coverage.json    `npm run eval:coverage`   사유 분류 커버리지 · 헛호출 (슬라이스 10)
 *   data/eval/incidents.json   `npm run import:incidents` 사고 분류 (슬라이스 10)
 *
 * 없으면 `null` 이다 — 부른 쪽이 "아직 안 돌렸다" 를 그린다. 여기서 수를 지어내지 않는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_DIR = join(REPO, 'data', 'eval');

/** 파일 이름 → 그것을 만드는 명령. 화면의 "없음" 안내에 그대로 쓴다. */
const EVAL_FILES = {
  scenarios: 'npm run eval',
  settings: 'npm run eval:settings',
  coverage: 'npm run eval:coverage',
  incidents: 'npm run import:incidents',
};

function readEval(name, dir = EVAL_DIR) {
  const file = join(dir, name + '.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 넷을 한 번에. 없는 것은 `null` 이다. */
const readEvals = (dir = EVAL_DIR) =>
  Object.fromEntries(Object.keys(EVAL_FILES).map((k) => [k, readEval(k, dir)]));

/** 재생 일치율 — 재생한 것 중 일치한 비율. **재생 불가는 분모에서 뺀다** (슬라이스 8과 같은 셈). */
const matchRate = (scenarios) =>
  scenarios && scenarios.counts.replayed ? (scenarios.counts.matched / scenarios.counts.replayed) * 100 : null;

export { EVAL_DIR, EVAL_FILES, matchRate, readEval, readEvals };
