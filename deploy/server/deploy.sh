#!/usr/bin/env bash
# Uploads the current code to the server and switches to it (rolls back if the health check fails).
#   DEPLOY_HOST=1.2.3.4 bash deploy/server/deploy.sh
# Optional DEPLOY_KEY: path to the SSH private key (CI uses its restricted deploy key).
set -euo pipefail
cd "$(dirname "$0")/../.."
host=${DEPLOY_HOST:?set DEPLOY_HOST to the server address}
ssh_opts=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes)
[ -n "${DEPLOY_KEY:-}" ] && ssh_opts+=(-i "$DEPLOY_KEY")

tar -cz src scripts package.json package-lock.json | ssh "${ssh_opts[@]}" "root@$host" /usr/local/bin/silk-hub-receive
