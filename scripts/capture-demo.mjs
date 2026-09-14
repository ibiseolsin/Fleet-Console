#!/usr/bin/env node
/**
 * 제출용 캡처를 만든다 — 배포본에서 실행 → 승인 → 착륙 → 이어서 끝내기를 한 바퀴 돌며 화면을 찍는다.
 *
 *   node scripts/capture-demo.mjs [https://…]     기본 주소는 FLEET_CAPTURE_URL
 *
 * 자기 방문자 쿠키로 돈다(다른 방문자의 샌드박스를 건드리지 않는다). 실제 모델을 한 번 부르므로 비용이 든다.
 * Edge/Chrome 을 헤드리스로 띄워 CDP 로 조작한다 — 검사 스크립트(`demo-browser-check.mjs`)와 같은 방식이다.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] || process.env.FLEET_CAPTURE_URL || '').replace(/\/$/, '');
if (!BASE) throw new Error('사용법: node scripts/capture-demo.mjs <배포 주소>');
const OUT = join(process.cwd(), 'docs', 'captures');
const PORT = Number(process.env.FLEET_CAPTURE_PORT || 9319);

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error('Edge/Chrome 을 찾지 못했습니다');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'fleet-capture-'));
const browser = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  const info = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await pause(500); }
    }
    throw new Error('브라우저 디버그 포트가 열리지 않았습니다');
  })();

  ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (!pending.has(m.id)) return;
    const { ok, fail, timer } = pending.get(m.id); pending.delete(m.id); clearTimeout(timer);
    m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error('CDP timeout: ' + method)); }, 120_000);
    pending.set(id, { ok, fail, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const text = () => evaluate('document.body.innerText');
  const go = async (path) => { await send('Page.navigate', { url: BASE + path }, sessionId); await pause(1500); };
  /** 화면에 문구가 뜰 때까지 기다린다. 절전 기동(최대 60초)과 픽스처 생성을 함께 견딘다. */
  const until = async (needle, limitMs = 180_000) => {
    const started = Date.now();
    for (;;) {
      if ((await text()).includes(needle)) return Date.now() - started;
      if (Date.now() - started > limitMs) throw new Error(`"${needle}" 가 뜨지 않았습니다:\n` + (await text()).slice(0, 400));
      await pause(1000);
    }
  };
  const click = async (label) => {
    const hit = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return false; b.click(); return true;
    })()`);
    if (!hit) throw new Error(`버튼 "${label}" 을 찾지 못했습니다`);
    await pause(2500);
  };
  /** 기본은 페이지 전체. `whole: false` 는 보이는 화면만 — 회차 241줄 같은 긴 페이지에 쓴다. */
  const shot = async (name, whole = true) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: whole }, sessionId);
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
    console.log('찍음  docs/captures/' + name);
  };

  mkdirSync(OUT, { recursive: true });
  console.log('대상 ' + BASE + ' — 절전 중이면 첫 화면까지 1분 가까이 걸립니다.');

  // 캡처마다 같은 그림이 나오도록 방문자 샌드박스를 처음 상태로 돌린다 — 지난 캡처의 승인 항목이 섞이면
  // "지나간 것" 이 쌓여 이번 흐름을 가린다.
  await go('/demo');
  await until('처음 상태로 되돌리기');
  await click('처음 상태로 되돌리기');

  const started = Date.now();
  await go('/agent');
  await until('에이전트 루프');
  console.log(`  /agent 첫 화면 ${((Date.now() - started) / 1000).toFixed(1)}초 (절전 기동 + 픽스처 생성 포함, 폴링 간격 1초)`);

  await click('시작');
  await until('승인 대기');
  await until('쓰기 도구');           // 실행이 waiting 으로 안착
  await shot('1-agent-trace.png');    // 도구 호출·이유·결과가 다 보이는 실행 trace

  await go('/approvals');
  await until('기다리는 것 1건');
  await shot('2-approval-queue.png'); // 사람이 답할 승인 항목

  await click('승인');
  await until('승인됨');              // 배너가 아니라 항목의 상태를 본다 (배너는 다음 렌더에 사라진다)
  await click('승인한 작업 실행');
  await until('실행됨');
  await shot('3-landing-result.png'); // 착륙 결과 (PR 머지·작업 공간 정리)

  await go('/agent');
  const href = await evaluate(`(document.querySelector('a[href^="/agent/"]') || {}).getAttribute?.('href') || ''`);
  await go(href);
  await click('이어서 끝내기');
  await until('끝남');
  await shot('4-run-finished.png');   // 승인 뒤 같은 세션을 이어서 끝낸 결과

  await go('/eval');
  await until('비용');
  await shot('5-usage.png', false);   // 비용·시간 화면 — 회차 241줄이라 보이는 화면만

  console.log('\n캡처 5장을 docs/captures/ 에 남겼다.');
} finally {
  try { ws?.close(); } catch {}
  browser.kill();
  await pause(1500);
  // 브라우저가 프로필을 늦게 놓아 준다(Windows EPERM). 임시 폴더라 못 지워도 그냥 둔다.
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}
