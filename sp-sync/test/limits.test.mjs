// node --test sp-sync/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeLimit, codexLimit, limitOf, limitText, newestRollouts, stillReached, toMs, windowReached } from '../sp-sync.mjs';

// 실물 파일 두 형식을 그대로 굳혀 둔다 (2026-09-02·09-03 이 PC 에서 뜬 값).
// 형식이 바뀌면 여기가 먼저 깨져야 한다 — 안 그러면 조용히 `모름` 으로 떨어져서, "한도가 여유"와
// "못 읽었다"가 겉으로 구분되지 않는다.
const NOW = Date.parse('2026-09-02T18:15:00Z');
const S = (ms) => ms / 1000; // 원본의 초 단위

const claudeFile = (dir, over = {}) => {
  const f = join(dir, 'data.json');
  writeFileSync(
    f,
    JSON.stringify({
      ok: true,
      fetchedAt: NOW - 60000, // 밀리초 — resetsAt(초)과 섞이는 자리
      fiveHour: { percent: 47, resetsAt: S(NOW + 3600000) + 0.143 },
      sevenDay: { percent: 37, resetsAt: S(NOW + 86400000) + 0.143 },
      scoped: [{ name: 'Fable', percent: 57, resetsAt: S(NOW + 86400000) + 0.143, severity: 'normal', active: true }],
      ...over,
    })
  );
  return f;
};

const rollout = (dir, { at, primary = 42, secondary = 13, reachedType = null, resets = NOW + 3600000, lines = null } = {}) => {
  const f = join(dir, 'rollout-' + new Date(at).toISOString().replace(/[:.]/g, '-') + '-x.jsonl');
  const body = lines || [
    JSON.stringify({ timestamp: new Date(at - 1000).toISOString(), type: 'session_meta', payload: { cwd: 'C:/w/slice12' } }),
    JSON.stringify({
      timestamp: new Date(at).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: primary, window_minutes: 300, resets_at: S(resets) },
          secondary: { used_percent: secondary, window_minutes: 10080, resets_at: S(NOW + 500000000) },
          plan_type: 'plus',
          rate_limit_reached_type: reachedType,
        },
      },
    }),
  ];
  writeFileSync(f, body.join('\n') + '\n');
  const t = at / 1000;
  utimesSync(f, t, t);
  return f;
};

const tmp = () => mkdtempSync(join(tmpdir(), 'sp-limits-'));

// ---------- 단위 통일 ----------
test('toMs — 초와 밀리초가 섞여 들어와도 밀리초로 나온다', () => {
  assert.equal(toMs(1788378000.143), 1788378000143); // Claude·codex 의 resetsAt (초)
  assert.equal(toMs(1788372128174), 1788372128174); // fetchedAt (밀리초)
  assert.equal(toMs(0), null);
  assert.equal(toMs(null), null);
  assert.equal(toMs('x'), null);
});

// ---------- Claude ----------
test('Claude 캐시 — 5시간·7일과 모델별 scoped 를 함께 읽는다', () => {
  const dir = tmp();
  const l = claudeLimit({ file: claudeFile(dir), now: NOW });
  assert.equal(l.agent, 'claude');
  assert.equal(l.pct5h, 47);
  assert.equal(l.pct7d, 37);
  // scoped 는 이름 그대로 — Fable 만 막히는 경우가 있어서 5시간·7일로 대신할 수 없다
  assert.deepEqual(Object.keys(l.models), ['Fable']);
  assert.equal(l.models.Fable.pct, 57);
  assert.equal(l.models.Fable.resetsAt, NOW + 86400000 + 143);
  assert.equal(l.resetsAt, NOW + 3600000 + 143, '막힌 것이 없으면 5시간 창의 초기화 시각');
  assert.equal(l.reached, false);
  rmSync(dir, { recursive: true, force: true });
});

test('Claude — 5시간·7일이 여유여도 Fable 만 100 이면 막힘이다', () => {
  const dir = tmp();
  const f = claudeFile(dir, { scoped: [{ name: 'Fable', percent: 100, resetsAt: S(NOW + 7200000), active: true }] });
  const l = claudeLimit({ file: f, now: NOW });
  assert.equal(l.reached, true, '[어려움] 이 Fable 로 뜨므로 이걸 놓치면 그 슬라이스만 조용히 죽는다');
  assert.equal(l.resetsAt, NOW + 7200000, '막고 있는 창의 초기화 시각을 쓴다');
  assert.equal(l.pct5h, 47);
  rmSync(dir, { recursive: true, force: true });
});

