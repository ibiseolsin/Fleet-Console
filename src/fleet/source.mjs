/**
 * 관찰 + 자격 판정 층 (슬라이스 3) — 읽기 도구 셋이 쓰는 재료를 한 곳에서 만든다.
 *
 * **판정 규칙은 여기서 만들지 않는다.** `landCheck` · `dispatchPlan` · `resumePlan` 이 낸 결과를
 * 그대로 실어 나르고, 도구가 쓸 수 있게 **사유에 코드를 붙이는 것**만 한다 (`holdOf`).
 * 사유 문장 자체는 sp-sync 의 것을 손대지 않는다 — 문장을 다시 쓰면 화면과 실제 판정이 갈린다.
 *
 * 대상은 저장소 안의 샌드박스 픽스처뿐이다 (`PRD.md §7` — 배포본은 남의 저장소를 건드리지 않는다).
 * 픽스처는 `scripts/fixture.mjs` 가 만들고 이 파일은 **읽기만** 한다.
 */
import { normPath } from '../../sp-sync/lib/common.mjs';
import { headlessOf, landCheck, dispatchPlan } from '../../sp-sync/lib/fleet.mjs';
import { resumePlan } from '../../sp-sync/lib/resume.mjs';
import { fixtureSlices, loadFixture } from '../../scripts/fixture.mjs';

/** 착륙 판정에 넘기는 값. 픽스처의 원격은 bare 저장소 하나라 base 는 `origin/main` 고정이다. */
const LAND_OPTS = { baseRef: 'origin/main', quietMs: 120000, idleMs: 5000 };

/** `fleetResumeMax` 기본값. 재개 시도 상한 — 넘으면 `exhausted` 로 사람에게 올라간다. */
const RESUME_MAX = 2;

/**
 * 동시 상한을 정한다 (슬라이스 9). 기본은 픽스처 정의(`fx.max(project)`)이고, `caps` 를 주면
 * 그것이 이긴다 — 수 하나면 모든 프로젝트에 같은 값, 객체면 프로젝트별이고 없는 프로젝트는
 * 픽스처 정의로 떨어진다. **픽스처를 바꾸지 않는다** — 세팅만 갈아 끼우는 자리다.
 */
function capOf(project, fx, caps) {
  if (caps == null) return fx.max(project);
  const v = typeof caps === 'object' ? caps[project] : caps;
  return Number.isFinite(v) && v > 0 ? v : fx.max(project);
}

/**
 * 파견 보류 사유 → 코드. 사유 문장은 사람이 읽는 것이고, 코드는 도구를 부른 쪽이 **거르고 세는**
 * 자리다. 앞머리로 가른다 — sp-sync 가 사유 뒤에 붙이는 꼬리(모르는 태그·재파견 보류)를 넘기려고.
 * 못 알아본 사유는 `other` 로 두고 문장을 그대로 싣는다: 여기서 문장을 지어내면 안 된다.
 */
const HOLD_CODES = [
  ['계획 오류', 'plan-error'],
  ['결정 필요', 'decision'],
  ['선행 미완', 'deps-undone'],
  ['이미 돌고 있음', 'running'],
  ['동시 상한', 'cap-project'],
  ['전역 상한', 'cap-global'],
  ['한도 임박', 'limit-hold'],
  ['모르는 에이전트', 'unknown-agent'],
  ['자원 점유', 'resource-held'],
  ['제목에 번호가 없어', 'no-number'],
  ['병렬 태그가 없어', 'solo'],
];

/** 사유가 `N번이 혼자 돌아야 함` · `N번이 먼저` 처럼 번호로 시작하는 것들. 앞머리로는 못 가른다. */
const HOLD_PATTERNS = [
  [/혼자 돌아야 함/, 'solo'],
  [/^\d+번이 먼저/, 'order'],
  [/^앞의 (?:비병렬 )?슬라이스가 먼저/, 'order'],
];

function holdOf(reason) {
  const r = String(reason || '');
  const byPrefix = HOLD_CODES.find(([k]) => r.startsWith(k));
  if (byPrefix) return byPrefix[1];
  const byPattern = HOLD_PATTERNS.find(([re]) => re.test(r));
  return byPattern ? byPattern[1] : 'other';
}

/**
 * 착륙 판정 한 줄 → 상태 한 낱말. `landCheck` 는 `ready`·`blocked` 두 깃발만 주는데, 둘 다 아닌
 * 것이 둘이다 — 아직 도는 중(`busy`)과 워커가 답을 기다리는 것(`waiting`). 화면과 도구가
 * 같은 낱말을 써야 "막힘 3건" 이 어디서나 같은 3건이 된다.
 */
function workspaceState(check) {
  if (check.blocked) return 'blocked';
  if (check.ready) return 'ready';
  if (check.waiting) return 'waiting';
  return 'busy';
}

/** 워크스페이스 상태 넷. 순서는 사람이 볼 급한 순 — 착륙 대기 → 막힘 → 답 대기 → 도는 중. */
const WORKSPACE_STATES = ['ready', 'blocked', 'waiting', 'busy'];

const num = (v) => (Number.isFinite(v) ? v : null);

/** 슬라이스 한 줄을 도구가 낼 모양으로. `workspace` 는 이름만 싣는다 — 객체째 실으면 순환한다. */
function sliceRow(s, decision) {
  return {
    number: num(s.number),
    title: s.title,
    done: !!s.done,
    tags: s.tags || [],
    deps: s.deps || [],
    decision: s.decision || null,
    agent: s.agent || null,
    agentUnknown: !!s.agentUnknown,
    unknownTags: s.unknownTags || [],
    resources: s.resources || [],
    planErrors: (s.errors || []).map((e) => e.detail),
    workspace: s.workspace ? s.workspace.name : null,
    // 아래 넷이 "파견 자격 + 불가 사유" 다 (`PRD.md §4`).
    eligible: decision ? !!decision.eligible : false,
    redispatch: decision?.redispatch ? decision.redispatch.name : null,
    reason: decision ? decision.reason : s.done ? '완료됨' : '판정 없음',
    hold: decision && !decision.eligible ? holdOf(decision.reason) : null,
  };
}

