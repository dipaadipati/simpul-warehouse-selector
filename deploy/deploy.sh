#!/usr/bin/env bash
#
# Rebuild and restart the service from the checkout it lives in, then prove it
# actually answers.
#
# This is the single copy of the deploy logic. The GitHub Actions workflow calls
# this file, and a person deploying by hand runs the same file, so the two paths
# cannot drift apart and quietly disagree about how the service is started.
#
# Run it on the server, after the checkout is at the revision you want:
#
#   cd /opt/simpul
#   git fetch --prune origin
#   git remote set-head origin --auto
#   git reset --hard origin/HEAD
#   bash deploy/deploy.sh
#
# The git update is deliberately NOT part of this script. bash reads a script as
# it executes it, so a script that rewrites its own file halfway through is a
# script that can go on to execute garbage.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "--- building and starting ---"
docker compose up -d --build

# "the command exited 0" is not the same claim as "the service answers", and the
# difference is the whole reason to automate a deploy at all.
echo "--- waiting for health ---"
for _ in $(seq 1 15); do
  # stderr silenced on purpose: fifteen "connection refused" lines bury the
  # container state printed below, which is the part that says why.
  if curl -fsS -o /dev/null http://127.0.0.1:3000/healthz 2>/dev/null; then
    echo "health check passed"
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "health check FAILED after 30 seconds"
docker compose ps || true
docker compose logs --tail=60 || true
exit 1
