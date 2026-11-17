# 배포 가이드: Radxa Dragon Q6A + Cloudflare Tunnel

```
학생 휴대폰 · 관리자 PC · 키오스크 태블릿
          │  https://<도메인>  (Cloudflare가 HTTPS 인증서 자동 처리)
          ▼
   Cloudflare 네트워크
          │  아웃바운드 터널 (학교 공유기 포트 개방 불필요)
          ▼
   Q6A: cloudflared ──▶ 127.0.0.1:3000  Node.js (SSSMS) ── SQLite /opt/sssms/data
```

- 비용: Q6A 전기료 외 0원. Cloudflare Tunnel은 무료입니다. 단, **고정 주소를 쓰려면 Cloudflare에 연결된 도메인이 하나 필요**합니다(연 1만~2만 원대). 도메인 없이 `cloudflared tunnel --url`(quick tunnel)로도 열 수 있지만 재시작할 때마다 주소가 바뀌어 구글 로그인·키오스크 주소 등록이 깨집니다.
- 카메라(키오스크)와 구글 로그인은 HTTPS가 필수인데, Cloudflare가 자동으로 처리합니다.
- 서버는 `127.0.0.1`에만 열려 있어 외부에서는 터널로만 접속할 수 있습니다.

## 1. Q6A 준비
- Radxa 공식 Ubuntu(arm64) 이미지를 설치하고 유선 LAN에 연결합니다(무선보다 안정적).
- 시간대: `sudo timedatectl set-timezone Asia/Seoul`
- 정전 후 자동 복구가 되도록 전원이 들어오면 자동 부팅되는지 확인합니다.

## 2. 설치 (한 번에)
```bash
git clone https://github.com/nanjjang/SSSMS.git ~/SSSMS
sudo bash ~/SSSMS/deploy/install.sh
```
스크립트가 하는 일: Node.js 22 설치, `sssms` 전용 사용자 생성, `/opt/sssms/app`에 코드 배치, systemd 서비스 등록·자동 시작, 매일 23:30 DB 백업 cron, cloudflared 설치.

그다음 환경 변수를 채웁니다.
```bash
sudo nano /opt/sssms/.env
```
- `ADMIN_PASSWORD`, `KIOSK_PASSWORD`: **첫 실행 전에** 바꾸세요(첫 실행 때 계정이 만들어짐). 초기값(`change-me-…`, `admin1234`, `kiosk1234`)으로는 외부(터널)에서 로그인할 수 없습니다.
  이미 실행했다면 관리자 → 설정에서 바꾸거나, Q6A에서 아래 명령으로 재설정하세요(데이터는 그대로, 해당 계정의 기존 로그인은 모두 끊김).
  ```bash
  sudo -u sssms SSSMS_DB=/opt/sssms/data/sssms.db node --no-warnings /opt/sssms/app/server/passwd.js admin   # 또는 kiosk
  ```
- `KIOSK_ALLOWED_IPS`: 학교 공인 IP(학교 와이파이에서 "내 IP" 검색)를 넣으면 키오스크 계정을 학교 안에서만 쓸 수 있습니다. **대리 출석 방지에 가장 효과적인 설정**이니 꼭 넣으세요.
- `GOOGLE_CLIENT_ID`: 4단계 참고
```bash
sudo systemctl restart sssms
```

## 3. Cloudflare Tunnel 연결
1. [Cloudflare](https://dash.cloudflare.com)에 가입하고 도메인을 추가합니다(네임서버를 Cloudflare로 변경).
2. Q6A에서:
```bash
cloudflared tunnel login                          # 표시되는 링크를 PC 브라우저로 열어 도메인 선택
cloudflared tunnel create sssms                   # TUNNEL_ID와 ~/.cloudflared/<ID>.json 생성
cloudflared tunnel route dns sssms yaja.<도메인>   # DNS 레코드 자동 생성
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/
sudo cp /opt/sssms/app/deploy/cloudflared-config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml             # <TUNNEL_ID>, <도메인> 바꾸기
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```
3. `https://yaja.<도메인>/student/` 이 열리면 성공입니다.

## 4. 학교 구글 로그인 연결
[Google Cloud Console](https://console.cloud.google.com) → API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션)
- 승인된 JavaScript 원본: `https://yaja.<도메인>`
- 발급된 클라이언트 ID를 `.env`의 `GOOGLE_CLIENT_ID`에 넣고 `sudo systemctl restart sssms`
- 학교 Google Workspace 관리자에게 외부 앱 허용이 필요할 수 있습니다.

## 5. 키오스크 태블릿
- 크롬에서 `https://yaja.<도메인>/kiosk/` 접속 → 키오스크 계정으로 1회 로그인 → 카메라 권한 허용
- 안드로이드: 화면 고정(앱 고정) 또는 키오스크 브라우저 앱, 화면 꺼짐 방지, 충전기 연결
- 처음 접속 때 얼굴 인식 모델(Human.js, 자체 ONNX 모델)을 내려받으니 학교 와이파이에서 1~2분 기다리세요.

## 6. 운영
| 할 일 | 명령 |
|---|---|
| 상태 확인 | `systemctl status sssms cloudflared` |
| 로그 보기 | `journalctl -u sssms -f` |
| 코드 업데이트 | `sudo bash /opt/sssms/app/deploy/install.sh update` |
| 수동 백업 | `sudo -u sssms /opt/sssms/app/deploy/backup.sh` |
| 백업 복원 | `sudo systemctl stop sssms && gunzip -c /opt/sssms/backups/<파일>.db.gz > /opt/sssms/data/sssms.db && sudo chown sssms: /opt/sssms/data/sssms.db && sudo systemctl start sssms` |

- 백업은 `/opt/sssms/backups`에 14일치가 남습니다. 가끔 USB나 다른 PC로 복사해 두세요.
- AI 학습 데이터(관리자 → AI 학습 데이터)는 `/opt/sssms/app/ml/data/liveness`에 쌓입니다. 학습은 Q6A가 아니라 GPU가 있는 PC(맥 등)에서 하고, 결과 `public/models/*.onnx`를 커밋한 뒤 Q6A에서 업데이트하세요.

## 보안 체크리스트
- [ ] `.env`의 관리자·키오스크 비밀번호 변경 (`chmod 600` 유지)
- [ ] `.env`의 `KIOSK_ALLOWED_IPS`에 학교 공인 IP 입력 (학교 밖에서 키오스크 계정으로 출석 처리하는 것 차단)
- [ ] 키오스크 태블릿은 화면 고정(앱 고정)으로 주소창·개발자 도구·다른 앱을 못 쓰게 하고, 감독 선생님 눈에 보이는 곳에 설치
- [ ] 키오스크 기기를 잃어버렸거나 비밀번호가 알려졌다면 관리자 → 설정 → 키오스크 비밀번호 변경(모든 키오스크가 즉시 로그아웃됨)
- [ ] Cloudflare 대시보드 → Security → WAF에서 `/api/login`에 Rate limiting 규칙 추가(무료 플랜 1개 가능)
- [ ] 관리자 페이지 추가 보호가 필요하면 Cloudflare Zero Trust Access로 `/admin/*`에 학교 계정 로그인 걸기(50명까지 무료)
- [ ] Q6A SSH는 비밀번호 대신 키 로그인, 기본 계정 비밀번호 변경
