# Deploying to the netcup VPS

Push to `main` → GitHub runs the test suite → if it passes, the server pulls and
restarts. About 40 seconds end to end.

## Why this is safe

Every piece of runtime state is git-ignored and **untracked**: the ten JSON
stores, `Uploads/`, `.pdf-cache/`. `git reset --hard` only rewrites *tracked*
files, so it provably cannot delete an account, a day log or an attachment.

That is the whole design. The one command that would break it is
`git clean -fdx`, which deletes untracked files — never run it in `/opt/szignotes`.
`szignotes-deploy` guards the other half by refusing to run if a state file ever
becomes tracked.

## Layout on the server

`server.js` resolves content as `../Data`, `../DataHU`, `../Music`, so the whole
repo is checked out and the service runs from the `Website/` subdirectory:

```
/opt/szignotes/            ← git checkout, branch main
├── Data/  DataHU/  Music/ ← content, tracked
└── Website/               ← WorkingDirectory
    ├── server.js          ← tracked
    ├── *.json             ← STATE, untracked
    ├── Uploads/           ← STATE, untracked
    └── .pdf-cache/        ← rebuildable, untracked
```

---

## One-time server setup

Run as root on the fresh netcup box.

### 1. User, packages, checkout

```bash
adduser --disabled-password --gecos "" deploy

apt update
apt install -y curl git caddy texlive-latex-recommended texlive-fonts-recommended texlive-lang-european
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

install -d -o deploy -g deploy /opt/szignotes
sudo -u deploy git clone https://github.com/RobinCodes/Digitalization.git /opt/szignotes
```

`texlive-lang-european` carries Hungarian hyphenation — worth having given the
`DataHU/` half of the archive. Add `texlive-science` if your notes use `amsmath`
extras beyond the base set. Only reach for `texlive-full` (~5 GB) if something
actually fails to compile.

### 2. Service

```bash
install -m 644 /opt/szignotes/Deploy/szignotes.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now szignotes
journalctl -u szignotes -n 30      # confirm the pdflatex banner says it was found
```

### 3. Deploy script + restricted sudo

```bash
install -m 755 /opt/szignotes/Deploy/szignotes-deploy.sh /usr/local/bin/szignotes-deploy

cat > /etc/sudoers.d/szignotes <<'EOF'
deploy ALL=(root) NOPASSWD: /bin/systemctl restart szignotes, /bin/systemctl is-active szignotes
EOF
chmod 440 /etc/sudoers.d/szignotes
visudo -c
```

The deploy user can restart this one service and nothing else.

### 4. Caddy

Point DNS at the box first — Caddy needs the names resolving to get a cert.

```bash
install -m 644 /opt/szignotes/Deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl reload caddy
```

### 5. Your admin account

```bash
cd /opt/szignotes/Website
sudo -u deploy node make-admin.js <you> '<a long password>'
```

---

## Wiring GitHub to it

### On the server — a key that can only deploy

```bash
sudo -u deploy ssh-keygen -t ed25519 -f /home/deploy/.ssh/gh_deploy -N '' -C github-actions

install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
printf 'command="/usr/local/bin/szignotes-deploy",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n' \
  "$(cat /home/deploy/.ssh/gh_deploy.pub)" \
  >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

cat /home/deploy/.ssh/gh_deploy      # ← private key, copy it
rm /home/deploy/.ssh/gh_deploy       # ← then delete it from the server
```

The `command=` prefix is the important part: even if that private key leaks, it
cannot open a shell, forward a port or read a file. It can only trigger a deploy.

### On GitHub — three secrets

*Settings → Secrets and variables → Actions → New repository secret*

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | the private key printed above, whole file including the BEGIN/END lines |
| `DEPLOY_HOST` | the server's IPv4 |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan <server-ip>` run on your own machine |

`DEPLOY_KNOWN_HOSTS` is what stops the workflow handing the key to an imposter —
don't skip it in favour of `StrictHostKeyChecking=no`.

### Test it

Actions tab → *Test &amp; deploy* → **Run workflow**. That runs the whole path
without needing a commit.

---

## Day to day

- **Deploys sign everyone out.** Sessions are in memory. Harmless, but don't push
  to `main` mid-lesson.
- **A failing test blocks the deploy.** The `deploy` job needs `test`.
- **Roll back** by reverting the commit and pushing — the same path redeploys.
  For an emergency, `cd /opt/szignotes && sudo -u deploy git reset --hard <sha> && sudo systemctl restart szignotes`.
- **State snapshots** land in `/var/backups/szignotes/` before every deploy, last
  14 kept. They are still on the same disk, so keep netcup's backup option on and
  pull a copy off the box periodically.
- **`.pdf-cache/` survives deploys.** It only rebuilds if you delete it, which
  costs a burst of CPU as notes get recompiled on demand.
