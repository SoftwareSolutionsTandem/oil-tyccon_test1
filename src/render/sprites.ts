import { isoX, isoY } from './iso';

type Ctx = CanvasRenderingContext2D;

/** Затемняет/осветляет цвет #rrggbb в f раз. */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/**
 * Параллелепипед в клеточных координатах: основание [x, x+sx] × [y, y+sy], высота h пикселей,
 * поднятый над землёй на z пикселей. Рисуются три видимые грани.
 */
export function block(ctx: Ctx, x: number, y: number, sx: number, sy: number, h: number, color: string, z = 0): void {
  const p = (tx: number, ty: number, lift: number) => [isoX(tx, ty), isoY(tx, ty) - lift] as const;
  const quad = (pts: ReadonlyArray<readonly [number, number]>, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  };
  const top = z + h;
  // Левая передняя грань (вдоль оси x на дальнем y).
  quad([p(x, y + sy, z), p(x + sx, y + sy, z), p(x + sx, y + sy, top), p(x, y + sy, top)], shade(color, 0.78));
  // Правая передняя грань (вдоль оси y на дальнем x).
  quad([p(x + sx, y, z), p(x + sx, y + sy, z), p(x + sx, y + sy, top), p(x + sx, y, top)], shade(color, 0.6));
  // Крыша.
  quad([p(x, y, top), p(x + sx, y, top), p(x + sx, y + sy, top), p(x, y + sy, top)], shade(color, 1.05));
}

export function diamond(ctx: Ctx, x: number, y: number, inset = 0): void {
  ctx.beginPath();
  ctx.moveTo(isoX(x + inset, y + inset), isoY(x + inset, y + inset));
  ctx.lineTo(isoX(x + 1 - inset, y + inset), isoY(x + 1 - inset, y + inset));
  ctx.lineTo(isoX(x + 1 - inset, y + 1 - inset), isoY(x + 1 - inset, y + 1 - inset));
  ctx.lineTo(isoX(x + inset, y + 1 - inset), isoY(x + inset, y + 1 - inset));
  ctx.closePath();
}

const PUMP_COLORS = ['#4f6d8a', '#d9822b', '#b8322a'];

/** Станок-качалка. phase — фаза качания (радианы). */
export function drawPumpjack(ctx: Ctx, tx: number, ty: number, level: number, phase: number): void {
  block(ctx, tx + 0.18, ty + 0.18, 0.64, 0.64, 3, '#8d939b');
  const cx = isoX(tx + 0.5, ty + 0.5);
  const cy = isoY(tx + 0.5, ty + 0.5) - 3;
  const color = PUMP_COLORS[level - 1] ?? PUMP_COLORS[0];
  const pivot = { x: cx + 2, y: cy - 26 - level * 3 };
  const a = Math.sin(phase) * 0.3;
  const headLen = 20 + level * 2;
  const tailLen = 13;
  const head = { x: pivot.x - headLen * Math.cos(a), y: pivot.y + headLen * Math.sin(a) };
  const tail = { x: pivot.x + tailLen * Math.cos(a), y: pivot.y - tailLen * Math.sin(a) };
  const crank = { x: cx + 15, y: cy - 7 };
  const weight = { x: crank.x + Math.cos(phase - Math.PI / 2) * 6, y: crank.y + Math.sin(phase - Math.PI / 2) * 6 };

  ctx.lineCap = 'round';
  // Устье скважины и шток.
  const rodX = head.x - 7;
  block(ctx, tx + 0.12, ty + 0.42, 0.14, 0.14, 7, '#555b63');
  ctx.strokeStyle = '#c9ccd0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(rodX, head.y + 3);
  ctx.lineTo(isoX(tx + 0.19, ty + 0.49), isoY(tx + 0.19, ty + 0.49) - 7);
  ctx.stroke();
  // Стойка (А-образная рама).
  ctx.strokeStyle = shade(color, 0.6);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy + 3);
  ctx.lineTo(pivot.x, pivot.y);
  ctx.lineTo(cx + 9, cy + 4);
  ctx.stroke();
  // Редуктор и противовес.
  block(ctx, tx + 0.58, ty + 0.36, 0.2, 0.2, 9, '#3c4148');
  ctx.strokeStyle = '#2b2f35';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(weight.x, weight.y);
  ctx.stroke();
  ctx.fillStyle = '#2b2f35';
  ctx.beginPath();
  ctx.arc(weight.x, weight.y, 5, 0, Math.PI * 2);
  ctx.fill();
  // Балансир.
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(tail.x, tail.y);
  ctx.stroke();
  // «Голова лошади».
  ctx.fillStyle = shade(color, 0.85);
  ctx.beginPath();
  ctx.arc(head.x, head.y, 7, Math.PI / 2 - a, (3 * Math.PI) / 2 - a);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e8e2d0';
  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y, 2, 0, Math.PI * 2);
  ctx.fill();
}

