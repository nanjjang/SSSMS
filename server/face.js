// Face embedding matching (1:N identification)
// Port of Human.js `match.similarity`: squared euclidean distance scaled and mapped to 0..1.
// FaceRes descriptors are non-negative, so plain cosine is badly calibrated; this metric is what
// the model's recommended thresholds (~0.5) are tuned for.
const OPT = { multiplier: 25, min: 0.2, max: 0.8 };

export function toVec(v) {
  const a = Array.from(v ?? [], Number);
  if (a.some((x) => !Number.isFinite(x))) return [];
  return a;
}
// 자체 학습 모델(128차원, L2 정규화)은 코사인 유사도를 쓴다.
// 학습 때 LFW로 구한 임계값(threshold)이 설정의 매칭 기준(match_threshold, 기본 0.6)에 오도록 0~1로 보정한다.
import { readFileSync } from 'node:fs';
// 1:N 비교는 등록 인원 × 샘플 수만큼 비교하므로 1:1 최고 정확도 기준(다른 사람 통과 약 1%)은 너무 느슨하다.
// LFW에서 다른 사람 통과율 0.1%인 기준(threshold_far01)이 있으면 그것을 쓴다.
let OWN = { t: 0.34 };
try { const m = JSON.parse(readFileSync(new URL('../public/models/facenet.json', import.meta.url))); OWN = { t: m.threshold_far01 ?? m.threshold_best_acc ?? 0.34 }; } catch {}
export const MATCH_REF = 0.6;
function ownSimilarity(a, b) {
  // 코사인 유사도: 길이로 나눠야 한다 (여러 프레임을 평균 낸 벡터는 길이가 1보다 짧아 점수가 낮게 나왔음)
  let c = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { c += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  c /= Math.sqrt(na * nb) || 1;
  const t = OWN.t;
  const s = c >= t ? MATCH_REF + (1 - MATCH_REF) * (c - t) / (1 - t) : MATCH_REF * (c + 1) / (t + 1);
  return Math.max(0, Math.min(1, s));
}

export function similarity(a, b) {
  if (a.length !== b.length || !a.length) return 0;
  if (a.length === 128) return ownSimilarity(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  const dist = OPT.multiplier * sum;
  if (dist === 0) return 1;
  const norm = (1 - Math.sqrt(dist) / 100 - OPT.min) / (OPT.max - OPT.min);
  return Math.max(0, Math.min(1, norm));
}
/**
 * candidates: [{id, name, face: JSON string of embeddings[]}]
 * Returns the best student (max similarity over that student's samples) and the margin vs. the
 * second-best student — a low margin means an ambiguous identity, which we reject.
 */
export function bestMatch(vec, candidates) {
  const scored = [];
  for (const c of candidates) {
    let samples; try { samples = JSON.parse(c.face); } catch { continue; }
    let best = 0;
    for (const s of samples) best = Math.max(best, similarity(vec, s));
    scored.push({ id: c.id, name: c.name, score: best });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return { ...scored[0], margin: scored[0].score - (scored[1]?.score ?? 0) };
}
