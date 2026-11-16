import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.SSSMS_DB || join(root, 'data', 'sssms.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('student','admin','kiosk')),
  login_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  grade INTEGER, class_no INTEGER, number INTEGER,
  pw_hash TEXT NOT NULL,
  face TEXT,                      -- JSON: array of normalized embeddings
  blacklisted INTEGER NOT NULL DEFAULT 0,
  blacklist_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('free','fixed','disabled')),
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seat_id INTEGER REFERENCES seats(id) ON DELETE SET NULL,
  check_in INTEGER NOT NULL,
  check_out INTEGER,
  method TEXT NOT NULL DEFAULT 'face',
  auto_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_att_user ON attendance(user_id, check_in);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT NOT NULL CHECK (board IN ('inquiry','lost_report','lost_found','notice')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT, answered_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// migration: Google 계정 연동 컬럼
const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!cols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
if (!cols.includes('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub ON users(google_sub) WHERE google_sub IS NOT NULL');

export const DEFAULT_SETTINGS = {
  room_name: '야간자율학습실',
  admin_emails: '',
  open_time: '18:00',
  close_time: '23:00',
  absence_days: '3',
  daily_goal_min: '180',
  match_threshold: '0.6',
  match_margin: '0.05',
  antispoof_threshold: '0.5',
  liveness_threshold: '0.5',
  grid_cols: '10',
  grid_rows: '8',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}

export function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

export function hashPw(pw) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(pw), salt, 64).toString('hex')}`;
}
export function verifyPw(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(String(pw), salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Seed ----
const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (count === 0) {
  const now = Date.now();
  const ins = db.prepare('INSERT INTO users (role, login_id, name, grade, class_no, number, pw_hash, created_at) VALUES (?,?,?,?,?,?,?,?)');
  ins.run('admin', 'admin', '관리자', null, null, null, hashPw('admin1234'), now);
  ins.run('kiosk', 'kiosk', '출석 키오스크', null, null, null, hashPw('kiosk1234'), now);
  const names = ['김민준', '이서연', '박도윤', '최하은', '정시우', '강지아', '조예준', '윤수아'];
  names.forEach((n, i) => ins.run('student', `2${String(i + 1).padStart(4, '0')}`, n, 2, (i % 4) + 1, i + 1, hashPw('1234'), now));

  // default layout: 8 rows x 10 cols with aisle
  const seatIns = db.prepare('INSERT INTO seats (label, type, x, y, assigned_user_id) VALUES (?,?,?,?,?)');
  let n = 1;
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 10; x++) {
      if (x === 4) continue; // aisle
      const fixed = y < 2;
      const label = `${fixed ? 'A' : 'B'}${String(n).padStart(2, '0')}`;
      seatIns.run(label, fixed ? 'fixed' : 'free', x, y + (y >= 2 ? 1 : 0), null);
      n++;
    }
  }
  // assign first 3 students to fixed seats
  const fixedSeats = db.prepare("SELECT id FROM seats WHERE type='fixed' ORDER BY id LIMIT 3").all();
  const studs = db.prepare("SELECT id FROM users WHERE role='student' ORDER BY id LIMIT 3").all();
  fixedSeats.forEach((s, i) => db.prepare('UPDATE seats SET assigned_user_id=? WHERE id=?').run(studs[i].id, s.id));

  // demo attendance history (past 30 days) for streak/heatmap visuals
  const att = db.prepare('INSERT INTO attendance (user_id, seat_id, check_in, check_out, method) VALUES (?,?,?,?,?)');
  const allStud = db.prepare("SELECT id FROM users WHERE role='student'").all();
  for (const s of allStud) {
    for (let d = 30; d >= 1; d--) {
      if (Math.random() < 0.25) continue;
      const day = new Date(); day.setDate(day.getDate() - d); day.setHours(18, Math.floor(Math.random() * 40), 0, 0);
      const dur = (60 + Math.floor(Math.random() * 200)) * 60000;
      att.run(s.id, null, day.getTime(), day.getTime() + dur, 'seed');
    }
  }
  db.prepare("INSERT INTO posts (board, user_id, title, body, pinned, created_at) VALUES ('notice', 1, ?, ?, 1, ?)")
    .run('야간자율학습실 이용 안내', '운영시간: 18:00 ~ 23:00\n입실/퇴실은 반드시 키오스크 얼굴 인식으로 해주세요.\n지정석은 3일 연속 미출석 시 퇴출 후보가 됩니다.', now);
  console.log('[seed] admin/admin1234, kiosk/kiosk1234, students 20001~20008 / 1234');
}
