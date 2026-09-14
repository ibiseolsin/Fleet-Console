#!/usr/bin/env node
/**
 * Claude Code 상태줄 — 현재 세션의 "다음 한 수"를 터미널 맨 아래에 고정한다.
 *
 * 왜 필요한가: 턴 끝에 남긴 카드는 곁가지 질문 몇 번이면 스크롤백 위로 밀려난다.
 * 상태줄은 스크롤되지 않으므로, 용어를 물어보고 돌아와도 "다음: ..."이 그대로 있다.
 *
 * 카드는 sp-sync 의 Stop 훅이 ~/.sp-sync/cards/<세션>.json 에 써둔다.
 * 여기서는 읽기만 한다 — 상태줄은 자주 불리므로 자식 프로세스를 띄우지 않는다.
 *
 * **지금은 상태줄에 안 붙어 있다.** status.md 패널이 그 역할을 대신하기로 해서
 * `~/.claude/statusline.sh` 에서 뺐다(그 파일 머리 주석에 되살리는 법이 있다 —
 * statusline.js 뒤에 이어 붙이면 된다). 훅은 여전히 카드를 쓰므로 되살리면 바로 뜬다.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CARDS = join(homedir(), '.sp-sync', 'cards');
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';
const WAIT = '\x1b[33m'; // 노랑 — 사용자 판단을 기다리는 중
const NEXT = '\x1b[36m'; // 청록 — 다음 한 수

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

/** 표시용: 구분자만 통일하고 끝의 슬래시를 턴다 */
const slash = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
/** 비교용: 대소문자까지 접는다 (윈도우 경로는 대소문자를 구분하지 않는다) */
const norm = (p) => slash(p).toLowerCase();

/** 세션 id 로 찾고, 없으면 같은 폴더에서 가장 최근에 갱신된 카드로 떨어진다. */
function findCard(sessionId, cwd) {
  if (sessionId) {
    const f = join(CARDS, String(sessionId).replace(/[^\w.-]/g, '_') + '.json');
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf8'));
      } catch {}
    }
  }
  if (!cwd) return null;
  let best = null;
  let bestAt = 0;
  try {
    for (const name of readdirSync(CARDS)) {
      const p = join(CARDS, name);
      try {
        const c = JSON.parse(readFileSync(p, 'utf8'));
        if (norm(c.cwd) !== norm(cwd)) continue;
        const at = c.at || statSync(p).mtimeMs;
        if (at > bestAt) {
          bestAt = at;
          best = c;
        }
      } catch {}
    }
  } catch {}
  return best;
}

function cut(s, n) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

const h = readStdin();
const cwd = h.cwd || h.workspace?.current_dir || h.workspace?.project_dir || '';
const card = findCard(h.session_id || h.sessionId, cwd);

// 카드가 없으면 아무것도 쓰지 않는다. 이 출력은 기존 상태줄 뒤에 이어 붙으므로
// "(카드 없음)" 같은 자리표시자는 매 턴 폭만 잡아먹는 잡음이 된다.
const parts = [];
if (card) {
  // sp-sync.mjs 의 isWaiting 과 같은 규칙. 이 파일은 자식 프로세스도 import 도 안 하므로 복사해 둔다.
  const waiting = !!(card.wait && !/^(없음|없다|없습니다|none|n\/a|-)$/i.test(card.wait.trim()));
  // 대기가 먼저다 — 에이전트가 멈춰 서 있다는 뜻이라 제일 눈에 띄어야 한다.
  // 다만 둘 다 있으면 대기를 짧게 깎는다. 대기가 길다고 `다음`이 통째로 밀려나면
  // 복귀에 정작 필요한 줄이 사라진다 — 실제로 한 번 그렇게 잘렸다.
  if (waiting) parts.push(WAIT + '⏸ ' + cut(card.wait, card.next ? 30 : 60) + OFF);
  if (card.next) parts.push(NEXT + '▸ 다음: ' + cut(card.next, waiting ? 55 : 75) + OFF);
  else if (card.now) parts.push(DIM + '지금: ' + cut(card.now, 70) + OFF);
}

if (parts.length) process.stdout.write(parts.join(DIM + ' · ' + OFF));
