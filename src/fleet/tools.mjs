import { statePath } from '../state.mjs';
/**
 * 도구 다섯 — 읽기 셋(슬라이스 3) `fleet_status` · `fleet_slices` · `fleet_report`,
 * 쓰기 둘(슬라이스 4) `fleet_dispatch` · `fleet_land`.
 *
 * 전송(MCP · HTTP · 화면)과 떼어 둔다. 여기 있는 것은 **이름 · 설명 · 입력 스키마 · 표시 · 핸들러**
 * 다섯이고, `src/mcp/server.mjs` 가 그것을 MCP 로 등록한다. 뒤 슬라이스의 화면·에이전트 루프도 같은
 * 표를 쓴다 — 도구가 낸 답과 화면에 뜬 답이 갈리면 회차 상세가 근거 노릇을 못 한다.
 *
 * **읽기와 쓰기를 가른다** (`PRD.md §4`). 읽기 셋은 어떤 상태도 바꾸지 않으므로 에이전트가 마음껏
 * 불러도 된다. 쓰기 둘은 **승인 게이트**를 지난다 — 승인 없이 부르면 대기 항목만 만들고 돌아가며,
 * 사람이 승인한 뒤 같은 호출을 다시 해야 실행된다 (`approvals.mjs`).
 * 그 갈림은 설명 문장이 아니라 **스키마의 표시**(`annotations`)에 있다: 도구를 고르는 쪽이 문장을
 * 안 읽고도 어느 쪽인지 알아야 한다.
 *
 * 결과에는 **늘 사유가 실린다.** "파견 불가" 만이 아니라 "선행 2번이 미완" 까지 — 사람이 화면에서
 * 보는 것도, 에이전트가 다음 수를 고르는 재료도 그 문장이다.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { finishApproval, requestApproval, takeApproval } from './approvals.mjs';
import { SANDBOX_CHECK, planDispatch, planLand, runDispatch, runLand } from './execute.mjs';
import { observeFleet } from './source.mjs';
import { readRuns } from './runs.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 회차 기록 폴더. `~/.sp-sync/config.json` 의 `cycleRunsDir` 기본값과 같은 자리다. */
const RUNS_DIR = statePath('runs');
const currentPath = () => statePath('runs');

const projectArg = z.string().min(1).optional().describe('프로젝트 이름 하나. 빼면 전부');

// ---------- 사람이 읽는 요약 ----------
// 도구를 부른 쪽이 JSON 을 안 읽어도 **무엇이 왜 그렇게 됐는지**는 알아야 한다. 아래 세 함수가
// 그 한 화면을 만든다. 사유 문장은 판정이 낸 것을 그대로 쓴다 — 여기서 고쳐 쓰지 않는다.

const STATE_LABEL = { ready: '착륙 자격', blocked: '막힘', waiting: '답 대기', busy: '도는 중' };

function statusText(o) {
  const L = ['샌드박스 플릿 — 프로젝트 ' + o.projects.length + ' (관찰 ' + o.at + ')'];
  for (const p of o.projects) {
    L.push('', p.project + ' — 단계 ' + (p.phase?.title || '?') + ' · 동시 상한 ' + p.max);
    if (!p.workspaces.length) L.push('  워크스페이스 없음');
    for (const w of p.workspaces) L.push('  ' + w.name + ' [' + STATE_LABEL[w.state] + '] ' + (w.reason || w.waiting || ''));
    for (const c of p.cards.filter((c) => c.wait)) L.push('  ↳ ' + c.workspace + ' 카드가 사람을 기다림: ' + c.wait);
    for (const r of p.resume.filter((r) => r.action !== 'drop')) L.push('  ↳ 재개 ' + r.name + ' [' + r.action + '] ' + r.reason);
    for (const e of p.planErrors) L.push('  ⚠ 계획 오류: ' + e);
  }
  return L.join('\n');
}

