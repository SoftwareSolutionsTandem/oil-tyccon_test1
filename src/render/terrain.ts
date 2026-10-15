import { BASE_MAP_SIZE, MAP_OFFSET, MAP_SIZE } from '../core/config';
import { LIGHT } from './model';
import { createCanvas, fbm, hash2, smoothstep, valueNoise } from './noise';

/**
 * Пикселей текстуры на клетку. Земля рисуется в координатах клеток и проецируется аффинным преобразованием.
 * Своя земля генерируется в высоком разрешении (резко при приближении), чужая — в низком.
 */
export const TEX_HIGH = 96;
export const TEX_LOW = 48;
/** Запас текстуры за краем ячейки, в клетках: соседние ячейки перекрываются одинаковым содержимым. */
const PAD_TILES = 0.125;

type RGBf = [number, number, number];
const DIRT: RGBf = [170, 146, 108];
const DRY: RGBf = [170, 162, 104];
const GREEN: RGBf = [118, 138, 74];
const SAND: RGBf = [200, 182, 138];
const DARK: RGBf = [138, 116, 86];
/** Пустыня (веха 0.5): светлый песок, тени барханов, выгоревшие плешины. */
const DUNE: RGBf = [230, 196, 130];
const DUNE_SHADE: RGBf = [204, 160, 100];
const DUNE_PALE: RGBf = [242, 222, 172];

/** Шельф (веха 0.5, этап 2б): пляж у кромки, отмель, глубокая вода. */
const BEACH: RGBf = [206, 190, 146];
const SHALLOW: RGBf = [86, 146, 146];
const DEEP: RGBf = [40, 86, 108];

/**
 * Береговая линия (v в клетках). На карте — ровно по границе шельфа (регион 2, core/world.ts regionAt) с
 * колебанием в пределах клетки, чтобы клетки шельфа были морем, а клетки суши — сушей; за краями карты берег
 * изгибается сильнее.
 */
function coastAt(u: number, seed: number): number {
  const out = Math.max(0, -u, u - MAP_SIZE);
  const amp = 0.12 + Math.min(6, out * 0.25);
  return MAP_OFFSET.y + BASE_MAP_SIZE + (fbm(u * 0.06, 7.3, 2, seed + 21) - 0.5) * 2 * amp;
}

/** Доля моря в точке мира (0 — суша, 1 — вода). */
export function seaWeight(u: number, v: number, seed = 0): number {
  const c = coastAt(u, seed);
  return smoothstep(c - 0.12, c + 0.12, v);
}

/**
 * Доля пустыни в точке мира: восточнее старой карты (регион 1, core/world.ts regionAt) с мягким переходом в клетку
 * у границы. За краем карты пустыня продолжается — окружение остаётся похожим на соседнюю землю.
 */
export function desertWeight(u: number, v: number): number {
  const bx = u - MAP_OFFSET.x;
  const by = v - MAP_OFFSET.y;
  return smoothstep(BASE_MAP_SIZE - 0.7, BASE_MAP_SIZE + 0.9, bx) * (1 - smoothstep(BASE_MAP_SIZE - 0.9, BASE_MAP_SIZE + 0.7, by));
}

const mix = (a: RGBf, b: RGBf, t: number): RGBf => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

interface Track {
  pts: Array<[number, number]>;
}

/**
 * Непрерывная процедурная текстура земли, разбитая на квадратные ячейки.
 * Содержимое зависит только от мировых координат, поэтому перекрывающиеся поля соседних кусков
 * совпадают и швов между ними нет.
 */
export class TerrainLayer {
  private chunks = new Map<string, HTMLCanvasElement>();
  private tracks: Track[];

  constructor(
    readonly seed: number,
    readonly size: number,
  ) {
    this.tracks = this.makeTracks();
  }

