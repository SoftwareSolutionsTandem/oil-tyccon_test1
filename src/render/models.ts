import { MATERIALS as M, mat, proj, type Material, type ModelPainter, type RGB, type V3, ZPX, add, mul } from './model';

/**
 * Модели объектов в координатах клетки [0,1]² (начало — дальний угол клетки).
 * Порядок вызовов = порядок отрисовки: сначала дальние детали, потом ближние.
 */

const R2 = Math.SQRT1_2;
/**
 * Оси «профильной» системы координат: s — вдоль балансира, t — поперёк (к зрителю).
 * Ориентация качалки: 0 — балансир по горизонтали экрана (по диагонали клетки), 1 — вдоль оси x карты,
 * 2 — вдоль оси y карты. Во всех вариантах «голова» дальше от зрителя, чем двигатель, а t смотрит к зрителю,
 * поэтому порядок рисования «сначала дальние детали» сохраняется.
 */
const AXES: Record<number, [V3, V3]> = {
  0: [[R2, -R2, 0], [R2, R2, 0]],
  1: [[1, 0, 0], [0, 1, 0]],
  2: [[0, 1, 0], [1, 0, 0]],
};
let E: V3 = AXES[0][0];
let F: V3 = AXES[0][1];
const Z: V3 = [0, 0, 1];
/** Точка в профильной системе относительно центра клетки. */
const W = (s: number, t: number, z: number): V3 => [0.5 + s * E[0] + t * F[0], 0.5 + s * E[1] + t * F[1], z];

function orient(o: number): void {
  [E, F] = AXES[o] ?? AXES[0];
}

export const PUMP_PAINT: RGB[] = [
  [70, 92, 110],
  [214, 150, 38],
  [158, 40, 32],
];

