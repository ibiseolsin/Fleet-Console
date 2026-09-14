import { statePath } from '../state.mjs';
/**
 * 승인 큐 (슬라이스 4) — 쓰기 도구가 멈추는 자리.
 *
 * `PRD.md §4` 는 쓰기 둘(`fleet_dispatch` · `fleet_land`)에 **승인 필요**를 박았고, `§5` 는 사람이
 * 무엇을 보고 무엇을 정하는지를 정했다. 그 사이를 잇는 것이 이 파일이다 — 도구는 **대기 항목만**
 * 만들고 돌아가며, 실행은 사람이 승인한 뒤의 재호출에서만 일어난다.
 *
 * **승인은 도구로 노출하지 않는다.** 에이전트가 자기 요청을 스스로 승인할 수 있으면 게이트가
 * 아니다. 승인·보류는 사람의 자리다 — 지금은 `scripts/approve.mjs`, 슬라이스 6부터는 화면
 * (`/approvals`). 그래서 이 모듈은 도구 층(`tools.mjs`)과 사람 층 양쪽이 같이 쓴다.
 *
 * 큐 파일은 `sandbox/approvals.json` 하나다. 픽스처(`sandbox/fleet/`)와 **따로 두는 이유**는
 * `npm run fixture` 가 픽스처를 통째로 다시 만들기 때문이다. 그렇다고 옛 승인이 새 픽스처에
 * 그대로 쓰이면 안 되므로, 항목마다 그때의 `fixture.json` 생성 시각을 적어 두고 실행 직전에
 * 대조한다 — 다르면 "픽스처가 다시 만들어졌다" 로 거부한다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUEUE_FILE = statePath('approvals.json');
const currentPath = () => statePath('approvals.json');
const fixtureFile = () => statePath('fleet', 'fixture.json');

/**
 * 항목의 삶. `pending` 에서 사람이 갈라 주고(`approved` · `held`), 실행이 끝나면 결과가 붙는다.
 * `held` 는 되돌릴 수 있다 — 사람이 보류했다가 나중에 승인하는 것이 `PRD.md §5` 의 "승인 / 보류" 다.
 */
const STATES = ['pending', 'approved', 'held', 'done', 'failed'];

/** 아직 사람의 답을 기다리는 것. 화면 배지가 세는 수다. */
const OPEN_STATES = ['pending', 'held'];

/** 지금 픽스처가 언제 만들어졌나. 없으면 null — 그러면 대조를 건너뛴다(픽스처 부재는 도구가 먼저 잡는다). */
function fixtureStamp() {
  try {
    return JSON.parse(readFileSync(fixtureFile(), 'utf8')).builtAt || null;
  } catch {
    return null;
  }
}

/**
 * 같은 요청인가를 가르는 지문. **도구 이름 + 정규화한 인자 + 픽스처 생성 시각** 셋이다.
 * 인자가 하나라도 다르면 다른 요청이다 — 승인 하나로 다른 대상을 실행하면 게이트가 뚫린다.
 */
function fingerprint(tool, args, fixtureAt) {
  const norm = JSON.stringify(Object.fromEntries(Object.entries(args || {}).sort(([a], [b]) => (a < b ? -1 : 1))));
  return createHash('sha256').update([tool, norm, fixtureAt || ''].join(' ')).digest('hex').slice(0, 16);
}

function readQueue() {
  try {
    const q = JSON.parse(readFileSync(currentPath(), 'utf8'));
    return { items: Array.isArray(q.items) ? q.items : [] };
  } catch {
    return { items: [] };
  }
}

/** tmp 에 쓰고 rename 한다. 반쯤 쓰인 큐를 다음 호출이 읽으면 승인이 통째로 사라진다. */
function writeQueue(q) {
  mkdirSync(dirname(currentPath()), { recursive: true });
  const tmp = currentPath() + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify({ items: q.items }, null, 2) + '\n');
  renameSync(tmp, currentPath());
}

function listApprovals({ state = null, tool = null, project = null, open = false } = {}) {
  return readQueue().items.filter(
    (it) =>
      (!state || it.state === state) &&
      (!open || OPEN_STATES.includes(it.state)) &&
      (!tool || it.tool === tool) &&
      (!project || it.project === project)
  );
}

const findById = (id) => readQueue().items.find((it) => it.id === id) || null;