  private makeTracks(): Track[] {
    const out: Track[] = [];
    // Колеи по всей видимой территории, а не только по игровой карте: степь вокруг тоже изъезжена.
    for (let i = 0; i < 26; i++) {
      let x = -24 + hash2(i, 1, this.seed) * (this.size + 48);
      let y = -24 + hash2(i, 2, this.seed) * (this.size + 48);
      let a = hash2(i, 3, this.seed) * Math.PI * 2;
      const pts: Array<[number, number]> = [[x, y]];
      for (let k = 0; k < 40; k++) {
        a += (valueNoise(k * 0.3, i * 7, this.seed) - 0.5) * 0.5;
        x += Math.cos(a) * 0.5;
        y += Math.sin(a) * 0.5;
        pts.push([x, y]);
      }
      out.push({ pts });
    }
    return out;
  }

  private fields(u: number, v: number) {
    const s = this.seed;
    return {
      biome: fbm(u * 0.09, v * 0.09, 3, s),
      patch: fbm(u * 0.35, v * 0.35, 3, s + 1),
      height: fbm(u * 0.45, v * 0.45, 3, s + 2),
      moist: fbm(u * 0.2, v * 0.2, 2, s + 3),
    };
  }

  /** Цвет грунта и высота рельефа в точке мира — общая основа для карты, степи и дальней панорамы. */
  sample(u: number, v: number): { color: RGBf; height: number } {
    const f = this.fields(u, v);
    const grass = smoothstep(0.42, 0.62, f.biome + (f.patch - 0.5) * 0.35);
    let c = mix(DIRT, mix(DRY, GREEN, smoothstep(0.42, 0.68, f.moist)), grass);
    c = mix(c, SAND, smoothstep(0.6, 0.74, f.patch) * (1 - grass * 0.7));
    c = mix(c, DARK, smoothstep(0.62, 0.8, f.moist) * (1 - grass) * 0.4);
    const w = desertWeight(u, v);
    if (w > 0) {
      // Барханы: гряды по высоте рельефа, светлые плешины по пятнам.
      const ridge = smoothstep(0.35, 0.75, f.height);
      let d = mix(DUNE_SHADE, DUNE, ridge);
      d = mix(d, DUNE_PALE, smoothstep(0.55, 0.75, f.patch) * 0.7);
      c = mix(c, d, w);
    }
    // Пляж — полоса у кромки на суше; вода темнеет с глубиной, по пятнам — светлые отмели. Рельеф воды плоский.
    const coast = coastAt(u, this.seed);
    const beach = smoothstep(coast - 0.9, coast - 0.15, v);
    if (beach > 0) c = mix(c, BEACH, beach * 0.85);
    const sea = seaWeight(u, v, this.seed);
    if (sea > 0) {
      const depth = smoothstep(0, 9, v - coast);
      const water = mix(mix(SHALLOW, DEEP, depth), SHALLOW, smoothstep(0.6, 0.8, f.patch) * 0.35 * (1 - depth));
      c = mix(c, water, sea);
    }
    return { color: c, height: f.height * (1 - sea) + 0.5 * sea };
  }

  grassAt(u: number, v: number): number {
    const f = this.fields(u, v);
    return smoothstep(0.42, 0.62, f.biome + (f.patch - 0.5) * 0.35) * (1 - desertWeight(u, v)) * (1 - seaWeight(u, v, this.seed));
  }

  canvases(): HTMLCanvasElement[] {
    return [...this.chunks.values()];
  }

  /** Освобождает исходник ячейки (например, у чужой земли после запекания в проекцию). */
  release(x0: number, y0: number, cell: number, tex: number): void {
    this.chunks.delete(`${x0},${y0},${cell},${tex}`);
  }

