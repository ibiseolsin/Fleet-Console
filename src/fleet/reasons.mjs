/**
 * 사후 분류표 (슬라이스 10) — **기록된 문장 → 코드 라벨.** 판정이 아니다.
 *
 * `src/fleet/source.mjs` 의 `holdOf` 와 같은 자리다: sp-sync 가 낸 사유 문장을 세고 거를 수
 * 있게 라벨만 붙인다. **여기서 판정 규칙을 만들지 않는다** (`PRD.md §7`) — 어떤 함수도
 * "착륙해도 되나"·"파견해도 되나" 를 답하지 않고, 이미 나온 결과 문장을 읽을 뿐이다.
 *
 * 왜 `holdOf` 로 다 못 하나 (`EVAL.md` 머리말과 같은 이야기):
 *   `holdOf` 의 `HOLD_CODES` 는 **파견 보류** 사유의 앞머리만 담는다. 반입한 회차 기록의 표
 *   넷 중 파견 보류 문장을 담은 칸은 하나도 없다 — 착륙 막힘은 `막힘` 표의 `이유` 이고,
 *   사람 호출은 `결정 필요` 표의 `무엇`·`내용` 이며, 착륙·파견 표의 `결과` 는 사유가 아니라
 *   **결과 갈래**(`머지됨 #22` · `name 실패`)다. 그래서 표마다 분류표를 따로 둔다.
 *
 * 분류표를 늘릴 때 지킬 것 — **없는 갈래를 지어내지 않는다.** 여기 있는 코드는 전부 반입한
 * 241회차나 픽스처 관찰에 실제로 나온 문장에서 왔다. 못 알아본 문장은 `other` 로 두고 세며,
 * 그 수를 `EVAL.md` 에 그대로 적는다.
 */

/**
 * 착륙 막힘 사유 (`막힘` 표의 `이유`, 그리고 관찰의 `workspaces[].reason`).
 * 앞머리가 아니라 **부분 일치**로 가른다 — sp-sync 가 사유를 ` · ` 로 이어 붙이기 때문이다
 * (`잠듦(claude done 22:07) · 유휴인데 25번이 미체크 …`). 먼저 걸리는 것이 이긴다: 순서가
 * 곧 우선순위다. 잠듦이 미체크보다 앞인 이유는 그 워크스페이스는 **깨울 수 없어서** 사람이
 * 봐야 하고, 미체크는 워커가 아직 안 끝냈다는 뜻이라 사람이 할 일이 다르기 때문이다.
 */
const BLOCK_CODES = [
  [/잠듦|창이 없음/, 'asleep', '창이 닫혔거나 잠들어 CLI 로 못 깨움'],
  [/한도 막힘/, 'limit', '에이전트 사용량 한도 — 초기화까지 막힘'],
  [/훅 기록이 안 생김|session 실패/, 'dispatch-unverified', '파견은 했는데 제출을 확인 못 함'],
  [/미체크/, 'unchecked', '유휴인데 PLAN.md 가 미체크 — 완료 신호 없음'],
  [/충돌/, 'conflict', '머지 충돌'],
];

/** 착륙 결과 (`착륙` 표의 `결과`). 사유가 아니라 갈래다 — 실패는 어느 단계에서 죽었나로 나뉜다. */
const LAND_RESULTS = [
  [/^머지됨/, 'merged', 'PR 이 머지됐다'],
  [/^push 실패/, 'push-failed', 'push 단계에서 실패'],
  [/^pr-create 실패/, 'pr-failed', 'PR 생성 단계에서 실패'],
  [/^check 실패/, 'check-failed', '검사 단계에서 실패'],
  [/^conflict 실패/, 'conflict-failed', '충돌 해소 실패'],
];

/** 파견 결과 (`파견` 표의 `결과`). `지시` 칸은 보낸 프롬프트라 분류 대상이 아니다. */
const DISPATCH_RESULTS = [
  [/^재파견/, 'redispatch', '앞 회차가 못 보낸 것을 다시 보냄'],
  [/^제출 확인/, 'submitted', '세션이 뜨고 프롬프트 제출까지 확인'],
  [/훅 기록 확인/, 'submitted-hook', 'Orca 가 제출하고 훅 기록으로 확인'],
  [/^래퍼 실행/, 'wrapper', '헤드리스 워커 래퍼를 띄웠다 (제출 확인이 없다)'],
  [/^지시 보냄/, 'sent', '이미 있는 창에 지시만 보냄'],
  [/^name 실패/, 'name-failed', '워크스페이스 이름 규칙에 걸려 못 만듦'],
  [/^create 실패/, 'create-failed', '워크스페이스 생성 실패'],
];

/**
 * 사람 호출 (`결정 필요` 표). **헛호출률의 재료다** (`PRD.md §8`).
 *
 * `need` 는 사후 판정이다 — 그 항목을 받은 사람이 **무엇을 해야 했나**:
 *   `판단`   답을 골라야 사람만 할 수 있는 것 (요구사항이 갈리는 것, 계획, 승인)
 *   `조작`   답은 정해져 있고 손이 필요한 것 (기기 연결, 로그인, 창 정리, 버튼)
 *   `불필요` 사람이 할 것이 없는 것 (기다리면 풀리는 한도, 이미 끝난 인계 보고)
 *
 * `PRD.md §8` 의 헛호출률("실제로 사람 **판단**이 필요했던 비율")은 `판단` 만 센 것이고,
 * `판단+조작` 은 "사람이 없으면 못 가는 것" 이다. `EVAL.md` 에 둘 다 적는다 — 어느 하나만
 * 적으면 "버튼 눌러 주세요" 를 헛호출로 몰거나 진짜 결정과 같이 세게 된다.
 *
 * 순서가 우선순위다. `내용` 을 먼저 보고, 안 걸리면 `무엇` 의 `(워커 대기)` 로 떨어진다.
 */
