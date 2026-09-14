import { runAvailability } from '../../../../src/demo.mjs';
import { withDemo } from '../../../lib/demo';
import { notFound } from 'next/navigation';
import { approvalState } from '../../../../src/agent/loop.mjs';
import { RESUMABLE, readRun } from '../../../../src/agent/runs.mjs';
import { resume } from '../actions';
import { StateBadge, fmtWhen, totalCost } from '../view';

/**
 * 실행 상세 (trace) — 계획 → 도구 호출(이유) → 결과 → 다음 행동을 시간순으로.
 *
 * 슬라이스 6의 회차 상세(`/runs/<회차>`)와 **다른 것**이다. 그쪽은 실제 기계가 돈 운영 회차를 되짚은
 * 것이고, 여기는 앱 안에서 방금 돈 루프다. 섞지 않는다 (`notes/slice6-승인큐와계측.md`).
 *
 * 돌고 있는 동안은 3초마다 다시 읽는다 — 루프는 메시지마다 파일을 쓰므로 화면이 곧 따라온다.
 */
export const dynamic = 'force-dynamic';

const TOOL = { fleet_status: '플릿 현황', fleet_slices: '슬라이스·자격', fleet_report: '지난 회차', fleet_dispatch: '파견', fleet_land: '착륙' };
const RESULT_TONE = { pending: 'warn', rejected: 'stop', failed: 'stop', error: 'stop', executed: '', ok: '' };
const RESULT_LABEL = { pending: '승인 대기', rejected: '거부', failed: '실행 실패', error: '오류', executed: '실행됨', ok: '읽음' };

function Step({ s }) {
  if (s.type === 'text')
    return (
      <div className="step text">
        <span className="who">모델</span>
        <p>{s.text}</p>
      </div>
    );
  if (s.type === 'call')
    return (
      <div className="step call">
        <span className="who">도구 호출</span>
        <p>
          <b>{TOOL[s.tool] || s.tool}</b> <code>{s.tool}</code>
          {Object.keys(s.args || {}).length ? <code className="args">{JSON.stringify(s.args)}</code> : null}
          <br />
          <span className="why-line">이유: {s.reason}</span>
        </p>
      </div>
    );
  if (s.type === 'result')
    return (
      <div className="step result">
        <span className="who">결과</span>
        <details>
          <summary>
            <span className={'n on ' + (RESULT_TONE[s.status] ?? '')}>{RESULT_LABEL[s.status] || s.status}</span> {TOOL[s.tool] || s.tool} · {s.ms}ms
          </summary>
          <pre>{s.text}</pre>
        </details>
      </div>
    );
  if (s.type === 'deny')
    return (
      <div className="step deny">
        <span className="who">게이트</span>
        <p>
          <span className="n on stop">거부</span> {s.tool} — {s.message}
        </p>
      </div>
    );
  return (
    <div className="step stop">
      <span className="who">멈춤</span>
      <p>{s.reason}</p>
    </div>
  );
}

export default async function AgentRunPage({ params, searchParams }) {
  return withDemo(async () => {
    const { id } = await params;
    const { msg = '', bad = '' } = (await searchParams) || {};
    const run = readRun(id);
    if (!run) notFound();
    const availability = runAvailability(run);
    const live = run.state === 'running';
    const item = run.approval ? approvalState(run.approval.id) : null;
    const answered = item && item.state !== 'pending';
    const canResume = RESUMABLE.includes(run.state) && (run.state !== 'waiting' || answered);

    return (
      <>
        {live ? <meta httpEquiv="refresh" content="3" /> : null}
        <p className="back">
          <a href="/agent">← 실행 목록</a>
        </p>
        <h1>
          <StateBadge state={run.state} /> {run.prompt}
        </h1>
        <p className="meta">
          {fmtWhen(run.createdAt)} 시작 · 모델 <code>{run.model}</code> · 상한 {run.limits.maxTurns}턴 / {Math.round(run.limits.maxMs / 1000)}초 / ${run.limits.maxUsd} ·
          도구 {run.steps.filter((s) => s.type === 'call').length}회 · ${totalCost(run).toFixed(4)}
        </p>
        {msg ? <p className={'flash' + (bad ? ' bad' : '')}>{msg}</p> : null}

        {!availability.allowed ? <p className="flash">{availability.reason}</p> : null}
        {run.stop ? (
          <section className="stage">
            <div className="head">
              <b>{live ? '돌고 있다' : '왜 멈췄나'}</b>
            </div>
            <p>{run.stop.reason}</p>
            {run.state === 'waiting' && run.approval ? (
              <p>
                승인 항목 <code>{run.approval.id}</code> ({TOOL[run.approval.tool]} {run.approval.project}/
                {run.approval.target.slice != null ? run.approval.target.slice + '번' : run.approval.target.workspace}) —{' '}
                {answered ? (
                  <>
                    사람이 <b>{item.state === 'approved' ? '승인' : item.state === 'held' ? '보류' : item.state}</b>했다. 이어서 끝내면 모델이 그 답을 받는다.
                  </>
                ) : (
                  <>
                    아직 답이 없다. <a href="/approvals">승인 큐</a>에서 승인·보류한 뒤 여기서 이어간다.
                  </>
                )}
              </p>
            ) : null}
            {canResume ? (
              <form action={resume} className="decide">
                <input type="hidden" name="id" value={run.id} />
                <button type="submit" className="go" disabled={!availability.allowed}>
                  이어서 끝내기
                </button>
              </form>
            ) : null}
          </section>
        ) : null}

        {run.legs.map((leg) => (
          <section className="stage" key={leg.n}>
            <div className="head">
              <b>
                구간 {leg.n} — {leg.kind === 'start' ? '시작' : '이어서'}
              </b>
              <span>
                {leg.endedAt ? '턴 ' + leg.turns + ' · ' + Math.round(leg.durationMs / 1000) + '초 · $' + (leg.costUsd || 0).toFixed(4) : '돌고 있다'}
                {leg.usage ? ' · 토큰 입력 ' + (leg.usage.input + leg.usage.cacheWrite + leg.usage.cacheRead).toLocaleString() + ' / 출력 ' + leg.usage.output.toLocaleString() : ''}
              </span>
            </div>
            <p className="meta">지시: {leg.prompt}</p>
            <div className="steps">
              {run.steps
                .filter((s) => s.leg === leg.n)
                .map((s, i) => (
                  <Step s={s} key={i} />
                ))}
            </div>
          </section>
        ))}
        {!run.legs.length ? <p className="empty">아직 아무것도 하지 않았다.</p> : null}
      </>
    );
  });
}
