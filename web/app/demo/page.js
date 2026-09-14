import { observeFleet } from '../../../src/fleet/source.mjs';
import { withDemo } from '../../lib/demo';
import { request, reset } from './actions';

export const dynamic = 'force-dynamic';
export default async function DemoPage({ searchParams }) {
  const { msg = '' } = await searchParams;
  return withDemo(async () => {
    const fleet = observeFleet();
    return <>
      <h1>내 데모 플릿</h1>
      <p className="lede">이 브라우저의 승인 큐와 작업 공간입니다. 요청을 보낸 뒤 승인 큐에서 승인하고 실행해 보세요.</p>
      {msg ? <p className="flash">{msg}</p> : null}
      <form action={reset}><button type="submit">처음 상태로 되돌리기</button></form>
      <p className="meta">작업 공간을 처음 상태로 되돌립니다. 승인 이력·실행 기록·오늘 사용량은 보존합니다.</p>
      {fleet.projects.map((p) => <section className="stage" key={p.project}>
        <h2>{p.project}</h2>
        {p.workspaces.map((w) => <p key={w.name}>{w.name} · {w.state} · {w.reason}</p>)}
        {p.workspaces.filter((w) => w.state === 'ready').map((w) => <form action={request.bind(null, 'fleet_land')} key={w.name} className="decide">
          <input type="hidden" name="project" value={p.project}/><input type="hidden" name="workspace" value={w.name}/>
          <button type="submit">{p.project}/{w.name} 착륙 요청</button>
        </form>)}
        {p.slices.filter((s) => s.eligible).map((s) => <form action={request.bind(null, 'fleet_dispatch')} key={s.number} className="decide">
          <input type="hidden" name="project" value={p.project}/><input type="hidden" name="slice" value={s.number}/>
          <button type="submit">{p.project}/{s.number} 파견 요청</button>
        </form>)}
      </section>)}
    </>;
  });
}
