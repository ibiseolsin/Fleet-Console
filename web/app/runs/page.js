import { COUNT_KEYS, allRuns, byDate } from '../../lib/runs';

/** 숫자 배지. 0 은 흐리게 두고, 사람을 부르는 둘(막힘·결정 필요)만 색을 준다. */
function Counts({ counts }) {
  return (
    <span className="counts">
      {COUNT_KEYS.map((k) => {
        const n = counts[k] || 0;
        const tone = n === 0 ? '' : k === '막힘' ? ' on stop' : k === '결정 필요' ? ' on warn' : ' on';
        return (
          <span key={k} className={'n' + tone}>
            {k} {n}
          </span>
        );
      })}
    </span>
  );
}

export default function RunsPage() {
  const data = allRuns();
  const days = byDate(data.runs);

  return (
    <>
      <h1>회차 목록</h1>
      <p className="lede">
        반입한 회차 <b>{data.total}개</b> · {data.files}일 · 최신 먼저. 실제 운영 기록을 익명화해 들여온 것이다
        (제외 프로젝트의 행은 빠졌고 요약 숫자는 다시 셌다 — <code>data/import-report.md</code>).
      </p>

      {days.map((day) => (
        <section className="day" key={day.date}>
          <div className="head">
            <b>{day.date}</b>
            <span style={{ color: 'var(--dim)', fontSize: 13 }}>회차 {day.runs.length}</span>
            <Counts counts={day.counts} />
          </div>
          <div className="runs">
            {day.runs.map((r) => (
              <a className="run" href={'/runs/' + r.slug} key={r.slug}>
                <span className="time">{r.time}</span>
                <span className="projects">
                  {r.projects.join(', ') || '프로젝트 없음'}
                  {r.dryRun ? ' · dry-run' : ''}
                </span>
                <Counts counts={r.counts} />
              </a>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
