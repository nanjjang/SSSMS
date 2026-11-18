import { createApi, h, fmtDate, toast, modal, renderSeatMap, LOGO } from '/common/api.js';
import { isNative, nativeGoogleIdToken, nativeGoogleSignOut } from '/common/native.js';

const api = createApi('student');
const app = document.getElementById('app');
let me = null; let tab = 'home'; let timer = null; let boardKind = 'inquiry';

api.onUnauthorized = () => { me = null; renderLogin(); };

const korDur = (m) => { m = Math.max(0, Math.round(m || 0)); const hh = Math.floor(m / 60), mm = m % 60; return hh ? (mm ? `${hh}시간 ${mm}분` : `${hh}시간`) : `${mm}분`; };
const koreaClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
const clk = (ms) => koreaClock.format(ms);
// 히어로용: 숫자는 크게, 단위는 작게 (2시간 15분 → 2 시간 15 분)
const heroTime = (m) => { m = Math.max(0, Math.round(m || 0)); const hh = Math.floor(m / 60), mm = m % 60; return `${hh ? `<span class="n">${hh}</span><span class="u">시간</span>` : ''}<span class="n">${mm}</span><span class="u">분</span>`; };
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
  if (isNative()) { // 앱: WebView 에서는 구글 웹 로그인이 막히므로 네이티브 로그인 사용
    const box = app.querySelector('#gbtn');
    box.innerHTML = '<button class="btn primary block" type="button"><i class="ti ti-brand-google"></i> 학교 구글 계정으로 계속하기</button>';
    box.querySelector('button').onclick = async (ev) => {
      const b = ev.currentTarget; b.disabled = true;
      try { await finishGoogle(await api.post('/api/auth/google', { credential: await nativeGoogleIdToken(authCfg) })); }
      catch (err) { if (!/cancel/i.test(err?.message || '')) toast(err.message || '로그인에 실패했어요', 'error'); b.disabled = false; }
    };
    return;
  }
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
      <span></span>
      <span class="appbar-page" aria-hidden="true"></span>
      ${meBtn()}
    </header>
    <main id="view"></main>
    <nav class="tabbar" aria-label="학생 메뉴">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-current="${tab === k}"><span class="tab-icon"><i class="ti ti-${TABIC[k]}" aria-hidden="true"></i></span><span>${l}</span></button>`).join('')}</nav>`;
  refreshBadge();
  app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => go(b.dataset.tab));
  showPage();
}
const pages = { home, seats: seat, record, board, notice };
const PAGE_TITLE = { home: '오늘', seats: '좌석', record: '기록', board: '문의', notice: '공지' };
// 큰 제목이 스크롤로 사라지면 상단 바에 작은 제목이 나타난다 (iOS 내비게이션 바)
addEventListener('scroll', () => app.querySelector('.appbar')?.classList.toggle('scrolled', scrollY > 40), { passive: true });
// 프로필 버튼은 페이지마다 큰 제목 줄에 있어서 이벤트 위임으로 처리
app.addEventListener('click', (e) => { if (me && e.target.closest('.js-me')) mySheet(); });
// ---------- iOS 네이티브 동작 ----------
const EASE = 'cubic-bezier(.32,.72,0,1)'; // iOS 화면 전환·시트 곡선

// UIAlertController 스타일 알림창
const iosAlert = ({ title, message = '', ok = '확인', cancel = '취소', destructive = false }) => new Promise((resolve) => {
  const d = document.createElement('dialog');
  d.className = 'ios-alert'; d.setAttribute('aria-labelledby', 'ia-t');
  d.innerHTML = `<div class="ia-body"><h2 id="ia-t">${h(title)}</h2>${message ? `<p>${h(message)}</p>` : ''}</div>
    <div class="ia-btns">${cancel ? `<button type="button" value="0">${h(cancel)}</button>` : ''}<button type="button" value="1" class="${destructive ? 'bad' : 'bold'}">${h(ok)}</button></div>`;
  let result = false;
  d.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { result = b.value === '1'; d.close(); } });
  d.addEventListener('close', () => { d.remove(); resolve(result); }, { once: true });
  document.body.append(d); d.showModal();
});

