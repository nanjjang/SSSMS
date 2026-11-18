import { createApi, LOGO, h, fmtMin, fmtTime, toast, renderSeatMap } from '/common/api.js';
import { loadHuman, startCamera, verifyLive } from '/common/face.js';
import { keepScreenOn } from '/common/native.js';

keepScreenOn(); // 앱: 화면 꺼짐 방지

const api = createApi('kiosk');
const app = document.getElementById('app');
let human = null; let cfg = null; let busy = false; let seatData = null; let fails = 0;
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RING = 2 * Math.PI * 48; // r=48 in a 100x100 viewBox

api.onUnauthorized = () => location.reload();

async function boot() {
  if (!api.token.get()) return renderLogin();
  try { const me = (await api.get('/api/me')).user; if (me.role !== 'kiosk') throw 0; }
  catch { api.token.set(null); return renderLogin(); }
  cfg = await api.get('/api/kiosk/config');
  renderMain();
}

function renderLogin() {
  app.innerHTML = `<div class="page center"><img class="lg-logo" src="${LOGO}" alt="">
    <h1 class="t1">키오스크 시작하기</h1><p class="sub">기기 계정으로 한 번만 로그인하면 돼요</p>
    <form class="login-f"><input class="kin" name="id" value="kiosk" aria-label="아이디"><input class="kin" type="password" name="pw" placeholder="비밀번호" aria-label="비밀번호">
    <button class="kbtn primary">시작하기</button></form></div>`;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try { const u = await api.login(e.target.id.value, e.target.pw.value); if (u.role !== 'kiosk') { await api.logout(); throw new Error('키오스크 계정이 아니에요'); } boot(); }
    catch (err) { toast(err.message, 'error'); }
  };
}

// ---------- 메인(대기 · 인식) ----------
function renderMain() {
  app.innerHTML = `
    <header class="top"><div class="who"><img src="${LOGO}" alt=""><span>${h(cfg.room_name)}</span></div><span class="clock" id="clock"></span></header>
    <main class="stage" id="stage">
      <div class="stage-copy" aria-live="polite" aria-atomic="true">
        <h1 class="t1" id="title">카메라 준비 중</h1>
        <p class="sub" id="sub"></p>
      </div>
      <div class="cam" id="cam"><i class="ti ti-user cam-ph def" aria-hidden="true"></i><i class="ti ti-camera-off cam-ph err" aria-hidden="true"></i>
        <video id="v" autoplay muted playsinline></video>
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="bg" cx="50" cy="50" r="48"/><circle class="fg" id="ring" cx="50" cy="50" r="48" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>
      </div>
      <div class="dots" id="dots" aria-hidden="true"></div>
    </main>
    <footer class="kbnr"><span>빈 자율석 <b id="cf">—</b></span><span>이용 중 <b id="co">—</b></span></footer>
`;
  const tick = () => { const c = $('clock'); if (c) c.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }); };
  tick(); setInterval(tick, 10000);
  refreshSeats(); setInterval(refreshSeats, 10000);
  initCamera();
}

async function refreshSeats() {
  try {
    seatData = await api.get('/api/seats');
    if ($('cf')) $('cf').textContent = `${seatData.seats.filter((s) => s.type === 'free' && !s.occupied).length}석`;
    if ($('co')) $('co').textContent = `${seatData.seats.filter((s) => s.occupied).length}명`;
  } catch {}
}

// 상태 표시: 문구 + 링 진행률 + 단계 점
function state({ title, sub = '', progress = 0, mode = 'idle', step, steps }) {
  if ($('title').textContent !== title) $('title').textContent = title;
  if ($('sub').textContent !== sub) $('sub').textContent = sub;
  $('cam').dataset.mode = mode;
  $('ring').style.strokeDashoffset = RING * (1 - Math.max(0, Math.min(1, progress)));
  $('dots').innerHTML = steps ? Array.from({ length: steps }, (_, i) => `<i class="${i < step - 1 ? 'done' : i === step - 1 ? 'now' : ''}"></i>`).join('') : '';
}

async function initCamera() {
  try { await startCamera($('v')); }
  catch (e) { state({ title: '카메라를 켤 수 없어요', sub: '카메라 연결과 권한을 확인해 주세요. 계속되면 감독 선생님께 알려주세요.', mode: 'error' }); return; }
  try { human = await loadHuman(); }
  catch (e) { state({ title: '얼굴 인식을 시작할 수 없어요', sub: '인터넷 연결을 확인하고 감독 선생님께 알려주세요.', mode: 'error' }); return; }
  loop();
}

