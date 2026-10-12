#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server for Silk Hub: Node.js 22, Caddy (HTTPS from Let's Encrypt),
# a systemd service, a firewall, nightly backups and a restricted deploy command for CI.
# Run once as root (deploy/server/install.sh does it for you):
#   bash setup.sh <domain> [CI deploy public key]
set -euo pipefail
domain=$1
ci_key=${2:-}
app=/opt/silk-hub
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -yq ca-certificates curl gnupg ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ $(node -v) != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

id hub >/dev/null 2>&1 || useradd --system --home-dir "$app" --shell /usr/sbin/nologin hub
install -d -o hub -g hub "$app" "$app/data" "$app/backups" "$app/releases"

# Settings of the service. The session secret is generated here and never leaves the server.
if [ ! -f /etc/silk-hub.env ]; then
  (umask 027; cat > /etc/silk-hub.env <<EOF
BASE_URL=https://$domain
HOST=127.0.0.1
PORT=8787
DATA_DIR=$app/data
SESSION_SECRET=$(openssl rand -hex 32)
DEV_LOGIN=0
TRUST_PROXY=1
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
EOF
  )
  chown root:hub /etc/silk-hub.env
fi

cat > /etc/systemd/system/silk-hub.service <<EOF
[Unit]
Description=Silk Hub
After=network-online.target
Wants=network-online.target

[Service]
User=hub
Group=hub
EnvironmentFile=/etc/silk-hub.env
WorkingDirectory=$app/current
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning src/server.js
Restart=always
RestartSec=3
MemoryMax=512M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$app/data $app/backups

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/silk-hub-backup.service <<EOF
[Unit]
Description=Silk Hub backup

[Service]
Type=oneshot
User=hub
EnvironmentFile=/etc/silk-hub.env
WorkingDirectory=$app/current
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning scripts/backup.js $app/backups
EOF

cat > /etc/systemd/system/silk-hub-backup.timer <<EOF
[Unit]
Description=Nightly Silk Hub backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Caddy terminates HTTPS and proxies to the service on localhost. It ignores X-Forwarded-For from
# clients, so the IP limits of the service can't be bypassed with a forged header.
cat > /etc/caddy/Caddyfile <<EOF
$domain {
	encode gzip
	request_body {
		max_size 25MB
	}
	header -Server
	reverse_proxy 127.0.0.1:8787
	log {
		output file /var/log/caddy/silk-hub.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
EOF

# Receives a release tarball on stdin, installs it next to the previous ones, switches over and
# rolls back if the health check fails. CI connects with a key that can run only this command.
cat > /usr/local/bin/silk-hub-receive <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
app=/opt/silk-hub
release=$app/releases/$(date +%Y%m%d-%H%M%S)
mkdir -p "$release"
# A broken upload or install leaves nothing behind.
trap 'rm -rf "$release"' ERR
tar -xz -C "$release"
cd "$release"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
trap - ERR
chown -R hub:hub "$release"
previous=$(readlink -f "$app/current" || true)
ln -sfn "$release" "$app/current"
systemctl restart silk-hub
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
    ls -1dt "$app"/releases/* | tail -n +6 | xargs -r rm -rf
    echo "Deployed $(basename "$release")"
    exit 0
  fi
  sleep 1
done
echo "Health check failed, rolling back" >&2
if [ -n "$previous" ]; then
  ln -sfn "$previous" "$app/current"
  systemctl restart silk-hub
fi
exit 1
EOF
chmod 755 /usr/local/bin/silk-hub-receive

if [ -n "$ci_key" ] && ! grep -qF "$ci_key" /root/.ssh/authorized_keys 2>/dev/null; then
  echo "command=\"/usr/local/bin/silk-hub-receive\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $ci_key" >> /root/.ssh/authorized_keys
fi

# Keys only: password logins are turned off once a key is in place.
if [ -s /root/.ssh/authorized_keys ]; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-silk-hub.conf
  systemctl reload ssh || systemctl reload sshd || true
fi

ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable silk-hub silk-hub-backup.timer >/dev/null
systemctl start silk-hub-backup.timer
systemctl reload caddy || systemctl restart caddy
echo "Server is ready for https://$domain"