// 시트 상단(그랩바·제목 줄)을 잡고 아래로 끌면 닫힌다
function dragToDismiss(sheet, dismiss, grabZone = 60) {
  let y0 = null; let dy = 0; let t0 = 0;
  sheet.addEventListener('touchstart', (e) => {
    const y = e.touches[0].clientY;
    if (y - sheet.getBoundingClientRect().top > grabZone) { y0 = null; return; }
    y0 = y; dy = 0; t0 = Date.now(); sheet.style.transition = 'none';
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (y0 == null) return;
    const fast = dy / Math.max(1, Date.now() - t0) > 0.5;
    sheet.style.transition = `transform .35s ${EASE}`;
    if (dy > 110 || (fast && dy > 30)) dismiss(); else sheet.style.transform = '';
    y0 = null;
  });
}
// 공통 modal()로 열리는 모든 시트에 적용
new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => {
  if (n.nodeType === 1 && n.classList.contains('modal-bg')) dragToDismiss(n.querySelector('.modal'), () => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}))).observe(document.body, { childList: true });

// 화면 왼쪽 가장자리에서 오른쪽으로 쓸면 뒤로, 맨 위에서 아래로 당기면 새로고침
const ptrEl = document.createElement('div');
ptrEl.className = 'ptr'; ptrEl.innerHTML = '<span class="spinner"></span>'; document.body.append(ptrEl);
const setPtr = (d, spin = false) => { ptrEl.style.setProperty('--d', `${d}px`); ptrEl.style.opacity = Math.min(1, d / 40); ptrEl.classList.toggle('spin', spin); };
let swipe = null; let pull = null;
addEventListener('touchstart', (e) => {
  if (!me || document.querySelector('.modal-bg, dialog[open]')) { swipe = pull = null; return; }
  const t = e.touches[0];
  swipe = null;
  pull = scrollY <= 0 ? { y: t.clientY, d: 0 } : null;
}, { passive: true });
addEventListener('touchmove', (e) => {
  if (!pull) return;
  const d = e.touches[0].clientY - pull.y;
  if (d > 0 && scrollY <= 0) { pull.d = Math.min(96, d * 0.45); setPtr(pull.d); } else if (d < 0) { pull = null; setPtr(0); }
}, { passive: true });
addEventListener('touchend', async (e) => {
  const t = e.changedTouches[0];
  if (swipe && t.clientX - swipe.x > 80 && Math.abs(t.clientY - swipe.y) < 60) go('home');
  swipe = null;
  if (!pull) return;
  const fire = pull.d >= 48; pull = null;
  if (!fire) return setPtr(0);
  setPtr(48, true);
  try { await showPage(); } finally { setPtr(0); }
});

