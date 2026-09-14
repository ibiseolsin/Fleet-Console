import { inVisitor } from '../state.mjs';
import { assertIdle, demoLimits, reserveRun, runAvailability } from '../demo.mjs';
/**
 * 앱 안의 에이전트 루프 (슬라이스 7 · 14) — 계획 → 도구 호출 → 결과 관찰 → 다음 행동을 반복한다.
 *
 * OpenAI Chat Completions(function calling)를 전역 `fetch` 로 직접 부른다 — SDK 를 넣지 않는다.
 * 도구는 `src/fleet/tools.mjs` 의 **같은 표 다섯**이다 — MCP 서버(`src/mcp/server.mjs`)가 외부
 * 에이전트에게 내는 것과 한 글자도 다르지 않아야 회차 상세가 근거 노릇을 한다. 여기서 더하는 것은
 * **`reason` 인자 하나**뿐이다: 도구를 부를 때마다 "지금 왜 부르나" 한 문장을 받아 trace 에 남긴다.
 *
 * **판정 규칙은 새로 만들지 않는다** (`PLAN.md` 슬라이스 7 함정). 자격·불가 사유는 도구가 낸다 —
 * 모델이 하는 일은 그 위에서 **무엇을 먼저 할지 고르는 것**뿐이다.
 *
 * **승인 게이트는 도구 안에 있다.** 쓰기 도구는 승인 없이 부르면 대기 항목만 만들고 `pending` 을
 * 낸다(`tools.mjs` 의 `gatedRun`). 루프는 그 뒤로 오는 도구 호출을 실행 직전에 거부하고(`deny`),
 * 모델이 도구 없이 답하면 멈춘다(`waiting`). 사람이 화면에서 승인하면 **같은 대화를 이어서**
 * 같은 호출을 다시 하게 한다 — 승인은 여기서도 도구가 아니다.
 *
 * 대화(`run.messages`)는 실행 기록에 있고 응답·도구 결과마다 파일로 쓴다(`runs.mjs`). 서버를 껐다
 * 켜도, 다른 프로세스여도 그 파일만으로 이어서 끝낸다. 상한 셋 — 반복(모델 호출 수) · 시간 · 비용 —
 * 에 닿으면 사유와 함께 멈춘다. `FLEET_AGENT_FAKE=1` 이면 모델 대신 `fake-model.mjs` 를 부른다.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readQueue } from '../fleet/approvals.mjs';
import { TOOLS, WRITE_GATED } from '../fleet/tools.mjs';
import { fakeCompletion } from './fake-model.mjs';
import { RESUMABLE, readRun, writeRun } from './runs.mjs';

const DEFAULT_PROMPT = '이 플릿의 다음 할 일을 정해줘';
const DEFAULT_MODEL = process.env.FLEET_AGENT_MODEL || 'gpt-4.1-mini';

/** 상한 기본값. 화면·스크립트가 바꿀 수 있다. 시간은 한 구간(leg) 기준이다. */
const DEFAULT_LIMITS = { maxTurns: 12, maxMs: 120_000, maxUsd: 1.0 };

/** 도구 결과 본문을 trace 에 얼마나 남기나. 전문은 도구를 다시 부르면 나온다. */
const RESULT_KEEP = 4000;