  /**
   * Текстура квадрата клеток [x0, x0+cell) × [y0, y0+cell) с запасом PAD_TILES по краям.
   * Возвращает холст и запас в клетках.
   */
  bake(x0: number, y0: number, cell: number, tex: number): { canvas: HTMLCanvasElement; pad: number } {
    const key = `${x0},${y0},${cell},${tex}`;
    const existing = this.chunks.get(key);
    if (existing) return { canvas: existing, pad: PAD_TILES };
    const PAD = Math.round(PAD_TILES * tex);
    // Шаг сетки полей в клетках: 1/16 на карте; в степи (низкое разрешение) хватает 1/8 — вчетверо меньше вычислений.
    const lod = tex < 48;
    const STEP = Math.max(2, Math.round(tex / (lod ? 8 : 16)));
    const TEX = tex;
    const size = cell * TEX + PAD * 2;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const u0 = x0 - PAD / TEX;
    const v0 = y0 - PAD / TEX;

    // 1. Низкочастотные поля на грубой сетке.
    const gw = Math.ceil(size / STEP) + 2;
    const fBase: RGBf[] = new Array(gw * gw);
    const fHeight = new Float32Array(gw * gw);
    for (let gy = 0; gy < gw; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const u = u0 + (gx * STEP) / TEX;
        const v = v0 + (gy * STEP) / TEX;
        const g = this.sample(u, v);
        fBase[gy * gw + gx] = g.color;
        fHeight[gy * gw + gx] = g.height;
      }
    }

    // 2. Мелкая деталь — на сетке с шагом ~1/32 клетки (её период ~1/9 клетки), дальше билинейно.
    const FSTEP = Math.max(1, Math.round(TEX / 32));
    const fw = Math.ceil(size / FSTEP) + 2;
    const fFine = new Float32Array(fw * fw);
    for (let gy = 0; gy < fw; gy++) {
      for (let gx = 0; gx < fw; gx++) {
        const u = u0 + (gx * FSTEP) / TEX;
        const v = v0 + (gy * FSTEP) / TEX;
        fFine[gy * fw + gx] = valueNoise(u * 3.2, v * 3.2, this.seed + 4) * 0.6 + valueNoise(u * 9, v * 9, this.seed + 5) * 0.4;
      }
    }

    // 3. Попиксельно: интерполяция, рельефная светотень, мелкая деталь и зерно.
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const relief = 6;
    for (let y = 0; y < size; y++) {
      const fyf = y / FSTEP;
      const fy = Math.floor(fyf);
      const fty = fyf - fy;
      const gyf = y / STEP;
      const gy = Math.floor(gyf);
      const ty = gyf - gy;
      for (let x = 0; x < size; x++) {
        const gxf = x / STEP;
        const gx = Math.floor(gxf);
        const tx = gxf - gx;
        const i00 = gy * gw + gx;
        const c00 = fBase[i00];
        const c10 = fBase[i00 + 1];
        const c01 = fBase[i00 + gw];
        const c11 = fBase[i00 + gw + 1];
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;
        const hu = (fHeight[i00 + 1] - fHeight[i00] + fHeight[i00 + gw + 1] - fHeight[i00 + gw]) * 0.5;
        const hv = (fHeight[i00 + gw] - fHeight[i00] + fHeight[i00 + gw + 1] - fHeight[i00 + 1]) * 0.5;
        const lit = 1 + (-hu * LIGHT[0] - hv * LIGHT[1]) * relief;
        const u = u0 + x / TEX;
        const v = v0 + y / TEX;
        const fxf = x / FSTEP;
        const fx = Math.floor(fxf);
        const ftx = fxf - fx;
        const f00 = fy * fw + fx;
        const fa = fFine[f00] + (fFine[f00 + 1] - fFine[f00]) * ftx;
        const fb = fFine[f00 + fw] + (fFine[f00 + fw + 1] - fFine[f00 + fw]) * ftx;
        const fine = fa + (fb - fa) * fty;
        // Зерно привязано к мировым координатам: совпадает в перекрытии ячеек любого разрешения.
        const grain = hash2(Math.floor(u * 64), Math.floor(v * 64), this.seed) - 0.5;
        const k = lit * (0.9 + fine * 0.16) + grain * 0.06;
        const o = (y * size + x) * 4;
        d[o] = (c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11) * k;
        d[o + 1] = (c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11) * k;
        d[o + 2] = (c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11) * k;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // 4. Векторные детали в координатах клеток: колеи, трещины, трава, камешки.
    ctx.setTransform(TEX, 0, 0, TEX, -u0 * TEX, -v0 * TEX);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const t of this.tracks) {
      for (const off of [-0.09, 0.09]) {
        ctx.beginPath();
        t.pts.forEach(([x, y], i) => {
          const [nx, ny] = i + 1 < t.pts.length ? t.pts[i + 1] : t.pts[i - 1];
          const len = Math.hypot(nx - x, ny - y) || 1;
          const ox = (-(ny - y) / len) * off * (i + 1 < t.pts.length ? 1 : -1);
          const oy = ((nx - x) / len) * off * (i + 1 < t.pts.length ? 1 : -1);
          if (i === 0) ctx.moveTo(x + ox, y + oy);
          else ctx.lineTo(x + ox, y + oy);
        });
        ctx.strokeStyle = 'rgba(78,62,44,0.16)';
        ctx.lineWidth = 0.06;
        ctx.stroke();
      }
    }
    for (let ty = y0 - 1; ty < y0 + cell + 1; ty++) {
      for (let tx = x0 - 1; tx < x0 + cell + 1; tx++) {
        this.tileDetails(ctx, tx, ty, lod);
      }
    }
    this.chunks.set(key, canvas);
    return { canvas, pad: PAD_TILES };
  }

