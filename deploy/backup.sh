#!/usr/bin/env bash
# SQLite 온라인 백업 (서비스를 멈추지 않고 일관된 스냅샷을 만든다) + 14일 지난 백업 삭제
# cron 예: 30 23 * * * /opt/sssms/app/deploy/backup.sh   (매일 23:30, 야자 마감 직후)
set -euo pipefail
# 백업에는 학생 개인정보·얼굴 특징값·비밀번호 해시가 들어 있으므로 서비스 계정만 읽을 수 있게
umask 077
DB="${SSSMS_DB:-/opt/sssms/data/sssms.db}"
DIR="${BACKUP_DIR:-/opt/sssms/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DIR"
OUT="$DIR/sssms-$(date +%Y%m%d-%H%M).db"
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
db.exec(`VACUUM INTO ${JSON.stringify(process.argv[2]).replace(/"/g, "\x27")}`);
' "$DB" "$OUT"
gzip -f "$OUT"
find "$DIR" -name 'sssms-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup: $OUT.gz"
