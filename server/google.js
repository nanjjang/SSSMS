// Google 학교 계정 로그인 (Google Identity Services ID token)
// - 프런트: GIS 버튼 → ID 토큰(JWT) 수신 → POST /api/auth/google
// - 서버: Google tokeninfo 엔드포인트로 서명/만료 검증 후 aud(클라이언트ID)·hd(학교 도메인)·email_verified 확인
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const SCHOOL_DOMAIN = process.env.SCHOOL_DOMAIN || 'sunrint.hs.kr';

export async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) throw Object.assign(new Error('GOOGLE_CLIENT_ID가 설정되지 않았습니다'), { status: 503 });
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) throw Object.assign(new Error('구글 인증에 실패했습니다'), { status: 401 });
  const p = await r.json();
  if (p.aud !== GOOGLE_CLIENT_ID) throw Object.assign(new Error('잘못된 클라이언트'), { status: 401 });
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) throw Object.assign(new Error('잘못된 발급자'), { status: 401 });
  if (String(p.email_verified) !== 'true') throw Object.assign(new Error('이메일 인증이 필요한 계정입니다'), { status: 401 });
  // 학교 Google Workspace 계정만 허용: hd(조직 도메인)와 이메일 도메인이 모두 학교 도메인이어야 한다
  // (둘 중 하나만 보면 학교 주소로 만든 개인 구글 계정이나 다른 조직 계정이 통과할 수 있음)
  const domain = String(p.email).split('@')[1]?.toLowerCase();
  const school = SCHOOL_DOMAIN.toLowerCase();
  if (String(p.hd || '').toLowerCase() !== school || domain !== school) throw Object.assign(new Error(`학교 계정(@${SCHOOL_DOMAIN})으로 로그인해주세요`), { status: 403 });
  if (!p.sub) throw Object.assign(new Error('구글 인증에 실패했습니다'), { status: 401 });
  return { sub: p.sub, email: String(p.email).toLowerCase(), name: p.name || '', given: p.given_name || '', family: p.family_name || '' };
}

/**
 * 명단 이름과 구글 계정 이름이 같은 사람인지 (한글이 있으면 한글만, 없으면 영문자만 비교).
 * 어느 한쪽이라도 비교할 글자가 없으면 false → 확인할 수 없는 경우는 연결하지 않는다.
 */
export function sameName(a, b) {
  const norm = (s) => { s = String(s || ''); return s.replace(/[^가-힣]/g, '') || s.toLowerCase().replace(/[^a-z]/g, ''); };
  const x = norm(a), y = norm(b);
  return !!x && x === y;
}

/**
 * 학교 구글 계정 프로필에서 학번·이름 추출.
 * 학교 계정은 보통 표시이름이 "20105 홍길동" / "홍길동(20105)" 형태이거나 이메일 아이디에 학번이 들어있음.
 * 학번: 5자리(학년1+반2+번호2). 추출 실패 시 null → 학생이 1회 직접 입력.
 */
export function parseStudentProfile({ name, given, family, email }) {
  const local = email.split('@')[0];
  const sources = [name, `${family}${given}`, given, family, local];
  let studentNo = null;
  for (const s of sources) { const m = /(?<!\d)([1-3](?:0[1-9]|1[0-9])(?:0[1-9]|[1-4][0-9]))(?!\d)/.exec(s || ''); if (m) { studentNo = m[1]; break; } }
  const korean = (s) => (s || '').replace(/[^가-힣]/g, '');
  const realName = korean(name) || korean(`${family}${given}`) || (name || '').replace(/[\d()\[\]_.\-]/g, '').trim() || null;
  const parsed = studentNo ? { grade: +studentNo[0], class_no: +studentNo.slice(1, 3), number: +studentNo.slice(3, 5) } : {};
  return { studentNo, name: realName, ...parsed };
}