  private tileDetails(ctx: CanvasRenderingContext2D, tx: number, ty: number, lod = false): void {
    const s = this.seed;
    const h = (i: number) => hash2(tx * 31 + i, ty * 17 + i * 7, s + 11);
    const grass = this.grassAt(tx + 0.5, ty + 0.5);
    // Море: вместо камней и трещин — гребешки волн, параллельные берегу.
    const sea = seaWeight(tx + 0.5, ty + 0.5, s);
    if (sea > 0.5) {
      const n = lod ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const cx = tx + h(400 + i);
        const cy = ty + h(420 + i);
        const len = 0.12 + h(440 + i) * 0.2;
        ctx.beginPath();
        ctx.moveTo(cx - len, cy);
        ctx.quadraticCurveTo(cx, cy - 0.05, cx + len, cy);
        ctx.strokeStyle = `rgba(225,240,240,${(0.16 + h(460 + i) * 0.14).toFixed(3)})`;
        ctx.lineWidth = 0.016;
        ctx.stroke();
      }
      return;
    }
    // Рябь на песке пустыни: короткие дуги поперёк ветра (с северо-запада), светлая сторона к свету.
    const desert = desertWeight(tx + 0.5, ty + 0.5);
    if (desert > 0.3) {
      const n = lod ? 2 : 4;
      for (let i = 0; i < n; i++) {
        const cx = tx + h(300 + i);
        const cy = ty + h(320 + i);
        const len = 0.18 + h(340 + i) * 0.22;
        ctx.beginPath();
        ctx.moveTo(cx - len, cy + len * 0.6);
        ctx.quadraticCurveTo(cx, cy - len * 0.15, cx + len, cy - len * 0.6);
        ctx.strokeStyle = `rgba(150,108,62,${(0.22 * desert).toFixed(3)})`;
        ctx.lineWidth = 0.022;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - len, cy + len * 0.6 - 0.025);
        ctx.quadraticCurveTo(cx, cy - len * 0.15 - 0.025, cx + len, cy - len * 0.6 - 0.025);
        ctx.strokeStyle = `rgba(255,240,205,${(0.25 * desert).toFixed(3)})`;
        ctx.lineWidth = 0.016;
        ctx.stroke();
      }
    }
    // Трещины на сухой земле.
    if (grass < 0.3 && desert < 0.5 && h(1) < 0.35) {
      let x = tx + h(2);
      let y = ty + h(3);
      let a = h(4) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let i = 0; i < 6; i++) {
        a += (h(10 + i) - 0.5) * 1.4;
        x += Math.cos(a) * 0.09;
        y += Math.sin(a) * 0.09;
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(70,56,40,0.22)';
      ctx.lineWidth = 0.012;
      ctx.stroke();
    }
    // Пучки травы.
    const tufts = Math.round(grass * 10 + h(5) * 3);
    for (let i = 0; i < tufts; i++) {
      const cx = tx + h(20 + i);
      const cy = ty + h(40 + i);
      // В упрощённом режиме — одна проверка травы на клетку вместо проверки каждого пучка.
      const g = lod ? grass : this.grassAt(cx, cy);
      if (g < 0.25) continue;
      const tone = h(60 + i);
      ctx.strokeStyle = tone < 0.5 ? 'rgba(70,86,40,0.55)' : 'rgba(176,170,104,0.5)';
      ctx.lineWidth = 0.014;
      ctx.beginPath();
      for (let j = 0; j < 5; j++) {
        const a = -Math.PI / 2 + (h(80 + i * 5 + j) - 0.5) * 2.2 + 0.6;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * 0.05, cy + Math.sin(a) * 0.05);
      }
      ctx.stroke();
    }
    // Камешки с собственной тенью и бликом.
    const pebbles = Math.round(1 + (1 - grass) * 4 * h(6));
    for (let i = 0; i < pebbles; i++) {
      const cx = tx + h(120 + i);
      const cy = ty + h(140 + i);
      const r = 0.012 + h(160 + i) * 0.022;
      const shade = 110 + h(180 + i) * 60;
      ctx.fillStyle = 'rgba(40,32,24,0.35)';
      ctx.beginPath();
      ctx.ellipse(cx + r * 0.5, cy - r * 0.7, r * 1.1, r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgb(${shade | 0},${(shade * 0.95) | 0},${(shade * 0.86) | 0})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.8, h(200 + i) * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,250,235,0.35)';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.25, cy + r * 0.3, r * 0.45, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Пятна нефти на поверхности: несколько вариантов, рисуются поверх земли с прозрачностью по остатку запасов. */
export function makeStains(count: number, seed: number): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  const size = 96;
  for (let v = 0; v < count; v++) {
    const c = createCanvas(size, size);
    const ctx = c.getContext('2d')!;
    const cx = size / 2;
    const cy = size / 2;
    const blob = (rBase: number, jag: number, s: number) => {
      ctx.beginPath();
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const r = rBase * (0.72 + fbm(Math.cos(a) * 1.5 + v * 3, Math.sin(a) * 1.5, 3, seed + s) * jag);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    // Пропитанный грунт вокруг.
    blob(40, 0.7, 1);
    const halo = ctx.createRadialGradient(cx, cy, 6, cx, cy, 44);
    halo.addColorStop(0, 'rgba(60,46,30,0.45)');
    halo.addColorStop(1, 'rgba(46,36,26,0)');
    ctx.fillStyle = halo;
    ctx.fill();
    // Лужа нефти.
    blob(22, 0.75, 2);
    const pool = ctx.createRadialGradient(cx - 3, cy + 3, 2, cx, cy, 26);
    pool.addColorStop(0, 'rgba(24,18,12,0.88)');
    pool.addColorStop(0.6, 'rgba(36,27,18,0.78)');
    pool.addColorStop(1, 'rgba(52,40,26,0.35)');
    ctx.fillStyle = pool;
    ctx.fill();
    // Радужная плёнка и блик неба.
    ctx.save();
    ctx.clip();
    const sheen = ctx.createLinearGradient(cx - 20, cy + 16, cx + 18, cy - 14);
    sheen.addColorStop(0, 'rgba(120,90,160,0)');
    sheen.addColorStop(0.45, 'rgba(110,140,170,0.12)');
    sheen.addColorStop(0.6, 'rgba(170,140,90,0.1)');
    sheen.addColorStop(1, 'rgba(120,90,160,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
    out.push(c);
  }
  return out;
}

/** Бесшовные материалы площадок (гравий, бетон) для заливки узором; узор задан в пикселях текстуры TEX_PATTERN на клетку. */
export const TEX_PATTERN = 64;
export function makeGroundMaterial(kind: 'gravel' | 'concrete', seed: number): HTMLCanvasElement {
  const size = 64;
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const base = kind === 'gravel' ? [138, 130, 116] : [176, 172, 162];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * 4, (y / size) * 4, 3, seed, 4);
      const g = hash2(x, y, seed) - 0.5;
      const k = kind === 'gravel' ? 0.82 + n * 0.3 + g * 0.28 : 0.9 + n * 0.16 + g * 0.06;
      const o = (y * size + x) * 4;
      img.data[o] = base[0] * k;
      img.data[o + 1] = base[1] * k;
      img.data[o + 2] = base[2] * k;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
