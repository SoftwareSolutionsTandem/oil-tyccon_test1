/** Процедурный шум для текстур. Всё детерминировано по seed, чтобы карта выглядела одинаково после загрузки. */

export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise 0..1. period > 0 делает шум бесшовно повторяющимся. */
export function valueNoise(x: number, y: number, seed = 0, period = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const w = (v: number) => (period > 0 ? ((v % period) + period) % period : v);
  const h = (ix: number, iy: number) => hash2(w(ix), w(iy), seed);
  const a = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * fx;
  const b = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * fx;
  return a + (b - a) * fy;
}

export function fbm(x: number, y: number, octaves: number, seed = 0, period = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, seed + i * 17, period > 0 ? period * f : 0) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/**
 * Бесшовная текстура «грязи» для материалов: почти белая с пятнами и зерном.
 * Накладывается режимом multiply — затемняет и разнообразит поверхность.
 */
export function grimeTexture(size: number, seed: number, opts: { streaks?: boolean; contrast?: number } = {}): HTMLCanvasElement {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const contrast = opts.contrast ?? 1;
  const period = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * period;
      const v = (y / size) * period;
      let n = fbm(u, v, 4, seed, period);
      if (opts.streaks) n = n * 0.4 + fbm(u * 3, v * 0.25, 3, seed + 5, period * 3) * 0.6;
      const grain = hash2(x, y, seed + 99) - 0.5;
      const val = 255 - Math.max(0, (0.62 - n) * 190 * contrast) + grain * 18 * contrast;
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, val);
      img.data[i + 1] = Math.min(255, val * 0.98);
      img.data[i + 2] = Math.min(255, val * 0.95);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
