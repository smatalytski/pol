#!/usr/bin/env bash
set -euo pipefail

DB="${FISZKI_DB:-data/fiszki.db}"
DEST="${1:-backups}"
mkdir -p "$DEST"
OUT="$DEST/fiszki-$(date +%Y-%m-%d-%H%M).db"

# VACUUM INTO, not cp: it takes a consistent snapshot while the app is running.
# A file copy of a live WAL database can capture a torn state.
sqlite3 "$DB" "VACUUM INTO '$OUT'"

# Offsite, or it is not a backup. A snapshot on the same disk as the database
# survives a corrupt write and nothing else — not a deleted VM, not a lost disk.
# FISZKI_BACKUP_BUCKET unset means local-only, which is correct for a dev box
# and wrong for the VM; the systemd unit always sets it.
if [[ -n "${FISZKI_BACKUP_BUCKET:-}" ]]; then
  # Only delete the local snapshot once it is confirmed safe in the bucket.
  # `set -e` would already abort the script on a failed `gcloud storage cp`,
  # but that guard is easy to lose (a future `|| true`, a pipeline, a
  # subshell); the explicit check keeps the invariant load-bearing on its own
  # rather than resting on script-wide flags someone might change later. A
  # broken upload must leave the only copy on disk, not delete it.
  if gcloud storage cp "$OUT" "gs://${FISZKI_BACKUP_BUCKET}/$(basename "$OUT")"; then
    rm -f "$OUT"
    echo "gs://${FISZKI_BACKUP_BUCKET}/$(basename "$OUT")"
  else
    echo "backup upload failed; local snapshot kept at $OUT" >&2
    exit 1
  fi
else
  echo "$OUT"
fi
