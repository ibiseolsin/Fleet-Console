/**
 * 공유 자원 예약 — 슬라이스 태그 `[자원: 폰, 마이크]` 가 말하는 **실물**을 프로젝트를 넘어 배타로 잡는다
 * (슬라이스 42). `common` 에만 의존한다.
 *
 * **왜 따로 두나.** `[병렬 가능]` 이 말할 수 있는 것은 "파일이 안 겹친다"까지다. 폰·마이크·같은 API 쿼터는
 * 파일이 아니라 실물이라, 두 프로젝트의 슬라이스가 서로를 모르는 채 같은 것을 집는다 — 그러면 둘 다 못 쓰거나
 * 한쪽 측정이 조용히 오염된다. 그래서 예약은 **프로젝트가 아니라 자원 이름**을 열쇠로 한 곳에 모은다.
 *
 * 저장소는 `~/.sp-sync/fleet-resources.json`:
 *
 *   { "폰": { "name": "폰", "project": "project-b", "slice": 25,
 *             "workspace": "C:/…/workspaces/project-b/slice25", "since": 1757… } }
 *
 * 키는 `normTitle` 로 접은 이름이고 `name` 이 계획에 적힌 그대로다 — 표·사유에는 `name` 을 쓴다.
 * 읽고-고치고-쓰기는 전용 락(`fleet-resources.lock/`) 안에서만 한다. `state.json` 과 같은 방식이지만
 * **다른 락**이다: 예약을 잡느라 훅의 세션 기록을 막을 이유가 없다.
 *
 * 잡는 자리와 놓는 자리:
 *  - 잡기 — 파견이 워크스페이스를 만든 **직후**(`fleetDispatch`). 재파견도 예약이 없으면 그때 잡는다.
 *  - 놓기 — 착륙이 워크스페이스 폴더를 지울 때(`landCleanup`).
 *  - 회수 — 매 회차 시작의 `sweep`. 폴더가 사라진 예약(사람이 손으로 지웠거나 착륙이 중간에 죽은 것)을 걷는다.
 *
 * **워커가 결정을 기다리는 동안은 계속 점유한다** — 폰을 든 채 사람을 기다리는 것이 맞다. 그래서 판정 재료는
 * "그 워크스페이스 폴더가 아직 있는가" 하나다(유휴·카드 `wait` 를 안 본다).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, log, normPath, normTitle, readJson, withDirLock, writeJson } from './common.mjs';

const RESOURCES_FILE = join(DIR, 'fleet-resources.json');
const RESOURCES_LOCK = join(DIR, 'fleet-resources.lock');

/** 바깥과 닿는 자리. 테스트가 임시 폴더로 갈아 끼운다 — 실제 `~/.sp-sync` 를 건드리지 않고 예약을 확인하려고. */
const RESOURCE_DEPS = {
  file: () => RESOURCES_FILE,
  lock: () => RESOURCES_LOCK,
  exists: (p) => existsSync(p),
};

/** 저장소를 읽는다. 깨졌거나 없으면 빈 표 — 예약을 못 읽는 것은 "아무도 안 쥐었다"로 떨어진다. */
function readHeld(deps = RESOURCE_DEPS) {
  const raw = readJson(deps.file(), null);
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    out[k] = { name: v.name || k, project: v.project || null, slice: v.slice ?? null, workspace: v.workspace || null, since: v.since || null };
  }
  return out;
}

/**
 * 저장소를 쓴다. **던지지 않는다** — 이 모듈은 파견·착륙·회차 한가운데서 불리므로, 예약 파일 하나를 못 썼다고
 * 그 회차가 통째로 죽으면 안 된다. 실패는 로그로 남기고 판정은 예약 없이 이어진다.
 */
function save(v, deps) {
  try {
    writeJson(deps.file(), v);
    return true;
  } catch (e) {
    log('fleet-resources 저장 실패: ' + (e.code || e.message));
    return false;
  }
}

/** 지금 잡혀 있는 예약. **락을 안 잡는다** — 판정용 읽기라, 그 사이에 바뀌면 다음 회차가 본다. */
function held(deps = RESOURCE_DEPS) {
  return readHeld(deps);
}

/** 그 예약이 이 (프로젝트, 슬라이스)의 것인가. 자기 예약은 자기를 막지 않는다. */
function isOwn(h, { project, slice }) {
  return !!h && h.project === project && h.slice === slice;
}

/**
 * 예약 하나를 잡는다. 남이 쥔 이름이 하나라도 있으면 **아무것도 안 잡고** 그 충돌을 돌려준다 —
 * 반만 잡으면 그 워크스페이스는 없는 자원으로 일을 시작한다.
 *
 * 자기 것(같은 프로젝트·슬라이스)은 충돌이 아니라 갱신이다: 재파견·인계로 같은 슬라이스가 다시 뜨는 자리.
 */
