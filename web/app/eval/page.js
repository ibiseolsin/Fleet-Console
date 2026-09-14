import { EVAL_FILES, matchRate, readEvals } from '../../../src/fleet/evals.mjs';
import { STAGES, fmtMs, fmtTokens, readUsage, slowestStage, stageTotals, tokenSum } from '../../../src/fleet/usage.mjs';

/**
 * 비용·시간 패널 (`PRD.md §6`) — 회차별 소요 시간과 토큰, 그리고 **어느 단계가 병목인지**.
 *
 * 계측은 `scripts/import-usage.mjs` 가 반입해 `data/usage/cycles.json` 에 커밋한다.
 * 화면은 읽기만 한다 — 원본(플릿 로그·세션 기록)이 없는 기계에서도 떠야 하기 때문이다.
 *
 * 평가 표 넷(시나리오 일치 · 세팅 비교 · 사유 커버리지 · 사고 분류)은 슬라이스 8~10 의 스크립트가
 * `data/eval/*.json` 으로 남긴 것을 그대로 읽는다. 여기서 다시 재지 않는다 — 화면이 판정을 돌리면
 * 보는 사람마다 다른 수를 보게 된다. 자세한 해석과 표본 수는 `EVAL.md`.
 */
const NUM = (n) => n.toLocaleString('en-US');