function workspaceRow(check, w) {
  return {
    name: check.name,
    slice: num(check.slice ?? w?.slice),
    agent: w?.agent || null,
    headless: !!headlessOf(w),
    branch: w?.branch || null,
    state: workspaceState(check),
    reason: check.reason || null,
    waiting: check.waiting || null,
    attention: check.attention || null,
  };
}

/**
 * 픽스처 플릿 한 바퀴를 관찰하고 판정한다. **아무것도 바꾸지 않는다** — 읽는 것은 픽스처 폴더와
 * 그 안의 git 뿐이고, 실제 `~/.sp-sync/` 는 `landCheck` 의 카드 읽기 하나만 스쳐 간다
 * (`scripts/fixture.mjs` 머리말 참고. 읽기다).
 *
 * `now` 를 한 번 정해 세 판정에 같이 넘긴다 — 픽스처의 시각이 상대값이라, 함수마다 따로 재면
 * 한 호출 안에서 "턴이 묵었나"·"한도가 풀렸나"의 답이 갈릴 수 있다.
 *
 * `planDirty` 는 `dispatchPlan` 이 이미 받는 인자를 그대로 열어 둔 것이다 (슬라이스 8) — 본체
 * `PLAN.md` 가 커밋 전이면 그 프로젝트의 새 파견을 전부 접는 사유이고, 문장은 sp-sync 의
 * `planDirtyBlock` 이 낸 것을 그대로 넘긴다. **여기서 사유를 지어내지 않는다.** 픽스처의 본체는
 * 늘 깨끗해서 기본값은 `null` 이다 — 그 갈래를 재생하는 쪽이 문장을 만들어 넘긴다
 * (`scripts/eval.mjs` 시나리오 3).
 *
 * `caps`(동시 상한) · `resumeMax`(재개 상한)는 **세팅 비교 실험**(슬라이스 9)이 여는 구멍이다.
 * 안 주면 지금까지와 같다 — 픽스처 정의와 `RESUME_MAX`. 판정 규칙이 아니라 판정에 넘기는
 * **입력값**이므로 여기서 갈아 끼워도 `PRD.md §7` 의 "판정 규칙 신설·변경" 이 아니다.
 */
function observeFleet({ now = Date.now(), projects = null, planDirty = null, caps = null, resumeMax = RESUME_MAX } = {}) {
  const fx = loadFixture(now);
  const names = projects && projects.length ? fx.projects.filter((p) => projects.includes(p)) : fx.projects;
  const unknown = (projects || []).filter((p) => !fx.projects.includes(p));

  const out = names.map((project) => {
    const r = fixtureSlices(project, fx);
    const max = capOf(project, fx, caps);
    const checks = r.workspaces.map((w) => landCheck(w, { ...LAND_OPTS, now }));
    const decisions = dispatchPlan({
      slices: r.slices,
      allSlices: r.allSlices,
      workspaces: r.workspaces,
      max,
      block: null,
      limitHold: null,
      planDirty,
      project,
    });
    const byNumber = new Map(decisions.map((d) => [d.slice, d]));
    const resume = resumePlan(fx.resume[project] || [], {
      now,
      workspaces: r.workspaces,
      slices: r.slices,
      cards: fx.cards,
      limits: null,
      max: resumeMax,
    });
    const workspaces = checks.map((c, i) => workspaceRow(c, r.workspaces[i]));
    return {
      project,
      root: r.root,
      phase: r.phase,
      max,
      // 상태별 워크스페이스 수. sp-sync 의 `activeCount` 를 흉내 내지 않는다 — 그 수는 파견 판정
      // 안에서만 뜻이 있고(`동시 상한 N개를 채움`), 여기서 따로 세면 두 수가 갈린다.
      counts: WORKSPACE_STATES.reduce((a, k) => ({ ...a, [k]: workspaces.filter((w) => w.state === k).length }), {}),
      planErrors: (r.errors || []).map((e) => e.detail || String(e)),
      workspaces,
      slices: r.slices.map((s) => sliceRow(s, byNumber.get(s))),
      resume: resume.map((x) => ({
        name: x.name,
        slice: num(x.slice),
        agent: x.agent || null,
        action: x.action,
        reason: x.reason,
        attempts: num(x.attempts) ?? 0,
      })),
      // 진행 카드 — 워커가 턴 끝에 남긴 한 줄. `wait` 가 차 있으면 사람을 기다리는 워크스페이스다.
      cards: r.workspaces
        .map((w) => [w, fx.cards[normPath(w.path)]])
        .filter(([, c]) => c)
        .map(([w, c]) => ({ workspace: w.name, now: c.now || '', wait: c.wait || '', next: c.next || '', task: c.task || null })),
    };
  });

  return {
    at: new Date(now).toISOString(),
    source: { kind: 'sandbox-fixture', root: fx.root },
    // 이번 관찰이 쓴 세팅. 세팅을 갈아 끼운 결과를 표로 모을 때 행마다 무엇이었는지 되짚을 자리다.
    settings: { caps: Object.fromEntries(names.map((p) => [p, capOf(p, fx, caps)])), resumeMax },
    unknownProjects: unknown,
    projects: out,
  };
}

export { HOLD_CODES, RESUME_MAX, WORKSPACE_STATES, capOf, holdOf, observeFleet, workspaceState };
