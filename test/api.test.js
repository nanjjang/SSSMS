process.env.TZ = 'Asia/Seoul'; // 서버와 같은 시간대로 운영 시간을 계산
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { similarity, bestMatch } from '../server/face.js';
import { parseStudentProfile, sameName } from '../server/google.js';
import { reserveGoogleVerification } from '../server/security.js';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3999; const B = `http://localhost:${PORT}`;
let srv, dir;
const j = async (m, p, body, tok, headers = {}) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PAD = { real: 0.9, live: 0.9, continuity: 0.9, challenge_passed: true, blinks: 1, motion: 0.01 };
let salt = 10;
// 키오스크 흐름: 서버 챌린지 받기 → 사람이 동작을 따라 하는 시간 → 결과 전송. 얼굴 벡터는 실제 카메라처럼 매번 조금씩 다르다.
async function identify(kiosk, face, padOver = {}, { exact = false, delay = 1300, nonce } = {}) {
  const ch = (await j('POST', '/api/kiosk/challenge', {}, kiosk)).body;
  await wait(delay);
  return j('POST', '/api/kiosk/identify', { embedding: exact ? face : jitter(face, ++salt), pad: { ...PAD, challenges: ch.plan, ...padOver }, nonce: nonce === undefined ? ch.nonce : nonce }, kiosk);
}
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sssms-'));
  srv = spawn(process.execPath, ['--no-warnings', join(ROOT, 'server/index.js')], { env: { ...process.env, PORT, SSSMS_DB: join(dir, 't.db'), GOOGLE_CLIENT_ID: '', KIOSK_ALLOWED_IPS: '', ADMIN_PASSWORD: '', KIOSK_PASSWORD: '', SEED_DEMO: '1' }, stdio: 'pipe' });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('running') && res()));
  // 테스트를 언제 돌리든 '지금'이 운영 시간 안에 들도록 맞춘다
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  assert.equal((await setHours(admin, -60, 60)).status, 200);
});
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const setHours = (admin, fromMin, toMin) => j('PUT', '/api/admin/settings', { open_time: hhmm(Date.now() + fromMin * 60000), close_time: hhmm(Date.now() + toMin * 60000) }, admin);
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

  const [spoof, noChallenge, unknown] = await Promise.all([identify(kiosk, face, { real: 0.1 }), identify(kiosk, face, { challenge_passed: false }), identify(kiosk, rnd(99))]);
  assert.equal(spoof.status, 422, 'spoof rejected');
  assert.equal(noChallenge.status, 422, 'no challenge rejected');
  assert.equal(unknown.status, 404, 'unknown face');

  const id1 = (await identify(kiosk, face)).body;
  assert.equal(id1.user.id, stu.id); assert.equal(id1.action, 'checkin');
  const seats = (await j('GET', '/api/seats', null, kiosk)).body.seats;
  const fixed = seats.find((s) => s.type === 'fixed');
  assert.equal((await j('POST', '/api/kiosk/checkin', { ticket: id1.ticket, seat_id: fixed.id }, kiosk)).status, 400, 'cannot take fixed seat');
  const id1b = (await identify(kiosk, face)).body;
  const free = seats.find((s) => s.type === 'free' && !s.occupied);
  assert.equal((await j('POST', '/api/kiosk/checkin', { ticket: id1b.ticket, seat_id: free.id }, kiosk)).status, 200);
  assert.equal((await j('POST', '/api/kiosk/checkin', { ticket: id1b.ticket, seat_id: free.id }, kiosk)).status, 400, 'ticket single-use');
  assert.ok((await j('GET', '/api/seats', null, st)).body.seats.find((s) => s.id === free.id).mine);

  const id2 = (await identify(kiosk, face)).body;
  assert.equal(id2.action, 'checkout');
  assert.equal((await j('POST', '/api/kiosk/checkout', { ticket: id2.ticket }, kiosk)).status, 200);

  const stats = (await j('GET', '/api/me/stats', null, st)).body;
  assert.equal(stats.heatmap.length, 120);
  assert.ok(stats.streak.current >= 1);

  await j('POST', `/api/admin/users/${stu.id}/blacklist`, { on: true, reason: '테스트' }, admin);
  assert.equal((await identify(kiosk, face)).status, 403);
  await j('POST', `/api/admin/users/${stu.id}/blacklist`, { on: false }, admin);
});

