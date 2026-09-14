import { execute } from '../demo/actions';
import { withDemo } from '../../lib/demo';
import { listApprovals } from '../../../src/fleet/approvals.mjs';
import { decide } from './actions';

/**
 * 승인 큐 (`PRD.md §5`·§6) — 쓰기 도구가 멈춘 자리를 사람이 푸는 화면.
 *
 * 슬라이스 4가 만든 큐(`sandbox/approvals.json`) 위에 그대로 올린다. 큐는 이 기계의 실행
 * 기록이라 커밋되지 않으므로(`.gitignore`) **매 요청 다시 읽는다** — 빌드 때 구운 값을
 * 보여주면 방금 누른 승인이 안 보인다.
 */
export const dynamic = 'force-dynamic';

/** 화면에서 부르는 이름. 큐에는 도구 이름이 그대로 들어 있다. */
const TOOL = { fleet_dispatch: '파견', fleet_land: '착륙' };

const STATE = {
  pending: ['대기', 'warn'],
  held: ['보류', 'stop'],
  approved: ['승인됨', ''],
  done: ['실행됨', ''],
  failed: ['실패', 'stop'],
};

/** `apr_… · 파견 · cobalt/2번` — 어느 프로젝트의 무엇에 대한 승인인가. */
function targetOf(it) {
  const t = it.target || {};
  return it.project + '/' + (t.slice != null ? t.slice + '번' : t.workspace || '?');
}

/** 사람이 누르기 전에 볼 것 — 도구가 실어 보낸 `evidence` 를 그대로 그린다 (`PRD.md §5`). */
function Evidence({ evidence }) {
  const rows = Object.entries(evidence || {});
  if (!rows.length) return null;
  return (
    <div className="rows">
      <dl className="row">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{Array.isArray(v) ? v.join(' · ') || '—' : String(v) || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 끝난 항목의 결과. 착륙은 단계 목록이, 파견은 만들어진 것이 들어 있다. */
function Result({ result }) {
  if (!result) return null;
  const steps = Array.isArray(result.steps) ? result.steps : null;
  const rest = Object.entries(result).filter(([k, v]) => k !== 'steps' && v !== null && v !== '' && v !== false);
  return (
    <div className="rows">
      <dl className="row">
        {rest.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
        {steps ? (
          <div className="why">
            <dt>단계</dt>
            <dd>{steps.map((s) => (s.ok ? '' : '✗ ') + s.step).join(' → ')}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function Item({ it }) {
  const [label, tone] = STATE[it.state] || [it.state, ''];
  const open = it.state === 'pending' || it.state === 'held';
  return (
    <section className="stage">
      <div className="head">
        <b>
          {TOOL[it.tool] || it.tool} · {targetOf(it)}
        </b>
        <span className={'n on ' + tone}>{label}</span>
      </div>

      <p className="meta">{it.reason}</p>
      {it.cost ? <p className="lede">승인하면: {it.cost}</p> : null}

      <Evidence evidence={it.evidence} />

      {it.note ? <p className="lede">메모: {it.note}</p> : null}
      {it.state === 'done' || it.state === 'failed' ? <Result result={it.result} /> : null}

      {it.state === 'approved' ? <form action={execute} className="decide">
        <input type="hidden" name="id" value={it.id}/><button type="submit">승인한 작업 실행</button>
      </form> : null}
      {open ? (
        <form className="decide">
          <input type="hidden" name="id" value={it.id} />
          <input type="text" name="note" placeholder="메모 (선택)" maxLength={200} />
          <button type="submit" formAction={decide.bind(null, 'approve')} className="go">
            승인
          </button>
          <button type="submit" formAction={decide.bind(null, 'hold')} className="stop">
            보류
          </button>
        </form>
      ) : null}

      <p className="lede">
        <code>{it.id}</code> · {it.createdAt.replace('T', ' ').slice(0, 16)}
        {it.state === 'approved' ? ' · 승인됨 — 같은 인자로 도구를 다시 부르면 실행된다' : ''}
      </p>
    </section>
  );
}

export default async function ApprovalsPage({ searchParams }) {
  return withDemo(async () => {
    const { msg = '', bad = '' } = (await searchParams) || {};
    const all = listApprovals({});
    const open = all.filter((it) => it.state === 'pending' || it.state === 'held');
    const closed = all.filter((it) => !open.includes(it));

    return (
      <>
        <h1>승인 큐</h1>
        <p className="lede">
          쓰기 도구 둘(<code>fleet_dispatch</code> · <code>fleet_land</code>)은 승인 없이 부르면 아무것도 만들지 않고 여기에 대기 항목만
          남긴다. 승인하면 에이전트가 <b>같은 인자로 다시 불렀을 때</b> 실행된다 — 승인 자체는 도구로 열지 않는다(에이전트가 제 요청을
          스스로 승인할 수 있으면 게이트가 아니다).
        </p>

        {msg ? <p className={'flash' + (bad ? ' bad' : '')}>{msg}</p> : null}

        <h2>
          기다리는 것 {open.length}건
          {open.length ? '' : ' — 없음'}
        </h2>
        {open.length ? (
          open.map((it) => <Item it={it} key={it.id} />)
        ) : (
          <p className="empty">지금 사람을 기다리는 항목이 없다. 도구가 대기 항목을 만들면 여기 뜬다.</p>
        )}

        <h2>지나간 것 {closed.length}건</h2>
        {closed.length ? closed.map((it) => <Item it={it} key={it.id} />) : <p className="empty">없음</p>}
      </>
    );
  });
}
