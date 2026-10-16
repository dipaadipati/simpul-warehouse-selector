#!/usr/bin/env bash
#
# Install and restart the service from the checkout it lives in, then prove it
# actually answers.
#
# This is the single copy of the deploy logic. The GitHub Actions workflow calls
# this file, the Harness pipeline calls this file, and a person deploying by hand
# runs the same file, so the three paths cannot drift apart and quietly disagree
# about how the service is started.
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

echo "--- installing ---"
# There is no build step - Node 24 strips the types itself, so the repository
# runs as checked out. This line is here for the day a runtime dependency
# appears; today it installs nothing and costs a second.
npm ci --omit=dev

# startOrReload covers the first deploy and every one after it, so there is no
# branch here for "is it already running".
echo "--- starting ---"
pm2 startOrReload ecosystem.config.cjs

# "the command exited 0" is not the same claim as "the service answers", and the
# difference is the whole reason to automate a deploy at all.
echo "--- waiting for health ---"
for _ in $(seq 1 15); do
  # stderr silenced on purpose: fifteen "connection refused" lines bury the PM2
  # state printed below, which is the part that says why.
  if curl -fsS -o /dev/null http://127.0.0.1:3000/healthz 2>/dev/null; then
    echo "health check passed"
    # So this process list is what `pm2 resurrect` starts after a reboot.
    # `pm2 startup` has to be run once, by hand; see section 11 of the README.
    pm2 save
    pm2 status
    exit 0
  fi
  sleep 2
done

echo "health check FAILED after 30 seconds"
pm2 status || true
pm2 logs --nostream --lines 60 || true
exit 1
