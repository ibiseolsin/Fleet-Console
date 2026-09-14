/**
 * 재생 전에 **픽스처가 정의 그대로인지** 본다 (슬라이스 8에서 만들어 9가 같이 쓴다).
 *
 * 재생값이 픽스처에 매여 있으므로, 앞서 무엇이 돌았느냐에 따라 표가 조용히 달라지면 안 된다.
 * 실제로 달라진다: `npm run check` 의 쓰기 도구 확인(`mcp-write-check.mjs`)은 샌드박스에 **정말로**
 * 파견하고 착륙한다 — 그 뒤에 재생하면 atlas/slice2 가 머지돼 사라지고(시나리오 1·4 불일치)
 * cobalt 2번이 "이미 돌고 있음" 이 된다(시나리오 3 불일치). 2026-09-11 실측으로 9개 중 6개만 맞았다.
 * 그때 표를 그대로 내면 일치율이 66.7% 로 적히는데, 그것은 판정이 아니라 픽스처가 틀린 것이다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE, projectRoot } from './fixture.mjs';

/** 어긋난 것들을 사람이 읽을 줄로 낸다. 빈 배열이면 정의 그대로다. */
function fixtureMatchesDefinition(o) {
  const bad = [];
  for (const [name, def] of Object.entries(FIXTURE)) {
    const p = o.projects.find((x) => x.project === name);
    if (!p) {
      bad.push(name + ' — 프로젝트가 없다');
      continue;
    }
    const want = def.workspaces.map((w) => 'slice' + w.slice).join(', ');
    const got = p.workspaces.map((w) => w.name).join(', ');
    if (want !== got) bad.push(name + ' 워크스페이스 — 정의 [' + want + '] · 실제 [' + got + ']');
    const plan = readFileSync(join(projectRoot(name), 'PLAN.md'), 'utf8');
    if (plan !== def.plan) bad.push(name + ' 본체 PLAN.md 가 정의와 다르다 (체크·머지가 반영됐다)');
  }
  return bad;
}

/** 어긋났으면 무엇이 다른지 적고 **exit 2** 로 멈춘다 — 틀린 표를 내는 것보다 안 내는 게 낫다. */
function requireCleanFixture(o, rerun) {
  const bad = fixtureMatchesDefinition(o);
  if (!bad.length) return;
  console.error('픽스처가 정의와 다르다 — 재생값이 픽스처에 매여 있으므로 여기서 멈춘다:');
  for (const b of bad) console.error('  ' + b);
  console.error('');
  console.error('`npm run fixture` 로 다시 만든 뒤 재생한다 (`' + rerun + '` 은 그것까지 한다).');
  process.exit(2);
}

export { fixtureMatchesDefinition, requireCleanFixture };
