process.env.TZ ||= 'Asia/Seoul';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { db, getSettings, hashPw, verifyPw, DEFAULT_SETTINGS } from './db.js';
import { toVec, bestMatch, similarity } from './face.js';
import { verifyGoogleIdToken, parseStudentProfile, GOOGLE_CLIENT_ID, SCHOOL_DOMAIN } from './google.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 3000);
// Cloudflare Tunnel 배포 시 외부 직접 접속을 막기 위해 기본은 로컬호스트에만 바인딩 (LAN 공개가 필요하면 HOST=0.0.0.0)
const HOST = process.env.HOST || '127.0.0.1';
const DAY = 86400000;

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
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, '잘못된 JSON'); }
}

function auth(req, roles) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const row = t && db.prepare('SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?').get(t);
  if (!row) fail(401, '로그인이 필요합니다');
  if (roles && !roles.includes(row.role)) fail(403, '권한이 없습니다');
  return row;
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
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (u.blacklisted) fail(403, `입실이 제한된 학생입니다${u.blacklist_reason ? ` (${u.blacklist_reason})` : ''}`);
  if (openSession(uid)) fail(409, '이미 입실 중입니다');
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

route('POST', '/api/login', async (req) => {
  const { login_id, password } = await body(req);
  const u = db.prepare('SELECT * FROM users WHERE login_id=?').get(String(login_id || ''));
  if (!u || !verifyPw(password, u.pw_hash)) fail(401, '아이디 또는 비밀번호가 올바르지 않습니다');
  if (u.role === 'student' && GOOGLE_CLIENT_ID && process.env.ALLOW_PASSWORD_LOGIN !== '1') fail(403, '학생은 학교 구글 계정으로 로그인해주세요');
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?,?,?)').run(token, u.id, Date.now());
  return { token, user: publicUser(u) };
});
const issueToken = (u) => {
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?,?,?)').run(token, u.id, Date.now());
  return { token, user: publicUser(u) };
};
const fixedSeatOf = (uid) => db.prepare("SELECT label FROM seats WHERE assigned_user_id=? AND type='fixed'").get(uid)?.label || null;

