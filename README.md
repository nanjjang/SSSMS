# 선린인터넷고 야간자율학습실 관리 시스템 (SSSMS)

| 화면 | 주소 | 대상 |
|---|---|---|
| 학생 모바일 웹 | `/student/` | 학교 구글 계정 로그인 → 학번·이름·지정석 자동 연동, 공부시간/스트릭/히트맵, 공석 확인, 문의·분실 게시판, 공지 |
| 관리자 웹 | `/admin/` | 좌석 배치 편집·지정석 부여, 출석 현황, 학생 명단·얼굴 등록, 블랙리스트, 퇴출 후보, 게시판 답변, 공지, 분실물 보관함 |
| 출석 키오스크 | `/kiosk/` | 얼굴 인식 + 라이브니스로 입실/퇴실, 실시간 좌석 맵에서 자율석 선택 |

설계·분석 내용은 [docs/ANALYSIS.md](docs/ANALYSIS.md)를 참고하세요.

## 실행
Node.js 22.5 이상이 필요합니다. 외부 npm 패키지는 쓰지 않습니다.

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com SCHOOL_DOMAIN=sunrint.hs.kr npm start
```

- 학교 로고 파일은 `public/assets/logo.svg`에 두세요.
- 구글 로그인 설정: Google Cloud Console → OAuth 클라이언트 ID(웹)를 만들고, 승인된 JavaScript 원본에 서비스 주소를 넣으세요.
  - `GOOGLE_CLIENT_ID`가 없으면 개발용 학번·비밀번호 로그인으로 대체됩니다.
  - `ALLOW_PASSWORD_LOGIN=1`로 두면 구글 로그인과 학번·비밀번호 로그인을 함께 쓸 수 있습니다.
- 학번 연동 방식: 구글 계정의 표시 이름이나 이메일 아이디에서 5자리 학번을 찾습니다. 찾지 못하면 학생이 처음 한 번만 학번을 입력합니다.
- 운영 순서: 관리자 → 학생 명단 일괄 등록(학번, 이름) → 좌석 배치에서 지정석 부여 → 얼굴 등록.
- 관리자 구글 계정은 설정의 `관리자 구글 계정` 항목에 넣으세요.
- 초기 계정 (첫 실행 때 시드로 생성):
  - 관리자: `admin` / `admin1234`
  - 키오스크: `kiosk` / `kiosk1234`
  - 운영 전에 반드시 비밀번호를 바꾸세요.
- 카메라는 HTTPS 또는 localhost에서만 작동합니다.

## 테스트
```bash
npm test
```

## 배포
Radxa Dragon Q6A + Cloudflare Tunnel 배포 방법은 [deploy/README.md](deploy/README.md)를 참고하세요. `sudo bash deploy/install.sh` 한 번으로 Node.js, systemd 서비스, 백업, cloudflared까지 설치됩니다.

## 얼굴 인식 · 라이브니스 모델
직접 학습시키는 모델과 학습 방법은 [ml/README.md](ml/README.md)를 참고하세요.