/** Станок-качалка, вид сбоку с поворотом 45°: балансир идёт горизонтально по экрану. */
export function pumpjack(p: ModelPainter, level: number, phase: number, o = 0): void {
  orient(o);
  const k = [0.9, 0.98, 1.08][level - 1] ?? 0.9;
  const paint = mat(PUMP_PAINT[level - 1] ?? PUMP_PAINT[0], 0.32, 22);
  const paintDark = mat((PUMP_PAINT[level - 1] ?? PUMP_PAINT[0]).map((c) => c * 0.7) as unknown as RGB, 0.25, 18);
  const H = 0.8 * k;
  const headR = 0.5 * k;
  const tail = 0.36 * k;
  const shaftZ = 0.3 * k;
  const crankR = 0.11 * k;
  const motorS = tail + 0.25 * k;

  // Кинематика: кривошип вращается, хвост балансира следует за пальцем кривошипа.
  const a = -Math.asin(Math.max(-0.9, Math.min(0.9, (crankR * Math.sin(phase)) / tail)));
  const beamPt = (d: number, t = 0): V3 => W(d * Math.cos(a), t, H - d * Math.sin(a));
  const tailPt = (t: number) => beamPt(tail, t);
  const pin = (t: number): V3 => W(tail + crankR * Math.cos(phase), t, shaftZ + crankR * Math.sin(phase));

  // Площадка и рама.
  // Фундаментные блоки под стойкой и редуктором, стальная рама-салазки.
  p.obox(W(0, 0, 0.03), mul(E, 0.24), mul(F, 0.22), mul(Z, 0.03), M.concrete);
  p.obox(W(tail + 0.1 * k, 0, 0.03), mul(E, 0.28 * k), mul(F, 0.2), mul(Z, 0.03), M.concrete);
  for (const t of [-0.13, 0.13]) p.obox(W(0.2, t, 0.08), mul(E, 0.46), mul(F, 0.022), mul(Z, 0.02), M.steelDark);

  // Устье скважины с выкидной линией.
  const wx = -headR;
  p.tube(W(wx, -0.04, 0.16), W(wx, -0.27, 0.16), 0.022, M.galvanized, 8);
  p.tube(W(wx, -0.27, 0.16), W(wx, -0.27, 0.04), 0.022, M.galvanized, 8);
  p.cylinder(...xy(W(wx, 0, 0)), 0.06, 0.075, 0.04, M.steel);
  p.cylinder(...xy(W(wx, 0, 0)), 0.1, 0.042, 0.12, M.galvanized);
  p.tube(W(wx, -0.07, 0.19), W(wx, 0.07, 0.19), 0.02, M.galvanized, 8);
  p.tube(W(wx, 0.075, 0.19), W(wx, 0.095, 0.19), 0.035, M.red, 10);
  p.cylinder(...xy(W(wx, 0, 0)), 0.22, 0.028, 0.08, M.steel);

  // Шток и подвеска (канатная серьга).
  const carrierZ = H - 0.33 * k + headR * a;
  p.wire(W(wx, 0, 0.3), W(wx, 0, carrierZ), 1.1, '#d9dcde');
  p.obox(W(wx, 0, carrierZ), mul(E, 0.018), mul(F, 0.05), mul(Z, 0.01), M.steelDark);
  for (const t of [-0.035, 0.035]) p.wire(W(wx, t, carrierZ), W(wx, t, H), 0.6, '#2b2b2b');

  // Задние стойки, задний кривошип, задний шатун.
  samsonLegs(p, -1, H, paint);
  crank(p, -0.14, tail, shaftZ, crankR, phase, k, paintDark);
  p.tube(pin(-0.15), tailPt(-0.11), 0.016, paint, 8);

  // Редуктор, вал и двигатель.
  p.obox(W(tail, 0, 0.12), mul(E, 0.15 * k), mul(F, 0.12), mul(Z, 0.02), M.steelDark);
  p.obox(W(tail, 0, (0.14 + shaftZ + 0.06) / 2), mul(E, 0.11 * k), mul(F, 0.1), mul(Z, (shaftZ + 0.06 - 0.14) / 2), paint);
  p.tube(W(tail, -0.16, shaftZ), W(tail, 0.16, shaftZ), 0.028, M.steel, 10);
  p.obox(W(motorS, 0, 0.13), mul(E, 0.08), mul(F, 0.09), mul(Z, 0.03), M.steelDark);
  if (level === 1) {
    // Старые станки — с газовым двигателем: блок цилиндров и выхлопная труба.
    p.obox(W(motorS, 0, 0.23), mul(E, 0.07), mul(F, 0.08), mul(Z, 0.07), mat([92, 86, 72], 0.25, 16));
    const ex = pumpExhaust(level, o)!;
    orient(o);
    p.tube([ex[0], ex[1], 0.28], ex, 0.013, M.steelDark, 6);
  } else {
    p.tube(W(motorS, -0.08, 0.23), W(motorS, 0.08, 0.23), 0.06, mat([84, 96, 104], 0.3, 20), 14);
  }

  // Балансир, «голова лошади», траверса и опорный подшипник.
  p.obox(W(0, 0, H - 0.04), mul(E, 0.05), mul(F, 0.05), mul(Z, 0.03), M.steelDark);
  const half = (tail + headR * 0.85) / 2;
  const centerD = (tail - headR * 0.85) / 2;
  const along: V3 = add(mul(E, Math.cos(a)), mul(Z, -Math.sin(a)));
  const up: V3 = add(mul(E, Math.sin(a)), mul(Z, Math.cos(a)));
  p.obox(beamPt(centerD), mul(along, half), mul(F, 0.034), mul(up, 0.036), paint);
  p.obox(add(tailPt(0), mul(up, -0.045)), mul(along, 0.03), mul(F, 0.15), mul(up, 0.022), M.steelDark);
  horsehead(p, H, headR, a, k, paint);

  // Передние стойки, передний кривошип и шатун, кожух ремня.
  samsonLegs(p, 1, H, paint);
  p.tube(pin(0.15), tailPt(0.11), 0.016, paint, 8);
  crank(p, 0.14, tail, shaftZ, crankR, phase, k, paintDark);
  p.obox(W((tail + motorS) / 2, 0.17, 0.24), mul(E, (motorS - tail) / 2 + 0.05), mul(F, 0.014), mul(Z, 0.075), paint);
}

