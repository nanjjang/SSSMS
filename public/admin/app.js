import { createApi, brand, h, fmtMin, fmtTime, fmtDT, toast, modal, renderSeatMap } from '/common/api.js';

const api = createApi('admin');
const app = document.getElementById('app');
let page = location.hash.slice(1) || 'dash';
let badges = {};

api.onUnauthorized = () => renderLogin();
window.addEventListener('hashchange', async () => {
  page = location.hash.slice(1) || 'dash';
  const m = document.getElementById('main'); if (!m) return renderShell();
  document.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === page));
  document.getElementById('side')?.classList.remove('open');
  try { await ({ dash, seats, att, students, evict, black, inquiry, lost, notice, settings })[page](); } catch (e) { m.innerHTML = `<div class="panel empty-state">${h(e.message)}</div>`; }
  m.classList.remove('enter'); void m.offsetWidth; m.classList.add('enter'); scrollTo(0, 0);
});

async function boot() {
  if (!api.token.get()) return renderLogin();
  try { const me = (await api.get('/api/me')).user; if (me.role !== 'admin') throw 0; renderShell(); }
  catch { api.token.set(null); renderLogin(); }
}
function renderLogin() {
  app.innerHTML = `<div class="login"><form class="login-card"><img src="/assets/logo.svg" alt="선린인터넷고등학교" onerror="this.remove()">
    <h1>선린 야자실 관리자</h1><p>감독 선생님 계정으로 로그인해 주세요</p>
    <label class="field">아이디<input class="input" name="id" autocomplete="username" required></label>
    <label class="field">비밀번호<input class="input" type="password" name="pw" autocomplete="current-password" required></label>
    <button class="btn primary">로그인</button></form></div>`;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try { const u = await api.login(e.target.id.value, e.target.pw.value); if (u.role !== 'admin') { await api.logout(); throw new Error('관리자 계정이 아닙니다'); } renderShell(); }
    catch (err) { toast(err.message, 'error'); }
  };
}

const GROUPS = [
  ['운영', [['dash', 'layout-dashboard', '', '오늘 현황'], ['att', 'calendar', '', '출석 내역'], ['seats', 'layout-grid', '', '좌석 배치']]],
  ['학생', [['students', 'users', '', '학생 관리'], ['evict', 'user-minus', '', '지정석 퇴출 후보'], ['black', 'ban', '', '입실 제한']]],
  ['게시판', [['inquiry', 'message', '', '문의·건의'], ['lost', 'package', '', '분실물'], ['notice', 'speakerphone', '', '공지사항']]],
  ['', [['settings', 'settings', '', '설정']]],
];
async function renderShell() {
  app.innerHTML = `
  <header class="topbar"><button class="tb-menu" id="menu" aria-label="메뉴"><i class="ti ti-menu-2"></i></button>
    <img src="/assets/logo.svg" alt=""><b>선린 야자실</b><span class="tb-sep"></span><span class="tb-sub">관리자</span>
    <span class="grow"></span><span class="tb-user"><span class="av"><i class="ti ti-user"></i></span><span>관리자</span></span><button class="btn sm ghost" id="logout">로그아웃</button></header>
  <div class="layout"><aside id="side"><nav>
    ${GROUPS.map(([g, items]) => `${g ? `<p class="grp">${g}</p>` : '<div class="gsep"></div>'}${items.map(([k, ic, c, l]) => `<button data-p="${k}" class="${page === k ? 'on' : ''}"><i class="ti ti-${ic} nic2"></i>${l}${badges[k] ? `<span class="n">${badges[k]}</span>` : ''}</button>`).join('')}`).join('')}
  </nav></aside>
  <main id="main"><div class="empty-state">불러오는 중이에요</div></main></div>`;
  app.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => { location.hash = b.dataset.p; });
  app.querySelector('#menu').onclick = () => app.querySelector('#side').classList.toggle('open');
  app.querySelector('#logout').onclick = async () => { await api.logout(); renderLogin(); };
  try { await ({ dash, seats, att, students, evict, black, inquiry, lost, notice, settings })[page](); }
  catch (e) { main().innerHTML = `<div class="panel empty-state">${h(e.message)}</div>`; }
}
const main = () => document.getElementById('main');
const SUBS_UNUSED = { dash: '오늘 야자실 상황을 한눈에 봐요', seats: '칸을 눌러 좌석을 놓고, 지정석은 학번·이름에 부여해요', att: '날짜별 입실·퇴실 기록', students: '학생은 학교 구글 계정으로 로그인하면 학번으로 이 명단과 연결돼요', evict: '지정석을 받고도 연속으로 나오지 않은 학생', black: '입실이 제한된 학생', inquiry: '학생 문의·건의에 답변해요', lost: '습득물 보관함과 학생 분실 신고', notice: '학생 앱 공지 탭에 보여요', settings: '운영 시간, 인식 기준, 관리자 계정' };
const title = (t, right = '', sub = '') => `<div class="pagehead"><div><h1>${t}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="row">${right}</div></div>`;
const won = (n) => Number(n || 0).toLocaleString('ko-KR');

