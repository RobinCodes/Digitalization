#!/usr/bin/env bash
#
# Deploy script — lives at /usr/local/bin/szignotes-deploy on the server,
# deliberately OUTSIDE the repo so a git reset cannot rewrite it while bash
# is still reading it.
#
# Install:
#   sudo install -m 755 Deploy/szignotes-deploy.sh /usr/local/bin/szignotes-deploy
#
# Re-run that after changing this file — the server copy is a copy, not a link.

set -euo pipefail

REPO=/opt/szignotes
BRANCH=main
SERVICE=szignotes
BACKUP_DIR=/var/backups/szignotes
KEEP=14

log() { printf '[deploy] %s\n' "$*"; }

cd "$REPO"

# ── Guard ────────────────────────────────────────────────────────────────────
# This whole design rests on one fact: every runtime state file is untracked,
# so `git reset --hard` cannot touch it. If someone ever commits one of them,
# that stops being true and a deploy would overwrite live user data. Check.
for f in Website/users.json Website/admins.json Website/days.json Website/timetable.json; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    log "REFUSING TO DEPLOY: $f is tracked in git."
    log "A reset would overwrite live state. Remove it from the index first:"
    log "  git rm --cached $f && git commit"
    exit 1
  fi
done

# ── Snapshot state before touching anything ──────────────────────────────────
# Cheap insurance, and not subject to the app's own EXPORT_MAX_BYTES ceiling.
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
(
  cd "$REPO/Website"
  shopt -s nullglob
  items=( *.json )
  [[ -d Uploads ]] && items+=( Uploads )
  if (( ${#items[@]} )); then
    tar -czf "$BACKUP_DIR/state-$STAMP.tar.gz" "${items[@]}"
    log "state snapshot → $BACKUP_DIR/state-$STAMP.tar.gz"
  else
    log "no state to snapshot yet (first deploy)"
  fi
)

# Prune old snapshots, keep the most recent $KEEP.
ls -1t "$BACKUP_DIR"/state-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

# ── Update tracked files ─────────────────────────────────────────────────────
PREV=$(git rev-parse --short HEAD)
git fetch --prune origin
git reset --hard "origin/$BRANCH"
NOW=$(git rev-parse --short HEAD)

# NOTE: `git clean` is deliberately never run here. Untracked files in
# Website/ ARE the live state — the JSON stores, Uploads/ and .pdf-cache/.
# `git clean -fdx` would destroy every account, day log and attachment.

if [[ "$PREV" == "$NOW" ]]; then
  log "already at $NOW — restarting anyway to pick up any manual changes"
else
  log "$PREV → $NOW"
  git --no-pager log --oneline "$PREV..$NOW" | sed 's/^/[deploy]   /'
fi

# ── Restart ──────────────────────────────────────────────────────────────────
# Sessions live in memory, so this signs everyone out. That is expected.
sudo -n /bin/systemctl restart "$SERVICE"
sleep 2
sudo -n /bin/systemctl is-active --quiet "$SERVICE" \
  && log "$SERVICE is up" \
  || { log "$SERVICE FAILED to come up — journalctl -u $SERVICE -n 50"; exit 1; }
