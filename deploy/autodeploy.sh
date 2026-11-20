#!/bin/bash
# Usion game host auto-deploy: pull a game's :latest image and roll it out.
# Runs as root from systemd (usion-autodeploy@<slug>.timer, every minute).
#
#   /opt/usion-games/autodeploy/<slug>.conf   IMAGE=ghcr.io/owner/repo   HEALTH=/health   PORT=8080
#   /opt/usion-games/games/<slug>.yml         the game's compose file (image: line is rewritten)
#
# New image → compose up → http://127.0.0.1:<PORT><HEALTH> inside the container
# must answer 200 within 90 s, otherwise the previous image goes back. Every change is appended
# to releases.log. Nothing happens while the running image is already the latest.
set -uo pipefail

SLUG="${1:?usage: autodeploy.sh <slug>}"
ROOT=/opt/usion-games
CONF="$ROOT/autodeploy/$SLUG.conf"
YML="$ROOT/games/$SLUG.yml"
LOG="$ROOT/releases.log"
[ -f "$CONF" ] && [ -f "$YML" ] || { echo "missing $CONF or $YML"; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${IMAGE:?IMAGE missing in $CONF}"
HEALTH="${HEALTH:-/health}"
PORT="${PORT:-8080}"

exec 9>"/run/usion-autodeploy-$SLUG.lock"
flock -n 9 || exit 0

# Quiet when the registry is unreachable or the package is still private.
# AUTODEPLOY_NO_PULL=1 rolls out whatever :latest is already local (testing).
if [ -z "${AUTODEPLOY_NO_PULL:-}" ]; then
  docker pull -q "$IMAGE:latest" >/dev/null 2>&1 || { echo "pull $IMAGE:latest failed"; exit 0; }
fi
REV=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE:latest" 2>/dev/null)
[ -n "$REV" ] && [ "$REV" != "<no value>" ] || { echo "image has no revision label"; exit 0; }
NEW="$IMAGE:${REV:0:12}"
# A revision that failed its health check is never retried; push a fix instead.
FAILED="$ROOT/autodeploy/$SLUG.failed"
grep -qx "$REV" "$FAILED" 2>/dev/null && exit 0
docker tag "$IMAGE:latest" "$NEW"

OLD=$(sed -nE 's/^ *image: *([^ ]+).*/\1/p' "$YML" | head -1)
CUR=$(docker inspect -f '{{.Config.Image}}' "game-$SLUG" 2>/dev/null || true)
[ "$OLD" = "$NEW" ] && [ "$CUR" = "$NEW" ] && exit 0

up() { sed -i -E "0,/^( *image: *).*/s##\1$1#" "$YML"; docker compose -p "game-$SLUG" -f "$YML" up -d >/dev/null 2>&1; }
healthy() {
  for _ in $(seq 1 45); do
    docker exec "game-$SLUG" wget -q -T 5 -O /dev/null "http://127.0.0.1:$PORT$HEALTH" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "deploying $NEW (was $OLD)"
up "$NEW"
if healthy; then
  echo "$(now) $SLUG server ${NEW##*:} autodeploy" >> "$LOG"
  echo "live: $NEW"
else
  echo "health failed for $NEW, last log lines:"; docker logs --tail 20 "game-$SLUG" 2>&1
  up "$OLD"
  echo "$REV" >> "$FAILED"
  echo "$(now) $SLUG FAILED ${NEW##*:} rolled back to ${OLD##*:} autodeploy" >> "$LOG"
  healthy && echo "rolled back to $OLD" || echo "rollback to $OLD is not healthy either"
  exit 1
fi

# Keep the running image and the one before it; drop older revisions of this repo.
docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' | grep -v -e ':latest$' -e "^$NEW$" -e "^$OLD$" \
  | xargs -r docker rmi >/dev/null 2>&1 || true