const meBtn = () => `<button class="avatar js-me" type="button" aria-label="내 정보">${h((me?.name || '?').slice(-2))}</button>`;
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
  const from = tab;
  tab = page;
  const appbar = app.querySelector('.appbar');
  appbar.querySelector('.appbar-page').textContent = PAGE_TITLE[page];
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
  // 좌석표는 push(오른쪽에서 들어옴), 홈으로 돌아올 땐 pop, 탭끼리는 페이드
  currentView.classList.remove('nav-fade'); void currentView.offsetWidth;
  currentView.classList.add('nav-fade');
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
  const row = (label, value) => `<div class="srow"><span class="slab">${label}</span><span class="sval">${value}</span></div>`;
  modal(`<div class="sheet-nav"><button type="button" class="x" data-close aria-label="닫기"><i class="ti ti-x" aria-hidden="true"></i></button><h2>계정</h2><span></span></div>
    <div class="sgroup"><div class="me-head"><div class="avatar lg">${h((me.name || '?').slice(-2))}</div><div><b>${h(me.name)}</b><span>${h(me.email || me.login_id)}</span></div></div></div>
    <div class="sgroup">
      ${row('학번', h(me.login_id))}
      ${row('학년 · 반 · 번호', `${h(me.grade ?? '-')}학년 ${h(me.class_no ?? '-')}반 ${h(me.number ?? '-')}번`)}
      ${row('지정석', me.fixed_seat ? h(me.fixed_seat) : '없음')}
      ${row('얼굴 등록', me.has_face ? '완료' : '선생님께 요청')}
    </div>
    <p class="sfoot">정보가 다르면 담당 선생님께 말해 주세요. 이름과 지정석은 선생님이 학번 기준으로 관리해요.</p>
    <div class="sgroup"><button type="button" class="srow-btn bad" id="lo">로그아웃</button></div>`, {
    onMount: (m, close) => m.querySelector('#lo').onclick = async () => {
      if (!await iosAlert({ title: '로그아웃', message: '이 기기에서 로그아웃할까요?', ok: '로그아웃', destructive: true })) return;
      close(); await api.logout(); try { google.accounts.id.disableAutoSelect(); } catch {} nativeGoogleSignOut(); renderLogin();
    },
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
const ptitle = (t, right = '') => `<div class="ptitle"><h1>${t}</h1><div class="ptitle-r">${right}</div></div>`;
const todayLabel = () => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());

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

// ---------- 공용 조각 ----------
const chev = '<i class="ti ti-chevron-right" aria-hidden="true"></i>';
const goBtn = `<span class="go">${chev}</span>`;
const sectionHead = (title, link = '', id = '') => `<div class="sh"><h2>${title}</h2>${link ? `<button type="button" class="sh-link" ${id ? `id="${id}"` : ''}>${link}</button>` : ''}</div>`;

// 좌석 미니맵
function miniMap(d) {
  const maxX = Math.max(d.cols, ...d.seats.map((s) => s.x + 1)); const maxY = Math.max(d.rows, ...d.seats.map((s) => s.y + 1));
  const grid = Array.from({ length: maxY }, () => Array(maxX).fill(null)); d.seats.forEach((s) => { grid[s.y][s.x] = s; });
  const cell = (s) => !s || s.type === 'disabled' ? '<i></i>' : `<i class="${s.mine ? 'mine' : s.occupied ? 'occ' : s.type === 'fixed' ? 'fixed' : 'free'}"></i>`;
  return `<span class="mini" style="--cols:${maxX}" aria-hidden="true">${grid.flat().map(cell).join('')}</span>`;
}

// 공지·문의 상세 시트
function postSheet(p, { label, deletable = false, onDelete } = {}) {
  modal(`<div class="sheet-nav"><button type="button" class="x" data-close aria-label="닫기"><i class="ti ti-x" aria-hidden="true"></i></button><h2>${h(label)}</h2><span></span></div>
    <div class="pd">
      <p class="pd-meta">${[p.category, p.pinned ? '고정' : '', `${fmtDate(p.created_at)} ${clk(p.created_at)}`].filter(Boolean).map(h).join(' · ')}</p>
      <h3 class="pd-title">${h(p.title)}</h3>
      <p class="pd-body">${h(p.body)}</p>
    </div>
    ${p.answer ? `<p class="sfoot sfoot-head">선생님 답변 · ${ago(p.answered_at)}</p><div class="sgroup"><p class="pd-answer">${h(p.answer)}</p></div>` : ''}
    ${deletable ? `<div class="sgroup" style="margin-top:16px"><button type="button" class="srow-btn bad" id="pdel">삭제</button></div>` : ''}`, {
    onMount: (m, close) => {
      m.querySelector('#pdel')?.addEventListener('click', async () => {
        if (!await iosAlert({ title: '글을 삭제할까요?', message: '삭제한 글은 되돌릴 수 없어요.', ok: '삭제', destructive: true })) return;
        close(); onDelete?.();
      });
    },
  });
}

const BANNER_KEY = 'sssms_banner_face';
const bannerDismissed = () => { try { return localStorage.getItem(BANNER_KEY) === '1'; } catch { return false; } };

async function home() {
  const v = view();
  v.innerHTML = '<div class="view-state" role="status"><span class="spinner"></span><span class="sr-only">불러오는 중</span></div>';
  const pending = v.firstElementChild;
  const [stats, seatData, noticeData] = await Promise.all([
    api.get('/api/me/stats'),
    api.get('/api/seats').catch(() => null),
    api.get('/api/posts?board=notice').catch(() => ({ posts: [] })),
  ]);
  if (!pending.isConnected) return;

  const currentTime = clk(Date.now());
  const running = currentTime >= stats.open_time && currentTime < stats.close_time;
  const completed = stats.today_sessions.findLast((session) => session.check_out);
  const roomStatus = currentTime < stats.open_time ? `${stats.open_time}에 시작` : running ? `${stats.close_time}까지 운영` : '운영 종료';
  const todayKey = stats.heatmap.at(-1).day;
  const goal = Number(stats.daily_goal_min) > 0 ? Number(stats.daily_goal_min) : 240;
  const attend = stats.week_days.filter((day) => day.minutes > 0).length;
  const state = stats.open ? { live: 'live', text: `공부 중 · ${clk(stats.open.check_in)} 입실` }
    : completed ? { live: '', text: `${clk(completed.check_out)} 퇴실` }
    : { live: '', text: running ? '입실 전' : currentTime < stats.open_time ? '운영 전' : '운영 종료' };
  const notices = [...noticeData.posts].sort((a, b) => (b.pinned - a.pinned) || (b.created_at - a.created_at)).slice(0, 3);
  const last = stats.open ? { from: stats.open.check_in, to: null, seat: stats.open.seat } : completed ? { from: completed.check_in, to: completed.check_out, seat: completed.seat } : null;

  // 추세: 이번 주 하루 평균 · 주간 출석을 이전 4주와 비교
  const weekDays = new Set(stats.week_days.map((d) => d.day));
  const prior = stats.heatmap.filter((d) => !weekDays.has(d.day) && d.day < stats.week_days[0].day).slice(-28);
  const priorAtt = prior.filter((d) => d.minutes > 0);
  const avgNow = attend ? stats.week_minutes / attend : 0;
  const avgPrev = priorAtt.length ? priorAtt.reduce((a, d) => a + d.minutes, 0) / priorAtt.length : 0;
  const dir = (now, prev) => !prev || !now ? 'minus' : now > prev * 1.05 ? 'chevron-up' : now < prev * 0.95 ? 'chevron-down' : 'minus';
  const trend = [
    ['하루 평균 공부', `${korDur(avgNow)}`, '/일', 'var(--m-move)', dir(avgNow, avgPrev)],
    ['주간 출석', `${attend}`, '일/주', 'var(--m-stand)', dir(attend, priorAtt.length / 4)],
    ['연속 출석', `${stats.streak.current}`, '일', 'var(--m-ex)', 'minus'],
    ['누적 공부', korDur(stats.total_minutes), '', 'var(--m-ex)', 'minus'],
  ];
  const weekMax = Math.max(60, ...stats.week_days.map(({ minutes }) => minutes));

  v.innerHTML = `
    <h1 class="sr-only">오늘</h1>
    <div class="lt-solo">${meBtn()}</div>

    ${!me.has_face && !bannerDismissed() ? `<section class="card banner" id="face-banner">
      <span class="banner-ico"><i class="ti ti-face-id" aria-hidden="true"></i></span>
      <div><b>얼굴이 아직 등록되지 않았어요</b><p>선생님께 얼굴 등록을 요청하면 키오스크에서 바로 입실할 수 있어요.</p></div>
      <button type="button" class="banner-x" id="banner-x" aria-label="닫기"><i class="ti ti-x" aria-hidden="true"></i></button>
    </section>` : ''}

    <button type="button" class="card act" id="open-record" aria-label="오늘 공부 기록 보기">
      <span class="ct"><h2>오늘 밤</h2><span class="ct-r ${state.live}"><i class="live-dot"></i>${h(state.text)}${goBtn}</span></span>
      <span class="night-v" id="home-time">${heroTime(stats.today_minutes)}</span>
      ${nightBar(stats)}
      <span class="night-stats">
        <span><small>목표</small><b>${Math.min(100, Math.round(stats.today_minutes / goal * 100))}<em>%</em></b></span>
        <span><small>이번 주 출석</small><b>${attend}<em>/5일</em></b></span>
        <span><small>종료까지</small><b>${running ? korDur(toMin(stats.close_time) - toMin(currentTime)) : '–'}</b></span>
      </span>
    </button>

    <div class="tiles">
      <button type="button" class="tile" data-go="record" style="--m:var(--m-ex)">
        <span class="ct"><h2>이번 주</h2>${goBtn}</span>
        <span class="tile-l">공부 시간</span>
        <span class="tile-v sm">${korDur(stats.week_minutes)}</span>
        <span class="chart"><span class="bars">${stats.week_days.map((d) => `<i class="${d.minutes ? '' : 'zero'}" style="height:${d.minutes ? Math.max(6, d.minutes / weekMax * 100) : 4}%"></i>`).join('')}</span>
        <span class="axis">${stats.week_days.map((d, i) => `<span class="${d.day === todayKey ? 'today' : ''}">${weekdays[i]}</span>`).join('')}</span></span>
      </button>
      <button type="button" class="tile" data-go="seats" style="--m:var(--m-stand)">
        <span class="ct"><h2>좌석</h2>${goBtn}</span>
        <span class="tile-l">빈 자율석</span>
        <span class="tile-v">${stats.free_seats}<span>석</span></span>
        ${seatData ? miniMap(seatData) : ''}
      </button>
    </div>

    <div class="tiles">
      <button type="button" class="tile" data-go="record" style="--m:var(--accent)">
        <span class="ct"><h2>세션</h2>${goBtn}</span>
        ${last ? `<span class="sess-ico"><img src="${LOGO}" alt=""></span>
        <span class="tile-l">${last.seat ? `${h(last.seat)} 자리` : '오늘 공부'}</span>
        <span class="tile-v sm">${korDur(((last.to ?? Date.now()) - last.from) / 60000)}</span>
        <span class="tile-s">${clk(last.from)}–${last.to ? clk(last.to) : '공부 중'}</span>`
        : `<span class="tile-l" style="margin-top:12px">오늘은 아직</span><span class="tile-v sm" style="color:var(--text-4)">–</span><span class="tile-s">${h(roomStatus)}</span>`}
      </button>
      <button type="button" class="tile" data-go="record" style="--m:var(--m-move)">
        <span class="ct"><h2>순위</h2>${goBtn}</span>
        <span class="tile-l">이번 주</span>
        <span class="tile-v">${stats.rank ? `${stats.rank}<span>위</span>` : '–'}</span>
        <span class="tile-s">${stats.rank ? `${stats.rank_total}명 중` : '이번 주 기록이 없어요'}</span>
      </button>
    </div>

    <section class="card">
      <div class="ct"><h2>추세</h2></div>
      <div class="trend-grid">${trend.map(([label, value, unit, color, icon]) => `<div class="tr" style="--m:${color}">
        <span class="tr-ico"><i class="ti ti-${icon}" aria-hidden="true"></i></span>
        <span><small>${label}</small><b>${value}<span>${unit}</span></b></span></div>`).join('')}</div>
    </section>

    <button type="button" class="pillbtn" data-go="record">기록 자세히 보기</button>

    ${notices.length ? `${sectionHead('공지', '모두 보기', 'open-notice')}
    <div class="card flush list">${notices.map((p, i) => `<button type="button" class="lrow" data-n="${i}">
      <span class="lrow-t"><b>${h(p.title)}</b><small>${p.pinned ? '고정 · ' : ''}${ago(p.created_at)}</small></span>${chev}</button>`).join('')}</div>` : ''}`;

  v.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => go(b.dataset.go));
  v.querySelector('#open-record').onclick = () => go('record');
  v.querySelector('#open-notice')?.addEventListener('click', () => go('notice'));
  v.querySelector('#banner-x')?.addEventListener('click', () => { try { localStorage.setItem(BANNER_KEY, '1'); } catch {} v.querySelector('#face-banner').remove(); });
  v.querySelectorAll('[data-n]').forEach((b) => b.onclick = () => postSheet(notices[Number(b.dataset.n)], { label: '공지' }));
  if (stats.open) {
    const loadedAt = Date.now();
    const time = v.querySelector('#home-time');
    timer = setInterval(() => {
      time.innerHTML = heroTime(stats.today_minutes + (Date.now() - loadedAt) / 60000);
    }, 15000);
  }
}

