import { HQ_POS, type Building, type GameState } from '../core';
import { makeGroundMaterial, TEX_PATTERN } from './terrain';

const R2 = Math.SQRT1_2;
/** Устье скважины относительно угла клетки качалки (выкидная линия выходит назад-влево). */
const WELLHEAD: [number, number] = [0.5 + (-0.5 - 0.27) * R2, 0.5 + (-0.27 + 0.5) * R2];
const SIDES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Кратчайший путь по клеткам без зданий (кроме начала) от from к goal; null — пути нет. */
function roadPath(n: number, blocked: Uint8Array, from: number, goal: number): number[] | null {
  const prev = new Int32Array(n * n).fill(-2);
  prev[from] = -1;
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    if (i === goal) {
      const out: number[] = [];
      for (let t = i; t >= 0; t = prev[t]) out.push(t);
      return out.reverse();
    }
    const x = i % n;
    const y = (i - x) / n;
    for (const [dx, dy] of SIDES) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (prev[j] !== -2 || (blocked[j] && j !== goal)) continue;
      prev[j] = i;
      queue.push(j);
    }
  }
  return null;
}

/** Убирает промежуточные точки на прямых участках ломаной. */
function simplify(pts: Array<[number, number]>): Array<[number, number]> {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = out[out.length - 1];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[i + 1];
    if (Math.abs((bx - ax) * (cy - by) - (by - ay) * (cx - bx)) > 1e-6) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Наземная инфраструктура: площадки под зданиями, трубопроводы (из состояния карты — это действующая сеть)
 * и подъездные дороги (выводятся из расположения зданий, чисто визуальные — на правила не влияют).
 * Все функции рисуют в координатах клеток (контекст уже в проекции земли).
 */
export class GroundDecals {
  private gravel: CanvasPattern;
  private concrete: CanvasPattern;
  private routesKey = '';
  private roads: Array<Array<[number, number]>> = [];

  constructor(ctx: CanvasRenderingContext2D) {
    const scale = new DOMMatrix().scale(1 / TEX_PATTERN, 1 / TEX_PATTERN);
    this.gravel = ctx.createPattern(makeGroundMaterial('gravel', 5), 'repeat')!;
    this.gravel.setTransform(scale);
    this.concrete = ctx.createPattern(makeGroundMaterial('concrete', 9), 'repeat')!;
    this.concrete.setTransform(scale);
  }

  /**
   * Подпись содержимого прямоугольника в клетках: трубы (тип по клеткам) и проходящие дороги.
   * Часть ключа кеша земли — ячейка перепекается, только если здесь что-то поменялось.
   */
  routesSignature(s: GameState, x0: number, y0: number, x1: number, y1: number): string {
    this.updateRoutes(s);
    const n = s.map.size;
    let pipes = '';
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) pipes += s.map.pipes[y * n + x];
    const hits = (route: Array<[number, number]>) =>
      route.some(([ax, ay], i) => {
        if (i === 0) return false;
        const [bx, by] = route[i - 1];
        return Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1;
      });
    const roads = this.roads
      .filter(hits)
      .map((r) => r.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(';'))
      .join('|');
    return `${pipes}|${roads}`;
  }

  /**
   * Дороги пересчитываются, только когда меняется набор зданий. Подъездная дорога идёт с «большой земли»
   * к конторе, к каждому терминалу — ответвление в обход зданий (поиск пути по клеткам), чтобы бензовозы
   * не проезжали сквозь объекты. Трубы дорогам не мешают: трубопровод на опорах пересекается переездом.
   */
  private updateRoutes(s: GameState): void {
    const key = s.buildings.map((b) => `${b.id}:${b.type}:${b.x}:${b.y}`).join('|');
    if (key === this.routesKey) return;
    this.routesKey = key;
    const n = s.map.size;
    const hq = s.buildings.find((b) => b.type === 'hq');
    const hx = hq ? hq.x : HQ_POS.x;
    const hy = hq ? hq.y : HQ_POS.y;
    const front: [number, number] = [hx + 0.42, hy + 1.1];
    this.roads = [[[-1, hy + 1.1], front]];
    const blocked = new Uint8Array(n * n);
    for (const b of s.buildings) blocked[b.y * n + b.x] = 1;
    const goal = (hy + 1) * n + hx;
    for (const b of s.buildings) {
      if (b.type !== 'terminal') continue;
      const path = roadPath(n, blocked, b.y * n + b.x, goal);
      if (!path) continue;
      const pts: Array<[number, number]> = [[b.x + 0.5, b.y + 0.72]];
      for (let k = 1; k < path.length - 1; k++) pts.push([(path[k] % n) + 0.5, Math.floor(path[k] / n) + 0.72]);
      pts.push([front[0], front[1]]);
      this.roads.push(simplify(pts));
    }
  }

  drawRoads(ctx: CanvasRenderingContext2D, s: GameState): void {
    this.updateRoutes(s);
    this.strokeRoads(ctx, this.roads);
  }

  /** Гравийная дорога по ломаным (в клетках): обочина, полотно, колеи. Общая для карты и окружения. */
  strokeRoads(ctx: CanvasRenderingContext2D, roads: Array<Array<[number, number]>>, width = 1): void {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const stroke = (style: string | CanvasPattern, w0: number) => {
      const w = w0 * width;
      for (const road of roads) {
        ctx.beginPath();
        road.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.strokeStyle = style;
        ctx.lineWidth = w;
        ctx.stroke();
      }
    };
    // Обочина, гравийное полотно, накатанные колеи и светлая середина.
    stroke('rgba(96,78,56,0.28)', 0.66);
    stroke(this.gravel, 0.5);
    stroke('rgba(80,68,54,0.18)', 0.34);
    stroke(this.gravel, 0.24);
    stroke('rgba(214,200,170,0.12)', 0.1);
  }

  /** Площадка под зданием: гравий у скважин и резервуаров, бетон у терминала и конторы. */
  drawPad(ctx: CanvasRenderingContext2D, b: Building): void {
    const { x, y } = b;
    ctx.save();
    if (b.type === 'pumpjack') {
      ctx.translate(x + 0.5, y + 0.5);
      ctx.rotate(-Math.PI / 4);
      this.roundRect(ctx, -0.74, -0.33, 1.48, 0.66, 0.12);
      ctx.fillStyle = this.gravel;
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,50,38,0.4)';
      ctx.lineWidth = 0.03;
      ctx.stroke();
      // Подтёки у устья.
      const g = ctx.createRadialGradient(-0.5, 0, 0, -0.5, 0, 0.22);
      g.addColorStop(0, 'rgba(16,12,10,0.75)');
      g.addColorStop(1, 'rgba(16,12,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(-0.5, 0, 0.24, 0.18, 0.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (b.type === 'tank') {
      this.roundRect(ctx, x + 0.03, y + 0.03, 0.94, 0.94, 0.08);
      ctx.fillStyle = this.gravel;
      ctx.fill();
      // Обвалование — земляной вал вокруг резервуара.
      ctx.strokeStyle = 'rgba(96,82,60,0.9)';
      ctx.lineWidth = 0.06;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(190,176,140,0.45)';
      ctx.lineWidth = 0.015;
      this.roundRect(ctx, x + 0.065, y + 0.065, 0.87, 0.87, 0.06);
      ctx.stroke();
    } else {
      this.roundRect(ctx, x + 0.02, y + 0.02, 0.96, 0.96, 0.04);
      ctx.fillStyle = this.concrete;
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,70,66,0.5)';
      ctx.lineWidth = 0.02;
      ctx.stroke();
      if (b.type === 'terminal') {
        ctx.strokeStyle = 'rgba(214,170,40,0.85)';
        ctx.lineWidth = 0.025;
        ctx.setLineDash([0.08, 0.06]);
        for (const ly of [0.52, 0.92]) {
          ctx.beginPath();
          ctx.moveTo(x + 0.04, y + ly);
          ctx.lineTo(x + 0.96, y + ly);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        const g = ctx.createRadialGradient(x + 0.45, y + 0.72, 0, x + 0.45, y + 0.72, 0.25);
        g.addColorStop(0, 'rgba(30,24,20,0.35)');
        g.addColorStop(1, 'rgba(30,24,20,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y + 0.45, 1, 0.5);
      } else {
        ctx.strokeStyle = 'rgba(90,88,82,0.35)';
        ctx.lineWidth = 0.01;
        for (let i = 1; i < 5; i++) {
          ctx.beginPath();
          ctx.moveTo(x + 0.02 + i * 0.19, y + 0.02);
          ctx.lineTo(x + 0.02 + i * 0.19, y + 0.98);
          ctx.moveTo(x + 0.02, y + 0.02 + i * 0.19);
          ctx.lineTo(x + 0.98, y + 0.02 + i * 0.19);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /**
   * Трубопроводы на опорах по клеткам с трубами в прямоугольнике (в клетках): каждая клетка рисует половинки
   * отрезков к соседним трубам и отводы к примыкающим зданиям; одиночная клетка — заглушённый патрубок.
   * Магистраль толще промысловой трубы. Тень, тело трубы и блик со стороны солнца.
   */
  drawPipes(ctx: CanvasRenderingContext2D, s: GameState, x0: number, y0: number, x1: number, y1: number): void {
    const n = s.map.size;
    const segs: Array<[number, number, number, number, number]> = [];
    const flanges: Array<[number, number, number]> = [];
    const byTile = new Map<number, Building>();
    for (const b of s.buildings) byTile.set(b.y * n + b.x, b);
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) {
        const kind = s.map.pipes[y * n + x];
        if (!kind) continue;
        const cx = x + 0.5;
        const cy = y + 0.5;
        let links = 0;
        for (const [dx, dy] of SIDES) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          const ex = cx + dx * 0.5;
          const ey = cy + dy * 0.5;
          const b = byTile.get(j);
          if (b) {
            links++;
            segs.push([cx, cy, ex, ey, kind]);
            if (b.type === 'pumpjack') {
              // Отвод к устью скважины.
              segs.push([ex, ey, b.x + WELLHEAD[0], b.y + WELLHEAD[1], 1]);
            } else {
              segs.push([ex, ey, ex + dx * 0.16, ey + dy * 0.16, kind]);
              flanges.push([ex + dx * 0.16, ey + dy * 0.16, kind]);
            }
          } else if (s.map.pipes[j]) {
            links++;
            segs.push([cx, cy, ex, ey, kind]);
          }
        }
        if (links === 0) {
          segs.push([cx - 0.3, cy, cx + 0.3, cy, kind]);
          flanges.push([cx - 0.3, cy, kind], [cx + 0.3, cy, kind]);
        } else if (links === 1) flanges.push([cx, cy, kind]); // конец линии — заглушка
      }
    }
    if (!segs.length) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Шпалы-опоры поперёк трубы.
    ctx.fillStyle = 'rgba(70,60,48,0.8)';
    for (const [ax, ay, bx, by, kind] of segs) {
      const len = Math.hypot(bx - ax, by - ay);
      const w = kind === 2 ? 0.09 : 0.06;
      for (let d = 0.175; d < len; d += 0.35) {
        const px = ax + ((bx - ax) * d) / len;
        const py = ay + ((by - ay) * d) / len;
        if (Math.abs(bx - ax) > Math.abs(by - ay)) ctx.fillRect(px - 0.012, py - w, 0.024, w * 2);
        else ctx.fillRect(px - w, py - 0.012, w * 2, 0.024);
      }
    }
    const pass = (style: string, w: number, dx: number, dy: number) => {
      ctx.strokeStyle = style;
      for (const kind of [1, 2]) {
        ctx.lineWidth = w * (kind === 2 ? 1.7 : 1);
        ctx.beginPath();
        for (const [ax, ay, bx, by, k] of segs) {
          if (k !== kind) continue;
          ctx.moveTo(ax + dx, ay + dy);
          ctx.lineTo(bx + dx, by + dy);
        }
        ctx.stroke();
      }
    };
    pass('rgba(30,24,16,0.4)', 0.07, 0.03, -0.06);
    pass('#3f454b', 0.064, 0, 0);
    pass('#6d757c', 0.04, -0.004, 0.008);
    pass('rgba(190,198,204,0.55)', 0.01, -0.01, 0.018);
    // Фланцы и заглушки.
    for (const [fx, fy, kind] of flanges) {
      const r = kind === 2 ? 0.075 : 0.05;
      ctx.fillStyle = '#353a40';
      ctx.beginPath();
      ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(190,198,204,0.5)';
      ctx.beginPath();
      ctx.arc(fx - r * 0.2, fy + r * 0.25, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