// ---------- 대시보드 (토스페이먼츠 정산 달력 방식) ----------
let calMonth = null;
async function dash() {
  const d = await api.get('/api/admin/dashboard');
  badges = { inquiry: d.open_inquiries || 0, evict: d.candidates || 0 };
  document.querySelectorAll('[data-p]').forEach((b) => { const n = badges[b.dataset.p]; b.querySelector('.n')?.remove(); if (n) b.insertAdjacentHTML('beforeend', `<span class="n">${n}</span>`); });
  const seatCnt = Object.fromEntries(d.seats.map((s) => [s.type, s.c]));
  const now = new Date();
  const total = (seatCnt.free || 0) + (seatCnt.fixed || 0);
  const used = d.present.length;
  main().innerHTML = `
  ${title('오늘 현황', '<button class="btn" id="rf"><i class="ti ti-refresh"></i>새로고침</button><a class="btn primary" href="#students"><i class="ti ti-user-plus"></i>학생 관리</a>', `${now.getMonth() + 1}월 ${now.getDate()}일 ${'일월화수목금토'[now.getDay()]}요일 · 운영 ${h(d.open_time)} 시작`)}
  ${d.open_inquiries || d.candidates ? `<a class="abnr" href="#${d.open_inquiries ? 'inquiry' : 'evict'}"><i class="ti ti-bell"></i><span>${[d.open_inquiries ? `답변을 기다리는 문의 <b>${d.open_inquiries}건</b>` : '', d.candidates ? `지정석 퇴출 후보 <b>${d.candidates}명</b>` : ''].filter(Boolean).join(' · ')}</span><i class="ti ti-chevron-right chev"></i></a>` : ''}
  <div class="strip" style="--n:4">
    <div><span>지금 공부 중</span><b>${used}명</b></div>
    <div><span>오늘 출석</span><b>${d.today_count}명<small>/ ${d.students}명</small></b></div>
    <div><span>아직 안 온 지정석</span><b class="${d.absent_fixed.length ? 'warn' : ''}">${d.absent_fixed.length}명</b></div>
    <a href="#inquiry"><span>답변 대기 문의</span><b>${d.open_inquiries}건</b></a>
  </div>
  <div class="dgrid">
    <div class="panel"><div class="cal-head"><h2 id="calt"></h2><button class="sq" id="prev" aria-label="이전 달"><i class="ti ti-chevron-left"></i></button><button class="sq" id="next" aria-label="다음 달"><i class="ti ti-chevron-right"></i></button>
        <span class="grow"></span><span class="lg">출석 인원 · 총 공부 시간</span></div>
      <div class="cal" id="cal"></div></div>
    <div class="dside">
      <div class="panel"><div class="panel-h"><h2>아직 안 온 지정석 학생<span class="cnt ${d.absent_fixed.length ? 'warn' : ''}">${d.absent_fixed.length}</span></h2></div>
        <div class="plist">${d.absent_fixed.map((p) => `<div><span class="ini sm seat out">${h(p.label)}</span><div><b>${h(p.name)}</b><small>${h(p.login_id)}</small></div><button class="btn sm" data-in="${p.id}">수동 입실</button></div>`).join('') || '<div class="empty-mini">지정석 학생이 모두 왔어요</div>'}</div>
        <p class="panel-foot">야자 시작(${h(d.open_time)}) 뒤에도 오지 않으면 연락이 필요해요</p></div>
      <div class="panel"><div class="panel-h"><h2>입실 중<span class="cnt">${used}</span></h2></div>
        <div class="plist">${d.present.map((p) => `<div><span class="ini sm seat">${h(p.label || '-')}</span><div><b>${h(p.name)}</b><small>${fmtTime(p.check_in)} 입실 · ${fmtMin((Date.now() - p.check_in) / 60000)}</small></div><button class="btn sm ghost" data-out="${p.user_id}">퇴실</button></div>`).join('') || '<div class="empty-mini">입실한 학생이 없어요</div>'}</div></div>
      <div class="panel"><div class="panel-h"><h2>좌석</h2><span class="meta">${used} / ${total}석 사용</span></div>
        <div class="seatbar"><i class="a" style="flex:${used}"></i><i class="b" style="flex:${Math.max(0, (seatCnt.free || 0) - used)}"></i><i class="c" style="flex:${seatCnt.fixed || 0}"></i></div>
        <div class="kv"><div><span class="dot a"></span>사용 중<span class="r">${used}석</span></div><div><span class="dot b"></span>자율석<span class="r">${seatCnt.free || 0}석</span></div><div><span class="dot c"></span>지정석<span class="r">${seatCnt.fixed || 0}석</span></div></div></div>
    </div>
  </div>`;
  main().querySelector('#rf').onclick = dash;
  main().querySelectorAll('[data-out]').forEach((b) => b.onclick = async () => { await api.post(`/api/admin/users/${b.dataset.out}/checkout`); toast('퇴실 처리했어요', 'ok'); dash(); });
  main().querySelectorAll('[data-in]').forEach((b) => b.onclick = async () => { try { await api.post(`/api/admin/users/${b.dataset.in}/checkin`, {}); toast('입실 처리했어요', 'ok'); dash(); } catch (e) { toast(e.message, 'error'); } });
  calMonth ||= `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const shift = (n) => { const [y, m] = calMonth.split('-').map(Number); const t = new Date(y, m - 1 + n, 1); calMonth = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; drawCal(); };
  main().querySelector('#prev').onclick = () => shift(-1); main().querySelector('#next').onclick = () => shift(1);
  drawCal();
}
async function drawCal() {
  const { days } = await api.get(`/api/admin/calendar?month=${calMonth}`);
  const [y, m] = calMonth.split('-').map(Number);
  document.getElementById('calt').textContent = `${y}년 ${m}월`;
  const first = new Date(y, m - 1, 1); const startPad = first.getDay(); const n = new Date(y, m, 0).getDate();
  const today = new Date(); const tk = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push('<div class="cd out"></div>');
  for (let dd = 1; dd <= n; dd++) {
    const k = `${calMonth}-${String(dd).padStart(2, '0')}`; const v = days[k]; const wd = (startPad + dd - 1) % 7;
    cells.push(`<div class="cd ${k === tk ? 'today' : ''}"><span class="dn ${wd === 0 ? 'sun' : ''}">${dd}</span>
      ${k > tk ? '' : v ? `<span class="v1">${v.count}명</span><span class="v2">${fmtMin(v.minutes)}</span>` : '<span class="none">기록 없음</span>'}</div>`);
  }
  document.getElementById('cal').innerHTML = `${'일월화수목금토'.split('').map((w) => `<div class="wh">${w}</div>`).join('')}${cells.join('')}`;
}

// ---------- 좌석 배치 ----------
async function seats() {
  const [d, { users }] = await Promise.all([api.get('/api/seats'), api.get('/api/admin/users')]);
  let cols = d.cols, rows = d.rows; let tool = 'free'; let sel = null;
  let list = d.seats.map((s) => ({ id: s.id, label: s.label, type: s.type, x: s.x, y: s.y, assigned_user_id: s.assigned_user_id }));
  const at = (x, y) => list.find((s) => s.x === x && s.y === y);
  const nextLabel = (type) => {
    const p = type === 'fixed' ? 'A' : type === 'free' ? 'B' : 'X';
    let n = 1; const used = new Set(list.map((s) => s.label));
    while (used.has(`${p}${String(n).padStart(2, '0')}`)) n++; return `${p}${String(n).padStart(2, '0')}`;
  };
  main().innerHTML = `${title('좌석 배치', '<button class="btn" id="renum"><i class="ti ti-sort-ascending-numbers"></i>번호 자동 정렬</button><button class="btn primary" id="save">저장</button>', '칸을 누르거나 드래그해서 좌석을 놓아요. 빈 칸은 통로예요.')}
  <div class="grid-2"><div class="panel">
    <div class="tools">
      <div class="seg">${[['free', '자율석'], ['fixed', '지정석'], ['disabled', '사용 불가'], ['erase', '지우기'], ['select', '선택']].map(([k, l]) => `<button class="${tool === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
      <span class="grow"></span>
      <label class="num-in">열<input class="input" id="cols" type="number" min="3" max="30" value="${cols}"></label>
      <label class="num-in">행<input class="input" id="rows" type="number" min="3" max="30" value="${rows}"></label>
    </div>
    <div class="ed-wrap"><div class="ed-front">교실 앞 · 칠판 · 감독석</div><div class="editor" id="ed"></div></div>
    <div class="legend ed"><span><i class="sw free"></i>자율석</span><span><i class="sw fx"></i>지정석</span><span><i class="sw dis"></i>사용 불가</span></div></div>
    <div class="panel" id="panel"></div></div>`;
  const ed = main().querySelector('#ed');
  let drag = false;
  const apply = (x, y) => {
    const s = at(x, y);
    if (tool === 'select') { sel = s || null; return draw(); }
    if (tool === 'erase') { if (s) list = list.filter((v) => v !== s); return draw(); }
    if (s) { if (s.type !== tool) { s.type = tool; if (tool !== 'fixed') s.assigned_user_id = null; } }
    else list.push({ label: nextLabel(tool), type: tool, x, y, assigned_user_id: null });
    draw();
  };
  function draw() {
    ed.style.setProperty('--cols', cols); ed.innerHTML = '';
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const s = at(x, y); const b = document.createElement('button');
      b.className = `c ${s ? s.type : ''} ${sel && s === sel ? 'sel' : ''}`;
      b.textContent = s ? s.label : '';
      if (s?.assigned_user_id) b.title = users.find((u) => u.id === s.assigned_user_id)?.name || '';
      b.onmousedown = (e) => { e.preventDefault(); drag = tool !== 'select'; apply(x, y); };
      b.onmouseenter = () => { if (drag) apply(x, y); };
      ed.append(b);
    }
    const f = list.filter((s) => s.type === 'free').length, fx = list.filter((s) => s.type === 'fixed').length;
    const p = main().querySelector('#panel');
    p.innerHTML = `<div class="panel-h"><h2>요약</h2></div><div class="sum"><div><span>자율석</span><b>${f}</b></div><div><span>지정석</span><b>${fx}</b></div><div><span>배정됨</span><b>${list.filter((s) => s.assigned_user_id).length}</b></div></div>
      <div class="panel-foot" style="border:0;margin-top:24px;padding-top:0">
      ${sel ? `<div class="panel-h" style="margin-top:8px"><h2>좌석 ${h(sel.label)}</h2></div><div class="form">
        <label class="field">좌석 번호<input class="input" id="sl" value="${h(sel.label)}"></label>
        <label class="field">유형<select class="input" id="st">${[['free', '자율석'], ['fixed', '지정석'], ['disabled', '사용 불가']].map(([k, l]) => `<option value="${k}" ${sel.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${sel.type === 'fixed' ? `<label class="field">배정 학생<select class="input" id="su"><option value="">배정 안 함</option>${users.map((u) => `<option value="${u.id}" ${sel.assigned_user_id === u.id ? 'selected' : ''} ${list.some((s) => s !== sel && s.assigned_user_id === u.id) ? 'disabled' : ''}>${h(u.login_id)} ${h(u.name)}</option>`).join('')}</select></label>` : ''}
        <div><button class="btn sm danger" id="sdel"><i class="ti ti-trash"></i>좌석 삭제</button></div></div>` : '<p class="desc">위 도구에서 <b>선택</b>을 고른 뒤 좌석을 누르면 번호, 유형, 배정 학생을 바꿀 수 있어요. 저장하기 전까지는 학생 화면에 반영되지 않아요.</p>'}</div>`;
    if (sel) {
      p.querySelector('#sl').onchange = (e) => { sel.label = e.target.value.trim(); draw(); };
      p.querySelector('#st').onchange = (e) => { sel.type = e.target.value; if (sel.type !== 'fixed') sel.assigned_user_id = null; draw(); };
      p.querySelector('#su')?.addEventListener('change', (e) => { sel.assigned_user_id = e.target.value ? Number(e.target.value) : null; draw(); });
      p.querySelector('#sdel').onclick = () => { list = list.filter((v) => v !== sel); sel = null; draw(); };
    }
  }
  document.onmouseup = () => { drag = false; };
  main().querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { tool = b.dataset.t; main().querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b)); if (tool !== 'select') sel = null; draw(); });
  main().querySelector('#cols').onchange = (e) => { cols = Math.max(3, Math.min(30, +e.target.value)); list = list.filter((s) => s.x < cols); draw(); };
  main().querySelector('#rows').onchange = (e) => { rows = Math.max(3, Math.min(30, +e.target.value)); list = list.filter((s) => s.y < rows); draw(); };
  main().querySelector('#renum').onclick = () => {
    const cnt = { free: 0, fixed: 0, disabled: 0 };
    [...list].sort((a, b) => a.y - b.y || a.x - b.x).forEach((s) => { cnt[s.type]++; s.label = `${({ fixed: 'A', free: 'B', disabled: 'X' })[s.type]}${String(cnt[s.type]).padStart(2, '0')}`; });
    draw();
  };
  main().querySelector('#save').onclick = async () => {
    try { await api.put('/api/admin/seats', { seats: list, cols, rows }); toast('좌석 배치가 저장되었습니다', 'ok'); seats(); }
    catch (e) { toast(e.message, 'error'); }
  };
  draw();
}

// ---------- 출석 현황 ----------
async function att(date) {
  const today = new Date(); const def = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const d = await api.get(`/api/admin/attendance?date=${date || def}`);
  const total = d.rows.reduce((a, r) => a + ((r.check_out || Date.now()) - r.check_in) / 60000, 0);
  const people = new Set(d.rows.map((r) => r.user_id)).size;
  main().innerHTML = `${title('출석 내역', `<input type="date" class="input" id="dt" value="${d.date}" style="width:auto"><button class="btn" id="csv"><i class="ti ti-download"></i>CSV 내보내기</button>`, '날짜별 입실 · 퇴실 기록')}
  <div class="strip" style="--n:3"><div><span>출석</span><b>${people}명</b></div><div><span>미출석</span><b>${d.absent.length}명</b></div><div><span>총 공부 시간</span><b>${fmtMin(total)}</b></div></div>
  <div class="grid-2"><div class="panel flush"><div class="panel-h"><h2>입 · 퇴실 기록<span class="cnt">${d.rows.length}</span></h2></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>학생</th><th>좌석</th><th>입실</th><th>퇴실</th><th>시간</th><th class="hide-m">방식</th></tr></thead><tbody>
    ${d.rows.map((r) => `<tr><td><b>${h(r.name)}</b> <span class="sub">${h(r.login_id)}</span></td><td>${h(r.label || '-')}</td><td>${fmtTime(r.check_in)}</td><td>${r.check_out ? fmtTime(r.check_out) : '<span class="badge ok">입실 중</span>'}${r.auto_out ? ' <span class="tag">자동</span>' : ''}</td>
      <td>${fmtMin(((r.check_out || Date.now()) - r.check_in) / 60000)}</td><td class="hide-m sub">${({ face: '얼굴 인식', manual: '수동', seed: '기록' })[r.method] || h(r.method)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-state">이 날은 입실 기록이 없어요</td></tr>'}
  </tbody></table></div></div>
  <div class="panel"><div class="panel-h"><h2>미출석 학생<span class="cnt">${d.absent.length}</span></h2></div><div class="plist" style="max-height:560px">${d.absent.map((u) => `<div><span class="ini sm">${h(u.name.slice(-2))}</span><div><b>${h(u.name)}</b><small>${h(u.login_id)}</small></div><button class="btn sm" data-in="${u.id}">수동 입실</button></div>`).join('') || '<div class="empty-mini">모두 출석했어요</div>'}</div></div></div>`;
  main().querySelector('#dt').onchange = (e) => att(e.target.value);
  main().querySelector('#csv').onclick = () => {
    const lines = [['학번', '이름', '좌석', '입실', '퇴실', '분'].join(',')].concat(d.rows.map((r) => [r.login_id, r.name, r.label || '', new Date(r.check_in).toLocaleString('ko-KR'), r.check_out ? new Date(r.check_out).toLocaleString('ko-KR') : '', Math.round(((r.check_out || Date.now()) - r.check_in) / 60000)].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' })); a.download = `attendance_${d.date}.csv`; a.click();
  };
  main().querySelectorAll('[data-in]').forEach((b) => b.onclick = () => manualCheckin(Number(b.dataset.in), () => att(d.date)));
}
async function manualCheckin(uid, done) {
  const sd = await api.get('/api/seats');
  const fixed = sd.seats.find((s) => s.assigned_user_id === uid && s.type === 'fixed');
  if (fixed) { try { await api.post(`/api/admin/users/${uid}/checkin`, {}); toast(`지정석 ${fixed.label} 입실 처리`, 'ok'); done(); } catch (e) { toast(e.message, 'error'); } return; }
  modal('<h2>수동 입실 · 좌석 선택</h2><p class="desc" style="margin:-8px 0 16px">빈 자율석을 누르면 바로 입실 처리돼요.</p><div id="pm"></div><div class="mbtns" style="margin-top:20px"><button class="btn" data-close>취소</button></div>', {
    onMount: (m, close) => renderSeatMap(m.querySelector('#pm'), sd, {
      pickable: (s, st) => st === 'free',
      onPick: async (s) => { try { await api.post(`/api/admin/users/${uid}/checkin`, { seat_id: s.id }); toast('입실 처리되었습니다', 'ok'); close(); done(); } catch (e) { toast(e.message, 'error'); } },
    }),
  });
}

// ---------- 학생 (토스플레이스 상품 관리 방식: 칩 필터 · 검색 · 토글) ----------
let stFilter = 'all';
async function students() {
  const { users } = await api.get('/api/admin/users');
  const F = [['all', '전체'], ['g1', '1학년'], ['g2', '2학년'], ['g3', '3학년'], ['in', '입실 중'], ['noface', '얼굴 미등록'], ['nogoogle', '구글 미연결']];
  const match = (u) => ({ all: true, g1: u.grade === 1, g2: u.grade === 2, g3: u.grade === 3, in: u.present, noface: !u.has_face, nogoogle: !u.email })[stFilter];
  main().innerHTML = `
  ${title('학생 관리', '<button class="btn" id="bulk"><i class="ti ti-list-details"></i>명단 한 번에 등록</button><button class="btn primary" id="add"><i class="ti ti-plus"></i>학생 추가</button>', '학생이 학교 구글 계정으로 로그인하면 학번으로 이 명단과 연결돼요')}
  <div class="row wrap" style="gap:12px;margin-bottom:16px"><label class="search"><i class="ti ti-search"></i><input id="q" placeholder="이름 또는 학번 검색" aria-label="학생 검색"></label></div>
  <div class="chips">${F.map(([k, l]) => `<button data-f="${k}" class="${stFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  <div class="panel flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>학생 <span class="cnum" id="cnt"></span></th><th>지정석</th><th class="hide-m">구글 계정</th><th>얼굴</th><th class="hide-m">최근 출석</th><th class="c">입실 허용</th><th></th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  const tb = main().querySelector('#tb');
  const draw = () => {
    const q = main().querySelector('#q').value.trim();
    const list = users.filter((u) => match(u) && (!q || u.name.includes(q) || u.login_id.includes(q)));
    main().querySelector('#cnt').textContent = `${list.length}명`;
    tb.innerHTML = list.map((u) => `<tr>
      <td><div class="who-cell"><span class="ini">${h(u.name.slice(-2))}</span><div><b>${h(u.name)}</b><small>${h(u.login_id)} · ${u.grade ?? '-'}학년 ${u.class_no ?? '-'}반</small></div>${u.present ? '<span class="badge ok">입실 중</span>' : ''}</div></td>
      <td>${u.fixed_seat ? `<b>${h(u.fixed_seat)}</b>` : '<span class="sub">–</span>'}</td>
      <td class="hide-m sub">${u.email ? h(u.email) : '미연결'}</td>
      <td>${u.has_face ? '<span class="badge ok">등록됨</span>' : `<button class="btn sm soft" data-face="${u.id}">등록하기</button>`}</td>
      <td class="hide-m sub">${u.last_in ? fmtDT(u.last_in) : '–'}</td>
      <td class="c"><label class="sw-t"><input type="checkbox" data-allow="${u.id}" ${u.blacklisted ? '' : 'checked'}><i></i></label></td>
      <td class="r"><button class="btn sm ghost" data-edit="${u.id}">수정</button>${u.has_face ? `<button class="btn sm ghost" data-face="${u.id}">재등록</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-state">조건에 맞는 학생이 없어요. 검색어나 필터를 바꿔 보세요.</td></tr>';
    tb.querySelectorAll('[data-face]').forEach((b) => b.onclick = () => enrollFace(users.find((u) => u.id === +b.dataset.face)));
    tb.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editStudent(users.find((u) => u.id === +b.dataset.edit)));
    tb.querySelectorAll('[data-allow]').forEach((c) => c.onchange = async () => {
      const u = users.find((x) => x.id === +c.dataset.allow);
      if (!c.checked) { const reason = prompt(`${u.name} 학생의 입실을 막을까요? 사유를 적어주세요`); if (reason == null) { c.checked = true; return; } await api.post(`/api/admin/users/${u.id}/blacklist`, { on: true, reason }); u.blacklisted = true; toast('입실을 제한했어요'); }
      else { await api.post(`/api/admin/users/${u.id}/blacklist`, { on: false }); u.blacklisted = false; toast('입실 제한을 풀었어요'); }
    });
  };
  main().querySelector('#q').oninput = draw;
  main().querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { stFilter = b.dataset.f; main().querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); draw(); });
  main().querySelector('#add').onclick = () => editStudent(null);
  main().querySelector('#bulk').onclick = () => modal(`<form class="stack"><h2>명단 한 번에 등록</h2>
    <p class="desc" style="margin-top:-8px">한 줄에 한 명씩 학번, 이름을 적어주세요. 엑셀에서 두 열을 복사해 붙여넣어도 돼요.</p>
    <textarea class="input" name="t" rows="10" placeholder="20101, 김민준&#10;20102, 이서연" required></textarea>
    <div class="mbtns"><button type="button" class="btn" data-close>취소</button><button class="btn primary">등록하기</button></div></form>`, {
    onMount: (m, close) => m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const rows = e.target.t.value.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [login_id, ...n] = l.split(/[,\t]+|\s+/); return { login_id, name: n.join(' ').trim() }; });
      try { const r = await api.post('/api/admin/users/bulk', { rows }); toast(`${r.created}명 추가 · ${r.updated}명 갱신${r.errors.length ? ` · ${r.errors.length}건 오류` : ''}`, r.errors.length ? 'error' : 'ok'); close(); students(); }
      catch (err) { toast(err.message, 'error'); }
    },
  });
  draw();
}
function editStudent(u) {
  modal(`<form class="stack"><h2>${u ? '학생 정보 수정' : '학생 추가'}</h2>
    <div class="row"><label class="field grow">학번<input class="input" name="login_id" value="${h(u?.login_id || '')}" ${u ? 'disabled' : 'required'}></label><label class="field grow">이름<input class="input" name="name" value="${h(u?.name || '')}" required></label></div>
    <div class="row"><label class="field grow">학년<input class="input" type="number" name="grade" value="${u?.grade ?? ''}"></label><label class="field grow">반<input class="input" type="number" name="class_no" value="${u?.class_no ?? ''}"></label><label class="field grow">번호<input class="input" type="number" name="number" value="${u?.number ?? ''}"></label></div>
    <label class="field">${u ? '비밀번호 재설정 (비우면 유지)' : '초기 비밀번호 (기본 1234)'}<input class="input" name="password" type="password" autocomplete="new-password"></label>
    <div class="mbtns">${u ? `<span class="left row">${u.has_face ? '<button type="button" class="btn sm ghost danger" id="dface">얼굴 삭제</button>' : ''}<button type="button" class="btn sm ghost danger" id="del">학생 삭제</button></span>` : ''}<button type="button" class="btn" data-close>취소</button><button class="btn primary">저장</button></div></form>`, {
    onMount: (m, close) => {
      const f = m.querySelector('form');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const b = { name: f.name.value, grade: +f.grade.value || null, class_no: +f.class_no.value || null, number: +f.number.value || null, password: f.password.value || undefined };
        try { if (u) await api.put(`/api/admin/users/${u.id}`, b); else await api.post('/api/admin/users', { ...b, login_id: f.login_id.value }); close(); toast('저장되었습니다', 'ok'); students(); }
        catch (err) { toast(err.message, 'error'); }
      };
      m.querySelector('#del')?.addEventListener('click', async () => { if (!confirm(`${u.name} 학생과 모든 출석 기록을 삭제할까요?`)) return; await api.del(`/api/admin/users/${u.id}`); close(); students(); });
      m.querySelector('#dface')?.addEventListener('click', async () => { if (!confirm('얼굴 데이터를 삭제할까요?')) return; await api.del(`/api/admin/users/${u.id}/face`); close(); toast('삭제됨', 'ok'); students(); });
    },
  });
}
async function enrollFace(u) {
  const { loadHuman, startCamera, captureSamples, drawOverlay } = await import('/common/face.js');
  const ac = new AbortController(); let stopCam = null;
  modal(`<h2>${h(u.name)} 얼굴 등록</h2>
    <div class="camwrap"><video id="ev" autoplay muted playsinline></video><canvas id="ec"></canvas></div>
    <div style="margin:16px 0 12px"><div id="et" style="font-weight:600;font-size:16px">AI 모델을 불러오는 중이에요</div><div class="prog"><i id="ep"></i></div></div>
    <p class="desc">정면을 바라보면 5장을 촬영해요. 사진이나 화면은 위조 방지 모델이 거부해요. 원본 이미지는 저장하지 않고 특징 값만 저장해요.</p>
    <div class="mbtns" style="margin-top:20px"><button class="btn" data-close>닫기</button></div>`, {
    onMount: async (m, close) => {
      const v = m.querySelector('#ev'), c = m.querySelector('#ec'), t = m.querySelector('#et'), p = m.querySelector('#ep');
      const obs = new MutationObserver(() => { if (!document.body.contains(m)) { ac.abort(); stopCam?.(); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
      try {
        stopCam = await startCamera(v);
        const human = await loadHuman();
        const cfg = await api.get('/api/kiosk/config');
        const embs = await captureSamples(human, v, {
          count: 5, signal: ac.signal, minReal: cfg.antispoof_threshold, minLive: cfg.liveness_threshold,
          onState: (s) => { t.textContent = s.text || '정면을 바라봐주세요'; p.style.width = `${s.progress * 100}%`; drawOverlay(c, v, s.a, s.progress ? '#4ade80' : undefined); },
        });
        t.textContent = '저장하는 중이에요';
        await api.post(`/api/admin/users/${u.id}/face`, { embeddings: embs });
        toast(`${u.name} 얼굴 등록 완료`, 'ok'); stopCam(); close(); students();
      } catch (e) { if (!ac.signal.aborted) { t.textContent = `실패: ${e.message}`; t.style.color = 'var(--danger)'; } }
    },
  });
}

// ---------- 지정석 퇴출 후보 ----------
async function evict() {
  const d = await api.get('/api/admin/candidates');
  main().innerHTML = `${title('지정석 퇴출 후보', '', `지정석을 받고도 평일 기준 ${d.absence_days}일 이상 연속으로 나오지 않은 학생이에요. 기준은 설정에서 바꿀 수 있어요.`)}
  <div class="panel flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>좌석</th><th>학생</th><th>연속 미출석</th><th>마지막 출석</th><th></th></tr></thead><tbody>
  ${d.candidates.map((c) => `<tr><td><span class="ini sm seat out">${h(c.label)}</span></td><td><b>${h(c.name)}</b> <span class="sub">${h(c.login_id)}</span></td><td><span class="tag red">${c.missed_days}일</span></td><td class="sub">${c.last_attended ? fmtDT(c.last_attended) : '기록 없음'}</td>
    <td class="r"><button class="btn sm danger" data-rv="${c.seat_id}" data-n="${h(c.name)}">지정석 해제</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">퇴출 후보가 없어요. 지정석 학생이 모두 잘 나오고 있어요.</td></tr>'}
  </tbody></table></div></div>`;
  main().querySelectorAll('[data-rv]').forEach((b) => b.onclick = async () => {
    if (!confirm(`${b.dataset.n} 학생의 지정석을 해제하고 자율석으로 전환할까요?`)) return;
    await api.post(`/api/admin/seats/${b.dataset.rv}/revoke`); toast('지정석을 해제했어요', 'ok'); evict();
  });
}

// ---------- 블랙리스트 ----------
async function black() {
  const { users } = await api.get('/api/admin/users');
  const bl = users.filter((u) => u.blacklisted);
  main().innerHTML = `${title('입실 제한', '', '제한된 학생은 키오스크에서 입실할 수 없어요')}
  <div class="grid-2"><div class="panel"><div class="panel-h"><h2>제한된 학생<span class="cnt">${bl.length}</span></h2></div>
    <div class="plist" style="max-height:none">${bl.map((u) => `<div><span class="ini sm">${h(u.name.slice(-2))}</span><div><b>${h(u.name)} <span class="sub" style="font-weight:400">${h(u.login_id)}</span></b><small>${h(u.blacklist_reason || '사유 없음')}</small></div><button class="btn sm" data-un="${u.id}">제한 풀기</button></div>`).join('') || '<div class="empty-mini">입실이 제한된 학생이 없어요</div>'}</div></div>
  <div class="panel"><div class="panel-h"><h2>입실 제한하기</h2></div><form class="form" id="f">
    <label class="field">학생<select class="input" name="u">${users.filter((u) => !u.blacklisted).map((u) => `<option value="${u.id}">${h(u.login_id)} ${h(u.name)}</option>`).join('')}</select></label>
    <label class="field">사유<input class="input" name="r" placeholder="예: 반복적인 소음, 무단 좌석 점유" required></label>
    <p class="desc">제한하면 키오스크 입실이 거부되고, 입실 중이면 바로 퇴실 처리돼요.</p>
    <div><button class="btn danger-fill">입실 제한</button></div></form></div></div>`;
  main().querySelector('#f').onsubmit = async (e) => { e.preventDefault(); await api.post(`/api/admin/users/${e.target.u.value}/blacklist`, { on: true, reason: e.target.r.value }); toast('입실을 제한했어요', 'ok'); black(); };
  main().querySelectorAll('[data-un]').forEach((b) => b.onclick = async () => { await api.post(`/api/admin/users/${b.dataset.un}/blacklist`, { on: false }); toast('입실 제한을 풀었어요', 'ok'); black(); });
}

// ---------- 게시판 (문의/건의, 분실물) ----------
function postList(posts, { answerable, statuses }) {
  return posts.map((p) => `<div class="post"><div class="row between" style="align-items:flex-start"><div><span class="title">${h(p.title)}</span>
    <p class="meta">${p.category ? `${h(p.category)} · ` : ''}${p.author ? `${h(p.author)} · ` : ''}${fmtDT(p.created_at)}</p></div>
    <span class="tag ${p.status === 'open' ? 'blue' : ''}">${statuses[p.status] || h(p.status)}</span></div>
    <p class="body">${h(p.body)}</p>
    ${p.answer ? `<div class="iq-a" style="margin-top:12px"><b>답변 · ${fmtDT(p.answered_at)}</b>${h(p.answer)}</div>` : ''}
    <div class="row wrap" style="margin-top:12px">${answerable ? `<button class="btn sm soft" data-ans="${p.id}">${p.answer ? '답변 수정' : '답변하기'}</button>` : ''}
      ${Object.keys(statuses).filter((s) => s !== p.status).map((s) => `<button class="btn sm" data-st="${p.id}" data-v="${s}">${statuses[s]}(으)로 변경</button>`).join('')}
      <span class="grow"></span><button class="btn sm ghost danger" data-del="${p.id}">삭제</button></div></div>`).join('') || '<div class="empty-state">아직 등록된 글이 없어요</div>';
}
function bindPosts(root, posts, reload) {
  root.querySelectorAll('[data-ans]').forEach((b) => b.onclick = () => {
    const p = posts.find((x) => x.id === +b.dataset.ans);
    modal(`<form class="stack"><h2>답변 작성</h2><div class="quote"><b>${h(p.title)}</b><div>${h(p.body)}</div></div>
      <textarea class="input" name="a" rows="5" placeholder="학생에게 보낼 답변" required>${h(p.answer || '')}</textarea><div class="mbtns"><button type="button" class="btn" data-close>취소</button><button class="btn primary">보내기</button></div></form>`, {
      onMount: (m, close) => m.querySelector('form').onsubmit = async (e) => { e.preventDefault(); await api.post(`/api/posts/${p.id}/answer`, { answer: e.target.a.value, status: p.board === 'lost_report' ? p.status : 'answered' }); close(); toast('답변을 보냈어요', 'ok'); reload(); },
    });
  });
  root.querySelectorAll('[data-st]').forEach((b) => b.onclick = async () => { await api.post(`/api/posts/${b.dataset.st}/status`, { status: b.dataset.v }); reload(); });
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (!confirm('삭제할까요?')) return; await api.del(`/api/posts/${b.dataset.del}`); reload(); });
}
let inqFilter = 'open';
async function inquiry() {
  const { posts } = await api.get('/api/posts?board=inquiry');
  const F = [['open', '답변 대기'], ['answered', '답변 완료'], ['all', '전체']];
  const list = posts.filter((p) => inqFilter === 'all' || (inqFilter === 'open' ? !p.answer : !!p.answer));
  main().innerHTML = `${title('문의 · 건의', '', '학생이 보낸 문의에 답하면 학생 앱 문의 탭에 바로 보여요')}
  <div class="chips">${F.map(([k, l]) => `<button data-f="${k}" class="${inqFilter === k ? 'on' : ''}">${l}<span class="cnum">${posts.filter((p) => k === 'all' || (k === 'open' ? !p.answer : !!p.answer)).length}</span></button>`).join('')}</div>
  <div class="panel flush">${list.map((p) => `<details class="iq" ${!p.answer && list.indexOf(p) === 0 ? 'open' : ''}>
    <summary><span class="ini sm">${h((p.author || '?').slice(-2))}</span><div class="iq-m"><b>${h(p.title)}</b><small>${h(p.author || '')} · ${p.category ? `${h(p.category)} · ` : ''}${fmtDT(p.created_at)}</small></div>
      <span class="tag ${p.answer ? '' : 'blue'}">${p.answer ? '답변 완료' : '답변 대기'}</span><i class="ti ti-chevron-down iq-ch"></i></summary>
    <div class="iq-b"><p class="iq-q">${h(p.body)}</p>
      <form data-id="${p.id}"><textarea class="input" name="a" rows="3" placeholder="학생에게 보낼 답변을 적어주세요">${h(p.answer || '')}</textarea>
        <div class="iq-act"><button type="button" class="btn sm ghost danger" data-del="${p.id}">삭제</button><span class="grow"></span><span class="kbd">Ctrl/⌘ + Enter로 보내기</span><button class="btn primary">${p.answer ? '답변 수정' : '답변 보내기'}</button></div></form></div></details>`).join('')
    || `<p class="empty-state">${inqFilter === 'open' ? '답변을 기다리는 문의가 없어요. 모두 답했어요.' : '아직 들어온 문의가 없어요'}</p>`}</div>`;
  main().querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { inqFilter = b.dataset.f; inquiry(); });
  main().querySelectorAll('form[data-id]').forEach((f) => {
    const send = async (e) => { e?.preventDefault(); if (!f.a.value.trim()) { toast('답변 내용을 적어주세요', 'error'); f.a.focus(); return; } await api.post(`/api/posts/${f.dataset.id}/answer`, { answer: f.a.value.trim(), status: 'answered' }); toast('답변을 보냈어요', 'ok'); inquiry(); };
    f.onsubmit = send; f.a.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); };
  });
  main().querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (!confirm('이 문의를 삭제할까요?')) return; await api.del(`/api/posts/${b.dataset.del}`); inquiry(); });
}
let lostTab = 'lost_found';
async function lost() {
  const { posts } = await api.get(`/api/posts?board=${lostTab}`);
  main().innerHTML = `${title('분실물', lostTab === 'lost_found' ? '<button class="btn primary" id="add"><i class="ti ti-plus"></i>습득물 등록</button>' : '', '보관함에 올린 물건은 학생 앱 문의 탭의 보관함에 보여요')}
  <div class="seg" style="margin-bottom:16px"><button class="${lostTab === 'lost_found' ? 'on' : ''}" data-lt="lost_found">보관함</button><button class="${lostTab === 'lost_report' ? 'on' : ''}" data-lt="lost_report">학생 분실 신고</button></div>
  <div class="panel">${lostTab === 'lost_found'
    ? postList(posts, { answerable: false, statuses: { open: '보관 중', found: '주인 찾음' } })
    : postList(posts, { answerable: true, statuses: { open: '접수', found: '찾음', closed: '종료' } })}</div>`;
  main().querySelectorAll('[data-lt]').forEach((b) => b.onclick = () => { lostTab = b.dataset.lt; lost(); });
  bindPosts(main(), posts, lost);
  main().querySelector('#add')?.addEventListener('click', () => modal(`<form class="form"><h2 style="margin:0">습득물 등록</h2>
    <label class="field">분류<select class="input" name="c">${['전자기기', '필기구', '의류', '지갑·카드', '기타'].map((c) => `<option>${c}</option>`).join('')}</select></label>
    <label class="field">물건 이름<input class="input" name="t" required></label><label class="field">습득 장소·일시·특징<textarea class="input" name="b" rows="4" required></textarea></label>
    <div class="mbtns"><button type="button" class="btn" data-close>취소</button><button class="btn primary">등록</button></div></form>`, {
    onMount: (m, close) => m.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = e.target; await api.post('/api/posts', { board: 'lost_found', category: f.c.value, title: f.t.value, body: f.b.value }); close(); lost(); },
  }));
}

// ---------- 공지 ----------
async function notice() {
  const { posts } = await api.get('/api/posts?board=notice');
  main().innerHTML = `${title('공지사항', '', '학생 앱 공지 탭과 홈 소식에 보여요')}<div class="grid-2"><div class="panel"><div class="panel-h"><h2>게시된 공지<span class="cnt">${posts.length}</span></h2></div>${posts.map((p) => `<div class="post"><div class="row between" style="align-items:flex-start"><div><span class="title">${h(p.title)}</span><p class="meta">${fmtDT(p.created_at)}</p></div><div class="row">${p.pinned ? '<span class="tag blue">고정</span>' : ''}<button class="btn sm ghost danger" data-del="${p.id}">삭제</button></div></div>
    <p class="body">${h(p.body)}</p></div>`).join('') || '<div class="empty-state">아직 공지가 없어요. 오른쪽에서 첫 공지를 써 보세요.</div>'}</div>
  <div class="panel"><div class="panel-h"><h2>새 공지</h2></div><form class="form" id="f"><label class="field">제목<input class="input" name="t" required></label><label class="field">내용<textarea class="input" name="b" rows="7" required></textarea></label>
    <label class="check"><input type="checkbox" name="p">상단에 고정</label><div><button class="btn primary">게시하기</button></div></form></div></div>`;
  main().querySelector('#f').onsubmit = async (e) => { e.preventDefault(); const f = e.target; await api.post('/api/posts', { board: 'notice', title: f.t.value, body: f.b.value, pinned: f.p.checked }); toast('공지를 게시했어요', 'ok'); notice(); };
  main().querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (!confirm('삭제할까요?')) return; await api.del(`/api/posts/${b.dataset.del}`); notice(); });
}

// ---------- 설정 ----------
async function settings() {
  const s = await api.get('/api/admin/settings');
  const G = [
    ['운영', [['room_name', '야자실 이름', '키오스크 상단에 보여요', 'text'], ['close_time', '운영 종료 시각', '이 시각까지 퇴실하지 않으면 자동 퇴실돼요', 'time'], ['daily_goal_min', '학생 하루 목표 (분)', '학생 앱 홈의 목표 달성률 기준', 'number'], ['absence_days', '지정석 퇴출 기준 (평일 수)', '연속으로 이만큼 안 나오면 퇴출 후보가 돼요', 'number']]],
    ['얼굴 인식', [['match_threshold', '매칭 임계값', '0~1 · 높을수록 엄격해요', 'number', '0.01'], ['match_margin', '1·2위 최소 차이', '비슷한 얼굴을 잘못 인식하지 않게 해요', 'number', '0.01'], ['antispoof_threshold', '위조 방지 임계값', '사진이나 화면을 막아요', 'number', '0.01'], ['liveness_threshold', '실제 사람 판별 임계값', '높을수록 엄격해요', 'number', '0.01']]],
    ['계정', [['admin_emails', '관리자 구글 계정', '쉼표로 구분해요', 'text']]],
  ];
  main().innerHTML = `${title('설정', '', '운영 시간, 인식 기준, 관리자 계정')}<form id="f"><div class="set-grid">
    ${G.map(([g, rows]) => `<div class="panel"><div class="panel-h"><h2>${g}</h2></div>${rows.map(([k, l, d, t, st]) => `<label class="set-row"><span><b>${l}</b><small>${d}</small></span><input class="input" name="${k}" type="${t}" ${st ? `step="${st}" min="0" max="1"` : ''} value="${h(s[k])}"></label>`).join('')}</div>`).join('')}
    </div><div class="set-actions"><button class="btn primary lg">변경 사항 저장</button></div></form>`;
  main().querySelector('#f').onsubmit = async (e) => { e.preventDefault(); await api.put('/api/admin/settings', Object.fromEntries(new FormData(e.target))); toast('설정을 저장했어요', 'ok'); };
}

boot();
