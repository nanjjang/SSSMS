# 모바일 앱 (iOS · Android)

[Capacitor](https://capacitorjs.com) 로 웹 화면을 감싼 앱 2개입니다. 관리자는 웹만 씁니다.

| 앱 | 폴더 | appId | 로드하는 화면 |
|---|---|---|---|
| 학생 앱 | `student/` | `kr.hs.sunrint.yaja` | `<서버>/student/` |
| 키오스크 앱 | `kiosk/` | `kr.hs.sunrint.yaja.kiosk` | `<서버>/kiosk/` |

앱은 **서버 주소를 그대로 불러오는 방식**입니다. 화면·기능을 고쳐 서버에 배포하면 앱 재배포 없이 바로 반영됩니다.
인터넷이 안 될 때는 `www/index.html` 의 재시도 화면이 나옵니다.

## 빌드
서버 주소를 환경변수로 넣고 동기화한 뒤 Xcode / Android Studio 를 엽니다. (앱마다 한 번씩)

```bash
cd mobile/student            # 또는 mobile/kiosk
npm install
SSSMS_SERVER_URL=https://야자실.도메인 npx cap sync
npx cap open ios             # Xcode  → 서명(Team) 선택 후 실행
npx cap open android         # Android Studio → 실행
```

- iOS 는 Xcode, Android 는 Android Studio(SDK 포함)가 필요합니다.
- 터미널에서 Android 를 빌드하려면 JDK 21(JDK 25 는 Gradle 이 못 읽음)과 `ANDROID_HOME` 이 필요합니다: `JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ./gradlew assembleDebug` (`android/` 안에서)
- 주소가 `http://` 이면 cleartext 가 자동으로 켜집니다. 운영은 `https://` 를 쓰세요(카메라도 HTTPS 필요).

## 학생 앱 — 구글 로그인
WebView 에서는 구글 웹 로그인이 막혀 앱에서는 네이티브 로그인(`@capgo/capacitor-social-login`)을 씁니다. 서버는 기존 `/api/auth/google` 을 그대로 씁니다.

1. Google Cloud Console 에서 **iOS OAuth 클라이언트**(번들 ID `kr.hs.sunrint.yaja`)와 **Android OAuth 클라이언트**(패키지명 `kr.hs.sunrint.yaja` + 서명 SHA-1)를 추가로 만듭니다. 기존 웹 클라이언트 ID 는 그대로 `GOOGLE_CLIENT_ID` 입니다.
2. 서버에 iOS 클라이언트 ID 를 알려줍니다: `GOOGLE_IOS_CLIENT_ID=xxxx.apps.googleusercontent.com`
3. iOS: Xcode → App → Info → URL Types 에 iOS 클라이언트 ID 의 **reversed client ID**(`com.googleusercontent.apps.xxxx`)를 URL Scheme 으로 추가합니다.

> 구글 로그인은 실제 OAuth 설정이 있어야 동작해서 아직 실기기에서 확인하지 못했습니다.

## 키오스크 앱
- 카메라 권한(Android `CAMERA`, iOS `NSCameraUsageDescription`)이 들어 있고, 앱을 처음 켤 때 허용하면 됩니다.
- 실행 중 화면이 꺼지지 않습니다(`@capacitor-community/keep-awake`).
- 서버에 `KIOSK_ALLOWED_IPS` 를 설정했다면 태블릿이 학교 Wi-Fi 에 연결돼 있어야 합니다.

## 참고
- iOS App Store 심사는 "웹사이트를 그대로 감싼 앱"에 엄격합니다. 학생 앱을 스토어에 올릴 계획이면 푸시 알림 등 네이티브 기능을 더하는 편이 안전하고, 학교 내부 배포라면 TestFlight / Apple Business(School) Manager 나 Android APK 직접 설치도 가능합니다.
- 앱 아이콘·스플래시는 기본 Capacitor 이미지입니다. `ios/App/App/Assets.xcassets`, `android/app/src/main/res` 에서 학교 로고로 바꾸세요.
