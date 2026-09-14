import { runAvailability } from '../../../src/demo.mjs';
import { withDemo } from '../../lib/demo';
import { DEFAULT_MODEL, DEFAULT_PROMPT } from '../../../src/agent/loop.mjs';
import { listRuns } from '../../../src/agent/runs.mjs';
import { start } from './actions';
import { StateBadge, fmtWhen, totalCost } from './view';

/**
 * 에이전트 루프 (`PRD.md §1` — "이 플릿의 다음 할 일을 정해줘") — 시작 화면과 실행 목록.
 * 실행 기록은 이 기계의 파일이라 매 요청 다시 읽는다.
 */
export const dynamic = 'force-dynamic';

export default async function AgentPage({ searchParams }) {
  return withDemo(async () => {
    const runs = listRuns();
    const availability = runAvailability();
    const { msg = '' } = await searchParams;
    const reason = availability.reason || (runs.some((r) => r.state === 'running') ? '에이전트가 실행 중입니다.' : '');
    return (
      <>
        <h1>에이전트 루프</h1>
        <p className="lede">
          모델이 읽기 도구로 플릿을 관찰하고, 도구가 낸 자격 위에서 <b>무엇을 먼저 할지</b> 고른 뒤, 쓰기 도구(파견·착륙) 앞에서{' '}
          <b>승인 대기</b>로 멈춘다. 사람이 <a href="/approvals">승인 큐</a>에서 답하면 같은 세션을 이어서 끝낸다. 판정 규칙은 도구가 내고 모델은
          순서만 고른다 — 도구 호출마다 <b>왜 불렀는지</b>가 실행 상세에 남는다.
        </p>

        {msg ? <p className="flash bad">{msg}</p> : null}
        {reason ? <p className="flash">{reason}</p> : null}
        <p className="meta">오늘 서버 전체 {availability.used}/{availability.daily}회 · 시작과 이어가기를 각각 1회로 셉니다.</p>
        <form action={start} className="decide agent-start">
          <textarea name="prompt" rows={2} defaultValue={DEFAULT_PROMPT} maxLength={500} />
          <button type="submit" className="go" disabled={!!reason}>
            시작
          </button>
        </form>
        <p className="meta">
          모델 <code>{DEFAULT_MODEL}</code> · 서버의 OpenAI API 키로 실행 · 실행 전체 비용 상한 ${availability.maxUsd} · 샌드박스 플릿만 만진다
        </p>

        <h2>실행 {runs.length}개</h2>
        {runs.length ? (
          <div className="runs">
            {runs.map((r) => (
              <a className="run" href={'/agent/' + r.id} key={r.id}>
                <span className="time">{fmtWhen(r.createdAt)}</span>
                <span className="projects">
                  <StateBadge state={r.state} /> {r.prompt}
                  <br />
                  <small className="meta">
                    {r.stop?.reason || '돌고 있다'} · 도구 {r.steps.filter((s) => s.type === 'call').length}회 · 구간 {r.legs.length} · ${totalCost(r).toFixed(3)}
                  </small>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="empty">아직 실행이 없다. 위에서 시작하면 여기 쌓인다.</p>
        )}
      </>
    );
  });
}
