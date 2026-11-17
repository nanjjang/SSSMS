// 관리자·키오스크 비밀번호 재설정 (서버 컴퓨터에서 직접 실행). 기존 로그인은 모두 끊긴다.
//   node --no-warnings server/passwd.js admin
//   운영 서버: sudo -u sssms SSSMS_DB=/opt/sssms/data/sssms.db node --no-warnings /opt/sssms/app/server/passwd.js kiosk
import { createInterface } from 'node:readline/promises';
import { db, hashPw, WEAK_PASSWORDS } from './db.js';

const loginId = process.argv[2];
const u = loginId && db.prepare('SELECT id, role FROM users WHERE login_id=?').get(loginId);
if (!u) { console.error('사용법: node server/passwd.js <아이디>   (예: admin, kiosk)'); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pw = (await rl.question(`'${loginId}' 새 비밀번호 (8자 이상): `)).trim();
rl.close();
if (pw.length < 8 || WEAK_PASSWORDS.includes(pw)) { console.error('8자 이상, 초기 비밀번호와 다른 값을 써주세요'); process.exit(1); }
db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(hashPw(pw), u.id);
db.prepare('DELETE FROM tokens WHERE user_id=?').run(u.id);
console.log('비밀번호를 바꿨습니다. 이 계정으로 로그인돼 있던 기기는 다시 로그인해야 합니다.');
