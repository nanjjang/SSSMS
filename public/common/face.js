// Face AI module — Human.js (BlazeFace + FaceMesh/Iris + FaceRes + Anti-Spoof + Liveness)
// Implements multi-layer Presentation Attack Detection (PAD):
//  1) passive: anti-spoof CNN (`real`) + liveness CNN (`live`) averaged over frames
//  2) active: randomized challenge–response (blink / head turn / mouth open)
//  3) continuity: same identity at start & end of the challenge, single face only
const HUMAN_VER = '3.3.6';
const CDN = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VER}`;

let humanPromise = null;
export function loadHuman() {
  humanPromise ||= (async () => {
    const mod = await import(`${CDN}/dist/human.esm.js`);
    const Human = mod.Human || mod.default;
    const human = new Human({
      modelBasePath: `${CDN}/models/`,
      backend: 'webgl',
      debug: false,
      cacheSensitivity: 0, // always run full inference: liveness must not be served from cache
      filter: { enabled: true, equalization: false, flip: false },
      face: {
        enabled: true,
        detector: { rotation: true, maxDetected: 3, minConfidence: 0.5, return: false },
        mesh: { enabled: true },
        iris: { enabled: true },
        attention: { enabled: false },
        description: { enabled: true },   // FaceRes embedding + age/gender
        emotion: { enabled: false },
        antispoof: { enabled: true },     // printed photo / screen replay texture detector
        liveness: { enabled: true },      // real person probability
      },
      body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, segmentation: { enabled: false },
      gesture: { enabled: true },
    });
    await human.load();
    await human.warmup();
    return human;
  })();
  return humanPromise;
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저는 카메라를 지원하지 않습니다 (HTTPS 또는 localhost 필요)');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  return () => stream.getTracks().forEach((t) => t.stop());
}

export const CHALLENGES = {
  blink: { text: '눈을 천천히 깜빡여주세요', icon: '' },
  turn: { text: '고개를 왼쪽·오른쪽으로 천천히 돌려주세요', icon: '' },
  mouth: { text: '입을 크게 벌려주세요', icon: '' },
};
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

function analyze(res, video) {
  const faces = res.face || [];
  const f = faces[0];
  const gestures = (res.gesture || []).filter((g) => g.face === 0).map((g) => g.gesture);
  if (!f) return { faces: 0 };
  const [bx, by, bw, bh] = f.box;
  const W = video.videoWidth || 1, H = video.videoHeight || 1;
  const cx = (bx + bw / 2) / W, cy = (by + bh / 2) / H;
  const yaw = f.rotation?.angle?.yaw ?? 0;
  const mouth = Math.max(0, ...gestures.map((g) => /mouth (\d+)% open/.exec(g)?.[1] ?? 0).map(Number));
  return {
    faces: faces.length, f,
    size: bw / W, centered: Math.abs(cx - 0.5) < 0.18 && Math.abs(cy - 0.5) < 0.2,
    yaw, blink: gestures.some((g) => g.startsWith('blink')), mouth,
    real: f.real ?? 0, live: f.live ?? 0, emb: f.embedding,
    quality: f.faceScore ?? f.score ?? 0,
  };
}

function avgEmb(list) {
  const n = list[0].length; const out = new Array(n).fill(0);
  for (const e of list) for (let i = 0; i < n; i++) out[i] += e[i];
  return out.map((x) => x / list.length);
}

/**
 * Full liveness + identification capture.
 * onState({phase, text, progress, step, steps, a}) is called each frame for UI.
 * Resolves { embedding, pad } or throws Error(message).
 */
export async function verifyLive(human, video, { onState, signal, steps = 2, timeoutMs = 14000 } = {}) {
  const plan = shuffle(Object.keys(CHALLENGES)).slice(0, steps);
  const t0 = performance.now();
  let phase = 'align'; let alignSince = 0; let stepIdx = 0;
  let realSum = 0, liveSum = 0, n = 0;
  const frontal = []; let firstEmb = null;
  let turn = { neg: false, pos: false }; let blinkOpen = false; let blinkCount = 0;

  while (true) {
    if (signal?.aborted) throw new Error('취소됨');
    if (performance.now() - t0 > timeoutMs) throw new Error('시간이 초과되었습니다. 다시 시도해주세요.');
    const res = await human.detect(video);
    const a = analyze(res, video);
    if (a.faces > 1) { onState?.({ phase, text: '한 명씩 인식해주세요', a, warn: true }); await frame(); continue; }
    if (!a.faces) { alignSince = 0; onState?.({ phase, text: '얼굴을 화면 중앙에 맞춰주세요', a }); await frame(); continue; }

    // passive PAD accumulates every frame
    realSum += a.real; liveSum += a.live; n++;
    if (Math.abs(a.yaw) < 0.2 && a.quality > 0.6 && a.emb?.length) { frontal.push(Array.from(a.emb)); firstEmb ||= Array.from(a.emb); }

    if (phase === 'align') {
      const ok = a.centered && a.size > 0.22 && Math.abs(a.yaw) < 0.25;
      const msg = a.size <= 0.22 ? '조금 더 가까이 와주세요' : !a.centered ? '얼굴을 가운데로 맞춰주세요' : '정면을 바라봐주세요';
      if (!ok) { alignSince = 0; onState?.({ phase, text: msg, a }); await frame(); continue; }
      alignSince ||= performance.now();
      const p = Math.min(1, (performance.now() - alignSince) / 600);
      onState?.({ phase, text: '좋아요, 잠시만 유지하세요', progress: p, a });
      if (p >= 1) { phase = 'challenge'; }
      await frame(); continue;
    }

    if (phase === 'challenge') {
      const c = plan[stepIdx];
      let done = false;
      if (c === 'blink') { if (!a.blink) blinkOpen = true; else if (blinkOpen) { blinkCount++; blinkOpen = false; } done = blinkCount >= 1; }
      if (c === 'turn') { if (a.yaw < -0.3) turn.neg = true; if (a.yaw > 0.3) turn.pos = true; done = turn.neg && turn.pos; }
      if (c === 'mouth') done = a.mouth >= 30;
      onState?.({ phase, text: CHALLENGES[c].text, icon: CHALLENGES[c].icon, step: stepIdx + 1, steps: plan.length, challenge: c, turn, a });
      if (done) { stepIdx++; if (stepIdx >= plan.length) phase = 'final'; else await sleep(250); }
      await frame(); continue;
    }

    if (phase === 'final') {
      onState?.({ phase, text: '정면을 바라봐주세요', a });
      if (Math.abs(a.yaw) > 0.2 || !a.emb?.length) { await frame(); continue; }
      const lastEmb = Array.from(a.emb);
      const real = realSum / n, live = liveSum / n;
      const continuity = firstEmb ? human.match.similarity(firstEmb, lastEmb) : 0;
      const recent = frontal.slice(-8);
      return { embedding: avgEmb(recent.length ? recent : [lastEmb]), pad: { real, live, continuity, challenge_passed: true, challenges: plan, frames: n } };
    }
  }
}

/** Enrollment: capture N good frontal samples, each must pass passive PAD. */
export async function captureSamples(human, video, { count = 5, onState, signal, minReal = 0.5, minLive = 0.5 } = {}) {
  const out = []; let last = 0;
  const t0 = performance.now();
  while (out.length < count) {
    if (signal?.aborted) throw new Error('취소됨');
    if (performance.now() - t0 > 30000) throw new Error('시간 초과');
    const a = analyze(await human.detect(video), video);
    let text = '';
    if (a.faces !== 1) text = a.faces ? '한 명만 화면에 있어야 합니다' : '얼굴을 화면에 맞춰주세요';
    else if (a.size < 0.2) text = '조금 더 가까이';
    else if (Math.abs(a.yaw) > 0.25) text = '정면을 봐주세요';
    else if (a.real < minReal || a.live < minLive) text = '실제 얼굴로 인식되지 않습니다 (사진/화면 불가)';
    else if (performance.now() - last > 350 && a.emb?.length) { out.push(Array.from(a.emb)); last = performance.now(); text = '촬영 중…'; }
    onState?.({ text, progress: out.length / count, a });
    await frame();
  }
  return out;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Draws the oval guide + mesh dots on an overlay canvas */
export function drawOverlay(canvas, video, a, color) {
  const W = canvas.width = video.videoWidth || 640, H = canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,20,.45)'; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.ellipse(W / 2, H / 2, H * 0.3, H * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.lineWidth = 6; ctx.strokeStyle = color || 'rgba(255,255,255,.8)';
  ctx.beginPath(); ctx.ellipse(W / 2, H / 2, H * 0.3, H * 0.4, 0, 0, Math.PI * 2); ctx.stroke();
  if (a?.f?.mesh?.length) {
    ctx.fillStyle = 'rgba(124,134,255,.7)';
    for (let i = 0; i < a.f.mesh.length; i += 6) { const [x, y] = a.f.mesh[i]; ctx.fillRect(x - 1.5, y - 1.5, 3, 3); }
  }
}