// 야자 밤 타임라인: 운영 시간(예: 18시–23시)을 가로로 펼치고, 공부한 구간을 채우고, 지금 위치를 표시한다
const toMin = (hhmm) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
function nightBar(s) {
  const start = toMin(s.open_time); const end = toMin(s.close_time); const dur = Math.max(60, end - start);
  const midnight = Date.parse(`${s.heatmap.at(-1).day}T00:00:00+09:00`);
  const pos = (ms) => Math.max(0, Math.min(100, ((ms - midnight) / 60000 - start) / dur * 100));
  const now = pos(Date.now());
  const ticks = []; for (let m = Math.ceil(start / 60) * 60; m <= end; m += 60) ticks.push(m);
  const x = (m) => (m - start) / dur * 100;
  return `<span class="night" aria-label="오늘 밤 공부한 시간대">
    <span class="night-track">${ticks.map((m) => `<i class="night-tick" style="left:${x(m)}%"></i>`).join('')}${s.today_sessions.map((e) => { const l = pos(e.check_in); const r = pos(e.check_out ?? Date.now()); return `<i class="night-seg" style="left:${l}%;width:${Math.max(0.8, r - l)}%"></i>`; }).join('')}${now > 0 && now < 100 ? `<i class="night-now" style="left:${now}%"></i>` : ''}</span>
    <span class="night-axis">${ticks.map((m) => `<em style="left:${x(m)}%">${Math.floor(m / 60)}시</em>`).join('')}</span>
  </span>`;
}