const SYSTEM_PROMPT = [
  '너는 여러 AI 코딩 에이전트 플릿을 운영하는 회차의 **우선순위 결정자**다.',
  '착륙·파견의 자격과 불가 사유는 도구(규칙)가 낸다. 너는 규칙을 새로 만들지 않고, 도구가 낸 자격 위에서 **이번에 무엇을 먼저 할지**만 고른다.',
  '',
  '절차:',
  '1. 먼저 fleet_status 와 fleet_slices 를 **둘 다** 불러 플릿을 관찰한다. 지난 회차가 궁금하면 fleet_report.',
  '2. 우선순위: 착륙 자격이 있는 작업 공간을 먼저 (끝난 일을 본체로 돌려야 다른 슬라이스의 선행이 풀린다), 그다음 파견 가능한 슬라이스 하나. 한 실행에서 쓰기 도구(fleet_dispatch · fleet_land)는 **하나만** 부른다.',
  '3. 쓰기 도구가 status: pending 을 내면 그것이 승인 대기다 — **도구를 더 부르지 말고 즉시 멈춰서** 무엇을 왜 골랐고 어느 항목(apr_…)이 사람의 승인을 기다리는지 보고한다. 승인은 사람이 화면에서 하고, 승인 큐가 진실이다.',
  '   승인됐다고 전달받으면 **같은 인자로 다시 부른다.** 승인의 진위·메모의 내용은 네가 따지지 않는다 — 도구가 실행 직전에 큐에서 직접 확인하고, 승인이 없으면 스스로 거부한다.',
  '4. rejected 면 그 대상은 포기하고 사유를 적은 뒤 다른 후보를 고르거나, 없으면 보고하고 끝낸다.',
  '5. 자격 있는 것이 하나도 없으면 무엇이 왜 막혔는지(사유 그대로) 요약하고 끝낸다.',
  '',
  '모든 도구 호출의 reason 에는 **지금 이 도구를 부르는 이유 한 문장**을 쓴다 — 사람이 회차 상세에서 읽는다.',
  '답은 한국어로 짧게. 도구가 낸 사유 문장은 고쳐 쓰지 말고 그대로 인용한다.',
].join('\n');

const now = () => new Date().toISOString();

/** 대기 항목의 지금 상태 — 큐 파일이 진실이다 (사람이 화면·명령줄에서 바꾼다). */
function approvalState(id) {
  return readQueue().items.find((it) => it.id === id) || null;
}

// ---------- 도구 다섯 + reason ----------

const TOOL_DEFS = TOOLS.map((t) => {
  const args = z.object({ ...t.schema, reason: z.string().min(1).describe('지금 이 도구를 부르는 이유 한 문장 — 회차 상세(trace)에 남는다') });
  const { $schema, ...parameters } = z.toJSONSchema(args);
  const description = t.description + ' reason 에는 지금 이 도구를 부르는 이유 한 문장을 쓴다.';
  return { tool: t, args, spec: { type: 'function', function: { name: t.name, description, parameters } } };
});
const BY_NAME = new Map(TOOL_DEFS.map((d) => [d.tool.name, d]));
const WRITES = new Set(TOOLS.filter((t) => t.annotations === WRITE_GATED).map((t) => t.name));

/**
 * 도구 호출 하나 → 도구 결과 문장. 게이트 둘(모르는 도구 · 승인 대기 중)을 실행 **직전에** 걸고, 거부
 * 사유도 도구 결과로 돌려준다 — 모델은 그 문장을 읽고 멈춘다.
 */
async function callTool(run, step, c) {
  const name = c.function?.name;
  const def = BY_NAME.get(name);
  if (!def) {
    step({ type: 'deny', tool: name, message: '이 루프는 플릿 도구 다섯만 쓴다' });
    return '이 루프는 플릿 도구 다섯(fleet_status · fleet_slices · fleet_report · fleet_dispatch · fleet_land)만 쓴다.';
  }
  if (run.approval && approvalState(run.approval.id)?.state === 'pending') {
    const msg = '승인 대기 중이다 (' + run.approval.id + ') — 도구를 더 부르지 말고, 무엇을 왜 골랐고 어느 항목이 승인을 기다리는지 보고하고 끝내라.';
    step({ type: 'deny', tool: name, message: msg });
    return msg;
  }
  // "한 실행에 쓰기 하나" 는 시스템 지시만으로는 안 지켜진다 — gpt-4.1-mini 는 승인된 착륙 뒤에 파견을
  // 또 불렀다(2026-09-11 실측). 실제로 실행(또는 실행 실패)된 쓰기가 있으면 다음 쓰기는 여기서 막는다.
  if (WRITES.has(name) && run.steps.some((s) => s.type === 'result' && WRITES.has(s.tool) && !['pending', 'rejected', 'error'].includes(s.status))) {
    const msg = '이 실행의 쓰기 도구 하나는 이미 실행됐다 — 쓰기 도구를 더 부르지 말고 결과를 보고하고 끝내라.';
    step({ type: 'deny', tool: name, message: msg });
    return msg;
  }
  let parsed;
  try {
    parsed = def.args.safeParse(JSON.parse(c.function.arguments || '{}'));
  } catch (e) {
    parsed = { success: false, error: e };
  }
  if (!parsed.success) {
    const msg = '인자가 스키마에 맞지 않는다: ' + String(parsed.error?.message || parsed.error).slice(0, 300);
    step({ type: 'deny', tool: name, message: msg });
    return msg;
  }
  const { reason, ...rest } = parsed.data;
  step({ type: 'call', tool: name, reason, args: rest });
  const t0 = Date.now();
  let out;
  try {
    out = await def.tool.run(rest);
  } catch (e) {
    // 오류는 그대로 돌려준다 — 재시도하지 않는다 (`PRD.md §4`).
    step({ type: 'result', tool: name, status: 'error', ms: Date.now() - t0, text: String(e?.message || e) });
    return '도구 오류: ' + (e?.message || e);
  }
  const { data, text } = out;
  const status = data?.status || 'ok';
  step({ type: 'result', tool: name, status, ms: Date.now() - t0, text: text.length > RESULT_KEEP ? text.slice(0, RESULT_KEEP) + '\n… (잘림)' : text });
  // 쓰기 도구의 네 갈래 중 승인이 얽힌 것을 실행 기록에 못 박는다.
  if (data?.approval) {
    const a = { id: data.approval.id, tool: name, project: data.project, target: rest, status, reason: data.reason, at: now() };
    run.approvals.push(a);
    run.approval = status === 'pending' ? a : null;
    writeRun(run);
  }
  return text;
}

