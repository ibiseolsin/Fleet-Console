'use server';

import { redirect } from 'next/navigation';
import { decideApproval } from '../../../src/fleet/approvals.mjs';
import { withDemo } from '../../lib/demo';

/**
 * 사람의 결정 — 화면의 버튼이 부르는 자리 (슬라이스 6).
 *
 * **승인은 도구가 아니다** (`src/fleet/approvals.mjs` 머리말). 에이전트가 제 요청을 스스로
 * 승인할 수 있으면 게이트가 아니라서, 승인·보류는 사람의 두 창구 — 명령줄
 * (`scripts/approve.mjs`)과 이 화면 — 만 부른다. 둘 다 `decideApproval` 하나를 쓴다.
 *
 * 결과는 주소줄로 돌려준다(`?msg=`). 그래야 화면이 서버 컴포넌트로만 서고 자바스크립트가
 * 꺼져 있어도 버튼이 동작한다 — 승인 큐는 사람이 자리를 비운 사이에도 열리는 화면이다.
 *
 * **결정은 인자로 묶어 받는다** (`decide.bind(null, 'approve')`). 버튼에 `name="decision"` 을
 * 달아 보내는 쪽이 짧지만, 그 값이 폼 데이터에 안 실려 오는 경로가 있었다 — 실제로 승인이
 * "결정은 approve 또는 hold 다: " 로 튕겼다. 묶어 두면 버튼마다 다른 함수라 값이 샐 자리가 없다.
 */
export async function decide(decision, formData) {
  const id = String(formData.get('id') || '');
  const note = String(formData.get('note') || '').trim();
  const r = await withDemo(() => decideApproval(id, decision, note));
  const msg = r.ok
    ? (decision === 'approve' ? '승인' : '보류') + ' — ' + r.item.id + (decision === 'approve' ? '. 같은 인자로 ' + r.item.tool + ' 를 다시 부르면 실행된다.' : '')
    : r.error;
  redirect('/approvals?msg=' + encodeURIComponent(msg) + (r.ok ? '' : '&bad=1'));
}
