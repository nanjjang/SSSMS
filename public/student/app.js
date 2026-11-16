import { createApi, h, fmtTime, fmtDate, toast, modal, renderSeatMap, LOGO } from '/common/api.js';

const api = createApi('student');
const app = document.getElementById('app');
let me = null; let tab = 'home'; let timer = null; let boardKind = 'inquiry';

api.onUnauthorized = () => { me = null; renderLogin(); };

const korDur = (m) => { m = Math.max(0, Math.round(m || 0)); const hh = Math.floor(m / 60), mm = m % 60; return hh ? (mm ? `${hh}시간 ${mm}분` : `${hh}시간`) : `${mm}분`; };
const clk = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const hm = (m) => { m = Math.max(0, Math.round(m || 0)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const ago = (ms) => { const d = (Date.now() - ms) / 60000; if (d < 1) return '방금'; if (d < 60) return `${Math.floor(d)}분 전`; if (d < 1440) return `${Math.floor(d / 60)}시간 전`; if (d < 10080) return `${Math.floor(d / 1440)}일 전`; const t = new Date(ms); return `${t.getMonth() + 1}월 ${t.getDate()}일`; };

async function boot() {
  if (!api.token.get()) return renderLogin();
  try { me = (await api.get('/api/me')).user; if (me.role !== 'student') throw 0; renderShell(); }
  catch { api.token.set(null); renderLogin(); }
}

// ---------- 로그인 ----------
let authCfg = null;
const loadGsi = () => new Promise((res, rej) => {
  if (window.google?.accounts?.id) return res();
  const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
  sc.onload = res; sc.onerror = () => rej(new Error('구글 로그인을 불러오지 못했어요')); document.head.append(sc);
});
async function finishGoogle(r) {
  if (r.need_student_no) return askStudentNo(r);
  api.token.set(r.token); me = { ...r.user, fixed_seat: r.fixed_seat };
  if (me.role !== 'student') { location.href = '/admin/'; return; }
  renderShell();
}
function askStudentNo(r) {
  app.innerHTML = `<div class="auth">
    <div class="auth-top"><h1>학번을 알려주세요</h1>
      <p class="desc">${h(r.email)} 계정에서 학번을 찾지 못했어요. 한 번만 입력하면 선생님이 등록한 이름과 지정석이 연결돼요.</p></div>
    <form class="auth-form" id="f">
      <label class="field">이름<input class="input" value="${h(r.name || '')}" disabled></label>
      <label class="field">학번 5자리<input class="input lg" name="no" inputmode="numeric" pattern="[1-3][0-9]{4}" maxlength="5" placeholder="20105" autofocus required></label>
      <button class="btn primary block">확인</button></form></div>`;
  app.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { await finishGoogle(await api.post('/api/auth/google', { link_token: r.link_token, student_no: e.target.no.value.trim() })); }
    catch (err) { toast(err.message, 'error'); if (/다시 로그인/.test(err.message)) renderLogin(); }
  };
}
async function renderLogin() {
  clearInterval(timer);
  authCfg ||= await api.get('/api/auth/config').catch(() => ({}));
  app.innerHTML = `<div class="auth">
    <div class="auth-top">
      <img class="auth-logo" src="${LOGO}" alt="선린인터넷고등학교" onerror="this.remove()">
      <p class="school">선린인터넷고등학교</p><h1>야간자율학습</h1>
      <p class="desc">학교 구글 계정으로 로그인하면 학번, 이름, 지정석을 자동으로 불러와요.</p>
    </div>
    <div class="auth-form">
      <div id="gbtn" class="gbtn"></div>
      <p class="note">@${h(authCfg.school_domain || 'sunrint.hs.kr')} 계정만 사용할 수 있어요</p>
      ${authCfg.password_login ? `<details class="dev" ${authCfg.google_client_id ? '' : 'open'}><summary>${authCfg.google_client_id ? '학번으로 로그인' : '학번으로 로그인'}<i class="ti ti-chevron-down"></i></summary>
        <form><input class="input" name="id" placeholder="학번" inputmode="numeric" autocomplete="username" required><input class="input" name="pw" type="password" placeholder="비밀번호" autocomplete="current-password" required><button class="btn primary block">로그인</button></form></details>` : ''}
    </div></div>`;
  app.querySelector('.dev form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { const u = await api.login(f.id.value.trim(), f.pw.value); if (u.role !== 'student') { await api.logout(); throw new Error('학생 계정이 아니에요'); } me = (await api.get('/api/me')).user; renderShell(); }
    catch (err) { toast(err.message, 'error'); }
  });
  if (!authCfg.google_client_id) { app.querySelector('#gbtn').remove(); return; }
  try {
    await loadGsi();
    google.accounts.id.initialize({
      client_id: authCfg.google_client_id, hd: authCfg.school_domain, ux_mode: 'popup',
      callback: async ({ credential }) => { try { await finishGoogle(await api.post('/api/auth/google', { credential })); } catch (err) { toast(err.message, 'error'); } },
    });
    const w = Math.min(380, app.querySelector('#gbtn').clientWidth || 320);
    google.accounts.id.renderButton(app.querySelector('#gbtn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: w, locale: 'ko', logo_alignment: 'center' });
  } catch (err) { app.querySelector('#gbtn').textContent = err.message; }
}

// ---------- 셸 ----------
const TABIC = { home: 'home', seat: 'layout-grid', board: 'message-circle', notice: 'bell' };
const TABS = [['home', '홈'], ['seat', '좌석'], ['board', '문의'], ['notice', '공지']];
function renderShell() {
  app.innerHTML = `
    <header class="appbar">
      <img src="${LOGO}" alt="" onerror="this.remove()"><span class="title">선린 야자실</span>
      <button class="avatar" id="mebtn" aria-label="내 정보">${h((me.name || '?').slice(-2))}</button>
    </header>
    <main id="view"></main>
    <nav class="tabbar">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-current="${tab === k}"><i class="ti ti-${TABIC[k]}"></i><i class="ti ti-${TABIC[k]}-filled ti-filled"></i><span>${l}</span></button>`).join('')}</nav>`;
  app.querySelector('#mebtn').onclick = mySheet;
  refreshBadge();
  app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => go(b.dataset.tab));
  ({ home, seat, board, notice })[tab]();
}
// 탭 전환: 탭바는 그대로 두고 내용만 교체 → 페이드·슬라이드
async function go(next) {
  if (tab === next) { scrollTo({ top: 0, behavior: 'smooth' }); return; }
  tab = next;
  app.querySelectorAll('[data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab); });
  clearInterval(timer);
  await ({ home, seat, board, notice })[tab]();
  scrollTo(0, 0);
}
// 데이터를 받은 뒤 한 번에 그려서 깜빡임 없이 등장
const paint = (html) => { const v = view(); v.classList.remove('enter'); v.innerHTML = html; void v.offsetWidth; v.classList.add('enter'); };
const view = () => app.querySelector('#view');

function mySheet() {
  modal(`<div class="handle"></div><div class="me-head"><div class="avatar lg">${h((me.name || '?').slice(-2))}</div><div><b>${h(me.name)}</b><span>${h(me.email || me.login_id)}</span></div></div>
    <div class="kvl">
      <div><span>학번</span><b>${h(me.login_id)}</b></div>
      <div><span>학년 · 반 · 번호</span><b>${h(me.grade ?? '-')}학년 ${h(me.class_no ?? '-')}반 ${h(me.number ?? '-')}번</b></div>
      <div><span>지정석</span><b>${me.fixed_seat ? h(me.fixed_seat) : '없음 (자율석 이용)'}</b></div>
      <div><span>얼굴 등록</span><b>${me.has_face ? '완료' : '<span class="muted">선생님께 등록 요청</span>'}</b></div>
    </div>
    <p class="note" style="margin-top:12px">정보가 다르면 담당 선생님께 말해 주세요. 이름과 지정석은 선생님이 학번 기준으로 관리해요.</p>
    <div class="sheet-actions"><button class="btn" data-close>닫기</button><button class="btn danger-fill" id="lo">로그아웃</button></div>`, {
    onMount: (m, close) => m.querySelector('#lo').onclick = async () => { close(); await api.logout(); try { google.accounts.id.disableAutoSelect(); } catch {} renderLogin(); },
  });
}

// 상단 배너: 상황 안내는 한 줄 배너로
const banner = (ic, text, tone = '', go = '') => `<${go ? 'button' : 'div'} class="bnr ${tone}" ${go ? `data-go="${go}"` : ''} role="status">${tone === 'live' ? '<span class="live-dot"></span>' : `<i class="ti ti-${ic}"></i>`}<span class="bnr-t">${text}</span>${go ? '<i class="ti ti-chevron-right chev"></i>' : ''}</${go ? 'button' : 'div'}>`;
const more = (go, label) => `<button class="more" data-go="${go}">${label}<i class="ti ti-chevron-right"></i></button>`;
const weekBars = (s, todayKey) => { const maxW = Math.max(60, ...s.week_days.map((d) => d.minutes)); return `<div class="wk">${s.week_days.map((d, i) => `<div class="${d.day === todayKey ? 'today' : ''} ${d.day > todayKey ? 'fut' : ''}">
  <span class="wk-col"><span class="wk-v">${d.minutes ? hm(d.minutes) : ''}</span><span class="wk-bar" style="height:${d.minutes ? Math.max(4, (d.minutes / maxW) * 72) : 0}px"></span></span>
  <span class="wk-d">${'월화수목금토일'[i]}</span></div>`).join('')}</div>`; };
const ptitle = (t, right = '') => `<div class="ptitle"><h1>${t}</h1>${right}</div>`;

// 안 읽은 선생님 답변 배지
const seenKey = () => `sssms_seen_answers_${me.id}`;
const getSeen = () => { try { return +localStorage.getItem(seenKey()) || 0; } catch { return 0; } };
async function refreshBadge(answered) {
  if (answered == null) { try { answered = (await api.get('/api/posts?board=inquiry')).posts.filter((p) => p.answer).length; } catch { return; } }
  const n = Math.max(0, answered - getSeen());
  const b = app.querySelector('[data-tab=board]'); if (!b) return;
  b.querySelector('.tbadge')?.remove();
  if (n) b.insertAdjacentHTML('beforeend', `<span class="tbadge">${n}</span>`);
}

// ---------- 홈 ----------
// ---------- 홈 ----------
async function home() {
  clearInterval(timer);
  if (!view().children.length) view().innerHTML = skeleton();
  const s = await api.get('/api/me/stats');
  const goal = s.daily_goal_min; const base = s.today_minutes; const loadedAt = Date.now();
  const nowMin = () => base + (s.open ? (Date.now() - loadedAt) / 60000 : 0);
  const attended = s.week_days.filter((d) => d.minutes).length;
  const free = s.free_seats;
  const toMin = (t) => { const [hh, mm] = String(t).split(':').map(Number); return hh * 60 + mm; };
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const T0 = toMin(s.open_time), T1 = toMin(s.close_time), span = Math.max(60, T1 - T0);
  const minOf = (ms) => (ms - day0.getTime()) / 60000;
  const pos = (m) => Math.max(0, Math.min(100, ((m - T0) / span) * 100));
  const nowM = minOf(Date.now());
  const segs = s.today_sessions.map((x) => ({ a: pos(minOf(x.check_in)), b: pos(minOf(x.check_out ?? Date.now())) }));
  const hours = []; for (let t = Math.ceil(T0 / 60) * 60; t <= T1; t += 60) hours.push(t);
  const untilClose = Math.max(0, T1 - nowM);
  const todayKey = s.heatmap.at(-1).day;
  const goalPct = Math.min(100, Math.round((nowMin() / goal) * 100));
  const bn = s.open ? banner('', `<b>${h(s.open.seat || '')}</b>에서 공부 중 · ${clk(s.open.check_in)} 입실`, 'live')
    : nowM < T0 ? banner('clock', `오늘 야자는 <b>${s.open_time}</b>에 시작해요`)
    : nowM >= T1 ? banner('moon', `오늘 야자는 ${s.close_time}에 끝났어요`)
    : base > 0 ? banner('door-exit', '오늘은 퇴실했어요')
    : banner('scan', `키오스크에서 얼굴을 비추면 입실돼요 · 마감 ${s.close_time}`);
  const mp = s.my_posts || {};
  paint(`
    ${bn}

    <section class="card">
      <div class="card-h"><p class="label">오늘 공부한 시간</p>${more('record', '기록')}</div>
      <p class="amount xl" id="clock">${korDur(nowMin())}</p>
      <div class="tl" aria-label="오늘 ${s.open_time}부터 ${s.close_time}까지 공부한 구간">
        <div class="tl-track">${segs.map((g) => `<i class="tl-seg" style="left:${g.a}%;width:${Math.max(1.5, g.b - g.a)}%"></i>`).join('')}
          ${nowM > T0 && nowM < T1 ? `<span class="tl-now" style="left:${pos(nowM)}%"></span>` : ''}</div>
        <div class="tl-hours">${hours.map((t) => `<span style="left:${pos(t)}%">${t / 60}시</span>`).join('')}</div>
      </div>
      <div class="facts">
        <div><span>목표 ${korDur(goal)}</span><b>${goalPct >= 100 ? '달성' : `${goalPct}%`}</b></div>
        <div><span>${s.open ? '입실 시각' : nowM < T0 ? '시작까지' : nowM < T1 ? '마감까지' : '마감'}</span><b>${s.open ? clk(s.open.check_in) : nowM < T0 ? korDur(T0 - nowM) : nowM < T1 ? korDur(untilClose) : s.close_time}</b></div>
        <div><span>내 자리</span><b>${me.fixed_seat ? h(me.fixed_seat) : '자율석'}</b></div>
      </div>
    </section>

    <div class="g2">
      <button class="tile" data-go="record"><span class="lbl"><i class="ti ti-calendar-check"></i>연속 출석</span><b class="amount">${s.streak.current}일</b><small>최고 기록 ${s.streak.best}일</small></button>
      <button class="tile" data-go="rank"><span class="lbl"><i class="ti ti-chart-bar"></i>이번 주 순위</span><b class="amount">${s.rank ? `${s.rank}위` : '–'}</b><small>${s.rank_total}명 중</small></button>
    </div>

    <section class="card">
      <div class="card-h"><p class="label">이번 주 공부</p>${more('record', '자세히')}</div>
      <p class="amount">${korDur(s.week_minutes)} <span class="of">${attended}일 출석</span></p>
      ${weekBars(s, todayKey)}
    </section>

    <section class="card flush lst">
      <button class="li" data-go="seat"><i class="ti ti-layout-grid"></i><span class="li-t"><b>지금 빈 자율석</b><small>입실할 때 키오스크에서 골라요</small></span><span class="li-v ${free ? 'accent' : ''}">${free}석</span><i class="ti ti-chevron-right chev"></i></button>
      <button class="li" data-go="me"><i class="ti ti-armchair"></i><span class="li-t"><b>내 지정석</b><small>${me.fixed_seat ? '입실하면 자동으로 배정돼요' : '지정석이 없으면 자율석을 이용해요'}</small></span><span class="li-v">${me.fixed_seat ? h(me.fixed_seat) : '없음'}</span><i class="ti ti-chevron-right chev"></i></button>
    </section>

    <div class="sec-h"><h2>소식</h2></div>
    <div class="hscroll" id="hs">
      <button class="mini ${s.notice ? '' : 'dim'}" data-go="notice"><i class="ti ti-speakerphone"></i><span class="mini-k">공지</span><b>${s.notice ? h(s.notice.title) : '새 공지가 없어요'}</b><small>${s.notice ? ago(s.notice.created_at) : '공지 탭에서 지난 공지 보기'}</small></button>
      <button class="mini" data-go="board"><i class="ti ti-message-circle"></i><span class="mini-k">내 문의</span><b>${(mp.answered || 0) ? `선생님 답변 ${mp.answered}건` : (mp.open || 0) ? '답변을 기다리고 있어요' : '선생님께 문의하기'}</b><small>${(mp.open || 0) ? `대기 ${mp.open}건` : '시설 · 소음 · 좌석 · 운영'}</small></button>
      <button class="mini ${s.lost_found ? '' : 'dim'}" data-go="lost"><i class="ti ti-package"></i><span class="mini-k">분실물 보관함</span><b>${s.lost_found ? `물건 ${s.lost_found}개 보관 중` : '보관 중인 물건이 없어요'}</b><small>관리실에서 찾아가요</small></button>
    </div>`);
  view().querySelectorAll('[data-go]').forEach((b) => b.onclick = () => {
    const g = b.dataset.go;
    if (g === 'me') return mySheet();
    if (g === 'record' || g === 'rank') return recordPage(s, g);
    if (g === 'lost') { boardKind = 'lost_found'; return go('board'); }
    if (g === 'board') boardKind = 'inquiry';
    if (g === 'notice') return go('notice');
    go(g);
  });
  if (s.open) timer = setInterval(() => { const el = document.getElementById('clock'); if (!el) return clearInterval(timer); el.textContent = korDur(nowMin()); }, 15000);
}

// 기록 상세 (토스 상세 페이지 패턴: 뒤로가기 · 큰 제목 · 배지 · 굵은 구분띠 · 라벨/값 목록)
function recordPage(s, focus) {
  clearInterval(timer);
  const todayKey = s.heatmap.at(-1).day;
  const lvl = (m) => m === 0 ? 0 : m < 60 ? 1 : m < 120 ? 2 : m < 240 ? 3 : 4;
  const first = new Date(s.heatmap[0].day + 'T00:00:00'); const pad = (first.getDay() + 6) % 7;
  const cols = Math.ceil((s.heatmap.length + pad) / 7);
  const months = []; s.heatmap.forEach((d, i) => { if (d.day.endsWith('-01')) months.push({ c: Math.floor((i + pad) / 7), m: +d.day.slice(5, 7) }); });
  const attendedDays = s.heatmap.filter((d) => d.minutes).length;
  const avg = attendedDays ? Math.round(s.heatmap.reduce((a, d) => a + d.minutes, 0) / attendedDays) : 0;
  const best = s.heatmap.reduce((a, d) => (d.minutes > a.minutes ? d : a), { minutes: 0 });
  paint(`
    <button class="back" id="back"><i class="ti ti-chevron-left"></i>홈</button>
    ${ptitle('내 기록')}
    ${banner('chart-bar', `지금까지 총 <b>${korDur(s.total_minutes)}</b> 공부했어요`)}

    <section class="card">
      <div class="card-h"><p class="label">이번 주 공부</p><span class="tag">${s.streak.current}일 연속</span></div>
      <p class="amount">${korDur(s.week_minutes)}</p>
      ${weekBars(s, todayKey)}
      <div class="facts"><div><span>최고 연속</span><b>${s.streak.best}일</b></div><div><span>하루 평균</span><b>${avg ? korDur(avg) : '–'}</b></div><div><span>누적 출석</span><b>${s.streak.total_days}일</b></div></div>
    </section>

    <section class="card" id="rank">
      <div class="card-h"><p class="label">이번 주 순위</p></div>
      <p class="amount">${s.rank ? `${s.rank}위` : '–'}<span class="of">/ ${s.rank_total}명</span></p>
      <div class="rk">${s.top.map((t, i) => `<div class="${t.me ? 'me' : ''}"><em>${i + 1}</em><span class="nm">${h(t.name)}${t.me ? '<span class="tag blue">나</span>' : ''}</span><b>${korDur(t.minutes)}</b></div>`).join('')}
        ${s.rank > 5 ? `<div class="me gap"><em>${s.rank}</em><span class="nm">${h(me.name)}<span class="tag blue">나</span></span><b>${korDur(s.week_minutes)}</b></div>` : ''}</div>
      <p class="note" style="margin-top:8px">다른 학생 이름은 가운데 글자를 가려서 보여줘요</p>
    </section>

    <section class="card">
      <div class="card-h"><p class="label">최근 4개월</p></div>
      <p class="amount">${attendedDays}일 출석</p>
      ${best.minutes ? `<p class="note">가장 오래 공부한 날 · ${+best.day.slice(5, 7)}월 ${+best.day.slice(8)}일 ${korDur(best.minutes)}</p>` : ''}
      <div class="hm-months" style="grid-template-columns:repeat(${cols},1fr)">${months.map((m) => `<span style="grid-column:${m.c + 1}">${m.m}월</span>`).join('')}</div>
      <div class="heat">${'<i class="pad"></i>'.repeat(pad)}${s.heatmap.map((d) => `<i class="l${lvl(d.minutes)}" title="${d.day} · ${korDur(d.minutes)}"></i>`).join('')}</div>
      <div class="heat-key"><span>적게</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>많이</span></div>
    </section>
    <p class="page-note">주말은 쉬어도 연속 출석이 끊기지 않아요.</p>`);
  document.getElementById('back').onclick = () => home();
  if (focus === 'rank') setTimeout(() => document.getElementById('rank')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
  else scrollTo(0, 0);
}
const skeleton = () => `<section class="card sk"><i style="width:40%"></i><i style="width:70%;height:24px"></i><i style="width:55%;height:24px"></i></section><section class="card sk"><i></i><i style="width:60%"></i></section>`;

// ---------- 좌석 ----------
async function seat() {
  clearInterval(timer);
  const v = view(); let first = true;
  const load = async () => {
    const d = await api.get('/api/seats');
    const freeList = d.seats.filter((x) => x.type === 'free' && !x.occupied).sort((a, b) => a.y - b.y || a.x - b.x);
    const totalFree = d.seats.filter((x) => x.type === 'free').length;
    const mine = d.seats.find((x) => x.mine);
    const rate = totalFree ? (totalFree - freeList.length) / totalFree : 0;
    const mood = rate < 0.5 ? ['여유', 'ok'] : rate < 0.85 ? ['조금 붐빔', 'warn'] : ['거의 꽉 참', 'bad'];
    const html = `
      ${ptitle('좌석', `<span class="mood ${mood[1]}">${mood[0]}</span>`)}
      ${mine ? banner('', `지금 <b>${h(mine.label)}</b>에 앉아 있어요`, 'live') : banner(freeList.length ? 'layout-grid' : 'ban', freeList.length ? `자율석 ${totalFree}석 중 <b>${freeList.length}석</b>이 비어 있어요` : '지금은 빈 자율석이 없어요')}
      <section class="card">
        <div class="front">교실 앞 · 칠판</div>
        <div id="map"></div>
        <div class="legend">${[['free', '빈 자리'], ['occ', '사용 중'], ['fixed', '지정석'], ['mine', '내 자리']].map(([k, l]) => `<span><i class="sw ${k}"></i>${l}</span>`).join('')}</div>
      </section>
      <section class="card flush lst">
        <div class="li"><i class="ti ti-arrow-bar-to-up"></i><span class="li-t"><b>앞쪽 빈 자리</b><small>칠판에서 가까운 순서</small></span><span class="li-v">${freeList.slice(0, 3).map((x) => h(x.label)).join(', ') || '없음'}</span></div>
        <div class="li"><i class="ti ti-armchair"></i><span class="li-t"><b>내 지정석</b></span><span class="li-v">${me.fixed_seat ? h(me.fixed_seat) : '없음'}</span></div>
        <button class="li" id="refresh"><i class="ti ti-refresh"></i><span class="li-t"><b>새로고침</b><small>20초마다 자동으로 바뀌어요</small></span><span class="li-v note">${clk(Date.now())}</span></button>
      </section>
      <p class="page-note">자리를 누르면 상태를 볼 수 있어요. 자리는 입실할 때 키오스크에서 골라요.</p>`;
    if (first) { paint(html); first = false; } else v.innerHTML = html;
    renderSeatMap(v.querySelector('#map'), d, { pickable: (x) => x.type !== 'disabled', onPick: seatSheet });
    v.querySelector('#refresh').onclick = load;
  };
  await load();
  timer = setInterval(() => document.getElementById('map') ? load() : clearInterval(timer), 20000);
}

function seatSheet(x) {
  const st = x.mine ? ['내 자리', 'blue'] : x.occupied ? ['사용 중', ''] : x.type === 'fixed' ? ['지정석', 'line'] : ['비어 있음', 'blue'];
  modal(`<div class="handle"></div><div class="seat-sh"><span class="seat-no">${h(x.label)}</span><span class="tag ${st[1]}">${st[0]}</span></div>
    <div class="kvl">
      <div><span>종류</span><b>${x.type === 'fixed' ? '지정석' : '자율석'}</b></div>
      ${x.occupied ? `<div><span>사용 시작</span><b>${clk(x.occ_since)}</b></div>` : ''}
      <div><span>위치</span><b>앞에서 ${x.y + 1}번째 줄 · 왼쪽에서 ${x.x + 1}번째</b></div>
    </div>
    <p class="note" style="margin-top:12px">${x.type === 'fixed' ? '지정석은 배정받은 학생만 앉을 수 있어요.' : x.occupied ? '다른 학생이 사용 중이에요.' : '입실할 때 키오스크에서 이 자리를 고를 수 있어요.'}</p>
    <button class="cta" data-close style="margin-top:24px">확인</button>`);
}

// ---------- 문의 · 분실 (토스 문서함 패턴) ----------
const BOARDS = { inquiry: '문의·건의', lost_report: '분실 신고', lost_found: '보관함' };
const STATUS = { open: ['답변 대기', 'gray'], answered: ['답변 완료', 'blue'], found: ['찾음', 'blue'], closed: ['종료', 'gray'] };
async function board() {
  clearInterval(timer);
  const { posts } = await api.get(`/api/posts?board=${boardKind}`);
  const mine = boardKind !== 'lost_found';
  const waiting = posts.filter((p) => p.status === 'open').length;
  if (boardKind === 'inquiry') { try { localStorage.setItem(seenKey(), posts.filter((p) => p.answer).length); } catch {} refreshBadge(posts.filter((p) => p.answer).length); }
  const answered = posts.filter((p) => p.answer).length;
  const keep = posts.filter((p) => p.status !== 'found').length;
  const ki = Object.keys(BOARDS).indexOf(boardKind);
  const head = boardKind === 'inquiry' ? (answered ? `선생님 답변 <b>${answered}건</b> · 대기 ${waiting}건` : `답변을 기다리는 글 <b>${waiting}건</b>`)
    : boardKind === 'lost_report' ? `분실 신고 <b>${posts.length}건</b> · 답변 대기 ${waiting}건`
    : `관리실에 물건 <b>${keep}개</b>를 보관 중이에요`;
  const EMPTY = { inquiry: ['message-circle', '아직 보낸 문의가 없어요', '시설·소음·좌석 문제를 선생님께 알려주세요. 선생님만 볼 수 있어요.'],
    lost_report: ['search', '분실 신고 내역이 없어요', '물건을 잃어버렸다면 언제, 어디서 잃어버렸는지 적어 신고해요.'],
    lost_found: ['package', '보관 중인 물건이 없어요', '관리실에서 물건을 맡으면 여기에 올라와요.'] }[boardKind];
  const tagOf = (p) => mine ? `<span class="tag ${p.answer ? 'blue' : ''}">${STATUS[p.status]?.[0] || h(p.status)}</span>` : `<span class="tag ${p.status === 'found' ? '' : 'blue'}">${p.status === 'found' ? '주인 찾음' : '보관 중'}</span>`;
  paint(`
    ${ptitle('문의')}
    <div class="seg" role="tablist" style="--n:3;--i:${ki}"><span class="thumb"></span>${Object.entries(BOARDS).map(([k, l]) => `<button role="tab" aria-selected="${boardKind === k}" data-k="${k}" class="${boardKind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${posts.length ? banner(boardKind === 'inquiry' ? 'message-circle' : boardKind === 'lost_report' ? 'search' : 'package', head) : ''}
    ${posts.length ? `<section class="card flush">${posts.map((p) => `<details class="doc">
      <summary><div class="dtx"><b>${h(p.title)}</b><small>${p.category ? `${h(p.category)} · ` : ''}${ago(p.created_at)}</small></div>${tagOf(p)}<i class="ti ti-chevron-down chev"></i></summary>
      <div class="dbody"><p>${h(p.body)}</p>
        ${p.answer ? `<div class="ans"><div class="ans-h"><b>선생님 답변</b><span>${ago(p.answered_at)}</span></div><p>${h(p.answer)}</p></div>` : ''}
        ${mine && p.status === 'open' ? `<button class="lnk red" data-del="${p.id}">삭제하기</button>` : ''}</div></details>`).join('')}</section>`
      : `<section class="card"><div class="empty"><i class="ti ti-${EMPTY[0]}"></i><b>${EMPTY[1]}</b><span>${EMPTY[2]}</span></div></section>`}
    ${mine ? `<div class="cta-wrap"><button class="cta" id="write">${boardKind === 'inquiry' ? '문의 남기기' : '분실 신고하기'}</button></div>` : ''}`);
  const v = view();
  v.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { if (boardKind === b.dataset.k) return; boardKind = b.dataset.k; v.querySelector('.seg').style.setProperty('--i', Object.keys(BOARDS).indexOf(boardKind)); v.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('on', x === b)); setTimeout(board, 180); });
  v.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (!confirm('이 글을 삭제할까요?')) return; await api.del(`/api/posts/${b.dataset.del}`); toast('삭제했어요'); board(); });
  v.querySelector('#write')?.addEventListener('click', write);
}
function write() {
  const lost = boardKind === 'lost_report';
  const cats = lost ? ['전자기기', '필기구', '의류', '지갑·카드', '기타'] : ['시설', '소음', '좌석', '운영', '기타'];
  modal(`<form class="sheetf" novalidate><div class="handle"></div><h2>${lost ? '분실 신고' : '문의 남기기'}</h2>
    <div class="fld"><span>분류</span><div class="chips" role="radiogroup" aria-label="분류">${cats.map((c, i) => `<label><input type="radio" name="cat" value="${c}" ${i === 0 ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></div>
    <label class="fld"><span>${lost ? '잃어버린 물건' : '제목'}</span><input class="input" name="title" maxlength="100" placeholder="${lost ? '예: 검정 무선 이어폰' : '예: 3열 에어컨이 너무 세요'}" autocomplete="off"><span class="fld-foot"><em class="err" id="e1"></em></span></label>
    <label class="fld"><span>${lost ? '언제·어디서·특징' : '내용'}</span><textarea class="input" name="body" rows="5" maxlength="1000" placeholder="${lost ? '예: 11월 16일 저녁, B23 자리 근처, 케이스에 스티커' : '선생님만 볼 수 있어요'}"></textarea><span class="fld-foot"><em class="err" id="e2"></em><em class="cnt" id="cnt">0 / 1000</em></span></label>
    <button class="cta" id="send" style="margin-top:4px">보내기</button></form>`, {
    onMount: (m, close) => {
      const f = m.querySelector('form'), cnt = m.querySelector('#cnt');
      f.body.oninput = () => { cnt.textContent = `${f.body.value.length} / 1000`; m.querySelector('#e2').textContent = ''; f.body.removeAttribute('aria-invalid'); };
      f.title.oninput = () => { m.querySelector('#e1').textContent = ''; f.title.removeAttribute('aria-invalid'); };
      setTimeout(() => f.title.focus(), 350);
      f.onsubmit = async (e) => {
        e.preventDefault();
        let bad = false;
        if (f.title.value.trim().length < 2) { m.querySelector('#e1').textContent = lost ? '물건 이름을 적어주세요' : '제목을 두 글자 이상 적어주세요'; f.title.setAttribute('aria-invalid', 'true'); bad = true; }
        if (f.body.value.trim().length < 5) { m.querySelector('#e2').textContent = '내용을 다섯 글자 이상 적어주세요'; f.body.setAttribute('aria-invalid', 'true'); bad = true; }
        if (bad) return;
        const btn = m.querySelector('#send'); btn.disabled = true; btn.textContent = '보내는 중';
        try { await api.post('/api/posts', { board: boardKind, title: f.title.value, body: f.body.value, category: f.cat.value }); close(); toast(lost ? '분실 신고를 접수했어요' : '선생님께 보냈어요'); board(); }
        catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = '보내기'; }
      };
    },
  });
}

// ---------- 공지 ----------
async function notice() {
  clearInterval(timer);
  const { posts } = await api.get('/api/posts?board=notice');
  const pinned = posts.filter((p) => p.pinned), rest = posts.filter((p) => !p.pinned);
  const item = (p, open) => `<details class="doc" ${open ? 'open' : ''}><summary><div class="dtx"><b>${h(p.title)}</b><small>${fmtDate(p.created_at)} · ${ago(p.created_at)}</small></div>${p.pinned ? '<span class="tag blue">고정</span>' : ''}<i class="ti ti-chevron-down chev"></i></summary><div class="dbody"><p>${h(p.body)}</p></div></details>`;
  paint(`
    ${ptitle('공지')}
    ${pinned.length ? `<section class="card flush"><p class="grp">꼭 읽어주세요</p>${pinned.map((p, i) => item(p, i === 0)).join('')}</section>` : ''}
    ${rest.length ? `<section class="card flush"><p class="grp">지난 공지</p>${rest.map((p) => item(p)).join('')}</section>` : ''}
    ${posts.length ? '' : '<section class="card"><div class="empty"><i class="ti ti-speakerphone"></i><b>아직 공지가 없어요</b><span>선생님이 공지를 올리면 여기에서 볼 수 있어요.</span></div></section>'}`);
}

boot();