/** Конец выкидной линии у устья (в клетке, на земле) — сюда подходит труба. */
export function pumpWellhead(o = 0): [number, number] {
  orient(o);
  const p = W(-0.5, -0.27, 0);
  return [p[0], p[1]];
}

/** Ось балансира на земле (для площадки под станком). */
export function pumpAxis(o = 0): [number, number] {
  orient(o);
  return [E[0], E[1]];
}

/** Верх выхлопной трубы газового двигателя (только у качалки 1-го уровня) — точка испускания выхлопа. */
export function pumpExhaust(level: number, o = 0): V3 | null {
  if (level !== 1) return null;
  orient(o);
  const k = 0.9;
  return W(0.36 * k + 0.25 * k + 0.03, -0.05, 0.44);
}

function xy(v: V3): [number, number] {
  return [v[0], v[1]];
}

function samsonLegs(p: ModelPainter, side: 1 | -1, H: number, m: Material): void {
  const top = W(0, 0.045 * side, H - 0.05);
  const feet = [W(-0.16, 0.17 * side, 0.1), W(0.17, 0.17 * side, 0.1)];
  for (const f of feet) p.tube(f, top, 0.022, m, 8);
  const mid = (f: V3) => add(mul(f, 0.55), mul(top, 0.45));
  p.tube(mid(feet[0]), mid(feet[1]), 0.012, m, 6);
}

function crank(p: ModelPainter, t: number, sx: number, sz: number, r: number, phase: number, k: number, m: Material): void {
  const dir = add(mul(E, Math.cos(phase)), mul(Z, Math.sin(phase)));
  const perp = add(mul(E, -Math.sin(phase)), mul(Z, Math.cos(phase)));
  const shaft = W(sx, t, sz);
  p.obox(add(shaft, mul(dir, -0.12 * k)), mul(dir, 0.055 * k), mul(F, 0.025), mul(perp, 0.1 * k), m);
  p.obox(add(shaft, mul(dir, r * 0.45)), mul(dir, r * 0.65), mul(F, 0.012), mul(perp, 0.025), M.steelDark);
}

function horsehead(p: ModelPainter, H: number, R: number, a: number, k: number, m: Material): void {
  const steps = 10;
  const inner = R - 0.13 * k;
  const b0 = a - 0.3;
  const b1 = a + 0.3;
  const pt = (radius: number, b: number, t: number): V3 => W(-radius * Math.cos(b), t, H + radius * Math.sin(b));
  for (let i = 0; i < steps; i++) {
    const ba = b0 + ((b1 - b0) * i) / steps;
    const bb = b0 + ((b1 - b0) * (i + 1)) / steps;
    const mid = (ba + bb) / 2;
    const n = add(mul(E, -Math.cos(mid)), mul(Z, Math.sin(mid)));
    p.face([pt(R, ba, -0.05), pt(R, bb, -0.05), pt(R, bb, 0.05), pt(R, ba, 0.05)], m, n);
  }
  // Верхний торец головы.
  const nTop = add(mul(E, Math.sin(b1)), mul(Z, Math.cos(b1)));
  p.face([pt(inner, b1, -0.05), pt(R, b1, -0.05), pt(R, b1, 0.05), pt(inner, b1, 0.05)], m, nTop);
  const plate: V3[] = [];
  for (let i = 0; i <= steps; i++) plate.push(pt(R, b0 + ((b1 - b0) * i) / steps, 0.05));
  for (let i = steps; i >= 0; i--) plate.push(pt(inner, b0 + ((b1 - b0) * i) / steps, 0.05));
  p.face(plate, m, F);
  p.shadowPoly(plate.map((q) => [q[0] - 0.05 * F[0], q[1] - 0.05 * F[1], q[2]] as V3).concat(plate));
}

