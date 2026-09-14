#!/bin/sh
# 완료 기준 1 (PLAN 슬라이스 12): 볼륨 없는 컨테이너에 seed → 컨테이너를 지우고 새로 만든 뒤 → verify.
# 상태는 `dir` 백엔드(호스트 폴더 하나에 state.tar.gz)로만 건너간다 — Render Free 의 GitHub 백엔드와 같은 경로.
# 사용: sh scripts/container-recreate-check.sh [이미지] [호스트 스냅샷 폴더]
set -eu
export MSYS_NO_PATHCONV=1  # Git Bash: keep /snapshot as a container path
IMAGE="${1:-fleet-console}"
SNAP="${2:-$(mktemp -d)}"
NAME=fleet-recreate-check
mkdir -p "$SNAP"
run() { # 이름 → 새 컨테이너(볼륨 없음, 스냅샷 폴더만 바인드)
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -e FLEET_STATE_DIR=/snapshot -e FLEET_STATE_SYNC_INTERVAL_MS=0 \
    -v "$SNAP:/snapshot" "$IMAGE" >/dev/null
  i=0; until docker logs "$NAME" 2>&1 | grep -q '"event":"state-sync:watching"'; do
    i=$((i+1)); [ "$i" -lt 60 ] || { docker logs "$NAME"; echo "watcher did not start"; exit 1; }; sleep 1; done
}
echo "== 1. fresh container, seed"
run
docker logs "$NAME" 2>&1 | grep 'state-sync:\|state-ready'
docker exec -u node "$NAME" node scripts/container-check.mjs seed
echo "== 2. stop (SIGTERM → final upload) and delete the container"
docker stop -t 30 "$NAME" >/dev/null
docker logs "$NAME" 2>&1 | grep 'state-sync:' | tail -4
docker rm "$NAME" >/dev/null
ls -l "$SNAP"
echo "== 3. new container: restore → prepare → verify"
run
docker logs "$NAME" 2>&1 | grep 'state-sync:\|state-ready'
docker exec -u node "$NAME" node scripts/container-check.mjs verify
echo "== 4. cleanup"
docker stop -t 30 "$NAME" >/dev/null
docker logs "$NAME" 2>&1 | grep 'state-sync:' | tail -3
docker rm "$NAME" >/dev/null
echo "snapshot dir: $SNAP"