function slicesText(o) {
  const L = ['슬라이스와 파견 자격 (관찰 ' + o.at + ')'];
  for (const p of o.projects) {
    const todo = p.slices.filter((s) => !s.done);
    L.push('', p.project + ' — 단계 ' + (p.phase?.title || '?') + ' · 미완 ' + todo.length + ' · 동시 상한 ' + p.max);
    for (const s of todo) {
      const mark = s.eligible ? '파견 가능' : '보류(' + s.hold + ')';
      L.push('  ' + (s.number ?? '?') + '. ' + s.title + ' [' + mark + '] ' + s.reason);
    }
    if (!todo.length) L.push('  현재 단계에 미완 슬라이스 없음 — 다음 단계 재계획 차례');
  }
  return L.join('\n');
}

function reportText(o) {
  if (o.missing) return '회차 기록 폴더가 없다: ' + o.dir + ' (아직 기록이 없다 — 오류가 아니다)';
  if (!o.runs.length) return '그 범위에 회차가 없다 (' + (o.from || '처음') + ' ~ ' + (o.to || '끝') + ')';
  const L = ['회차 ' + o.runs.length + '개 (범위 안 ' + o.total + '개, 최신 먼저)'];
  for (const r of o.runs) {
    const counts = Object.entries(r.counts)
      .map(([k, v]) => k + ' ' + v)
      .join(' · ');
    L.push('', '## ' + r.id + (r.dryRun ? ' (dry-run)' : '') + ' — ' + counts);
    for (const n of r.notes) L.push('  ' + n);
    for (const [name, rows] of Object.entries(r.tables)) {
      if (!rows.length) continue;
      L.push('  [' + name + ']');
      // 마지막 열이 늘 사유다 (`renderCycleReport` 의 표 넷: 비고 · 지시 · 이유 · 내용).
      for (const row of rows) {
        const v = Object.values(row);
        L.push('    ' + v.slice(0, -1).filter(Boolean).join(' / ') + ' — ' + v[v.length - 1]);
      }
    }
  }
  return L.join('\n');
}

// ---------- 표시 ----------
// 도구를 고르는 쪽은 설명 문장을 안 읽을 수 있다. 읽기/쓰기의 갈림은 스키마에 박아 둔다.

/** 읽기 전용 — 몇 번을 불러도 안전하다. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** 승인 게이트를 지나는 쓰기 — 되돌리기 어렵고, 같은 호출을 두 번 하면 두 번 일어난다. */
const WRITE_GATED = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

// ---------- 승인 게이트 ----------

/** 대기 항목 한 덩이 — 결과의 `approval` 자리. 큐 항목 전부를 싣지 않는다(내부 지문·인자는 뺀다). */
const approvalOf = (it) =>
  it ? { id: it.id, state: it.state, reason: it.reason, cost: it.cost, evidence: it.evidence, createdAt: it.createdAt, note: it.note || '' } : null;

/**
 * 쓰기 도구 둘의 **공통 뼈대**: 자격 판정 → 승인 게이트 → 실행. 순서를 도구마다 따로 쓰면
 * 한쪽만 게이트를 건너뛰는 날이 온다.
 *
 * 네 갈래로 끝난다:
 *   - `rejected` — 자격이 없거나(판정이 낸 사유 그대로) 승인 항목을 쓸 수 없다. **아무것도 안 만든다.**
 *   - `pending`  — 자격은 있고 승인이 없다. 대기 항목만 만들고 멈춘다.
 *   - `executed` / `failed` — 승인된 것을 실제로 돌린 결과.
 */
