// node --test sp-sync/test/*.test.mjs
// 회차 트리거를 터미널 밖에서 띄우는 명령 (`triggerLaunchPlan`). Orca 가 탭을 닫을 때 Job Object 로 손자까지
// 죽이므로 Windows 에서는 WMI 로 만든다 — 그 명령줄이 Node argv 로 그대로 되돌아오는지, 다른 OS 는 분리 자식 그대로인지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { triggerLaunchPlan } from '../sp-sync.mjs';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SELF = 'C:\\Users\\me\\orca\\projects\\SP-sync\\sp-sync\\sp-sync.mjs';

test('Windows 는 powershell 의 Win32_Process.Create 로 띄운다 — 기다리지 않는 짧은 명령', () => {
  const p = triggerLaunchPlan('Project X', { platform: 'win32', node: NODE, self: SELF });
  assert.equal(p.viaWmi, true);
  assert.equal(p.exe, 'powershell.exe');
  assert.ok(p.args.includes('-NonInteractive'));
  const ps = p.args[p.args.length - 1];
  assert.match(ps, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.ok(ps.includes("CommandLine = '" + p.cmdLine + "'"), '명령줄이 작은따옴표 안에 그대로');
  assert.ok(ps.includes('Write-Output $r.ProcessId') && ps.includes('exit [int]$r.ReturnValue'), '훅이 pid 와 종료 코드로 성공을 판정한다');
  assert.equal(p.cmdLine, '"' + NODE + '" "' + SELF + '" "fleet" "trigger" "--project" "Project X"');
});

test('명령줄 안의 작은따옴표는 PowerShell 식으로 겹쳐 쓴다', () => {
  const p = triggerLaunchPlan("O'Brien", { platform: 'win32', node: NODE, self: SELF });
  assert.ok(p.args[p.args.length - 1].includes("O''Brien"));
  assert.ok(p.cmdLine.includes('"--project" "O\'Brien"'));
});

test('큰따옴표·끝 백슬래시가 든 인자도 Node argv 로 그대로 돌아온다', { skip: process.platform !== 'win32' && 'Windows 명령줄 규칙' }, () => {
  const weird = 'A "B" C\\';
  const p = triggerLaunchPlan(weird, { platform: 'win32', node: process.execPath, self: SELF });
  // 실제 CRT 파서로 되돌려 본다 — 같은 명령줄을 node -e 로 넘겨 argv 를 찍는다.
  const rest = p.cmdLine.slice(('"' + process.execPath + '" ').length);
  const probe = '"' + process.execPath + '" -e "console.log(JSON.stringify(process.argv.slice(1)))" ' + rest;
  const r = spawnSync(probe, { shell: true, encoding: 'utf8', windowsHide: true });
  const argv = JSON.parse(r.stdout.trim());
  assert.deepEqual(argv, [SELF, 'fleet', 'trigger', '--project', weird]);
});

test('Windows 가 아니면 분리 자식 그대로', () => {
  const p = triggerLaunchPlan('Demo', { platform: 'linux', node: '/usr/bin/node', self: '/s/sp-sync.mjs' });
  assert.deepEqual(p, { exe: '/usr/bin/node', args: ['/s/sp-sync.mjs', 'fleet', 'trigger', '--project', 'Demo'], viaWmi: false });
});
