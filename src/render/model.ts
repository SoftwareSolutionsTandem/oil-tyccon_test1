import { createCanvas } from './noise';

/**
 * Мини-3D для запекания спрайтов. Координаты: x, y — в клетках, z — высота в тех же единицах.
 * Проекция совпадает с картой: клетка (1,0) → (32,16) px, единица высоты → ZPX px вверх
 * (это соответствует ортографической камере с азимутом 45° и углом возвышения 30°).
 */
export type V3 = readonly [number, number, number];
export type RGB = readonly [number, number, number];

export const ZPX = 39.2;
/** Масштаб запекания спрайтов: 2 пикселя спрайта на пиксель мира — чётко при приближении и на HiDPI. */
export const SPRITE_SCALE = 2;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Солнце: слева-спереди и сверху. Правые грани (+x) в тени, левые (+y) освещены, тени падают вправо. */
export const LIGHT = norm([-0.2, 0.7, 0.75]);
/** Направление на камеру. */
export const VIEW = norm([1, 1, 0.816]);
const HALF = norm(add(LIGHT, VIEW));
/** Смещение тени по земле на единицу высоты. */
export const SHADOW_DIR: readonly [number, number] = [-LIGHT[0] / LIGHT[2], -LIGHT[1] / LIGHT[2]];

export function proj(p: V3): [number, number] {
  return [(p[0] - p[1]) * 32, (p[0] + p[1]) * 16 - p[2] * ZPX];
}

/** Точка тени на земле (в клетках). */
export function groundShadow(p: V3): [number, number] {
  return [p[0] + p[2] * SHADOW_DIR[0], p[1] + p[2] * SHADOW_DIR[1]];
}

export interface Material {
  rgb: RGB;
  /** Сила блика 0..1 и его резкость. */
  spec: number;
  shine: number;
}

export const mat = (rgb: RGB, spec = 0.08, shine = 12): Material => ({ rgb, spec, shine });

export const MATERIALS = {
  concrete: mat([168, 164, 154], 0.03, 6),
  gravel: mat([132, 124, 110], 0.02, 4),
  steelDark: mat([58, 62, 68], 0.25, 18),
  steel: mat([120, 126, 132], 0.35, 24),
  galvanized: mat([178, 184, 186], 0.4, 26),
  tankWhite: mat([222, 222, 216], 0.22, 20),
  aluminium: mat([200, 206, 212], 0.65, 40),
  rubber: mat([34, 34, 36], 0.08, 8),
  glass: mat([52, 78, 96], 0.9, 60),
  roofGray: mat([112, 116, 118], 0.12, 10),
  wall: mat([206, 196, 176], 0.04, 8),
  brand: mat([206, 150, 28], 0.3, 20),
  red: mat([168, 42, 34], 0.3, 22),
  rust: mat([128, 74, 44], 0.05, 6),
};

/** Цвет поверхности с нормалью n: небесный эмбиент + тёплое солнце + блик Блинна — Фонга. */
export function shade(m: Material, n: V3, ao = 1): string {
  const d = Math.max(0, dot(n, LIGHT));
  const sky = 0.55 + 0.45 * n[2];
  const spec = d > 0 ? m.spec * Math.pow(Math.max(0, dot(n, HALF)), m.shine) : 0;
  const r = (m.rgb[0] * (0.5 * sky + 1.06 * d) + 255 * spec) * ao;
  const g = (m.rgb[1] * (0.53 * sky + 1.0 * d) + 248 * spec) * ao;
  const b = (m.rgb[2] * (0.62 * sky + 0.86 * d) + 236 * spec) * ao;
  return `rgb(${Math.min(255, r) | 0},${Math.min(255, g) | 0},${Math.min(255, b) | 0})`;
}

/** Фигура тени на земле в координатах клеток относительно начала клетки объекта. */
export type ShadowShape =
  | { kind: 'poly'; pts: Array<[number, number]> }
  | { kind: 'line'; a: [number, number]; b: [number, number]; w: number };

