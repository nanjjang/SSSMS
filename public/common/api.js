export function createApi(app) {
  const KEY = `sssms_token_${app}`;
  const store = {
    get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
    set: (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} },
  };
  async function call(method, path, data) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(store.get() ? { authorization: `Bearer ${store.get()}` } : {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { store.set(null); api.onUnauthorized?.(); }
    if (!res.ok) { const e = new Error(json.error || `오류 (${res.status})`); e.status = res.status; throw e; }
    return json;
  }
  const api = {
    token: store,
    get: (p) => call('GET', p), post: (p, d) => call('POST', p, d || {}), put: (p, d) => call('PUT', p, d), del: (p) => call('DELETE', p),
    async login(login_id, password) { const r = await call('POST', '/api/login', { login_id, password }); store.set(r.token); return r.user; },
    async logout() { try { await call('POST', '/api/logout'); } catch {} store.set(null); },
    onUnauthorized: null,
  };
  return api;
}

export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtMin = (m) => { m = Math.round(m || 0); const hh = Math.floor(m / 60); return hh ? `${hh}시간 ${m % 60}분` : `${m}분`; };
export const fmtHM = (m) => { m = Math.round(m || 0); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
export const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '-';
export const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short' }) : '-';
export const fmtDT = (ms) => ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '-';

export function toast(msg, kind = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg; box.append(t);
  setTimeout(() => t.classList.add('out'), 2600); setTimeout(() => t.remove(), 2900);
}

export function modal(html, { onMount } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
    let closed = false;
    const close = (v) => {
      if (closed) return; closed = true;
      bg.classList.add('closing'); document.removeEventListener('keydown', esc);
      setTimeout(() => bg.remove(), reduced() ? 0 : 220); resolve(v);
    };
    const esc = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', esc);
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(null); });
    document.body.append(bg);
    onMount?.(bg.querySelector('.modal'), close);
  });
}

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 화면 전환: View Transitions API(지원 시) + 내용 페이드/슬라이드 */
export function transition(update) {
  if (!document.startViewTransition || reduced()) { update(); return Promise.resolve(); }
  return document.startViewTransition(update).finished.catch(() => {});
}

/** Seat map renderer shared by student / kiosk / admin views */
export function renderSeatMap(el, { seats, cols, rows }, { onPick, pickable, highlightId } = {}) {
  const maxX = Math.max(cols, ...seats.map((s) => s.x + 1));
  const maxY = Math.max(rows, ...seats.map((s) => s.y + 1));
  el.classList.add('seatmap');
  el.style.setProperty('--cols', maxX);
  el.innerHTML = '';
  const grid = Array.from({ length: maxY }, () => Array(maxX).fill(null));
  for (const s of seats) grid[s.y][s.x] = s;
  for (let y = 0; y < maxY; y++) for (let x = 0; x < maxX; x++) {
    const s = grid[y][x];
    const c = document.createElement(s ? 'button' : 'div');
    if (!s) { c.className = 'cell empty'; el.append(c); continue; }
    const state = s.mine ? 'mine' : s.type === 'disabled' ? 'disabled' : s.occupied ? 'occupied' : s.type === 'fixed' ? 'fixed' : 'free';
    c.className = `cell seat ${state}${highlightId === s.id ? ' hl' : ''}`;
    c.innerHTML = `<span class="lb">${h(s.label)}</span>`;
    c.title = `${s.label} · ${({ mine: '내 자리', disabled: '사용 불가', occupied: '사용 중', fixed: '지정석', free: '공석' })[state]}`;
    const can = pickable ? pickable(s, state) : false;
    c.disabled = !can;
    if (can) c.addEventListener('click', () => onPick?.(s));
    el.append(c);
  }
}

export const LOGO = '/assets/logo.svg';
export const brand = (sub) => `<div class="brand"><img src="${LOGO}" alt="선린인터넷고등학교" onerror="this.style.display='none'"><span><b>선린인터넷고 야간자율학습</b><small>${h(sub)}</small></span></div>`;
