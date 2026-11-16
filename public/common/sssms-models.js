// SSSMS 자체 학습 모델 (ml/ 폴더에서 학습 → public/models/*.onnx 로 내보냄)
//  - facenet.onnx : 112x112 정렬 얼굴 → 128차원 임베딩 (MobileFaceNet + ArcFace)
//  - livenet.onnx : 80x80 얼굴 → [spoof, real] (화면·인쇄 사진 공격 판별)
// Human.js는 얼굴 검출·랜드마크·동작 챌린지에만 사용하고, 신원 임베딩과 라이브니스 점수는 이 모델들이 담당한다.
const ORT_VER = '1.22.0';
const ORT = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;

// ArcFace 5점 기준 좌표 (112x112): 왼눈, 오른눈, 코끝, 입 왼쪽, 입 오른쪽 (이미지 기준)
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
// MediaPipe FaceMesh(468) 인덱스 → 5점. 눈은 양 끝점의 중점을 쓴다.
const EYE_L = [33, 133], EYE_R = [362, 263], NOSE = 1, MOUTH_L = 61, MOUTH_R = 291;

let loading = null;
export function loadModels() {
  loading ||= (async () => {
    const meta = await fetch('/models/facenet.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const liveMeta = await fetch('/models/livenet.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!meta && !liveMeta) return null; // 아직 학습 전이면 Human.js 모델로 동작
    const ort = await import(`${ORT}ort.min.mjs`);
    ort.env.wasm.wasmPaths = ORT;
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [face, live] = await Promise.all([
      meta ? ort.InferenceSession.create('/models/facenet.onnx', opt) : null,
      liveMeta ? ort.InferenceSession.create('/models/livenet.onnx', opt) : null,
    ]);
    return { ort, face, live, meta, liveMeta };
  })().catch((e) => { console.warn('SSSMS models unavailable, falling back to Human.js', e); return null; });
  return loading;
}

const mid = (m, [a, b]) => [(m[a][0] + m[b][0]) / 2, (m[a][1] + m[b][1]) / 2];
export function fivePoints(mesh) {
  // 사람 기준 오른눈(이미지 왼쪽)이 템플릿의 첫 점
  const a = mid(mesh, EYE_L), b = mid(mesh, EYE_R);
  const [le, re] = a[0] < b[0] ? [a, b] : [b, a];
  const ml = mesh[MOUTH_L], mr = mesh[MOUTH_R];
  return [le, re, [mesh[NOSE][0], mesh[NOSE][1]], ml[0] < mr[0] ? [ml[0], ml[1]] : [mr[0], mr[1]], ml[0] < mr[0] ? [mr[0], mr[1]] : [ml[0], ml[1]]];
}

/** 최소제곱 닮음변환(회전·균등 스케일·이동): src 점들을 dst 템플릿으로 보낸다 */
export function similarity(src, dst) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let a = 0, b = 0, d = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx, y = src[i][1] - sy, u = dst[i][0] - dx, v = dst[i][1] - dy;
    a += x * u + y * v; b += x * v - y * u; d += x * x + y * y;
  }
  a /= d; b /= d;
  // [u v] = [[a -b][b a]] [x y] + t
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

const canvases = {};
function canvas(size) {
  if (!canvases[size]) { const c = document.createElement('canvas'); c.width = c.height = size; canvases[size] = c.getContext('2d', { willReadFrequently: true }); }
  return canvases[size];
}

/** 비디오 프레임에서 정렬된 112x112 얼굴을 잘라낸다 */
export function alignFace(video, mesh) {
  const T = similarity(fivePoints(mesh), TEMPLATE);
  const ctx = canvas(112);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 112, 112);
  ctx.setTransform(T.a, T.b, -T.b, T.a, T.tx, T.ty);
  ctx.drawImage(video, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx;
}

function toTensor(ort, ctx, size, flip = false) {
  const { data } = ctx.getImageData(0, 0, size, size);
  const out = new Float32Array(3 * size * size); const plane = size * size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sxp = flip ? size - 1 - x : x; const p = (y * size + sxp) * 4; const q = y * size + x;
    out[q] = (data[p] - 127.5) / 128; out[plane + q] = (data[p + 1] - 127.5) / 128; out[2 * plane + q] = (data[p + 2] - 127.5) / 128;
  }
  return new ort.Tensor('float32', out, [1, 3, size, size]);
}
const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Array.from(v, (x) => x / s); };

/** 정렬 얼굴 → { embedding(128, L2정규화), real(0~1) } */
export async function infer(models, video, mesh, { embed = true, live = true } = {}) {
  const ctx = alignFace(video, mesh);
  const out = {};
  if (models.face && embed) {
    // onnxruntime-web은 같은 세션의 동시 실행을 허용하지 않으므로 순서대로 실행
    const e1 = await models.face.run({ input: toTensor(models.ort, ctx, 112) });
    const e2 = await models.face.run({ input: toTensor(models.ort, ctx, 112, true) });
    const a = e1.embedding.data, b = e2.embedding.data;
    out.embedding = l2(Array.from(a, (x, i) => x + b[i])); // 좌우 반전 TTA
  }
  if (models.live && live) {
    const c80 = canvas(80); c80.drawImage(ctx.canvas, 0, 0, 80, 80);
    const r = await models.live.run({ input: toTensor(models.ort, c80, 80) });
    const [s, re] = r.logits.data; const m = Math.max(s, re);
    out.real = Math.exp(re - m) / (Math.exp(s - m) + Math.exp(re - m));
  }
  return out;
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
