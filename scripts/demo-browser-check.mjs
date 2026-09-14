#!/usr/bin/env node
// Run only after checking the target server's port/PID/command/repo/branch/HEAD.
// Uses Chrome DevTools Protocol and two separate incognito cookie stores; no model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = process.env.FLEET_TEST_URL || 'http://127.0.0.1:3018';
const root = process.env.FLEET_STATE_ROOT;
if (!root) throw new Error('FLEET_STATE_ROOT must equal the verified server test root');
const info = await (await fetch('http://127.0.0.1:9318/json/version')).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (pending.has(m.id)) {
    const { ok, fail, timer } = pending.get(m.id); pending.delete(m.id); clearTimeout(timer);
    m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); fail(new Error('CDP timeout: ' + method)); }, 30_000);
  pending.set(id, { ok, fail, timer }); ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function tab() {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  return { browserContextId, sessionId };
}
async function evaluate(t, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, t.sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function until(t, expression, description) {
  for (let n = 0; n < 150; n++) { if (await evaluate(t, expression)) return; await pause(200); }
  throw new Error(description + '\n' + await evaluate(t, 'document.body.innerText'));
}
async function go(t, path, text) {
  await send('Page.navigate', { url: base + path }, t.sessionId);
  await until(t, `location.pathname === ${JSON.stringify(path)} && document.readyState === 'complete' && document.body.innerText.includes(${JSON.stringify(text)})`, 'navigation ' + path);
}
async function click(t, label, text) {
  await until(t, `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(label)} && !b.disabled)`, 'button ' + label);
  await evaluate(t, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  await until(t, `document.body.innerText.includes(${JSON.stringify(text)})`, 'after ' + label);
}
const tabs = [];
try {
  const a = await tab(), b = await tab(); tabs.push(a, b);
  await Promise.all([go(a, '/demo', '내 데모 플릿'), go(b, '/demo', '내 데모 플릿')]);
  const visitor = async (t) => (await send('Storage.getCookies', { browserContextId: t.browserContextId })).cookies.find((c) => c.name === 'fleet-visitor').value;
  const aid = await visitor(a), bid = await visitor(b);
  assert.notEqual(aid, bid);
  await click(a, 'cobalt/2 파견 요청', '기다리는 것 1건');
  await go(b, '/approvals', '기다리는 것 0건');
  const foreign = await evaluate(a, "document.querySelector('input[name=id]').value");
  await click(a, '승인', '승인한 작업 실행');
  await click(a, '승인한 작업 실행', '실행됨');
  await go(b, '/demo', '내 데모 플릿');
  await click(b, 'cobalt/2 파견 요청', '기다리는 것 1건');
  // Forge an ID from the other cookie store. It must leave B's own request pending.
  await evaluate(b, `document.querySelector('input[name=id]').value=${JSON.stringify(foreign)}`);
  await click(b, '승인', '그런 승인 항목이 없다');
  await go(b, '/approvals', '기다리는 것 1건');
  await click(b, '승인', '승인한 작업 실행');
  await click(b, '승인한 작업 실행', '실행됨');
  for (const t of tabs) {
    await go(t, '/demo', '내 데모 플릿');
    await click(t, 'atlas/slice2 착륙 요청', '기다리는 것 1건');
    await click(t, '승인', '승인한 작업 실행');
    await click(t, '승인한 작업 실행', '머지 완료');
  }
  await go(a, '/demo', '내 데모 플릿');
  await click(a, '처음 상태로 되돌리기', '처음 상태로 돌아왔습니다');
  assert.ok(await evaluate(a, "document.body.innerText.includes('atlas/slice2 착륙 요청') && document.body.innerText.includes('cobalt/2 파견 요청')"));
  await go(b, '/demo', '내 데모 플릿');
  assert.ok(await evaluate(b, "!document.body.innerText.includes('atlas/slice2 착륙 요청') && !document.body.innerText.includes('cobalt/2 파견 요청')"));
  console.log('PASS two actual browser cookie stores: dispatch approval/execution, landing, forged foreign ID rejection, own reset');

  // Seed a finished record and an exhausted daily ledger; no API request is needed.
  const id = randomUUID(), runs = join(root, 'visitors', aid, 'agent-runs');
  mkdirSync(runs, { recursive: true });
  const run = { id, prompt: '보존된 실행 검증', model: 'test', state: 'stopped', limits: { maxTurns: 12, maxMs: 120000, maxUsd: 0.25 }, createdAt: new Date().toISOString(), legs: [], steps: [], approvals: [], stop: { kind: 'budget', reason: '상한 검증용 저장 기록' } };
  writeFileSync(join(runs, id + '.json'), JSON.stringify(run));
  writeFileSync(join(root, 'daily-runs.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), used: 1 }));
  await go(a, '/agent', '오늘 서버 전체 실행 상한 1회');
  assert.ok(await evaluate(a, "document.querySelector('button').disabled"));
  await evaluate(a, "document.querySelector('button').disabled = false; document.querySelector('button').click()");
  await until(a, "location.search.includes('msg=') && document.body.innerText.includes('오늘 서버 전체 실행 상한 1회')", 'forged start is rejected by server');
  assert.equal(readdirSync(runs).filter((f) => f.endsWith('.json')).length, 1);
  await go(a, '/agent/' + id, '보존된 실행 검증');
  assert.ok(await evaluate(a, "document.querySelector('button').disabled"));
  await go(b, '/agent/' + id, '404');
  await go(b, '/agent', '오늘 서버 전체 실행 상한 1회');
  assert.ok(await evaluate(b, "document.querySelector('button').disabled"));
  console.log('PASS exhausted quota disables start/resume with reason, own saved history remains readable, foreign history is 404');
  await go(a, '/demo', '내 데모 플릿');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, a.sessionId);
  writeFileSync(resolve('sandbox', 'slice11-demo.png'), Buffer.from(shot.data, 'base64'));
} finally {
  for (const t of tabs) await send('Target.disposeBrowserContext', { browserContextId: t.browserContextId });
  ws.close();
}