async function gatedRun({ tool, args, approvalId, check, ask, run }) {
  const plan = await check();
  if (!plan.ok) {
    return { tool, status: 'rejected', ...args, reason: plan.error, hold: plan.hold || null, approval: null };
  }
  const taken = takeApproval({ id: approvalId, tool, args });
  if (!taken.ok && taken.error) {
    // 항목은 찾았지만 쓸 수 없다 — 보류됐거나, 이미 실행됐거나, 승인 당시와 인자가 다르다.
    return { tool, status: 'rejected', ...args, reason: taken.error, hold: null, approval: approvalOf(taken.item) };
  }
  if (!taken.ok) {
    const { item, created } = requestApproval({ tool, project: args.project, target: args, args, ...ask(plan) });
    // 사람이 이미 보류한 것을 다시 부른 것 — 새 대기 항목으로 되살리지 않는다. 그러면 보류가
    // "다시 부르면 풀리는 것" 이 되어 게이트가 아니게 된다 (`PRD.md §5` — 답을 줄 때까지 그 항목만 멈춘다).
    if (item.state === 'held')
      return { tool, status: 'rejected', ...args, reason: '사람이 보류한 항목이다: ' + item.id + (item.note ? ' — ' + item.note : ''), hold: null, approval: approvalOf(item) };
    return { tool, status: 'pending', ...args, reason: item.reason, created, approval: approvalOf(item) };
  }
  const r = await run(plan);
  const item = finishApproval(taken.item.id, { ok: r.ok, result: r.result });
  return { tool, status: r.ok ? 'executed' : 'failed', ...args, reason: r.reason, approval: approvalOf(item), result: r.result };
}

/** 쓰기 도구의 한 화면. 네 갈래마다 사람이 다음에 할 일이 다르므로 그 한 줄을 같이 낸다. */
function writeText(o) {
  const what = o.tool + ' ' + o.project + '/' + (o.slice != null ? o.slice + '번' : o.workspace);
  const L = [];
  if (o.status === 'rejected') {
    L.push('거부 — ' + what, '사유: ' + o.reason + (o.hold ? ' [' + o.hold + ']' : ''));
  } else if (o.status === 'pending') {
    L.push('승인 대기 — ' + what, (o.created ? '대기 항목을 만들었다: ' : '이미 대기 중인 항목이다: ') + o.approval.id);
    L.push('자격: ' + o.reason, '승인하면: ' + o.approval.cost);
    for (const [k, v] of Object.entries(o.approval.evidence || {})) L.push('  ' + k + ': ' + (Array.isArray(v) ? v.join(' · ') : v));
    L.push('아직 아무것도 만들지 않았다. 사람이 승인한 뒤 같은 호출을 다시 하면 실행된다.');
  } else {
    L.push((o.status === 'executed' ? '실행됨' : '실행 실패') + ' — ' + what, '사유: ' + o.reason);
    for (const s of o.result?.steps || []) L.push('  ' + s.step + (s.ok ? ' ✓' : ' ✗') + (s.detail ? '  ' + s.detail : ''));
  }
  return L.join('\n');
}