// 학교 구글 계정 로그인: 학번·이름 자동 추출 → 관리자가 등록한 학생(학번)과 연결 → 지정석 자동 반영
const pendingGoogle = new Map(); // 학번 추출 실패 시 1회 입력용 임시 토큰
route('POST', '/api/auth/google', async (req) => {
  const { credential, link_token, student_no } = await body(req);
  let g;
  if (link_token) { g = pendingGoogle.get(link_token); pendingGoogle.delete(link_token); if (!g || g.exp < Date.now()) fail(400, '다시 로그인해주세요'); }
  else g = await verifyGoogleIdToken(String(credential || ''));

  // 1) 이미 연결된 계정
  let u = db.prepare('SELECT * FROM users WHERE google_sub=?').get(g.sub);
  // 2) 관리자 이메일 → 관리자 계정
  const admins = getSettings().admin_emails.split(/[,\s]+/).filter(Boolean).map((e) => e.toLowerCase());
  if (!u && admins.includes(g.email)) {
    u = db.prepare("SELECT * FROM users WHERE role='admin' AND email=?").get(g.email);
    if (!u) {
      const r = db.prepare("INSERT INTO users (role, login_id, name, pw_hash, email, google_sub, created_at) VALUES ('admin',?,?,?,?,?,?)").run(g.email, g.name || g.email, hashPw(randomBytes(16).toString('hex')), g.email, g.sub, Date.now());
      u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    }
  }
  if (!u) {
    const prof = parseStudentProfile(g);
    const no = String(student_no || prof.studentNo || '').trim();
    if (!/^[1-3]\d{4}$/.test(no)) {
      const lt = randomBytes(16).toString('hex'); pendingGoogle.set(lt, { ...g, exp: Date.now() + 600000 });
      return { need_student_no: true, link_token: lt, name: prof.name, email: g.email };
    }
    u = db.prepare("SELECT * FROM users WHERE role='student' AND login_id=?").get(no);
    if (u && u.google_sub && u.google_sub !== g.sub) fail(409, '이 학번은 이미 다른 구글 계정과 연결되어 있습니다. 선생님께 문의하세요.');
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
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  db.prepare('DELETE FROM tokens WHERE token=?').run(t); return { ok: true };
});
// password login remains for admin/kiosk devices
route('GET', '/api/me', async (req) => { const u = auth(req); return { user: { ...publicUser(u), fixed_seat: fixedSeatOf(u.id) } }; });
route('POST', '/api/me/password', async (req) => {
  const u = auth(req); const { current, next } = await body(req);
  if (!verifyPw(current, u.pw_hash)) fail(400, '현재 비밀번호가 올바르지 않습니다');
  if (!next || String(next).length < 4) fail(400, '새 비밀번호는 4자 이상');
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(hashPw(next), u.id); return { ok: true };
});
route('GET', '/api/me/stats', async (req) => stats(auth(req, ['student']).id));
route('GET', '/api/public/settings', async () => { const s = getSettings(); return { room_name: s.room_name, close_time: s.close_time, grid_cols: +s.grid_cols, grid_rows: +s.grid_rows }; });

route('GET', '/api/seats', async (req) => {
  const u = auth(req);
  const s = getSettings();
  return { seats: seatsWithStatus(u.id), cols: +s.grid_cols, rows: +s.grid_rows };
});

// boards
const BOARD_RULES = {
  inquiry: { write: ['student', 'admin'], readAll: ['admin'] },     // 학생은 본인 글만
  lost_report: { write: ['student', 'admin'], readAll: ['admin'] },
  lost_found: { write: ['admin'], readAll: ['student', 'admin'] },   // 분실물 보관함: 관리자 작성, 모두 열람
  notice: { write: ['admin'], readAll: ['student', 'admin', 'kiosk'] },
};
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
  if (!title?.trim() || !text?.trim()) fail(400, '제목과 내용을 입력하세요');
  const r = db.prepare('INSERT INTO posts (board, user_id, title, body, category, pinned, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(board, u.id, title.trim().slice(0, 100), text.trim().slice(0, 5000), category || null, u.role === 'admin' && pinned ? 1 : 0, Date.now());
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/posts/:id/answer', async (req, p) => {
  auth(req, ['admin']); const { answer, status } = await body(req);
  db.prepare('UPDATE posts SET answer=?, answered_at=?, status=? WHERE id=?').run(answer || null, Date.now(), status || 'answered', p.id);
  return { ok: true };
});
route('POST', '/api/posts/:id/status', async (req, p) => {
  auth(req, ['admin']); const { status } = await body(req);
  db.prepare('UPDATE posts SET status=? WHERE id=?').run(String(status), p.id); return { ok: true };
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
      .run('student', String(b.login_id), String(b.name), b.grade || null, b.class_no || null, b.number || null, hashPw(b.password || '1234'), Date.now());
    return { id: Number(r.lastInsertRowid) };
  } catch { fail(409, '이미 존재하는 학번'); }
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
  if (b.password) db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(hashPw(b.password), u.id);
  return { ok: true };
});
route('DELETE', '/api/admin/users/:id', async (req, p) => {
  auth(req, ['admin']); db.prepare("DELETE FROM users WHERE id=? AND role='student'").run(p.id); return { ok: true };
});
route('POST', '/api/admin/users/:id/blacklist', async (req, p) => {
  auth(req, ['admin']); const { on, reason } = await body(req);
  db.prepare('UPDATE users SET blacklisted=?, blacklist_reason=? WHERE id=?').run(on ? 1 : 0, on ? (reason || null) : null, p.id);
  if (on) { const s = openSession(Number(p.id)); if (s) db.prepare('UPDATE attendance SET check_out=? WHERE id=?').run(Date.now(), s.id); }
  return { ok: true };
});
route('POST', '/api/admin/users/:id/face', async (req, p) => {
  auth(req, ['admin']); const { embeddings } = await body(req);
  if (!Array.isArray(embeddings) || embeddings.length < 3) fail(400, '최소 3개의 얼굴 샘플이 필요합니다');
  const vecs = embeddings.map((e) => toVec(e));
  if (vecs.some((v) => v.length < 128 || v.length !== vecs[0].length)) fail(400, '잘못된 임베딩');
  // self-consistency: samples must look like the same person
  for (let i = 1; i < vecs.length; i++) if (similarity(vecs[0], vecs[i]) < 0.45) fail(400, '샘플 간 일관성이 낮습니다. 다시 촬영해주세요.');
  // duplicate check against other students
  const others = db.prepare("SELECT id, name, face FROM users WHERE face IS NOT NULL AND id<>?").all(p.id);
  const dup = bestMatch(vecs[0], others);
  if (dup && dup.score > 0.75) fail(409, `이미 등록된 얼굴과 매우 유사합니다 (${dup.name})`);
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
    if (!['free', 'fixed', 'disabled'].includes(s.type)) fail(400, '잘못된 좌석 유형');
    if (labels.has(s.label)) fail(400, `중복 좌석 번호: ${s.label}`); labels.add(s.label);
  }
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
  const s = new Date(date + 'T00:00:00').getTime();
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
// 테스트 페이지(/facetest) 녹화용: 이 컴퓨터에서 직접 접속한 경우만 허용 (Cloudflare 터널·프록시 경유 요청은 거부)
const isLocalDirect = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
route('POST', '/api/dev/liveness-sample', async (req) => {
  if (!isLocalDirect(req)) fail(403, '이 컴퓨터에서만 사용할 수 있어요');
  return saveLiveSample(await body(req));
});
route('GET', '/api/dev/liveness-sample', async (req) => {
  if (!isLocalDirect(req)) fail(403, '이 컴퓨터에서만 사용할 수 있어요');
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
route('PUT', '/api/admin/settings', async (req) => {
  auth(req, ['admin']); const b = await body(req);
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (b[k] != null) db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(b[k]), k);
  return getSettings();
});

// ---------- kiosk ----------
route('GET', '/api/kiosk/config', async (req) => {
  auth(req, ['kiosk', 'admin']); const s = getSettings();
  return { antispoof_threshold: +s.antispoof_threshold, liveness_threshold: +s.liveness_threshold, room_name: s.room_name };
});
route('POST', '/api/kiosk/identify', async (req) => {
  auth(req, ['kiosk']);
  const { embedding, pad } = await body(req);
  const s = getSettings();
  // server-side re-validation of presentation attack detection results
  if (!pad || pad.real < +s.antispoof_threshold || pad.live < +s.liveness_threshold || !pad.challenge_passed || !(pad.continuity >= 0.55))
    fail(422, '실제 얼굴 확인(라이브니스)에 실패했습니다');
  // 깜빡임·비강체 움직임(사진/화면 흔들기 공격 방지) 재검증 — 클라이언트가 보낸 경우 서버 기준으로 다시 확인
  if (pad.blinks != null && (!(pad.blinks >= 1) || !(pad.motion >= 0.004)))
    fail(422, '눈 깜빡임과 자연스러운 움직임이 확인되지 않았어요');
  if (!Array.isArray(embedding)) fail(400, '임베딩 없음');
  const vec = toVec(embedding);
  const cands = db.prepare("SELECT id, name, face FROM users WHERE role='student' AND face IS NOT NULL").all();
  const m = bestMatch(vec, cands);
  if (!m || m.score < +s.match_threshold || m.margin < +s.match_margin) fail(404, '등록된 얼굴을 찾지 못했습니다');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(m.id);
  if (u.blacklisted) fail(403, `${u.name} 학생은 입실이 제한되어 있습니다${u.blacklist_reason ? ` (${u.blacklist_reason})` : ''}`);
  const open = openSession(u.id);
  const fixed = db.prepare("SELECT id, label FROM seats WHERE assigned_user_id=? AND type='fixed'").get(u.id);
  return {
    ticket: issueTicket(u.id), action: open ? 'checkout' : 'checkin', score: +m.score.toFixed(3),
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
async function serveStatic(res, pathname) {
  if (pathname === '/') { res.writeHead(302, { location: '/student/' }); return res.end(); }
  let p = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!p.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const out = await r.fn(req, params, url.searchParams);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(out));
    }
    fail(404, 'Not found');
  } catch (e) {
    const status = e.status || 500; if (status === 500) console.error(e);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.status ? e.message : '서버 오류' }));
  }
}).listen(PORT, HOST, () => {
  autoCheckout();
  console.log(`SSSMS running → http://localhost:${PORT}  (student /student, admin /admin, kiosk /kiosk)`);
});
