import { proj, type V3 } from './model';
import { createCanvas } from './noise';

/** 0 — пыль у земли (рисуется до объектов), 1 — дым/выхлоп (поднимается, рисуется поверх объектов). */
export type ParticleKind = 0 | 1;

const CAPACITY = 480;
const VARIANTS = 4;

/**
 * Лёгкая система частиц на типизированных массивах: без выделения памяти в кадре,
 * фиксированная ёмкость (старейшие частицы вытесняются), время — игровое (пауза замораживает частицы).
 */
export class ParticleSystem {
  private x = new Float32Array(CAPACITY);
  private y = new Float32Array(CAPACITY);
  private z = new Float32Array(CAPACITY);
  private vx = new Float32Array(CAPACITY);
  private vy = new Float32Array(CAPACITY);
  private vz = new Float32Array(CAPACITY);
  private age = new Float32Array(CAPACITY);
  private life = new Float32Array(CAPACITY);
  private r0 = new Float32Array(CAPACITY);
  private r1 = new Float32Array(CAPACITY);
  private alpha = new Float32Array(CAPACITY);
  private kind = new Uint8Array(CAPACITY);
  private variant = new Uint8Array(CAPACITY);
  private seed = new Float32Array(CAPACITY);
  private next = 0;
  private time = 0;
  private textures: HTMLCanvasElement[][];
  /** Множитель интенсивности испускания (адаптивное качество). */
  quality = 1;

  constructor() {
    this.textures = [makePuffs([200, 176, 134], 11), makePuffs([176, 178, 182], 23)];
  }

  get count(): number {
    let n = 0;
    for (let i = 0; i < CAPACITY; i++) if (this.age[i] < this.life[i]) n++;
    return n;
  }

  /** Ветер в плоскости земли, клеток/с: медленно меняет силу и направление. */
  private wind(): [number, number] {
    const t = this.time;
    return [0.12 + 0.07 * Math.sin(t * 0.05), -0.05 + 0.06 * Math.cos(t * 0.037 + 1)];
  }

  /**
   * Испускание с заданной интенсивностью (частиц в игровую секунду): дробная часть разыгрывается случайно,
   * поэтому поток не выглядит механически равномерным.
   */
  emit(kind: ParticleKind, at: V3, rate: number, simDt: number, opts: Partial<EmitOptions> = {}): void {
    const expected = rate * simDt * this.quality;
    let n = Math.floor(expected);
    if (Math.random() < expected - n) n++;
    for (let k = 0; k < n; k++) this.spawn(kind, at, opts);
  }

  spawn(kind: ParticleKind, at: V3, opts: Partial<EmitOptions> = {}): void {
    const o = { ...DEFAULTS[kind], ...opts };
    const i = this.next;
    this.next = (this.next + 1) % CAPACITY;
    const jitter = (v: number) => (Math.random() - 0.5) * 2 * v;
    this.x[i] = at[0] + jitter(o.spread);
    this.y[i] = at[1] + jitter(o.spread);
    this.z[i] = at[2];
    this.vx[i] = o.vx + jitter(o.speedJitter);
    this.vy[i] = o.vy + jitter(o.speedJitter);
    this.vz[i] = o.vz * (0.7 + Math.random() * 0.6);
    this.age[i] = 0;
    this.life[i] = o.life * (0.7 + Math.random() * 0.6);
    this.r0[i] = o.size * (0.7 + Math.random() * 0.6);
    this.r1[i] = this.r0[i] * o.growth * (0.8 + Math.random() * 0.4);
    this.alpha[i] = o.alpha * (0.75 + Math.random() * 0.5);
    this.kind[i] = kind;
    this.variant[i] = Math.floor(Math.random() * VARIANTS);
    this.seed[i] = Math.random() * 100;
  }

  update(simDt: number): void {
    if (simDt <= 0) return;
    this.time += simDt;
    const [wx, wy] = this.wind();
    const drag = Math.exp(-1.6 * simDt);
    for (let i = 0; i < CAPACITY; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += simDt;
      const k = this.age[i] / this.life[i];
      // Сопротивление воздуха гасит начальную скорость, ветер постепенно подхватывает частицу.
      const pull = Math.min(1, k * 1.5);
      const turb = Math.sin(this.time * 2.3 + this.seed[i]) * 0.05;
      this.vx[i] = this.vx[i] * drag + (wx + turb) * pull * (1 - drag);
      this.vy[i] = this.vy[i] * drag + (wy - turb) * pull * (1 - drag);
      this.x[i] += this.vx[i] * simDt;
      this.y[i] += this.vy[i] * simDt;
      this.vz[i] *= this.kind[i] === 1 ? Math.exp(-0.5 * simDt) : drag;
      this.z[i] = Math.max(0, this.z[i] + this.vz[i] * simDt);
    }
  }

  /** Перебор живых частиц вида kind с глубиной x + y — для сортировки вместе с объектами. */
  forEachAlive(kind: ParticleKind, cb: (index: number, depth: number) => void): void {
    for (let i = 0; i < CAPACITY; i++) {
      if (this.kind[i] === kind && this.age[i] < this.life[i]) cb(i, this.x[i] + this.y[i]);
    }
  }

  drawOne(ctx: CanvasRenderingContext2D, i: number): void {
    const k = this.age[i] / this.life[i];
    // Быстрое появление и плавное исчезновение.
    const fade = Math.min(1, k * 5) * (1 - k);
    const a = this.alpha[i] * fade;
    if (a < 0.01) return;
    const r = this.r0[i] + (this.r1[i] - this.r0[i]) * Math.sqrt(k);
    const [sx, sy] = proj([this.x[i], this.y[i], this.z[i]]);
    ctx.globalAlpha = a;
    ctx.drawImage(this.textures[this.kind[i]][this.variant[i]], sx - r, sy - r * 0.8, r * 2, r * 1.6);
    ctx.globalAlpha = 1;
  }

  draw(ctx: CanvasRenderingContext2D, kind: ParticleKind): void {
    this.forEachAlive(kind, (i) => this.drawOne(ctx, i));
  }
}

interface EmitOptions {
  spread: number;
  vx: number;
  vy: number;
  vz: number;
  speedJitter: number;
  life: number;
  size: number;
  growth: number;
  alpha: number;
}

const DEFAULTS: Record<ParticleKind, EmitOptions> = {
  0: { spread: 0.06, vx: 0, vy: 0, vz: 0.18, speedJitter: 0.25, life: 2, size: 3.6, growth: 3.4, alpha: 0.85 },
  1: { spread: 0.01, vx: 0, vy: 0, vz: 0.55, speedJitter: 0.04, life: 2.6, size: 1.8, growth: 4.2, alpha: 0.75 },
};

/** Несколько вариантов «клубов» из перекрывающихся мягких пятен, чтобы частицы не выглядели одинаковыми кругами. */
function makePuffs(rgb: [number, number, number], seed: number): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let v = 0; v < VARIANTS; v++) {
    const size = 32;
    const c = createCanvas(size, size);
    const ctx = c.getContext('2d')!;
    for (let k = 0; k < 5; k++) {
      const cx = size / 2 + (rand() - 0.5) * 10;
      const cy = size / 2 + (rand() - 0.5) * 10;
      const r = 6 + rand() * 8;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const tone = 0.85 + rand() * 0.3;
      const col = rgb.map((c0) => Math.min(255, Math.round(c0 * tone))).join(',');
      g.addColorStop(0, `rgba(${col},0.7)`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    out.push(c);
  }
  return out;
}
