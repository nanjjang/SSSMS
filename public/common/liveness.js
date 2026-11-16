// 살아 있는 사람 판별 (다중 신호 PAD)
//  1) 눈 깜빡임  : MediaPipe FaceMesh 눈 6점의 EAR(eye aspect ratio)이 개인 기준치보다 크게 떨어졌다가 회복 → 깜빡임
//  2) 비강체 움직임: 프레임 간 468점 변화 중 '평면 아핀 변환(이동·회전·확대·기울기)으로 설명되지 않는 부분'의 크기.
//                  손에 든 사진·화면은 평면이라 아핀으로 거의 다 설명되고(잔차≈0), 실제 얼굴은 표정·눈꺼풀·3D 시차 때문에 잔차가 생긴다.
//  3) 질감       : 자체 학습 LiveNet(화면 모아레·인쇄 망점) + Human.js antispoof 점수의 이동 평균
// 세 신호를 모두 만족해야 live 로 판정한다.

// 눈 6점: [바깥 끝, 위1, 위2, 안쪽 끝, 아래2, 아래1]
const EYE_A = [33, 160, 158, 133, 153, 144];
const EYE_B = [362, 385, 387, 263, 373, 380];
// 비강체 분석에 쓸 점: 눈·눈썹·입·코·턱 등 전 영역 (468점 중 일부만 써도 충분)
const NR_IDX = Array.from({ length: 117 }, (_, i) => i * 4);

const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
function ear(m, idx) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => m[i]);
  return (d(p2, p6) + d(p3, p5)) / (2 * d(p1, p4) + 1e-6);
}

/** 최소제곱 2D 아핀 변환으로 src→dst 를 맞춘 뒤 남는 잔차(RMS) */
function affineResidual(src, dst) {
  // 정규방정식 (A^T A) x = A^T b, A=[x y 1]
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, n = src.length;
  let bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    bx[0] += x * u; bx[1] += y * u; bx[2] += u;
    by[0] += x * v; by[1] += y * v; by[2] += v;
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const solve = (b) => { // 3x3 크래머
    const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const D = det(M) || 1e-9;
    return [0, 1, 2].map((c) => det(M.map((r, i) => r.map((v, j) => (j === c ? b[i] : v)))) / D);
  };
  const ax = solve(bx), ay = solve(by);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    const pu = ax[0] * x + ax[1] * y + ax[2], pv = ay[0] * x + ay[1] * y + ay[2];
    s += (pu - u) ** 2 + (pv - v) ** 2;
  }
  return Math.sqrt(s / n);
}

export const LIVENESS_DEFAULTS = {
  blinkDrop: 0.78,     // EAR 이 기준치의 78% 아래로 떨어지면 '감음' (웹캠 랜드마크는 완전히 닫히지 않는 경우가 많음)
  blinkMaxMs: 700,     // 감았다 뜨는 데 걸린 시간이 이보다 짧아야 깜빡임 (오래 감고 있기 X)
  blinkWindowMs: 8000, // 최근 이 시간 안에 깜빡임이 있어야 함
  motionMin: 0.006,    // 비강체 잔차(눈 사이 거리로 정규화) 기준
  textureMin: 0.5,     // 질감 점수(0~1) 기준
  lagMs: 200,          // 비강체 비교 프레임 간격
  textureSource: null, // 'own' | 'human' | null(둘 중 낮은 쪽)
};

export class LivenessTracker {
  constructor(opts = {}) { this.o = { ...LIVENESS_DEFAULTS, ...opts }; this.reset(); }

  reset() {
    this.earBase = null; this.closedAt = 0; this.blinks = []; this.hist = []; this.motion = []; this.tex = []; this.earSeries = [];
  }

  /**
   * @param mesh  468x[x,y,(z)] 랜드마크 (영상 좌표)
   * @param scores { own: 자체 LiveNet 0~1, human: Human.js antispoof 0~1 }
   * @param t     ms (performance.now)
   */
  update(mesh, scores = {}, t = performance.now()) {
    const o = this.o;
    // ---- 1) 깜빡임 ----
    const e = (ear(mesh, EYE_A) + ear(mesh, EYE_B)) / 2;
    if (this.earBase == null) this.earBase = e;
    // 기준치: 눈 뜬 상태(감음 아닐 때)만 천천히 따라감
    const closed = e < this.earBase * o.blinkDrop;
    if (!closed) this.earBase = this.earBase * 0.95 + e * 0.05;
    if (closed && !this.closedAt) this.closedAt = t;
    if (!closed && this.closedAt) { if (t - this.closedAt <= o.blinkMaxMs) this.blinks.push(t); this.closedAt = 0; }
    // 보조 검출기: Human.js 홍채 모델의 blink 제스처 (EAR이 놓친 짧은 깜빡임 보완). 직전 깜빡임과 0.4초 이상 떨어져야 새 깜빡임
    if (scores.gestureBlink && !(this.blinks.length && t - this.blinks.at(-1) < 400)) this.blinks.push(t);
    this.blinks = this.blinks.filter((b) => t - b < o.blinkWindowMs);
    this.earSeries.push({ t, e, base: this.earBase }); this.earSeries = this.earSeries.filter((s) => t - s.t < 6000);

    // ---- 2) 비강체 움직임 ----
    const iod = Math.hypot(mesh[33][0] - mesh[263][0], mesh[33][1] - mesh[263][1]) || 1;
    const pts = NR_IDX.map((i) => [mesh[i][0] / iod, mesh[i][1] / iod]);
    this.hist.push({ t, pts }); this.hist = this.hist.filter((h) => t - h.t < 1500);
    const ref = this.hist.find((h) => t - h.t >= o.lagMs);
    if (ref) { this.motion.push({ t, r: affineResidual(ref.pts, pts) }); }
    this.motion = this.motion.filter((m) => t - m.t < 3000);

    // ---- 3) 질감 ----
    // 질감: 보정에서 고른 모델(textureSource)이 있으면 그 점수, 없으면 두 모델 중 낮은 쪽(보수적)
    const src = o.textureSource && scores[o.textureSource] != null ? [scores[o.textureSource]] : [scores.own, scores.human].filter((v) => v != null);
    if (src.length) this.tex.push({ t, v: Math.min(...src) });
    this.tex = this.tex.filter((x) => t - x.t < 2000);
    return this.state(t);
  }

  state(t = performance.now()) {
    const o = this.o;
    const rs = this.motion.map((m) => m.r).sort((a, b) => a - b);
    const motion = rs.length ? rs[Math.floor(rs.length * 0.8)] : 0;          // 상위 20% 수준(가끔 생기는 미세 움직임)
    const texture = this.tex.length ? this.tex.reduce((s, x) => s + x.v, 0) / this.tex.length : null;
    const blink = this.blinks.length > 0;
    const ready = this.motion.length > 8 && this.tex.length > 3;
    const checks = {
      blink: { ok: blink, value: this.blinks.length, label: '눈 깜빡임' },
      motion: { ok: motion >= o.motionMin, value: motion, label: '미세한 움직임' },
      texture: { ok: texture != null && texture >= o.textureMin, value: texture, label: '화면·사진 질감 아님' },
    };
    const live = ready && checks.blink.ok && checks.motion.ok && checks.texture.ok;
    const spoofLikely = ready && (!checks.texture.ok || (!checks.motion.ok && this.motion.length > 30));
    return { live, ready, spoofLikely, checks, ear: this.earSeries.at(-1)?.e ?? null, earBase: this.earBase, earSeries: this.earSeries };
  }
}
