#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for Silk Hub, then the first deploy.
#   DEPLOY_HOST=1.2.3.4 bash deploy/server/install.sh [domain]
# Without a domain the server gets <ip>.sslip.io, which works with HTTPS right away.
# If deploy/server/ci_deploy_key.pub exists, it is allowed to run only the deploy command.
set -euo pipefail
cd "$(dirname "$0")/../.."
host=${DEPLOY_HOST:?set DEPLOY_HOST to the server address}
domain=${1:-$(echo "$host" | tr . -).sslip.io}
ssh_opts=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes)
ci_key=$(cat deploy/server/ci_deploy_key.pub 2>/dev/null || true)

ssh "${ssh_opts[@]}" "root@$host" "bash -s -- '$domain' '$ci_key'" < deploy/server/setup.sh

# Google sign-in settings go from the local .env straight into the server's settings file.
if grep -qE '^GOOGLE_CLIENT_ID=.+' .env 2>/dev/null; then
  grep -E '^GOOGLE_CLIENT_(ID|SECRET)=' .env | ssh "${ssh_opts[@]}" "root@$host" \
    'while IFS= read -r line; do key=${line%%=*}; sed -i "s|^$key=.*|$line|" /etc/silk-hub.env; done'
fi

DEPLOY_HOST=$host bash deploy/server/deploy.sh
echo "Silk Hub: https://$domain"
echo "Google OAuth redirect URI: https://$domain/auth/google/callback"
