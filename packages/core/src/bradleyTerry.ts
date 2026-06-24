import type { BtScore, Candidate, Comparison } from "./schemas.js";

interface Outcome {
  i: number;
  j: number;
  y: number;
}

export function fitBradleyTerry(
  candidates: Candidate[] | string[],
  comparisons: Comparison[],
  lambda = 0.01,
  generation: number | "final" = inferGeneration(comparisons)
): BtScore[] {
  const ids = candidates.map((candidate) => (typeof candidate === "string" ? candidate : candidate.id)).sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const outcomes: Outcome[] = [];
  const counts = new Map(
    ids.map((id) => [
      id,
      {
        wins: 0,
        losses: 0,
        ties: 0,
        comparisons: 0
      }
    ])
  );

  for (const comparison of comparisons) {
    const a = comparison.presentedAOriginalId;
    const b = comparison.presentedBOriginalId;
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) continue;

    const aCount = counts.get(a)!;
    const bCount = counts.get(b)!;
    aCount.comparisons += 1;
    bCount.comparisons += 1;

    if (comparison.winner === "A") {
      outcomes.push({ i, j, y: 1 });
      aCount.wins += 1;
      bCount.losses += 1;
    } else if (comparison.winner === "B") {
      outcomes.push({ i, j, y: 0 });
      bCount.wins += 1;
      aCount.losses += 1;
    } else {
      outcomes.push({ i, j, y: 0.5 });
      aCount.ties += 1;
      bCount.ties += 1;
    }
  }

  const scores = new Array(ids.length).fill(0);
  if (outcomes.length > 0) {
    fitLbfgs(scores, outcomes, lambda);
  }

  const ranked = ids
    .map((candidateId, i) => {
      const count = counts.get(candidateId)!;
      return {
        candidateId,
        generation,
        score: finite(scores[i]),
        rank: 0,
        wins: count.wins,
        losses: count.losses,
        ties: count.ties,
        comparisons: count.comparisons
      };
    })
    .sort((left, right) => right.score - left.score || left.candidateId.localeCompare(right.candidateId));

  let tieGroup = 0;
  let previousScore: number | undefined;
  return ranked.map((score, i) => {
    if (previousScore === undefined || Math.abs(score.score - previousScore) > 1e-9) {
      tieGroup += 1;
      previousScore = score.score;
    }
    return { ...score, rank: i + 1, tieGroup, tieBreakerRank: i + 1 };
  });
}

function fitLbfgs(scores: number[], outcomes: Outcome[], lambda: number): void {
  const historySize = 10;
  const sHistory: number[][] = [];
  const yHistory: number[][] = [];
  const rhoHistory: number[] = [];
  let currentLoss = loss(scores, outcomes, lambda);
  let currentGrad = gradient(scores, outcomes, lambda);

  for (let iter = 0; iter < 500; iter += 1) {
    const norm = vectorNorm(currentGrad);
    if (norm < 1e-7) break;

    let direction = lbfgsDirection(currentGrad, sHistory, yHistory, rhoHistory).map((value) => -value);
    if (dot(direction, currentGrad) >= 0) direction = currentGrad.map((value) => -value);

    let step = 1;
    let acceptedScores: number[] | undefined;
    let acceptedLoss = Number.POSITIVE_INFINITY;
    const directionalDerivative = dot(currentGrad, direction);

    for (let backtrack = 0; backtrack < 30; backtrack += 1) {
      const candidate = scores.map((score, i) => score + step * direction[i]);
      center(candidate);
      const candidateLoss = loss(candidate, outcomes, lambda);
      if (Number.isFinite(candidateLoss) && candidateLoss <= currentLoss + 1e-4 * step * directionalDerivative) {
        acceptedScores = candidate;
        acceptedLoss = candidateLoss;
        break;
      }
      step *= 0.5;
    }
    if (!acceptedScores) break;

    const nextGrad = gradient(acceptedScores, outcomes, lambda);
    const s = acceptedScores.map((score, i) => score - scores[i]);
    const y = nextGrad.map((value, i) => value - currentGrad[i]);
    const ys = dot(y, s);
    if (ys > 1e-10) {
      sHistory.push(s);
      yHistory.push(y);
      rhoHistory.push(1 / ys);
      if (sHistory.length > historySize) {
        sHistory.shift();
        yHistory.shift();
        rhoHistory.shift();
      }
    }

    for (let i = 0; i < scores.length; i += 1) scores[i] = acceptedScores[i];
    currentLoss = acceptedLoss;
    currentGrad = nextGrad;
  }
  zScore(scores);
}

