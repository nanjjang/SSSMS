process.env.TZ ||= 'Asia/Seoul';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { db, getSettings, hashPw, verifyPw, hashToken, DEFAULT_SETTINGS, WEAK_PASSWORDS } from './db.js';
import { toVec, bestMatch, similarity } from './face.js';
import { verifyGoogleIdToken, parseStudentProfile, sameName, GOOGLE_CLIENT_ID, SCHOOL_DOMAIN } from './google.js';
import { isLocalDirect, isLocalDev, clientIp, tooMany, countFail, reserveGoogleVerification, kioskIpAllowed, kioskIpRestricted } from './security.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 3000);
// Cloudflare Tunnel 배포 시 외부 직접 접속을 막기 위해 기본은 로컬호스트에만 바인딩 (LAN 공개가 필요하면 HOST=0.0.0.0)
const HOST = process.env.HOST || '127.0.0.1';
const DAY = 86400000;
const MAX_ACTIVE_TOKENS_PER_USER = 10;
const SUCCESSFUL_AUTH_LIMIT = 20;

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const startOfDay = (ms = Date.now()) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const publicUser = (u) => u && ({
  id: u.id, role: u.role, login_id: u.login_id, name: u.name, grade: u.grade, class_no: u.class_no, number: u.number,
  blacklisted: !!u.blacklisted, blacklist_reason: u.blacklist_reason, has_face: !!u.face, email: u.email || null,
});

async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 2e6) fail(413, '요청이 너무 큽니다'); chunks.push(c); }
  if (!chunks.length) return {};
  // JSON 요청만 받는다: 다른 웹사이트의 폼·단순 요청(text/plain)으로 이 서버 API를 호출하는 것을 막음
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) fail(415, 'JSON 요청만 받을 수 있습니다');
  let v; try { v = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, '잘못된 JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, '잘못된 요청');
  return v;
}

