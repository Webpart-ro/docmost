#!/usr/bin/env bash
# Pull-based deploy for n.webpart.ro (homeserver, /srv/apps/docmost).
#
# ghcr.io/webpart-ro/docmost:latest is only pushed by .github/workflows/webpart-image.yml
# on pushes to the `webpart` branch, i.e. merged PRs. This script, run by
# docmost-autodeploy.timer, pins compose.yml to the commit SHA of that image,
# restarts the app, health-checks it, and rolls back on failure.
#
# Note: Docmost runs DB migrations on startup. A rollback restores the old
# image but does not undo migrations a failed release already applied.
set -euo pipefail

DIR="${DOCMOST_DIR:-/srv/apps/docmost}"
IMAGE="${DOCMOST_IMAGE:-ghcr.io/webpart-ro/docmost}"
SERVICE="${DOCMOST_SERVICE:-docmost}"
COMPOSE="$DIR/compose.yml"
FAILED="$DIR/.autodeploy-failed"

exec 9>/run/docmost-autodeploy.lock
flock -n 9 || exit 0

log() { echo "docmost-autodeploy: $*"; }

current="$(grep -oE "image: ${IMAGE}:[0-9a-f]{40}" "$COMPOSE" | grep -oE '[0-9a-f]{40}$' || true)"
if [ -z "$current" ]; then
  log "no pinned ${IMAGE}:<sha> in $COMPOSE, refusing to touch it"
  exit 1
fi

docker pull -q "${IMAGE}:latest" >/dev/null
latest="$(docker image inspect "${IMAGE}:latest" \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"

if ! [[ "$latest" =~ ^[0-9a-f]{40}$ ]]; then
  log "${IMAGE}:latest has no revision label (got '$latest')"
  exit 1
fi

[ "$latest" = "$current" ] && exit 0

if [ -f "$FAILED" ] && grep -qx "$latest" "$FAILED"; then
  exit 0 # already failed once; wait for the next merge
fi

log "deploying ${current:0:8} -> ${latest:0:8}"
docker tag "${IMAGE}:latest" "${IMAGE}:${latest}"
cp "$COMPOSE" "$COMPOSE.previous"
sed -i "s#image: ${IMAGE}:${current}#image: ${IMAGE}:${latest}#" "$COMPOSE"

healthy() {
  for _ in $(seq 1 60); do
    if docker compose -f "$COMPOSE" exec -T "$SERVICE" \
      curl -fsS -o /dev/null http://localhost:3000/api/health 2>/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

if docker compose -f "$COMPOSE" up -d --wait "$SERVICE" && healthy; then
  log "deployed ${latest:0:8}"
  # Keep the running and the previous image; drop older pinned tags.
  docker images "$IMAGE" --format '{{.Tag}}' \
    | grep -E '^[0-9a-f]{40}$' \
    | grep -vx -e "$latest" -e "$current" \
    | xargs -r -I{} docker rmi "${IMAGE}:{}" >/dev/null 2>&1 || true
  exit 0
fi

log "health check failed for ${latest:0:8}, rolling back to ${current:0:8}"
echo "$latest" >> "$FAILED"
cp "$COMPOSE.previous" "$COMPOSE"
docker compose -f "$COMPOSE" up -d --wait "$SERVICE" || true
exit 1
