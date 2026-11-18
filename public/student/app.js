import { createApi, h, fmtDate, toast, modal, renderSeatMap, LOGO } from '/common/api.js';

const api = createApi('student');
const app = document.getElementById('app');
let me = null; let tab = 'home'; let timer = null; let boardKind = 'inquiry';

api.onUnauthorized = () => { me = null; renderLogin(); };

const korDur = (m) => { m = Math.max(0, Math.round(m || 0)); const hh = Math.floor(m / 60), mm = m % 60; return hh ? (mm ? `${hh}시간 ${mm}분` : `${hh}시간`) : `${mm}분`; };
const koreaClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
const clk = (ms) => koreaClock.format(ms);
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
      <p class="school">선린인터넷고등학교</p><h1>선린 야자실</h1>
      ${authCfg.google_client_id ? '<p class="desc">학교 구글 계정으로 로그인해 주세요.</p>' : ''}
    </div>
    <div class="auth-form">
      <div id="gbtn" class="gbtn"></div>
      ${authCfg.google_client_id ? `<p class="note">@${h(authCfg.school_domain || 'sunrint.hs.kr')} 계정만 사용할 수 있어요</p>` : ''}
      ${authCfg.password_login ? `<details class="dev" ${authCfg.google_client_id ? '' : 'open'}><summary>학번으로 로그인<i class="ti ti-chevron-down"></i></summary>
        <form><label class="field">학번<input class="input" name="id" placeholder="학번 입력" inputmode="numeric" autocomplete="username" required></label><label class="field">비밀번호<input class="input" name="pw" type="password" placeholder="비밀번호 입력" autocomplete="current-password" required></label><button class="btn primary block">로그인</button></form></details>` : ''}
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
    google.accounts.id.renderButton(app.querySelector('#gbtn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: w, locale: 'ko', logo_alignment: 'center' });
  } catch (err) { app.querySelector('#gbtn').textContent = err.message; }
}

// ---------- 셸 ----------
const TABIC = { home: 'home', seats: 'armchair', record: 'calendar', board: 'message-circle', notice: 'bell' };
const TABS = [['home', '홈'], ['seats', '좌석'], ['record', '기록'], ['board', '문의'], ['notice', '공지']];
function renderShell() {
  app.innerHTML = `
    <header class="appbar">
      <div class="appbar-brand"><img src="${LOGO}" alt=""><span class="title">선린인터넷고</span></div>
      <button class="appbar-back iconbtn" id="back-home" type="button" aria-label="홈으로 돌아가기" hidden><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
      <span class="appbar-page" hidden>좌석표</span>
      <button class="avatar" id="mebtn" aria-label="내 정보">${h((me.name || '?').slice(-2))}</button>
    </header>
    <main id="view"></main>
    <nav class="tabbar" aria-label="학생 메뉴">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-current="${tab === k}"><span class="tab-icon"><i class="ti ti-${TABIC[k]}" aria-hidden="true"></i></span><span>${l}</span></button>`).join('')}</nav>`;
  app.querySelector('#mebtn').onclick = mySheet;
  app.querySelector('#back-home').onclick = () => go('home');
  refreshBadge();
  app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => go(b.dataset.tab));
  showPage();
}
const pages = { home, seats: seat, record, board, notice };
window.addEventListener('hashchange', () => { if (me && view()) showPage(); });

function go(page) {
  if (location.hash === `#${page}`) {
    scrollTo(0, 0);
    return;
  }
  location.hash = page;
}