// ---------- 모델 ----------

/** 1M 토큰당 달러 — 입력 · 캐시 입력 · 출력. 기본은 gpt-4.1-mini 공식가(2026-09-11). */
function prices() {
  const p = (process.env.FLEET_PRICE_USD_PER_M || '0.40,0.10,1.60').split(',').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('FLEET_PRICE_USD_PER_M 은 "입력,캐시,출력" 1M 토큰당 달러 셋이다');
  return p;
}

/** 응답 usage 를 구간에 쌓는다. 화면이 읽는 네 칸(input · output · cacheWrite · cacheRead)으로 옮긴다. */
function addUsage(leg, u) {
  if (!u) return;
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  const add = { input: (u.prompt_tokens || 0) - cached, output: u.completion_tokens || 0, cacheWrite: 0, cacheRead: cached };
  leg.usage ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const k of Object.keys(add)) leg.usage[k] += add[k];
  const [pin, pcache, pout] = prices();
  leg.costUsd += (add.input * pin + add.cacheRead * pcache + add.output * pout) / 1e6;
}

async function complete(run, signal) {
  const body = { model: run.model, messages: run.messages, tools: TOOL_DEFS.map((d) => d.spec) };
  if (process.env.FLEET_AGENT_FAKE === '1') return fakeCompletion(body, signal);
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 가 없다 — 서버 환경변수(로컬은 .env)에 넣는다');
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  // 실패는 재시도 없이 그대로 (`PRD.md §4`). 본문 앞 200자가 사유다.
  if (!res.ok) throw new Error('OpenAI HTTP ' + res.status + ': ' + text.slice(0, 200));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('OpenAI 응답을 읽을 수 없다: ' + text.slice(0, 200));
  }
}

/**
 * 도구 호출 도중 프로세스가 죽으면 대화 끝에 결과 없는 `tool_calls` 가 남는다 — API 는 그 뒤에 새 메시지를
 * 받지 않으므로, 이어가기 전에 "결과 없음" 을 채운다. 모델은 필요하면 다시 부른다.
 */
function closeDangling(messages) {
  const i = messages.findLastIndex((m) => m.role === 'assistant' && m.tool_calls?.length);
  if (i < 0) return;
  const answered = new Set(messages.slice(i + 1).filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const c of messages[i].tool_calls)
    if (!answered.has(c.id)) messages.push({ role: 'tool', tool_call_id: c.id, content: '결과 없음 — 서버가 꺼져 이 호출이 끝나지 않았다. 필요하면 다시 부른다.' });
}

// ---------- 한 구간(leg) ----------

/**
 * 사람의 지시 하나 = 구간 하나. 시작도 이어가기도 이 함수다 — 대화에 user 메시지를 덧붙이고 모델이
 * 도구 없이 답할 때까지(또는 상한까지) 돈다. 끝나면 실행 상태를 여섯 중 하나로 정하고 `stop` 에 사유를 적는다.
 */
