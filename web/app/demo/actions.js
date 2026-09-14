'use server';

import { redirect } from 'next/navigation';
import { assertIdle, resetDemo } from '../../../src/demo.mjs';
import { readQueue } from '../../../src/fleet/approvals.mjs';
import { TOOLS } from '../../../src/fleet/tools.mjs';
import { withDemo } from '../../lib/demo';

export async function request(tool, formData) {
  let msg;
  try {
    msg = await withDemo(async () => {
      assertIdle();
      if (!['fleet_dispatch', 'fleet_land'].includes(tool)) throw new Error('지원하지 않는 요청입니다.');
      const project = String(formData.get('project') || '');
      const args = tool === 'fleet_dispatch' ? { project, slice: Number(formData.get('slice')) } : { project, workspace: String(formData.get('workspace') || '') };
      const out = await TOOLS.find((t) => t.name === tool).run(args);
      return out.data.reason || out.text;
    });
  } catch (e) { msg = e.message; }
  redirect('/approvals?msg=' + encodeURIComponent(msg));
}

export async function execute(formData) {
  let msg;
  try {
    msg = await withDemo(async () => {
      assertIdle();
      const item = readQueue().items.find((i) => i.id === String(formData.get('id')));
      if (!item || item.state !== 'approved') throw new Error('이 방문자의 승인된 항목이 아닙니다.');
      const out = await TOOLS.find((t) => t.name === item.tool).run({ ...item.args, approvalId: item.id });
      return out.data.reason || out.text;
    });
  } catch (e) { msg = e.message; }
  redirect('/approvals?msg=' + encodeURIComponent(msg));
}

export async function reset() {
  let msg;
  try { await withDemo(resetDemo); msg = '처음 상태로 돌아왔습니다. 승인 이력과 실행 기록은 보존했습니다.'; }
  catch (e) { msg = e.message; }
  redirect('/demo?msg=' + encodeURIComponent(msg));
}
