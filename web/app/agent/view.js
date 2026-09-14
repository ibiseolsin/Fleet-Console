/** 두 화면(목록 · 상세)이 같이 쓰는 조각. 상태 이름은 `src/agent/runs.mjs` 의 여섯 그대로다. */

const STATE = {
  running: ['돌고 있음', 'warn'],
  waiting: ['승인 대기', 'warn'],
  interrupted: ['끊김', 'stop'],
  stopped: ['상한 멈춤', 'stop'],
  done: ['끝남', ''],
  failed: ['실패', 'stop'],
};

export function StateBadge({ state }) {
  const [label, tone] = STATE[state] || [state, ''];
  return <span className={'n on ' + tone}>{label}</span>;
}

export const fmtWhen = (iso) => (iso || '').replace('T', ' ').slice(5, 16);

export const totalCost = (run) => run.legs.reduce((a, l) => a + (l.costUsd || 0), 0);