/**
 * 대기 항목을 만든다 — **이미 같은 지문의 항목이 살아 있으면 그것을 돌려준다.** 에이전트가 같은
 * 도구를 두 번 부르는 것은 흔한 일이고(사람이 아직 안 눌렀나 보려고), 그때마다 항목이 쌓이면
 * 승인 큐가 같은 요청으로 가득 찬다.
 *
 * `reason` 은 **판정이 낸 문장 그대로**다. `evidence` 는 사람이 누르기 전에 볼 것
 * (`PRD.md §5` — 파견 전: 무엇을 어느 에이전트에게 · 지금 몇 개가 도는지 / 착륙 전: 변경 요약 ·
 * 완료 체크 · 검사 결과). `cost` 는 "승인하면 무엇이 생기나" 한 줄이다.
 */
function requestApproval({ tool, project, target, args, reason, evidence = {}, cost = '' }) {
  const fixtureAt = fixtureStamp();
  const fp = fingerprint(tool, args, fixtureAt);
  const q = readQueue();
  const live = q.items.find((it) => it.fingerprint === fp && it.state !== 'done' && it.state !== 'failed');
  if (live) return { item: live, created: false };
  const item = {
    id: 'apr_' + randomUUID().replace(/-/g, '').slice(0, 10),
    tool,
    project,
    target,
    args,
    fingerprint: fp,
    fixtureAt,
    state: 'pending',
    reason,
    evidence,
    cost,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    note: '',
    result: null,
  };
  q.items.push(item);
  writeQueue(q);
  return { item, created: true };
}

/** 큐의 한 항목을 바꿔 쓴다. 없으면 null — 부른 쪽이 사유를 만든다. */
function updateApproval(id, patch) {
  const q = readQueue();
  const i = q.items.findIndex((it) => it.id === id);
  if (i < 0) return null;
  q.items[i] = { ...q.items[i], ...patch };
  writeQueue(q);
  return q.items[i];
}

/**
 * **사람의 결정.** `approve` 면 다음 재호출에서 실행되고, `hold` 면 그 항목만 멈춘다
 * (`PRD.md §5` — 다른 프로젝트는 계속 돈다). 이미 실행된 항목은 다시 못 정한다.
 */
function decideApproval(id, decision, note = '') {
  const it = findById(id);
  if (!it) return { ok: false, error: '그런 승인 항목이 없다: ' + id };
  if (!OPEN_STATES.includes(it.state)) return { ok: false, error: '이미 ' + it.state + ' 인 항목이다: ' + id };
  if (decision !== 'approve' && decision !== 'hold') return { ok: false, error: '결정은 approve 또는 hold 다: ' + decision };
  const state = decision === 'approve' ? 'approved' : 'held';
  return { ok: true, item: updateApproval(id, { state, decidedAt: new Date().toISOString(), note }) };
}

/**
 * 실행 직전의 관문. 이 함수를 지나야만 쓰기가 일어난다.
 *
 * 넷을 본다: 항목이 있는가 · 승인됐는가 · **지문이 지금 인자와 같은가** · 픽스처가 그대로인가.
 * 셋째가 게이트의 핵심이다 — 승인은 "이 슬라이스를 이 에이전트로" 에 대한 것이지 도구 이름에
 * 대한 것이 아니다. `id` 를 안 주면 지문으로 찾는다: 사람이 승인한 뒤 **같은 호출을 다시** 하면
 * 그대로 실행되는 것이 도구를 부르는 쪽에서 가장 자연스럽다.
 */
function takeApproval({ id = null, tool, args }) {
  const fixtureAt = fixtureStamp();
  const fp = fingerprint(tool, args, fixtureAt);
  const it = id ? findById(id) : readQueue().items.find((x) => x.fingerprint === fp && x.state === 'approved');
  if (!it) return { ok: false, error: id ? '그런 승인 항목이 없다: ' + id : null };
  if (it.state !== 'approved') return { ok: false, error: '승인되지 않았다 (' + it.state + '): ' + it.id, item: it };
  if (it.tool !== tool) return { ok: false, error: '다른 도구의 승인이다 (' + it.tool + '): ' + it.id, item: it };
  if (it.fixtureAt && fixtureAt && it.fixtureAt !== fixtureAt)
    return { ok: false, error: '픽스처가 다시 만들어졌다 — 승인 당시의 플릿이 아니다: ' + it.id, item: it };
  if (it.fingerprint !== fp) return { ok: false, error: '승인 당시와 인자가 다르다: ' + it.id, item: it };
  return { ok: true, item: it };
}

/** 실행 결과를 항목에 못 박는다. 승인 하나는 실행 하나다 — `done`·`failed` 는 다시 못 쓴다. */
function finishApproval(id, { ok, result }) {
  return updateApproval(id, { state: ok ? 'done' : 'failed', finishedAt: new Date().toISOString(), result });
}

export {
  OPEN_STATES,
  QUEUE_FILE,
  STATES,
  decideApproval,
  fingerprint,
  finishApproval,
  fixtureStamp,
  listApprovals,
  readQueue,
  requestApproval,
  takeApproval,
};
