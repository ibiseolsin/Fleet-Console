import { notFound } from 'next/navigation';
import { COUNT_KEYS, allRuns } from '../../../lib/runs';
import { fmtMs, fmtTokens, readUsage, slowestStage, tokenSum, usageOf } from '../../../../src/fleet/usage.mjs';

/**
 * 회차 상세 — **관찰 → 자격 판정 → 실행** 순서로 세운다 (`PRD.md §3`).
 * 기록의 표 넷은 그 순서가 아니라 결과 종류별로 적혀 있어서, 여기서 단계에 맞춰 다시 묶는다.
 */
const STAGES = [
  { title: '자격 판정', hint: '규칙이 무엇을 왜 막았나', tables: ['막힘', '결정 필요'] },
  { title: '실행', hint: '승인을 지나 실제로 한 것', tables: ['착륙', '파견'] },
];

/** 그 칸이 **사유**인 열. 도구가 내는 것도 화면이 보여주는 것도 결국 이 한 칸이다. */
const WHY = new Set(['이유', '내용', '비고', '지시', '결과']);

function Rows({ rows }) {
  return (
    <div className="rows">
      {rows.map((row, i) => (
        <dl className="row" key={i}>
          {Object.entries(row).map(([k, v]) => (
            <div key={k} className={WHY.has(k) ? 'why' : undefined}>
              <dt>{k}</dt>
              <dd>{v || '—'}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

/**
 * 이 회차의 시간·토큰 (슬라이스 6). 기록에 없는 것이라 따로 반입한다 — 여기서는 읽기만 한다.
 * 단계 이름은 그 구간을 **끝낸** 로그 줄의 이름이다 (`src/fleet/usage.mjs` 의 STAGES 머리말).
 */
function Cost({ cost }) {
  if (!cost) return null;
  const slow = slowestStage(cost);
  const stages = cost.stages ? Object.entries(cost.stages).filter(([, ms]) => ms > 0) : [];
  return (
    <section className="stage">
      <div className="head">
        <b>시간·토큰</b>
        <span>이 회차가 얼마나 걸렸고 얼마를 썼나</span>
      </div>
      <div className="rows">
        <dl className="row">
          <div>
            <dt>소요</dt>
            <dd>{fmtMs(cost.ms)}</dd>
          </div>
          {slow ? (
            <div className="why">
              <dt>가장 오래 걸린 단계</dt>
              <dd>
                {slow[0]} {fmtMs(slow[1])}
              </dd>
            </div>
          ) : null}
          {stages.length ? (
            <div>
              <dt>단계</dt>
              <dd>{stages.map(([k, ms]) => k + ' ' + fmtMs(ms)).join(' · ')}</dd>
            </div>
          ) : null}
          {cost.tokens ? (
            <div>
              <dt>토큰</dt>
              <dd>
                {fmtTokens(tokenSum(cost.tokens))} (입력 {fmtTokens(cost.tokens.in)} · 출력 {fmtTokens(cost.tokens.out)} · 캐시 생성{' '}
                {fmtTokens(cost.tokens.cacheCreate)} · 캐시 읽기 {fmtTokens(cost.tokens.cacheRead)})
              </dd>
            </div>
          ) : null}
          <div>
            <dt>세션</dt>
            <dd>{cost.sessions ? cost.sessions + '개 · 메시지 ' + cost.messages + '개' : '이 회차 범위에 붙은 세션 기록 없음'}</dd>
          </div>
        </dl>
      </div>
      <p className="lede">
        구간 이름은 그것을 <b>끝낸</b> 로그 줄의 단계다 — 실행 앞의 관찰·판정이 얼마간 섞여 있다. 회차 시작이 분 단위라 소요는 최대
        59초 길게 나온다. 전체는 <a href="/eval">비용·시간</a>.
      </p>
    </section>
  );
}

export default async function RunPage({ params }) {
  const { slug } = await params;
  const runs = allRuns().runs;
  const i = runs.findIndex((r) => r.slug === slug);
  if (i < 0) notFound();
  const run = runs[i];
  const newer = runs[i - 1] || null; // 목록이 최신 먼저라 앞쪽이 더 최근이다
  const older = runs[i + 1] || null;

  return (
    <>
      <a className="back" href="/runs">
        ← 회차 목록
      </a>
      <h1>
        {run.date} {run.time} 회차{run.dryRun ? ' (dry-run)' : ''}
      </h1>
      <p className="meta">
        {COUNT_KEYS.map((k) => k + ' ' + (run.counts[k] || 0)).join(' · ')}
      </p>
      <p className="lede">출처 {run.file} · 그날의 {run.seq}번째 회차</p>

      <Cost cost={usageOf(readUsage(), slug)} />

      <section className="stage">
        <div className="head">
          <b>관찰</b>
          <span>이번 회차가 무엇을 봤나</span>
        </div>
        <div className="rows">
          <dl className="row">
            <div>
              <dt>프로젝트</dt>
              <dd>{run.projects.join(', ') || '—'}</dd>
            </div>
            {/* `detail` 은 요약 줄의 괄호 안이다 — `프로젝트(…)` 는 바로 위 줄과 같은 값이라 뺀다. */}
            {Object.entries(run.detail)
              .filter(([k]) => k !== '프로젝트')
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
        </div>
        {run.notes.length ? (
          <div className="notes">
            {run.notes.map((n, k) => (
              <div key={k}>{n}</div>
            ))}
          </div>
        ) : (
          <p className="empty">본체 동기화·경고 없음</p>
        )}
      </section>

      {STAGES.map((stage) => (
        <section className="stage" key={stage.title}>
          <div className="head">
            <b>{stage.title}</b>
            <span>{stage.hint}</span>
          </div>
          {stage.tables.map((name) => {
            const rows = run.tables[name] || [];
            return (
              <div key={name}>
                <h3>
                  {name} {rows.length}
                </h3>
                {rows.length ? <Rows rows={rows} /> : <p className="empty">없음</p>}
              </div>
            );
          })}
        </section>
      ))}

      <nav className="pager">
        {older ? <a href={'/runs/' + older.slug}>← 이전 회차 {older.date} {older.time}</a> : null}
        {newer ? <a href={'/runs/' + newer.slug}>다음 회차 {newer.date} {newer.time} →</a> : null}
      </nav>
    </>
  );
}
