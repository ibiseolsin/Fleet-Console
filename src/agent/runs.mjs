import { statePath } from '../state.mjs';
/**
 * 에이전트 실행 기록 (슬라이스 7) — 루프 하나가 남기는 파일.
 *
 * 한 실행은 `sandbox/agent-runs/<id>.json` 하나다. 루프가 메시지를 받을 때마다 **통째로 다시 쓰므로**
 * (tmp → rename) 서버가 어느 순간에 죽어도 파일은 마지막 온전한 상태다. 모델과 나눈 대화도
 * 여기(`messages`)에 있어 다시 켠 뒤 이 파일만으로 이어서 끝낼 수 있다 — 루프 프로세스 안에는
 * 아무것도 안 남긴다.
 *
 * 화면(`/agent`)과 루프(`loop.mjs`)와 검사 스크립트가 이 파일 하나를 같이 읽는다.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = statePath('agent-runs');
const currentPath = () => statePath('agent-runs');

/**
 * 실행의 삶.
 *   running     — 루프가 돌고 있다 (이 기계의 어느 프로세스에서)
 *   waiting     — 쓰기 도구 앞에서 멈춤. 승인 큐의 항목 하나를 기다린다
 *   interrupted — 돌던 프로세스가 사라졌다 (서버를 껐다 켬). 이어서 끝낼 수 있다
 *   stopped     — 상한(반복 · 시간 · 비용)에 닿아 사유와 함께 멈춤. 이어서 돌릴 수 있다
 *   done        — 끝남
 *   failed      — 오류로 끝남
 */
const STATES = ['running', 'waiting', 'interrupted', 'stopped', 'done', 'failed'];

/** 이 상태에서는 "이어서 끝내기" 를 누를 수 있다. */
const RESUMABLE = ['waiting', 'interrupted', 'stopped'];

const fileOf = (id) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('잘못된 실행 ID');
  return join(currentPath(), id + '.json');
};

function writeRun(run) {
  mkdirSync(currentPath(), { recursive: true });
  run.updatedAt = new Date().toISOString();
  const tmp = fileOf(run.id) + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n');
  renameSync(tmp, fileOf(run.id));
  return run;
}

/** 그 pid 가 살아 있나. 다른 프로세스가 돌리던 실행이 끊겼는지 볼 때 쓴다. */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 파일 하나를 읽고, **돌던 프로세스가 죽었으면 `interrupted` 로 고쳐 적는다.** 루프는 자기 죽음을
 * 못 적으므로 읽는 쪽이 판정한다 — 살아 있는 프로세스의 실행은 건드리지 않는다.
 */
function readRun(id) {
  let run;
  try {
    run = JSON.parse(readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
  if (run.state === 'running' && run.pid !== process.pid && !alive(run.pid)) {
    run.state = 'interrupted';
    run.stop = { kind: 'interrupted', reason: '돌리던 프로세스(pid ' + run.pid + ')가 사라졌다 — 서버를 껐다 켠 것. 이어서 끝낼 수 있다' };
    run.pid = null;
    writeRun(run);
  }
  return run;
}

function listRuns() {
  let names = [];
  try {
    names = readdirSync(currentPath()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n) => readRun(n.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export { RESUMABLE, RUNS_DIR, STATES, listRuns, readRun, writeRun };
