import { HQ_POS, type Building, type GameState } from '../core';
import { makeGroundMaterial, TEX } from './terrain';

const R2 = Math.SQRT1_2;

/**
 * Наземная инфраструктура, выводимая из состояния игры: площадки под зданиями, трубопроводы
 * от скважин к хранилищам и подъездные дороги. Чисто визуальный слой — на правила не влияет.
 * Все функции рисуют в координатах клеток (контекст уже в проекции земли).
 */
export class GroundDecals {
  private gravel: CanvasPattern;
  private concrete: CanvasPattern;
  private routesKey = '';
  private pipes: Array<Array<[number, number]>> = [];
  private roads: Array<Array<[number, number]>> = [];

  constructor(ctx: CanvasRenderingContext2D) {
    const scale = new DOMMatrix().scale(1 / TEX, 1 / TEX);
    this.gravel = ctx.createPattern(makeGroundMaterial('gravel', 5), 'repeat')!;
    this.gravel.setTransform(scale);
    this.concrete = ctx.createPattern(makeGroundMaterial('concrete', 9), 'repeat')!;
    this.concrete.setTransform(scale);
  }

  /** Подпись трасс (труб и дорог), проходящих через прямоугольник в клетках: часть ключа кеша земли. */
  routesSignature(s: GameState, x0: number, y0: number, x1: number, y1: number): string {
    this.updateRoutes(s);
    const hits = (route: Array<[number, number]>) =>
      route.some(([ax, ay], i) => {
        if (i === 0) return false;
        const [bx, by] = route[i - 1];
        return Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1;
      });
    return [...this.pipes, ...this.roads]
      .filter(hits)
      .map((r) => r.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(';'))
      .join('|');
  }

  /** Пересчитывает трассы, только когда меняется набор зданий. */
  private updateRoutes(s: GameState): void {
    const key = s.buildings.map((b) => `${b.id}:${b.type}:${b.x}:${b.y}`).join('|');
    if (key === this.routesKey) return;
    this.routesKey = key;
    const storages = s.buildings.filter((b) => b.type === 'tank' || b.type === 'hq');
    this.pipes = [];
    for (const b of s.buildings) {
      if (b.type !== 'pumpjack') continue;
      // Выкидная линия выходит из устья в сторону −t (назад-влево) и идёт к ближайшему хранилищу.
      const start: [number, number] = [b.x + 0.5 + (-0.5 - 0.27) * R2, b.y + 0.5 + (-0.27 + 0.5) * R2];
      let best: Building | undefined;
      let bestD = Infinity;
      for (const t of storages) {
        const d = Math.abs(t.x - b.x) + Math.abs(t.y - b.y);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (!best) continue;
      const end: [number, number] = [best.x + 0.5, best.y + 0.85];
      this.pipes.push([start, [start[0], end[1]], end]);
    }
    const hq = s.buildings.find((b) => b.type === 'hq');
    const hx = hq ? hq.x : HQ_POS.x;
    const hy = hq ? hq.y : HQ_POS.y;
    const front: [number, number] = [hx + 0.42, hy + 1.1];
    // Подъездная дорога с «большой земли» и ответвления к терминалам.
    this.roads = [[[-1, hy + 1.1], front]];
    for (const b of s.buildings) {
      if (b.type !== 'terminal') continue;
      this.roads.push([front, [front[0], b.y + 0.72], [b.x + 0.5, b.y + 0.72]]);
    }
  }

  drawRoads(ctx: CanvasRenderingContext2D, s: GameState): void {
    this.updateRoutes(s);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const stroke = (style: string | CanvasPattern, w: number) => {
      for (const road of this.roads) {
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

  /** Трубопроводы на опорах: тень, тело трубы и блик со стороны солнца. */
  drawPipes(ctx: CanvasRenderingContext2D): void {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    const pass = (style: string, w: number, dx: number, dy: number) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      for (const p of this.pipes) {
        ctx.beginPath();
        p.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x + dx, y + dy) : ctx.lineTo(x + dx, y + dy)));
        ctx.stroke();
      }
    };
    // Шпалы-опоры.
    ctx.fillStyle = 'rgba(70,60,48,0.8)';
    for (const p of this.pipes) {
      for (let i = 0; i + 1 < p.length; i++) {
        const [ax, ay] = p[i];
        const [bx, by] = p[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.floor(len / 0.35);
        for (let k = 1; k <= n; k++) {
          const t = (k * 0.35) / len;
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          if (Math.abs(bx - ax) > Math.abs(by - ay)) ctx.fillRect(x - 0.012, y - 0.06, 0.024, 0.12);
          else ctx.fillRect(x - 0.06, y - 0.012, 0.12, 0.024);
        }
      }
    }
    pass('rgba(30,24,16,0.4)', 0.07, 0.03, -0.06);
    pass('#3f454b', 0.064, 0, 0);
    pass('#6d757c', 0.04, -0.004, 0.008);
    pass('rgba(190,198,204,0.55)', 0.01, -0.01, 0.018);
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
