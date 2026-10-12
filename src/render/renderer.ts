import {
  PARCEL_SIZE,
  PARCELS_PER_SIDE,
  isParcelOwned,
  storageCapacity,
  type BuildableType,
  type Building,
  type GameState,
} from '../core';
import { Camera, isoX, isoY, TH, TW } from './iso';
import { diamond, drawDecor, drawHQ, drawPumpjack, drawTank, drawTerminal, drawTruck } from './sprites';

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

const POP_TIME = 0.35;
const TRUCK_LOAD = 0.55;

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Плавный шум для пятен песка: билинейная интерполяция хеша по решётке. */
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(0, 1, x - x0);
  const fy = smoothstep(0, 1, y - y0);
  const a = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * fx;
  const b = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * fx;
  return a + (b - a) * fy;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
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

  constructor(
    private canvas: HTMLCanvasElement,
    readonly camera: Camera,
  ) {
    this.ctx = canvas.getContext('2d')!;
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

  /** Здания, существовавшие на момент загрузки, не должны «выскакивать» с анимацией. */
  adopt(s: GameState): void {
    for (const b of s.buildings) this.bornAt.set(b.id, -Infinity);
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
    this.clock += dt;
    const simDt = dt * speed;
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    bg.addColorStop(0, '#16202b');
    bg.addColorStop(1, '#253241');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const z = this.camera.zoom * this.dpr;
    ctx.setTransform(z, 0, 0, z, this.dpr * (this.width / 2) - this.camera.x * z, this.dpr * (this.height / 2) - this.camera.y * z);

    this.drawGround(s, view);
    this.drawObjects(s, view, simDt);
    this.drawFloats(dt);
  }

  private visibleRange(s: GameState) {
    // Грубое отсечение по экранному прямоугольнику с запасом на высоту зданий.
    const halfW = this.width / 2 / this.camera.zoom + TW;
    const halfH = this.height / 2 / this.camera.zoom + TH * 3;
    return {
      minX: this.camera.x - halfW,
      maxX: this.camera.x + halfW,
      minY: this.camera.y - halfH,
      maxY: this.camera.y + halfH + 60,
      size: s.map.size,
    };
  }

  private tileVisible(r: ReturnType<Renderer['visibleRange']>, x: number, y: number): boolean {
    const sx = isoX(x + 0.5, y + 0.5);
    const sy = isoY(x + 0.5, y + 0.5);
    return sx > r.minX && sx < r.maxX && sy > r.minY && sy < r.maxY;
  }

  private drawGround(s: GameState, view: ViewState): void {
    const { ctx } = this;
    const r = this.visibleRange(s);
    const size = s.map.size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!this.tileVisible(r, x, y)) continue;
        const owned = isParcelOwned(s, Math.floor(x / PARCEL_SIZE), Math.floor(y / PARCEL_SIZE));
        const n = hash(x, y);
        const sand = smoothstep(0.55, 0.75, valueNoise(x / 5, y / 5));
        const v = (0.94 + n * 0.1) * (owned ? 1 : 0.55);
        const rr = (138 + (196 - 138) * sand) * v;
        const gg = (163 + (182 - 163) * sand) * v;
        const bb = (92 + (132 - 92) * sand) * v * (owned ? 1 : 1.25);
        ctx.fillStyle = `rgb(${rr | 0},${gg | 0},${bb | 0})`;
        diamond(ctx, x, y);
        ctx.fill();
        if (owned) {
          ctx.strokeStyle = 'rgba(0,0,0,0.07)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        const i = y * size + x;
        const initial = s.map.initial[i];
        if (initial > 0) {
          const frac = s.map.reserve[i] / initial;
          const cx = isoX(x + 0.5, y + 0.5);
          const cy = isoY(x + 0.5, y + 0.5);
          ctx.fillStyle = `rgba(22,16,12,${(0.18 + 0.6 * frac) * (owned ? 1 : 0.45)})`;
          ctx.beginPath();
          ctx.ellipse(cx, cy, TW * (0.2 + 0.14 * frac), TH * (0.2 + 0.14 * frac), 0, 0, Math.PI * 2);
          ctx.fill();
          if (owned && frac > 0.05) {
            ctx.fillStyle = `rgba(120,110,160,${0.25 * frac})`;
            ctx.beginPath();
            ctx.ellipse(cx - 4, cy - 2, TW * 0.08, TH * 0.06, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    this.drawParcelBorders(s);

    if (view.highlightParcel) {
      const { px, py } = view.highlightParcel;
      const x0 = px * PARCEL_SIZE;
      const y0 = py * PARCEL_SIZE;
      ctx.beginPath();
      ctx.moveTo(isoX(x0, y0), isoY(x0, y0));
      ctx.lineTo(isoX(x0 + PARCEL_SIZE, y0), isoY(x0 + PARCEL_SIZE, y0));
      ctx.lineTo(isoX(x0 + PARCEL_SIZE, y0 + PARCEL_SIZE), isoY(x0 + PARCEL_SIZE, y0 + PARCEL_SIZE));
      ctx.lineTo(isoX(x0, y0 + PARCEL_SIZE), isoY(x0, y0 + PARCEL_SIZE));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,214,102,0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,214,102,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const selected = s.buildings.find((b) => b.id === view.selectedBuilding);
    if (selected) {
      diamond(ctx, selected.x, selected.y, 0.02);
      ctx.strokeStyle = '#5ce1e6';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (view.hover) {
      diamond(ctx, view.hover.x, view.hover.y, 0.02);
      if (view.ghost) {
        ctx.fillStyle = view.ghost.ok ? 'rgba(90,220,120,0.35)' : 'rgba(235,80,70,0.35)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private drawParcelBorders(s: GameState): void {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(255,236,170,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.moveTo(isoX(x1, y1), isoY(x1, y1));
      ctx.lineTo(isoX(x2, y2), isoY(x2, y2));
    };
    for (let py = 0; py < PARCELS_PER_SIDE; py++) {
      for (let px = 0; px < PARCELS_PER_SIDE; px++) {
        if (!isParcelOwned(s, px, py)) continue;
        const x0 = px * PARCEL_SIZE;
        const y0 = py * PARCEL_SIZE;
        const x1 = x0 + PARCEL_SIZE;
        const y1 = y0 + PARCEL_SIZE;
        if (!isParcelOwned(s, px, py - 1)) line(x0, y0, x1, y0);
        if (!isParcelOwned(s, px + 1, py)) line(x1, y0, x1, y1);
        if (!isParcelOwned(s, px, py + 1)) line(x0, y1, x1, y1);
        if (!isParcelOwned(s, px - 1, py)) line(x0, y0, x0, y1);
      }
    }
    ctx.stroke();
  }

  private drawObjects(s: GameState, view: ViewState, simDt: number): void {
    const { ctx } = this;
    const r = this.visibleRange(s);
    type Item = { order: number; draw: () => void };
    const items: Item[] = [];
    const occupied = new Set<number>();
    const fill = Math.min(1, s.oil / Math.max(1, storageCapacity(s)));

    for (const b of s.buildings) {
      occupied.add(b.y * s.map.size + b.x);
      if (!this.bornAt.has(b.id)) this.bornAt.set(b.id, this.clock);
      this.animate(b, simDt);
      if (!this.tileVisible(r, b.x, b.y)) continue;
      items.push({ order: b.x + b.y + 0.5, draw: () => this.drawBuilding(b, fill) });
    }
    for (let i = 0; i < s.map.decor.length; i++) {
      const kind = s.map.decor[i];
      if (!kind || occupied.has(i)) continue;
      const x = i % s.map.size;
      const y = Math.floor(i / s.map.size);
      if (!this.tileVisible(r, x, y)) continue;
      const owned = isParcelOwned(s, Math.floor(x / PARCEL_SIZE), Math.floor(y / PARCEL_SIZE));
      items.push({ order: x + y + 0.4, draw: () => drawDecor(ctx, x, y, kind, !owned) });
    }
    if (view.hover && view.ghost && !occupied.has(view.hover.y * s.map.size + view.hover.x)) {
      const { x, y } = view.hover;
      const type = view.ghost.type;
      items.push({
        order: x + y + 0.6,
        draw: () => {
          ctx.save();
          ctx.globalAlpha = 0.55;
          this.drawSprite(type, x, y, 1, fill, 0, null);
          ctx.restore();
        },
      });
    }
    items.sort((a, b) => a.order - b.order);
    for (const it of items) it.draw();
  }

  private animate(b: Building, simDt: number): void {
    if (b.type === 'pumpjack' && b.status === 'ok') {
      this.pumpPhase.set(b.id, (this.pumpPhase.get(b.id) ?? hash(b.x, b.y) * 6) + simDt * (2 + 0.5 * b.level));
    }
    if (b.type === 'terminal') {
      let t = this.truckT.get(b.id) ?? 0;
      const moving = t >= TRUCK_LOAD;
      if (b.status === 'ok' || moving) t += simDt * (0.22 + 0.08 * b.level);
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

  private drawBuilding(b: Building, fill: number): void {
    const { ctx } = this;
    const age = this.clock - (this.bornAt.get(b.id) ?? -Infinity);
    ctx.save();
    if (age < POP_TIME) {
      const k = age / POP_TIME;
      const scale = 0.6 + 0.4 * (1 - Math.pow(1 - k, 3)) + Math.sin(k * Math.PI) * 0.08;
      const cx = isoX(b.x + 0.5, b.y + 0.5);
      const cy = isoY(b.x + 0.5, b.y + 0.5);
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
    }
    if (!b.enabled) ctx.globalAlpha = 0.7;
    const t = this.truckT.get(b.id) ?? 0;
    const truck = t < TRUCK_LOAD ? { dx: 0, alpha: 1 } : { dx: Math.pow((t - TRUCK_LOAD) / (1 - TRUCK_LOAD), 2) * 2.2, alpha: 1 - (t - TRUCK_LOAD) / (1 - TRUCK_LOAD) };
    this.drawSprite(b.type, b.x, b.y, b.level, fill, this.pumpPhase.get(b.id) ?? 0, truck);
    if (b.type === 'hq') this.drawHqTrucks(b);
    ctx.restore();
    this.drawStatusBadge(b);
  }

  private drawSprite(
    type: Building['type'],
    x: number,
    y: number,
    level: number,
    fill: number,
    phase: number,
    truck: { dx: number; alpha: number } | null,
  ): void {
    const { ctx } = this;
    if (type === 'pumpjack') drawPumpjack(ctx, x, y, level, phase);
    else if (type === 'tank') drawTank(ctx, x, y, level, fill);
    else if (type === 'terminal') drawTerminal(ctx, x, y, level, truck);
    else drawHQ(ctx, x, y, this.clock);
  }

  private drawHqTrucks(b: Building): void {
    this.hqTrucks = this.hqTrucks.filter((start) => this.clock - start < 2.5);
    for (const start of this.hqTrucks) {
      const k = (this.clock - start) / 2.5;
      drawTruck(this.ctx, b.x + 0.9 + k * k * 3, b.y + 0.35, 1 - k);
    }
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
    const y = isoY(b.x + 0.5, b.y + 0.5) - 58 + bob;
    ctx.fillStyle = badge[1];
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
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
      const y = isoY(f.x, f.y) - 40 - k * 36;
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