// 로그인 세션 유효 기간 (키오스크 기기는 만료 없이 두고, 비밀번호를 바꾸면 모두 로그아웃됨)
const TOKEN_TTL = { admin: 7 * DAY, student: 30 * DAY };
function pruneTokens(userId, keep) {
  db.prepare(`DELETE FROM tokens WHERE user_id=? AND token IN
    (SELECT token FROM tokens WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
    .run(userId, userId, keep);
}
for (const { user_id } of db.prepare('SELECT user_id FROM tokens GROUP BY user_id HAVING COUNT(*)>?').all(MAX_ACTIVE_TOKENS_PER_USER))
  pruneTokens(user_id, MAX_ACTIVE_TOKENS_PER_USER);
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');
function auth(req, roles) {
  const t = bearer(req);
  const row = t && db.prepare('SELECT u.*, t.created_at AS token_at FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?').get(hashToken(t));
  if (!row) fail(401, '로그인이 필요합니다');
  const ttl = TOKEN_TTL[row.role];
  if (ttl && Date.now() - row.token_at > ttl) { db.prepare('DELETE FROM tokens WHERE token=?').run(hashToken(t)); fail(401, '로그인이 만료되었습니다. 다시 로그인해주세요'); }
  if (row.role === 'kiosk' && !kioskIpAllowed(req)) fail(403, '허용된 장소에서만 키오스크를 사용할 수 있습니다');
  if (revokedGoogleAdmin(row)) fail(403, '관리자 권한이 해제된 계정입니다');
  if (roles && !roles.includes(row.role)) fail(403, '권한이 없습니다');
  return row;
}
// 설정의 '관리자 구글 계정'에서 빠진 이메일은 이미 로그인한 세션까지 바로 관리자 권한을 잃는다
const adminEmails = () => getSettings().admin_emails.split(/[,\s]+/).filter(Boolean).map((e) => e.toLowerCase());
const revokedGoogleAdmin = (u) => u.role === 'admin' && !!u.google_sub && !adminEmails().includes(String(u.email || '').toLowerCase());
setInterval(() => {
  for (const [role, ttl] of Object.entries(TOKEN_TTL))
    db.prepare('DELETE FROM tokens WHERE created_at<? AND user_id IN (SELECT id FROM users WHERE role=?)').run(Date.now() - ttl, role);
}, 3600000).unref();

function newPassword(pw) {
  pw = String(pw ?? '');
  if (pw.length < 8) fail(400, '비밀번호는 8자 이상이어야 합니다');
  if (WEAK_PASSWORDS.includes(pw)) fail(400, '초기 비밀번호와 다른 비밀번호를 써주세요');
  return pw;
}

// ---------- attendance logic ----------
function closeTimeFor(ms) {
  const [h, m] = getSettings().close_time.split(':').map(Number);
  const d = new Date(ms); d.setHours(h, m, 0, 0);
  if (d.getTime() < ms) d.setDate(d.getDate() + 1); // session started after close → next day close
  return d.getTime();
}
function autoCheckout() {
  const now = Date.now();
  for (const s of db.prepare('SELECT id, check_in FROM attendance WHERE check_out IS NULL').all()) {
    const close = closeTimeFor(s.check_in);
    if (now >= close) db.prepare('UPDATE attendance SET check_out=?, auto_out=1 WHERE id=?').run(close, s.id);
  }
}
setInterval(autoCheckout, 60000);

// 운영 시간(시작~종료) 안에서만 키오스크 입실을 받는다. 종료 뒤에 입실하면 다음 날 종료 시각까지 공부한 것으로 기록되기 때문.
// 자정을 넘기는 운영(예: 22:00~01:00)도 지원하고, 시작과 종료가 같으면 종일 운영으로 본다. 퇴실과 관리자 수동 입실은 제한하지 않는다.
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
function withinHours(ms = Date.now()) {
  const s = getSettings(); const o = toMin(s.open_time), c = toMin(s.close_time);
  if (o === c) return true;
  const d = new Date(ms); const t = d.getHours() * 60 + d.getMinutes();
  return o < c ? t >= o && t < c : t >= o || t < c; // 값이 잘못돼 NaN이면 모두 false → 입실 불가(안전한 쪽)
}
function requireHours() {
  const s = getSettings();
  if (!withinHours()) fail(403, `지금은 입실 시간이 아니에요 (${s.open_time} ~ ${s.close_time})`);
}

const openSession = (uid) => db.prepare('SELECT * FROM attendance WHERE user_id=? AND check_out IS NULL').get(uid);

function seatsWithStatus(viewerId) {
  const rows = db.prepare(`SELECT s.*, a.user_id AS occ_user, u.name AS assigned_name, a.check_in AS occ_since
    FROM seats s LEFT JOIN attendance a ON a.seat_id=s.id AND a.check_out IS NULL
    LEFT JOIN users u ON u.id=s.assigned_user_id ORDER BY s.y, s.x`).all();
  return rows.map((s) => ({
    id: s.id, label: s.label, type: s.type, x: s.x, y: s.y,
    assigned_user_id: s.assigned_user_id, assigned_name: s.assigned_name,
    occupied: !!s.occ_user, mine: viewerId != null && (s.occ_user === viewerId), occ_since: s.occ_since,
  }));
}

function minutesByDay(uid, fromMs) {
  const map = {};
  const now = Date.now();
  for (const a of db.prepare('SELECT check_in, check_out FROM attendance WHERE user_id=? AND check_in>=?').all(uid, fromMs)) {
    const end = a.check_out ?? now;
    const k = dayKey(a.check_in);
    map[k] = (map[k] || 0) + Math.max(0, Math.round((end - a.check_in) / 60000));
  }
  return map;
}

// 주말(토·일)은 쉬어도 연속 출석이 끊기지 않음 — 스트릭 "용서 장치" (docs/DESIGN_REFERENCES.md §2)
const isWeekend = (ms) => [0, 6].includes(new Date(ms).getDay());
function streaks(uid) {
  const days = new Set(db.prepare('SELECT check_in FROM attendance WHERE user_id=?').all(uid).map((r) => dayKey(r.check_in)));
  let cur = 0;
  let d = startOfDay();
  if (!days.has(dayKey(d))) d -= DAY; // 오늘 아직 안 왔어도 어제까지의 기록은 유지
  for (let i = 0; i < 400; i++, d -= DAY) {
    if (days.has(dayKey(d))) cur++;
    else if (!isWeekend(d)) break;
  }
  const sorted = [...days].sort().map((k) => new Date(k + 'T00:00:00').getTime());
  let best = 0, run = 0, prev = null;
  for (const t of sorted) {
    let gapOk = false;
    if (prev != null) { gapOk = true; for (let x = prev + DAY; x < t - DAY / 2; x += DAY) if (!isWeekend(x)) { gapOk = false; break; } }
    run = gapOk ? run + 1 : 1; best = Math.max(best, run); prev = t;
  }
  return { current: cur, best: Math.max(best, cur), total_days: days.size };
}

function stats(uid) {
  const from = startOfDay() - 119 * DAY;
  const byDay = minutesByDay(uid, from);
  const today = byDay[dayKey(Date.now())] || 0;
  const weekStart = (() => { const d = new Date(startOfDay()); const wd = (d.getDay() + 6) % 7; return d.getTime() - wd * DAY; })();
  let week = 0; const weekDays = [];
  for (let i = 0; i < 7; i++) { const k = dayKey(weekStart + i * DAY); weekDays.push({ day: k, minutes: byDay[k] || 0 }); week += byDay[k] || 0; }
  const total = db.prepare('SELECT COALESCE(SUM((COALESCE(check_out, ?) - check_in)/60000),0) m FROM attendance WHERE user_id=?').get(Date.now(), uid).m;
  // weekly ranking among students
  const ranking = db.prepare(`SELECT u.id, u.name, COALESCE(SUM((COALESCE(a.check_out, ?) - a.check_in)/60000),0) m
     FROM users u LEFT JOIN attendance a ON a.user_id=u.id AND a.check_in>=? WHERE u.role='student' GROUP BY u.id ORDER BY m DESC`).all(Date.now(), weekStart);
  const rank = ranking.findIndex((r) => r.id === uid) + 1;
  const heat = [];
  for (let i = 119; i >= 0; i--) { const k = dayKey(startOfDay() - i * DAY); heat.push({ day: k, minutes: byDay[k] || 0 }); }
  const open = openSession(uid);
  return {
    today_minutes: today, week_minutes: week, total_minutes: Math.round(total),
    week_days: weekDays, heatmap: heat, streak: streaks(uid),
    rank, rank_total: ranking.length,
    top: ranking.slice(0, 5).map((r) => ({ name: r.name.slice(0, 1) + '*' + r.name.slice(2), minutes: Math.round(r.m), me: r.id === uid })),
    daily_goal_min: Number(getSettings().daily_goal_min),
    open_time: getSettings().open_time || '18:00', close_time: getSettings().close_time,
    today_sessions: db.prepare('SELECT check_in, check_out FROM attendance WHERE user_id=? AND check_in>=? ORDER BY check_in').all(uid, startOfDay()),
    notice: db.prepare("SELECT id, title, created_at FROM posts WHERE board='notice' ORDER BY pinned DESC, created_at DESC LIMIT 1").get() || null,
    my_posts: db.prepare("SELECT SUM(status='open') open, SUM(status='answered') answered FROM posts WHERE user_id=? AND board IN ('inquiry','lost_report')").get(uid),
    lost_found: db.prepare("SELECT COUNT(*) c FROM posts WHERE board='lost_found' AND status='open'").get().c,
    free_seats: db.prepare("SELECT COUNT(*) c FROM seats s WHERE s.type='free' AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.seat_id=s.id AND a.check_out IS NULL)").get().c,
    open: open ? { check_in: open.check_in, seat: open.seat_id && db.prepare('SELECT label FROM seats WHERE id=?').get(open.seat_id)?.label } : null,
  };
}

// 지정석 퇴출 후보: 지정석 보유 + 최근 N 평일 연속 미출석
function evictionCandidates() {
  const n = Number(getSettings().absence_days);
  const rows = db.prepare(`SELECT s.id seat_id, s.label, u.id user_id, u.name, u.login_id FROM seats s JOIN users u ON u.id=s.assigned_user_id WHERE s.type='fixed'`).all();
  const out = [];
  for (const r of rows) {
    const last = db.prepare('SELECT MAX(check_in) t FROM attendance WHERE user_id=?').get(r.user_id).t;
    // count consecutive weekdays (excluding today) with no attendance
    const days = new Set(db.prepare('SELECT check_in FROM attendance WHERE user_id=? AND check_in>=?').all(r.user_id, startOfDay() - 60 * DAY).map((a) => dayKey(a.check_in)));
    let miss = 0; let d = startOfDay() - DAY;
    for (let i = 0; i < 60; i++, d -= DAY) {
      const wd = new Date(d).getDay();
      if (wd === 0 || wd === 6) continue;
      if (days.has(dayKey(d))) break;
      miss++;
    }
    if (miss >= n) out.push({ ...r, missed_days: miss, last_attended: last });
  }
  return out.sort((a, b) => b.missed_days - a.missed_days);
}

// ---------- kiosk tickets ----------
const tickets = new Map(); // ticket -> { user_id, exp }
function issueTicket(uid) {
  const t = randomBytes(16).toString('hex');
  tickets.set(t, { user_id: uid, exp: Date.now() + 60000 });
  return t;
}
function useTicket(t) {
  const v = tickets.get(t); tickets.delete(t);
  if (!v || v.exp < Date.now()) fail(400, '인식 시간이 만료되었습니다. 다시 시도해주세요.');
  return v.user_id;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k); }, 30000);

function doCheckin(uid, seatId, method) {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(uid);
  if (!u) fail(404, '없는 학생');
  if (u.blacklisted) fail(403, `입실이 제한된 학생입니다${u.blacklist_reason ? ` (${u.blacklist_reason})` : ''}`);
  if (openSession(uid)) fail(409, '이미 입실 중입니다');
  if (method === 'face') requireHours();
  const fixed = db.prepare("SELECT * FROM seats WHERE assigned_user_id=? AND type='fixed'").get(uid);
  let seat;
  if (fixed) seat = fixed;
  else {
    seat = db.prepare('SELECT * FROM seats WHERE id=?').get(seatId);
    if (!seat) fail(400, '좌석을 선택해주세요');
    if (seat.type !== 'free') fail(400, '자율석만 선택할 수 있습니다');
  }
  const occ = db.prepare('SELECT 1 FROM attendance WHERE seat_id=? AND check_out IS NULL').get(seat.id);
  if (occ) fail(409, '이미 사용 중인 좌석입니다');
  db.prepare('INSERT INTO attendance (user_id, seat_id, check_in, method) VALUES (?,?,?,?)').run(uid, seat.id, Date.now(), method);
  return { seat: seat.label };
}
function doCheckout(uid) {
  const s = openSession(uid);
  if (!s) fail(409, '입실 기록이 없습니다');
  const now = Date.now();
  db.prepare('UPDATE attendance SET check_out=? WHERE id=?').run(now, s.id);
  return { minutes: Math.round((now - s.check_in) / 60000), today_minutes: minutesByDay(uid, startOfDay())[dayKey(now)] || 0 };
}

// ---------- routes ----------
const routes = [];
const route = (method, path, fn) => {
  const keys = []; const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
};

const DUMMY_HASH = hashPw(randomBytes(16).toString('hex')); // 없는 아이디도 같은 시간이 걸리게 (아이디 존재 여부 추측 방지)
route('POST', '/api/login', async (req) => {
  const { login_id, password } = await body(req);
  const id = String(login_id || '').slice(0, 64); const ip = clientIp(req);
  // 비밀번호 대입 공격 방지: 10분 동안 같은 곳·같은 아이디 10회, 같은 아이디 30회, 같은 곳 100회 실패하면 잠시 차단
  const keys = [[`login:${ip}|${id}`, 10], [`login-id:${id}`, 30], [`login-ip:${ip}`, 100]];
  if (keys.some(([k, max]) => tooMany(k, max))) fail(429, '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도해주세요');
  const u = db.prepare('SELECT * FROM users WHERE login_id=?').get(id);
  if (!verifyPw(password, u ? u.pw_hash : DUMMY_HASH) || !u) {
    for (const [k] of keys) countFail(k);
    fail(401, '아이디 또는 비밀번호가 올바르지 않습니다');
  }
  if (u.role === 'student' && GOOGLE_CLIENT_ID && process.env.ALLOW_PASSWORD_LOGIN !== '1') fail(403, '학생은 학교 구글 계정으로 로그인해주세요');
  // 누구나 아는 초기 비밀번호(데모 학생 1234 포함)로는 외부에서 로그인할 수 없다 — 학번은 순서대로라 쉽게 추측됨
  if (WEAK_PASSWORDS.includes(String(password)) && !isLocalDirect(req))
    fail(403, u.role === 'student' ? '초기 비밀번호로는 로그인할 수 없습니다. 선생님께 비밀번호 재설정을 요청하세요'
      : '초기 비밀번호로는 외부에서 로그인할 수 없습니다. 서버 컴퓨터에서 비밀번호를 먼저 바꿔주세요');
  if (u.role === 'kiosk' && !kioskIpAllowed(req)) fail(403, '허용된 장소에서만 키오스크를 사용할 수 있습니다');
  return issueToken(u);
});
const issueToken = (u) => {
  const successKey = `login-success:${u.id}`;
  if (tooMany(successKey, SUCCESSFUL_AUTH_LIMIT)) fail(429, '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도해주세요');
  countFail(successKey);
  // 여러 기기 로그인은 허용하되, 가장 최근 세션만 남겨 계정 하나가 토큰 테이블을 무한히 키우지 못하게 한다.
  const token = randomBytes(24).toString('hex');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?,?,?)').run(hashToken(token), u.id, Date.now());
    pruneTokens(u.id, MAX_ACTIVE_TOKENS_PER_USER);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { token, user: publicUser(u) };
};
const fixedSeatOf = (uid) => db.prepare("SELECT label FROM seats WHERE assigned_user_id=? AND type='fixed'").get(uid)?.label || null;

// 학교 구글 계정 로그인: 학번·이름 자동 추출 → 관리자가 등록한 학생(학번)과 연결 → 지정석 자동 반영
const pendingGoogle = new Map(); // 학번 추출 실패 시 1회 입력용 임시 토큰
setInterval(() => { const now = Date.now(); for (const [k, v] of pendingGoogle) if (v.exp < now) pendingGoogle.delete(k); }, 60000).unref();
route('POST', '/api/auth/google', async (req) => {
  const { credential, link_token, student_no } = await body(req);
  const ip = clientIp(req); const gKey = `google:${ip}`;
  if (tooMany(gKey, 60)) fail(429, '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도해주세요');
  countFail(gKey); // 성공 여부와 무관하게 외부 검증을 시작하기 전에 시도를 예약한다.
  let g;
  if (link_token) { g = pendingGoogle.get(String(link_token)); pendingGoogle.delete(String(link_token)); if (!g || g.exp < Date.now()) fail(400, '다시 로그인해주세요'); }
  else {
    const release = reserveGoogleVerification(ip);
    if (!release) fail(429, '구글 로그인 요청이 너무 많습니다. 잠시 뒤에 다시 시도해주세요');
    const controller = new AbortController();
    const abort = () => controller.abort();
    try {
      req.once('aborted', abort); req.socket.once('close', abort);
      if (req.aborted || req.socket.destroyed) abort();
      g = await verifyGoogleIdToken(credential, { signal: controller.signal });
    } finally {
      req.off('aborted', abort); req.socket.off('close', abort);
      release();
    }
  }

  // 1) 이미 연결된 계정
  let u = db.prepare('SELECT * FROM users WHERE google_sub=?').get(g.sub);
  if (u && revokedGoogleAdmin(u)) fail(403, '관리자 권한이 해제된 계정입니다');
  // 2) 관리자 이메일 → 관리자 계정
  if (!u && adminEmails().includes(g.email)) {
    u = db.prepare("SELECT * FROM users WHERE role='admin' AND email=?").get(g.email);
    if (!u) {
      const r = db.prepare("INSERT INTO users (role, login_id, name, pw_hash, email, google_sub, created_at) VALUES ('admin',?,?,?,?,?,?)").run(g.email, g.name || g.email, hashPw(randomBytes(16).toString('hex')), g.email, g.sub, Date.now());
      u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    }
  }
  if (!u) {
    const prof = parseStudentProfile(g);
    // 구글 계정에 학번이 들어 있으면 그 학번만 인정한다. 직접 입력한 학번은 계정에서 학번을 찾지 못한 경우(link_token 단계)에만 받는다
    // → 요청에 남의 학번을 끼워 넣어 그 학생의 계정·지정석을 가로채는 것을 막음
    const typed = !prof.studentNo && link_token ? String(student_no || '').trim() : '';
    const no = prof.studentNo || typed;
    if (!/^[1-3]\d{4}$/.test(no)) {
      if (pendingGoogle.size > 5000) pendingGoogle.delete(pendingGoogle.keys().next().value);
      const lt = randomBytes(16).toString('hex'); pendingGoogle.set(lt, { ...g, exp: Date.now() + 600000 });
      return { need_student_no: true, link_token: lt, name: prof.name, email: g.email };
    }
    u = db.prepare("SELECT * FROM users WHERE role='student' AND login_id=?").get(no);
    if (u && u.google_sub && u.google_sub !== g.sub) fail(409, '이 학번은 이미 다른 구글 계정과 연결되어 있습니다. 선생님께 문의하세요.');
    // 학번을 직접 입력했다면 선생님이 등록한 명단에 있어야 하고, 명단 이름과 구글 계정 이름이 같아야 연결한다.
    // (이전에는 구글 이름에 한글이 없으면 이름 확인을 건너뛰어 남의 학번을 가로챌 수 있었고, 명단에 없는 학번은 새 학생으로 선점할 수 있었음)
    if (typed && !u) fail(403, '명단에 없는 학번이에요. 학번을 확인하거나 선생님께 문의하세요.');
    if (typed && !sameName(u.name, prof.name || g.name)) {
      fail(403, '입력한 학번의 이름이 구글 계정 이름과 달라요. 학번을 확인하거나 선생님께 문의하세요.');
    }
    const name = u?.name || prof.name || g.name;
    const grade = +no[0], class_no = +no.slice(1, 3), number = +no.slice(3, 5);
    if (u) db.prepare('UPDATE users SET email=?, google_sub=?, grade=COALESCE(grade,?), class_no=COALESCE(class_no,?), number=COALESCE(number,?) WHERE id=?').run(g.email, g.sub, grade, class_no, number, u.id);
    else db.prepare("INSERT INTO users (role, login_id, name, grade, class_no, number, pw_hash, email, google_sub, created_at) VALUES ('student',?,?,?,?,?,?,?,?,?)").run(no, name, grade, class_no, number, hashPw(randomBytes(16).toString('hex')), g.email, g.sub, Date.now());
    u = db.prepare("SELECT * FROM users WHERE role='student' AND login_id=?").get(no);
  }
  return { ...issueToken(u), fixed_seat: fixedSeatOf(u.id) };
});
route('GET', '/api/auth/config', async () => ({ google_client_id: GOOGLE_CLIENT_ID, school_domain: SCHOOL_DOMAIN, password_login: !GOOGLE_CLIENT_ID || process.env.ALLOW_PASSWORD_LOGIN === '1' }));

route('POST', '/api/logout', async (req) => {
  db.prepare('DELETE FROM tokens WHERE token=?').run(hashToken(bearer(req))); return { ok: true };
});
// password login remains for admin/kiosk devices
route('GET', '/api/me', async (req) => { const u = auth(req); return { user: { ...publicUser(u), fixed_seat: fixedSeatOf(u.id) } }; });
route('POST', '/api/me/password', async (req) => {
  const u = auth(req); const { current, next } = await body(req);
  const key = `pw:${u.id}`;
  if (tooMany(key, 10)) fail(429, '시도가 너무 많습니다. 10분 뒤에 다시 시도해주세요');
  if (!verifyPw(current, u.pw_hash)) { countFail(key); fail(400, '현재 비밀번호가 올바르지 않습니다'); }
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(hashPw(newPassword(next)), u.id);
  // 비밀번호를 바꾸면 이 기기를 뺀 다른 로그인은 모두 끊는다
  db.prepare('DELETE FROM tokens WHERE user_id=? AND token<>?').run(u.id, hashToken(bearer(req)));
  return { ok: true };
});
route('GET', '/api/me/stats', async (req) => stats(auth(req, ['student']).id));
route('GET', '/api/public/settings', async () => { const s = getSettings(); return { room_name: s.room_name, close_time: s.close_time, grid_cols: +s.grid_cols, grid_rows: +s.grid_rows }; });

route('GET', '/api/seats', async (req) => {
  const u = auth(req);
  const s = getSettings();
  let seats = seatsWithStatus(u.id);
  // 지정석 주인의 이름·ID는 관리자에게만 보여준다. 학생은 본인 배정 여부만, 키오스크는 좌석 선택에 필요한 상태만 받는다.
  if (u.role === 'student') seats = seats.map((x) => ({ ...x, assigned_name: null, assigned_user_id: x.assigned_user_id === u.id ? u.id : null }));
  else if (u.role !== 'admin') seats = seats.map(({ id, label, type, x, y, occupied }) => ({ id, label, type, x, y, occupied }));
  return { seats, cols: +s.grid_cols, rows: +s.grid_rows };
});

// boards
const BOARD_RULES = {
  inquiry: { write: ['student', 'admin'], readAll: ['admin'] },     // 학생은 본인 글만
  lost_report: { write: ['student', 'admin'], readAll: ['admin'] },
  lost_found: { write: ['admin'], readAll: ['student', 'admin'] },   // 분실물 보관함: 관리자 작성, 모두 열람
  notice: { write: ['admin'], readAll: ['student', 'admin', 'kiosk'] },
};
const POST_STATUS = ['open', 'answered', 'found', 'closed'];
route('GET', '/api/posts', async (req, _p, q) => {
  const u = auth(req); const board = q.get('board'); const rule = BOARD_RULES[board];
  if (!rule) fail(400, '알 수 없는 게시판');
  const all = rule.readAll.includes(u.role);
  const rows = db.prepare(`SELECT p.*, u.name author FROM posts p LEFT JOIN users u ON u.id=p.user_id
    WHERE board=? ${all ? '' : 'AND p.user_id=?'} ORDER BY pinned DESC, created_at DESC LIMIT 200`).all(...(all ? [board] : [board, u.id]));
  return { posts: rows };
});
route('POST', '/api/posts', async (req) => {
  const u = auth(req); const { board, title, body: text, category, pinned } = await body(req);
  const rule = BOARD_RULES[board]; if (!rule) fail(400, '알 수 없는 게시판');
  if (!rule.write.includes(u.role)) fail(403, '작성 권한이 없습니다');
  if (typeof title !== 'string' || typeof text !== 'string' || !title.trim() || !text.trim()) fail(400, '제목과 내용을 입력하세요');
  // 학생 글 도배 방지: 10분에 10건
  if (u.role === 'student') { const k = `post:${u.id}`; if (tooMany(k, 10)) fail(429, '글을 너무 자주 올리고 있어요. 잠시 뒤에 다시 시도해주세요'); countFail(k); }
  const r = db.prepare('INSERT INTO posts (board, user_id, title, body, category, pinned, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(board, u.id, title.trim().slice(0, 100), text.trim().slice(0, 5000), category ? String(category).slice(0, 30) : null, u.role === 'admin' && pinned ? 1 : 0, Date.now());
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/posts/:id/answer', async (req, p) => {
  auth(req, ['admin']); const { answer, status } = await body(req);
  if (status != null && !POST_STATUS.includes(status)) fail(400, '알 수 없는 상태');
  db.prepare('UPDATE posts SET answer=?, answered_at=?, status=? WHERE id=?').run(answer ? String(answer).slice(0, 5000) : null, Date.now(), status || 'answered', p.id);
  return { ok: true };
});
route('POST', '/api/posts/:id/status', async (req, p) => {
  auth(req, ['admin']); const { status } = await body(req);
  if (!POST_STATUS.includes(status)) fail(400, '알 수 없는 상태');
  db.prepare('UPDATE posts SET status=? WHERE id=?').run(status, p.id); return { ok: true };
});
route('DELETE', '/api/posts/:id', async (req, p) => {
  const u = auth(req); const post = db.prepare('SELECT * FROM posts WHERE id=?').get(p.id);
  if (!post) fail(404, '없는 글');
  if (u.role !== 'admin' && post.user_id !== u.id) fail(403, '권한 없음');
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id); return { ok: true };
});

// ---------- admin ----------
route('GET', '/api/admin/dashboard', async (req) => {
  auth(req, ['admin']);
  const today = startOfDay();
  const present = db.prepare(`SELECT a.*, u.name, u.login_id, s.label FROM attendance a JOIN users u ON u.id=a.user_id LEFT JOIN seats s ON s.id=a.seat_id WHERE a.check_out IS NULL ORDER BY a.check_in`).all();
  const todayCount = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM attendance WHERE check_in>=?').get(today).c;
  const students = db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c;
  const seats = db.prepare("SELECT type, COUNT(*) c FROM seats GROUP BY type").all();
  const openInq = db.prepare("SELECT COUNT(*) c FROM posts WHERE board IN ('inquiry','lost_report') AND status='open'").get().c;
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const s = today - i * DAY;
    trend.push({ day: dayKey(s), count: db.prepare('SELECT COUNT(DISTINCT user_id) c FROM attendance WHERE check_in>=? AND check_in<?').get(s, s + DAY).c });
  }
  const absent_fixed = db.prepare(`SELECT u.id, u.name, u.login_id, s.label FROM seats s JOIN users u ON u.id=s.assigned_user_id
    WHERE s.type='fixed' AND u.id NOT IN (SELECT user_id FROM attendance WHERE check_in>=?) ORDER BY s.label`).all(today);
  return { present, today_count: todayCount, students, seats, open_inquiries: openInq, candidates: evictionCandidates().length, trend, absent_fixed, open_time: getSettings().open_time };
});
route('GET', '/api/admin/users', async (req) => {
  auth(req, ['admin']);
  const rows = db.prepare(`SELECT u.*, s.label fixed_seat, (SELECT MAX(check_in) FROM attendance WHERE user_id=u.id) last_in
    FROM users u LEFT JOIN seats s ON s.assigned_user_id=u.id AND s.type='fixed' WHERE role='student' ORDER BY login_id`).all();
  return { users: rows.map((r) => ({ ...publicUser(r), fixed_seat: r.fixed_seat, last_in: r.last_in, present: !!openSession(r.id) })) };
});
route('POST', '/api/admin/users', async (req) => {
  auth(req, ['admin']); const b = await body(req);
  if (!b.login_id || !b.name) fail(400, '학번과 이름은 필수');
  try {
    const r = db.prepare('INSERT INTO users (role, login_id, name, grade, class_no, number, pw_hash, created_at) VALUES (?,?,?,?,?,?,?,?)')
      // 비밀번호를 정하지 않으면 무작위 값 → 구글 로그인으로만 들어올 수 있음 (모두가 아는 '1234' 기본값 제거)
      .run('student', String(b.login_id).slice(0, 64), String(b.name).slice(0, 50), b.grade || null, b.class_no || null, b.number || null, hashPw(b.password ? newPassword(b.password) : randomBytes(16).toString('hex')), Date.now());
    return { id: Number(r.lastInsertRowid) };
  } catch (e) { if (e instanceof HttpError) throw e; fail(409, '이미 존재하는 학번'); }
});
route('POST', '/api/admin/users/bulk', async (req) => {
  auth(req, ['admin']); const { rows } = await body(req);
  let created = 0, updated = 0; const errors = [];
  for (const [i, r] of (rows || []).entries()) {
    const no = String(r.login_id || '').trim(); const name = String(r.name || '').trim();
    if (!/^[1-3]\d{4}$/.test(no) || !name) { errors.push(`${i + 1}행: 학번(5자리)·이름 확인`); continue; }
    const ex = db.prepare("SELECT id FROM users WHERE role='student' AND login_id=?").get(no);
    if (ex) { db.prepare('UPDATE users SET name=? WHERE id=?').run(name, ex.id); updated++; }
    else { db.prepare("INSERT INTO users (role, login_id, name, grade, class_no, number, pw_hash, created_at) VALUES ('student',?,?,?,?,?,?,?)").run(no, name, +no[0], +no.slice(1, 3), +no.slice(3, 5), hashPw(randomBytes(16).toString('hex')), Date.now()); created++; }
  }
  return { created, updated, errors };
});
route('PUT', '/api/admin/users/:id', async (req, p) => {
  auth(req, ['admin']); const b = await body(req);
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(p.id); if (!u) fail(404, '없는 학생');
  db.prepare('UPDATE users SET name=?, grade=?, class_no=?, number=? WHERE id=?').run(b.name ?? u.name, b.grade ?? u.grade, b.class_no ?? u.class_no, b.number ?? u.number, u.id);
  if (b.password) {
    db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(hashPw(newPassword(b.password)), u.id);
    db.prepare('DELETE FROM tokens WHERE user_id=?').run(u.id); // 비밀번호를 재설정하면 기존 로그인은 모두 끊음
  }
  return { ok: true };
});
route('DELETE', '/api/admin/users/:id', async (req, p) => {
  auth(req, ['admin']); db.prepare("DELETE FROM users WHERE id=? AND role='student'").run(p.id); return { ok: true };
});
route('POST', '/api/admin/users/:id/blacklist', async (req, p) => {
  auth(req, ['admin']); const { on, reason } = await body(req);
  db.prepare("UPDATE users SET blacklisted=?, blacklist_reason=? WHERE id=? AND role='student'").run(on ? 1 : 0, on && reason ? String(reason).slice(0, 200) : null, p.id);
  if (on) { const s = openSession(Number(p.id)); if (s) db.prepare('UPDATE attendance SET check_out=? WHERE id=?').run(Date.now(), s.id); }
  return { ok: true };
});
route('POST', '/api/admin/users/:id/face', async (req, p) => {
  auth(req, ['admin']); const { embeddings } = await body(req);
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='student'").get(p.id)) fail(404, '없는 학생');
  if (!Array.isArray(embeddings) || embeddings.length < 3 || embeddings.length > 20) fail(400, '얼굴 샘플은 3~20개가 필요합니다');
  const vecs = embeddings.map((e) => toVec(e));
  if (vecs.some((v) => v.length < 128 || v.length > 2048 || v.length !== vecs[0].length)) fail(400, '잘못된 임베딩');
  // self-consistency: samples must look like the same person
  for (let i = 1; i < vecs.length; i++) if (similarity(vecs[0], vecs[i]) < 0.45) fail(400, '샘플 간 일관성이 낮습니다. 다시 촬영해주세요.');
  // duplicate check against other students
  const others = db.prepare("SELECT id, name, face FROM users WHERE face IS NOT NULL AND id<>?").all(p.id);
  // 한 사람의 얼굴을 두 학생에게 등록해 대신 출석하는 것을 막기 위해 모든 샘플을 비교
  for (const v of vecs) { const dup = bestMatch(v, others); if (dup && dup.score > 0.75) fail(409, `이미 등록된 얼굴과 매우 유사합니다 (${dup.name})`); }
  db.prepare('UPDATE users SET face=? WHERE id=?').run(JSON.stringify(vecs.map((v) => v.map((x) => +x.toFixed(6)))), p.id);
  return { ok: true };
});
route('DELETE', '/api/admin/users/:id/face', async (req, p) => {
  auth(req, ['admin']); db.prepare('UPDATE users SET face=NULL WHERE id=?').run(p.id); return { ok: true };
});
route('POST', '/api/admin/users/:id/checkout', async (req, p) => { auth(req, ['admin']); return doCheckout(Number(p.id)); });
route('POST', '/api/admin/users/:id/checkin', async (req, p) => {
  auth(req, ['admin']); const { seat_id } = await body(req); return doCheckin(Number(p.id), seat_id, 'manual');
});

route('PUT', '/api/admin/seats', async (req) => {
  auth(req, ['admin']); const { seats, cols, rows } = await body(req);
  if (!Array.isArray(seats)) fail(400, 'seats 필요');
  const labels = new Set();
  for (const s of seats) {
    if (!s || !['free', 'fixed', 'disabled'].includes(s.type)) fail(400, '잘못된 좌석 유형');
    if (![s.x, s.y].every((n) => Number.isInteger(n) && n >= 0 && n < 60)) fail(400, '잘못된 좌석 위치');
    s.label = String(s.label ?? '').trim().slice(0, 12); if (!s.label) fail(400, '좌석 번호를 입력하세요');
    if (labels.has(s.label)) fail(400, `중복 좌석 번호: ${s.label}`); labels.add(s.label);
    if (s.type === 'fixed' && s.assigned_user_id && !db.prepare("SELECT 1 FROM users WHERE id=? AND role='student'").get(s.assigned_user_id)) fail(400, '배정할 학생을 찾을 수 없습니다');
  }
  if (seats.length > 1000) fail(400, '좌석이 너무 많습니다');
  for (const n of [cols, rows]) if (n != null && !(Number.isInteger(+n) && +n >= 1 && +n <= 60)) fail(400, '잘못된 배치 크기');
  db.exec('BEGIN');
  try {
    const keep = new Set(seats.filter((s) => s.id).map((s) => Number(s.id)));
    for (const r of db.prepare('SELECT id FROM seats').all()) if (!keep.has(r.id)) {
      db.prepare('UPDATE attendance SET seat_id=NULL WHERE seat_id=?').run(r.id);
      db.prepare('DELETE FROM seats WHERE id=?').run(r.id);
    }
    for (const s of seats) {
      const assigned = s.type === 'fixed' ? (s.assigned_user_id || null) : null;
      if (s.id) db.prepare('UPDATE seats SET label=?, type=?, x=?, y=?, assigned_user_id=? WHERE id=?').run(String(s.label), s.type, s.x, s.y, assigned, s.id);
      else db.prepare('INSERT INTO seats (label, type, x, y, assigned_user_id) VALUES (?,?,?,?,?)').run(String(s.label), s.type, s.x, s.y, assigned);
    }
    if (cols) db.prepare("UPDATE settings SET value=? WHERE key='grid_cols'").run(String(cols));
    if (rows) db.prepare("UPDATE settings SET value=? WHERE key='grid_rows'").run(String(rows));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true };
});

route('GET', '/api/admin/attendance', async (req, _p, q) => {
  auth(req, ['admin']);
  const date = q.get('date') || dayKey(Date.now());
  const s = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T00:00:00').getTime() : NaN;
  if (!Number.isFinite(s)) fail(400, '잘못된 날짜');
  const rows = db.prepare(`SELECT a.*, u.name, u.login_id, s.label FROM attendance a JOIN users u ON u.id=a.user_id LEFT JOIN seats s ON s.id=a.seat_id
    WHERE a.check_in>=? AND a.check_in<? ORDER BY a.check_in`).all(s, s + DAY);
  const absent = db.prepare(`SELECT id, name, login_id FROM users WHERE role='student' AND id NOT IN (SELECT user_id FROM attendance WHERE check_in>=? AND check_in<?) ORDER BY login_id`).all(s, s + DAY);
  return { date, rows, absent };
});
route('GET', '/api/admin/calendar', async (req, _p, q) => {
  auth(req, ['admin']);
  const m = /^(\d{4})-(\d{2})$/.exec(q.get('month') || '') || [null, new Date().getFullYear(), String(new Date().getMonth() + 1).padStart(2, '0')];
  const start = new Date(+m[1], +m[2] - 1, 1).getTime(); const end = new Date(+m[1], +m[2], 1).getTime();
  const days = {};
  for (const a of db.prepare('SELECT user_id, check_in, check_out FROM attendance WHERE check_in>=? AND check_in<?').all(start, end)) {
    const k = dayKey(a.check_in); const d = (days[k] ||= { users: new Set(), minutes: 0 });
    d.users.add(a.user_id); d.minutes += Math.max(0, Math.round(((a.check_out ?? Date.now()) - a.check_in) / 60000));
  }
  return { month: `${m[1]}-${m[2]}`, days: Object.fromEntries(Object.entries(days).map(([k, v]) => [k, { count: v.users.size, minutes: v.minutes }])) };
});
route('GET', '/api/admin/candidates', async (req) => { auth(req, ['admin']); return { candidates: evictionCandidates(), absence_days: +getSettings().absence_days }; });
route('POST', '/api/admin/seats/:id/revoke', async (req, p) => {
  auth(req, ['admin']); db.prepare('UPDATE seats SET assigned_user_id=NULL, type=\'free\' WHERE id=?').run(p.id); return { ok: true };
});
// 라이브니스 재학습용 샘플 수집 (정렬된 112x112 얼굴 JPEG) → ml/data/liveness/{real,spoof}
const LIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ml', 'data', 'liveness');
route('GET', '/api/admin/liveness-samples', async (req) => {
  auth(req, ['admin']);
  const n = (l) => { try { return readdirSync(join(LIVE_DIR, l)).filter((f) => f.endsWith('.jpg')).length; } catch { return 0; } };
  return { real: n('real'), spoof: n('spoof') };
});
// 테스트 페이지(/facetest) 녹화용: 이 컴퓨터에서 직접 접속한 경우만 허용 (Cloudflare 터널·프록시 경유, 다른 웹사이트가 보낸 요청은 거부)
route('POST', '/api/dev/liveness-sample', async (req) => {
  if (!isLocalDev(req)) fail(403, '이 컴퓨터에서만 사용할 수 있어요');
  return saveLiveSample(await body(req));
});
route('GET', '/api/dev/liveness-sample', async (req) => {
  if (!isLocalDev(req)) fail(403, '이 컴퓨터에서만 사용할 수 있어요');
  const n = (l) => { try { return readdirSync(join(LIVE_DIR, l)).filter((f) => f.endsWith('.jpg')).length; } catch { return 0; } };
  return { real: n('real'), spoof: n('spoof') };
});
function saveLiveSample({ label, image, split }) {
  if (!['real', 'spoof'].includes(label)) fail(400, 'label은 real 또는 spoof');
  if (split === 'val') label = `${label}_val`; // 학습에 쓰지 않는 평가용
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) fail(400, 'JPEG 이미지가 필요합니다');
  const buf = Buffer.from(m[1], 'base64'); if (buf.length > 200000) fail(413, '이미지가 너무 큽니다');
  mkdirSync(join(LIVE_DIR, label), { recursive: true });
  writeFileSync(join(LIVE_DIR, label, `${Date.now()}_${randomBytes(3).toString('hex')}.jpg`), buf);
  return { ok: true };
}
route('POST', '/api/admin/liveness-samples', async (req) => { auth(req, ['admin']); return saveLiveSample(await body(req)); });
route('GET', '/api/admin/settings', async (req) => { auth(req, ['admin']); return getSettings(); });
// 잘못된 값이 들어가면 자동 퇴실이 멈추거나(시간) 얼굴 인식이 아무나 통과시킬 수 있어(임계값) 형식·범위를 확인한다
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const inRange = (lo, hi, int) => (v) => v !== '' && Number.isFinite(+v) && +v >= lo && +v <= hi && (!int || Number.isInteger(+v));
const SETTING_RULES = {
  open_time: isTime, close_time: isTime,
  absence_days: inRange(1, 60, true), daily_goal_min: inRange(1, 1440, true),
  match_threshold: inRange(0.3, 1), match_margin: inRange(0, 1), antispoof_threshold: inRange(0.1, 1), liveness_threshold: inRange(0.1, 1),
  grid_cols: inRange(1, 60, true), grid_rows: inRange(1, 60, true),
};
// 키오스크 계정 비밀번호 변경 → 로그인돼 있던 키오스크는 모두 로그아웃 (기기를 잃어버렸거나 비밀번호가 새었을 때)
route('POST', '/api/admin/kiosk-password', async (req) => {
  auth(req, ['admin']); const { password } = await body(req);
  const hash = hashPw(newPassword(password));
  db.prepare("UPDATE users SET pw_hash=? WHERE role='kiosk'").run(hash);
  db.prepare("DELETE FROM tokens WHERE user_id IN (SELECT id FROM users WHERE role='kiosk')").run();
  return { ok: true };
});
route('PUT', '/api/admin/settings', async (req) => {
  auth(req, ['admin']); const b = await body(req);
  const next = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (b[k] == null) continue;
    const v = String(b[k]).trim(); const rule = SETTING_RULES[k];
    if (rule && !rule(v)) fail(400, `설정 값이 올바르지 않습니다: ${k}`);
    next[k] = v.slice(0, 500);
  }
  for (const [k, v] of Object.entries(next)) db.prepare('UPDATE settings SET value=? WHERE key=?').run(v, k);
  return getSettings();
});

// ---------- kiosk ----------
route('GET', '/api/kiosk/config', async (req) => {
  auth(req, ['kiosk', 'admin']); const s = getSettings();
  return { antispoof_threshold: +s.antispoof_threshold, liveness_threshold: +s.liveness_threshold, room_name: s.room_name };
});
// ---- 대리 출석 방지 ----
// 얼굴 인식·라이브니스 계산은 키오스크 브라우저에서 하므로, 서버는 키오스크가 보낸 결과를 최대한 의심하고 다시 확인한다.
//  1) 동작 챌린지는 서버가 무작위로 정해 1회용 번호(nonce)와 함께 내려준다 → 미리 만들어 둔 요청이나 가로챈 요청을 다시 보낼 수 없음
//  2) 챌린지를 받고 사람이 실제로 따라 할 수 없을 만큼 빨리 온 응답은 거부
//  3) 라이브니스 값이 하나라도 빠지거나 숫자가 아니면 거부 (빠진 값을 통과시키지 않음)
//  4) 이전에 왔던 것과 완전히 같은 얼굴 벡터는 거부 (카메라로 찍으면 매번 조금씩 달라지므로 같으면 재전송)
const CHALLENGE_TTL = 45000, CHALLENGE_MIN_MS = 1200;
const challenges = new Map(); // nonce -> { plan, at, kiosk }
const seenEmbeddings = new Map(); // sha256(embedding) -> 시각
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (now - v.at > CHALLENGE_TTL) challenges.delete(k);
  for (const [k, t] of seenEmbeddings) if (now - t > DAY) seenEmbeddings.delete(k);
}, 30000).unref();
route('POST', '/api/kiosk/challenge', async (req) => {
  const k = auth(req, ['kiosk']);
  const kinds = ['blink', 'turn', 'mouth'];
  for (let i = kinds.length - 1; i > 0; i--) { const j = randomInt(i + 1); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  if (challenges.size >= 500) challenges.delete(challenges.keys().next().value);
  const nonce = randomBytes(16).toString('hex'); const plan = kinds.slice(0, 2);
  challenges.set(nonce, { plan, at: Date.now(), kiosk: k.id });
  return { nonce, plan };
});
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN); // 숫자가 아니면 NaN → 아래 비교가 모두 실패
function checkPad(pad, s, plan) {
  const bad = () => fail(422, '실제 얼굴 확인(라이브니스)에 실패했습니다');
  if (!pad || typeof pad !== 'object') bad();
  if (!(finite(pad.real) >= +s.antispoof_threshold) || !(finite(pad.live) >= +s.liveness_threshold) || pad.challenge_passed !== true || !(finite(pad.continuity) >= 0.55)) bad();
  if (!Array.isArray(pad.challenges) || pad.challenges.join() !== plan.join()) bad();
  // 깜빡임·비강체 움직임(사진/화면 흔들기 공격 방지) — 반드시 있어야 함
  if (!(finite(pad.blinks) >= 1) || !(finite(pad.motion) >= 0.004)) fail(422, '눈 깜빡임과 자연스러운 움직임이 확인되지 않았어요');
}
route('POST', '/api/kiosk/identify', async (req) => {
  const k = auth(req, ['kiosk']);
  const { embedding, pad, nonce } = await body(req);
  const s = getSettings();
  const ch = challenges.get(String(nonce || '')); challenges.delete(String(nonce || ''));
  const elapsed = ch ? Date.now() - ch.at : -1;
  if (!ch || ch.kiosk !== k.id || elapsed > CHALLENGE_TTL) fail(422, '인식 시간이 만료되었습니다. 다시 시도해주세요.');
  if (elapsed < CHALLENGE_MIN_MS) fail(422, '실제 얼굴 확인(라이브니스)에 실패했습니다');
  checkPad(pad, s, ch.plan);
  if (!Array.isArray(embedding) || embedding.length > 2048) fail(400, '임베딩 없음');
  const vec = toVec(embedding);
  if (vec.length < 128) fail(400, '임베딩 없음');
  const fp = createHash('sha256').update(JSON.stringify(vec)).digest('hex');
  if (seenEmbeddings.has(fp)) fail(422, '실제 얼굴 확인(라이브니스)에 실패했습니다');
  if (seenEmbeddings.size >= 5000) seenEmbeddings.delete(seenEmbeddings.keys().next().value);
  seenEmbeddings.set(fp, Date.now());
  const cands = db.prepare("SELECT id, name, face FROM users WHERE role='student' AND face IS NOT NULL").all();
  const m = bestMatch(vec, cands);
  if (!m || !(m.score >= +s.match_threshold) || !(m.margin >= +s.match_margin)) fail(404, '등록된 얼굴을 찾지 못했습니다');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(m.id);
  if (u.blacklisted) fail(403, `${u.name} 학생은 입실이 제한되어 있습니다${u.blacklist_reason ? ` (${u.blacklist_reason})` : ''}`);
  const open = openSession(u.id);
  if (!open) requireHours(); // 퇴실은 언제든 가능
  const fixed = db.prepare("SELECT id, label FROM seats WHERE assigned_user_id=? AND type='fixed'").get(u.id);
  return {
    ticket: issueTicket(u.id), action: open ? 'checkout' : 'checkin',
    user: { id: u.id, name: u.name, login_id: u.login_id }, fixed_seat: fixed || null,
    session: open ? { check_in: open.check_in } : null,
  };
});
route('POST', '/api/kiosk/checkin', async (req) => {
  auth(req, ['kiosk']); const { ticket, seat_id } = await body(req);
  return doCheckin(useTicket(ticket), seat_id, 'face');
});
route('POST', '/api/kiosk/checkout', async (req) => {
  auth(req, ['kiosk']); const { ticket } = await body(req);
  return doCheckout(useTicket(ticket));
});

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
// 모든 응답 공통 보안 헤더: MIME 추측 금지, 다른 사이트의 iframe 삽입(클릭재킹) 금지, 외부로 주소 노출 금지, 카메라는 이 사이트에서만
// CSP는 화면을 깨뜨리지 않는 항목만: iframe 삽입 금지, 플러그인 금지, <base> 주입으로 스크립트 경로 바꾸기 금지
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'permissions-policy': 'camera=(self), microphone=(), geolocation=()', 'content-security-policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" };
const LARGE_STATIC_BYTES = 1024 * 1024;
const STATIC_STREAM_BUFFER_BYTES = 64 * 1024;
const MAX_LARGE_STATIC = 32;
const MAX_LARGE_STATIC_PER_IP = 8;
let activeLargeStatic = 0;
const activeLargeStaticByIp = new Map();

function reserveLargeStatic(req, size) {
  if (size < LARGE_STATIC_BYTES) return () => {};
  const ip = clientIp(req); const activeForIp = activeLargeStaticByIp.get(ip) || 0;
  if (activeLargeStatic >= MAX_LARGE_STATIC || activeForIp >= MAX_LARGE_STATIC_PER_IP) return null;
  activeLargeStatic++;
  activeLargeStaticByIp.set(ip, activeForIp + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true; activeLargeStatic--;
    const remaining = (activeLargeStaticByIp.get(ip) || 1) - 1;
    if (remaining) activeLargeStaticByIp.set(ip, remaining); else activeLargeStaticByIp.delete(ip);
  };
}

async function serveStatic(req, res, pathname) {
  const send = (status, text, headers = {}) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }); res.end(text); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
  if (pathname === '/') { res.writeHead(302, { location: '/student/' }); return res.end(); }
  let rel; try { rel = decodeURIComponent(pathname); } catch { return send(400, 'Bad request'); }
  // 숨김 파일(.git, .env 등)과 _로 시작하는 개발용 폴더(_vids 얼굴 영상 등)는 내보내지 않음
  if (rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg.startsWith('.') || seg.startsWith('_'))) return send(404, 'Not found');
  let p = normalize(join(PUBLIC, rel));
  if (p !== PUBLIC && !p.startsWith(PUBLIC + sep)) return send(403, 'Forbidden'); // public 밖(이름이 public으로 시작하는 옆 폴더 포함) 차단
  try {
    let info = await stat(p);
    if (info.isDirectory()) { p = join(p, 'index.html'); info = await stat(p); }
    if (!info.isFile()) return send(404, 'Not found');
    const headers = { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': String(info.size) };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }

    const release = reserveLargeStatic(req, info.size);
    if (!release) return send(503, 'Server busy', { 'retry-after': '1' });
    try {
      res.writeHead(200, headers);
      await pipeline(createReadStream(p, { highWaterMark: STATIC_STREAM_BUFFER_BYTES }), res);
    } finally { release(); }
  } catch {
    if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
    send(404, 'Not found');
  }
}

createServer(async (req, res) => {
  try {
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    let url; try { url = new URL(req.url, 'http://x'); } catch { fail(400, '잘못된 주소'); }
    if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url.pathname);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const out = await r.fn(req, params, url.searchParams);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(out));
    }
    fail(404, 'Not found');
  } catch (e) {
    // 어떤 요청도 서버를 죽이지 못하게 여기서 모두 받는다 (처리되지 않은 예외는 Node 프로세스를 종료시킴)
    const status = e.status || 500; if (status === 500) console.error(e);
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: e.status ? e.message : '서버 오류' }));
  }
}).listen(PORT, HOST, () => {
  autoCheckout();
  console.log(`SSSMS running → http://localhost:${PORT}  (student /student, admin /admin, kiosk /kiosk)`);
  // 초기 비밀번호를 그대로 쓰고 있으면 눈에 띄게 알림 (외부 로그인은 이미 차단됨)
  for (const u of db.prepare("SELECT login_id, pw_hash FROM users WHERE role IN ('admin','kiosk') AND google_sub IS NULL").all())
    if (WEAK_PASSWORDS.some((w) => verifyPw(w, u.pw_hash))) console.warn(`[보안 경고] '${u.login_id}' 계정이 초기 비밀번호를 쓰고 있습니다. 외부에서는 로그인할 수 없으니 비밀번호를 바꾸세요 (관리자 → 설정, 또는 node server/passwd.js ${u.login_id})`);
  if (!kioskIpRestricted) console.log('[안내] KIOSK_ALLOWED_IPS가 비어 있어 키오스크 계정을 어디서나 쓸 수 있습니다. 학교 공인 IP를 넣으면 학교 밖 출석 처리를 막을 수 있어요.');
});
