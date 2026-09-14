// node --test sp-sync/test/*.test.mjs
// 슬라이스 42 — 공유 자원 예약(`lib/resources.mjs`). 실제 `~/.sp-sync` 를 안 건드린다:
// 파일·락 경로와 폴더 존재 판정을 `deps` 로 임시 폴더에 갈아 끼운다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { held, heldText, release, reserve, sweep } from '../sp-sync.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'sp-res-'));
const depsIn = (dir) => ({ file: () => join(dir, 'fleet-resources.json'), lock: () => join(dir, 'fleet-resources.lock'), exists: (p) => existsSync(p) });

test('예약을 잡으면 이름별로 남고, 남이 쥔 것은 충돌로 거절된다 — 프로젝트를 넘어 배타', () => {
  const dir = tmp();
  const deps = depsIn(dir);
  try {
    const ws1 = join(dir, 'slice25');
    mkdirSync(ws1);
    const a = reserve({ names: ['폰', '마이크'], project: 'project-b', slice: 25, workspace: ws1 }, deps);
    assert.deepEqual(a.reserved, ['폰', '마이크']);
    assert.equal(a.ok, true);
    // 다른 프로젝트가 같은 이름을 집으면 거절 — 폰은 한 대뿐이다
    const b = reserve({ names: ['폰'], project: 'SP-sync', slice: 3, workspace: join(dir, 'slice3') }, deps);
    assert.equal(b.ok, false);
    assert.equal(b.conflicts.length, 1);
    assert.equal(heldText(b.conflicts[0]), '폰 — project-b slice25');
    // 반만 잡지 않는다 — 하나라도 막히면 아무것도 안 잡는다
    const c = reserve({ names: ['카메라', '폰'], project: 'SP-sync', slice: 3, workspace: join(dir, 'slice3') }, deps);
    assert.equal(c.ok, false);
    assert.equal(held(deps)['카메라'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('자기 예약은 자기를 안 막는다 — 재파견·인계로 같은 슬라이스가 다시 뜨는 자리', () => {
  const dir = tmp();
  const deps = depsIn(dir);
  try {
    const ws = join(dir, 'slice25');
    mkdirSync(ws);
    reserve({ names: ['폰'], project: 'G', slice: 25, workspace: ws }, deps);
    const again = reserve({ names: ['폰'], project: 'G', slice: 25, workspace: ws }, deps);
    assert.equal(again.ok, true);
    assert.deepEqual(again.reserved, ['폰']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('해제는 그 워크스페이스의 예약만 걷는다 — 경로 비교는 normPath', () => {
  const dir = tmp();
  const deps = depsIn(dir);
  try {
    const a = join(dir, 'slice1');
    const b = join(dir, 'slice2');
    mkdirSync(a);
    mkdirSync(b);
    reserve({ names: ['폰'], project: 'P', slice: 1, workspace: a }, deps);
    reserve({ names: ['마이크'], project: 'P', slice: 2, workspace: b }, deps);
    // 역슬래시·대소문자가 달라도 같은 폴더로 읽혀야 한다 (안 접으면 예약이 영영 안 풀린다)
    const r = release({ workspace: a.replace(/\//g, '\\').toUpperCase() }, deps);
    assert.deepEqual(r.released, ['폰']);
    assert.deepEqual(Object.keys(held(deps)), ['마이크']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweep 은 폴더가 사라진 예약을 걷고 살아 있는 것은 그대로 둔다', () => {
  const dir = tmp();
  const deps = depsIn(dir);
  try {
    const live = join(dir, 'slice1');
    const gone = join(dir, 'slice9');
    mkdirSync(live);
    reserve({ names: ['폰'], project: 'P', slice: 1, workspace: live }, deps);
    reserve({ names: ['마이크'], project: 'P', slice: 9, workspace: gone }, deps);
    const r = sweep({}, deps);
    assert.deepEqual(r.removed.map((x) => x.name), ['마이크']);
    assert.deepEqual(Object.keys(held(deps)), ['폰']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('경로가 없는 예약도 sweep 이 걷는다 — 어느 폴더에 매인지 모르면 그 자원이 영영 죽는다', () => {
  const dir = tmp();
  const deps = depsIn(dir);
  try {
    writeFileSync(deps.file(), JSON.stringify({ 폰: { name: '폰', project: 'P', slice: 1, workspace: null, since: 1 } }));
    assert.deepEqual(sweep({}, deps).removed.map((x) => x.name), ['폰']);
    assert.deepEqual(held(deps), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('파일이 없거나 깨졌으면 빈 표 — 예약을 못 읽는 것은 "아무도 안 쥐었다" 로 떨어진다', () => {
  const dir = tmp();
  const deps = depsIn(dir);
  try {
    assert.deepEqual(held(deps), {});
    assert.deepEqual(sweep({}, deps).removed, []); // 파일이 없으면 락도 안 잡는다
    assert.deepEqual(release({ workspace: join(dir, 'x') }, deps).released, []);
    writeFileSync(deps.file(), '{깨진');
    assert.deepEqual(held(deps), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweep --dry-run 은 회수 목록만 내고 파일을 안 고친다 — 진단과 실행이 갈리면 안 된다', () => {
  const dir = tmp();
  const deps = depsIn(dir);
  try {
    reserve({ names: ['폰'], project: 'P', slice: 9, workspace: join(dir, 'slice9') }, deps);
    assert.deepEqual(sweep({ dryRun: true }, deps).removed.map((x) => x.name), ['폰']);
    assert.deepEqual(Object.keys(held(deps)), ['폰']); // 파일은 그대로
    assert.deepEqual(sweep({}, deps).removed.map((x) => x.name), ['폰']);
    assert.deepEqual(held(deps), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