async function showPage() {
  const name = location.hash.slice(1);
  const page = Object.hasOwn(pages, name) ? name : 'home';
  tab = page;
  const appbar = app.querySelector('.appbar');
  appbar.classList.toggle('in-detail', page === 'seats');
  appbar.querySelector('.appbar-brand').hidden = page === 'seats';
  appbar.querySelector('.appbar-back').hidden = page !== 'seats';
  appbar.querySelector('.appbar-page').hidden = page !== 'seats';
  const currentView = view();
  document.querySelector('dialog.seat-detail[open]')?.close();
  app.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('on', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  clearInterval(timer);
  currentView.innerHTML = '';
  scrollTo(0, 0);
  try {
    await pages[page]();
    if (view() === currentView && location.hash.slice(1) === name) {
      const heading = currentView.querySelector('h1');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
  } catch (err) {
    if (view() !== currentView || location.hash.slice(1) !== name) return;
    currentView.innerHTML = '<div class="view-state"><p>화면을 불러오지 못했어요.</p><button class="btn" type="button">다시 시도</button></div>';
    currentView.querySelector('button').onclick = showPage;
  }
}
const paint = (html) => { view().innerHTML = html; };
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

const weekdays = '월화수목금토일';
function weekBars(stats, todayKey) {
  const max = Math.max(60, ...stats.week_days.map(({ minutes }) => minutes));
  return `<div class="wk" role="list" aria-label="요일별 공부 시간">${stats.week_days.map((day, i) => `
    <div role="listitem" aria-label="${weekdays[i]}요일 ${day.day > todayKey ? '예정' : korDur(day.minutes)}${day.day === todayKey ? ', 오늘' : ''}" class="${day.day === todayKey ? 'today' : ''} ${day.day > todayKey ? 'fut' : ''}">
      <span class="wk-col" aria-hidden="true"><span class="wk-v">${day.minutes ? hm(day.minutes) : ''}</span><span class="wk-bar" style="height:${day.minutes ? Math.max(4, day.minutes / max * 72) : 0}px"></span></span>
      <span class="wk-d" aria-hidden="true">${weekdays[i]}</span>
    </div>`).join('')}</div>`;
}
const ptitle = (t, right = '') => `<div class="ptitle"><h1>${t}</h1>${right}</div>`;

// 안 읽은 선생님 답변 배지
const seenKey = () => `sssms_seen_answers_${me.id}`;
const getSeen = () => { try { return +localStorage.getItem(seenKey()) || 0; } catch { return 0; } };
async function refreshBadge(answered) {
  if (answered == null) { try { answered = (await api.get('/api/posts?board=inquiry')).posts.filter((p) => p.answer).length; } catch { return; } }
  if (!me) return;
  const n = Math.max(0, answered - getSeen());
  const b = app.querySelector('[data-tab=board]'); if (!b) return;
  b.querySelector('.tbadge')?.remove();
  if (n) b.insertAdjacentHTML('beforeend', `<span class="tbadge">${n}</span>`);
}

async function home() {
  const v = view();
  v.innerHTML = '<p class="view-state" role="status">야자실 현황을 불러오는 중이에요</p>';
  const pending = v.firstElementChild;
  const stats = await api.get('/api/me/stats');
  if (!pending.isConnected) return;

  const currentTime = clk(Date.now());
  const running = currentTime >= stats.open_time && currentTime < stats.close_time;
  const currentSeat = stats.open?.seat || me.fixed_seat;
  const completed = stats.today_sessions.findLast((session) => session.check_out);
  const session = stats.open || completed;
  const sessionStatus = stats.open ? `${clk(stats.open.check_in)} 입실` : completed ? `${clk(completed.check_out)} 퇴실` : '';
  const free = stats.free_seats;
  const roomStatus = currentTime < stats.open_time ? `${stats.open_time}에 시작` : running ? `${stats.close_time}까지 운영` : '운영 종료';
  v.innerHTML = `
    <div class="student-home">
      <section class="home-panel" aria-labelledby="room-panel-title">
        <h1 class="panel-title" id="room-panel-title"><button class="panel-header" id="open-seats" type="button">야자실<i class="ti ti-chevron-right" aria-hidden="true"></i></button></h1>
        <div class="panel-row">
          <span class="panel-icon" aria-hidden="true"><i class="ti ti-layout-grid"></i></span>
          <span class="panel-copy"><small>${h(roomStatus)}${currentSeat ? ` · ${stats.open?.seat ? '이용 중' : '지정석'} ${h(currentSeat)}` : ''}</small><b>빈 자율석 ${free}석</b></span>
          <button class="row-action" id="seat-action" type="button">좌석표</button>
        </div>
      </section>

      <section class="home-panel" aria-labelledby="home-record-title">
        <h2 class="panel-title" id="home-record-title"><button class="panel-header" id="open-record" type="button">공부 기록<i class="ti ti-chevron-right" aria-hidden="true"></i></button></h2>
        ${session ? `<div class="panel-row">
          <span class="panel-icon" aria-hidden="true"><i class="ti ti-clock-hour-4"></i></span>
          <span class="panel-copy"><small>오늘 공부 · ${h(sessionStatus)}</small><b id="home-time">${korDur(stats.today_minutes)}</b></span>
        </div>` : ''}
        <div class="panel-row">
          <span class="panel-icon" aria-hidden="true"><i class="ti ti-chart-bar"></i></span>
          <span class="panel-copy"><small>이번 주 공부 시간</small><b>${korDur(stats.week_minutes)}</b></span>
          <button class="row-action" id="record-action" type="button">내역</button>
        </div>
        <div class="panel-row attendance-row">
          <span class="panel-icon" aria-hidden="true"><i class="ti ti-calendar-check"></i></span>
          <span class="panel-copy"><small>이번 주 출석</small><b>${stats.week_days.filter((day) => day.minutes > 0).length}일</b></span>
        </div>
      </section>

      ${stats.notice ? `<section class="home-panel" aria-labelledby="home-notice-title">
        <h2 class="panel-title" id="home-notice-title"><button class="panel-header" id="open-notice" type="button">공지<i class="ti ti-chevron-right" aria-hidden="true"></i></button></h2>
        <button class="panel-row panel-row-button" id="notice-action" type="button">
          <span class="panel-icon" aria-hidden="true"><i class="ti ti-bell"></i></span>
          <span class="panel-copy"><small>${ago(stats.notice.created_at)}</small><b>${h(stats.notice.title)}</b></span>
        </button>
      </section>` : ''}
    </div>`;
  v.querySelector('#open-seats').onclick = () => go('seats');
  v.querySelector('#seat-action').onclick = () => go('seats');
  v.querySelector('#open-record').onclick = () => go('record');
  v.querySelector('#record-action').onclick = () => go('record');
  v.querySelector('#open-notice')?.addEventListener('click', () => go('notice'));
  v.querySelector('#notice-action')?.addEventListener('click', () => go('notice'));
  if (stats.open) {
    const loadedAt = Date.now();
    const time = v.querySelector('#home-time');
    timer = setInterval(() => {
      time.textContent = korDur(stats.today_minutes + (Date.now() - loadedAt) / 60000);
    }, 15000);
  }
}

function todayTimeline(s) {
  const minutes = (time) => {
    const [hours, mins] = time.split(':').map(Number);
    return hours * 60 + mins;
  };
  const start = minutes(s.open_time);
  const end = minutes(s.close_time);
  const duration = Math.max(60, end - start);
  const midnight = Date.parse(`${s.heatmap.at(-1).day}T00:00:00+09:00`);
  const position = (ms) => Math.max(0, Math.min(100, ((ms - midnight) / 60000 - start) / duration * 100));
  return `<div class="tl" aria-label="오늘 공부한 시간대">
    <div class="tl-track">${s.today_sessions.map((session) => {
      const left = position(session.check_in);
      const right = position(session.check_out ?? Date.now());
      return `<i class="tl-seg" style="left:${left}%;width:${Math.max(0, right - left)}%"></i>`;
    }).join('')}</div>
    <div class="tl-hours"><span>${h(s.open_time)}</span><span>${h(s.close_time)}</span></div>
  </div>`;
}

async function record() {
  const currentView = view();
  currentView.innerHTML = '<p class="view-state" role="status">공부 기록을 불러오는 중이에요</p>';
  const pending = currentView.firstElementChild;
  const s = await api.get('/api/me/stats');
  if (!pending.isConnected) return;
  const goal = Number(s.daily_goal_min);
  const goalPercent = goal > 0 ? Math.min(100, Math.round(s.today_minutes / goal * 100)) : 0;
  const todayKey = s.heatmap.at(-1).day;
  const lvl = (m) => m === 0 ? 0 : m < 60 ? 1 : m < 120 ? 2 : m < 240 ? 3 : 4;
  const first = new Date(s.heatmap[0].day + 'T00:00:00'); const pad = (first.getDay() + 6) % 7;
  const cols = Math.ceil((s.heatmap.length + pad) / 7);
  const months = []; s.heatmap.forEach((d, i) => { if (d.day.endsWith('-01')) months.push({ c: Math.floor((i + pad) / 7), m: +d.day.slice(5, 7) }); });
  const attendedDays = s.heatmap.filter((d) => d.minutes).length;
  const avg = attendedDays ? Math.round(s.heatmap.reduce((a, d) => a + d.minutes, 0) / attendedDays) : 0;
  const best = s.heatmap.reduce((a, d) => (d.minutes > a.minutes ? d : a), { minutes: 0 });
  paint(`
    ${ptitle('공부 기록')}
    <section class="record-section record-today">
      <div class="card-h"><h2>오늘 공부</h2><span class="note">누적 ${korDur(s.total_minutes)}</span></div>
      <p class="amount">${korDur(s.today_minutes)}</p>
      ${goal > 0 ? `<p class="note">목표 ${korDur(goal)} · ${goalPercent}%</p>` : ''}
      ${todayTimeline(s)}
      ${s.today_sessions.length ? `<ul class="record-sessions">${s.today_sessions.map((session) => `<li><span>${clk(session.check_in)}–${session.check_out ? clk(session.check_out) : '공부 중'}</span><b>${korDur(((session.check_out ?? Date.now()) - session.check_in) / 60000)}</b></li>`).join('')}</ul>` : ''}
    </section>

    <section class="record-section">
      <div class="card-h"><h2>이번 주 공부</h2><span class="tag">${s.streak.current}일 연속</span></div>
      <p class="amount">${korDur(s.week_minutes)}</p>
      ${weekBars(s, todayKey)}
      <div class="facts"><div><span>최고 연속</span><b>${s.streak.best}일</b></div><div><span>하루 평균</span><b>${avg ? korDur(avg) : '–'}</b></div><div><span>누적 출석</span><b>${s.streak.total_days}일</b></div></div>
    </section>

    <section class="record-section" id="rank">
      <div class="card-h"><h2>이번 주 순위</h2></div>
      <p class="amount">${s.rank ? `${s.rank}위` : '–'}<span class="of">/ ${s.rank_total}명</span></p>
      <div class="rk">${s.top.map((t, i) => `<div class="${t.me ? 'me' : ''}"><em>${i + 1}</em><span class="nm">${h(t.name)}${t.me ? '<span class="tag blue">나</span>' : ''}</span><b>${korDur(t.minutes)}</b></div>`).join('')}
        ${s.rank > 5 ? `<div class="me gap"><em>${s.rank}</em><span class="nm">${h(me.name)}<span class="tag blue">나</span></span><b>${korDur(s.week_minutes)}</b></div>` : ''}</div>
      <p class="note" style="margin-top:8px">다른 학생 이름은 가운데 글자를 가려서 보여줘요</p>
    </section>

    <section class="record-section">
      <div class="card-h"><h2>최근 4개월</h2></div>
      <p class="amount">${attendedDays}일 출석</p>
      ${best.minutes ? `<p class="note">가장 오래 공부한 날 · ${+best.day.slice(5, 7)}월 ${+best.day.slice(8)}일 ${korDur(best.minutes)}</p>` : ''}
      <div class="hm-months" style="grid-template-columns:repeat(${cols},1fr)">${months.map((m) => `<span style="grid-column:${m.c + 1}">${m.m}월</span>`).join('')}</div>
      <div class="heat">${'<i class="pad"></i>'.repeat(pad)}${s.heatmap.map((d) => `<i class="l${lvl(d.minutes)}" title="${d.day} · ${korDur(d.minutes)}"></i>`).join('')}</div>
      <div class="heat-key"><span>적게</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>많이</span></div>
    </section>
    <p class="page-note">주말은 쉬어도 연속 출석이 끊기지 않아요.</p>`);
}

// ---------- 좌석 ----------
async function seat() {
  clearInterval(timer);
  const v = view();
  let previousMap;
  let loading = false;
  v.innerHTML = `
    <h1 class="sr-only">좌석표</h1>
    <section class="room-plan" aria-labelledby="room-availability">
      <div class="room-availability">
        <h2 id="room-availability">빈 자율석 <strong id="free-count" aria-live="polite">—</strong></h2>
        <button class="iconbtn" id="refresh" aria-label="좌석 새로고침"><i class="ti ti-refresh" aria-hidden="true"></i></button>
      </div>
      <div class="seat-view-switch" role="group" aria-label="좌석 보기 방식">
        <button type="button" id="show-map" aria-pressed="true">배치도</button>
        <button type="button" id="show-free" aria-pressed="false">빈 자리 목록</button>
      </div>
      <div id="seat-plan">
      <div class="room-floor">
        <div class="room-chalkboard">칠판</div>
        <div id="map" aria-label="교실 좌석 배치"></div>
      </div>
      <div class="legend">${[['free', '빈 자율석'], ['occ', '사용 중'], ['fixed', '지정석'], ['mine', '내 자리']].map(([key, label]) => `<span><i class="sw ${key}"></i>${label}</span>`).join('')}</div>
      </div>
      <div id="free-list" hidden></div>
    </section>
    <div class="room-footer"><span id="room-personal"></span><span>입실·퇴실은 키오스크에서</span></div>`;
  const map = v.querySelector('#map');
  const active = () => tab === 'seats' && view() === v && v.contains(map);
  const refresh = v.querySelector('#refresh');
  const plan = v.querySelector('#seat-plan');
  const list = v.querySelector('#free-list');
  const showMap = v.querySelector('#show-map');
  const showFree = v.querySelector('#show-free');
  const setSeatView = (isMap) => {
    plan.hidden = !isMap;
    list.hidden = isMap;
    showMap.setAttribute('aria-pressed', isMap);
    showFree.setAttribute('aria-pressed', !isMap);
  };
  showMap.onclick = () => setSeatView(true);
  showFree.onclick = () => setSeatView(false);
  const load = async () => {
    if (loading || !active()) return;
    loading = true;
    refresh.disabled = true;
    try {
      const d = await api.get('/api/seats');
      if (!active()) return;
      const free = d.seats.filter((seat) => seat.type === 'free' && !seat.occupied).sort((a, b) => a.y - b.y || a.x - b.x);
      const mine = d.seats.find((seat) => seat.mine);
      v.querySelector('#free-count').textContent = `${free.length}석`;
      v.querySelector('#room-personal').textContent = mine ? `사용 중 · ${mine.label}`
        : me.fixed_seat ? `내 지정석 · ${me.fixed_seat}` : '';
      const mapState = JSON.stringify(d);
      if (mapState !== previousMap) {
        renderSeatMap(map, d, { pickable: (seat) => seat.type !== 'disabled', onPick: seatSheet });
        list.innerHTML = free.length
          ? `<ul class="free-seat-list">${free.map((seat, i) => `<li><button type="button" data-free="${i}">${h(seat.label)}</button></li>`).join('')}</ul>`
          : '<p class="free-seat-empty">지금은 빈 자율석이 없어요.</p>';
        list.querySelectorAll('[data-free]').forEach((button) => {
          button.onclick = () => seatSheet(free[Number(button.dataset.free)]);
        });
        previousMap = mapState;
      }
    } catch (err) {
      if (active()) toast(err.message, 'error');
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  };
  refresh.onclick = load;
  await load();
  if (active()) timer = setInterval(load, 20000);
}

function seatSheet(seat) {
  const status = seat.mine ? '내 자리' : seat.occupied ? '사용 중' : seat.type === 'fixed' ? '지정석' : '빈 자율석';
  const dialog = document.createElement('dialog');
  dialog.className = 'seat-detail';
  dialog.setAttribute('aria-labelledby', 'seat-detail-title');
  dialog.innerHTML = `
    <div class="seat-detail-heading"><h2 id="seat-detail-title">${h(seat.label)}</h2><span>${status}</span></div>
    <dl class="seat-facts">
      <div><dt>위치</dt><dd>앞에서 ${seat.y + 1}번째 줄 · 왼쪽에서 ${seat.x + 1}번째</dd></div>
      ${seat.occupied ? `<div><dt>사용 시작</dt><dd>${clk(seat.occ_since)}</dd></div>` : ''}
    </dl>
    <form method="dialog"><button class="cta" autofocus>닫기</button></form>`;
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

// ---------- 문의 · 분실 (토스 문서함 패턴) ----------
const BOARDS = { inquiry: '문의·건의', lost_report: '분실 신고', lost_found: '보관함' };
const STATUS = { open: ['답변 대기', 'gray'], answered: ['답변 완료', 'blue'], found: ['찾음', 'blue'], closed: ['종료', 'gray'] };
async function board() {
  clearInterval(timer);
  const kind = boardKind;
  const currentView = view();
  const { posts } = await api.get(`/api/posts?board=${kind}`);
  if (tab !== 'board' || view() !== currentView || kind !== boardKind) return;
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
    ${ptitle('문의', mine ? `<button class="compose-action" id="write" type="button"><i class="ti ti-pencil" aria-hidden="true"></i>${boardKind === 'inquiry' ? '문의 쓰기' : '신고 쓰기'}</button>` : '')}
    <div class="seg" role="tablist" style="--n:3;--i:${ki}"><span class="thumb"></span>${Object.entries(BOARDS).map(([k, l]) => `<button role="tab" aria-selected="${boardKind === k}" data-k="${k}" class="${boardKind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${posts.length ? `<p class="board-summary" role="status">${head}</p>` : ''}
    ${posts.length ? `<section class="card flush">${posts.map((p) => `<details class="doc">
      <summary><div class="dtx"><b>${h(p.title)}</b><small>${p.category ? `${h(p.category)} · ` : ''}${ago(p.created_at)}</small></div>${tagOf(p)}<i class="ti ti-chevron-down chev"></i></summary>
      <div class="dbody"><p>${h(p.body)}</p>
        ${p.answer ? `<div class="ans"><div class="ans-h"><b>선생님 답변</b><span>${ago(p.answered_at)}</span></div><p>${h(p.answer)}</p></div>` : ''}
        ${mine && p.status === 'open' ? `<button class="lnk red" data-del="${p.id}">삭제하기</button>` : ''}</div></details>`).join('')}</section>`
      : `<section class="card"><div class="empty"><i class="ti ti-${EMPTY[0]}"></i><b>${EMPTY[1]}</b><span>${EMPTY[2]}</span></div></section>`}
    `);
  const v = view();
  v.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { if (boardKind === b.dataset.k) return; boardKind = b.dataset.k; v.querySelector('.seg').style.setProperty('--i', Object.keys(BOARDS).indexOf(boardKind)); v.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('on', x === b)); board().catch((err) => { if (tab === 'board') toast(err.message, 'error'); }); });
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
  const currentView = view();
  const { posts } = await api.get('/api/posts?board=notice');
  if (tab !== 'notice' || view() !== currentView) return;
  const pinned = posts.filter((p) => p.pinned), rest = posts.filter((p) => !p.pinned);
  const item = (p, open) => `<details class="doc" ${open ? 'open' : ''}><summary><div class="dtx"><b>${h(p.title)}</b><small>${fmtDate(p.created_at)} · ${ago(p.created_at)}</small></div>${p.pinned ? '<span class="tag blue">고정</span>' : ''}<i class="ti ti-chevron-down chev"></i></summary><div class="dbody"><p>${h(p.body)}</p></div></details>`;
  paint(`
    ${ptitle('공지')}
    ${pinned.length ? `<section class="card flush"><p class="grp">고정 공지</p>${pinned.map((p, i) => item(p, i === 0)).join('')}</section>` : ''}
    ${rest.length ? `<section class="card flush"><p class="grp">지난 공지</p>${rest.map((p) => item(p)).join('')}</section>` : ''}
    ${posts.length ? '' : '<section class="card"><div class="empty"><i class="ti ti-speakerphone"></i><b>아직 공지가 없어요</b><span>선생님이 공지를 올리면 여기에서 볼 수 있어요.</span></div></section>'}`);
}

boot();
