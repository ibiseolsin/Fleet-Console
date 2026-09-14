#!/usr/bin/env node
// 벤더링한 sp-sync 의 판정 함수가 이 저장소에서 그대로 돈다는 것만 보인다 (슬라이스 1 완료 기준).
//   node scripts/dispatch-demo.mjs
// `dispatchPlan` 은 부수효과가 없다 — 계획 텍스트와 워크스페이스 목록을 받아 슬라이스마다
// "띄운다 / 안 띄운다 + 사유" 를 낸다. 디스크도 실제 플릿도 건드리지 않는다.
import { parsePlanSlices } from '../sp-sync/lib/common.mjs';
import { dispatchPlan } from '../sp-sync/lib/fleet.mjs';

const PLAN = `# 작업계획

## 1단계

- [x] **1. 뼈대**
- [ ] **2. 읽기 도구** [병렬 가능]
- [ ] **3. 쓰기 도구** [결정 필요: 승인 게이트 위치]
- [ ] **4. 화면** [선행: 3]
- [ ] **5. 계측**
`;

const { phase, slices, allSlices } = parsePlanSlices(PLAN);
const plan = dispatchPlan({
  slices,
  allSlices,
  workspaces: [],   // 지금 떠 있는 워크스페이스 없음
  max: 3,           // 프로젝트당 동시 상한
  block: null,
  limitHold: null,
  project: 'demo',
});

console.log('단계: ' + (phase?.title || '(없음)') + ' — 슬라이스 ' + slices.length + '개\n');
for (const d of plan) {
  const n = d.slice.number ?? '?';
  console.log((d.eligible ? '  파견 ' : '  보류 ') + n + '. ' + d.slice.title + (d.eligible ? '' : ' — ' + d.reason));
}
