import { HQ_POS, type GameState } from '../core';
import type { GroundDecals } from './ground';
import { mipmap } from './mipmap';
import { isoX, isoY } from './iso';
import { bakeSprite, MATERIALS as M, mat, type ModelPainter, type RGB, type Sprite, type V3 } from './model';
import { createCanvas, grimeTexture, hash2, smoothstep, valueNoise } from './noise';
import type { SpriteLibrary } from './sprites';
import { desertWeight, type TerrainLayer } from './terrain';
import type { TerrainSource } from './terrainSource';

/**
 * Окружение игровой карты — чисто визуальный большой мир в три зоны:
 *  - ближняя: сама карта (рисует Renderer);
 *  - средняя: кольцо степи вокруг карты — ячейки 8×8 клеток в проекции, растительность и камни запечены в текстуру;
 *  - дальняя: одна грубая текстура до горизонта + крупные ориентиры (гряды холмов, буровые, факел, ЛЭП).
 * Дымка — одна радиальная функция расстояния от центра карты, запечена во все три слоя окружения.
 * На игровые правила окружение не влияет: строить и покупать можно только внутри карты.
 */

/** Ширина кольца средней зоны вокруг карты и размер её ячейки, клетки. */
export const MID_RING = 24;
export const MID_CELL = 8;
/** Дальняя текстура: квадрат [−FAR, size+FAR] при FAR_TEX пикселях на клетку. */
const FAR = 120;
const FAR_TEX = 3;

/** Цвет дымки и фона (днём; ночью общий multiply делает его тёмно-синим). */
export const HAZE_RGB: RGB = [186, 186, 172];
export const HAZE_CSS = `rgb(${HAZE_RGB.join(',')})`;

/** Дымка от центра карты: прозрачна над игровой территорией, к ~100 клеткам сливается с фоном. */
const HAZE_R0 = 26;
const HAZE_R1 = 92;

export function hazeAt(s: { map: { size: number } }, u: number, v: number): number {
  const c = s.map.size / 2;
  const d = Math.hypot(u - c, v - c);
  const k = smoothstep(HAZE_R0, HAZE_R1, d);
  return Math.min(1, k * (0.75 + 0.25 * k));
}

/** Та же дымка как радиальный градиент в координатах клеток — для заливки поверх запечённых слоёв. */
function hazeGradient(ctx: CanvasRenderingContext2D, size: number): CanvasGradient {
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, HAZE_R0, c, c, HAZE_R1);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const k = t * t * (3 - 2 * t);
    g.addColorStop(t, `rgba(${HAZE_RGB.join(',')},${Math.min(1, k * (0.75 + 0.25 * k)).toFixed(3)})`);
  }
  return g;
}

