#!/usr/bin/env bash
# One-time setup of a fresh Debian 13 server for Minerva. Run as root; safe to run again, and run again
# after a change to deploy/server/minerva-deploy. Run through `deploy/ops.sh <env> bootstrap`, which
# copies this file and deploy/server/ to /root/minerva-bootstrap/ first.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
APT_OPTS=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

echo "== Packages"
apt-get update
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install ca-certificates curl git gnupg ufw unattended-upgrades rsync

echo "== Unattended upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

echo "== Docker Engine (download.docker.com)"
install -m 0755 -d /etc/apt/keyrings
. /etc/os-release
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

echo "== gVisor (gvisor.dev)"
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list

apt-get update
apt-get "${APT_OPTS[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin runsc

# Rotate logs of containers the compose file does not configure (the per-run workers).
# Written only if absent; `runsc install` then merges its runtime into the same file.
if [[ ! -f /etc/docker/daemon.json ]]; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
fi
runsc install
# Workers use this one: without --host-uds=open, gVisor refuses connections to the gateway socket
# that the host mounts into them.
runsc install --runtime=runsc-minerva -- --host-uds=open
systemctl enable docker
systemctl restart docker
# No grep -q after a pipe: it exits early, the writer gets SIGPIPE, and pipefail fails the check.
docker info --format '{{json .Runtimes}}' | grep runsc-minerva >/dev/null || { echo "runsc-minerva is not registered with Docker." >&2; exit 1; }
docker run --rm --runtime=runsc-minerva hello-world >/dev/null
echo "gVisor runtime works."

echo "== Firewall: SSH only"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "== SSH: keys only"
# Refuses to lock the door before a key is in place (ssh-copy-id first).
if [[ ! -s /root/.ssh/authorized_keys ]]; then
  echo "/root/.ssh/authorized_keys is empty: add your key before turning off password logins." >&2
  exit 1
fi
# sshd keeps the first value it reads, and the image's 50-cloud-init.conf may allow passwords, so this
# file sorts first.
cat > /etc/ssh/sshd_config.d/00-minerva.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh
sshd -T | grep -x 'passwordauthentication no' >/dev/null || { echo "Password logins are still allowed." >&2; exit 1; }

echo "== Swap"
if [[ -z "$(swapon --show --noheadings)" ]]; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
if [[ -f /swapfile ]] && ! grep -q '^/swapfile ' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Persistent journal (release logs)"
install -d -m 2755 -g systemd-journal /var/log/journal
systemctl restart systemd-journald

echo "== /opt/minerva and the deploy commands"
install -d -m 0750 /opt/minerva /opt/minerva/backups
install -d -m 0750 -o root -g 10001 /opt/minerva/secrets
# The gatekeeper of every deploy: installed from this checkout, never from the commit being deployed.
install -m 0755 "$HERE/server/minerva-deploy" /usr/local/bin/minerva-deploy
# Follows the deployed commit, so that it always matches the compose file it runs.
ln -sfn /opt/minerva/src/deploy/server/minerva-compose /usr/local/bin/minerva-compose

echo "Bootstrap complete. Next: deploy/ops.sh <env> env, then deploy/ops.sh <env> deploy."