// ---------- 도구 ----------
const TOOLS = [
  {
    name: 'fleet_status',
    annotations: READ_ONLY,
    title: '플릿 현황',
    description: [
      '샌드박스 플릿의 프로젝트별 작업 공간과 진행 상태를 읽는다. 읽기 전용 — 아무것도 바꾸지 않는다.',
      '작업 공간마다 상태 넷 중 하나와 **그 사유**가 붙는다: ready(착륙 자격) · blocked(막힘) ·',
      'waiting(워커가 사람의 답을 기다림) · busy(도는 중). 진행 카드의 질문과 재개 판정도 함께 낸다.',
      '"지금 무엇이 왜 멈춰 있나" 를 물을 때 가장 먼저 부른다.',
    ].join(' '),
    schema: { project: projectArg },
    run: ({ project }) => {
      const data = observeFleet({ projects: project ? [project] : null });
      return { data, text: statusText(data) };
    },
  },
  {
    name: 'fleet_slices',
    annotations: READ_ONLY,
    title: '슬라이스와 파견 자격',
    description: [
      '계획서(PLAN.md)의 슬라이스 목록과 **파견 자격 + 불가 사유**를 읽는다. 읽기 전용.',
      '슬라이스마다 eligible(파견 가능 여부) · reason(그 판정의 사유) · hold(불가 사유의 갈래)가 붙는다.',
      'hold 갈래: deps-undone(선행 미완) · cap-project/cap-global(동시 상한) · decision(사용자 결정 필요) ·',
      'running(이미 돌고 있음) · solo/order(순서) · plan-error(계획 오류) · limit-hold(한도 임박) 등.',
      '무엇을 다음에 띄울지 고르기 전에 부른다.',
    ].join(' '),
    schema: {
      project: projectArg,
      eligibleOnly: z.boolean().optional().describe('파견 자격이 난 것만 (기본 false)'),
      hold: z.string().optional().describe('이 hold 갈래만 (예: deps-undone)'),
    },
    run: ({ project, eligibleOnly = false, hold = null }) => {
      const data = observeFleet({ projects: project ? [project] : null });
      // 거르기는 미완 슬라이스에만 건다 — 완료된 줄은 자격을 묻는 대상이 아니다.
      for (const p of data.projects) {
        p.slices = p.slices.filter((s) => {
          if (s.done) return !eligibleOnly && !hold;
          if (eligibleOnly && !s.eligible) return false;
          if (hold && s.hold !== hold) return false;
          return true;
        });
      }
      data.filter = { eligibleOnly, hold };
      // 어떤 사유로 몇 개가 막혔나 — 부른 쪽이 세지 않아도 되게.
      data.holds = data.projects
        .flatMap((p) => p.slices.filter((s) => !s.done && s.hold).map((s) => s.hold))
        .reduce((a, k) => ({ ...a, [k]: (a[k] || 0) + 1 }), {});
      return { data, text: slicesText(data) };
    },
  },
  {
    name: 'fleet_report',
    annotations: READ_ONLY,
    title: '지난 회차 기록',
    description: [
      '지난 회차 기록을 날짜 범위로 읽는다. 읽기 전용. 회차마다 착륙 · 파견 · 막힘 · 결정 필요 표와',
      '각 줄의 사유가 그대로 실린다. from/to 는 YYYY-MM-DD 이고 양끝을 포함한다.',
      '**없는 날짜면 빈 결과다 — 오류가 아니다.** "지난번엔 왜 그렇게 됐나" 를 되짚을 때 부른다.',
    ].join(' '),
    schema: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('시작 날짜 YYYY-MM-DD (포함)'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('끝 날짜 YYYY-MM-DD (포함)'),
      limit: z.number().int().min(1).max(200).optional().describe('최신부터 몇 개까지 (기본 20)'),
      project: projectArg,
    },
    run: ({ from = null, to = null, limit = 20, project = null }) => {
      const data = readRuns({ dir: currentPath(), from, to, limit, project });
      return { data, text: reportText(data) };
    },
  },
  {
    name: 'fleet_dispatch',
    annotations: WRITE_GATED,
    title: '슬라이스 파견 (승인 필요)',
    description: [
      '슬라이스 하나를 에이전트에게 파견한다. **승인 필요** — 작업 공간과 세션이 생기므로 비용이 발생한다.',
      '승인 없이 부르면 아무것도 만들지 않고 **승인 대기 항목만** 만든다(status: pending). 사람이 승인한 뒤',
      '같은 인자로 다시 부르면 그때 실행된다(status: executed). 파견 자격이 없으면 만들지도 대기시키지도 않고',
      '**사유와 함께 거부한다**(status: rejected) — 사유는 fleet_slices 가 내는 것과 같은 문장이다.',
      '자격이 있는지는 fleet_slices 로 먼저 확인한다.',
    ].join(' '),
    schema: {
      project: z.string().min(1).describe('프로젝트 이름'),
      slice: z.number().int().min(1).describe('계획서의 슬라이스 번호'),
      approvalId: z.string().optional().describe('승인 항목 id. 빼면 같은 인자의 승인을 찾아 쓴다'),
    },
    run: async ({ project, slice, approvalId = null }) => {
      const data = await gatedRun({
        tool: 'fleet_dispatch',
        args: { project, slice },
        approvalId,
        check: () => planDispatch(project, slice),
        // 사람이 누르기 전에 볼 것 (`PRD.md §5` — 어떤 슬라이스를 어느 에이전트에게, 지금 몇 개가 도는지).
        ask: (p) => ({
          reason: p.slice.reason,
          cost: '작업 공간 slice' + slice + ' 와 ' + (p.slice.agent || 'claude') + ' 세션 하나가 생긴다 — 에이전트 사용량이 발생한다',
          evidence: {
            슬라이스: slice + '. ' + p.slice.title + (p.slice.tags.length ? ' [' + p.slice.tags.join('] [') + ']' : ''),
            에이전트: p.slice.agent || 'claude',
            명령: p.command || '(못 만듦)',
            단계: p.project.phase?.title || '?',
            지금: '도는 중 ' + p.project.counts.busy + ' · 동시 상한 ' + p.project.max,
          },
        }),
        run: async () => {
          const r = await runDispatch(project, slice);
          const d = r.dispatched || {};
          return {
            ok: r.ok,
            reason: r.error || (d.ok ? d.submit || '파견됨' : d.stage + ' 단계에서 실패: ' + d.detail),
            result: { outcome: d.outcome || 'failed', name: d.name, path: d.path || null, agent: d.agent, command: d.command || d.text || null, stage: d.stage },
          };
        },
      });
      return { data, text: writeText(data) };
    },
  },
  {
    name: 'fleet_land',
    annotations: WRITE_GATED,
    title: '작업 공간 착륙 (승인 필요)',
    description: [
      '완료된 작업 공간을 본 저장소에 반영한다(검사 → push → PR → 머지 → 작업 공간 삭제).',
      '**승인 필요 — 되돌리기 어렵다.** 승인 없이 부르면 아무것도 하지 않고 승인 대기 항목만 만든다.',
      '착륙 자격(슬라이스 체크 + 커밋 + 깨끗한 트리 + 유휴)이 없으면 사유와 함께 거부한다 —',
      '워커가 사람의 답을 기다리는 중이거나 미체크로 막힌 것은 여기서 걸린다.',
      '충돌이면 해소를 시도하지 않고 사람에게 올린다. 자격은 fleet_status 로 먼저 확인한다.',
    ].join(' '),
    schema: {
      project: z.string().min(1).describe('프로젝트 이름'),
      workspace: z.string().min(1).describe('작업 공간 이름 (sliceN)'),
      approvalId: z.string().optional().describe('승인 항목 id. 빼면 같은 인자의 승인을 찾아 쓴다'),
    },
    run: async ({ project, workspace, approvalId = null }) => {
      const data = await gatedRun({
        tool: 'fleet_land',
        args: { project, workspace },
        approvalId,
        check: async () => planLand(project, workspace),
        // 사람이 누르기 전에 볼 것 (`PRD.md §5` — 변경 요약 · 완료 체크 상태 · 검사 결과).
        ask: (p) => ({
          reason: p.check.reason,
          cost: workspace + ' 의 커밋을 main 에 머지하고 작업 공간과 브랜치를 지운다 — 되돌리기 어렵다',
          evidence: {
            브랜치: p.workspace.branch,
            슬라이스: String(p.check.slice),
            완료체크: '워크스페이스 PLAN.md 에서 ' + p.check.slice + '번 [x]',
            커밋: p.check.commits || [],
            검사: '머지 전에 ' + SANDBOX_CHECK + ' 를 돌린다',
          },
        }),
        run: async () => {
          const r = await runLand(project, workspace);
          const d = r.landed || {};
          return {
            ok: r.ok,
            reason: r.error || (r.ok ? '머지 완료 (PR #' + d.pr + ')' : d.stage + ' 단계에서 멈춤' + (d.needsUser ? ' — 사람이 볼 것' : '')),
            result: { pr: d.pr ?? null, url: d.url || null, steps: d.steps || [], stage: d.stage || null, needsUser: !!d.needsUser, ff: !!d.ff },
          };
        },
      });
      return { data, text: writeText(data) };
    },
  },
];

export { READ_ONLY, RUNS_DIR, TOOLS, WRITE_GATED, reportText, slicesText, statusText, writeText };
