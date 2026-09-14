/**
 * 폴더 하나의 내용 해시 — "이 호출이 아무것도 안 바꿨다" 를 확인하는 재료.
 *
 * 읽기 도구는 어떤 상태도 바꾸면 안 된다 (`PRD.md §4`). 그것을 말이 아니라 **해시로** 확인한다.
 * `scripts/fixture-check.mjs` 가 `~/.sp-sync/` 에 같은 일을 하는 사본을 갖고 있다 — 슬라이스 4가
 * 쓰기 도구의 격리 확인을 붙일 때 그쪽도 이 파일을 쓰게 합친다.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 폴더 아래 모든 파일의 `상대경로 → 내용 sha256`. 폴더가 없으면 빈 표. */
function hashTree(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      const key = rel ? rel + '/' + n : n;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue; // 방금 사라진 파일 — 아래 비교에서 "사라짐" 으로 잡힌다
      }
      if (st.isDirectory()) walk(p, key);
      else {
        try {
          out.set(key, createHash('sha256').update(readFileSync(p)).digest('hex'));
        } catch {
          out.set(key, '읽기 실패');
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

/** 두 표의 차이. 빈 배열이면 하나도 안 변했다. */
function diffTrees(before, after) {
  const changed = [];
  for (const k of after.keys()) if (!before.has(k)) changed.push('생김 ' + k);
  for (const [k, v] of before) {
    if (!after.has(k)) changed.push('사라짐 ' + k);
    else if (after.get(k) !== v) changed.push('바뀜 ' + k);
  }
  return changed;
}

export { diffTrees, hashTree };
