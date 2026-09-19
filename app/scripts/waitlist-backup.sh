#!/bin/zsh
# Off-Vercel backup of the waitlist. Downloads the full export and keeps dated copies.
# Installed to ~/Library/Application Support/ProofOfAgent and run daily by launchd
# (dev.proofofagent.waitlist-backup). macOS blocks background jobs from Desktop, Documents and
# iCloud Drive, so the primary copy lives in Application Support; the others are best effort.
set -euo pipefail

APP_DIR="${0:A:h:h}"
KEY="$(security find-generic-password -a proofofagent -s WAITLIST_ADMIN_KEY -w 2>/dev/null || grep '^WAITLIST_ADMIN_KEY=' "$APP_DIR/.env.local" 2>/dev/null | cut -d= -f2)"
[ -n "$KEY" ] || { echo "no WAITLIST_ADMIN_KEY in Keychain or .env.local" >&2; exit 1; }

PRIMARY="$HOME/Library/Application Support/ProofOfAgent/backups/waitlist"
LOCAL="$HOME/Documents/ProofOfAgent-backups/waitlist"
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs/ProofOfAgent-backups/waitlist"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsS --max-time 120 "https://proofofagent.dev/api/waitlist?key=$KEY" -o "$TMP"
head -1 "$TMP" | grep -q '^submittedAt,name,email' || { echo "unexpected export format" >&2; exit 1; }
ROWS=$(( $(wc -l < "$TMP") ))   # header has no trailing newline, so lines == entries

backup_to() {
  local DIR="$1"
  mkdir -p "$DIR" && chmod 700 "$DIR" || return 1
  PREV=0; [ -f "$DIR/latest.csv" ] && PREV=$(( $(wc -l < "$DIR/latest.csv") ))
  if [ "$ROWS" -lt "$PREV" ]; then
    echo "$(date -u +%FT%TZ) WARNING: export has $ROWS entries, previous backup had $PREV; keeping both" >> "$DIR/backup.log"
  else
    cp "$TMP" "$DIR/latest.csv"
  fi
  cp "$TMP" "$DIR/waitlist-$STAMP.csv"
  chmod 600 "$DIR"/*.csv
  ls -t "$DIR"/waitlist-*.csv | tail -n +91 | xargs -I{} rm -f {}   # keep the newest 90
  echo "$(date -u +%FT%TZ) ok: $ROWS entries -> waitlist-$STAMP.csv" >> "$DIR/backup.log"
}

backup_to "$PRIMARY"                                   # must succeed
DONE="primary"
for EXTRA in "$LOCAL" "$ICLOUD"; do
  [ -d "${EXTRA:h:h}" ] || continue
  if ( backup_to "$EXTRA" ) 2>/dev/null; then DONE="$DONE, ${EXTRA:h:h:t}"; fi
done
echo "$(date -u +%FT%TZ) backed up $ROWS entries ($DONE)"
