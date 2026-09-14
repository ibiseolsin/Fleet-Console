/**
 * whoami — CLI가 지금 어느 조직으로 붙어 있는지 확인한다.
 *
 * `~/.claude.json` 의 최근 실행 기록(`clientDataCacheSlots`)을 본다. 같은 파일의
 * `oauthAccount` 는 **캐시라 근거로 쓰면 안 된다** — 하루 지난 값이 들어 있을 수 있다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const H = homedir(); // HOME 은 PowerShell 에 없다 — 도구 본체와 같은 규칙
const j = JSON.parse(readFileSync(join(H, '.claude.json'), 'utf8'));
const NAME = { 'eb5a4ec6-eb68-4af2-a72b-7ff944324acb': '⚠ Modulabs AGENT01 (팀즈)', '41ec52ea-009a-48e7-9767-74221b420de9': '✓ 개인' };
const slots = Object.values(j.clientDataCacheSlots || {}).sort((a, b) => b.at - a.at);
const kst = (ms) => new Date(ms + 9 * 3600000).toISOString().replace('T', ' ').slice(5, 19);
const cli = slots.filter((s) => /cli/.test(s.entrypoint || ''));
console.log('최근 CLI 실행 5건:');
cli.slice(0, 5).forEach((s) => console.log(' ', kst(s.at), (s.entrypoint || '').padEnd(9), NAME[s.org] || s.org));
const bad = cli.filter((s) => s.org && s.org.startsWith('eb5a4ec6'));
console.log('\n판정:', bad.length ? '⚠ CLI가 팀즈 조직으로 실행된 기록 ' + bad.length + '건' : '✓ CLI는 전부 개인 조직');