test('fixed-seat student is auto-assigned; eviction candidates computed', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const kiosk = (await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' })).body.token;
  const { users } = (await j('GET', '/api/admin/users', null, admin)).body;
  const fx = users.find((u) => u.fixed_seat);
  const face = rnd(42);
  await j('POST', `/api/admin/users/${fx.id}/face`, { embeddings: [face, jitter(face, 1), jitter(face, 2)] }, admin);
  const id = (await identify(kiosk, face)).body;
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

// ---------- 보안 ----------
test('대리 출석 방지: 라이브니스 값 누락·위조, 챌린지 없음·재사용, 같은 요청 재전송을 모두 거부', async () => {
  const kiosk = (await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' })).body.token;
  const face = rnd(7); // 첫 테스트에서 등록한 얼굴
  const ok = await identify(kiosk, face);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.score, undefined, '유사도 점수는 내보내지 않음');

  const cases = {
    'real 값 없음': [{ real: undefined }], 'live 값 없음': [{ live: undefined }], '숫자가 아닌 값': [{ real: '0.9' }],
    '깜빡임 정보 없음': [{ blinks: undefined }], '움직임 정보 없음': [{ motion: undefined }], '연속성 없음': [{ continuity: undefined }],
    '서버가 낸 것과 다른 챌린지': [{ challenges: ['mouth', 'mouth'] }],
    '챌린지 번호 없음': [{}, { nonce: null }], '가짜 챌린지 번호': [{}, { nonce: 'f'.repeat(32) }],
    '사람이 따라 할 수 없을 만큼 빠른 응답': [{}, { delay: 0 }],
  };
  const res = await Promise.all(Object.values(cases).map(([padOver, opt]) => identify(kiosk, face, padOver, opt)));
  Object.keys(cases).forEach((name, i) => assert.equal(res[i].status, 422, name));

  // 챌린지 번호는 한 번만 쓸 수 있다
  const ch = (await j('POST', '/api/kiosk/challenge', {}, kiosk)).body;
  await wait(1300);
  const req = { embedding: jitter(face, 777), pad: { ...PAD, challenges: ch.plan }, nonce: ch.nonce };
  assert.equal((await j('POST', '/api/kiosk/identify', req, kiosk)).status, 200);
  assert.equal((await j('POST', '/api/kiosk/identify', req, kiosk)).status, 422, '같은 요청 재전송');
  // 새 챌린지를 받아도 이전과 완전히 같은 얼굴 벡터는 거부
  assert.equal((await identify(kiosk, req.embedding, {}, { exact: true })).status, 422, '같은 얼굴 벡터 재사용');
  // 학생·관리자 토큰으로는 챌린지를 받을 수 없다
  const st = (await j('POST', '/api/login', { login_id: '20005', password: '1234' })).body.token;
  assert.equal((await j('POST', '/api/kiosk/challenge', {}, st)).status, 403);
});

test('한 사람의 얼굴을 두 학생에게 등록할 수 없다', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const { users } = (await j('GET', '/api/admin/users', null, admin)).body;
  const other = users.find((u) => !u.has_face);
  const mine = rnd(7); const fresh = rnd(1234);
  // 첫 샘플만 새 얼굴이고 나머지가 이미 등록된 얼굴이어도 걸러야 한다
  const r = await j('POST', `/api/admin/users/${other.id}/face`, { embeddings: [fresh, jitter(fresh, 1), jitter(mine, 2)] }, admin);
  assert.ok([400, 409].includes(r.status), `status ${r.status}`);
  assert.equal((await j('POST', `/api/admin/users/${other.id}/face`, { embeddings: [mine, jitter(mine, 1), jitter(mine, 2)] }, admin)).status, 409);
});

test('운영 시간 밖에는 키오스크로 입실할 수 없다 (퇴실·관리자 수동 입실은 가능)', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const kiosk = (await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' })).body.token;
  const face = rnd(7); // 첫 테스트에서 등록한 자율석 학생
  const stu = (await j('GET', '/api/admin/users', null, admin)).body.users.find((u) => u.has_face && !u.fixed_seat);
  try {
    await setHours(admin, 120, 180); // 운영 시간이 2시간 뒤에 시작
    const early = await identify(kiosk, face);
    assert.equal(early.status, 403); assert.match(early.body.error, /입실 시간/);

    // 운영 시간 안에 받은 입실 티켓도 시간이 지나면 쓸 수 없다
    await setHours(admin, -60, 60);
    const id = (await identify(kiosk, face)).body;
    const free = (await j('GET', '/api/seats', null, kiosk)).body.seats.find((s) => s.type === 'free' && !s.occupied);
    await setHours(admin, -180, -120); // 운영이 2시간 전에 끝남
    assert.equal((await j('POST', '/api/kiosk/checkin', { ticket: id.ticket, seat_id: free.id }, kiosk)).status, 403);

    // 선생님 수동 입실은 되고, 퇴실은 키오스크에서 언제든 가능
    assert.equal((await j('POST', `/api/admin/users/${stu.id}/checkin`, { seat_id: free.id }, admin)).status, 200);
    const out = await identify(kiosk, face);
    assert.equal(out.status, 200); assert.equal(out.body.action, 'checkout');
    assert.equal((await j('POST', '/api/kiosk/checkout', { ticket: out.body.ticket }, kiosk)).status, 200);

    // 자정을 넘기는 운영 시간, 시작=종료(종일 운영)
    await j('PUT', '/api/admin/settings', { open_time: hhmm(Date.now() - 3600000), close_time: hhmm(Date.now() - 7200000) }, admin);
    assert.equal((await identify(kiosk, face)).status, 200, '시작 1시간 전 ~ 다음 날까지 운영');
    await j('PUT', '/api/admin/settings', { open_time: '09:00', close_time: '09:00' }, admin);
    assert.equal((await identify(kiosk, face)).status, 200, '종일 운영');
  } finally { await setHours(admin, -60, 60); }
});

test('요청 하나로 서버가 죽지 않고, public 밖 파일은 내주지 않는다', async () => {
  for (const path of ['/%', '/%E0%A4%A', '/..%2f..%2fpackage.json', '/..%2fserver/index.js', '/.env', '/_vids/a.mp4', '/student/%00'])
    assert.ok([400, 403, 404].includes((await fetch(B + path)).status), path);
  const r = await fetch(B + '/student/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await j('POST', '/api/login', null)).status, 401, '본문 없는 요청');
  assert.equal((await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })).status, 400);
  assert.equal((await fetch(B + '/api/admin/attendance?date=x', { headers: { authorization: 'Bearer x' } })).status, 401);
});

