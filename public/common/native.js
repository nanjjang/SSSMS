// 학생·키오스크 앱(Capacitor)에서만 쓰는 네이티브 연동. 일반 웹 브라우저에서는 모두 no-op.
export const isNative = () => !!window.Capacitor?.isNativePlatform?.();
const plugin = (name) => window.Capacitor?.Plugins?.[name];

let socialReady = false;
/** 네이티브 구글 로그인 → ID 토큰. (WebView 안에서는 구글이 웹 로그인을 막기 때문에 앱은 네이티브 SDK를 쓴다) */
export async function nativeGoogleIdToken(cfg) {
  const SocialLogin = plugin('SocialLogin');
  if (!SocialLogin) throw new Error('앱에서 구글 로그인을 사용할 수 없어요');
  if (!socialReady) {
    // webClientId: 서버가 검증하는 웹 클라이언트 ID. 이 값을 서버 클라이언트로 지정해야 토큰의 aud 가 서버 설정과 일치한다.
    await SocialLogin.initialize({
      google: { webClientId: cfg.google_client_id, iOSClientId: cfg.google_ios_client_id || undefined, iOSServerClientId: cfg.google_client_id, mode: 'online' },
    });
    socialReady = true;
  }
  const r = await SocialLogin.login({ provider: 'google', options: { scopes: ['email', 'profile'] } });
  const token = r?.result?.idToken;
  if (!token) throw new Error('구글 인증 정보를 받지 못했어요');
  return token;
}
export async function nativeGoogleSignOut() {
  try { await plugin('SocialLogin')?.logout({ provider: 'google' }); } catch {}
}

/** 키오스크: 화면이 꺼지지 않게 유지 */
export async function keepScreenOn() {
  try { await plugin('KeepAwake')?.keepAwake(); } catch {}
}
