import {
  canBuild,
  pumpNeighbors,
  pumpOrientAt,
  type PumpOrient,
  drainageTiles,
  getNetwork,
  isTileOwned,
  lastFlow,
  levelSpec,
  pipeCapacity,
  PARCEL_SIZE,
  PARCELS_PER_SIDE,
  isParcelOwned,
  storageCapacity,
  type BuildableType,
  type Building,
  type GameState,
} from '../core';
import { Environment, HAZE_CSS } from './environment';
import { GroundDecals } from './ground';
import { Camera, isoX, isoY, worldToTile } from './iso';
import { proj, type ShadowShape, type Sprite } from './model';
import { mipmap, mipmapBytes, mipmapFrame } from './mipmap';
import { HQ_FLAG_TOP, HQ_WINDOWS, LIGHTS, pumpExhaust, tankDims, tankGauge, TRUCK_DUST, TRUCK_EXHAUST, TRUCK_LENGTH } from './models';
import { ParticleSystem } from './particles';
import { createCanvas, hash2 } from './noise';
import { SpriteLibrary } from './sprites';
import { makeStains, TerrainLayer, TEX_HIGH, TEX_LOW } from './terrain';
import { TerrainSource } from './terrainSource';
import { lightingAt, NOON, type Lighting } from './daylight';

