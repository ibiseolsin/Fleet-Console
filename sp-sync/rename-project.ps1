# Dev-orca -> SP-sync 개명. 이 폴더 밖에서, 세션과 Orca 창을 닫고 실행한다.
#
# 윈도우는 열려 있는 폴더를 못 옮긴다. Claude Code 세션이나 Orca 터미널이
# 폴더 안에 있으면 Move-Item 이 실패한다 — 그래서 스크립트로 떼어냈다.
#
#   powershell -ExecutionPolicy Bypass -File <이 파일 경로>
#
# 되돌리려면 $Old 와 $New 를 바꿔서 다시 돌리고 install 을 재실행하면 된다.

$ErrorActionPreference = 'Stop'

$Root    = Join-Path $env:USERPROFILE 'orca\projects'
$Old     = Join-Path $Root 'Dev-orca'
$New     = Join-Path $Root 'SP-sync'
$SetupId = 'd22c2393-99a2-43c6-9c4f-62c0f83c8dfc'
$SpDir   = Join-Path $env:USERPROFILE '.sp-sync'

if (-not (Test-Path -LiteralPath $Old)) { throw "옛 폴더가 없다: $Old" }
if (Test-Path -LiteralPath $New)        { throw "새 폴더가 이미 있다: $New" }

# 1. 폴더 이동 — 여기서 실패하면 아직 뭔가 폴더를 잡고 있는 것이다.
Write-Host '1/5  폴더 이동'
try { Move-Item -LiteralPath $Old -Destination $New }
catch { throw "폴더를 옮기지 못했다. 이 폴더를 쓰는 세션·터미널·탐색기 창을 모두 닫고 다시 실행할 것.`n$_" }

# 2. Orca 등록 갱신 (경로와 표시 이름)
Write-Host '2/5  Orca 등록 갱신'
& orca.exe project setup-update --setup $SetupId --path $New --display-name 'SP-sync' | Out-Null

# 3. 훅 재설치 — settings.local.json 과 .git/hooks 의 절대경로가 옛 폴더를 가리킨다
Write-Host '3/5  훅 재설치'
& node (Join-Path $New 'sp-sync\sp-sync.mjs') install $New

# 4. 런타임 상태에서 옛 경로 정리
Write-Host '4/5  상태 파일 정리'
$fixer = @'
const fs=require("fs"),path=require("path");
const dir=path.join(require("os").homedir(),".sp-sync");
const swap=s=>String(s).replace(/([\\\/])Dev-orca([\\\/]|$)/gi,(m,a,b)=>a+"SP-sync"+b);
const f=path.join(dir,"state.json");
const s=JSON.parse(fs.readFileSync(f,"utf8"));
const repos={}; for(const[k,v]of Object.entries(s.repos||{})) repos[swap(k).toLowerCase()]=v;
s.repos=repos;
for(const e of Object.values(s.sessions||{})) if(e&&e.cwd) e.cwd=swap(e.cwd);
delete (s.projectIds||{})["Dev-orca"];   // 죽은 projectId 캐시
fs.writeFileSync(f,JSON.stringify(s,null,2));
for(const sub of ["cards","candidates"]){
  const d=path.join(dir,sub); if(!fs.existsSync(d)) continue;
  for(const n of fs.readdirSync(d)){
    const p=path.join(d,n);
    if(sub==="candidates"&&/^Dev-orca\.json$/i.test(n)){ fs.unlinkSync(p); continue; }
    try{ const j=JSON.parse(fs.readFileSync(p,"utf8")); if(j.cwd){ j.cwd=swap(j.cwd); fs.writeFileSync(p,JSON.stringify(j)); } }catch{}
  }
}
const shim=path.join(dir,"sp-sync.mjs");
if(fs.existsSync(shim)) fs.unlinkSync(shim);   // 옛 경로 전달자. 더는 필요 없다
console.log("   상태 정리 완료");
'@
$fixer | & node -

# 5. 기억 폴더 이관
#    Claude Code 는 작업 경로로 폴더 이름을 짓는다. 폴더를 옮기면 새 이름으로 빈 폴더를
#    새로 만들기 때문에, 옮겨주지 않으면 이 프로젝트의 기억이 새 세션에 안 실린다.
Write-Host '5/6  기억 폴더 이관'
$ProjDir = Join-Path $env:USERPROFILE '.claude\projects'
$OldMem  = Join-Path $ProjDir 'C--Users-----orca-projects-Dev-orca\memory'
$NewMem  = Join-Path $ProjDir 'C--Users-----orca-projects-SP-sync\memory'
if (Test-Path -LiteralPath $OldMem) {
  if (Test-Path -LiteralPath $NewMem) {
    Write-Host '   새 기억 폴더가 이미 있다. 덮지 않고 넘어간다.'
  } else {
    New-Item -ItemType Directory -Path (Split-Path $NewMem) -Force | Out-Null
    Copy-Item -LiteralPath $OldMem -Destination $NewMem -Recurse
    Write-Host "   복사함: $NewMem"
  }
} else {
  Write-Host '   옛 기억 폴더가 없다. 넘어간다.'
}

# 6. 확인
Write-Host '6/6  확인'
& node (Join-Path $New 'sp-sync\sp-sync.mjs') doctor $New

Write-Host ''
Write-Host '끝났다. SP 앱에서 프로젝트 이름을 SP-sync 로 바꿨는지 확인할 것 —'
Write-Host '안 바꿨으면 doctor 가 프로젝트를 못 찾고, 작업이 조용히 기록되지 않는다.'