/** Резервуар. fill — доля заполнения хранилища 0..1. */
export function drawTank(ctx: Ctx, tx: number, ty: number, level: number, fill: number): void {
  const cx = isoX(tx + 0.5, ty + 0.5);
  const cy = isoY(tx + 0.5, ty + 0.5);
  const r = 15 + level * 3;
  const ry = r / 2;
  const h = 16 + level * 9;
  // Тень-основание.
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx + 3, cy + 2, r + 3, ry + 2, 0, 0, Math.PI * 2);
  ctx.fill();
  const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
  grad.addColorStop(0, '#f1f3f5');
  grad.addColorStop(0.45, '#d5dade');
  grad.addColorStop(1, '#8e979f');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - h);
  ctx.lineTo(cx - r, cy);
  ctx.ellipse(cx, cy, r, ry, 0, Math.PI, 0, true);
  ctx.lineTo(cx + r, cy - h);
  ctx.ellipse(cx, cy - h, r, ry, 0, 0, Math.PI, false);
  ctx.fill();
  // Пояса.
  ctx.strokeStyle = 'rgba(70,80,90,0.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy - (h * i) / 3, r, ry, 0, 0, Math.PI);
    ctx.stroke();
  }
  // Крыша.
  ctx.fillStyle = '#e9ecef';
  ctx.beginPath();
  ctx.ellipse(cx, cy - h, r, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#aab2b9';
  ctx.stroke();
  // Указатель уровня.
  const gx = cx + r * 0.45;
  const gh = h * 0.8;
  const gy = cy + ry * 0.85 - 3;
  ctx.fillStyle = '#39424b';
  ctx.fillRect(gx - 2, gy - gh, 4, gh);
  ctx.fillStyle = fill > 0.95 ? '#e0533d' : '#1d1a17';
  ctx.fillRect(gx - 1, gy - gh * fill, 2, gh * fill);
  // Лестница.
  ctx.strokeStyle = '#6b737b';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.7, cy + ry * 0.6);
  ctx.lineTo(cx - r * 0.2, cy - h + ry * 0.9);
  ctx.stroke();
}

