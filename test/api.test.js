import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { similarity, bestMatch } from '../server/face.js';
import { parseStudentProfile } from '../server/google.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3999; const B = `http://localhost:${PORT}`;
let srv;
const j = async (m, p, body, tok) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sssms-'));
  srv = spawn(process.execPath, ['--no-warnings', join(ROOT, 'server/index.js')], { env: { ...process.env, PORT, SSSMS_DB: join(dir, 't.db') }, stdio: 'pipe' });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('running') && res()));
});
after(() => srv.kill());

const rnd = (seed) => { let x = seed * 7919 + 1; return Array.from({ length: 1024 }, () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)); };
const jitter = (v, s) => v.map((x, i) => x + Math.sin(i * s) * 0.02);

test('similarity: same person scores higher than a different person', () => {
  const a = rnd(1), b = rnd(2);
  assert.ok(similarity(a, jitter(a, 3)) > 0.9);
  assert.ok(similarity(a, b) < 0.5);
  const m = bestMatch(jitter(a, 5), [{ id: 1, name: 'A', face: JSON.stringify([a]) }, { id: 2, name: 'B', face: JSON.stringify([b]) }]);
  assert.equal(m.id, 1);
});

test('full flow: enroll → identify (PAD) → checkin → checkout → blacklist', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const kiosk = (await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' })).body.token;
  const { users } = (await j('GET', '/api/admin/users', null, admin)).body;
  const stu = users.find((u) => !u.fixed_seat);
  const face = rnd(7);
  const enr = await j('POST', `/api/admin/users/${stu.id}/face`, { embeddings: [face, jitter(face, 1), jitter(face, 2)] }, admin);
  assert.equal(enr.status, 200, JSON.stringify(enr.body));

  const st = (await j('POST', '/api/login', { login_id: stu.login_id, password: '1234' })).body.token;
  assert.equal((await j('GET', '/api/admin/users', null, st)).status, 403);
  assert.equal((await j('POST', '/api/kiosk/identify', {}, st)).status, 403);

  const pad = { real: 0.9, live: 0.9, continuity: 0.9, challenge_passed: true };
  assert.equal((await j('POST', '/api/kiosk/identify', { embedding: face, pad: { ...pad, real: 0.1 } }, kiosk)).status, 422, 'spoof rejected');
  assert.equal((await j('POST', '/api/kiosk/identify', { embedding: face, pad: { ...pad, challenge_passed: false } }, kiosk)).status, 422, 'no challenge rejected');
  assert.equal((await j('POST', '/api/kiosk/identify', { embedding: rnd(99), pad }, kiosk)).status, 404, 'unknown face');

  const id1 = (await j('POST', '/api/kiosk/identify', { embedding: jitter(face, 4), pad }, kiosk)).body;
  assert.equal(id1.user.id, stu.id); assert.equal(id1.action, 'checkin');
  const seats = (await j('GET', '/api/seats', null, kiosk)).body.seats;
  const fixed = seats.find((s) => s.type === 'fixed');
  assert.equal((await j('POST', '/api/kiosk/checkin', { ticket: id1.ticket, seat_id: fixed.id }, kiosk)).status, 400, 'cannot take fixed seat');
  const id1b = (await j('POST', '/api/kiosk/identify', { embedding: face, pad }, kiosk)).body;
  const free = seats.find((s) => s.type === 'free' && !s.occupied);
  assert.equal((await j('POST', '/api/kiosk/checkin', { ticket: id1b.ticket, seat_id: free.id }, kiosk)).status, 200);
  assert.equal((await j('POST', '/api/kiosk/checkin', { ticket: id1b.ticket, seat_id: free.id }, kiosk)).status, 400, 'ticket single-use');
  assert.ok((await j('GET', '/api/seats', null, st)).body.seats.find((s) => s.id === free.id).mine);

  const id2 = (await j('POST', '/api/kiosk/identify', { embedding: face, pad }, kiosk)).body;
  assert.equal(id2.action, 'checkout');
  assert.equal((await j('POST', '/api/kiosk/checkout', { ticket: id2.ticket }, kiosk)).status, 200);

  const stats = (await j('GET', '/api/me/stats', null, st)).body;
  assert.equal(stats.heatmap.length, 120);
  assert.ok(stats.streak.current >= 1);

  await j('POST', `/api/admin/users/${stu.id}/blacklist`, { on: true, reason: '테스트' }, admin);
  assert.equal((await j('POST', '/api/kiosk/identify', { embedding: face, pad }, kiosk)).status, 403);
});

test('fixed-seat student is auto-assigned; eviction candidates computed', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const kiosk = (await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' })).body.token;
  const { users } = (await j('GET', '/api/admin/users', null, admin)).body;
  const fx = users.find((u) => u.fixed_seat);
  const face = rnd(42);
  await j('POST', `/api/admin/users/${fx.id}/face`, { embeddings: [face, jitter(face, 1), jitter(face, 2)] }, admin);
  const id = (await j('POST', '/api/kiosk/identify', { embedding: face, pad: { real: 0.9, live: 0.9, continuity: 0.9, challenge_passed: true } }, kiosk)).body;
  assert.equal(id.fixed_seat.label, fx.fixed_seat);
  const r = await j('POST', '/api/kiosk/checkin', { ticket: id.ticket }, kiosk);
  assert.equal(r.body.seat, fx.fixed_seat);
  const c = await j('GET', '/api/admin/candidates', null, admin);
  assert.equal(c.status, 200); assert.ok(Array.isArray(c.body.candidates));
});

test('boards: student sees only own inquiries; notices are admin-only to write', async () => {
  const a = (await j('POST', '/api/login', { login_id: '20002', password: '1234' })).body.token;
  const b = (await j('POST', '/api/login', { login_id: '20003', password: '1234' })).body.token;
  assert.equal((await j('POST', '/api/posts', { board: 'inquiry', title: '에어컨', body: '더워요' }, a)).status, 200);
  assert.equal((await j('GET', '/api/posts?board=inquiry', null, a)).body.posts.length, 1);
  assert.equal((await j('GET', '/api/posts?board=inquiry', null, b)).body.posts.length, 0);
  assert.equal((await j('POST', '/api/posts', { board: 'notice', title: 'x', body: 'y' }, a)).status, 403);
  assert.ok((await j('GET', '/api/posts?board=notice', null, b)).body.posts.length >= 1);
});

test('google profile → 학번/이름 파싱', () => {
  assert.deepEqual(parseStudentProfile({ name: '20105 홍길동', email: 'x@sunrint.hs.kr' }), { studentNo: '20105', name: '홍길동', grade: 2, class_no: 1, number: 5 });
  assert.equal(parseStudentProfile({ name: '홍길동', email: 's30212@sunrint.hs.kr' }).studentNo, '30212');
  assert.equal(parseStudentProfile({ name: '홍길동', email: 'gildong@sunrint.hs.kr' }).studentNo, null);
});