export interface ViewState {
  hover: { x: number; y: number } | null;
  ghost: { type: BuildableType; ok: boolean } | null;
  selectedBuilding: number | null;
  highlightParcel: { px: number; py: number } | null;
  /** Предпросмотр протяжки трубы: клетки, допустимость, демонтаж ли это. */
  pipePlan?: { tiles: Array<[number, number]>; ok: boolean; remove: boolean } | null;
  /** Слой сети: 'full' — загрузка всех труб и точки подключения, 'selection' — сеть и маршрут выбранного. */
  network?: 'full' | 'selection' | null;
  selectedPipe?: { x: number; y: number } | null;
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
/** Ячейка кеша земли, клеток: меньше ячейка — дешевле перепекание после строительства. */
const CELL = 4;
/** Разрешение запечённой земли относительно пикселей мира: своя земля резче чужой. */
const GROUND_SCALE_HIGH = 2;
const GROUND_SCALE_LOW = 1;
/** Запас холста ячейки земли за её ромбом, пиксели мира (видимый нахлёст ячеек — 0,06 клетки). */
const CHUNK_MARGIN = 4;

interface GroundCell {
  canvas: HTMLCanvasElement;
  key: string;
  shadow: ShadowSprite | null;
}

function cellGeometry(x0: number, y0: number) {
  return {
    ox: isoX(x0, y0 + CELL) - CHUNK_MARGIN,
    oy: isoY(x0, y0) - CHUNK_MARGIN,
    w: CELL * 64 + CHUNK_MARGIN * 2,
    h: CELL * 32 + CHUNK_MARGIN * 2,
  };
}
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
  private env: Environment | null = null;
  private source: TerrainSource | null = null;
  /** Первый кадр после загрузки: видимую землю генерируем сразу, без заглушек. */
  private firstFrame = true;
  private decals: GroundDecals;
  private stains = makeStains(5, 17);
  private shadowSprites = new WeakMap<ShadowShape[], ShadowSprite>();
  private groundCache = new Map<number, GroundCell>();
  private width = 0;
  private height = 0;
  private dpr = 1;
  private clock = 0;
  private pumpPhase = new Map<number, number>();
  /** Ориентации качалок без учёта призрака (для анимации поворота) и с учётом (для отрисовки кадра). */
  private orients = new Map<number, PumpOrient>();
  private previewOrients = new Map<number, PumpOrient>();
  private guideKey = '';
  private guides: Array<[number, number, number]> = [];
  private truckT = new Map<number, number>();
  /** Направление выезда машин (обновляется раз в кадр по соседним зданиям). */
  private exitDirs = new Map<number, 1 | -1 | 0>();
  private terminalCash = new Map<number, number>();
  private bornAt = new Map<number, number>();
  private floats: FloatText[] = [];
  private hqTrucks: number[] = [];
  readonly particles = new ParticleSystem();
  /** Смена дня и ночи (настройка игрока); выключено — всегда полдень. */
  dayNight = true;
  /** Освещение последнего кадра (для интерфейса). */
  lighting: Lighting = NOON;
  /** Значки состояния рисуются после ночной цветокоррекции, чтобы не терять читаемость. */
  private pendingBadges: Building[] = [];
  private glowWarm = makeGlow([255, 214, 150]);
  private glowRed = makeGlow([255, 70, 50]);
  private glowFlame = makeGlow([255, 150, 50]);
  /** Сглаженная длительность реального кадра — по ней снижается интенсивность частиц на слабых устройствах. */
  private avgFrame = 1 / 60;
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
      this.source?.dispose();
      this.source = new TerrainSource(s.seed, s.map.size);
      this.groundCache.clear();
      this.env = new Environment(s, this.terrain, this.source, this.sprites, this.decals);
      this.firstFrame = true;
    }
    for (const b of s.buildings) this.bornAt.set(b.id, -Infinity);
    this.pumpPhase.clear();
    this.orients.clear();
    this.previewOrients.clear();
    this.truckT.clear();
  }

  /** Оценка памяти холстов по категориям, МБ (4 байта на пиксель). */
  memoryStats(): Record<string, number> {
    const mb = (canvases: Iterable<HTMLCanvasElement>) => {
      let bytes = 0;
      for (const c of canvases) bytes += c.width * c.height * 4;
      return Math.round((bytes / 1048576) * 10) / 10;
    };
    const stats: Record<string, number> = {
      terrainSource: Math.round(((this.source?.bytes() ?? 0) / 1048576) * 10) / 10,
      groundChunks: mb([...this.groundCache.values()].map((e) => e.canvas)),
      sprites: mb(this.sprites.canvases()),
      groundShadows: mb([...this.groundCache.values()].flatMap((e) => (e.shadow ? [e.shadow.canvas] : []))),
      environment: mb(this.env?.canvases() ?? []),
      mipmaps: Math.round((mipmapBytes() / 1048576) * 10) / 10,
      frame: mb([this.canvas]),
    };
    stats.total = Math.round(Object.values(stats).reduce((a, b) => a + b, 0) * 10) / 10;
    return stats;
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
    mipmapFrame();
    this.updateGroundCache(s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Фон — цвет дымки: дальняя текстура растворяется в нём без видимой границы.
    ctx.fillStyle = HAZE_CSS;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // Камера не уходит дальше нескольких клеток за край карты.
    this.camera.clampToTiles(-8, s.map.size + 8);

    const light = this.dayNight ? lightingAt(s.time) : NOON;
    this.lighting = light;
    this.applyCamera(ctx);
    const vr = this.viewRect();
    const ratio = this.camera.zoom * this.dpr;
    // Если весь экран над картой (приближение), окружение не видно — не тратим на него время.
    if (!this.viewInsideMap(s)) {
      this.env!.drawFar(ctx);
      this.env!.drawMid(ctx, vr, ratio, mipmap);
      this.env!.drawLandmarks(ctx, vr, ratio, mipmap);
    }
    this.drawGround(s, view, light);

    this.avgFrame += (dt - this.avgFrame) * 0.05;
    // Медленнее 30 и 20 кадров/с — испускаем меньше частиц.
    // При сильном отдалении частицы почти не видны — плавно перестаём их испускать.
    const zoomFade = Math.min(1, Math.max(0, (this.camera.zoom - 0.4) / 0.35));
    this.particles.quality = (this.avgFrame > 0.05 ? 0.35 : this.avgFrame > 0.034 ? 0.6 : 1) * zoomFade;
    this.updateOrients(s, view);
    for (const b of s.buildings) {
      if (!this.bornAt.has(b.id)) this.bornAt.set(b.id, this.clock);
      if (b.type === 'terminal' || b.type === 'hq') this.exitDirs.set(b.id, this.exitDir(s, b));
      this.animate(b, simDt);
    }
    this.particles.update(simDt);
    const items = this.collectItems(s, view);
    this.drawShadows(items, light);
    // Пыль у земли сортируется по глубине вместе с объектами.
    this.particles.forEachAlive(0, (i, depth) => items.push({ order: depth + 0.3, draw: () => this.particles.drawOne(ctx, i) }));
    items.sort((a, b) => a.order - b.order);
    for (const it of items) it.draw();
    this.particles.draw(ctx, 1); // дым и выхлоп поднимаются над объектами
    this.drawFlare(light);
    this.drawNight(s, light);
    for (const b of this.pendingBadges) this.drawStatusBadge(b);
    this.pendingBadges = [];

    this.drawFloats(dt);
    this.frameMs = performance.now() - t0;
  }

  /**
   * Ориентации качалок на этот кадр (выводятся из расстановки, см. pumpOrientAt). При размещении качалки
   * учитывается и призрак — видно, как развернутся соседи. Сменившая ориентацию качалка «подпрыгивает».
   */
  private updateOrients(s: GameState, view: ViewState): void {
    const n = s.map.size;
    const tiles = new Set<number>();
    for (const b of s.buildings) if (b.type === 'pumpjack') tiles.add(b.y * n + b.x);
    const ghost = view.ghost?.type === 'pumpjack' && view.ghost.ok && view.hover ? view.hover : null;
    if (ghost) tiles.add(ghost.y * n + ghost.x);
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && tiles.has(y * n + x);
    const orientAt = (x: number, y: number): PumpOrient => {
      const alongX = at(x - 1, y) || at(x + 1, y);
      const alongY = at(x, y - 1) || at(x, y + 1);
      return alongX === alongY ? 0 : alongX ? 2 : 1;
    };
    for (const b of s.buildings) {
      if (b.type !== 'pumpjack') continue;
      const o = orientAt(b.x, b.y);
      const before = this.orients.get(b.id);
      // Призрак не считается: поворот «на пробу» не запускает анимацию.
      if (before !== undefined && before !== o && !ghost) this.bornAt.set(b.id, this.clock - POP_TIME * 0.5);
      if (!ghost || before === undefined) this.orients.set(b.id, o);
      this.previewOrients.set(b.id, o);
    }
    this.previewOrients.set(-1, ghost ? orientAt(ghost.x, ghost.y) : 0);
  }

  private orientOf(b: Building): PumpOrient {
    return this.previewOrients.get(b.id) ?? 0;
  }

  private viewInsideMap(s: GameState): boolean {
    const n = s.map.size;
    const { w, h } = this.size;
    for (const [sx, sy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      const p = this.camera.screenToWorld(sx, sy, w, h);
      const t = worldToTile(p.x, p.y);
      if (t.x < 0 || t.y < 0 || t.x > n || t.y > n) return false;
    }
    return true;
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

  /**
   * Земля: запечённые в проекции ячейки 4×4 клетки, затем слой статичных теней с силой по времени суток.
   * Устаревшая ячейка показывается, пока не перепечена (не больше одной за кадр).
   */
  private drawGround(s: GameState, view: ViewState, light: Lighting): void {
    const { ctx } = this;
    const r = this.viewRect();
    const n = s.map.size;
    const cells = n / CELL;
    const visible: GroundCell[] = [];
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const g = cellGeometry(cx * CELL, cy * CELL);
        if (g.ox > r.x1 || g.ox + g.w < r.x0 || g.oy > r.y1 || g.oy + g.h < r.y0) continue;
        const cell = this.groundCache.get(cy * cells + cx);
        if (!cell) {
          // Заглушка до запекания: ромб усреднённого цвета грунта вместо дыры.
          ctx.fillStyle = '#8e8466';
          ctx.beginPath();
          ctx.moveTo(isoX(cx * CELL, cy * CELL), isoY(cx * CELL, cy * CELL));
          ctx.lineTo(isoX((cx + 1) * CELL, cy * CELL), isoY((cx + 1) * CELL, cy * CELL));
          ctx.lineTo(isoX((cx + 1) * CELL, (cy + 1) * CELL), isoY((cx + 1) * CELL, (cy + 1) * CELL));
          ctx.lineTo(isoX(cx * CELL, (cy + 1) * CELL), isoY(cx * CELL, (cy + 1) * CELL));
          ctx.fill();
          continue;
        }
        ctx.drawImage(mipmap(cell.canvas, (this.camera.zoom * this.dpr * g.w) / cell.canvas.width), g.ox, g.oy, g.w, g.h);
        visible.push(cell);
      }
    }
    // Статичные тени: у каждой ячейки — тени своих объектов (каждая тень рисуется ровно один раз).
    ctx.globalAlpha = SHADOW_ALPHA * light.shadow;
    for (const cell of visible) {
      if (cell.shadow) ctx.drawImage(cell.shadow.canvas, cell.shadow.ox, cell.shadow.oy, cell.shadow.w, cell.shadow.h);
    }
    ctx.globalAlpha = 1;

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
      // Зона тяжёлой нефти — янтарная, лёгкой — бирюзовая: сорт виден при размещении.
      const heavy = s.map.grade[zoneOf.y * n + zoneOf.x] === 1;
      for (const i of drainageTiles(s, zoneOf)) {
        const zx = i % n;
        const zy = Math.floor(i / n);
        ctx.fillStyle = heavy ? 'rgba(235,170,70,0.2)' : 'rgba(92,225,230,0.16)';
        ctx.fillRect(zx, zy, 1, 1);
        this.tileOutline(zx, zy, heavy ? 'rgba(235,170,70,0.65)' : 'rgba(92,225,230,0.55)', 0.025);
      }
    }
    if (view.network) this.drawNetworkOverlay(s, view, selected ?? null);
    if (view.pipePlan) {
      const { tiles, ok, remove } = view.pipePlan;
      const fillStyle = !ok ? 'rgba(235,80,70,0.3)' : remove ? 'rgba(240,150,60,0.35)' : 'rgba(90,220,120,0.32)';
      for (const [x, y] of tiles) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        ctx.fillStyle = fillStyle;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    if (view.ghost?.type === 'pumpjack' && view.hover) this.drawPumpGuides(s, view.hover);
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

  /**
   * Обновление кеша земли выполняется в начале кадра, до любого рисования, и в новые холсты:
   * перезапись холста, который уже нарисован в текущем кадре, заставила бы браузер дорисовать весь кадр заранее.
   * Отсутствующие видимые ячейки запекаются сразу, устаревшие — не больше одной за кадр.
   */
  private updateGroundCache(s: GameState): void {
    const r = this.viewRect();
    const cells = s.map.size / CELL;
    let rebaked = 0;
    let created = 0;
    const t0 = performance.now();
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const g = cellGeometry(cx * CELL, cy * CELL);
        if (g.ox > r.x1 || g.ox + g.w < r.x0 || g.oy > r.y1 || g.oy + g.h < r.y0) continue;
        const id = cy * cells + cx;
        const cell = this.groundCache.get(id);
        if (!this.firstFrame && (cell ? rebaked >= 1 : created >= 2)) continue; // недостающие видимые — до двух за кадр
        const key = this.cellKey(s, cx * CELL, cy * CELL);
        if (cell && cell.key === key) continue;
        const baked = this.bakeCell(s, cx * CELL, cy * CELL, key);
        if (!baked) continue; // текстура ещё в работе — остаётся прежняя ячейка или заглушка
        this.groundCache.set(id, baked);
        if (cell) rebaked++;
        else created++;
      }
    }
    // Спокойный кадр: заранее готовим то, что понадобится при перемещении и отдалении камеры —
    // невидимые ячейки карты, дальнюю текстуру и степь. Не больше одной единицы работы за кадр.
    if (rebaked + created === 0 && this.clock > 0.5) {
      let requested = 0;
      for (let id = 0; id < cells * cells && requested < 4; id++) {
        if (this.groundCache.has(id)) continue;
        const x0 = (id % cells) * CELL;
        const y0 = Math.floor(id / cells) * CELL;
        const baked = this.bakeCell(s, x0, y0, this.cellKey(s, x0, y0));
        if (baked) {
          this.groundCache.set(id, baked);
          this.firstFrame = false;
          return;
        }
        requested++; // запрос текстуры ушёл в фоновый поток
      }
      if (requested === 0) this.env?.prebake(Math.max(2, 8 - (performance.now() - t0)));
    }
    this.firstFrame = false;
  }

  /** Ключ содержимого ячейки: качество, владение, уровни пятен, здания рядом и проходящие трассы. */
  private cellKey(s: GameState, x0: number, y0: number): string {
    const n = s.map.size;
    let stains = '';
    for (let y = y0 - 1; y < y0 + CELL + 1; y++) {
      for (let x = x0 - 1; x < x0 + CELL + 1; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const i = y * n + x;
        if (s.map.initial[i] > 0) stains += Math.round((s.map.reserve[i] / s.map.initial[i]) * STAIN_LEVELS).toString(36);
      }
    }
    let owned = '';
    for (let py = Math.floor((y0 - 1) / PARCEL_SIZE); py <= Math.floor((y0 + CELL) / PARCEL_SIZE); py++)
      for (let px = Math.floor((x0 - 1) / PARCEL_SIZE); px <= Math.floor((x0 + CELL) / PARCEL_SIZE); px++) owned += isParcelOwned(s, px, py) ? '1' : '0';
    const buildings = s.buildings
      .filter((b) => b.x >= x0 - 3 && b.x < x0 + CELL + 3 && b.y >= y0 - 3 && b.y < y0 + CELL + 3)
      .map((b) => `${b.type}:${b.x}:${b.y}:${b.level}`)
      .join('|');
    const routes = this.decals.routesSignature(s, x0 - 1, y0 - 1, x0 + CELL, y0 + CELL);
    return `${owned}/${stains}/${buildings}/${routes}`;
  }

  /**
   * Запекает ячейку земли в проекции: текстура, пятна нефти, дороги, площадки, трубы, затемнение чужой земли;
   * отдельно — слой статичных теней. Ячейки перекрываются с одинаковым содержимым, поэтому швов нет.
   * Своя земля — в повышенном разрешении; у чужой исходная текстура освобождается сразу после запекания.
   */
  private bakeCell(s: GameState, x0: number, y0: number, key: string): GroundCell | null {
    const n = s.map.size;
    const owned = isParcelOwned(s, Math.floor(x0 / PARCEL_SIZE), Math.floor(y0 / PARCEL_SIZE));
    const scale = owned ? GROUND_SCALE_HIGH : GROUND_SCALE_LOW;
    const tex = owned ? TEX_HIGH : TEX_LOW;
    // Исходная текстура готовится в фоновом потоке; пока её нет, ячейку не трогаем.
    const terrain = this.source!.get(x0, y0, CELL, tex, this.firstFrame);
    if (!terrain) return null;
    const g = cellGeometry(x0, y0);
    const cw = Math.ceil(g.w * scale);
    const ch = Math.ceil(g.h * scale);
    const canvas = createCanvas(cw, ch);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(scale, 0, 0, scale, -g.ox * scale, -g.oy * scale);
    ctx.transform(...GROUND);
    const e = 0.06;
    ctx.beginPath();
    ctx.rect(Math.max(0, x0 - e), Math.max(0, y0 - e), Math.min(n, x0 + CELL + e) - Math.max(0, x0 - e), Math.min(n, y0 + CELL + e) - Math.max(0, y0 - e));
    ctx.clip();

    ctx.drawImage(terrain.image, x0 - terrain.pad, y0 - terrain.pad, CELL + terrain.pad * 2, CELL + terrain.pad * 2);
    // Исходник нужен только там, где земля может меняться: своя и соседняя с ней (площадки, трубы, тени у границы).
    if (!owned && !this.nearOwned(s, x0, y0)) this.source!.release(x0, y0, CELL, tex);

    for (let y = y0 - 1; y < y0 + CELL + 1; y++) {
      for (let x = x0 - 1; x < x0 + CELL + 1; x++) {
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
    for (const b of s.buildings) if (b.x >= x0 - 2 && b.x < x0 + CELL + 2 && b.y >= y0 - 2 && b.y < y0 + CELL + 2) this.decals.drawPad(ctx, b, b.type === 'pumpjack' ? pumpOrientAt(s, b.x, b.y) : 0);
    this.decals.drawPipes(ctx, s, x0 - 1, y0 - 1, x0 + CELL, y0 + CELL);

    const pMin = (v: number) => Math.max(0, Math.floor((v - 1) / PARCEL_SIZE));
    const pMax = (v: number) => Math.min(PARCELS_PER_SIDE - 1, Math.floor((v + CELL) / PARCEL_SIZE));
    for (let qy = pMin(y0); qy <= pMax(y0); qy++) {
      for (let qx = pMin(x0); qx <= pMax(x0); qx++) {
        if (isParcelOwned(s, qx, qy)) continue;
        ctx.globalCompositeOperation = 'saturation';
        ctx.fillStyle = 'rgba(128,128,128,0.4)';
        ctx.fillRect(qx * PARCEL_SIZE, qy * PARCEL_SIZE, PARCEL_SIZE, PARCEL_SIZE);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(16,22,32,0.24)';
        ctx.fillRect(qx * PARCEL_SIZE, qy * PARCEL_SIZE, PARCEL_SIZE, PARCEL_SIZE);
      }
    }
    return { canvas, key, shadow: this.bakeCellShadows(s, x0, y0, owned ? 1 : 0.5) };
  }

  private nearOwned(s: GameState, x0: number, y0: number): boolean {
    for (let py = Math.floor((y0 - CELL) / PARCEL_SIZE); py <= Math.floor((y0 + 2 * CELL - 1) / PARCEL_SIZE); py++)
      for (let px = Math.floor((x0 - CELL) / PARCEL_SIZE); px <= Math.floor((x0 + 2 * CELL - 1) / PARCEL_SIZE); px++)
        if (isParcelOwned(s, px, py)) return true;
    return false;
  }

  /** Тени объектов, стоящих в ячейке: непрозрачно (объединение без двойного затемнения); прозрачность — при выводе. */
  private bakeCellShadows(s: GameState, x0: number, y0: number, scale: number): ShadowSprite | null {
    const inCell = (x: number, y: number) => x >= x0 && x < x0 + CELL && y >= y0 && y < y0 + CELL;
    const casts: Array<{ shapes: ShadowShape[]; x: number; y: number }> = [];
    const occupied = new Set<number>();
    for (const b of s.buildings) {
      occupied.add(b.y * s.map.size + b.x);
      if (inCell(b.x, b.y)) for (const sp of this.buildingSprites(b)) casts.push({ shapes: sp.sprite.shadows, x: b.x + sp.dx, y: b.y });
    }
    for (let y = y0; y < y0 + CELL; y++) {
      for (let x = x0; x < x0 + CELL; x++) {
        const i = y * s.map.size + x;
        const kind = s.map.decor[i];
        if (!kind || occupied.has(i)) continue;
        casts.push({ shapes: this.sprites.decor(kind, Math.floor(hash2(x, y, 5) * 4), false).shadows, x, y });
      }
    }
    const placed = casts
      .filter((c) => c.shapes.length > 0)
      .map((c) => {
        const sh = this.shadowOf(c.shapes);
        return { sh, x: isoX(c.x, c.y) + sh.ox, y: isoY(c.x, c.y) + sh.oy };
      });
    if (placed.length === 0) return null;
    // Холст ровно по габаритам теней: меньше перерисовки пустых пикселей в каждом кадре.
    const ox = Math.floor(Math.min(...placed.map((p) => p.x)));
    const oy = Math.floor(Math.min(...placed.map((p) => p.y)));
    const w = Math.ceil(Math.max(...placed.map((p) => p.x + p.sh.w))) - ox;
    const h = Math.ceil(Math.max(...placed.map((p) => p.y + p.sh.h))) - oy;
    const canvas = createCanvas(w * scale, h * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
    for (const p of placed) ctx.drawImage(p.sh.canvas, p.x, p.y, p.sh.w, p.sh.h);
    return { canvas, ox, oy, w, h };
  }

  /**
   * Слой сети трубопроводов (в координатах клеток). Полный — при работе с трубами: загрузка каждой трубы
   * (зелёный — запас, жёлтый — почти предел, красный — узкое место), трубы без хранилища, неподключённые
   * здания и свободные точки подключения у хранилищ. Выборочный — сеть выбранной трубы или хранилища,
   * маршрут нефти выбранной качалки или терминала.
   */
  private drawNetworkOverlay(s: GameState, view: ViewState, selected: Building | null): void {
    const { ctx } = this;
    const n = s.map.size;
    const net = getNetwork(s);
    const flow = lastFlow(s);
    const pulse = 0.6 + 0.4 * Math.sin(this.clock * 5);
    const loadColor = (i: number): string => {
      const comp = net.components[net.compOfTile[i]];
      if (!comp || comp.storages.length === 0) return 'rgba(150,150,150,';
      const cap = pipeCapacity(s.map.pipes[i]);
      const u = flow && cap > 0 ? flow.demand[i] / cap : 0;
      if (u > 1.0001) return 'rgba(235,70,55,';
      if (u > 0.8) return 'rgba(240,190,60,';
      if (u > 0.005) return 'rgba(90,220,120,';
      return 'rgba(120,190,235,';
    };
    if (view.network === 'full') {
      for (let i = 0; i < n * n; i++) {
        if (!s.map.pipes[i]) continue;
        const x = i % n;
        const y = (i - x) / n;
        const c = loadColor(i);
        ctx.fillStyle = `${c}0.3)`;
        ctx.fillRect(x, y, 1, 1);
        const cap = pipeCapacity(s.map.pipes[i]);
        if (flow && flow.demand[i] > cap + 1e-4) this.tileOutline(x, y, `rgba(235,70,55,${pulse})`, 0.06);
      }
      // Свободные точки подключения: клетки своей земли рядом с хранилищами.
      for (const b of s.buildings) {
        if (b.type === 'hq' || b.type === 'tank') {
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const x = b.x + dx;
            const y = b.y + dy;
            if (x < 0 || y < 0 || x >= n || y >= n || !isTileOwned(s, x, y)) continue;
            const j = y * n + x;
            if (s.map.pipes[j] || s.buildings.some((o) => o.x === x && o.y === y)) continue;
            ctx.fillStyle = 'rgba(92,225,230,0.85)';
            ctx.beginPath();
            ctx.arc(x + 0.5 - dx * 0.35, y + 0.5 - dy * 0.35, 0.09, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (b.status === 'no_route') this.tileOutline(b.x, b.y, `rgba(235,70,55,${pulse})`, 0.07);
      }
      return;
    }
    // Выборочный слой.
    let comp = -1;
    if (view.selectedPipe) comp = net.compOfTile[view.selectedPipe.y * n + view.selectedPipe.x];
    else if (selected && (selected.type === 'hq' || selected.type === 'tank')) comp = net.compOfTile[selected.y * n + selected.x];
    if (comp >= 0) {
      for (const i of net.components[comp].pipeTiles) {
        ctx.fillStyle = `${loadColor(i)}0.28)`;
        ctx.fillRect(i % n, Math.floor(i / n), 1, 1);
      }
      for (const st of net.components[comp].storages) this.tileOutline(st.x, st.y, 'rgba(92,225,230,0.7)', 0.04);
      if (view.selectedPipe) this.tileOutline(view.selectedPipe.x, view.selectedPipe.y, 'rgba(92,225,230,0.95)', 0.05);
      return;
    }
    if (selected && (selected.type === 'pumpjack' || selected.type === 'terminal')) {
      const f = flow?.clients.get(selected.id);
      const path = f?.path ?? net.routes.get(selected.id);
      if (!path) return;
      for (const i of path) {
        ctx.fillStyle = `${loadColor(i)}0.3)`;
        ctx.fillRect(i % n, Math.floor(i / n), 1, 1);
      }
      const target = f ? s.buildings.find((b) => b.id === f.storage) : net.reach.get(selected.id)?.[0]?.storage;
      if (target) this.tileOutline(target.x, target.y, 'rgba(92,225,230,0.8)', 0.05);
      if (f && f.bottleneck >= 0) this.tileOutline(f.bottleneck % n, Math.floor(f.bottleneck / n), `rgba(235,70,55,${pulse})`, 0.07);
    }
  }

  /**
   * Ориентиры расстановки качалок вокруг курсора: точки на клетках, где качалку можно поставить;
   * у продолжения существующего ряда (сосед по стороне) — ромбик ярче. Пересчёт — только при смене клетки
   * или зданий.
   */
  private drawPumpGuides(s: GameState, hover: { x: number; y: number }): void {
    const key = `${hover.x}:${hover.y}:${s.buildings.length}:${s.nextId}:${s.unlocked.length}`;
    if (key !== this.guideKey) {
      this.guideKey = key;
      this.guides = [];
      const probe = { ...s, cash: Infinity };
      const R = 6;
      for (let y = hover.y - R; y <= hover.y + R; y++) {
        for (let x = hover.x - R; x <= hover.x + R; x++) {
          if (x < 0 || y < 0 || x >= s.map.size || y >= s.map.size) continue;
          if (Math.abs(x - hover.x) + Math.abs(y - hover.y) > R) continue;
          if (!canBuild(probe, 'pumpjack', x, y).ok) continue;
          const n = pumpNeighbors(s, x, y);
          this.guides.push([x, y, n.alongX || n.alongY ? 1 : 0]);
        }
      }
    }
    const { ctx } = this;
    for (const [x, y, row] of this.guides) {
      if (x === hover.x && y === hover.y) continue;
      ctx.fillStyle = row ? 'rgba(120,235,150,0.75)' : 'rgba(255,255,255,0.4)';
      const r = row ? 0.11 : 0.06;
      ctx.beginPath();
      ctx.moveTo(x + 0.5 - r, y + 0.5 - r);
      ctx.lineTo(x + 0.5 + r, y + 0.5 - r);
      ctx.lineTo(x + 0.5 + r, y + 0.5 + r);
      ctx.lineTo(x + 0.5 - r, y + 0.5 + r);
      ctx.fill();
    }
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
    // Граница лицензионной территории: всё, что за ней, — окружение, его нельзя купить.
    const n = s.map.size;
    ctx.beginPath();
    ctx.moveTo(isoX(0, 0), isoY(0, 0));
    ctx.lineTo(isoX(n, 0), isoY(n, 0));
    ctx.lineTo(isoX(n, n), isoY(n, n));
    ctx.lineTo(isoX(0, n), isoY(0, n));
    ctx.closePath();
    ctx.setLineDash([10, 7]);
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1.4 / Math.max(0.5, this.camera.zoom);
    ctx.stroke();
    ctx.setLineDash([]);
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
      // Уровень в резервуаре — его собственный запас (нефть хранится по месту).
      const own = b.type === 'tank' || b.type === 'hq' ? Math.min(1, (b.stored ?? 0) / Math.max(1, levelSpec(b).value)) : fill;
      items.push(this.buildingItem(b, own));
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
        this.pendingBadges.push(b);
      },
      shadows: () => {
        if (b.type === 'pumpjack') {
          // Тень кадра анимации: те же примитивы и кинематика, что и у модели.
          this.castShadow(this.sprites.pumpjack(b.level, this.pumpPhase.get(b.id) ?? hash2(b.x, b.y, 1) * 6, this.orientOf(b)).shadows, b.x, b.y);
          return;
        }
        const truck = b.type === 'terminal' ? this.truckOffset(b) : null;
        if (truck && truck.dx !== 0) this.castShadow(this.truckSprite(truck.dir).shadows, b.x + truck.dx, b.y);
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
        return [() => this.blit(lib.pumpjack(b.level, this.pumpPhase.get(b.id) ?? hash2(x, y, 1) * 6, this.orientOf(b)), x, y)];
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
            this.blit(this.truckSprite(truck.dir), x + truck.dx, y);
            this.ctx.restore();
          },
          () => this.blit(lib.terminalFront(b.level), x, y),
        ];
      }
    }
  }

  /**
   * Куда уезжает машина от здания: вдоль оси x туда, где две клетки свободны от зданий
   * (сначала вперёд, иначе назад); если заперта с обеих сторон — растворяется на месте.
   */
  private exitDir(s: GameState, b: Building): 1 | -1 | 0 {
    const free = (x: number) => x >= 0 && x < s.map.size && !s.buildings.some((o) => o.x === x && o.y === b.y);
    if (free(b.x + 1) && free(b.x + 2)) return 1;
    if (free(b.x - 1) && free(b.x - 2)) return -1;
    return 0;
  }

  private truckOffset(b: Building): { dx: number; alpha: number; dir: 1 | -1 } | null {
    const dir = this.exitDirs.get(b.id) ?? 1;
    if (b.id < 0) return { dx: 0, alpha: 1, dir: 1 };
    const t = this.truckT.get(b.id) ?? 0;
    if (t < TRUCK_LOAD) return { dx: 0, alpha: 1, dir: dir === -1 ? -1 : 1 };
    const k = (t - TRUCK_LOAD) / (1 - TRUCK_LOAD);
    if (k > 0.98) return null;
    if (dir === 0) return { dx: 0, alpha: Math.max(0, 1 - k * 3), dir: 1 };
    return { dx: dir * k * k * 2.4, alpha: Math.min(1, (1 - k) * 2.5), dir };
  }

  private truckSprite(dir: 1 | -1): Sprite {
    return dir === 1 ? this.sprites.truck() : this.sprites.truckReverse();
  }

  private hqTrucksItem(b: Building): DrawItem {
    this.hqTrucks = this.hqTrucks.filter((start) => this.clock - start < 2.5);
    const dir = this.exitDirs.get(b.id) ?? 1;
    // Грузовик перекупщика: уезжает по свободной стороне или растворяется у конторы.
    const trucks = this.hqTrucks.map((start) => {
      const k = (this.clock - start) / 2.5;
      const sprite = this.truckSprite(dir === -1 ? -1 : 1);
      const x = dir === 0 ? b.x + 0.4 : b.x + 0.4 * dir + dir * k * k * 3;
      const alpha = dir === 0 ? Math.max(0, 1 - k * 3) : Math.min(1, (1 - k) * 2.5);
      return { sprite, x, alpha };
    });
    return {
      order: b.x + b.y + 1.2,
      draw: () => {
        for (const t of trucks) {
          this.ctx.save();
          this.ctx.globalAlpha = t.alpha;
          this.blit(t.sprite, t.x, b.y + 0.35);
          this.ctx.restore();
        }
      },
      shadows: () => {
        for (const t of trucks) this.castShadow(t.sprite.shadows, t.x, b.y + 0.35);
      },
    };
  }

  /** Рисует спрайт так, чтобы начало его модели совпало с углом клетки (x, y). */
  private blit(sp: Sprite, x: number, y: number): void {
    const ratio = (this.camera.zoom * this.dpr * sp.w) / sp.canvas.width;
    this.ctx.drawImage(mipmap(sp.canvas, ratio), isoX(x, y) + sp.ox, isoY(x, y) + sp.oy, sp.w, sp.h);
  }

  private animate(b: Building, simDt: number): void {
    if (b.type === 'pumpjack' && (b.status === 'ok' || b.status === 'throttled')) {
      const before = this.pumpPhase.get(b.id) ?? hash2(b.x, b.y, 1) * 6;
      const after = before + simDt * (1.7 + 0.35 * b.level);
      this.pumpPhase.set(b.id, after);
      const ex = pumpExhaust(b.level, this.orientOf(b));
      if (ex && simDt > 0) {
        const at: [number, number, number] = [b.x + ex[0], b.y + ex[1], ex[2]];
        // Газовый двигатель: тонкий постоянный выхлоп и клуб на каждом ходе (два на оборот кривошипа).
        this.particles.emit(1, at, 1.5, simDt, { size: 1.8, alpha: 0.7 });
        if (Math.floor(after / Math.PI) !== Math.floor(before / Math.PI)) this.particles.spawn(1, at, { size: 2.4, alpha: 0.9 });
      }
    }
    if (b.type === 'hq') this.emitHqTrucks(b, simDt);
    if (b.type === 'terminal') {
      let t = this.truckT.get(b.id) ?? 0;
      const moving = t >= TRUCK_LOAD;
      if (b.status === 'ok' || b.status === 'throttled' || moving) t += simDt * (0.2 + 0.07 * b.level);
      else t = Math.min(t, TRUCK_LOAD - 0.01);
      if (t >= 1) {
        t -= 1;
        const cash = this.terminalCash.get(b.id) ?? 0;
        if (cash >= 1) this.floatText(b.x + 0.5, b.y + 0.5, `+$${formatShort(cash)}`);
        this.terminalCash.set(b.id, 0);
      }
      this.truckT.set(b.id, t);
      const truck = this.truckOffset(b);
      if (truck && simDt > 0) {
        const moving = t >= TRUCK_LOAD;
        const speed = moving ? (t - TRUCK_LOAD) / (1 - TRUCK_LOAD) : 0;
        const dust = truckPoint(TRUCK_DUST, truck.dir);
        const exhaust = truckPoint(TRUCK_EXHAUST, truck.dir);
        if (moving && truck.dx !== 0) this.particles.emit(0, [b.x + truck.dx + dust[0], b.y + dust[1], dust[2]], 10 + 40 * speed, simDt, { vx: -0.3 * truck.dir });
        if (moving || b.status === 'ok') {
          this.particles.emit(1, [b.x + truck.dx + exhaust[0], b.y + exhaust[1], exhaust[2]], moving ? 7 : 2, simDt);
        }
      }
    }
  }

  /** Пыль и выхлоп грузовиков перекупщика, уезжающих от конторы. */
  private emitHqTrucks(b: Building, simDt: number): void {
    if (simDt <= 0) return;
    const dir = this.exitDirs.get(b.id) ?? 1;
    if (dir === 0) return;
    const dust = truckPoint(TRUCK_DUST, dir);
    const exhaust = truckPoint(TRUCK_EXHAUST, dir);
    for (const start of this.hqTrucks) {
      const k = (this.clock - start) / 2.5;
      if (k < 0 || k >= 1) continue;
      const x = b.x + 0.4 * dir + dir * k * k * 3;
      const y = b.y + 0.35;
      this.particles.emit(0, [x + dust[0], y + dust[1], dust[2]], 15 + 40 * k, simDt, { vx: -0.3 * dir });
      this.particles.emit(1, [x + exhaust[0], y + exhaust[1], exhaust[2]], 7, simDt);
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
  private drawShadows(items: DrawItem[], light: Lighting): void {
    this.ctx.save();
    this.ctx.globalAlpha = SHADOW_ALPHA * light.shadow;
    for (const it of items) it.shadows?.();
    this.ctx.restore();
  }

  /** Пламя факела на горизонте: днём видно слабо, ночью — яркая точка в дымке. */
  private drawFlare(light: Lighting): void {
    if (!this.env) return;
    const { ctx } = this;
    const haze = this.env.flareHaze();
    for (const p of this.env.flarePoints()) {
      const [x, y] = proj(p);
      const flicker = 0.8 + 0.2 * Math.sin(this.clock * 13) * Math.sin(this.clock * 7.3);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - haze * 0.7) * (0.35 + 0.65 * light.night) * flicker;
      ctx.drawImage(this.glowFlame, x - 9, y - 16, 18, 22);
      ctx.restore();
    }
  }

  // ——— Время суток ———

  /**
   * Цветокоррекция кадра (multiply) и искусственный свет (additive). Днём проход пропускается целиком.
   * Значки и всплывающий текст рисуются позже — они не темнеют.
   */
  private drawNight(s: GameState, light: Lighting): void {
    const [r, g, b] = light.tint;
    const { ctx } = this;
    if (r > 0.995 && g > 0.995 && b > 0.995) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    if (light.night < 0.03) return;
    const view = this.viewRect();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = (tex: HTMLCanvasElement, p: readonly [number, number, number], rx: number, ry: number, a: number) => {
      const [x, y] = proj(p);
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) return;
      ctx.globalAlpha = a * light.night;
      ctx.drawImage(tex, x - rx, y - ry, rx * 2, ry * 2);
    };
    const at = (b: Building, p: readonly number[]): [number, number, number] => [b.x + p[0], b.y + p[1], p[2]];
    for (const b of s.buildings) {
      if (b.type === 'terminal') {
        glow(this.glowWarm, at(b, LIGHTS.terminalPool), 46, 24, 0.55);
        for (const l of LIGHTS.terminalLamps) glow(this.glowWarm, at(b, l), 9, 9, 0.9);
      } else if (b.type === 'hq') {
        ctx.fillStyle = 'rgba(255,206,120,1)';
        HQ_WINDOWS.forEach((w, i) => {
          if (hash2(b.x * 31 + i, b.y, 7) < 0.3) return; // часть окон тёмная
          ctx.globalAlpha = 0.75 * light.night;
          ctx.beginPath();
          w.quad.forEach((q, k) => {
            const [x, y] = proj(at(b, q));
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.fill();
        });
        glow(this.glowWarm, at(b, LIGHTS.hqEntrance), 18, 12, 0.7);
        glow(this.glowWarm, at(b, LIGHTS.hqSign), 22, 10, 0.5);
      } else if (b.type === 'tank') {
        // Заградительный огонь на крыше, медленно мигает.
        const { h, z0 } = tankDims(b.level);
        const blink = 0.55 + 0.45 * Math.sin(this.clock * 2.2 + b.id);
        glow(this.glowRed, [b.x + 0.5, b.y + 0.5, z0 + h + 0.12], 6, 6, blink);
      }
    }
    // Фары уезжающих бензовозов.
    for (const b of s.buildings) {
      if (b.type !== 'terminal') continue;
      const truck = this.truckOffset(b);
      if (!truck || truck.dx === 0) continue;
      const front = truck.dir === 1 ? 0.64 : TRUCK_LENGTH - 0.64;
      for (const y of [0.64, 0.76]) glow(this.glowWarm, [b.x + truck.dx + front, b.y + y, 0.12], 5, 5, 0.9 * truck.alpha);
      glow(this.glowWarm, [b.x + truck.dx + front + 0.45 * truck.dir, b.y + 0.7, 0], 26, 12, 0.4 * truck.alpha);
    }
    ctx.restore();
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
      no_route: ['⌁', '#e0533d'],
      throttled: ['≈', '#d4a017'],
      wrong_grade: ['!', '#8a5a2b'],
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

/** Точка на модели бензовоза с учётом разворота (зеркально по x относительно кузова). */
function truckPoint(p: readonly [number, number, number], dir: 1 | -1): [number, number, number] {
  return dir === 1 ? [p[0], p[1], p[2]] : [TRUCK_LENGTH - p[0], p[1], p[2]];
}

/** Мягкое световое пятно для аддитивного смешивания. */
function makeGlow(rgb: [number, number, number]): HTMLCanvasElement {
  const c = createCanvas(64, 64);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(${rgb.join(',')},1)`);
  g.addColorStop(0.25, `rgba(${rgb.join(',')},0.55)`);
  g.addColorStop(1, `rgba(${rgb.join(',')},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return c;
}