async function loop() {
  const video = $('v');
  while (true) {
    if (busy) { await wait(300); continue; }
    state({ title: '원 안에 얼굴을 맞춰 주세요', sub: '입실·퇴실은 얼굴 인식으로 진행됩니다.' });
    const res = await human.detect(video);
    if (!res.face?.length) { await wait(200); continue; }
    busy = true;
    try {
      const ch = await api.post('/api/kiosk/challenge'); // 서버가 정한 1회용 동작 챌린지
      const out = await verifyLive(human, video, {
        plan: ch.plan,
        onState: (st) => {
          if (st.phase === 'align') state({ title: st.text, sub: '원 안에 얼굴이 꽉 차게 해주세요', progress: (st.progress || 0) * 0.25, mode: st.warn ? 'warn' : 'scan' });
          else if (st.phase === 'challenge') state({ title: st.text, sub: `${st.step}/${st.steps} 단계 · 실제 얼굴인지 확인하고 있어요`, progress: 0.25 + ((st.step - 1) / st.steps) * 0.6, mode: 'scan', step: st.step, steps: st.steps });
          else state({ title: '정면을 봐주세요', sub: '거의 다 됐어요', progress: 0.9, mode: 'scan' });
        },
      });
      state({ title: '확인하고 있어요', sub: '', progress: 1, mode: 'verify' });
      if (out.pad.real < cfg.antispoof_threshold || out.pad.live < cfg.liveness_threshold) throw new Error('사진이나 화면이 아닌 실제 얼굴로 다시 해주세요');
      const r = await api.post('/api/kiosk/identify', { ...out, nonce: ch.nonce });
      fails = 0;
      await handleIdentified(r);
    } catch (e) {
      fails++;
      const m = String(e.message || '');
      const tip = /시간이 초과/.test(m) ? '화면 안내에 맞춰 천천히 따라 해주세요'
        : /실제 얼굴|라이브니스|사진/.test(m) ? '모자·마스크를 벗고 밝은 곳에서 정면을 봐주세요'
        : /등록된 얼굴/.test(m) ? '얼굴이 아직 등록되지 않았을 수 있어요'
        : /입실 시간/.test(m) ? '운영 시간에 다시 와주세요. 급한 경우 감독 선생님께 말씀해주세요'
        : /제한/.test(m) ? '담당 선생님께 문의해주세요' : '잠시 후 다시 시도해주세요';
      await result({ ok: false, title: '인식 실패', sub: `${m}`, rows: [['이렇게 해보세요', tip], ...(fails >= 2 ? [['계속 안 되나요?', '감독 선생님께 말씀해주세요']] : [])], ms: fails >= 2 ? 6000 : 4000 });
    } finally { busy = false; await wait(500); }
  }
}

// ---------- 전체 화면 페이지 (결과 · 좌석 선택 · 퇴실 확인) ----------
function page(html) {
  const el = document.createElement('div'); el.className = 'page over'; el.innerHTML = html;
  document.body.append(el); return el;
}
const closePage = (el) => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
function countdown(el, sec, onEnd) {
  let left = sec; const c = el.querySelector('.cd');
  const t = setInterval(() => { left--; if (c) c.textContent = `${left}초 뒤 처음 화면으로 돌아가요`; if (left <= 0) { clearInterval(t); onEnd(); } }, 1000);
  return () => clearInterval(t);
}