test('Claude — 파일이 없거나 묵었으면 null (모르면 막지 않는다)', () => {
  const dir = tmp();
  assert.equal(claudeLimit({ file: join(dir, '없음.json'), now: NOW }), null);
  const f = claudeFile(dir, { fetchedAt: NOW - 4 * 3600000 }); // 4시간 전 — 기본 180분을 넘는다
  assert.equal(claudeLimit({ file: f, now: NOW }), null, 'Claude 창이 하나도 없으면 캐시가 이렇게 묵는다');
  assert.ok(claudeLimit({ file: f, now: NOW, staleMs: 5 * 3600000 }), '기준을 늘리면 같은 파일이 읽힌다');
  // 값 자체가 없는 파일도 null 이다 — 빈 객체를 0% 로 읽으면 안 된다
  writeFileSync(join(dir, 'empty.json'), JSON.stringify({ ok: false, fetchedAt: NOW, error: 'x' }));
  assert.equal(claudeLimit({ file: join(dir, 'empty.json'), now: NOW }), null);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- codex ----------
test('codex rollout — primary/secondary 를 5시간·7일로 읽고 워크트리는 부가 정보다', () => {
  const dir = tmp();
  const day = join(dir, '2026', '09', '03');
  mkdirSync(day, { recursive: true });
  rollout(day, { at: NOW - 600000 });
  const l = codexLimit({ dir, now: NOW });
  assert.equal(l.agent, 'codex');
  assert.equal(l.pct5h, 42);
  assert.equal(l.pct7d, 13);
  assert.equal(l.resetsAt, NOW + 3600000);
  assert.equal(l.reached, false);
  assert.equal(l.cwd, 'C:/w/slice12', '한도는 계정 것이고 워크트리는 참고만');
  rmSync(dir, { recursive: true, force: true });
});

test('codex — rate_limits 가 없는 rollout 은 건너뛰고 다음(더 옛) 파일을 본다', () => {
  const dir = tmp();
  const day = join(dir, '2026', '09', '03');
  mkdirSync(day, { recursive: true });
  rollout(day, { at: NOW - 900000, primary: 55 });
  // **첫 요청부터 막힌 턴**은 rate_limits 를 한 줄도 안 남긴다 — 그게 최신 파일이다
  rollout(day, { at: NOW - 60000, lines: [JSON.stringify({ timestamp: new Date(NOW - 60000).toISOString(), type: 'session_meta', payload: { cwd: 'C:/w/slice12' } })] });
  const l = codexLimit({ dir, now: NOW });
  assert.equal(l.pct5h, 55, '워크트리별로 찾으면 못 읽는 값이다');
  rmSync(dir, { recursive: true, force: true });
});

test('codex — 가장 최근 값이 묵었으면 null, 폴더가 아예 없어도 null', () => {
  const dir = tmp();
  const day = join(dir, '2026', '09', '01');
  mkdirSync(day, { recursive: true });
  rollout(day, { at: NOW - 5 * 3600000 });
  assert.equal(codexLimit({ dir, now: NOW }), null);
  assert.ok(codexLimit({ dir, now: NOW, staleMs: 6 * 3600000 }));
  assert.equal(codexLimit({ dir: join(dir, '없음'), now: NOW }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('codex — rate_limit_reached_type 이 있으면 퍼센트와 무관하게 막힘이다', () => {
  const dir = tmp();
  const day = join(dir, '2026', '09', '03');
  mkdirSync(day, { recursive: true });
  rollout(day, { at: NOW - 60000, primary: 99, reachedType: 'primary' });
  const l = codexLimit({ dir, now: NOW });
  assert.equal(l.reached, true);
  assert.equal(l.reachedType, 'primary');
  rmSync(dir, { recursive: true, force: true });
});

test('codex — 파일 순서가 아니라 기록 시각이 가장 늦은 rate_limits 를 쓴다 (2026-09-03 slice8)', () => {
  // 16:00 에 시작한 긴 세션이 16:24 에 100%·막힘을 적었고, 16:10 에 시작한 짧은 세션은 83% 다.
  // 긴 세션 파일은 이름도 mtime 도 앞서 있다(Windows 에서 codex 가 쓰는 동안 mtime 이 안 오른다).
  const dir = tmp();
  const day = join(dir, '2026', '09', '03');
  mkdirSync(day, { recursive: true });
  const long = rollout(day, { at: NOW - 24 * 60000, primary: 100, reachedType: 'primary' });
  utimesSync(long, (NOW - 24 * 60000) / 1000, (NOW - 24 * 60000) / 1000);
  // 마지막 기록을 뒤늦게 덧붙인다 — 이름·mtime 은 그대로 둔다
  const late = JSON.stringify({
    timestamp: new Date(NOW - 60000).toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: S(NOW + 3600000) }, rate_limit_reached_type: 'primary' } },
  });
  writeFileSync(long, readFileSync(long, 'utf8') + late + '\n');
  utimesSync(long, (NOW - 24 * 60000) / 1000, (NOW - 24 * 60000) / 1000);
  const short = rollout(day, { at: NOW - 14 * 60000, primary: 83 });
  assert.deepEqual(newestRollouts(dir, 5), [short, long]); // 후보 순서로는 짧은 세션이 먼저다
  const l = codexLimit({ dir, now: NOW });
  assert.equal(l.source, long);
  assert.equal(l.pct5h, 100);
  assert.equal(l.reached, true);
  assert.equal(l.reachedType, 'primary');
  assert.equal(l.fetchedAt, NOW - 60000);
  rmSync(dir, { recursive: true, force: true });
});

test('codex — 창이 없는 크레딧 기록(limit_id premium)은 건너뛰고 그 위의 100% 를 읽는다 (2026-09-03 slice8)', () => {
  const dir = tmp();
  const day = join(dir, '2026', '09', '03');
  mkdirSync(day, { recursive: true });
  const f = rollout(day, { at: NOW - 120000, primary: 100 });
  const credits = JSON.stringify({
    timestamp: new Date(NOW - 60000).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: { limit_id: 'premium', limit_name: null, primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'plus', rate_limit_reached_type: null },
    },
  });
  writeFileSync(f, readFileSync(f, 'utf8') + credits + '\n');
  const l = codexLimit({ dir, now: NOW });
  assert.equal(l.pct5h, 100);
  assert.equal(l.reached, true);
  assert.equal(l.fetchedAt, NOW - 120000); // 크레딧 줄이 아니라 100% 줄의 시각
  assert.equal(stillReached(l, NOW), true);
  rmSync(dir, { recursive: true, force: true });
});

test('newestRollouts — 날짜 폴더를 내림차순으로 훑고 mtime 으로 세운다', () => {
  const dir = tmp();
  for (const d of ['2026/09/01', '2026/09/03']) mkdirSync(join(dir, ...d.split('/')), { recursive: true });
  const old = rollout(join(dir, '2026', '09', '01'), { at: NOW - 86400000 });
  const fresh = rollout(join(dir, '2026', '09', '03'), { at: NOW - 60000 });
  assert.deepEqual(newestRollouts(dir, 5), [fresh, old]);
  assert.deepEqual(newestRollouts(dir, 1), [fresh]);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- 초기화가 지난 창 ----------
test('초기화 시각이 지난 창은 안 센다 — 한 번 막힌 기록이 영영 막힘으로 남으면 안 된다', () => {
  assert.equal(windowReached({ pct: 100, resetsAt: NOW + 1000 }, NOW), true);
  assert.equal(windowReached({ pct: 100, resetsAt: NOW - 1000 }, NOW), false);
  assert.equal(windowReached({ pct: 99, resetsAt: NOW + 1000 }, NOW), false);
  assert.equal(windowReached(null, NOW), false);
  // 세션 기록에 박힌 사진(`limit`)을 나중에 다시 볼 때 쓰는 것이 stillReached 다
  const l = { windows: { fiveHour: { pct: 100, resetsAt: NOW + 1000 }, sevenDay: { pct: 20, resetsAt: NOW + 9e8 } }, models: {} };
  assert.equal(stillReached(l, NOW), true);
  assert.equal(stillReached(l, NOW + 2000), false, '창이 초기화된 뒤에는 더 이상 막힘이 아니다');
  assert.equal(stillReached({ windows: {}, models: {}, reachedType: 'primary', resetsAt: NOW + 1000 }, NOW), true);
  assert.equal(stillReached({ windows: {}, models: {}, reachedType: 'primary', resetsAt: NOW - 1000 }, NOW), false);
  assert.equal(stillReached(null, NOW), false);
});

// ---------- 이름과 표 칸 ----------
test('limitOf — 읽는 법을 모르는 에이전트는 null (모름 = 여유)', () => {
  assert.equal(limitOf('antigravity'), null);
  assert.equal(limitOf(''), null);
  assert.equal(limitOf(null), null);
});

test('limitText — 모르면 빈 칸이 아니라 "모름" 이다', () => {
  assert.equal(limitText(null), '모름'); // 빈 칸이면 0% 로 읽힌다
  assert.equal(limitText({ pct5h: 47, pct7d: 37, models: { Fable: { pct: 57 } } }), '5h 47% · 7d 37% · Fable 57%');
  assert.equal(limitText({ pct5h: 100, pct7d: 37, models: {}, reached: true }), '참 · 5h 100% · 7d 37%');
});
