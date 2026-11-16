#!/usr/bin/env bash
# Radxa Dragon Q6A (arm64, Ubuntu/Debian)용 설치 스크립트
#   sudo bash deploy/install.sh            # 처음 설치
#   sudo bash deploy/install.sh update     # 코드 업데이트 후 재시작
set -euo pipefail
REPO="${REPO:-https://github.com/nanjjang/SSSMS.git}"
BASE=/opt/sssms
APP=$BASE/app
NODE_MAJOR=22

[ "$(id -u)" = 0 ] || { echo "sudo로 실행하세요"; exit 1; }

if [ "${1:-}" = "update" ]; then
  sudo -u sssms git -C "$APP" pull --ff-only
  systemctl restart sssms
  systemctl --no-pager status sssms | head -5
  exit 0
fi

echo "== 1. 기본 패키지"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg

echo "== 2. Node.js $NODE_MAJOR (node:sqlite 내장 버전 필요: 22.5 이상)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 3. 전용 사용자와 폴더"
id sssms >/dev/null 2>&1 || useradd --system --home "$BASE" --shell /usr/sbin/nologin sssms
mkdir -p "$BASE/data" "$BASE/backups"
if [ ! -d "$APP/.git" ]; then git clone "$REPO" "$APP"; fi
mkdir -p "$APP/ml/data/liveness/real" "$APP/ml/data/liveness/spoof"
[ -f "$BASE/.env" ] || { cp "$APP/deploy/.env.example" "$BASE/.env"; chmod 600 "$BASE/.env"; echo "!! $BASE/.env 를 열어 비밀번호와 구글 클라이언트 ID를 채우세요"; }
chown -R sssms:sssms "$BASE"

echo "== 4. systemd 서비스"
cp "$APP/deploy/sssms.service" /etc/systemd/system/sssms.service
systemctl daemon-reload
systemctl enable --now sssms
sleep 2
curl -fsS -o /dev/null -w "로컬 응답: %{http_code}\n" http://127.0.0.1:3000/student/ || echo "서버가 아직 안 떴어요: journalctl -u sssms -n 50"

echo "== 5. 매일 23:30 DB 백업"
cat >/etc/cron.d/sssms-backup <<EOF
30 23 * * * sssms SSSMS_DB=$BASE/data/sssms.db BACKUP_DIR=$BASE/backups $APP/deploy/backup.sh >> $BASE/backups/backup.log 2>&1
EOF

echo "== 6. cloudflared"
if ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -y && apt-get install -y cloudflared
fi
cloudflared --version

cat <<'MSG'

설치 완료. 남은 단계 (deploy/README.md 3단계 참고):
  1) sudo nano /opt/sssms/.env           비밀번호·구글 ID 입력 후  sudo systemctl restart sssms
  2) cloudflared tunnel login             브라우저에서 도메인 선택
  3) cloudflared tunnel create sssms
  4) cloudflared tunnel route dns sssms <도메인>
  5) /etc/cloudflared/config.yml 작성 (deploy/cloudflared-config.yml 참고)
  6) sudo cloudflared service install && sudo systemctl enable --now cloudflared
MSG
