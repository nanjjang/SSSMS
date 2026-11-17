#!/usr/bin/env bash
# Radxa Dragon Q6A (arm64, Ubuntu/Debian)용 설치 스크립트
#   sudo bash deploy/install.sh            # 처음 설치
#   sudo bash deploy/install.sh update     # 코드 업데이트 후 재시작
set -euo pipefail
REPO="${REPO:-https://github.com/nanjjang/SSSMS.git}"
BASE=/opt/sssms
APP=$BASE/app
NODE_MAJOR=22
NODE_MIN_MINOR=5
NODESOURCE_KEY_URL=https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
NODESOURCE_KEY_FINGERPRINT=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
CLOUDFLARE_KEY_URL=https://pkg.cloudflare.com/cloudflare-main.gpg
CLOUDFLARE_KEY_FINGERPRINT=8E5F9A5D3A8F870C9A3D8C3D254B391D8CACCBF8
KEY_WORKDIR=

cleanup_key_workdir() {
  if [ -n "$KEY_WORKDIR" ]; then rm -rf -- "$KEY_WORKDIR"; fi
}
trap cleanup_key_workdir EXIT

# HTTPS로 받은 키가 저장소에서 검토한 단 하나의 기본 키인지 확인한 뒤에만 apt에 맡긴다.
install_repository_key() {
  local name=$1 url=$2 expected=$3 destination=$4
  local downloaded gpg_home exported actual
  if [ -z "$KEY_WORKDIR" ]; then KEY_WORKDIR="$(mktemp -d)"; fi
  downloaded="$KEY_WORKDIR/$name.download"
  gpg_home="$KEY_WORKDIR/$name-gnupg"
  exported="$KEY_WORKDIR/$name.gpg"
  mkdir --mode=0700 "$gpg_home"

  curl --proto '=https' --tlsv1.2 -fsSL "$url" --output "$downloaded"
  gpg --batch --quiet --homedir "$gpg_home" --import-options import-minimal --import "$downloaded"
  actual="$(
    gpg --batch --homedir "$gpg_home" --with-colons --list-keys |
      awk -F: '$1 == "pub" { primary = 1; next } primary && $1 == "fpr" { print toupper($10); primary = 0 }'
  )"
  if [ "$actual" != "$expected" ]; then
    echo "$name 저장소 키 지문이 일치하지 않습니다. 예상: $expected, 실제: ${actual:-없음}" >&2
    return 1
  fi

  gpg --batch --quiet --homedir "$gpg_home" --export "$expected" > "$exported"
  [ -s "$exported" ] || { echo "$name 저장소 키를 내보낼 수 없습니다" >&2; return 1; }
  install -m 0644 "$exported" "$destination"
}

node_version_supported() {
  command -v node >/dev/null && node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const [requiredMajor, requiredMinor] = process.argv.slice(1).map(Number);
    process.exit(major > requiredMajor || (major === requiredMajor && minor >= requiredMinor) ? 0 : 1);
  ' "$NODE_MAJOR" "$NODE_MIN_MINOR"
}

[ "$(id -u)" = 0 ] || { echo "sudo로 실행하세요"; exit 1; }

if [ "${1:-}" = "update" ]; then
  sudo -u sssms git -C "$APP" pull --ff-only
  # 서비스 설정(UMask 등)과 데이터 폴더 권한도 최신으로 맞춘다
  cp "$APP/deploy/sssms.service" /etc/systemd/system/sssms.service
  systemctl daemon-reload
  chmod 700 "$BASE/data" "$BASE/backups"
  chmod -R go-rwx "$BASE/data" "$BASE/backups"
  [ -d "$APP/ml/data" ] && chmod -R go-rwx "$APP/ml/data"
  systemctl restart sssms
  systemctl --no-pager status sssms | head -5
  exit 0
fi

echo "== 1. 기본 패키지"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg

echo "== 2. Node.js $NODE_MAJOR (node:sqlite 내장 버전 필요: 22.5 이상)"
if ! node_version_supported; then
  mkdir -p --mode=0755 /usr/share/keyrings
  install_repository_key nodesource "$NODESOURCE_KEY_URL" "$NODESOURCE_KEY_FINGERPRINT" /usr/share/keyrings/nodesource.gpg
  ARCH="$(dpkg --print-architecture)"
  echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
node_version_supported || { echo "Node.js $NODE_MAJOR.$NODE_MIN_MINOR 이상이 필요합니다" >&2; exit 1; }
node -v

echo "== 3. 전용 사용자와 폴더"
id sssms >/dev/null 2>&1 || useradd --system --home "$BASE" --shell /usr/sbin/nologin sssms
mkdir -p "$BASE/data" "$BASE/backups"
if [ ! -d "$APP/.git" ]; then git clone "$REPO" "$APP"; fi
mkdir -p "$APP/ml/data/liveness/real" "$APP/ml/data/liveness/spoof"
[ -f "$BASE/.env" ] || { cp "$APP/deploy/.env.example" "$BASE/.env"; chmod 600 "$BASE/.env"; echo "!! $BASE/.env 를 열어 비밀번호와 구글 클라이언트 ID를 채우세요"; }
chown -R sssms:sssms "$BASE"
# 데이터·백업·학습용 얼굴 사진 폴더는 서비스 계정만 접근 (기존 설치의 파일 권한도 함께 바로잡음)
chmod 700 "$BASE/data" "$BASE/backups" "$APP/ml/data"
chmod -R go-rwx "$BASE/data" "$BASE/backups" "$APP/ml/data"

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
  install_repository_key cloudflare "$CLOUDFLARE_KEY_URL" "$CLOUDFLARE_KEY_FINGERPRINT" /usr/share/keyrings/cloudflare-main.gpg
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
