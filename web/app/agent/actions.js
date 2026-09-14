'use server';

import { redirect } from 'next/navigation';
import { resumeRun, startRun } from '../../../src/agent/loop.mjs';
import { withDemo } from '../../lib/demo';

/**
 * 에이전트 루프의 두 버튼 — **시작**과 **이어서 끝내기** (슬라이스 7).
 *
 * 둘 다 루프를 기다리지 않는다. 실행 기록을 만들자마자 상세 화면으로 보내고, 루프는 이 서버
 * 프로세스 안에서 계속 돈다 — 화면은 파일(`sandbox/agent-runs/`)을 다시 읽어 따라간다.
 * 승인은 여기 없다. 쓰기 도구 앞에서 멈춘 실행은 `/approvals` 에서 사람이 답한 뒤 이어간다.
 */
export async function start(formData) {
  let id, error;
  try {
    id = await withDemo(() => {
      const prompt = String(formData.get('prompt') || '').trim().slice(0, 500);
      const { run, done } = startRun({ ...(prompt ? { prompt } : {}) });
      done.catch(() => {});
      return run.id;
    });
  } catch (e) { error = e.message; }
  redirect(error ? '/agent?msg=' + encodeURIComponent(error) : '/agent/' + id);
}

export async function resume(formData) {
  const id = String(formData.get('id') || '');
  const r = await withDemo(() => resumeRun(id));
  if (!r.ok) redirect('/agent/' + encodeURIComponent(id) + '?msg=' + encodeURIComponent(r.error) + '&bad=1');
  r.done.catch(() => {});
  redirect('/agent/' + id);
}