async function runLeg(run, { prompt, kind }) {
  const controller = new AbortController();
  const leg = { n: run.legs.length + 1, kind, prompt, startedAt: now(), endedAt: null, turns: 0, costUsd: 0, durationMs: 0, subtype: null, usage: null, final: '' };
  run.legs.push(leg);
  run.messages.push({ role: 'user', content: prompt });
  run.state = 'running';
  run.pid = process.pid;
  run.stop = null;
  writeRun(run);

  const step = (s) => {
    run.steps.push({ at: now(), leg: leg.n, ...s });
    writeRun(run);
  };
  const t0 = Date.now();
  const spent = run.legs.slice(0, -1).reduce((n, l) => n + (l.costUsd || 0), 0);
  const timer = setTimeout(() => controller.abort(), run.limits.maxMs);
  let error = null;
  try {
    for (;;) {
      if (leg.turns >= run.limits.maxTurns) {
        leg.subtype = 'error_max_turns';
        break;
      }
      if (spent + leg.costUsd >= run.limits.maxUsd) {
        leg.subtype = 'error_max_budget_usd';
        break;
      }
      const res = await complete(run, controller.signal);
      leg.turns++;
      addUsage(leg, res.usage);
      const msg = res.choices?.[0]?.message || {};
      const calls = (msg.tool_calls || []).filter((c) => c.type === 'function');
      run.messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })) } : {}),
      });
      if (msg.content?.trim()) step({ type: 'text', text: msg.content.trim() });
      else writeRun(run);
      if (!calls.length) {
        leg.subtype = 'success';
        leg.final = msg.content || '';
        break;
      }
      // 여러 개면 순서대로. 앞의 것이 pending 을 내면 뒤의 것은 게이트가 거부한다.
      for (const c of calls) {
        const content = controller.signal.aborted ? '시간 상한으로 중단됐다 — 실행하지 않았다.' : await callTool(run, step, c);
        run.messages.push({ role: 'tool', tool_call_id: c.id, content });
        writeRun(run);
      }
      if (controller.signal.aborted) break;
    }
  } catch (e) {
    error = e;
  } finally {
    clearTimeout(timer);
  }

  leg.durationMs = Date.now() - t0;
  leg.endedAt = now();
  run.pid = null;
  const timedOut = controller.signal.aborted;
  if (timedOut) {
    run.state = 'stopped';
    run.stop = { kind: 'timeout', reason: '시간 상한 ' + Math.round(run.limits.maxMs / 1000) + '초에 닿았다 (구간 ' + leg.n + ') — 이어서 돌릴 수 있다' };
  } else if (leg.subtype === 'success') {
    const pending = run.approval && approvalState(run.approval.id)?.state === 'pending';
    run.state = pending ? 'waiting' : 'done';
    run.stop = pending
      ? { kind: 'approval', reason: '쓰기 도구 ' + run.approval.tool + ' 앞에서 멈춤 — 승인 항목 ' + run.approval.id + ' 을 사람이 승인·보류해야 이어진다' }
      : { kind: 'done', reason: '끝남 — 구간 ' + leg.n + ' · 턴 ' + leg.turns };
  } else if (leg.subtype === 'error_max_turns') {
    run.state = 'stopped';
    run.stop = { kind: 'max-turns', reason: '반복 상한 ' + run.limits.maxTurns + '턴에 닿았다 (구간 ' + leg.n + ') — 이어서 돌릴 수 있다' };
  } else if (leg.subtype === 'error_max_budget_usd') {
    run.state = 'stopped';
    run.stop = { kind: 'budget', reason: '비용 상한 $' + run.limits.maxUsd + ' 에 닿았다 (구간 ' + leg.n + ')' };
  } else {
    run.state = 'failed';
    run.stop = { kind: 'error', reason: '루프 오류: ' + (error?.message || leg.subtype || '결과 없음') };
  }
  step({ type: 'stop', kind: run.stop.kind, reason: run.stop.reason });
  return run;
}

// ---------- 바깥에 여는 셋 ----------