test('좌석 배정 신원은 관리자에게만 보이고 학생은 본인 표시만 받는다', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const kiosk = (await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' })).body.token;
  const st = (await j('POST', '/api/login', { login_id: '20006', password: '1234' })).body.token;
  const me = (await j('GET', '/api/me', null, st)).body.user;
  assert.ok((await j('GET', '/api/seats', null, admin)).body.seats.some((s) => s.assigned_name));
  for (const s of (await j('GET', '/api/seats', null, kiosk)).body.seats)
    assert.deepEqual(Object.keys(s).sort(), ['id', 'label', 'occupied', 'type', 'x', 'y']);
  for (const s of (await j('GET', '/api/seats', null, st)).body.seats) {
    assert.equal(s.assigned_name, null);
    assert.ok(s.assigned_user_id == null || s.assigned_user_id === me.id);
  }
});

test('로그인 보호: 교차 출처 요청·초기 비밀번호 외부 로그인·대입 공격 차단, 토큰은 해시로 저장', async () => {
  const creds = { login_id: 'admin', password: 'admin1234' };
  // 다른 웹사이트가 보낼 수 있는 단순 요청(text/plain)은 받지 않는다
  assert.equal((await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(creds) })).status, 415);
  // 프록시(터널)를 거쳐 온 요청은 초기 비밀번호로 로그인할 수 없다
  assert.equal((await j('POST', '/api/login', creds, null, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
  assert.equal((await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' }, null, { 'cf-connecting-ip': '203.0.113.9' })).status, 403);
  const admin = (await j('POST', '/api/login', creds)).body.token;
  assert.ok(admin);
  // DB에는 토큰 원문이 없다
  const db = new DatabaseSync(join(dir, 't.db'), { readOnly: true });
  const rows = db.prepare('SELECT token FROM tokens').all(); db.close();
  assert.ok(rows.length > 0 && rows.every((r) => r.token !== admin && r.token.length === 64));
  // 비밀번호 대입: 10번 틀리면 올바른 비밀번호여도 잠시 차단
  for (let i = 0; i < 10; i++) assert.equal((await j('POST', '/api/login', { login_id: '20007', password: `wrong${i}` })).status, 401);
  assert.equal((await j('POST', '/api/login', { login_id: '20007', password: '1234' })).status, 429);
  assert.equal((await j('POST', '/api/login', { login_id: '20008', password: '1234' })).status, 200, '다른 계정은 영향 없음');
});

test('성공한 로그인을 제한하고 계정별 최근 세션 열 개만 유지한다', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const login_id = '39902'; const password = 'session-limit-password';
  assert.equal((await j('POST', '/api/admin/users', { login_id, name: '세션학생', password }, admin)).status, 200);
  const tokens = [];
  for (let i = 0; i < 20; i++) {
    const r = await j('POST', '/api/login', { login_id, password });
    assert.equal(r.status, 200); tokens.push(r.body.token);
  }
  assert.equal((await j('POST', '/api/login', { login_id, password })).status, 429);
  const db = new DatabaseSync(join(dir, 't.db'), { readOnly: true });
  const count = db.prepare('SELECT COUNT(*) c FROM tokens WHERE user_id=(SELECT id FROM users WHERE login_id=?)').get(login_id).c;
  db.close();
  assert.equal(count, 10);
  assert.equal((await j('GET', '/api/me', null, tokens[0])).status, 401, '가장 오래된 세션은 해제');
  assert.equal((await j('GET', '/api/me', null, tokens.at(-1))).status, 200, '최근 세션은 유지');
});

test('비밀번호 변경: 약한 비밀번호 거부, 변경 시 다른 로그인 세션 종료', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const a = (await j('POST', '/api/login', { login_id: '20004', password: '1234' })).body.token;
  const b = (await j('POST', '/api/login', { login_id: '20004', password: '1234' })).body.token;
  assert.equal((await j('POST', '/api/me/password', { current: '1234', next: 'short' }, a)).status, 400);
  assert.equal((await j('POST', '/api/me/password', { current: '1234', next: 'admin1234' }, a)).status, 400);
  assert.equal((await j('POST', '/api/me/password', { current: 'nope', next: 'long-enough-pw' }, a)).status, 400);
  assert.equal((await j('POST', '/api/me/password', { current: '1234', next: 'long-enough-pw' }, a)).status, 200);
  assert.equal((await j('GET', '/api/me', null, a)).status, 200, '바꾼 기기는 유지');
  assert.equal((await j('GET', '/api/me', null, b)).status, 401, '다른 기기는 로그아웃');
  assert.equal((await j('POST', '/api/login', { login_id: '20004', password: '1234' })).status, 401);

  // 키오스크 비밀번호를 바꾸면 켜져 있던 키오스크 세션이 모두 끊긴다 (토큰 유출 대응)
  const kiosk = (await j('POST', '/api/login', { login_id: 'kiosk', password: 'kiosk1234' })).body.token;
  assert.equal((await j('POST', '/api/admin/kiosk-password', { password: 'kiosk1234' }, admin)).status, 400);
  assert.equal((await j('POST', '/api/admin/kiosk-password', { password: 'new-kiosk-pass' }, kiosk)).status, 403);
  assert.equal((await j('POST', '/api/admin/kiosk-password', { password: 'new-kiosk-pass' }, admin)).status, 200);
  assert.equal((await j('POST', '/api/kiosk/challenge', {}, kiosk)).status, 401);
  assert.equal((await j('POST', '/api/login', { login_id: 'kiosk', password: 'new-kiosk-pass' }, null, { 'cf-connecting-ip': '203.0.113.9' })).status, 200, '새 비밀번호는 외부에서도 로그인 가능');
  // 관리자가 만든 학생은 기본 비밀번호 1234가 아니다
  assert.equal((await j('POST', '/api/admin/users', { login_id: '39901', name: '새학생' }, admin)).status, 200);
  assert.equal((await j('POST', '/api/login', { login_id: '39901', password: '1234' })).status, 401);
  assert.equal((await j('PUT', '/api/admin/settings', { close_time: '25:99' }, admin)).status, 400);
  assert.equal((await j('PUT', '/api/admin/settings', { match_threshold: '0' }, admin)).status, 400);
  assert.equal((await j('PUT', '/api/admin/settings', { close_time: '22:30', match_threshold: '0.6' }, admin)).status, 200);
});

test('구글 로그인 학번 직접 입력: 이름을 확인할 수 없으면 연결하지 않는다', () => {
  assert.ok(sameName('홍길동', '홍길동'));
  assert.ok(sameName('홍길동', '20105 홍길동'));
  assert.ok(!sameName('홍길동', '김철수'));
  // 이전에는 구글 이름에 한글이 없으면 확인을 건너뛰어 남의 학번에 연결할 수 있었다
  assert.ok(!sameName('홍길동', 'Attacker Kim'));
  assert.ok(!sameName('홍길동', ''));
  assert.ok(!sameName('', ''));
  assert.ok(sameName('John Smith', 'john smith'));
});

test('구글 검증 동시 작업은 IP별·전체 한도를 지키고 자리를 반환한다', () => {
  const perIp = Array.from({ length: 8 }, () => reserveGoogleVerification('203.0.113.10'));
  assert.ok(perIp.every((release) => typeof release === 'function'));
  assert.equal(reserveGoogleVerification('203.0.113.10'), null);
  perIp.pop()();
  const replacement = reserveGoogleVerification('203.0.113.10');
  assert.equal(typeof replacement, 'function');
  for (const release of [...perIp, replacement]) release();

  const global = Array.from({ length: 32 }, (_, i) => reserveGoogleVerification(`198.51.100.${i}`));
  assert.ok(global.every((release) => typeof release === 'function'));
  assert.equal(reserveGoogleVerification('192.0.2.1'), null);
  for (const release of global) release();
  const recovered = reserveGoogleVerification('192.0.2.1');
  assert.equal(typeof recovered, 'function'); recovered();
});

test('데모 학생의 초기 비밀번호(1234)로는 외부에서 로그인할 수 없다', async () => {
  assert.equal((await j('POST', '/api/login', { login_id: '20001', password: '1234' }, null, { 'cf-connecting-ip': '203.0.113.20' })).status, 403);
  assert.equal((await j('POST', '/api/login', { login_id: '20001', password: '1234' })).status, 200, '서버 컴퓨터에서는 가능 (개발용)');
});

test('관리자 구글 계정 목록에서 빠지면 로그인돼 있던 세션도 관리자 권한을 잃는다', async () => {
  const admin = (await j('POST', '/api/login', { login_id: 'admin', password: 'admin1234' })).body.token;
  const email = 'teacher@sunrint.hs.kr'; const token = 'g'.repeat(48);
  const db = new DatabaseSync(join(dir, 't.db'));
  const r = db.prepare("INSERT INTO users (role, login_id, name, pw_hash, email, google_sub, created_at) VALUES ('admin',?,?,?,?,?,?)").run(email, '선생님', 'x:y', email, 'sub-teacher', Date.now());
  db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), r.lastInsertRowid, Date.now());
  db.close();
  assert.equal((await j('PUT', '/api/admin/settings', { admin_emails: email }, admin)).status, 200);
  assert.equal((await j('GET', '/api/admin/users', null, token)).status, 200);
  assert.equal((await j('PUT', '/api/admin/settings', { admin_emails: 'other@sunrint.hs.kr' }, admin)).status, 200);
  assert.equal((await j('GET', '/api/admin/users', null, token)).status, 403, '목록에서 빠진 관리자');
  assert.equal((await j('GET', '/api/admin/users', null, admin)).status, 200, '비밀번호 관리자 계정은 영향 없음');
});

test('보안 헤더: 다른 사이트 iframe 삽입·<base> 주입 차단', async () => {
  const r = await fetch(B + '/student/');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy') || '', /base-uri 'self'/);
});
