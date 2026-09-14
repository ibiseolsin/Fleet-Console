#!/bin/sh
set -eu
# Only one container may own this state root at a time (Render Free runs one instance).
# Prepare the state directory at runtime; image-layer ownership is hidden by mounts.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$FLEET_STATE_ROOT"
  chown node:node "$FLEET_STATE_ROOT"
  exec gosu node sh "$0" "$@"
fi
# Order matters: restore the snapshot first, then prepare (turns restored `running` into
# `interrupted`, drops empty locks), then watch for changes while Next serves.
node /app/scripts/state-sync.mjs restore
node /app/scripts/container-prepare.mjs
node /app/scripts/state-sync.mjs watch &
WATCH=$!
node /app/web/node_modules/next/dist/bin/next start /app/web --hostname 0.0.0.0 --port "$PORT" &
NEXT=$!
# tini -g signals the whole group, so both children see SIGTERM; forward anyway and keep this
# shell alive until the watcher finished its final upload (otherwise tini exits and cuts it off).
trap 'kill -TERM "$NEXT" 2>/dev/null || true' TERM INT
status=0
while kill -0 "$NEXT" 2>/dev/null; do
  set +e; wait "$NEXT"; status=$?; set -e
done
kill -TERM "$WATCH" 2>/dev/null || true
set +e; wait "$WATCH"; set -e
exit "$status"