function result({ ok, title, sub, rows = [], ms = 3500 }) {
  return new Promise((res) => {
    const el = page(`<div class="center grow">
      <div class="badge-ic ${ok ? 'ok' : 'bad'}">${ok ? '<svg viewBox="0 0 52 52"><path d="M15 27l8 8 15-17"/></svg>' : '<svg viewBox="0 0 52 52"><path d="M26 15v14M26 36v1"/></svg>'}</div>
      <h1 class="t1">${title}</h1>${sub ? `<p class="sub">${h(sub)}</p>` : ''}
      ${rows.length ? `<div class="list">${rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>` : ''}
    </div><p class="cd">${Math.round(ms / 1000)}초 뒤 처음 화면으로 돌아가요</p>`);
    const stop = countdown(el, Math.round(ms / 1000), () => { closePage(el); res(); });
    el.onclick = () => { stop(); closePage(el); res(); };
  });
}

async function handleIdentified(r) {
  if (r.action === 'checkout') return checkoutFlow(r);
  if (r.fixed_seat) {
    const out = await api.post('/api/kiosk/checkin', { ticket: r.ticket });
    refreshSeats();
    return result({ ok: true, title: '입실 완료', sub: `${r.user.name}님, 자리에 앉아 주세요`, rows: [['자리', `지정석 ${h(out.seat)}`], ['입실 시간', fmtTime(Date.now())]] });
  }
  return seatPickFlow(r);
}

function seatPickFlow(r) {
  return new Promise(async (resolve) => {
    await refreshSeats();
    const free = seatData.seats.filter((s) => s.type === 'free' && !s.occupied).sort((a, b) => a.y - b.y || a.x - b.x);
    let pick = free[0] || null;
    const el = page(`<div class="phead"><h1 class="t1">자리 선택</h1></div><div class="kbnr in"><i class="ti ti-user"></i><span><b>${h(r.user.name)}</b>님 · 빈 자리 ${free.length}석 · 파란 자리를 눌러 고르세요</span></div>
      <div class="front">교실 앞</div><div class="pmap" id="pick"></div>
      <div class="legend k"><span><i class="sw free"></i>빈 자리</span><span><i class="sw occ"></i>사용 중</span><span><i class="sw fixed"></i>지정석</span><span><i class="sw sel"></i>선택</span></div>
      <div class="bar2"><button class="kbtn" id="cancel">취소</button><button class="kbtn primary" id="ok"></button></div><p class="cd">30초 뒤 처음 화면으로 돌아가요</p>`);
    const stop = countdown(el, 30, () => { closePage(el); resolve(); });
    const draw = () => {
      renderSeatMap(el.querySelector('#pick'), seatData, { pickable: (s, st) => st === 'free', onPick: (s) => { pick = s; draw(); }, highlightId: pick?.id });
      el.querySelector('#ok').textContent = pick ? `${pick.label} 자리에 앉기` : '빈 자리가 없어요';
      el.querySelector('#ok').disabled = !pick;
    };
    draw();
    el.querySelector('#cancel').onclick = () => { stop(); closePage(el); resolve(); };
    el.querySelector('#ok').onclick = async () => {
      stop(); closePage(el);
      try {
        const out = await api.post('/api/kiosk/checkin', { ticket: r.ticket, seat_id: pick.id });
        refreshSeats();
        await result({ ok: true, title: '입실 완료', sub: `${r.user.name}님, 자리에 앉아 주세요`, rows: [['자리', h(out.seat)], ['입실 시간', fmtTime(Date.now())]] });
      } catch (e) { await result({ ok: false, title: '입실 실패', sub: e.message }); }
      resolve();
    };
  });
}

function checkoutFlow(r) {
  return new Promise((resolve) => {
    const mins = Math.round((Date.now() - r.session.check_in) / 60000);
    const el = page(`<div class="phead"><h1 class="t1">퇴실</h1></div><div class="kbnr in"><i class="ti ti-door-exit"></i><span><b>${h(r.user.name)}</b>님, 퇴실할까요?</span></div>
      <div class="list big"><div><span>입실 시간</span><b>${fmtTime(r.session.check_in)}</b></div><div><span>이번에 공부한 시간</span><b>${fmtMin(mins)}</b></div></div>
      <div class="grow"></div>
      <div class="bar2"><button class="kbtn" id="no">아니요</button><button class="kbtn primary" id="yes">퇴실하기</button></div><p class="cd">15초 뒤 처음 화면으로 돌아가요</p>`);
    const stop = countdown(el, 15, () => { closePage(el); resolve(); });
    el.querySelector('#no').onclick = () => { stop(); closePage(el); resolve(); };
    el.querySelector('#yes').onclick = async () => {
      stop(); closePage(el);
      try {
        const out = await api.post('/api/kiosk/checkout', { ticket: r.ticket });
        refreshSeats();
        await result({ ok: true, title: '퇴실 완료', sub: `${r.user.name}님, 오늘도 수고했어요`, rows: [['이번 공부', fmtMin(out.minutes)], ['오늘 총', fmtMin(out.today_minutes)]] });
      } catch (e) { await result({ ok: false, title: '퇴실 실패', sub: e.message }); }
      resolve();
    };
  });
}

boot();