function hull(points: Array<[number, number]>): Array<[number, number]> {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const crossZ = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Рисует примитивы в спрайт. Без контекста работает в режиме измерения — собирает габариты,
 * чтобы потом создать холст ровно нужного размера.
 */
export class ModelPainter {
  readonly shadows: ShadowShape[] = [];
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  castShadows = true;

  constructor(readonly ctx: CanvasRenderingContext2D | null) {}

  pt(p: V3): [number, number] {
    const s = proj(p);
    if (s[0] < this.minX) this.minX = s[0];
    if (s[0] > this.maxX) this.maxX = s[0];
    if (s[1] < this.minY) this.minY = s[1];
    if (s[1] > this.maxY) this.maxY = s[1];
    return s;
  }

  private path(points: V3[]): void {
    const ctx = this.ctx!;
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = this.pt(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }

  /** Залитый многоугольник; тонкая обводка тем же цветом убирает щели сглаживания между гранями. */
  poly(points: V3[], fill: string | CanvasGradient): void {
    if (!this.ctx) {
      points.forEach((p) => this.pt(p));
      return;
    }
    this.path(points);
    this.ctx.fillStyle = fill;
    this.ctx.fill();
    this.ctx.strokeStyle = fill;
    this.ctx.lineWidth = 0.35;
    this.ctx.stroke();
  }

  /** Плоская грань с освещением; невидимые с камеры грани пропускаются. */
  face(points: V3[], m: Material, n?: V3, ao = 1): void {
    const normal = n ?? norm(cross(sub(points[1], points[0]), sub(points[2], points[0])));
    if (dot(normal, VIEW) <= 1e-4) return;
    this.poly(points, this.ctx ? shade(m, normal, ao) : '');
  }

  /** Вертикальная грань с затемнением у земли (ambient occlusion). */
  private aoFace(points: V3[], m: Material, n: V3, zBottom: number): void {
    if (dot(n, VIEW) <= 1e-4) return;
    if (!this.ctx || zBottom > 0.02) return this.face(points, m, n);
    const top = Math.max(...points.map((p) => p[2]));
    const [, y0] = proj([points[0][0], points[0][1], 0]);
    const g = this.ctx.createLinearGradient(0, y0, 0, y0 - Math.min(0.25, top) * ZPX);
    g.addColorStop(0, shade(m, n, 0.62));
    g.addColorStop(1, shade(m, n, 1));
    this.poly(points, g);
  }

  shadowPoly(points: V3[]): void {
    if (!this.castShadows) return;
    this.shadows.push({ kind: 'poly', pts: hull(points.map(groundShadow)) });
  }

  shadowLine(a: V3, b: V3, w: number): void {
    if (!this.castShadows) return;
    this.shadows.push({ kind: 'line', a: groundShadow(a), b: groundShadow(b), w });
  }

  /** Параллелепипед по осям. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: Material, top?: Material): void {
    this.aoFace([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], m, [0, 1, 0], z0);
    this.aoFace([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], m, [1, 0, 0], z0);
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], top ?? m, [0, 0, 1]);
    if (this.ctx && z1 - z0 > 0.01) {
      // Светлая кромка верхней грани делает силуэт чётче.
      const ctx = this.ctx;
      ctx.beginPath();
      const a = proj([x0, y1, z1]);
      const b = proj([x1, y1, z1]);
      const c = proj([x1, y0, z1]);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.strokeStyle = 'rgba(255,250,235,0.28)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    if (z1 > 0.005) {
      const pts: V3[] = [];
      for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) pts.push([x, y, z]);
      this.shadowPoly(pts);
    }
  }

  /** Произвольно ориентированный параллелепипед: центр и три полуоси. */
  obox(c: V3, ax: V3, ay: V3, az: V3, m: Material): void {
    const corner = (i: number, j: number, k: number) => add(add(add(c, mul(ax, i)), mul(ay, j)), mul(az, k));
    const faces: Array<[V3, V3[]]> = [];
    for (const [axis, u, v] of [
      [ax, ay, az],
      [ay, az, ax],
      [az, ax, ay],
    ] as const) {
      for (const s of [1, -1]) {
        const n = mul(norm(axis), s);
        const center = add(c, mul(axis, s));
        faces.push([n, [add(add(center, mul(u, -1)), mul(v, -1)), add(add(center, u), mul(v, -1)), add(add(center, u), v), add(add(center, mul(u, -1)), v)]]);
      }
    }
    for (const [n, pts] of faces) this.face(pts, m, n);
    const all: V3[] = [];
    for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) all.push(corner(i, j, k));
    if (Math.max(...all.map((p) => p[2])) > 0.005) this.shadowPoly(all);
  }

  /** Вертикальный цилиндр с плавным освещением и бликом. */
  cylinder(cx: number, cy: number, z0: number, r: number, h: number, m: Material, top?: Material | null): void {
    const rx = r * 32 * Math.SQRT2;
    const ry = r * 16 * Math.SQRT2;
    const [bx, by] = this.pt([cx, cy, z0]);
    const tyy = by - h * ZPX;
    this.pt([cx - r * 1.5, cy + r * 1.5, z0]);
    this.pt([cx + r * 1.5, cy - r * 1.5, z0 + h]);
    this.minX = Math.min(this.minX, bx - rx);
    this.maxX = Math.max(this.maxX, bx + rx);
    this.maxY = Math.max(this.maxY, by + ry);
    this.minY = Math.min(this.minY, tyy - ry);
    if (h > 0.005) this.shadowLine([cx, cy, z0], [cx, cy, z0 + h], r * 2);
    if (!this.ctx) return;
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(bx - rx, 0, bx + rx, 0);
    for (let i = 0; i <= 24; i++) {
      const psi = (i / 24) * Math.PI;
      const theta = (3 * Math.PI) / 4 - psi;
      g.addColorStop((1 - Math.cos(psi)) / 2, shade(m, [Math.cos(theta), Math.sin(theta), 0]));
    }
    ctx.beginPath();
    ctx.moveTo(bx - rx, tyy);
    ctx.lineTo(bx - rx, by);
    ctx.ellipse(bx, by, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(bx + rx, tyy);
    ctx.ellipse(bx, tyy, rx, ry, 0, 0, Math.PI, false);
    ctx.fillStyle = g;
    ctx.fill();
    if (z0 < 0.02 && h > 0.05) {
      // Затемнение у основания.
      const ao = ctx.createLinearGradient(0, by + ry, 0, by + ry - Math.min(h, 0.2) * ZPX - ry);
      ao.addColorStop(0, 'rgba(20,16,10,0.35)');
      ao.addColorStop(1, 'rgba(20,16,10,0)');
      ctx.fillStyle = ao;
      ctx.fill();
    }
    if (top !== null) {
      ctx.beginPath();
      ctx.ellipse(bx, tyy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(top ?? m, [0, 0, 1]);
      ctx.fill();
    }
  }

  /** Конус из граней (крыши резервуаров). */
  cone(cx: number, cy: number, z0: number, r: number, h: number, m: Material, segments = 32): void {
    const apex: V3 = [cx, cy, z0 + h];
    const ring = (i: number): V3 => {
      const a = (i / segments) * Math.PI * 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z0];
    };
    for (let i = 0; i < segments; i++) {
      const a = ring(i);
      const b = ring(i + 1);
      const n = norm(cross(sub(b, a), sub(apex, a)));
      this.face([a, b, apex], m, dot(n, [0, 0, 1]) < 0 ? mul(n, -1) : n);
    }
  }

  /** Труба между двумя точками (грани + торец). */
  tube(a: V3, b: V3, r: number, m: Material, segments = 12, caps = true): void {
    const d = norm(sub(b, a));
    const ref: V3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(d, ref));
    const v = cross(d, u);
    const ringPt = (base: V3, ang: number): V3 => add(base, add(mul(u, Math.cos(ang) * r), mul(v, Math.sin(ang) * r)));
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      const n = norm(add(mul(u, Math.cos(mid)), mul(v, Math.sin(mid))));
      this.face([ringPt(a, a0), ringPt(a, a1), ringPt(b, a1), ringPt(b, a0)], m, n);
    }
    if (caps) {
      const end = dot(d, VIEW) > 0 ? b : a;
      const n = dot(d, VIEW) > 0 ? d : mul(d, -1);
      const pts: V3[] = [];
      for (let i = 0; i < segments; i++) pts.push(ringPt(end, (i / segments) * Math.PI * 2));
      this.face(pts, m, n, 0.92);
    }
    if (Math.max(a[2], b[2]) > 0.005) this.shadowLine(a, b, r * 2);
  }

  /**
   * Сфера/эллипсоид: радиальный градиент с бликом со стороны солнца.
   * squash < 1 сплющивает по вертикали (валуны), leafy добавляет пятна листвы.
   */
  sphere(c: V3, r: number, m: Material, opts: { squash?: number; leafy?: number } = {}): void {
    const [x, y] = this.pt(c);
    const R = r * 32 * Math.SQRT2;
    const squash = opts.squash ?? 1;
    this.minX = Math.min(this.minX, x - R);
    this.maxX = Math.max(this.maxX, x + R);
    this.minY = Math.min(this.minY, y - R * squash);
    this.maxY = Math.max(this.maxY, y + R * squash);
    if (c[2] > 0) this.shadows.push({ kind: 'line', a: groundShadow(c), b: groundShadow(c), w: r * 2 });
    if (!this.ctx) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, squash);
    ctx.translate(-x, -y);
    this.sphereBody(x, y, R, m);
    if (opts.leafy) {
      // Пятна листвы: светлые со стороны солнца, тёмные в тени.
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.clip();
      let seed = (x * 13.7 + y * 7.1) | 0;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const [lx, ly] = proj(LIGHT);
      const ll = Math.hypot(lx, ly) || 1;
      for (let i = 0; i < opts.leafy; i++) {
        const a = rand() * Math.PI * 2;
        const d = Math.sqrt(rand()) * R;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d;
        const toward = ((px - x) * lx + (py - y) * ly) / (ll * R);
        ctx.fillStyle = toward > 0.1 ? 'rgba(220,230,150,0.22)' : 'rgba(20,30,10,0.28)';
        ctx.beginPath();
        ctx.arc(px, py, R * (0.12 + rand() * 0.16), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private sphereBody(x: number, y: number, R: number, m: Material): void {
    const ctx = this.ctx!;
    const [lx, ly] = proj(LIGHT);
    const ll = Math.hypot(lx, ly) || 1;
    const g = ctx.createRadialGradient(x + (lx / ll) * R * 0.45, y + (ly / ll) * R * 0.45, R * 0.05, x, y, R);
    g.addColorStop(0, shade(m, LIGHT));
    g.addColorStop(0.55, shade(m, norm([LIGHT[0] * 0.3, LIGHT[1] * 0.3, 0.6])));
    g.addColorStop(1, shade(m, norm([-LIGHT[0], -LIGHT[1], 0.1])));
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }

  /** Тонкая линия (тросы, перила) толщиной w пикселей мира. */
  wire(a: V3, b: V3, w: number, color: string): void {
    const pa = this.pt(a);
    const pb = this.pt(b);
    if (!this.ctx) return;
    this.ctx.beginPath();
    this.ctx.moveTo(pa[0], pa[1]);
    this.ctx.lineTo(pb[0], pb[1]);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = w;
    this.ctx.lineCap = 'round';
    this.ctx.stroke();
  }

  /** Текст на плоскости, заданной началом и осями u (вдоль строки) и v (вверх). */
  planeText(origin: V3, u: V3, v: V3, text: string, size: number, color: string): void {
    const o = this.pt(origin);
    if (!this.ctx) return;
    const pu = proj(add(origin, u));
    const pv = proj(add(origin, v));
    const ctx = this.ctx;
    ctx.save();
    // Ось Y холста смотрит вниз, поэтому v берётся с минусом: текст встаёт «вверх» по плоскости.
    ctx.transform(pu[0] - o[0], pu[1] - o[1], -(pv[0] - o[0]), -(pv[1] - o[1]), o[0], o[1]);
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Смещение левого верхнего угла холста от проекции начала клетки, пиксели мира. */
  ox: number;
  oy: number;
  w: number;
  h: number;
  shadows: ShadowShape[];
}

/** Запекает модель в спрайт: измерение → холст по размеру → отрисовка → наложение текстуры загрязнения. */
export function bakeSprite(draw: (p: ModelPainter) => void, grime?: { texture: HTMLCanvasElement; strength: number }): Sprite {
  const measure = new ModelPainter(null);
  draw(measure);
  const pad = 2;
  const ox = Math.floor(measure.minX - pad);
  const oy = Math.floor(measure.minY - pad);
  const w = Math.ceil(measure.maxX + pad) - ox;
  const h = Math.ceil(measure.maxY + pad) - oy;
  const canvas = createCanvas(w * SPRITE_SCALE, h * SPRITE_SCALE);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(SPRITE_SCALE, 0, 0, SPRITE_SCALE, -ox * SPRITE_SCALE, -oy * SPRITE_SCALE);
  const painter = new ModelPainter(ctx);
  draw(painter);
  if (grime) applyGrime(canvas, grime.texture, grime.strength);
  return { canvas, ox, oy, w, h, shadows: painter.shadows };
}

/** Умножает спрайт на текстуру загрязнения, сохраняя его альфа-маску. */
export function applyGrime(canvas: HTMLCanvasElement, texture: HTMLCanvasElement, strength: number): void {
  const ctx = canvas.getContext('2d')!;
  const copy = createCanvas(canvas.width, canvas.height);
  copy.getContext('2d')!.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = strength;
  ctx.fillStyle = ctx.createPattern(texture, 'repeat')!;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(copy, 0, 0);
  ctx.restore();
}