function lbfgsDirection(grad: number[], sHistory: number[][], yHistory: number[][], rhoHistory: number[]): number[] {
  const q = [...grad];
  const alphas: number[] = [];
  for (let i = sHistory.length - 1; i >= 0; i -= 1) {
    const alpha = rhoHistory[i] * dot(sHistory[i], q);
    alphas[i] = alpha;
    addScaled(q, yHistory[i], -alpha);
  }

  const lastS = sHistory.at(-1);
  const lastY = yHistory.at(-1);
  const gamma = lastS && lastY ? dot(lastS, lastY) / Math.max(dot(lastY, lastY), 1e-12) : 1;
  for (let i = 0; i < q.length; i += 1) q[i] *= gamma;

  for (let i = 0; i < sHistory.length; i += 1) {
    const beta = rhoHistory[i] * dot(yHistory[i], q);
    addScaled(q, sHistory[i], (alphas[i] ?? 0) - beta);
  }
  return q;
}

function gradient(scores: number[], outcomes: Outcome[], lambda: number): number[] {
  const grad = scores.map((score) => lambda * score);
  for (const outcome of outcomes) {
    const p = sigmoid(scores[outcome.i] - scores[outcome.j]);
    const delta = p - outcome.y;
    grad[outcome.i] += delta;
    grad[outcome.j] -= delta;
  }
  return grad;
}

function loss(scores: number[], outcomes: Outcome[], lambda: number): number {
  let scoreNorm = 0;
  for (let i = 0; i < scores.length; i += 1) scoreNorm += scores[i] * scores[i];
  let total = 0.5 * lambda * scoreNorm;
  for (const outcome of outcomes) {
    const diff = scores[outcome.i] - scores[outcome.j];
    total += softplus(diff) - outcome.y * diff;
  }
  return total;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function softplus(value: number): number {
  return value > 30 ? value : Math.log1p(Math.exp(value));
}

function center(values: number[]): void {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i];
  const mean = total / values.length;
  for (let i = 0; i < values.length; i += 1) values[i] -= mean;
}

// Match the reference Python implementation's score scaling: subtract the mean
// and divide by stddev (z-score). Rank is invariant under this affine transform.
// Note: the OpenDeepThink paper (Zhou et al. 2026) specifies raw L2-regularized
// MLE; z-scoring is a reference-repo logging convention, not a paper-specified
// step. We adopt it so logged `score:` values are directly comparable to the
// reference's outputs.
function zScore(values: number[]): void {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i];
  const mean = total / values.length;
  let variance = 0;
  for (let i = 0; i < values.length; i += 1) {
    const centered = values[i] - mean;
    values[i] = centered;
    variance += centered * centered;
  }
  variance /= values.length;
  const std = Math.sqrt(variance);
  if (std <= 1e-6) return;
  for (let i = 0; i < values.length; i += 1) values[i] /= std;
}

function dot(left: number[], right: number[]): number {
  let total = 0;
  for (let i = 0; i < left.length; i += 1) total += left[i] * right[i];
  return total;
}

function addScaled(target: number[], vector: number[], scale: number): void {
  for (let i = 0; i < target.length; i += 1) target[i] += scale * vector[i];
}

function vectorNorm(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i] * values[i];
  return Math.sqrt(total);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function inferGeneration(comparisons: Comparison[]): number | "final" {
  return comparisons[0]?.generation ?? "final";
}
