import {
  drainageTiles,
  PARCEL_SIZE,
  PARCELS_PER_SIDE,
  isParcelOwned,
  storageCapacity,
  type BuildableType,
  type Building,
  type GameState,
} from '../core';
import { GroundDecals } from './ground';
import { Camera, isoX, isoY } from './iso';
import { proj, SPRITE_SCALE, ZPX, type ShadowShape, type Sprite } from './model';
import { HQ_FLAG_TOP, tankGauge } from './models';
import { createCanvas, hash2 } from './noise';
import { SpriteLibrary } from './sprites';
import { makeStains, TEX, TerrainLayer } from './terrain';

export interface ViewState {
  hover: { x: number; y: number } | null;
  ghost: { type: BuildableType; ok: boolean } | null;
  selectedBuilding: number | null;
  highlightParcel: { px: number; py: number } | null;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

interface DrawItem {
  order: number;
  draw: () => void;
  shadows?: () => void;
}

const POP_TIME = 0.35;
const TRUCK_LOAD = 0.55;
/** Матрица проекции земли: клетки → пиксели мира. */
const GROUND: [number, number, number, number, number, number] = [32, 16, -32, 16, 0, 0];
const SHADOW_ALPHA = 0.5;
/** Разрешение запечённой земли относительно пикселей мира и нахлёст кусков. */
const GROUND_SCALE = 1.5;
const CHUNK_MARGIN = 24;
/** Сколько ступеней прозрачности у пятен истощения (чтобы не перепекать землю каждый тик). */
const STAIN_LEVELS = 8;

/**
 * Рендер мира на Canvas 2D. Слои: подложка карты → земля (текстура, пятна, дороги, площадки, трубы)
 * → тени (отдельный размытый слой) → объекты по глубине → эффекты → виньетка.
 * Рендер только читает состояние игры.
 */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private sprites = new SpriteLibrary();
  private terrain: TerrainLayer | null = null;
  private decals: GroundDecals;
  private stains = makeStains(5, 17);
  private shadowLayer = createCanvas(1, 1);
  private shadowSprites = new WeakMap<ShadowShape[], ShadowSprite>();
  private groundCache = new Map<string, { canvas: HTMLCanvasElement; key: string }>();
  private width = 0;
  private height = 0;
  private dpr = 1;
  private clock = 0;
  private pumpPhase = new Map<number, number>();
  private truckT = new Map<number, number>();
  private terminalCash = new Map<number, number>();
  private bornAt = new Map<number, number>();
  private floats: FloatText[] = [];
  private hqTrucks: number[] = [];
  /** Время отрисовки последнего кадра, мс (для отладки производительности). */
  frameMs = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    readonly camera: Camera,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.decals = new GroundDecals(this.ctx);
    this.resize();
  }

  get size() {
    return { w: this.width, h: this.height };
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  /** Подготовка к новому состоянию: земля под seed карты; существующие здания появляются без анимации. */
  adopt(s: GameState): void {
    if (!this.terrain || this.terrain.seed !== s.seed) {
      this.terrain = new TerrainLayer(s.seed, s.map.size);
      this.groundCache.clear();
    }
    for (const b of s.buildings) this.bornAt.set(b.id, -Infinity);
    this.pumpPhase.clear();
    this.truckT.clear();
  }

  floatText(x: number, y: number, text: string, color = '#ffe08a'): void {
    this.floats.push({ x, y, text, color, age: 0 });
  }

  /** Выручку терминалов показываем порциями — когда очередной бензовоз уезжает. */
  addTerminalRevenue(s: GameState, amount: number): void {
    const active = s.buildings.filter((b) => b.type === 'terminal' && b.status === 'ok');
    for (const b of active) this.terminalCash.set(b.id, (this.terminalCash.get(b.id) ?? 0) + amount / active.length);
  }

  manualSale(): void {
    this.hqTrucks.push(this.clock);
  }

  draw(s: GameState, view: ViewState, dt: number, speed: number): void {
    const t0 = performance.now();
    this.clock += dt;
    if (!this.terrain || this.terrain.seed !== s.seed) this.adopt(s);
    const simDt = dt * speed;
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    bg.addColorStop(0, '#1a2430');
    bg.addColorStop(1, '#2a3540');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.applyCamera(ctx);
    this.drawSlab(s);
    this.drawGround(s, view);

    for (const b of s.buildings) {
      if (!this.bornAt.has(b.id)) this.bornAt.set(b.id, this.clock);
      this.animate(b, simDt);
    }
    const items = this.collectItems(s, view);
    this.drawShadows(items);
    items.sort((a, b) => a.order - b.order);
    for (const it of items) it.draw();

    this.drawFloats(dt);
    this.frameMs = performance.now() - t0;
  }

  private applyCamera(ctx: CanvasRenderingContext2D, k = 1): void {
    const z = this.camera.zoom * this.dpr * k;
    ctx.setTransform(z, 0, 0, z, k * this.dpr * (this.width / 2) - this.camera.x * z, k * this.dpr * (this.height / 2) - this.camera.y * z);
  }

  /** Видимая область в пикселях мира с запасом на высоту объектов. */
  private viewRect() {
    const halfW = this.width / 2 / this.camera.zoom + 80;
    const halfH = this.height / 2 / this.camera.zoom + 80;
    return { x0: this.camera.x - halfW, x1: this.camera.x + halfW, y0: this.camera.y - halfH, y1: this.camera.y + halfH + 60 };
  }

  private tileVisible(r: ReturnType<Renderer['viewRect']>, x: number, y: number): boolean {
    const sx = isoX(x + 0.5, y + 0.5);
    const sy = isoY(x + 0.5, y + 0.5);
    return sx > r.x0 && sx < r.x1 && sy > r.y0 && sy < r.y1;
  }

  /** Срез грунта по краям карты — мир выглядит как макет, а не как плоская картинка. */
  private drawSlab(s: GameState): void {
    const { ctx } = this;
    const n = s.map.size;
    const depth = 1.1 * ZPX;
    const side = (a: [number, number], b: [number, number], light: number) => {
      const [ax, ay] = proj([a[0], a[1], 0]);
      const [bx, by] = proj([b[0], b[1], 0]);
      const g = ctx.createLinearGradient(0, Math.min(ay, by), 0, Math.max(ay, by) + depth);
      g.addColorStop(0, `rgb(${92 * light},${72 * light},${50 * light})`);
      g.addColorStop(0.25, `rgb(${120 * light},${84 * light},${56 * light})`);
      g.addColorStop(0.6, `rgb(${104 * light},${92 * light},${80 * light})`);
      g.addColorStop(1, `rgb(${62 * light},${60 * light},${58 * light})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx, by + depth);
      ctx.lineTo(ax, ay + depth);
      ctx.closePath();
      ctx.fill();
    };
    side([0, n], [n, n], 0.95);
    side([n, 0], [n, n], 0.62);
  }

  private drawGround(s: GameState, view: ViewState): void {
    const { ctx } = this;
    const r = this.viewRect();
    const n = s.map.size;
    // Земля: запечённые в проекции куски по участкам. Устаревший кусок показывается, пока не перепечён (не больше одного за кадр).
    let rebaked = 0;
    for (let py = 0; py < PARCELS_PER_SIDE; py++) {
      for (let px = 0; px < PARCELS_PER_SIDE; px++) {
        const ox = isoX(px * PARCEL_SIZE, (py + 1) * PARCEL_SIZE) - CHUNK_MARGIN;
        const oy = isoY(px * PARCEL_SIZE, py * PARCEL_SIZE) - CHUNK_MARGIN;
        const w = PARCEL_SIZE * 64 + CHUNK_MARGIN * 2;
        const h = PARCEL_SIZE * 32 + CHUNK_MARGIN * 2;
        if (ox > r.x1 || ox + w < r.x0 || oy > r.y1 || oy + h < r.y0) continue;
        const id = `${px},${py}`;
        const key = this.chunkKey(s, px, py);
        let entry = this.groundCache.get(id);
        if ((!entry || entry.key !== key) && (rebaked < 1 || !entry)) {
          entry = { canvas: this.bakeGroundChunk(s, px, py, entry?.canvas), key };
          this.groundCache.set(id, entry);
          rebaked++;
        }
        ctx.drawImage(entry.canvas, ox, oy, w, h);
      }
    }

    ctx.save();
    ctx.transform(...GROUND);
    ctx.beginPath();
    ctx.rect(0, 0, n, n);
    ctx.clip();
    if (view.highlightParcel) {
      const { px, py } = view.highlightParcel;
      ctx.fillStyle = 'rgba(255,214,102,0.14)';
      ctx.fillRect(px * PARCEL_SIZE, py * PARCEL_SIZE, PARCEL_SIZE, PARCEL_SIZE);
    }
    const selected = s.buildings.find((b) => b.id === view.selectedBuilding);
    // Зона дренирования: при выборе качалки и при её размещении.
    let zoneOf: Building | null = selected?.type === 'pumpjack' ? selected : null;
    if (view.ghost?.type === 'pumpjack' && view.ghost.ok && view.hover) {
      zoneOf = { id: -1, type: 'pumpjack', x: view.hover.x, y: view.hover.y, level: 1, enabled: true, invested: 0, status: 'ok' };
    }
    if (zoneOf && s.map.initial[zoneOf.y * n + zoneOf.x] > 0) {
      for (const i of drainageTiles(s, zoneOf)) {
        const zx = i % n;
        const zy = Math.floor(i / n);
        ctx.fillStyle = 'rgba(92,225,230,0.16)';
        ctx.fillRect(zx, zy, 1, 1);
        this.tileOutline(zx, zy, 'rgba(92,225,230,0.55)', 0.025);
      }
    }
    if (selected) this.tileOutline(selected.x, selected.y, 'rgba(92,225,230,0.95)', 0.05);
    if (view.hover) {
      if (view.ghost) {
        ctx.fillStyle = view.ghost.ok ? 'rgba(90,220,120,0.3)' : 'rgba(235,80,70,0.32)';
        ctx.fillRect(view.hover.x, view.hover.y, 1, 1);
      }
      this.tileOutline(view.hover.x, view.hover.y, 'rgba(255,255,255,0.85)', 0.03);
    }
    ctx.restore();

    this.drawParcelBorders(s, view);
  }

  /** Ключ содержимого куска земли: владение, уровни пятен, набор зданий (дороги и трубы). */
  private chunkKey(s: GameState, px: number, py: number): string {
    const n = s.map.size;
    let stains = '';
    for (let y = py * PARCEL_SIZE - 1; y < (py + 1) * PARCEL_SIZE + 1; y++) {
      for (let x = px * PARCEL_SIZE - 1; x < (px + 1) * PARCEL_SIZE + 1; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const i = y * n + x;
        if (s.map.initial[i] > 0) stains += Math.round((s.map.reserve[i] / s.map.initial[i]) * STAIN_LEVELS).toString(36);
      }
    }
    let owned = '';
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) owned += isParcelOwned(s, px + dx, py + dy) ? '1' : '0';
    const x0 = px * PARCEL_SIZE;
    const y0 = py * PARCEL_SIZE;
    // Здания рядом (площадки и тени могут заходить на соседний участок) и трассы, проходящие через кусок.
    const buildings = s.buildings
      .filter((b) => b.x >= x0 - 3 && b.x < x0 + PARCEL_SIZE + 3 && b.y >= y0 - 3 && b.y < y0 + PARCEL_SIZE + 3)
      .map((b) => `${b.type}:${b.x}:${b.y}:${b.level}`)
      .join('|');
    const routes = this.decals.routesSignature(s, x0 - 1, y0 - 1, x0 + PARCEL_SIZE + 1, y0 + PARCEL_SIZE + 1);
    return `${owned}/${stains}/${buildings}/${routes}`;
  }

  /**
   * Запекает кусок земли в проекции: текстура, пятна нефти, дороги, площадки, трубы, затемнение чужой земли.
   * Кусок рисуется с небольшим нахлёстом на соседей; содержимое нахлёста у соседей совпадает, поэтому швов нет.
   */
  private bakeGroundChunk(s: GameState, px: number, py: number, reuse?: HTMLCanvasElement): HTMLCanvasElement {
    const n = s.map.size;
    const ox = isoX(px * PARCEL_SIZE, (py + 1) * PARCEL_SIZE) - CHUNK_MARGIN;
    const oy = isoY(px * PARCEL_SIZE, py * PARCEL_SIZE) - CHUNK_MARGIN;
    const w = PARCEL_SIZE * 64 + CHUNK_MARGIN * 2;
    const h = PARCEL_SIZE * 32 + CHUNK_MARGIN * 2;
    const canvas = reuse ?? createCanvas(w * GROUND_SCALE, h * GROUND_SCALE);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(GROUND_SCALE, 0, 0, GROUND_SCALE, -ox * GROUND_SCALE, -oy * GROUND_SCALE);
    ctx.transform(...GROUND);
    const x0 = px * PARCEL_SIZE;
    const y0 = py * PARCEL_SIZE;
    const e = 0.06;
    ctx.beginPath();
    ctx.rect(Math.max(0, x0 - e), Math.max(0, y0 - e), Math.min(n, x0 + PARCEL_SIZE + e) - Math.max(0, x0 - e), Math.min(n, y0 + PARCEL_SIZE + e) - Math.max(0, y0 - e));
    ctx.clip();

    const terrain = this.terrain!.bake(px, py);
    const pad = (terrain.width - PARCEL_SIZE * TEX) / 2 / TEX;
    ctx.drawImage(terrain, x0 - pad, y0 - pad, terrain.width / TEX, terrain.height / TEX);

    for (let y = y0 - 1; y < y0 + PARCEL_SIZE + 1; y++) {
      for (let x = x0 - 1; x < x0 + PARCEL_SIZE + 1; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const i = y * n + x;
        if (s.map.initial[i] <= 0) continue;
        const level = Math.round((s.map.reserve[i] / s.map.initial[i]) * STAIN_LEVELS) / STAIN_LEVELS;
        const stain = this.stains[Math.floor(hash2(x, y, 3) * this.stains.length)];
        ctx.globalAlpha = 0.12 + 0.68 * level;
        const size = 1.4 + hash2(x, y, 8) * 0.4;
        ctx.save();
        ctx.translate(x + 0.5 + (hash2(x, y, 9) - 0.5) * 0.25, y + 0.5 + (hash2(x, y, 10) - 0.5) * 0.25);
        ctx.rotate(hash2(x, y, 11) * Math.PI * 2);
        ctx.drawImage(stain, -size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    this.decals.drawRoads(ctx, s);
    for (const b of s.buildings) if (Math.abs(b.x + 0.5 - (x0 + 4)) < 6 && Math.abs(b.y + 0.5 - (y0 + 4)) < 6) this.decals.drawPad(ctx, b);
    this.decals.drawPipes(ctx);
    this.bakeChunkShadows(s, ctx, x0, y0, canvas);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= PARCELS_PER_SIDE || qy >= PARCELS_PER_SIDE || isParcelOwned(s, qx, qy)) continue;
        ctx.globalCompositeOperation = 'saturation';
        ctx.fillStyle = 'rgba(128,128,128,0.4)';
        ctx.fillRect(qx * PARCEL_SIZE, qy * PARCEL_SIZE, PARCEL_SIZE, PARCEL_SIZE);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(16,22,32,0.24)';
        ctx.fillRect(qx * PARCEL_SIZE, qy * PARCEL_SIZE, PARCEL_SIZE, PARCEL_SIZE);
      }
    }
    return canvas;
  }

  /** Статичные тени зданий и декора: сначала непрозрачно во временный слой (без двойного затемнения), затем с прозрачностью. */
  private bakeChunkShadows(s: GameState, ctx: CanvasRenderingContext2D, x0: number, y0: number, target: HTMLCanvasElement): void {
    if (this.shadowLayer.width !== target.width || this.shadowLayer.height !== target.height) {
      this.shadowLayer.width = target.width;
      this.shadowLayer.height = target.height;
    }
    const layer = this.shadowLayer;
    const lc = layer.getContext('2d')!;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, layer.width, layer.height);
    lc.setTransform(ctx.getTransform());
    lc.transform(1 / 32 / 2, -1 / 32 / 2, 1 / 16 / 2, 1 / 16 / 2, 0, 0); // обратно из клеток в пиксели мира
    const near = (x: number, y: number) => x >= x0 - 3 && x < x0 + PARCEL_SIZE + 2 && y >= y0 - 2 && y < y0 + PARCEL_SIZE + 3;
    const put = (shapes: ShadowShape[], x: number, y: number) => {
      if (shapes.length === 0) return;
      const sh = this.shadowOf(shapes);
      lc.drawImage(sh.canvas, isoX(x, y) + sh.ox, isoY(x, y) + sh.oy, sh.w, sh.h);
    };
    const occupied = new Set<number>();
    for (const b of s.buildings) {
      occupied.add(b.y * s.map.size + b.x);
      if (near(b.x, b.y)) for (const sp of this.buildingSprites(b)) put(sp.sprite.shadows, b.x + sp.dx, b.y);
    }
    for (let i = 0; i < s.map.decor.length; i++) {
      const kind = s.map.decor[i];
      const x = i % s.map.size;
      const y = Math.floor(i / s.map.size);
      if (!kind || occupied.has(i) || !near(x, y)) continue;
      put(this.sprites.decor(kind, Math.floor(hash2(x, y, 5) * 4), false).shadows, x, y);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = SHADOW_ALPHA;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  private tileOutline(x: number, y: number, color: string, w: number): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.strokeRect(x + w / 2, y + w / 2, 1 - w, 1 - w);
  }

  private drawParcelBorders(s: GameState, view: ViewState): void {
    const { ctx } = this;
    const segs: Array<[number, number, number, number]> = [];
    for (let py = 0; py < PARCELS_PER_SIDE; py++) {
      for (let px = 0; px < PARCELS_PER_SIDE; px++) {
        if (!isParcelOwned(s, px, py)) continue;
        const x0 = px * PARCEL_SIZE;
        const y0 = py * PARCEL_SIZE;
        const x1 = x0 + PARCEL_SIZE;
        const y1 = y0 + PARCEL_SIZE;
        if (!isParcelOwned(s, px, py - 1)) segs.push([x0, y0, x1, y0]);
        if (!isParcelOwned(s, px + 1, py)) segs.push([x1, y0, x1, y1]);
        if (!isParcelOwned(s, px, py + 1)) segs.push([x0, y1, x1, y1]);
        if (!isParcelOwned(s, px - 1, py)) segs.push([x0, y0, x0, y1]);
      }
    }
    const strokeSegs = (style: string, w: number) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      ctx.beginPath();
      for (const [ax, ay, bx, by] of segs) {
        ctx.moveTo(isoX(ax, ay), isoY(ax, ay));
        ctx.lineTo(isoX(bx, by), isoY(bx, by));
      }
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    strokeSegs('rgba(0,0,0,0.25)', 3.5);
    strokeSegs('rgba(255,232,160,0.75)', 1.5);
    if (view.highlightParcel) {
      const { px, py } = view.highlightParcel;
      const c = [
        [px, py],
        [px + 1, py],
        [px + 1, py + 1],
        [px, py + 1],
      ].map(([a, b]) => [a * PARCEL_SIZE, b * PARCEL_SIZE]);
      ctx.beginPath();
      c.forEach(([a, b], i) => (i === 0 ? ctx.moveTo(isoX(a, b), isoY(a, b)) : ctx.lineTo(isoX(a, b), isoY(a, b))));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,214,102,0.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ——— Объекты ———

  private collectItems(s: GameState, view: ViewState): DrawItem[] {
    const r = this.viewRect();
    const items: DrawItem[] = [];
    const occupied = new Set<number>();
    const fill = Math.min(1, s.oil / Math.max(1, storageCapacity(s)));
    for (const b of s.buildings) {
      occupied.add(b.y * s.map.size + b.x);
      if (!this.tileVisible(r, b.x, b.y)) continue;
      items.push(this.buildingItem(b, fill));
      if (b.type === 'hq') items.push(this.hqTrucksItem(b));
    }
    for (let i = 0; i < s.map.decor.length; i++) {
      const kind = s.map.decor[i];
      if (!kind || occupied.has(i)) continue;
      const x = i % s.map.size;
      const y = Math.floor(i / s.map.size);
      if (!this.tileVisible(r, x, y)) continue;
      const owned = isParcelOwned(s, Math.floor(x / PARCEL_SIZE), Math.floor(y / PARCEL_SIZE));
      const sprite = this.sprites.decor(kind, Math.floor(hash2(x, y, 5) * 4), !owned);
      items.push({
        order: x + y + 0.4,
        draw: () => this.blit(sprite, x, y),
      });
    }
    if (view.hover && view.ghost && !occupied.has(view.hover.y * s.map.size + view.hover.x)) {
      const { x, y } = view.hover;
      const ghost: Building = { id: -1, type: view.ghost.type, x, y, level: 1, enabled: true, invested: 0, status: 'ok' };
      items.push({
        order: x + y + 0.6,
        draw: () => {
          this.ctx.save();
          this.ctx.globalAlpha = 0.6;
          for (const part of this.buildingParts(ghost, fill)) part();
          this.ctx.restore();
        },
      });
    }
    return items;
  }

  private buildingItem(b: Building, fill: number): DrawItem {
    return {
      order: b.x + b.y + 0.5,
      draw: () => {
        const { ctx } = this;
        const age = this.clock - (this.bornAt.get(b.id) ?? -Infinity);
        ctx.save();
        if (age < POP_TIME) {
          const k = age / POP_TIME;
          const scale = 0.6 + 0.4 * (1 - Math.pow(1 - k, 3)) + Math.sin(k * Math.PI) * 0.06;
          const cx = isoX(b.x + 0.5, b.y + 0.5);
          const cy = isoY(b.x + 0.5, b.y + 0.5);
          ctx.translate(cx, cy);
          ctx.scale(scale, scale);
          ctx.translate(-cx, -cy);
        }
        if (!b.enabled) ctx.globalAlpha = 0.72;
        for (const part of this.buildingParts(b, fill)) part();
        ctx.restore();
        this.drawStatusBadge(b);
      },
      shadows: () => {
        if (b.type === 'pumpjack') {
          // Тень кадра анимации: те же примитивы и кинематика, что и у модели.
          this.castShadow(this.sprites.pumpjack(b.level, this.pumpPhase.get(b.id) ?? hash2(b.x, b.y, 1) * 6).shadows, b.x, b.y);
          return;
        }
        const truck = b.type === 'terminal' ? this.truckOffset(b) : null;
        if (truck && truck.dx > 0) this.castShadow(this.sprites.truck().shadows, b.x + truck.dx, b.y);
      },
    };
  }

  /** Спрайты здания для статичной тени, запекаемой в землю. */
  private buildingSprites(b: Building): Array<{ sprite: Sprite; dx: number }> {
    const lib = this.sprites;
    if (b.type === 'pumpjack') return []; // тень качалки динамическая, см. buildingItem
    if (b.type === 'tank') return [{ sprite: lib.tank(b.level), dx: 0 }];
    if (b.type === 'hq') return [{ sprite: lib.headquarters(), dx: 0 }];
    const parts = [
      { sprite: lib.terminalBack(b.level), dx: 0 },
      { sprite: lib.terminalFront(b.level), dx: 0 },
    ];
    parts.push({ sprite: lib.truck(), dx: 0 });
    return parts;
  }

  /** Части здания в порядке отрисовки. */
  private buildingParts(b: Building, fill: number): Array<() => void> {
    const lib = this.sprites;
    const { x, y } = b;
    switch (b.type) {
      case 'pumpjack':
        return [() => this.blit(lib.pumpjack(b.level, this.pumpPhase.get(b.id) ?? hash2(x, y, 1) * 6), x, y)];
      case 'tank':
        return [() => this.blit(lib.tank(b.level), x, y), () => this.drawGauge(b, fill)];
      case 'hq':
        return [() => this.blit(lib.headquarters(), x, y), () => this.drawFlag(b)];
      case 'terminal': {
        const truck = this.truckOffset(b);
        return [
          () => this.blit(lib.terminalBack(b.level), x, y),
          () => {
            if (!truck) return;
            this.ctx.save();
            this.ctx.globalAlpha *= truck.alpha;
            this.blit(lib.truck(), x + truck.dx, y);
            this.ctx.restore();
          },
          () => this.blit(lib.terminalFront(b.level), x, y),
        ];
      }
    }
  }

  private truckOffset(b: Building): { dx: number; alpha: number } | null {
    if (b.id < 0) return { dx: 0, alpha: 1 };
    const t = this.truckT.get(b.id) ?? 0;
    if (t < TRUCK_LOAD) return { dx: 0, alpha: 1 };
    const k = (t - TRUCK_LOAD) / (1 - TRUCK_LOAD);
    if (k > 0.98) return null;
    return { dx: k * k * 2.4, alpha: Math.min(1, (1 - k) * 2.5) };
  }

  private hqTrucksItem(b: Building): DrawItem {
    this.hqTrucks = this.hqTrucks.filter((start) => this.clock - start < 2.5);
    const trucks = this.hqTrucks.map((start) => (this.clock - start) / 2.5);
    return {
      order: b.x + b.y + 1.2,
      draw: () => {
        for (const k of trucks) {
          this.ctx.save();
          this.ctx.globalAlpha = Math.min(1, (1 - k) * 2.5);
          this.blit(this.sprites.truck(), b.x + 0.4 + k * k * 3, b.y + 0.35);
          this.ctx.restore();
        }
      },
      shadows: () => {
        for (const k of trucks) this.castShadow(this.sprites.truck().shadows, b.x + 0.4 + k * k * 3, b.y + 0.35);
      },
    };
  }

  /** Рисует спрайт так, чтобы начало его модели совпало с углом клетки (x, y). */
  private blit(sp: Sprite, x: number, y: number): void {
    this.ctx.drawImage(sp.canvas, isoX(x, y) + sp.ox, isoY(x, y) + sp.oy, sp.canvas.width / SPRITE_SCALE, sp.canvas.height / SPRITE_SCALE);
  }

  private animate(b: Building, simDt: number): void {
    if (b.type === 'pumpjack' && b.status === 'ok') {
      this.pumpPhase.set(b.id, (this.pumpPhase.get(b.id) ?? hash2(b.x, b.y, 1) * 6) + simDt * (1.7 + 0.35 * b.level));
    }
    if (b.type === 'terminal') {
      let t = this.truckT.get(b.id) ?? 0;
      const moving = t >= TRUCK_LOAD;
      if (b.status === 'ok' || moving) t += simDt * (0.2 + 0.07 * b.level);
      else t = Math.min(t, TRUCK_LOAD - 0.01);
      if (t >= 1) {
        t -= 1;
        const cash = this.terminalCash.get(b.id) ?? 0;
        if (cash >= 1) this.floatText(b.x + 0.5, b.y + 0.5, `+$${formatShort(cash)}`);
        this.terminalCash.set(b.id, 0);
      }
      this.truckT.set(b.id, t);
    }
  }

  // ——— Тени ———

  /** Тень объекта: заранее запечённая и размытая картинка; в кадре — одна быстрая операция drawImage. */
  private shadowOf(shapes: ShadowShape[]): ShadowSprite {
    let baked = this.shadowSprites.get(shapes);
    if (!baked) {
      baked = bakeShadow(shapes);
      this.shadowSprites.set(shapes, baked);
    }
    return baked;
  }

  private castShadow(shapes: ShadowShape[], x: number, y: number): void {
    if (shapes.length === 0) return;
    const baked = this.shadowOf(shapes);
    this.ctx.drawImage(baked.canvas, isoX(x, y) + baked.ox, isoY(x, y) + baked.oy, baked.w, baked.h);
  }

  /** Тени движущихся объектов (качалки, бензовозы) рисуются прямо поверх земли; статичные запечены в землю. */
  private drawShadows(items: DrawItem[]): void {
    this.ctx.save();
    this.ctx.globalAlpha = SHADOW_ALPHA;
    for (const it of items) it.shadows?.();
    this.ctx.restore();
  }

  // ——— Динамические детали ———

  private drawGauge(b: Building, fill: number): void {
    const g = tankGauge(b.level);
    const [bx, by] = proj([g.bottom[0] + b.x, g.bottom[1] + b.y, g.bottom[2]]);
    const [, ty] = proj([g.top[0] + b.x, g.top[1] + b.y, g.top[2]]);
    const { ctx } = this;
    ctx.fillStyle = 'rgba(40,44,48,0.9)';
    ctx.fillRect(bx - 1.3, ty, 2.6, by - ty);
    ctx.fillStyle = fill > 0.95 ? '#e0533d' : '#2a1f16';
    ctx.fillRect(bx - 0.7, by - (by - ty) * fill, 1.4, (by - ty) * fill);
  }

  private drawFlag(b: Building): void {
    const [fx, fy] = proj([HQ_FLAG_TOP[0] + b.x, HQ_FLAG_TOP[1] + b.y, HQ_FLAG_TOP[2]]);
    const { ctx } = this;
    const w = Math.sin(this.clock * 3.5);
    const g = ctx.createLinearGradient(fx, 0, fx + 15, 0);
    g.addColorStop(0, '#c99a1c');
    g.addColorStop(0.5, '#e8bd3e');
    g.addColorStop(1, '#a8800f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.bezierCurveTo(fx + 5, fy - 2 + w * 1.5, fx + 10, fy + 2 - w * 1.5, fx + 15, fy + 1);
    ctx.lineTo(fx + 15, fy + 9);
    ctx.bezierCurveTo(fx + 10, fy + 10 - w * 1.5, fx + 5, fy + 6 + w * 1.5, fx, fy + 8);
    ctx.closePath();
    ctx.fill();
  }

  private drawStatusBadge(b: Building): void {
    const badges: Partial<Record<Building['status'], [string, string]>> = {
      full: ['!', '#e0533d'],
      depleted: ['×', '#7d8590'],
      off: ['z', '#5c6b7a'],
      waiting_price: ['$', '#d4a017'],
    };
    const badge = badges[b.status];
    if (!badge) return;
    const { ctx } = this;
    const bob = Math.sin(this.clock * 3 + b.id) * 2;
    const x = isoX(b.x + 0.5, b.y + 0.5);
    const y = isoY(b.x + 0.5, b.y + 0.5) - 66 + bob;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(x + 1, y + 1.5, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = badge[1];
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badge[0], x, y + 0.5);
  }

  private drawFloats(dt: number): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 13px system-ui, sans-serif';
    for (const f of this.floats) {
      f.age += dt;
      const k = f.age / 1.8;
      const x = isoX(f.x, f.y);
      const y = isoY(f.x, f.y) - 46 - k * 36;
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 3;
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, x, y);
    }
    ctx.globalAlpha = 1;
    this.floats = this.floats.filter((f) => f.age < 1.8);
  }
}

export function formatShort(n: number): string {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2).replace('.', ',') + ' млн';
  if (Math.abs(n) >= 1e4) return Math.round(n / 1000) + ' тыс.';
  return Math.round(n).toLocaleString('ru-RU');
}

interface ShadowSprite {
  canvas: HTMLCanvasElement;
  ox: number;
  oy: number;
  w: number;
  h: number;
}

const SHADOW_SCALE = 1;
const CAST_SHADOW_DENSITY = 0.72;
const SHADOW_BLUR = 1.6;

/** Рисует фигуры тени (в клетках) в маленький холст в пикселях мира и размывает края. */
function bakeShadow(shapes: ShadowShape[]): ShadowSprite {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (u: number, v: number, r: number) => {
    const x = isoX(u, v);
    const y = isoY(u, v);
    minX = Math.min(minX, x - r * 46);
    maxX = Math.max(maxX, x + r * 46);
    minY = Math.min(minY, y - r * 23);
    maxY = Math.max(maxY, y + r * 23);
  };
  for (const sh of shapes) {
    if (sh.kind === 'poly') sh.pts.forEach(([u, v]) => grow(u, v, 0.04));
    else {
      grow(sh.a[0], sh.a[1], sh.w / 2);
      grow(sh.b[0], sh.b[1], sh.w / 2);
    }
  }
  const pad = 4;
  const ox = Math.floor(minX - pad);
  const oy = Math.floor(minY - pad);
  const w = Math.ceil(maxX + pad) - ox;
  const h = Math.ceil(maxY + pad) - oy;
  const canvas = createCanvas(w * SHADOW_SCALE, h * SHADOW_SCALE);
  const ctx = canvas.getContext('2d')!;
  if (typeof ctx.filter === 'string') ctx.filter = `blur(${SHADOW_BLUR * SHADOW_SCALE}px)`;
  ctx.setTransform(SHADOW_SCALE, 0, 0, SHADOW_SCALE, -ox * SHADOW_SCALE, -oy * SHADOW_SCALE);
  ctx.transform(...GROUND);
  ctx.fillStyle = '#1a1612';
  ctx.strokeStyle = '#1a1612';
  ctx.lineCap = 'round';
  // Падающая тень полупрозрачная, контактная — плотная: у основания объект темнее, тень дальше светлее.
  const ordered = [...shapes.filter((sh) => !sh.contact), ...shapes.filter((sh) => sh.contact)];
  for (const sh of ordered) {
    ctx.globalAlpha = sh.contact ? 1 : CAST_SHADOW_DENSITY;
    if (sh.kind === 'poly') {
      ctx.beginPath();
      sh.pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
      ctx.closePath();
      ctx.fill();
    } else if (sh.a[0] === sh.b[0] && sh.a[1] === sh.b[1]) {
      ctx.beginPath();
      ctx.arc(sh.a[0], sh.a[1], sh.w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineWidth = sh.w;
      ctx.beginPath();
      ctx.moveTo(sh.a[0], sh.a[1]);
      ctx.lineTo(sh.b[0], sh.b[1]);
      ctx.stroke();
    }
  }
  return { canvas, ox, oy, w, h };
}