/** Геометрия резервуара — нужна и модели, и динамическому указателю уровня. */
export function tankDims(level: number) {
  const r = [0.33, 0.37, 0.42][level - 1] ?? 0.33;
  const h = [0.72, 0.98, 1.28][level - 1] ?? 0.72;
  return { r, h, z0: 0.05 };
}

export function tank(p: ModelPainter, level: number): void {
  const { r, h, z0 } = tankDims(level);
  const cx = 0.5;
  const cy = 0.5;
  const top = z0 + h;
  const at = (theta: number, radius: number, z: number): V3 => [cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius, z];
  const deg = Math.PI / 180;

  p.cylinder(cx, cy, 0, r + 0.05, z0, M.concrete);
  // Патрубок с задвижкой — к трубопроводу.
  p.tube(at(-20 * deg, r - 0.01, 0.13), at(-20 * deg, r + 0.16, 0.13), 0.03, M.galvanized, 10);
  p.cylinder(...xy2(at(-20 * deg, r + 0.1, 0)), 0.1, 0.03, 0.08, M.red);
  p.cylinder(cx, cy, z0, r, h, M.tankWhite, null);

  const ctx = p.ctx;
  if (ctx) {
    // Сварные швы поясов и вертикальные стыки листов.
    ctx.lineWidth = 0.45;
    ctx.strokeStyle = 'rgba(60,62,60,0.28)';
    const rx = r * 32 * Math.SQRT2;
    const ry = r * 16 * Math.SQRT2;
    const [bx, by] = proj([cx, cy, 0]);
    for (let z = z0 + 0.18; z < top - 0.05; z += 0.18) {
      ctx.beginPath();
      ctx.ellipse(bx, by - z * ZPX, rx, ry, 0, 0, Math.PI);
      ctx.stroke();
    }
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * Math.PI * 2 + 0.2;
      if (Math.cos(th - Math.PI / 4) < 0.05) continue;
      const a = proj(at(th, r, z0));
      const b = proj(at(th, r, top));
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }
  // Фирменный пояс.
  p.cylinder(cx, cy, top - 0.13, r + 0.003, 0.06, M.brand, null);
  // Люк-лаз.
  p.tube(at(75 * deg, r - 0.005, 0.2), at(75 * deg, r + 0.02, 0.2), 0.06, M.steel, 14);
  // Крыша и ограждение.
  p.cone(cx, cy, top, r + 0.012, 0.06 + level * 0.02, mat([190, 192, 188], 0.2, 16));
  const rail = r - 0.015;
  const railZ = top + 0.07;
  for (let i = 0; i < 24; i++) {
    const t0 = (i / 24) * Math.PI * 2;
    const t1 = ((i + 1) / 24) * Math.PI * 2;
    p.wire(at(t0, rail, railZ), at(t1, rail, railZ), 0.5, 'rgba(70,74,76,0.9)');
    if (i % 2 === 0) p.wire(at(t0, rail, top + 0.01), at(t0, rail, railZ), 0.4, 'rgba(70,74,76,0.8)');
  }
  // Кольцевая лестница по видимой стороне.
  const steps = Math.round(8 + h * 10);
  const th0 = 128 * deg;
  const th1 = 18 * deg;
  let prev: V3 | null = null;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const th = th0 + (th1 - th0) * k;
    const z = z0 + 0.04 + (top - z0 - 0.04) * k;
    const tangent: V3 = [-Math.sin(th), Math.cos(th), 0];
    const radial: V3 = [Math.cos(th), Math.sin(th), 0];
    p.obox(at(th, r + 0.035, z), mul(tangent, 0.035), mul(radial, 0.03), [0, 0, 0.006], M.steelDark);
    const railPt = at(th, r + 0.068, z + 0.09);
    if (prev) p.wire(prev, railPt, 0.6, 'rgba(48,50,52,0.95)');
    if (i % 3 === 0) p.wire(at(th, r + 0.068, z), railPt, 0.45, 'rgba(48,50,52,0.9)');
    prev = railPt;
  }
}