function reserve({ names, project, slice, workspace, now = Date.now() }, deps = RESOURCE_DEPS) {
  const want = (names || []).filter(Boolean);
  if (!want.length) return { ok: true, reserved: [], conflicts: [] };
  const r = withDirLock(deps.lock(), () => {
    const cur = readHeld(deps);
    const conflicts = [];
    for (const name of want) {
      const h = cur[normTitle(name)];
      if (h && !isOwn(h, { project, slice })) conflicts.push({ name, ...h });
    }
    if (conflicts.length) return { ok: false, reserved: [], conflicts };
    for (const name of want) cur[normTitle(name)] = { name, project, slice, workspace, since: now };
    if (!save(cur, deps)) return { ok: false, reserved: [], conflicts: [], saveFailed: true };
    return { ok: true, reserved: want, conflicts: [] };
  });
  // 락을 못 잡았으면 `withDirLock` 이 null 을 돌린다 (`common` 의 규칙). 예약 없이 진행하는 것보다
  // "못 잡았다"로 보고하는 편이 낫다 — 파견은 이미 끝났으니 사람이 보고에서 본다.
  if (!r) {
    log('fleet-resources 락을 못 잡아 예약을 건너뜀: ' + want.join(', '));
    return { ok: false, reserved: [], conflicts: [], lockFailed: true };
  }
  return r;
}

/**
 * 그 워크스페이스가 쥔 예약을 전부 놓는다. 착륙이 폴더를 지운 자리에서 부른다.
 * 경로 비교는 `normPath` — 한 곳만 안 접으면 예약이 영영 안 풀린다.
 */
function release({ workspace }, deps = RESOURCE_DEPS) {
  if (!workspace) return { released: [] };
  // 예약 파일이 아예 없으면 놓을 것도 없다 — 락도 안 잡는다. 자원 태그를 안 쓰는 프로젝트가 대부분이라
  // 착륙마다 락을 만들었다 지우는 것은 그냥 낭비다 (`sweep` 도 같은 자리).
  if (!deps.exists(deps.file())) return { released: [] };
  const key = normPath(workspace);
  const r = withDirLock(deps.lock(), () => {
    const cur = readHeld(deps);
    const released = [];
    for (const [k, v] of Object.entries(cur)) {
      if (normPath(v.workspace) !== key) continue;
      released.push(v.name);
      delete cur[k];
    }
    if (released.length) save(cur, deps);
    return { released };
  });
  if (!r) {
    log('fleet-resources 락을 못 잡아 해제를 건너뜀: ' + workspace);
    return { released: [], lockFailed: true };
  }
  return r;
}

/**
 * 폴더가 사라진 예약을 걷는다 (`dryRun` 이면 목록만 내고 파일은 안 고친다) — 착륙이 중간에 죽었거나 사람이 손으로 지운 워크스페이스의 것.
 * 매 회차 시작에 한 번 부른다. **경로가 비어 있는 예약도 걷는다**: 어느 폴더에 매인지 모르는 예약은
 * 영영 안 풀려 그 자원을 통째로 죽인다.
 */
function sweep({ dryRun = false } = {}, deps = RESOURCE_DEPS) {
  if (!deps.exists(deps.file())) return { removed: [] };
  const r = withDirLock(deps.lock(), () => {
    const cur = readHeld(deps);
    const removed = [];
    for (const [k, v] of Object.entries(cur)) {
      if (v.workspace && deps.exists(v.workspace)) continue;
      removed.push({ name: v.name, project: v.project, slice: v.slice, workspace: v.workspace });
      delete cur[k];
    }
    // **dry-run 도 회수 목록은 낸다 — 쓰지 않을 뿐이다.** 안 그러면 dry-run 만 "자원 점유" 로 보류하고
    // 실제 회차는 띄우는, 진단과 실행이 갈리는 자리가 된다 (dry-run 의 존재 이유가 그 일치다).
    if (removed.length && !dryRun) save(cur, deps);
    return { removed };
  });
  if (!r) return { removed: [], lockFailed: true };
  if (r.removed.length) log('fleet-resources 회수 — ' + r.removed.map((x) => x.name + ' (' + (x.project || '?') + ' slice' + x.slice + ')').join(', '));
  return r;
}

/** 예약 한 줄의 사람이 읽는 꼴 — `폰 — project-b slice25`. 사유와 `fleet status` 가 같은 문구를 쓴다. */
function heldText(h) {
  return h.name + ' — ' + (h.project || '?') + ' slice' + (h.slice ?? '?');
}

export { RESOURCES_FILE, RESOURCES_LOCK, RESOURCE_DEPS, held, heldText, isOwn, release, reserve, sweep };