async function record() {
  const currentView = view();
  currentView.innerHTML = '<div class="view-state" role="status"><span class="spinner"></span><span class="sr-only">불러오는 중</span></div>';
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
    ${ptitle('기록')}

    ${sectionHead('오늘')}
    <section class="card record-today">
      <div class="rt-main">
        <div class="rt-n"><small>오늘 공부</small><b class="amount">${korDur(s.today_minutes)}</b><span class="sub">${goal > 0 ? `목표 ${korDur(goal)} · ${goalPercent}%` : `누적 ${korDur(s.total_minutes)}`}</span></div>
      </div>
      ${nightBar(s)}
      ${s.today_sessions.length ? `<ul class="record-sessions">${s.today_sessions.map((session) => `<li><span>${clk(session.check_in)}–${session.check_out ? clk(session.check_out) : '공부 중'}</span><b>${korDur(((session.check_out ?? Date.now()) - session.check_in) / 60000)}</b></li>`).join('')}</ul>` : ''}
    </section>

    <div class="sh"><h2>이번 주</h2><span class="sh-note">${s.streak.current}일 연속 출석</span></div>
    <section class="card">
      <p class="amount">${korDur(s.week_minutes)}</p>
      ${weekBars(s, todayKey)}
      <div class="facts"><div><span>최고 연속</span><b>${s.streak.best}일</b></div><div><span>하루 평균</span><b>${avg ? korDur(avg) : '–'}</b></div><div><span>누적 출석</span><b>${s.streak.total_days}일</b></div></div>
    </section>

    <div class="sh"><h2>이번 주 순위</h2><span class="sh-note">${s.rank ? `${s.rank}위 / ${s.rank_total}명` : ''}</span></div>
    <section class="card flush" id="rank">
      <div class="rk">${s.top.map((t, i) => `<div class="${t.me ? 'me' : ''}"><em>${i + 1}</em><span class="nm">${h(t.name)}${t.me ? '<span class="tag blue">나</span>' : ''}</span><b>${korDur(t.minutes)}</b></div>`).join('')}
        ${s.rank > 5 ? `<div class="me gap"><em>${s.rank}</em><span class="nm">${h(me.name)}<span class="tag blue">나</span></span><b>${korDur(s.week_minutes)}</b></div>` : ''}</div>
    </section>
    <p class="page-note">다른 학생 이름은 가운데 글자를 가려서 보여줘요.</p>

    <div class="sh"><h2>최근 4개월</h2><span class="sh-note">${attendedDays}일 출석</span></div>
    <section class="card">
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
    ${ptitle('좌석', '<button class="gbtn-round" id="refresh" type="button" aria-label="좌석 새로고침"><i class="ti ti-refresh" aria-hidden="true"></i></button>')}
    <section class="room-plan" aria-labelledby="room-availability">
      <div class="room-availability">
        <h2 id="room-availability">빈 자율석</h2><strong id="free-count" aria-live="polite">—</strong>
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
  dragToDismiss(dialog, () => dialog.close());
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
    ${posts.length ? `<p class="board-summary" role="status">${head}</p>
    <div class="card flush list">${posts.map((p, i) => `<button type="button" class="lrow" data-p="${i}">
      <span class="lrow-t"><b>${h(p.title)}</b><small class="prev">${h(p.body)}</small><small>${p.category ? `${h(p.category)} · ` : ''}${ago(p.created_at)}</small></span>
      <span class="lrow-r">${tagOf(p)}${chev}</span></button>`).join('')}</div>`
      : `<section class="card"><div class="empty"><i class="ti ti-${EMPTY[0]}"></i><b>${EMPTY[1]}</b><span>${EMPTY[2]}</span></div></section>`}
    `);
  const v = view();
  v.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { if (boardKind === b.dataset.k) return; boardKind = b.dataset.k; v.querySelector('.seg').style.setProperty('--i', Object.keys(BOARDS).indexOf(boardKind)); v.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('on', x === b)); board().catch((err) => { if (tab === 'board') toast(err.message, 'error'); }); });
  v.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => {
    const p = posts[Number(b.dataset.p)];
    postSheet(p, { label: BOARDS[kind], deletable: mine && p.status === 'open', onDelete: async () => { await api.del(`/api/posts/${p.id}`); toast('삭제했어요'); board(); } });
  });
  v.querySelector('#write')?.addEventListener('click', write);
}

function write() {
  const lost = boardKind === 'lost_report';
  const cats = lost ? ['전자기기', '필기구', '의류', '지갑·카드', '기타'] : ['시설', '소음', '좌석', '운영', '기타'];
  modal(`<form class="sheetf" novalidate>
    <div class="sheet-nav"><button type="button" class="x" data-close aria-label="취소"><i class="ti ti-x" aria-hidden="true"></i></button><h2>${lost ? '분실 신고' : '문의 남기기'}</h2><button type="submit" class="done" id="send">보내기</button></div>
    <div class="fld"><span>분류</span><div class="chips" role="radiogroup" aria-label="분류">${cats.map((c, i) => `<label><input type="radio" name="cat" value="${c}" ${i === 0 ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></div>
    <label class="fld"><span>${lost ? '잃어버린 물건' : '제목'}</span><input class="input" name="title" maxlength="100" placeholder="${lost ? '예: 검정 무선 이어폰' : '예: 3열 에어컨이 너무 세요'}" autocomplete="off"><span class="fld-foot"><em class="err" id="e1"></em></span></label>
    <label class="fld"><span>${lost ? '언제·어디서·특징' : '내용'}</span><textarea class="input" name="body" rows="5" maxlength="1000" placeholder="${lost ? '예: 11월 16일 저녁, B23 자리 근처, 케이스에 스티커' : '선생님만 볼 수 있어요'}"></textarea><span class="fld-foot"><em class="err" id="e2"></em><em class="cnt" id="cnt">0 / 1000</em></span></label>
    </form>`, {
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
  const pinned = posts.filter((p) => p.pinned); const rest = posts.filter((p) => !p.pinned);
  const group = (title, list, base) => list.length ? `<div class="sh"><h2>${title}</h2></div>
    <div class="card flush list">${list.map((p, i) => `<button type="button" class="lrow" data-n="${base + i}">
      <span class="lrow-t"><b>${h(p.title)}</b><small>${fmtDate(p.created_at)} · ${ago(p.created_at)}</small></span>${p.pinned ? '<span class="tag blue">고정</span>' : ''}${chev}</button>`).join('')}</div>` : '';
  const all = [...pinned, ...rest];
  paint(`
    ${ptitle('공지')}
    ${group('고정 공지', pinned, 0)}
    ${group('지난 공지', rest, pinned.length)}
    ${posts.length ? '' : '<section class="card"><div class="empty"><i class="ti ti-speakerphone"></i><b>아직 공지가 없어요</b><span>선생님이 공지를 올리면 여기에서 볼 수 있어요.</span></div></section>'}`);
  view().querySelectorAll('[data-n]').forEach((b) => b.onclick = () => postSheet(all[Number(b.dataset.n)], { label: '공지' }));
}

boot();