function xy2(v: V3): [number, number] {
  return [v[0], v[1]];
}

/** Указатель уровня на стенке резервуара (рисуется каждый кадр). */
export function tankGauge(level: number): { bottom: V3; top: V3 } {
  const { r, h, z0 } = tankDims(level);
  const th = (55 * Math.PI) / 180;
  const x = 0.5 + Math.cos(th) * (r + 0.004);
  const y = 0.5 + Math.sin(th) * (r + 0.004);
  return { bottom: [x, y, z0 + 0.12], top: [x, y, z0 + h - 0.2] };
}

/** Терминал, задняя часть: всё, что стоит за полосой налива. */
export function terminalBack(p: ModelPainter, level: number): void {
  const steelPaint = mat([92, 104, 114], 0.3, 20);
  p.tube([0.05, 0.08, 0.07], [0.95, 0.08, 0.07], 0.028, M.galvanized, 10);
  p.tube([0.05, 0.15, 0.07], [0.95, 0.15, 0.07], 0.024, M.brand, 10);
  for (const x of [0.15, 0.5, 0.85]) p.box(x - 0.02, 0.05, 0, x + 0.02, 0.18, 0.05, M.concrete);
  // Пульт оператора.
  p.box(0.82, 0.02, 0, 0.98, 0.22, 0.36, M.wall, M.roofGray);
  p.face([[0.84, 0.221, 0.16], [0.96, 0.221, 0.16], [0.96, 0.221, 0.3], [0.84, 0.221, 0.3]], M.glass, [0, 1, 0]);
  // Задние колонны навеса.
  for (const x of [0.08, 0.92]) p.tube([x, 0.3, 0], [x, 0.3, 0.86], 0.022, steelPaint, 8);
  // Эстакада с площадкой, ограждением и лестницей.
  for (const [x, y] of [[0.2, 0.24], [0.76, 0.24], [0.2, 0.44], [0.76, 0.44]]) p.tube([x, y, 0], [x, y, 0.42], 0.015, steelPaint, 6);
  p.box(0.16, 0.2, 0.42, 0.8, 0.48, 0.45, M.steelDark);
  for (let x = 0.16; x <= 0.8; x += 0.08) p.wire([x, 0.48, 0.45], [x, 0.48, 0.56], 0.45, 'rgba(210,170,40,0.95)');
  p.wire([0.16, 0.48, 0.56], [0.8, 0.48, 0.56], 0.7, 'rgba(210,170,40,0.95)');
  for (let i = 0; i < 6; i++) {
    const x = 0.8 + i * 0.025;
    const z = 0.42 - i * 0.07;
    p.box(x, 0.22, z - 0.01, x + 0.03, 0.34, z, M.steelDark);
  }
  // Наливные стояки (больше на старших уровнях).
  const arms = level >= 3 ? [0.3, 0.48, 0.66] : level === 2 ? [0.34, 0.62] : [0.48];
  for (const x of arms) {
    p.tube([x, 0.44, 0.06], [x, 0.44, 0.66], 0.022, M.galvanized, 8);
    p.tube([x, 0.44, 0.64], [x, 0.66, 0.54], 0.018, M.galvanized, 8);
    p.tube([x, 0.66, 0.55], [x, 0.66, 0.42], 0.016, M.steelDark, 8);
    p.obox([x, 0.42, 0.7], [0.03, 0, 0], [0, 0.03, 0], [0, 0, 0.03], M.red);
  }
}

