export const UINT32_SIZE = 0x1_0000_0000;
const EPS = 1e-12;

export function drawUInt32(rng: () => number): number {
  return Math.floor(rng() * UINT32_SIZE) >>> 0;
}

export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / UINT32_SIZE;
  };
}

export function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function weightedSample(weights: number[], rng: () => number): number {
  let total = 0;
  for (const weight of weights) total += weight;

  if (total <= EPS) {
    return weights.findIndex((weight) => weight > 0);
  }

  let threshold = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    threshold -= weights[i];
    if (threshold <= 0) return i;
  }

  for (let i = weights.length - 1; i >= 0; i -= 1) {
    if (weights[i] > 0) return i;
  }
  return -1;
}
