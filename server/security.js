// 요청 출처 판별 · 로그인 시도 제한 · 키오스크 접속 위치 제한
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress);

/** 이 컴퓨터에서 직접 접속한 요청 (Cloudflare 터널·프록시 경유 요청은 제외) */
export const isLocalDirect = (req) => isLoopback(req) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];

/**
 * 실제 접속자 IP. 터널(cloudflared)·리버스 프록시는 이 컴퓨터에서 접속하므로
 * 소켓이 루프백일 때만 프록시 헤더를 믿는다 (직접 접속한 사용자가 헤더를 위조해도 무시됨).
 */
export function clientIp(req) {
  const sock = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!isLoopback(req)) return sock;
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || sock; // 가장 가까운 프록시가 덧붙인 값
}

/** 개발용 API: 로컬 직접 접속 + Host/Origin 도 localhost 여야 함 (다른 웹사이트·DNS 리바인딩을 통한 호출 차단) */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function isLocalDev(req) {
  const origin = req.headers.origin;
  return isLocalDirect(req) && LOCAL_HOST.test(req.headers.host || '') && (!origin || LOCAL_HOST.test(String(origin).replace(/^https?:\/\//, '')));
}

// ---------- 실패 횟수 제한 (메모리, 10분 창) ----------
const WINDOW = 10 * 60000;
const hits = new Map(); // key -> { n, until }
export const tooMany = (key, max) => { const e = hits.get(key); return !!e && e.until > Date.now() && e.n >= max; };
export function countFail(key) {
  const now = Date.now(); const e = hits.get(key);
  if (!e || e.until <= now) hits.set(key, { n: 1, until: now + WINDOW }); else e.n++;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.until <= now) hits.delete(k); }, 60000).unref();

// ---------- 구글 인증 동시 작업 제한 ----------
const GOOGLE_VERIFY_MAX_GLOBAL = 32;
const GOOGLE_VERIFY_MAX_PER_IP = 8;
let googleVerifyTotal = 0;
const googleVerifyByIp = new Map();

/** 동시 검증 자리를 예약하고, 성공하면 한 번만 호출할 해제 함수를 돌려준다. */
export function reserveGoogleVerification(ip) {
  ip = String(ip);
  const perIp = googleVerifyByIp.get(ip) || 0;
  if (googleVerifyTotal >= GOOGLE_VERIFY_MAX_GLOBAL || perIp >= GOOGLE_VERIFY_MAX_PER_IP) return null;
  googleVerifyTotal++;
  googleVerifyByIp.set(ip, perIp + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    googleVerifyTotal--;
    const remaining = (googleVerifyByIp.get(ip) || 1) - 1;
    if (remaining) googleVerifyByIp.set(ip, remaining); else googleVerifyByIp.delete(ip);
  };
}

// ---------- 키오스크 접속 위치 제한 ----------
// KIOSK_ALLOWED_IPS=203.0.113.7,198.51.100.0/24 처럼 학교 공인 IP를 적어 두면
// 키오스크 계정은 그 IP(와 서버 컴퓨터 자체)에서만 쓸 수 있다 → 비밀번호·토큰이 새도 학교 밖에서 출석 처리 불가.
const KIOSK_IPS = (process.env.KIOSK_ALLOWED_IPS || '').split(/[,\s]+/).filter(Boolean);
const v4 = (ip) => { const p = String(ip).split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null; };
function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/'); const a = v4(ip), b = v4(base), n = Number(bits);
  if (a == null || b == null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
export function kioskIpAllowed(req) {
  if (!KIOSK_IPS.length || isLocalDirect(req)) return true;
  const ip = clientIp(req);
  return KIOSK_IPS.some((r) => (r.includes('/') ? inCidr(ip, r) : r === ip));
}
export const kioskIpRestricted = KIOSK_IPS.length > 0;