/** Затемнение «не своей» земли — то же, что у непроданных участков карты, чтобы граница не выглядела обрывом. */
function dimForeign(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.globalCompositeOperation = 'saturation';
  ctx.fillStyle = 'rgba(128,128,128,0.4)';
  ctx.fillRect(x, y, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(16,22,32,0.24)';
  ctx.fillRect(x, y, w, h);
}

interface MidCell {
  canvas: HTMLCanvasElement;
  ox: number;
  oy: number;
  w: number;
  h: number;
  lastSeen: number;
  /** Кадр запекания — новая ячейка проявляется плавно, а не выскакивает. */
  born: number;
}

interface Landmark {
  x: number;
  y: number;
  sprite: Sprite;
  /** Глубина сортировки. */
  order: number;
  flare?: V3;
}

const GROUND = [32, 16, -32, 16, 0, 0] as const;
const MID_MARGIN = 4;
/** Запас холста ячейки степи сверху под деревья, пиксели мира. */
const MID_TOP = 56;
const NEAR_SCALE = 0.6;
const FAR_SCALE = 0.32;

export class Environment {
  private far: HTMLCanvasElement | null = null;
  private mid = new Map<string, MidCell>();
  private landmarks: Landmark[] = [];
  private pylons: Array<{ x: number; y: number; haze: number }> = [];
  private frame = 0;
  private cellOrder: Array<[number, number]> | null = null;
  private farJob: Generator<void, HTMLCanvasElement> | null = null;
  readonly roads: Array<Array<[number, number]>>;

  constructor(
    private s: GameState,
    private terrain: TerrainLayer,
    private source: TerrainSource,
    private sprites: SpriteLibrary,
    private decals: GroundDecals,
  ) {
    const n = s.map.size;
    // Региональные дороги вдоль задних сторон карты и съезд от конторы к ним — за пределами игровой территории.
    this.roads = [
      [[-12, -FAR], [-12, n + FAR]],
      [[-FAR, -11], [n + FAR, -11]],
      [[-12, HQ_POS.y + 1.1], [0, HQ_POS.y + 1.1]],
    ];
    this.buildLandmarks();
  }

  canvases(): HTMLCanvasElement[] {
    const out = [...this.mid.values()].map((c) => c.canvas);
    if (this.far) out.push(this.far);
    for (const l of this.landmarks) out.push(l.sprite.canvas);
    return out;
  }

  // ——— Дальняя зона ———

  /**
   * Дальняя текстура в координатах клеток: та же палитра и шум, что у карты, крупный рельеф (пологие увалы),
   * дороги, затемнение «не своей» земли и дымка. Генерируется один раз, ~1 МБ.
   */
  /** Генерация дальней текстуры кусками строк: вызывающий продвигает её по бюджету времени кадра. */
  private *bakeFarSteps(): Generator<void, HTMLCanvasElement> {
    const n = this.s.map.size;
    const span = n + FAR * 2;
    const size = span * FAR_TEX;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    // Сетка с шагом 2 клетки: вдали нужны только крупные формы, мелкий шум дал бы рябь.
    const step = FAR_TEX * 2;
    const gw = Math.ceil(size / step) + 3;
    const col = new Float32Array(gw * gw * 3);
    const hgt = new Float32Array(gw * gw);
    const c = n / 2;
    for (let gy = 0; gy < gw; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const u = -FAR + (gx * step) / FAR_TEX;
        const v = -FAR + (gy * step) / FAR_TEX;
        const smp = this.terrain.sample(u, v);
        const k = (gy * gw + gx) * 3;
        col[k] = smp.color[0];
        col[k + 1] = smp.color[1];
        col[k + 2] = smp.color[2];
        // Пологие холмы: амплитуда растёт с расстоянием — у карты ровная степь, к горизонту увалы.
        const hills = smoothstep(62, 110, Math.hypot(u - c, v - c));
        hgt[gy * gw + gx] = this.terrain.sample(u * 0.05 + 300, v * 0.05 + 300).height * (0.6 + 3.2 * hills);
      }
      if (gy % 8 === 0) yield;
    }
    // Наклоны в узлах сетки (центральные разности) — освещение потом интерполируется плавно.
    const lit = new Float32Array(gw * gw).fill(1);
    for (let gy = 1; gy < gw - 1; gy++) {
      for (let gx = 1; gx < gw - 1; gx++) {
        const i = gy * gw + gx;
        const hu = (hgt[i + 1] - hgt[i - 1]) / 2;
        const hv = (hgt[i + gw] - hgt[i - gw]) / 2;
        lit[i] = 1 + (hu * 0.19 - hv * 0.67) * 2.4;
      }
    }
    for (let y = 0; y < size; y++) {
      const gy = Math.floor(y / step);
      const ty = y / step - gy;
      for (let x = 0; x < size; x++) {
        const gx = Math.floor(x / step);
        const tx = x / step - gx;
        const i = gy * gw + gx;
        const bil = (arr: Float32Array, stride: number, off: number) => {
          const a = arr[i * stride + off] + (arr[(i + 1) * stride + off] - arr[i * stride + off]) * tx;
          const b2 = arr[(i + gw) * stride + off] + (arr[(i + gw + 1) * stride + off] - arr[(i + gw) * stride + off]) * tx;
          return a + (b2 - a) * ty;
        };
        // Средняя деталь (~1 клетка) и зерно — чтобы дальняя земля не выглядела размытым пятном.
        const u = -FAR + x / FAR_TEX;
        const v = -FAR + y / FAR_TEX;
        const l = bil(lit, 1, 0) * (0.93 + valueNoise(u * 0.9, v * 0.9, 61) * 0.14) + (hash2(x, y, 62) - 0.5) * 0.05;
        const o = (y * size + x) * 4;
        img.data[o] = bil(col, 3, 0) * l;
        img.data[o + 1] = bil(col, 3, 1) * l;
        img.data[o + 2] = bil(col, 3, 2) * l;
        img.data[o + 3] = 255;
      }
      if (y % 24 === 0) yield;
    }
    ctx.putImageData(img, 0, 0);
    yield;
    ctx.setTransform(FAR_TEX, 0, 0, FAR_TEX, FAR * FAR_TEX, FAR * FAR_TEX);
    // Дальняя растительность — уже не деревья, а тёмные точки, гуще в рощах (тот же шум рощ, что в степи).
    for (let y = -FAR; y < n + FAR; y++) {
      for (let x = -FAR; x < n + FAR; x++) {
        const kind = this.decorAt(x, y);
        if (!kind) continue;
        const r = kind === 3 ? 0.32 : kind === 1 ? 0.2 : 0.14;
        ctx.fillStyle = kind === 2 ? 'rgba(150,146,136,0.7)' : 'rgba(58,72,38,0.75)';
        ctx.beginPath();
        ctx.ellipse(x + hash2(x, y, 3), y + hash2(x, y, 4), r, r, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (y % 20 === 0) yield;
    }
    this.decals.strokeRoads(ctx, this.roads, 1.6);
    dimForeign(ctx, -FAR, -FAR, span, span);
    ctx.fillStyle = hazeGradient(ctx, n);
    ctx.fillRect(-FAR, -FAR, span, span);
    return canvas;
  }

  /**
   * Фоновое запекание в спокойных кадрах в пределах бюджета: сначала дальняя текстура (кусками),
   * затем ячейки степи — ближнее кольцо, потом дальнее. Возвращает true, если что-то сделано.
   */
  prebake(budgetMs: number): boolean {
    const t0 = performance.now();
    if (!this.far) {
      this.farJob ??= this.bakeFarSteps();
      while (performance.now() - t0 < budgetMs) {
        const r = this.farJob.next();
        if (r.done) {
          this.far = r.value;
          this.farJob = null;
          break;
        }
      }
      return true;
    }
    const cells = this.cellOrder ?? (this.cellOrder = this.midCells());
    let queued = 0;
    for (const near of [true, false]) {
      for (const [x0, y0] of cells) {
        const key = `${x0},${y0}`;
        if (this.mid.has(key) || this.isNearRing(x0, y0) !== near) continue;
        const cell = this.bakeMid(x0, y0);
        if (!cell) {
          // Текстура запрошена у фонового потока — следующие ячейки тоже ставим в очередь.
          if (++queued >= 3) return true;
          continue;
        }
        cell.born = -100; // ещё невидимая ячейка: проявление не нужно
        this.mid.set(key, cell);
        return true;
      }
    }
    return false;
  }

  drawFar(ctx: CanvasRenderingContext2D): void {
    if (!this.far) return; // пока не готова — виден фон того же цвета дымки
    const n = this.s.map.size;
    ctx.save();
    ctx.transform(...GROUND);
    // Дальняя текстура видна только снаружи плотной части кольца степи: внутреннюю область не растрируем.
    const inner = MID_RING - 11;
    ctx.beginPath();
    ctx.rect(-FAR, -FAR, n + FAR * 2, n + FAR * 2);
    ctx.rect(-inner, -inner, n + inner * 2, n + inner * 2);
    ctx.clip('evenodd');
    ctx.drawImage(this.far, -FAR, -FAR, n + FAR * 2, n + FAR * 2);
    ctx.restore();
  }

  // ——— Средняя зона ———

  private midCells(): Array<[number, number]> {
    const n = this.s.map.size;
    const out: Array<[number, number]> = [];
    for (let y = -MID_RING; y < n + MID_RING; y += MID_CELL) {
      for (let x = -MID_RING; x < n + MID_RING; x += MID_CELL) {
        if (x >= 0 && x < n && y >= 0 && y < n) continue; // внутри карты — ближняя зона
        out.push([x, y]);
      }
    }
    // Сзади вперёд: деревья передних ячеек перекрывают задние.
    return out.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  }

  /** Ячейка степи: текстура, редкие пятна нефти, дороги, затемнение, растительность и камни с тенями, дымка. */
  private bakeMid(x0: number, y0: number): MidCell | null {
    const n = this.s.map.size;
    const near = this.isNearRing(x0, y0);
    const scale = near ? NEAR_SCALE : FAR_SCALE;
    const tex = near ? 32 : 12;
    // Текстура степи готовится в фоновом потоке; пока её нет — видна дальняя текстура.
    const src = this.source.get(x0, y0, MID_CELL, tex);
    if (!src) return null;
    const ox = isoX(x0, y0 + MID_CELL) - MID_MARGIN;
    const oy = isoY(x0, y0) - MID_MARGIN - MID_TOP;
    const w = MID_CELL * 64 + MID_MARGIN * 2;
    const h = MID_CELL * 32 + MID_MARGIN * 2 + MID_TOP;
    const canvas = createCanvas(Math.ceil(w * scale), Math.ceil(h * scale));
    const ctx = canvas.getContext('2d')!;
    const world = () => ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
    world();
    ctx.save();
    ctx.transform(...GROUND);
    const e = 0.06;
    ctx.beginPath();
    ctx.rect(x0 - e, y0 - e, MID_CELL + 2 * e, MID_CELL + 2 * e);
    ctx.clip();
    ctx.drawImage(src.image, x0 - src.pad, y0 - src.pad, MID_CELL + src.pad * 2, MID_CELL + src.pad * 2);
    this.source.release(x0, y0, MID_CELL, tex);
    // Отдалённые нефтепроявления: редкие тёмные пятна там, где крупный шум «нефтеносен».
    for (let y = y0; y < y0 + MID_CELL; y++) {
      for (let x = x0; x < x0 + MID_CELL; x++) {
        const field = this.terrain.sample(x * 0.6 + 900, y * 0.6 + 900).height;
        if (field < 0.66 || hash2(x, y, 41) > 0.45) continue;
        const g = ctx.createRadialGradient(x + 0.5, y + 0.5, 0, x + 0.5, y + 0.5, 0.7);
        g.addColorStop(0, 'rgba(26,20,14,0.6)');
        g.addColorStop(1, 'rgba(26,20,14,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - 0.3, y - 0.3, 1.6, 1.6);
      }
    }
    this.decals.strokeRoads(ctx, this.roads);
    dimForeign(ctx, x0 - 1, y0 - 1, MID_CELL + 2, MID_CELL + 2);
    ctx.restore();

    // Растительность и камни запекаются прямо в ячейку вместе с тенями: на расстоянии это часть ландшафта.
    world();
    for (let d = 0; d < MID_CELL * 2; d++) {
      for (let y = y0; y < y0 + MID_CELL; y++) {
        const x = x0 + d - (y - y0);
        if (x < x0 || x >= x0 + MID_CELL) continue;
        const kind = this.decorAt(x, y);
        if (!kind) continue;
        const sp = this.sprites.decor(kind, Math.floor(hash2(x, y, 5) * 4), true);
        ctx.globalAlpha = 0.5;
        for (const sh of sp.shadows.slice(0, 4)) {
          if (sh.kind !== 'line') continue;
          ctx.fillStyle = '#1a1612';
          ctx.beginPath();
          ctx.ellipse(isoX(x + sh.a[0], y + sh.a[1]), isoY(x + sh.a[0], y + sh.a[1]), sh.w * 26, sh.w * 13, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        // Уменьшенная копия вместо дорогого сглаживания «high» при сжатии спрайта в 3–6 раз.
        ctx.drawImage(mipmap(sp.canvas, (scale * sp.w) / sp.canvas.width), isoX(x, y) + sp.ox, isoY(x, y) + sp.oy, sp.w, sp.h);
      }
    }
    // Дымка поверх всего содержимого ячейки.
    ctx.save();
    ctx.transform(...GROUND);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = hazeGradient(ctx, n);
    ctx.fillRect(x0 - 4, y0 - 4, MID_CELL + 8, MID_CELL + 8);
    // У внешнего края кольца ячейки плавно растворяются в дальней текстуре — без видимой рамки.
    ctx.globalCompositeOperation = 'destination-out';
    const lo = -MID_RING;
    const hi = n + MID_RING;
    const fade = 10;
    const edge = (gx0: number, gy0: number, gx1: number, gy1: number, rx: number, ry: number, rw: number, rh: number) => {
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rw, rh);
    };
    const pad = 12;
    if (x0 - lo < fade + MID_CELL) edge(lo + fade, 0, lo, 0, lo - pad, y0 - pad, fade + pad, MID_CELL + 2 * pad);
    if (hi - (x0 + MID_CELL) < fade + MID_CELL) edge(hi - fade, 0, hi, 0, hi - fade, y0 - pad, fade + pad, MID_CELL + 2 * pad);
    if (y0 - lo < fade + MID_CELL) edge(0, lo + fade, 0, lo, x0 - pad, lo - pad, MID_CELL + 2 * pad, fade + pad);
    if (hi - (y0 + MID_CELL) < fade + MID_CELL) edge(0, hi - fade, 0, hi, x0 - pad, hi - fade, MID_CELL + 2 * pad, fade + pad);
    ctx.restore();
    return { canvas, ox, oy, w, h, lastSeen: this.frame, born: this.frame };
  }

  private isNearRing(x0: number, y0: number): boolean {
    const n = this.s.map.size;
    return x0 >= -MID_CELL && x0 < n + MID_CELL && y0 >= -MID_CELL && y0 < n + MID_CELL;
  }

  /** Декор степи: редкие кусты и камни, деревья рощицами (по крупному шуму). */
  private decorAt(x: number, y: number): number {
    const r = hash2(x, y, 77);
    if (r >= 0.18) return 0; // дешёвая проверка до обращения к шуму
    // Пустыня за восточным краем — только камни.
    if (desertWeight(x + 0.5, y + 0.5) > 0.5) return r < 0.05 ? 2 : 0;
    const grove = this.terrain.sample(x * 0.5 + 500, y * 0.5 - 200).height;
    if (grove > 0.62) return 3;
    if (r < 0.035) return 1;
    if (r < 0.06) return 2;
    return 0;
  }

  /**
   * Рисует видимые ячейки степи (недостающие запекаются, не больше двух за кадр) и вытесняет давно невидимые.
   * view — видимый прямоугольник в пикселях мира.
   */
  drawMid(ctx: CanvasRenderingContext2D, view: { x0: number; x1: number; y0: number; y1: number }, ratio: number, mip: (c: HTMLCanvasElement, r: number) => HTMLCanvasElement): void {
    this.frame++;
    let baked = 0;
    const cells = this.cellOrder ?? (this.cellOrder = this.midCells());
    for (const [x0, y0] of cells) {
      const ox = isoX(x0, y0 + MID_CELL) - MID_MARGIN;
      const oy = isoY(x0, y0) - MID_MARGIN - MID_TOP;
      const w = MID_CELL * 64 + MID_MARGIN * 2;
      const h = MID_CELL * 32 + MID_MARGIN * 2 + MID_TOP;
      if (ox > view.x1 || ox + w < view.x0 || oy > view.y1 || oy + h < view.y0) continue;
      const key = `${x0},${y0}`;
      let cell = this.mid.get(key);
      if (!cell) {
        if (baked >= 1) continue; // пока не готова — видна дальняя текстура
        const fresh = this.bakeMid(x0, y0);
        if (!fresh) continue;
        cell = fresh;
        this.mid.set(key, cell);
        baked++;
      }
      cell.lastSeen = this.frame;
      const appear = Math.min(1, (this.frame - cell.born) / 20);
      if (appear < 1) ctx.globalAlpha = appear;
      ctx.drawImage(mip(cell.canvas, (ratio * cell.w) / cell.canvas.width), cell.ox, cell.oy, cell.w, cell.h);
      ctx.globalAlpha = 1;
    }

    // Освобождаем ячейки, не попадавшие в кадр ~10 секунд, если их много.
    // Ячейки степи немногочисленны (≈100 штук, ~10 МБ) и запекаются заранее, поэтому не вытесняются.
  }

  // ——— Ориентиры ———

  private buildLandmarks(): void {
    const s = this.s;
    const n = s.map.size;
    const tint = (sp: Sprite, x: number, y: number) => hazed(sp, hazeAt(s, x, y));
    const grime = grimeTexture(64, 13, { contrast: 1.6 });
    // Чужие буровые вышки и факел на горизонте — далеко за границей, в дымке: не путаются с активами игрока.
    const rigs: Array<[number, number]> = [
      [-19, -7],
      [47, -19],
      [-30, 14],
    ];
    for (const [x, y] of rigs) {
      const sp = bakeSprite((p) => derrick(p), { texture: grime, strength: 0.3 }, 1);
      this.landmarks.push({ x, y, sprite: tint(sp, x, y), order: x + y });
    }
    const fx = 33;
    const fy = -24;
    const flare = bakeSprite((p) => flareStack(p), { texture: grime, strength: 0.3 }, 1);
    this.landmarks.push({ x: fx, y: fy, sprite: tint(flare, fx, fy), order: fx + fy, flare: [fx + 0.5, fy + 0.5, 2.9] });
    // ЛЭП вдоль региональной дороги за картой.
    const pylon = bakeSprite((p) => pylonModel(p), undefined, 1);
    for (let x = -56; x <= n + 60; x += 6) {
      const y = -13.5;
      const haze = hazeAt(s, x, y);
      this.pylons.push({ x, y, haze });
      this.landmarks.push({ x, y, sprite: hazed(pylon, haze), order: x + y });
    }
    this.landmarks.sort((a, b) => a.order - b.order);
  }

  /** Ориентиры и провода ЛЭП: все стоят позади или далеко сбоку от карты, поэтому рисуются до объектов игрока. */
  drawLandmarks(ctx: CanvasRenderingContext2D, view: { x0: number; x1: number; y0: number; y1: number }, ratio: number, mip: (c: HTMLCanvasElement, r: number) => HTMLCanvasElement): void {
    for (const l of this.landmarks) {
      const x = isoX(l.x, l.y) + l.sprite.ox;
      const y = isoY(l.x, l.y) + l.sprite.oy;
      if (x > view.x1 || x + l.sprite.w < view.x0 || y > view.y1 || y + l.sprite.h < view.y0) continue;
      ctx.drawImage(mip(l.sprite.canvas, (ratio * l.sprite.w) / l.sprite.canvas.width), x, y, l.sprite.w, l.sprite.h);
    }
    // Провисающие провода между опорами.
    ctx.lineWidth = 0.6;
    for (let i = 0; i + 1 < this.pylons.length; i++) {
      const a = this.pylons[i];
      const b = this.pylons[i + 1];
      ctx.strokeStyle = `rgba(40,44,48,${(0.7 * (1 - Math.max(a.haze, b.haze))).toFixed(3)})`;
      for (const [t, z] of [[-0.32, 1.72], [0.32, 1.72], [0, 1.95]] as const) {
        const ax = isoX(a.x + 0.5 + t * 0.7, a.y + 0.5 + t * 0.7);
        const ay = isoY(a.x + 0.5 + t * 0.7, a.y + 0.5 + t * 0.7) - z * 39.2;
        const bx = isoX(b.x + 0.5 + t * 0.7, b.y + 0.5 + t * 0.7);
        const by = isoY(b.x + 0.5 + t * 0.7, b.y + 0.5 + t * 0.7) - z * 39.2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 + 9, bx, by);
        ctx.stroke();
      }
    }
  }

  /** Пламя факела (рисуется в проходе ночного/аддитивного света и днём). */
  flarePoints(): V3[] {
    return this.landmarks.filter((l) => l.flare).map((l) => l.flare!);
  }

  flareHaze(): number {
    const f = this.landmarks.find((l) => l.flare);
    return f ? hazeAt(this.s, f.x, f.y) : 1;
  }
}

/** Копия спрайта, растворённая в дымке. */
function hazed(src: Sprite, haze: number): Sprite {
  const canvas = createCanvas(src.canvas.width, src.canvas.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(src.canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = `rgba(${HAZE_RGB.join(',')},${Math.min(0.95, haze).toFixed(3)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { ...src, canvas };
}

/** Буровая вышка: решётчатая башня, кронблок, основание. */
function derrick(p: ModelPainter): void {
  const steel = mat([150, 120, 70], 0.2, 14);
  p.box(0.1, 0.1, 0, 0.9, 0.9, 0.25, M.steelDark);
  const H = 3.4;
  const base = [[0.22, 0.22], [0.78, 0.22], [0.78, 0.78], [0.22, 0.78]];
  const top = base.map(([x, y]) => [0.5 + (x - 0.5) * 0.22, 0.5 + (y - 0.5) * 0.22]);
  const order = [0, 1, 3, 2];
  for (const i of order) p.tube([base[i][0], base[i][1], 0.25], [top[i][0], top[i][1], H], 0.025, steel, 6);
  for (let k = 1; k < 7; k++) {
    const t = k / 7;
    const z = 0.25 + (H - 0.25) * t;
    const ring = base.map(([x, y], i) => [x + (top[i][0] - x) * t, y + (top[i][1] - y) * t, z] as V3);
    for (let i = 0; i < 4; i++) p.wire(ring[i], ring[(i + 1) % 4], 0.6, 'rgba(120,96,56,0.9)');
  }
  p.box(0.4, 0.4, H, 0.6, 0.6, H + 0.15, M.steelDark);
  p.box(0.62, 0.15, 0.25, 0.95, 0.45, 0.55, M.red);
}

/** Факельная установка: высокая тонкая труба на растяжках. */
function flareStack(p: ModelPainter): void {
  p.box(0.3, 0.3, 0, 0.7, 0.7, 0.1, M.concrete);
  p.tube([0.5, 0.5, 0.1], [0.5, 0.5, 2.8], 0.05, mat([170, 60, 50], 0.25, 14), 8);
  p.tube([0.5, 0.5, 2.6], [0.5, 0.5, 2.85], 0.07, M.steelDark, 8);
  for (const [x, y] of [[-0.6, 0.5], [1.6, 0.5], [0.5, -0.6]]) p.wire([0.5, 0.5, 2.2], [x, y, 0], 0.4, 'rgba(60,60,60,0.7)');
}

/** Опора ЛЭП: решётчатая стойка с траверсами. */
function pylonModel(p: ModelPainter): void {
  const steel = mat([120, 124, 126], 0.3, 18);
  const H = 2.0;
  const feet: Array<[number, number]> = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];
  for (const [x, y] of feet) p.tube([x, y, 0], [0.5 + (x - 0.5) * 0.2, 0.5 + (y - 0.5) * 0.2, H], 0.014, steel, 5);
  for (const z of [0.5, 1.0, 1.4]) {
    const t = z / H;
    const ring = feet.map(([x, y]) => [x + (0.5 + (x - 0.5) * 0.2 - x) * t, y + (0.5 + (y - 0.5) * 0.2 - y) * t, z] as V3);
    for (let i = 0; i < 4; i++) p.wire(ring[i], ring[(i + 1) % 4], 0.45, 'rgba(100,104,108,0.95)');
  }
  // Траверса поперёк линии (линия идёт вдоль x, траверса — вдоль диагонали t).
  p.tube([0.5 - 0.32 * 0.7, 0.5 - 0.32 * 0.7, 1.72], [0.5 + 0.32 * 0.7, 0.5 + 0.32 * 0.7, 1.72], 0.018, steel, 5);
  p.tube([0.5, 0.5, H], [0.5, 0.5, 1.95], 0.012, steel, 5);
}

