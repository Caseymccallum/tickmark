#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${TICKMARK_APP_DIR:-/opt/tickmark}
SERVICE=${TICKMARK_SERVICE_NAME:-tickmark.service}
ENV_FILE=${TICKMARK_BACKUP_ENV_FILE:-/etc/tickmark/backup.env}
DATA=${TICKMARK_DATA:-/var/lib/tickmark}
STAGING=${TICKMARK_BACKUP_STAGING:-/var/lib/tickmark/backup-staging}
LOCK=/run/lock/tickmark-hosted-operations.lock

if [[ ! -r "$ENV_FILE" ]]; then
  echo '{"level":"error","event":"backup.failed","reason":"backup environment file is not readable"}' >&2
  exit 1
fi
set -a
. "$ENV_FILE"
set +a

exec 9>"$LOCK"
if ! flock -n 9; then
  echo '{"level":"error","event":"maintenance.locked","reason":"another hosted operation holds the lock"}' >&2
  exit 75
fi

was_active=0
if systemctl is-active --quiet "$SERVICE"; then was_active=1; fi
restart_service() {
  if [[ "$was_active" == 1 ]]; then systemctl start "$SERVICE"; fi
}
trap restart_service EXIT

if [[ "$was_active" == 1 ]]; then systemctl stop "$SERVICE"; fi

export TICKMARK_DATA="$DATA"
export TICKMARK_BACKUP_STAGING="$STAGING"
export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$DATA/restic-cache}
runuser --preserve-environment -u tickmark -- node "$APP_DIR/tools/hosted-backup.mjs"
