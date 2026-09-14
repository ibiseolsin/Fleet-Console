// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanSlices, sliceNumberOf, renderSlices } from '../sp-sync.mjs';
// 슬라이스 36 — 계획 오류 판정은 파서 옆에 있다 (진입점은 안 손댄다).
import { foldedSliceNumbers } from '../lib/common.mjs';
// 진입점은 이번 슬라이스에서 손대지 않는다(4·6 과 병렬) — 새 헬퍼는 모듈에서 바로 가져온다.
import { sliceInPlan, resolveAgents, nextProjectAgent } from '../lib/fleet.mjs';

// 실제 PLAN.md 두 개(project-b, SP-sync)에서 뽑은 모양들.
const PLAN = `# PLAN — 예시

## 1단계 완료 (2026-08-28 ~ 08-29, e674e25..b0dc6bf) — 실사용 전 준비

슬라이스 1~7. 결과는 git 이력에 있다.

## 2단계 — 결과 처리

- [x] **7. 이미 끝난 것** \`[병렬 가능]\`
- [ ] **8. 작가 목소리 결정 — 남자(Vertex) 유지** \`[병렬 가능]\`
  완료 기준: config·PRD 두 곳에 같은 근거가 있다.
- [ ] **10. 리허설이 기억을 더럽히지 못하게** \`[어려움]\`
- [ ] **11. 실제 화자 전사 정답 + CER** \`[병렬 가능]\` — 사람 일 30분 포함
- [ ] **12. \`fleet land <프로젝트>\`** \`[결정 필요: 자동 push·머지 승인]\`
  — 착륙. 활성 워크스페이스마다.
- [ ] **13. STT 2.9초 — 어디서 나는가** — 지연 측정: **혼자 돌린다.** 11·12 뒤에
- [ ] **14. 파견** — 자격: \`[결정 필요]\` 는 건너뛰고 보고, \`[병렬 가능]\` 이면 간다
  - [ ] 하위 항목은 슬라이스가 아니다

## 3단계 — 나중에 정하는 것

- **스트리밍 STT** — 체크박스가 없으므로 단계가 아니다
`;

test('현재 단계 = 미체크가 있는 첫 절. 접힌 완료 단계와 체크박스 없는 절은 안 센다', () => {
  const r = parsePlanSlices(PLAN);
  assert.equal(r.phase.title, '2단계 — 결과 처리');
  assert.equal(r.phases.length, 1);
  assert.equal(r.phases[0].current, true);
  assert.deepEqual(
    r.slices.map((s) => s.number),
    [7, 8, 10, 11, 12, 13, 14]
  );
  assert.equal(r.slices.filter((s) => !s.done).length, 6);
});

test('들여쓴 체크박스는 슬라이스가 아니라 하위 항목이다', () => {
  assert.equal(parsePlanSlices(PLAN).slices.filter((s) => s.title.includes('하위 항목')).length, 0);
});

