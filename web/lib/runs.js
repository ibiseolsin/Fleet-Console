/**
 * 화면이 쓰는 회차 기록 — 파서는 `src/fleet/runs.mjs` 하나다 (도구와 같은 것).
 *
 * 읽는 곳은 `data/runs/` — 슬라이스 5가 익명화해 반입한 **실제 운영 기록**이다.
 * `sandbox/runs/` 는 픽스처가 만든 것이라 화면이 보지 않는다.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRuns, runSlug } from '../../src/fleet/runs.mjs';

/** `next dev`·`next start` 는 `web/` 에서 돈다. 저장소 루트에서 돌린 경우도 받아 준다. */
function runsDir() {
  const here = process.cwd();
  const up = resolve(here, '..', 'data', 'runs');
  return existsSync(up) ? up : join(here, 'data', 'runs');
}

/** 표 넷의 이름과, 회차 상세에서 묶이는 단계. `renderCycleReport` 가 쓰는 이름 그대로다. */
const STAGES = [
  { key: '관찰', title: '관찰', hint: '이번 회차가 무엇을 봤나', tables: [] },
  { key: '판정', title: '자격 판정', hint: '규칙이 무엇을 왜 막았나', tables: ['막힘', '결정 필요'] },
  { key: '실행', title: '실행', hint: '실제로 무엇을 했나', tables: ['착륙', '파견'] },
];

const COUNT_KEYS = ['착륙', '파견', '막힘', '결정 필요'];

/** 반입한 회차 전부, 최신 먼저. 회차가 241개라 한 번에 읽어도 가볍다. */
function allRuns() {
  const data = readRuns({ dir: runsDir(), limit: Number.MAX_SAFE_INTEGER });
  return { ...data, runs: data.runs.map((r) => ({ ...r, slug: runSlug(r) })) };
}

function findRun(slug) {
  return allRuns().runs.find((r) => r.slug === slug) || null;
}

/** 날짜별 묶음 — 목록 화면이 날짜 단위로 접어 보여준다. */
function byDate(runs) {
  const map = new Map();
  for (const r of runs) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  return [...map.entries()].map(([date, list]) => ({
    date,
    runs: list,
    counts: COUNT_KEYS.reduce((a, k) => ({ ...a, [k]: list.reduce((n, r) => n + (r.counts[k] || 0), 0) }), {}),
  }));
}

export { COUNT_KEYS, STAGES, allRuns, byDate, findRun };
