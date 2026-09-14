/**
 * 가짜 모델 (슬라이스 14) — `FLEET_AGENT_FAKE=1` 이면 루프가 OpenAI 대신 이것을 부른다.
 *
 * Chat Completions 응답과 같은 꼴(`choices[0].message` · `usage`)을 **대화 기록만 보고 결정적으로** 낸다.
 * 네트워크·키 없이 루프의 모양 — 관찰 → 쓰기 앞에서 멈춤 → 승인 뒤 같은 인자로 재호출 → 보고 — 을
 * 검사하려는 것이다. 판정은 하지 않는다: 무엇을 고를지는 도구가 낸 문장(`[착륙 자격]` · `[파견 가능]`)을
 * 그대로 읽는다.
 *
 *   status → slices → 쓰기 도구 하나 → (pending 이면) 도구 없이 보고
 *   재개 지시에 "승인됐다" → 같은 인자로 재호출 → 보고
 *   첫 지시에 "끝없이" → 읽기 도구만 계속 (반복 상한 시험)
 *
 * 응답마다 `FLEET_AGENT_FAKE_DELAY_MS`(기본 500ms)를 기다린다 — 시간 상한 시험이 걸릴 틈이다.
 */
const WRITE = ['fleet_dispatch', 'fleet_land'];

let seq = 0;
const call = (name, args, reason) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_fake_' + ++seq + '_' + Date.now().toString(36), type: 'function', function: { name, arguments: JSON.stringify({ ...args, reason }) } }],
});
const say = (content) => ({ role: 'assistant', content });

function aborted() {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}
const wait = (ms, signal) =>
  new Promise((ok, fail) => {
    if (signal?.aborted) return fail(aborted());
    const t = setTimeout(ok, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), fail(aborted())), { once: true });
  });

/** 도구 결과 문장에서 첫 후보를 고른다 — 착륙 자격이 먼저, 그다음 파견 가능 (시스템 지시의 우선순위). */
function choose(status = '', slices = '') {
  const scan = (text, re, make) => {
    let project = null;
    for (const line of text.split('\n')) {
      const h = line.match(/^(\S+) — 단계 /);
      if (h) project = h[1];
      const m = project && line.match(re);
      if (m) return make(project, m[1]);
    }
    return null;
  };
  return (
    scan(status, /^ {2}(\S+) \[착륙 자격\]/, (project, workspace) => ({ tool: 'fleet_land', args: { project, workspace }, why: project + '/' + workspace + ' 가 착륙 자격이 있다 — 끝난 일을 먼저 본체로 돌린다' })) ||
    scan(slices, /^ {2}(\d+)\. .*\[파견 가능\]/, (project, n) => ({ tool: 'fleet_dispatch', args: { project, slice: Number(n) }, why: project + ' ' + n + '번이 파견 가능하다' }))
  );
}

function decide(messages) {
  const users = messages.filter((m) => m.role === 'user');
  const first = users[0]?.content || '';
  const last = users.at(-1)?.content || '';
  const since = messages.lastIndexOf(users.at(-1));
  const calls = (from = 0) => messages.slice(from).flatMap((m) => m.tool_calls || []);
  const resultOf = (c) => messages.find((m) => m.role === 'tool' && m.tool_call_id === c?.id)?.content || '';
  const lastOf = (names, from = 0) => calls(from).filter((c) => names.includes(c.function.name)).at(-1);
  const head = (text) => text.split('\n').slice(0, 2).join(' / ');

  if (first.includes('끝없이')) return call('fleet_report', { limit: 1 }, '반복 상한 시험 — 읽기 도구를 끝없이 부른다');
  if (last.includes('승인됐다')) {
    const done = lastOf(WRITE, since);
    if (done) return say('승인된 호출을 다시 불렀다 — ' + head(resultOf(done)));
    const prev = lastOf(WRITE);
    if (!prev) return say('다시 부를 쓰기 호출이 기록에 없다.');
    const { reason, ...args } = JSON.parse(prev.function.arguments);
    return call(prev.function.name, args, '승인됐다고 전달받아 같은 인자로 다시 부른다');
  }
  if (last.includes('보류됐다') || last.includes('은 이미 ')) return say('그 대상은 하지 않는다. 남은 후보는 다음 회차에 본다.');

  const names = calls().map((c) => c.function.name);
  if (!names.includes('fleet_status')) return call('fleet_status', {}, '무엇이 왜 멈춰 있는지 플릿 현황부터 본다');
  if (!names.includes('fleet_slices')) return call('fleet_slices', {}, '다음에 띄울 슬라이스의 파견 자격을 본다');
  const write = lastOf(WRITE);
  if (write) return say('고른 쓰기 호출의 결과 — ' + head(resultOf(write)));
  const pick = choose(resultOf(lastOf(['fleet_status'])), resultOf(lastOf(['fleet_slices'])));
  if (!pick) return say('착륙 자격도 파견 가능한 슬라이스도 없다 — 사유는 도구가 낸 그대로다.');
  return call(pick.tool, pick.args, pick.why);
}

async function fakeCompletion({ messages }, signal) {
  await wait(Number(process.env.FLEET_AGENT_FAKE_DELAY_MS ?? 500), signal);
  const message = decide(messages);
  return {
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4), completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } },
  };
}

export { fakeCompletion };