test('태그 — 제목 바로 뒤의 것만 센다', () => {
  const by = Object.fromEntries(parsePlanSlices(PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[8].tags, ['parallel']);
  assert.deepEqual(by[10].tags, ['hard']);
  assert.deepEqual(by[11].tags, ['parallel']); // 태그 뒤에 본문이 이어져도 잡힌다
  assert.deepEqual(by[12].tags, ['decision']);
  assert.equal(by[12].decision, '자동 push·머지 승인');
  assert.deepEqual(by[13].tags, []); // 제목 뒤가 바로 본문
});

test('본문이 인용한 태그는 그 슬라이스의 태그가 아니다', () => {
  // SP-sync 슬라이스 6 의 실제 모양 — 규칙을 설명하는 줄이지 태그가 아니다.
  const by = Object.fromEntries(parsePlanSlices(PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[14].tags, []);
});

test('제목은 태그·백틱을 뺀 것', () => {
  const by = Object.fromEntries(parsePlanSlices(PLAN).slices.map((s) => [s.number, s]));
  assert.equal(by[11].title, '실제 화자 전사 정답 + CER');
  assert.equal(by[12].title, 'fleet land <프로젝트>');
});

test('CRLF 로 저장된 PLAN.md 도 똑같이 읽는다', () => {
  const crlf = parsePlanSlices(PLAN.replace(/\n/g, '\r\n'));
  assert.equal(crlf.slices.length, 7);
  assert.equal(crlf.phase.title, '2단계 — 결과 처리');
  assert.deepEqual(crlf.slices.find((s) => s.number === 10).tags, ['hard']);
});

test('미체크가 하나도 없으면 마지막으로 슬라이스가 있던 절이 현재 단계', () => {
  const r = parsePlanSlices('## 슬라이스\n\n- [x] **1. 하나**\n- [x] **2. 둘**\n');
  assert.equal(r.phase.title, '슬라이스');
  assert.equal(r.slices.filter((s) => !s.done).length, 0);
});

test('슬라이스가 하나도 없으면 phase 는 null', () => {
  const r = parsePlanSlices('# 제목\n\n줄거리만 있는 문서.\n');
  assert.equal(r.phase, null);
  assert.deepEqual(r.slices, []);
});

test('### 소제목은 절을 가르지 않는다', () => {
  const r = parsePlanSlices('## 2단계\n\n- [ ] **1. 하나**\n\n### 곁가지\n\n- [ ] **2. 둘**\n');
  assert.equal(r.phases.length, 1);
  assert.equal(r.slices.length, 2);
});

test('브랜치·폴더 이름에서 슬라이스 번호 — 정확히 sliceN 일 때만', () => {
  assert.equal(sliceNumberOf('refs/heads/dev/slice11'), 11);
  assert.equal(sliceNumberOf('slice8'), 8);
  assert.equal(sliceNumberOf('slice-13'), 13);
  // 이름 안에 slice 가 섞인 브랜치를 슬라이스로 읽으면 엉뚱한 워크스페이스가 매핑된다
  assert.equal(sliceNumberOf('plan-slice-5-merge'), null);
  assert.equal(sliceNumberOf('tuskfish'), null);
  assert.equal(sliceNumberOf(''), null);
  // 앞의 후보가 없으면 뒤(폴더 경로)를 본다
  assert.equal(sliceNumberOf('tuskfish', 'C:/Users/x/orca/workspaces/P/slice9'), 9);
});

test('표에 번호·상태·태그·제목·워크스페이스가 모두 나온다', () => {
  const parsed = parsePlanSlices(PLAN);
  const ws = { name: 'slice11', path: 'C:/w/slice11', branch: 'dev/slice11', slice: 11, lastActivityAt: null, terminals: ['term_a'] };
  const slices = parsed.slices.map((s) => ({ ...s, workspace: s.number === 11 ? ws : null }));
  const out = renderSlices({ project: 'P', phase: parsed.phase, slices, workspaces: [ws], unmatched: [] });
  assert.match(out, /P {2}— {2}2단계 — 결과 처리/);
  assert.match(out, /11 .*\[ \].*slice11.*병렬 가능.*실제 화자 전사/);
  assert.match(out, /7 .*\[x\]/);
  assert.match(out, /미체크 6 · 워크스페이스 1 · 결정 대기 1/);
});

test('슬라이스로 안 읽힌 체크박스를 센다 — 구문 어긋남을 조용히 넘기지 않는다', () => {
  // Project A 2026-08-30. `###` 이 붙어 절 제목도 슬라이스도 아니게 됐다.
  const bad = ['# 계획', '', '## 슬라이스', '', '### - [ ] 슬라이스 1. 수집', '### - [x] 슬라이스 2. 요약'].join('\n');
  const r = parsePlanSlices(bad);
  assert.equal(r.slices.length, 0);
  assert.equal(r.strayChecks, 2);

  // 정상 계획의 하위 항목(들여쓴 체크박스)도 세지만, 슬라이스가 있으므로 판정에 안 쓰인다
  const good = ['## 슬라이스', '', '- [ ] **1. 수집** — 설명', '  - [ ] 하위 항목', '- [x] **2. 요약**'].join('\n');
  const g = parsePlanSlices(good);
  assert.equal(g.slices.length, 2);
  assert.equal(g.strayChecks, 1);
});

// 슬라이스 21 — `[선행: N, M]` 부분 의존과 모르는 태그
const DEPS_PLAN = [
  '## 슬라이스',
  '',
  '- [x] **3. 끝난 것**',
  '- [ ] **7. 부분 의존** `[선행: 3, 5]` — 본문',
  '- [ ] **8. 모르는 것이 먼저** `[오타태그]` `[병렬 가능]`',
  '- [ ] **9. 번호 없는 선행** `[선행: ]` — 오타',
  '- [ ] **10. 링크는 태그가 아니다** [문서](./doc.md) 참고',
].join('\n');

test('`[선행: 3, 5]` 에서 선행 번호 목록을 뽑는다', () => {
  const by = Object.fromEntries(parsePlanSlices(DEPS_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[7].tags, ['deps']);
  assert.deepEqual(by[7].deps, [3, 5]);
  assert.equal(by[7].title, '부분 의존');
  assert.deepEqual(by[7].unknownTags, []);
});

test('모르는 태그가 먼저 와도 연쇄가 안 끊긴다 — 뒤의 [병렬 가능] 을 여전히 읽는다', () => {
  const by = Object.fromEntries(parsePlanSlices(DEPS_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[8].tags, ['parallel']);
  assert.deepEqual(by[8].unknownTags, ['오타태그']); // 조용히 무시하면 오타가 영영 안 보인다
});

test('번호가 없는 `[선행: ]` 은 태그가 아니라 모르는 태그다 — 오타가 자격을 넓히면 안 된다', () => {
  const by = Object.fromEntries(parsePlanSlices(DEPS_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[9].tags, []);
  assert.deepEqual(by[9].deps, []);
  assert.equal(by[9].unknownTags.length, 1);
});

test('마크다운 링크는 모르는 태그로 세지 않는다', () => {
  const by = Object.fromEntries(parsePlanSlices(DEPS_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[10].tags, []);
  assert.deepEqual(by[10].unknownTags, []);
});

test('표의 태그 열에 선행이, 밑에 계획 오류 목록이 난다', () => {
  const parsed = parsePlanSlices(DEPS_PLAN);
  const out = renderSlices({
    project: 'P',
    phase: parsed.phase,
    slices: parsed.slices.map((s) => ({ ...s, workspace: null })),
    workspaces: [],
    unmatched: [],
  });
  assert.match(out, /7 .*\[ \].*선행: 3, 5/);
  // 파견이 보는 것과 **같은 목록**이다 — 검토에서 통과인데 파견이 막는 일이 없게.
  assert.ok(out.includes('계획 오류 3건'));
  assert.ok(out.includes('8번 (5줄) unknown-tag — 모르는 태그 [오타태그]'));
  assert.ok(out.includes('9번 (6줄) unknown-tag — 모르는 태그 [선행:]'));
  // `[선행: 3, 5]` 의 5 는 파일 어디에도 없다 — 예전에는 '접힌 지난 단계겠지'로 넘어갔다.
  assert.ok(out.includes('7번 (4줄) missing-prereq — 선행 5번이 계획에 없음'));
});

// --- 슬라이스 3: 단계 경계에서 번호를 잃지 않는다 ---
// 워커가 자기 절의 **마지막** 슬라이스를 체크하면 그 절에 미체크가 하나도 안 남아 "현재 단계"가
// 다음 절로 넘어간다. 착륙·트리거가 현재 단계에서만 번호를 찾으면 그 순간 "N번이 없음"으로 막힌다.
const TWO_PHASES = `# PLAN

## 3단계 — 정리

- [x] **1. 첫**
- [x] **2. 마지막** [병렬 가능]

## 4단계 — 다음

- [ ] **3. 새 것**
- [ ] **4. 그 다음**
`;

test('현재 단계는 미체크가 남은 절이다 — 다 체크한 절은 넘어간다', () => {
  const parsed = parsePlanSlices(TWO_PHASES);
  assert.equal(parsed.phase.title, '4단계 — 다음');
  assert.deepEqual(parsed.slices.map((s) => s.number), [3, 4]);
  // 모든 절의 슬라이스는 따로 남는다 — 착륙·트리거가 여기서 찾는다
  assert.deepEqual(parsed.allSlices.map((s) => s.number), [1, 2, 3, 4]);
});

test('번호 찾기는 모든 절을 본다 — 방금 끝낸 절의 슬라이스도 찾는다', () => {
  const parsed = parsePlanSlices(TWO_PHASES);
  // 2번은 현재 단계에 없다. 그래도 찾아야 착륙이 "2번이 없음"으로 막히지 않는다.
  assert.equal(sliceInPlan(parsed, 2).done, true);
  assert.equal(sliceInPlan(parsed, 2).title, '마지막');
  // 현재 단계의 번호는 그대로
  assert.equal(sliceInPlan(parsed, 3).done, false);
  assert.equal(sliceInPlan(parsed, 9), null);
  assert.equal(sliceInPlan(parsed, null), null);
});

test('번호가 절마다 겹치면 현재 단계 → 그 앞 절의 마지막 순으로 고른다', () => {
  const parsed = parsePlanSlices(`# PLAN

## 1단계

- [x] **1. 옛 1번**

## 2단계

- [x] **1. 새 1번**
- [x] **2. 끝**

## 3단계

- [ ] **1. 앞으로의 1번**
`);
  // 현재 단계(3단계)에 있으면 그것
  assert.equal(sliceInPlan(parsed, 1).title, '앞으로의 1번');
  // 현재 단계에 없는 번호는 현재 단계보다 **앞선** 절 중 마지막 것 — 방금 끝낸 절이 거기다
  assert.equal(sliceInPlan(parsed, 2).title, '끝');
});

// --- 4단계 슬라이스 1: `[에이전트: <이름>]` ---
const AGENT_PLAN = [
  '## 4단계',
  '',
  '- [ ] **1. 그냥 클로드**',
  '- [ ] **2. 헤드리스** `[에이전트: codex]` `[선행: 1]` — 본문',
  '- [ ] **3. 이름이 빔** `[에이전트: ]`',
  '- [ ] **4. 다른 것** `[어려움]` `[에이전트: antigravity]`',
].join('\n');

test('`[에이전트: codex]` 에서 이름을 뽑고, 뒤의 태그 연쇄도 안 끊는다', () => {
  const by = Object.fromEntries(parsePlanSlices(AGENT_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[2].tags, ['agent', 'deps']);
  assert.equal(by[2].agent, 'codex');
  assert.deepEqual(by[2].deps, [1]);
  assert.equal(by[2].title, '헤드리스'); // 제목에서 태그가 빠진다
  // 태그가 없으면 파서는 이름을 만들지 않는다 — 기본값 채우기는 resolveAgents 몫이다
  assert.equal(by[1].agent, null);
  assert.deepEqual(by[4].tags, ['hard', 'agent']);
  assert.equal(by[4].agent, 'antigravity');
});

test('이름이 빈 `[에이전트: ]` 은 태그가 아니라 모르는 태그다 — 조용히 claude 로 떨어지면 안 된다', () => {
  const by = Object.fromEntries(parsePlanSlices(AGENT_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[3].tags, []);
  assert.equal(by[3].agent, null);
  assert.deepEqual(by[3].unknownTags, ['에이전트:']);
});

test('에이전트 결정 순서 — 태그 > 프로젝트 기본값 > claude', () => {
  const agents = { codex: { command: 'codex' }, antigravity: { command: 'agy' } };
  const slices = parsePlanSlices(AGENT_PLAN).slices;
  const plain = Object.fromEntries(resolveAgents(slices, { agents }).map((s) => [s.number, s]));
  assert.equal(plain[1].agent, 'claude'); // 기본값이 없으면 지금 동작 그대로
  assert.equal(plain[2].agent, 'codex');
  assert.equal(plain[1].agentUnknown, false);

  const byProject = Object.fromEntries(resolveAgents(slices, { projectAgent: 'codex', agents }).map((s) => [s.number, s]));
  assert.equal(byProject[1].agent, 'codex'); // 태그가 없는 슬라이스는 프로젝트 기본값
  assert.equal(byProject[4].agent, 'antigravity'); // 태그가 이긴다

  // 프로필에 없는 이름은 표시만 하고 막지는 않는다 — 보류는 dispatchPlan 이 정한다
  const unknown = resolveAgents(slices, { projectAgent: 'opencode', agents });
  assert.equal(unknown[0].agentUnknown, true);
  assert.equal(unknown[0].agent, 'opencode');
});

test('표에 에이전트 열이 나온다 — claude 는 빈 칸, 모르는 이름에는 ?', () => {
  const slices = resolveAgents(parsePlanSlices(AGENT_PLAN).slices, { agents: { codex: { command: 'codex' } } }).map((s) => ({
    ...s,
    workspace: null,
  }));
  const out = renderSlices({ project: 'P', phase: { title: '4단계' }, slices, workspaces: [], unmatched: [] });
  assert.match(out, /2 .*\[ \].*codex.*선행: 1/);
  assert.match(out, /4 .*antigravity \?.*어려움/); // 프로필에 없는 이름
  // 이름은 제 열에만 — 태그 열에 또 쓰면 그만큼 다른 태그가 잘린다
  assert.doesNotMatch(out, /에이전트: codex/);
  assert.doesNotMatch(out, /claude/); // 기본 에이전트는 표에 안 쓴다
});

test('nextProjectAgent: claude 는 키를 지우고, 대소문자 다른 옛 키는 합쳐지고, 모르는 이름은 거부', () => {
  const agents = { codex: { cmd: 'codex', args: [] } };
  // 기본값에서 codex 로
  let r = nextProjectAgent({}, 'Project X', 'codex', agents);
  assert.deepEqual(r, { map: { 'Project X': 'codex' }, project: 'Project X', agent: 'codex', prev: 'claude', changed: true });
  // 같은 값이면 changed 아님
  r = nextProjectAgent(r.map, 'Project X', 'codex', agents);
  assert.equal(r.changed, false);
  // claude 로 되돌리면 키가 사라진다 — "비어 있으면 claude" 한 모양만 남긴다
  r = nextProjectAgent(r.map, 'Project X', 'claude', agents);
  assert.deepEqual(r.map, {});
  assert.equal(r.prev, 'codex');
  assert.equal(r.changed, true);
  // 손으로 적어 둔 소문자 키는 새 키로 합쳐진다 — 둘이 나란히 남으면 파견마다 어느 쪽을 읽을지 갈린다
  r = nextProjectAgent({ 'project a': 'codex', 'SP-sync': 'codex' }, 'Project A', 'codex', agents);
  assert.deepEqual(r.map, { 'SP-sync': 'codex', 'Project A': 'codex' });
  assert.equal(r.changed, false);
  // 다른 프로젝트는 건드리지 않는다
  r = nextProjectAgent({ 'SP-sync': 'codex' }, 'coordinator', 'claude', agents);
  assert.deepEqual(r.map, { 'SP-sync': 'codex' });
  assert.equal(r.changed, false);
  // 프로필에 없는 이름은 거부 — 넣으면 그 프로젝트 슬라이스가 전부 "모르는 에이전트" 로 보류된다
  assert.throws(() => nextProjectAgent({}, 'coordinator', 'gemini', agents), /모르는 에이전트: gemini/);
  assert.throws(() => nextProjectAgent({}, 'coordinator', '', agents), /에이전트 이름이 필요/);
});

// --- 슬라이스 36: 계획 오류 셋 ---
// coordinator 점검 #2 — 오타 하나가 조용히 기본값(승인 없이 실행·선행 완료)으로 읽히던 자리.
const ERROR_PLAN = `# PLAN

## 3단계 완료 (2026-09-01, 슬라이스 1~7 — 접힌 단계. 본문은 PLAN-archive.md)

## 8단계 — 지금

- [ ] **10. 접힌 선행** [선행: 3]
- [ ] **11. 오타 태그** [결정필요: 승인]
- [ ] **12. 없는 선행** [선행: 999]
- [ ] **13. 중복** [병렬 가능]
- [ ] **13. 중복 둘째** [병렬 가능]
`;

test('접힌 단계 제목의 범위에 있는 선행은 통과한다 — PLAN-archive.md 를 안 읽고도', () => {
  const r = parsePlanSlices(ERROR_PLAN);
  const byLine = Object.fromEntries(r.slices.map((s) => [s.line, s]));
  assert.deepEqual(byLine[7].errors || [], []); // `[선행: 3]` — 접힌 3단계의 1~7 안이다
});

test('모르는 태그·없는 선행·중복 번호가 계획 오류로 난다', () => {
  const r = parsePlanSlices(ERROR_PLAN);
  const kinds = (n) => r.errors.filter((e) => e.slice === n).map((e) => e.kind);
  assert.deepEqual(kinds(10), []);
  assert.deepEqual(kinds(11), ['unknown-tag']); // `[결정필요: 승인]` — 승인 대기를 의도한 오타
  assert.deepEqual(kinds(12), ['missing-prereq']); // 999 는 접힌 범위(1~7)에도 없다
  assert.deepEqual(kinds(13), ['dup-number', 'dup-number']); // **둘 다** 막는다
  assert.ok(r.errors.find((e) => e.kind === 'dup-number').detail.includes('번호 13 중복 — 2곳'));
  // 같은 객체가 슬라이스에도 붙어 있다 — 파견은 슬라이스 하나만 보면 된다
  const byLine = Object.fromEntries(r.slices.map((s) => [s.line, s]));
  assert.equal(byLine[8].errors[0].kind, 'unknown-tag');
  assert.equal(byLine[10].errors.length, 1);
  assert.equal(byLine[11].errors.length, 1);
});

test('접힌 제목의 날짜 범위는 슬라이스 번호가 아니다', () => {
  // `(2026-08-30~31, 슬라이스 5~24 — …)` — `슬라이스` 뒤에 붙은 숫자만 센다.
  const n = foldedSliceNumbers('## 2단계 완료 (2026-08-30~31, 슬라이스 5~24 — 파견)');
  assert.equal(n.has(5) && n.has(24), true);
  assert.equal(n.has(2026), false);
  assert.equal(n.has(30), false);
  assert.equal(n.has(4), false);
});

// ---------- 슬라이스 42 — `[자원: 이름, …]` ----------
const RES_PLAN = `## 1단계

- [ ] **1. 폰 실측** \`[병렬 가능]\` \`[자원: 폰, 마이크]\`
- [ ] **2. 이름 접기** \`[자원:  폰 , 폰 ]\`
- [ ] **3. 빈 값** \`[자원: ]\` \`[병렬 가능]\`
- [ ] **4. 콜론 없는 오타** \`[자원 폰]\`
`;

test('`[자원: 폰, 마이크]` 는 쉼표로 갈리고 공백이 털린다', () => {
  const by = Object.fromEntries(parsePlanSlices(RES_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[1].resources, ['폰', '마이크']);
  assert.deepEqual(by[1].tags, ['parallel', 'resources']); // 연쇄가 안 끊긴다
  assert.deepEqual(by[1].unknownTags, []);
});

test('같은 이름이 두 번 오면 `normTitle` 로 접어 한 번만 센다', () => {
  const by = Object.fromEntries(parsePlanSlices(RES_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[2].resources, ['폰']);
});

test('이름이 빈 `[자원: ]` 은 태그가 아니라 모르는 태그다 — 오타가 배타를 풀면 안 된다', () => {
  const by = Object.fromEntries(parsePlanSlices(RES_PLAN).slices.map((s) => [s.number, s]));
  assert.deepEqual(by[3].resources, []);
  assert.deepEqual(by[3].tags, ['parallel']); // 뒤의 아는 태그는 그대로 읽힌다
  assert.deepEqual(by[3].unknownTags, ['자원:']);
});

test('콜론을 빠뜨린 `[자원 폰]` 은 모르는 태그 — 계획 오류로 그 슬라이스가 안 뜬다', () => {
  const r = parsePlanSlices(RES_PLAN);
  const by = Object.fromEntries(r.slices.map((s) => [s.number, s]));
  assert.deepEqual(by[4].resources, []);
  assert.deepEqual(by[4].unknownTags, ['자원 폰']);
  assert.equal(by[4].errors[0].kind, 'unknown-tag');
});

test('표의 태그 열에 자원 이름이 그대로 난다', () => {
  const parsed = parsePlanSlices(RES_PLAN);
  const out = renderSlices({ project: 'P', phase: parsed.phase, slices: parsed.slices, workspaces: [], unmatched: [], errors: parsed.errors });
  // 2번 줄은 태그가 하나뿐이라 24칸에 다 들어간다. 1번은 `병렬 가능 · 자원: 폰, 마이크` 라 열 너비에서 잘린다.
  assert.ok(out.includes('자원: 폰'));
});