const CALL_CODES = [
  [/^한도 임박/, 'limit-hold', '불필요', '한도가 차 파견을 멈췄다 — 초기화되면 저절로 풀린다'],
  [/^대기 —/, 'limit-wait', '불필요', '상대 에이전트도 한도라 기다리는 중'],
  [/^인계 →/, 'handoff', '불필요', '다른 에이전트로 인계했다는 보고 — 실행은 이미 됐다'],
  [/^재개 포기/, 'resume-exhausted', '판단', '재개 2회 실패 — 사람이 보고 정한다'],
  [/^다음 단계 재계획 필요/, 'replan', '판단', '단계가 끝났다 — 다음 계획은 사람이 짠다'],
  [/^결정 필요:/, 'decision-tag', '판단', '`[결정 필요]` 태그가 붙은 슬라이스'],
  [/^자동 착륙 보류 요청/, 'land-hold', '판단', '워커가 착륙을 멈춰 달라고 했다'],
  [/^PLAN.md 미커밋/, 'plan-dirty', '판단', '계획이 미커밋 — 검토하고 커밋해야 파견된다'],
  [/^본체가 origin|^본체 미push/, 'main-unpushed', '조작', '본체가 앞서 있다 — push 하면 된다'],
  [/^미분류 창/, 'stray-window', '조작', '슬라이스를 알 수 없는 창 — 닫거나 이름을 고친다'],
  [/꼴이 아니라 어느 슬라이스인지 모름/, 'stray-branch', '조작', '브랜치 이름이 `sliceN` 이 아니다'],
];

/**
 * 워커가 카드 `wait` 로 올린 질문(`무엇` 이 `… (워커 대기)`)을 판단/조작으로 가르는 **휴리스틱**.
 * 문장에 사람이 할 동작이 적혀 있으면 조작, 아니면 판단으로 본다. 규칙이 아니라 어림이므로
 * 항목별 라벨을 `data/eval/calls.json` 에 그대로 실어 사람이 되짚을 수 있게 한다.
 */
const WORKER_HANDS = /눌러|누른|열고|열어|로그인|잠금|연결|붙이고|복사합니다|실행해|보내기|적어 보내|켜|꽂/;

/** 코드 → `[need, 설명]`. 표를 그릴 때 쓴다. 워커 대기 둘은 위 휴리스틱이 만든다. */
const CALL_LABELS = {
  ...Object.fromEntries(CALL_CODES.map(([, code, need, desc]) => [code, [need, desc]])),
  'worker-decide': ['판단', '워커가 카드 `wait` 로 올린 질문 — 답을 골라야 한다'],
  'worker-hands': ['조작', '워커가 카드 `wait` 로 올린 요청 — 사람 손이 필요하다'],
  other: ['미분류', '분류표가 못 알아본 문장'],
};

const first = (table, text) => table.find(([re]) => re.test(String(text || '')));

/** 막힘 사유 한 줄 → 코드. 못 알아보면 `other`. */
const blockOf = (reason) => first(BLOCK_CODES, reason)?.[1] ?? 'other';

/** 착륙 결과 한 칸 → 코드. */
const landResultOf = (result) => first(LAND_RESULTS, result)?.[1] ?? 'other';

/** 파견 결과 한 칸 → 코드. */
const dispatchResultOf = (result) => first(DISPATCH_RESULTS, result)?.[1] ?? 'other';

/**
 * 사람 호출 한 행 → `{ code, need }`. `무엇`·`내용` 두 칸을 다 본다 — 카드 `wait` 로 올라온
 * 질문은 `내용` 에 정해진 앞머리가 없고 `무엇` 이 `slice18 (워커 대기)` 꼴이다.
 */
function callOf(row) {
  const what = String(row?.['무엇'] ?? row?.what ?? '');
  const body = String(row?.['내용'] ?? row?.body ?? '');
  const hit = first(CALL_CODES, body);
  if (hit) return { code: hit[1], need: hit[2] };
  if (/\(워커 대기\)/.test(what)) {
    return WORKER_HANDS.test(body)
      ? { code: 'worker-hands', need: '조작' }
      : { code: 'worker-decide', need: '판단' };
  }
  return { code: 'other', need: '미분류' };
}

/** 코드 → 설명 한 줄. 표의 마지막 칸에 그대로 쓴다. */
function describe(table, code) {
  const row = table.find(([, k]) => k === code);
  return row ? row[2] : null;
}

export {
  BLOCK_CODES,
  CALL_CODES,
  CALL_LABELS,
  DISPATCH_RESULTS,
  LAND_RESULTS,
  blockOf,
  callOf,
  describe,
  dispatchResultOf,
  landResultOf,
};