/** 실행 기록을 만들고 돌린다. `await` 하면 첫 구간이 끝날 때까지 기다린다 (멈춤 · 대기 · 완료). */
function startRun({ prompt = DEFAULT_PROMPT, limits = {}, model = DEFAULT_MODEL } = {}) {
  if (inVisitor()) {
    assertIdle();
    reserveRun();
    limits = { maxTurns: DEFAULT_LIMITS.maxTurns, maxMs: DEFAULT_LIMITS.maxMs, maxUsd: demoLimits().maxUsd };
    model = DEFAULT_MODEL;
  }
  const run = {
    id: randomUUID(),
    prompt,
    model,
    limits: { ...DEFAULT_LIMITS, ...limits },
    createdAt: now(),
    updatedAt: null,
    state: 'running',
    pid: process.pid,
    stop: null,
    approval: null,
    approvals: [],
    legs: [],
    steps: [],
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
  };
  writeRun(run);
  return { run, done: runLeg(run, { prompt, kind: 'start' }) };
}

/**
 * 이어서 끝내기. 승인 대기였으면 큐의 답(승인/보류)을 읽어 그대로 모델에게 전하고, 끊겼거나 상한에
 * 닿았으면 "앞의 대화를 이어서" 다. 대화는 실행 기록의 `messages` 라 모델은 앞의 관찰을 그대로 받는다.
 */
function resumeRun(id) {
  const run = readRun(id);
  if (!run) return { ok: false, error: '그런 실행이 없다: ' + id };
  if (!RESUMABLE.includes(run.state)) return { ok: false, error: '이어갈 수 없는 상태다 (' + run.state + '): ' + id };
  if (!Array.isArray(run.messages)) return { ok: false, error: '대화 기록이 없는 실행이다 (OpenAI 전환 전 기록): ' + id };
  if (inVisitor()) {
    const a = runAvailability(run);
    if (!a.allowed) return { ok: false, error: a.reason };
    try { assertIdle(); } catch (e) { return { ok: false, error: e.message }; }
    run.limits = { maxTurns: DEFAULT_LIMITS.maxTurns, maxMs: DEFAULT_LIMITS.maxMs, maxUsd: Math.min(run.limits.maxUsd, demoLimits().maxUsd) };
  }
  let prompt;
  if (run.state === 'waiting' && run.approval) {
    const it = approvalState(run.approval.id);
    if (!it) return { ok: false, error: '승인 항목이 큐에 없다: ' + run.approval.id + ' (픽스처를 다시 만들었나)' };
    if (it.state === 'pending') return { ok: false, error: '아직 사람이 답하지 않았다: ' + it.id + ' — /approvals 에서 승인·보류한 뒤 누른다' };
    const memo = it.note ? ' (메모: ' + it.note + ')' : '';
    if (it.state === 'approved')
      prompt = '승인 항목 ' + it.id + ' 이 승인 큐에서 승인됐다(state: approved)' + memo + '. 같은 인자로 ' + run.approval.tool + ' 를 다시 불러 실행하라 — 승인의 진위는 도구가 큐에서 직접 확인하니 따지지 않는다. 결과(실행됨/실패와 그 사유)를 보고하고 끝내라.';
    else if (it.state === 'held')
      prompt = '승인 항목 ' + it.id + ' 이 보류됐다' + memo + '. 그 대상은 하지 않는다. 남은 후보가 있으면 하나 고르고, 없으면 무엇이 왜 남았는지 보고하고 끝내라.';
    else prompt = '승인 항목 ' + it.id + ' 은 이미 ' + it.state + ' 다 (다른 창구에서 실행됨). 결과를 확인하고 보고하고 끝내라.';
    run.approval = null;
  } else {
    prompt = '서버가 다시 켜졌다. 앞의 대화를 이어서 끝내라 — 이미 관찰한 것은 다시 부르지 말고, 하던 판단을 마무리한다.';
  }
  if (inVisitor()) {
    try { reserveRun(run); } catch (e) { return { ok: false, error: e.message }; }
  }
  closeDangling(run.messages);
  return { ok: true, run, done: runLeg(run, { prompt, kind: 'resume' }) };
}

export { DEFAULT_LIMITS, DEFAULT_MODEL, DEFAULT_PROMPT, SYSTEM_PROMPT, approvalState, resumeRun, startRun };