/** Терминал, передняя часть: колонны и навес над полосой налива. */
export function terminalFront(p: ModelPainter, level: number): void {
  const steelPaint = mat([92, 104, 114], 0.3, 20);
  for (const x of [0.08, 0.92]) p.tube([x, 0.94, 0], [x, 0.94, 0.86], 0.022, steelPaint, 8);
  const fascia = level >= 3 ? mat([40, 110, 170], 0.3, 20) : M.brand;
  p.box(0.03, 0.26, 0.86, 0.97, 0.98, 0.93, fascia, mat([176, 180, 182], 0.25, 16));
  const ctx = p.ctx;
  if (ctx) {
    // Профнастил кровли.
    ctx.strokeStyle = 'rgba(80,84,86,0.35)';
    ctx.lineWidth = 0.4;
    for (let y = 0.3; y < 0.97; y += 0.045) {
      const a = proj([0.03, y, 0.93]);
      const b = proj([0.97, y, 0.93]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }
}

/** Верх выхлопной трубы бензовоза и точка за задними колёсами (откуда летит пыль), в координатах модели. */
export const TRUCK_EXHAUST: V3 = [0.47, 0.6, 0.38];
/** Габарит бензовоза по оси x: зеркальная модель — x → TRUCK_LENGTH − x. */
export const TRUCK_LENGTH = 0.65;
export const TRUCK_DUST: V3 = [0.04, 0.7, 0.02];

/** Бензовоз, развёрнутый кабиной к −x (для выезда назад). Зеркалим по x: передние/задние детали меняются местами. */
export function truckReverse(p: ModelPainter): void {
  const X = (x: number) => TRUCK_LENGTH - x;
  for (const x of [0.1, 0.21, 0.5]) p.tube([X(x), 0.6, 0.06], [X(x), 0.64, 0.06], 0.058, M.rubber, 10);
  p.box(X(0.6), 0.62, 0.07, X(0.02), 0.78, 0.12, M.steelDark);
  p.box(X(0.63), 0.6, 0.07, X(0.6), 0.8, 0.12, M.steel);
  p.box(X(0.61), 0.6, 0.08, X(0.47), 0.8, 0.3, M.red);
  p.face([[X(0.58), 0.801, 0.19], [X(0.5), 0.801, 0.19], [X(0.5), 0.801, 0.28], [X(0.58), 0.801, 0.28]], M.glass, [0, 1, 0]);
  p.tube([X(0.47), 0.6, 0.12], [X(0.47), 0.6, 0.38], 0.012, M.steel, 6);
  p.tube([X(0.45), 0.7, 0.23], [X(0.03), 0.7, 0.23], 0.11, M.aluminium, 18);
  p.box(X(0.42), 0.67, 0.33, X(0.06), 0.73, 0.345, M.steelDark);
  for (const x of [0.1, 0.21, 0.5]) p.tube([X(x), 0.78, 0.06], [X(x), 0.82, 0.06], 0.058, M.rubber, 10);
}

/** Бензовоз, ориентирован вдоль оси x. */
export function truck(p: ModelPainter): void {
  for (const x of [0.1, 0.21, 0.5]) p.tube([x, 0.6, 0.06], [x, 0.64, 0.06], 0.058, M.rubber, 10);
  p.box(0.02, 0.62, 0.07, 0.6, 0.78, 0.12, M.steelDark);
  p.tube([0.03, 0.7, 0.23], [0.45, 0.7, 0.23], 0.11, M.aluminium, 18);
  p.box(0.06, 0.67, 0.33, 0.42, 0.73, 0.345, M.steelDark);
  p.box(0.47, 0.6, 0.08, 0.61, 0.8, 0.3, M.red);
  p.face([[0.611, 0.63, 0.19], [0.611, 0.77, 0.19], [0.611, 0.77, 0.28], [0.611, 0.63, 0.28]], M.glass, [1, 0, 0]);
  p.face([[0.5, 0.801, 0.19], [0.58, 0.801, 0.19], [0.58, 0.801, 0.28], [0.5, 0.801, 0.28]], M.glass, [0, 1, 0]);
  p.box(0.6, 0.6, 0.07, 0.63, 0.8, 0.12, M.steel);
  p.tube([0.47, 0.6, 0.12], TRUCK_EXHAUST, 0.012, M.steel, 6);
  for (const x of [0.1, 0.21, 0.5]) p.tube([x, 0.78, 0.06], [x, 0.82, 0.06], 0.058, M.rubber, 10);
}

/** Окна конторы (нужны и модели, и ночной подсветке). */
export const HQ_WINDOWS: Array<{ side: 'x' | 'y'; quad: V3[] }> = (() => {
  const out: Array<{ side: 'x' | 'y'; quad: V3[] }> = [];
  for (const z of [0.1, 0.4]) {
    for (let i = 0; i < 4; i++) {
      const x = 0.15 + i * 0.19;
      if (z < 0.2 && i === 1) continue; // место для двери
      out.push({ side: 'y', quad: [[x, 0.862, z], [x + 0.12, 0.862, z], [x + 0.12, 0.862, z + 0.17], [x, 0.862, z + 0.17]] });
    }
    for (let i = 0; i < 4; i++) {
      const y = 0.19 + i * 0.17;
      out.push({ side: 'x', quad: [[0.902, y, z], [0.902, y + 0.11, z], [0.902, y + 0.11, z + 0.17], [0.902, y, z + 0.17]] });
    }
  }
  return out;
})();

/** Точки ночного освещения в координатах модели. */
export const LIGHTS = {
  terminalLamps: [[0.25, 0.985, 0.84], [0.75, 0.985, 0.84]] as V3[],
  terminalPool: [0.5, 0.7, 0] as V3,
  hqEntrance: [0.41, 0.98, 0.3] as V3,
  hqSign: [0.5, 0.62, 0.84] as V3,
};

/** Контора компании: двухэтажное здание с окнами, крыльцом, оборудованием на крыше и вывеской. */
export function headquarters(p: ModelPainter): void {
  p.box(0.06, 0.1, 0, 0.94, 0.9, 0.04, M.concrete);
  p.box(0.1, 0.14, 0.04, 0.9, 0.86, 0.64, M.wall, M.roofGray);
  p.box(0.095, 0.135, 0.33, 0.905, 0.865, 0.35, M.concrete);
  const frame = mat([236, 232, 222], 0.05, 6);
  for (const w of HQ_WINDOWS) {
    const n: V3 = w.side === 'y' ? [0, 1, 0] : [1, 0, 0];
    const grow = (q: V3, du: number, dz: number): V3 =>
      w.side === 'y' ? [q[0] + du, q[1] - 0.001, q[2] + dz] : [q[0] - 0.001, q[1] + du, q[2] + dz];
    const [a, b, c, d] = w.quad;
    p.face([grow(a, -0.006, -0.008), grow(b, 0.006, -0.008), grow(c, 0.006, 0.008), grow(d, -0.006, 0.008)], frame, n);
    p.face(w.quad, M.glass, n);
  }
  // Вход с козырьком.
  p.face([[0.35, 0.862, 0.04], [0.47, 0.862, 0.04], [0.47, 0.862, 0.26], [0.35, 0.862, 0.26]], mat([60, 54, 48], 0.2, 10), [0, 1, 0]);
  p.box(0.31, 0.86, 0.27, 0.51, 0.98, 0.3, M.steelDark);
  for (const x of [0.32, 0.5]) p.tube([x, 0.97, 0], [x, 0.97, 0.27], 0.008, M.steel, 6);
  // Парапет.
  p.box(0.1, 0.14, 0.64, 0.9, 0.17, 0.68, M.concrete);
  p.box(0.1, 0.14, 0.64, 0.13, 0.86, 0.68, M.concrete);
  p.box(0.1, 0.83, 0.64, 0.9, 0.86, 0.68, M.concrete);
  p.box(0.87, 0.14, 0.64, 0.9, 0.86, 0.68, M.concrete);
  // Вентиляционные установки.
  p.box(0.2, 0.22, 0.64, 0.4, 0.42, 0.76, M.galvanized);
  p.cylinder(0.3, 0.32, 0.76, 0.06, 0.02, M.steelDark);
  p.box(0.55, 0.55, 0.64, 0.7, 0.75, 0.72, M.galvanized);
  // Вывеска на крыше.
  for (const x of [0.2, 0.8]) p.tube([x, 0.6, 0.64], [x, 0.6, 0.78], 0.01, M.steelDark, 6);
  p.box(0.14, 0.58, 0.76, 0.86, 0.6, 0.92, mat([34, 38, 44], 0.2, 12));
  p.planeText([0.17, 0.601, 0.79], [0.0115, 0, 0], [0, 0, 0.0115], 'OIL TYCOON', 10, '#e6b43a');
  // Флагшток (сам флаг анимируется в рендере).
  p.tube([0.9, 0.12, 0.04], [0.9, 0.12, 1.45], 0.01, M.galvanized, 6);
}

export const HQ_FLAG_TOP: V3 = [0.9, 0.12, 1.45];

const STONE: RGB[] = [
  [138, 130, 118],
  [118, 112, 104],
  [150, 138, 120],
];
const LEAVES: RGB[] = [
  [92, 110, 58],
  [108, 120, 62],
  [78, 96, 52],
  [120, 124, 70],
];

function rnd(seed: number, i: number): number {
  const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function rock(p: ModelPainter, variant: number): void {
  const n = 2 + (variant % 3);
  const stones: Array<[V3, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const r = (0.09 + rnd(variant, i + 9) * 0.08) * (i === 0 ? 1.2 : 0.75);
    const cx = 0.5 + (rnd(variant, i + 3) - 0.5) * 0.32;
    const cy = 0.5 + (rnd(variant, i + 5) - 0.5) * 0.32;
    stones.push([[cx, cy, r * 0.3], r, (i + variant) % 3]);
  }
  stones.sort((a, b) => a[0][0] + a[0][1] - (b[0][0] + b[0][1]));
  for (const [c, r, tone] of stones) p.sphere(c, r, mat(STONE[tone], 0.08, 10), { squash: 0.62 });
}

export function shrub(p: ModelPainter, variant: number): void {
  const n = 5 + (variant % 3);
  const balls: Array<[V3, number]> = [];
  for (let i = 0; i < n; i++) {
    const r = 0.06 + rnd(variant, i) * 0.05;
    const a = rnd(variant, i + 11) * Math.PI * 2;
    const d = rnd(variant, i + 13) * 0.12;
    balls.push([[0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, r * 0.8 + rnd(variant, i + 17) * 0.04], r]);
  }
  balls.sort((a, b) => a[0][0] + a[0][1] - (b[0][0] + b[0][1]) || a[0][2] - b[0][2]);
  balls.forEach(([c, r], i) => p.sphere(c, r, mat(LEAVES[(variant + i) % 4], 0.03, 6), { leafy: 14 }));
}

export function tree(p: ModelPainter, variant: number): void {
  const h = 0.22 + rnd(variant, 1) * 0.12;
  const bark = mat([86, 66, 48], 0.05, 6);
  p.tube([0.5, 0.5, 0], [0.5, 0.5, h + 0.15], 0.032, bark, 8);
  p.tube([0.5, 0.5, h], [0.58, 0.44, h + 0.22], 0.016, bark, 6);
  const balls: Array<[V3, number]> = [];
  const count = 11 + (variant % 4);
  for (let i = 0; i < count; i++) {
    const r = 0.09 + rnd(variant, i + 2) * 0.07;
    const a = rnd(variant, i + 21) * Math.PI * 2;
    const d = Math.sqrt(rnd(variant, i + 23)) * 0.2;
    const z = h + 0.12 + rnd(variant, i + 27) * 0.42 - d * 0.5;
    balls.push([[0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, z], r]);
  }
  balls.sort((a, b) => a[0][0] + a[0][1] + a[0][2] * 0.6 - (b[0][0] + b[0][1] + b[0][2] * 0.6));
  balls.forEach(([c, r], i) => p.sphere(c, r, mat(LEAVES[(variant + i) % 4], 0.03, 6), { leafy: 16 }));
}