/** Бензовоз вдоль оси x. offset — сдвиг в клетках, alpha — прозрачность. */
export function drawTruck(ctx: Ctx, tx: number, ty: number, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  block(ctx, tx, ty, 0.42, 0.2, 9, '#cfd5da', 3);
  block(ctx, tx + 0.43, ty, 0.15, 0.2, 11, '#c0392b', 2);
  ctx.fillStyle = '#1f2327';
  for (const wx of [0.06, 0.32, 0.5]) {
    ctx.beginPath();
    ctx.arc(isoX(tx + wx, ty + 0.2), isoY(tx + wx, ty + 0.2) - 1, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Наливной терминал. truck — положение машины: null если её нет. */
export function drawTerminal(ctx: Ctx, tx: number, ty: number, level: number, truck: { dx: number; alpha: number } | null): void {
  block(ctx, tx + 0.04, ty + 0.04, 0.92, 0.92, 3, '#9aa0a6');
  // Полоса проезда.
  ctx.fillStyle = '#6d737a';
  ctx.beginPath();
  const lane = [
    [tx + 0.04, ty + 0.55],
    [tx + 0.96, ty + 0.55],
    [tx + 0.96, ty + 0.85],
    [tx + 0.04, ty + 0.85],
  ];
  ctx.moveTo(isoX(lane[0][0], lane[0][1]), isoY(lane[0][0], lane[0][1]) - 3);
  for (const [lx, ly] of lane.slice(1)) ctx.lineTo(isoX(lx, ly), isoY(lx, ly) - 3);
  ctx.fill();
  // Наливная эстакада.
  block(ctx, tx + 0.12, ty + 0.18, 0.7, 0.25, 6 + level * 3, '#7c858e', 3);
  block(ctx, tx + 0.2, ty + 0.12, 0.12, 0.12, 14 + level * 3, '#5a6169', 3);
  if (truck) drawTruck(ctx, tx + 0.2 + truck.dx, ty + 0.6, truck.alpha);
  // Навес на столбах.
  const roofZ = 26 + level * 2;
  ctx.strokeStyle = '#4a5058';
  ctx.lineWidth = 2;
  for (const [px, py] of [[tx + 0.12, ty + 0.9], [tx + 0.86, ty + 0.9]]) {
    ctx.beginPath();
    ctx.moveTo(isoX(px, py), isoY(px, py) - 3);
    ctx.lineTo(isoX(px, py), isoY(px, py) - roofZ);
    ctx.stroke();
  }
  block(ctx, tx + 0.06, ty + 0.15, 0.88, 0.8, 3, level >= 3 ? '#2e86c1' : '#e0b43a', roofZ);
}

/** Контора компании. */
export function drawHQ(ctx: Ctx, tx: number, ty: number, time: number): void {
  block(ctx, tx + 0.05, ty + 0.05, 0.9, 0.9, 3, '#a39e93');
  block(ctx, tx + 0.15, ty + 0.2, 0.7, 0.6, 24, '#e6d6b8', 3);
  block(ctx, tx + 0.1, ty + 0.15, 0.8, 0.7, 4, '#7a3b2e', 27);
  // Окна на передних гранях.
  ctx.fillStyle = '#5d8aa8';
  for (const wx of [0.3, 0.55]) {
    const x = isoX(tx + 0.15 + wx * 0.9, ty + 0.8);
    const y = isoY(tx + 0.15 + wx * 0.9, ty + 0.8);
    ctx.fillRect(x - 3, y - 18, 6, 8);
  }
  // Флаг.
  const fx = isoX(tx + 0.85, ty + 0.15);
  const fy = isoY(tx + 0.85, ty + 0.15);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(fx, fy - 50);
  ctx.stroke();
  const wave = Math.sin(time * 4) * 2;
  ctx.fillStyle = '#d4a017';
  ctx.beginPath();
  ctx.moveTo(fx, fy - 50);
  ctx.quadraticCurveTo(fx + 8, fy - 50 + wave, fx + 16, fy - 47);
  ctx.lineTo(fx + 16, fy - 39);
  ctx.quadraticCurveTo(fx + 8, fy - 42 + wave, fx, fy - 42);
  ctx.fill();
}

/** Декор: 1 — куст, 2 — камень, 3 — дерево. */
export function drawDecor(ctx: Ctx, tx: number, ty: number, kind: number, dim: boolean): void {
  const ox = ((tx * 7 + ty * 13) % 5) / 25 - 0.08;
  const cx = isoX(tx + 0.5 + ox, ty + 0.5 - ox);
  const cy = isoY(tx + 0.5 + ox, ty + 0.5 - ox);
  ctx.save();
  if (dim) ctx.globalAlpha = 0.6;
  if (kind === 2) {
    ctx.fillStyle = '#8b8a84';
    ctx.beginPath();
    ctx.ellipse(cx, cy - 3, 7, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a8a7a0';
    ctx.beginPath();
    ctx.ellipse(cx - 1.5, cy - 4.5, 4, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 3) {
    ctx.fillStyle = '#5a3e2b';
    ctx.fillRect(cx - 1.5, cy - 10, 3, 10);
    ctx.fillStyle = '#3f6b35';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 34);
    ctx.lineTo(cx + 9, cy - 9);
    ctx.lineTo(cx - 9, cy - 9);
    ctx.fill();
    ctx.fillStyle = '#4d7f41';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 34);
    ctx.lineTo(cx - 9, cy - 9);
    ctx.lineTo(cx - 2, cy - 9);
    ctx.fill();
  } else {
    ctx.fillStyle = '#5f8a46';
    for (const [dx, dy, r] of [[-4, -3, 4.5], [3, -4, 5], [0, -7, 4.5]]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