/** 가운뎃값. 평균은 431초짜리 한 회차에 끌려간다. */
function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/** 단계별 합계 막대. 표로 그리면 400px 에서 넘친다 — 이름·시간·막대를 세로로 쌓는다. */
function Bars({ rows, sum }) {
  const top = Math.max(...rows.map((r) => r.ms), 1);
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className={'bar' + (r.ms === top ? ' top' : '')} key={r.stage}>
          <span className="name">{r.stage}</span>
          <span className="fill" style={{ width: (sum ? (r.ms / top) * 100 : 0).toFixed(1) + '%' }} />
          <span className="val">
            {fmtMs(r.ms)} · {r.pct.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

export default function EvalPage() {
  const usage = readUsage();
  if (!usage) {
    return (
      <>
        <h1>비용·시간</h1>
        <p className="empty">
          계측 파일이 없다. <code>npm run import:usage</code> 로 반입한다 — 플릿 로그와 세션 기록이 있는 기계에서만 된다.
        </p>
      </>
    );
  }

  const cycles = usage.cycles;
  const timed = cycles.filter((c) => c.ms != null);
  const tokened = cycles.filter((c) => c.tokens);
  const totals = stageTotals(timed);
  const slowest = totals.rows.slice().sort((a, b) => b.ms - a.ms)[0];
  const midMs = median(timed.map((c) => c.ms));
  const midTok = median(tokened.map((c) => tokenSum(c.tokens)));
  const maxCycle = timed.slice().sort((a, b) => b.ms - a.ms)[0];
  const sumTok = tokened.reduce((a, c) => a + tokenSum(c.tokens), 0);
  const cacheRead = tokened.reduce((a, c) => a + c.tokens.cacheRead, 0);

  return (
    <>
      <h1>비용·시간</h1>
      <p className="lede">
        회차 <b>{timed.length}개</b>의 소요 시간과 <b>{tokened.length}개</b>의 토큰. 회차 기록에는 시간이 없고 기존 토큰 요약은
        프로젝트·주 단위라, 플릿 로그의 줄 시각과 에이전트 세션 기록을 <b>회차 시각 범위로</b> 새로 묶은 것이다 — 규칙과 한계는{' '}
        <code>data/usage-report.md</code>.
      </p>

      <section className="stage">
        <div className="head">
          <b>한눈에</b>
          <span>가운뎃값으로 본다 — 평균은 가장 긴 회차 하나에 끌려간다</span>
        </div>
        <div className="rows">
          <dl className="row">
            <div>
              <dt>회차 소요 (가운뎃값)</dt>
              <dd>{fmtMs(midMs)}</dd>
            </div>
            <div>
              <dt>가장 오래 걸린 회차</dt>
              <dd>
                {fmtMs(maxCycle.ms)} — <a href={'/runs/' + maxCycle.slug}>{maxCycle.date} {maxCycle.time}</a>
              </dd>
            </div>
            <div className="why">
              <dt>가장 오래 걸린 단계</dt>
              <dd>
                {slowest.stage} — 전체 {slowest.pct.toFixed(1)}%
              </dd>
            </div>
            <div>
              <dt>회차 토큰 (가운뎃값)</dt>
              <dd>{fmtTokens(midTok)}</dd>
            </div>
            <div>
              <dt>토큰 합계</dt>
              <dd>
                {fmtTokens(sumTok)} · 그중 캐시 읽기 {((cacheRead / sumTok) * 100).toFixed(1)}%
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="stage">
        <div className="head">
          <b>단계별 합계</b>
          <span>{timed.length}개 회차를 가로질러 어디에 시간이 갔나</span>
        </div>
        <Bars rows={totals.rows} sum={totals.sum} />
        <p className="lede">
          로그는 단계가 <b>끝날 때</b> 한 줄을 남기지 시작할 때는 안 남긴다. 그래서 각 구간은 &ldquo;앞 줄 다음부터 이 줄까지&rdquo;이고,
          실행 네 단계에는 그 앞의 관찰·판정이 얼마간 섞여 있다. 마지막 구간(마지막 실행 → 보고 쓰기)이 <code>관찰·기록</code> 이고 아무
          실행도 없던 회차는 통째로 이것이다. 회차 시작은 분 단위라 소요 시간은 최대 59초 길게 나온다.
        </p>
      </section>

      <h2>회차별 {cycles.length}개</h2>
      <p className="lede">
        최신 먼저. 시각을 누르면 그 회차의 관찰 → 판정 → 실행이 나온다. <code>—</code> 는 그 회차에 붙일 기록이 없었다는 뜻이다.
      </p>
      <div className="runs">
        {cycles.map((c) => {
          const s = slowestStage(c);
          return (
            <a className="run" href={'/runs/' + c.slug} key={c.slug}>
              <span className="time">{c.time}</span>
              <span className="projects">
                {c.date}
                {c.sessions ? ' · 세션 ' + c.sessions + '개' : ''}
              </span>
              <span className="counts">
                <span className={'n' + (c.ms == null ? '' : ' on')}>{fmtMs(c.ms)}</span>
                <span className={'n' + (s ? ' on warn' : '')}>{s ? s[0] + ' ' + fmtMs(s[1]) : '단계 —'}</span>
                <span className={'n' + (c.tokens ? ' on' : '')}>{c.tokens ? fmtTokens(tokenSum(c.tokens)) : '토큰 —'}</span>
              </span>
            </a>
          );
        })}
      </div>

      <h2>토큰 갈래</h2>
      <p className="lede">
        캐시 읽기를 따로 세지 않으면 나머지가 안 보인다 — 한 세션이 같은 맥락을 매 턴 다시 읽는 것이 비용의 거의 전부다.
        프로젝트별·모델별 비중은 <code>data/usage-report.md</code> 에 있다(절대치는 내지 않는다).
      </p>
      <div className="rows">
        <dl className="row">
          {[
            ['입력', 'in'],
            ['출력', 'out'],
            ['캐시 생성', 'cacheCreate'],
            ['캐시 읽기', 'cacheRead'],
          ].map(([label, key]) => {
            const n = tokened.reduce((a, c) => a + c.tokens[key], 0);
            return (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  {NUM(n)} · {((n / sumTok) * 100).toFixed(1)}%
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      <p className="lede">단계 이름은 {STAGES.join(' · ')} 다섯이다.</p>

      <Evals />
    </>
  );
}

/* ─── 평가 표 넷 (슬라이스 10) ─────────────────────────────────────────────── */

/** 결과 배지 색. 일치는 강조색, 불일치는 정지색, 재생 불가는 흐리게. */
const RESULT_TAG = { match: ['일치', ''], mismatch: ['불일치', ' stop'], skip: ['재생 불가', ' dim'] };

/** 표 하나가 없을 때. 수를 지어내지 않고 만드는 명령을 알려 준다. */
function Missing({ what, cmd }) {
  return (
    <p className="empty">
      {what} 결과 파일이 없다. <code>{cmd}</code> 로 만든다.
    </p>
  );
}

/** 수를 담는 표. 첫 칸은 이름, 나머지는 수다. `wrapLast` 면 마지막 칸만 줄바꿈을 허용한다. */
function Table({ head, rows }) {
  return (
    <div className="tblwrap">
      <table className="tbl">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.hi ? 'hi' : undefined}>
              {r.cells.map((c, j) => (
                <td
                  key={j}
                  className={j === 0 ? undefined : r.wrapLast && j === r.cells.length - 1 ? 'wrap-cell' : 'num'}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 시나리오 재생 (`PRD.md §9` 열 개). 한 줄에 결과와 판정 시간을 두고 기대·실제는 접어 둔다 —
 * 문장이 길어 펼쳐 두면 400px 에서 무너진다.
 */
function Scenarios({ data }) {
  if (!data) return <Missing what="시나리오 재생" cmd={EVAL_FILES.scenarios} />;
  const c = data.counts;
  const rate = matchRate(data);
  return (
    <>
      <div className="rows">
        <dl className="row">
          <div className="why">
            <dt>재생 일치율</dt>
            <dd>
              {rate.toFixed(1)}% — 재생 {c.replayed} 중 일치 {c.matched}
            </dd>
          </div>
          <div>
            <dt>불일치 · 재생 불가</dt>
            <dd>
              {c.mismatched} · {c.skipped}
            </dd>
          </div>
          <div>
            <dt>가장 오래 걸린 시나리오</dt>
            <dd>
              {(data.timing.maxMs / 1000).toFixed(2)}초 / 상한 {data.budgetMs / 1000}초
            </dd>
          </div>
        </dl>
      </div>
      <div className="cases">
        {data.scenarios.map((s) => {
          const [label, cls] = RESULT_TAG[s.result] || [s.result, ' warn'];
          return (
            <details className="case" key={s.n}>
              <summary>
                <b>
                  {s.n}. {s.name}
                </b>
                <span className={'tag' + cls}>{label}</span>
                <span className="tag dim">{s.ms == null ? '재생 안 함' : s.ms + 'ms'}</span>
              </summary>
              <dl>
                <div>
                  <dt>기대</dt>
                  <dd>{s.expect}</dd>
                </div>
                <div>
                  <dt>실제</dt>
                  <dd>{s.actual}</dd>
                </div>
              </dl>
            </details>
          );
        })}
      </div>
    </>
  );
}

/** 세팅 비교 (슬라이스 9). 조합마다 자격·보류·사람 호출이 어떻게 갈리나. */
function Settings({ data }) {
  if (!data) return <Missing what="세팅 비교" cmd={EVAL_FILES.settings} />;
  const rows = data.rows.map((r) => ({
    hi: r.resumeMax === data.baseline.settings.resumeMax && r.caps === data.axes.fixedCap,
    cells: [
      r.caps + ' / ' + r.resumeMax,
      r.slices.eligible,
      r.slices.held,
      r.holds['cap-project'] || 0,
      r.resumeActions.exhausted || 0,
      r.callsTotal,
    ],
  }));
  const changed = data.sweeps.resumeMax.watched.filter((w) => new Set(w.actions).size > 1);
  return (
    <>
      <Table head={['동시 / 재개 상한', '파견 자격', '보류', 'cap-project', '재개 소진', '사람 호출']} rows={rows} />
      <p className="lede">
        <b>표본이 작다.</b> 기준 세팅에서 <code>cap-project</code> 로 떨어지는 슬라이스는 픽스처 전체에서{' '}
        {data.sample.capProjectSlices}개다 — 동시 상한을 3으로 올리면 이미 0이 되고 5는 아무것도 더 움직이지 않는다. 수가 안
        는다고 픽스처를 늘리면 위 시나리오의 표본이 같이 바뀐다. 재개 상한 1→3 에서 갈래가 바뀌는 워크스페이스는 둘이다
        {changed.map((w) => ' · ' + w.where + ' ' + w.actions.join(' → '))}.
      </p>
    </>
  );
}

/** 사유 분류 커버리지 + 헛호출 (슬라이스 10). */
function Coverage({ data }) {
  if (!data) return <Missing what="사유 커버리지" cmd={EVAL_FILES.coverage} />;
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');
  const rows = data.tables.map((t) => ({
    cells: [
      t.table + ' / ' + t.column,
      t.kind,
      t.samples,
      t.unique,
      pct(t.hold.coded, t.samples),
      pct(t.own.coded, t.samples),
      t.own.other,
    ],
  }));
  const needs = data.calls.needs.filter((n) => n.items);
  return (
    <>
      <Table head={['표 / 열', '무엇인가', '표본', '고유', 'holdOf', '전용 분류표', '못 알아본 것']} rows={rows} />
      <p className="lede">
        회차 {data.runs.cycles}개에서 뽑은 문장이다. <code>holdOf</code> 는 <b>파견 보류</b> 사유의 코드표라 착륙 막힘과 사람
        호출 문장은 거의 못 알아본다 — 그래서 표마다 분류표를 따로 뒀다(<code>src/fleet/reasons.mjs</code>). 같은 분류표를 지금
        관찰의 막힘 사유 {data.live.samples}건에도 먹여 <code>other</code> 가 {data.live.other}건임을 확인한다 — 기록과 지금
        판정이 같은 라벨을 받는다.
      </p>

      <h3>헛호출 — 사람을 부른 항목을 사후 분류</h3>
      <Table
        head={['사람이 할 일', '고유 항목', '행']}
        rows={needs.map((n) => ({
          hi: n.need === '판단',
          cells: [
            n.need,
            n.items + ' (' + pct(n.items, data.calls.totals.items) + ')',
            n.rows + ' (' + pct(n.rows, data.calls.totals.rows) + ')',
          ],
        }))}
      />
      <p className="lede">
        같은 항목이 답을 받을 때까지 회차마다 다시 올라오므로 행 {data.calls.totals.rows}개는 고유 항목{' '}
        {data.calls.totals.items}개다. <b>헛호출률</b>(사람 <b>판단</b>이 정말 필요했나)은 고유 기준{' '}
        {data.calls.strict.items.toFixed(1)}% · 행 기준 {data.calls.strict.rows.toFixed(1)}% 이고, 손이라도 필요했던 것까지 세면
        각각 {data.calls.loose.items.toFixed(1)}% · {data.calls.loose.rows.toFixed(1)}% 다. <code>PRD.md §8</code> 의 목표는
        80% 이고 <b>둘 다 못 넘는다</b> — 가장 큰 몫이 초기화되면 저절로 풀리는 한도 보고다. 갈래별 수와 근거는{' '}
        <code>EVAL.md</code>.
      </p>
    </>
  );
}

/** 사고 분류 (슬라이스 10). 원인이 어느 단계에서 생겼나. */
function Incidents({ data }) {
  if (!data) return <Missing what="사고 분류" cmd={EVAL_FILES.incidents} />;
  return (
    <>
      <Table
        head={['원인 단계', '건수', '번호']}
        rows={data.stages.map((s) => ({ wrapLast: true, cells: [s.stage, s.n, s.cases.join(', ')] }))}
      />
      <p className="lede">
        운영 기록의 규칙 근거 표 {data.source.rows}행 중 제외 목록 프로젝트가 든 행 {data.source.dropped}개를 빼고{' '}
        {data.source.kept}행을 들여왔다(<code>ANONYMIZATION.md §1</code> — 이름만 지우지 않고 통째로 뺀다). 그중 실제 사고는{' '}
        <b>{data.counts.incidents}건</b>이고 나머지 {data.counts.notIncidents}행은 사용자 결정·점검 결과·기능 설명이다 —{' '}
        <b>표 행 수는 사고 수가 아니다.</b> 단계 라벨은 사람이 읽고 붙였다.
      </p>
    </>
  );
}

/**
 * 표 넷. `PRD.md §6` 화면 표가 `/eval` 에 두기로 한 "세팅별 비교표, 실패 사례" 가 여기다.
 * 판정 일치율을 **두 축**으로 나눈 이유는 `EVAL.md` 머리말과 같다 — 회차 기록에는 결과 문장만
 * 있고 그 시점의 저장소 상태가 없어 기록을 그대로 재생해 대조할 수가 없다.
 */
function Evals() {
  const { scenarios, settings, coverage, incidents } = readEvals();
  return (
    <>
      <h2>판정 일치율 — 축 하나: 시나리오 재생</h2>
      <p className="lede">
        <code>PRD.md §9</code> 의 시나리오 열 개를 픽스처로 재생해 기대와 대조한다. 재생은 관찰 결과를 읽는 것이고 판정 규칙을
        새로 만들지 않는다. 사람이 적은 기대와 실제 판정이 아래에 나란히 있다.
      </p>
      <Scenarios data={scenarios} />

      <h2>세팅 비교</h2>
      <p className="lede">
        동시 상한과 재개 상한을 갈아 끼워 같은 픽스처를 다시 관찰한 결과다. 판정 규칙이 아니라 판정에 넘기는 입력값을 바꾼 것이다.
        바탕이 밝은 줄은 두 축의 기준값이 만나는 조합이다 — 기준 세팅의 동시 상한은 프로젝트마다 달라(픽스처 정의) 이 표의 한 줄과
        정확히 같지는 않다.
      </p>
      <Settings data={settings} />

      <h2>판정 일치율 — 축 둘: 사유 분류 커버리지</h2>
      <p className="lede">
        반입한 회차 기록에는 결과 문장만 있고 그 시점의 저장소 상태가 없어 재생해 대조할 수가 없다. 대신 <b>그 문장을 코드가
        알아보는가</b>를 잰다.
      </p>
      <Coverage data={coverage} />

      <h2>사고 분류</h2>
      <p className="lede">
        축적된 사고를 원인 단계별로 나눈 것이다(<code>PRD.md §9</code>). 무엇을 고쳐야 헛호출과 막힘이 줄어드는지가 여기서 보인다.
      </p>
      <Incidents data={incidents} />
    </>
  );
}
