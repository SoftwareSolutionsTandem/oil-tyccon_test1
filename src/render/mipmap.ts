import { createCanvas } from './noise';

/**
 * Уменьшенные копии запечённых холстов (½, ¼, ⅛). При сильном отдалении камеры холст 2× ужимается в 6–10 раз,
 * и тонкие детали (тросы, перила, камешки) мерцают при движении. Заранее отфильтрованная копия нужного размера
 * убирает мерцание и экономит заполнение. Копии создаются лениво последовательным уменьшением вдвое,
 * не больше MIP_BUDGET за кадр (иначе при пересечении порога масштаба все копии создавались бы в одном кадре),
 * и освобождаются, если долго не используются.
 */
interface Entry {
  levels: HTMLCanvasElement[];
  lastUsed: number;
}

const cache = new Map<HTMLCanvasElement, Entry>();
const MIP_BUDGET = 8;
let frame = 0;
let budget = MIP_BUDGET;

/** Вызывается раз в кадр: сбрасывает бюджет и иногда освобождает неиспользуемые копии. */
export function mipmapFrame(): void {
  frame++;
  budget = MIP_BUDGET;
  if (frame % 120 === 0) {
    for (const [canvas, e] of cache) if (frame - e.lastUsed > 600) cache.delete(canvas);
  }
}

/**
 * Возвращает холст для вывода с коэффициентом ratio (пикселей экрана на пиксель холста).
 * Порог 0,6 (а не 0,5): на копию переходим, пока исходник ещё немного больше нужного, — без «мыла».
 */
export function mipmap(canvas: HTMLCanvasElement, ratio: number): HTMLCanvasElement {
  if (ratio >= 0.6 || canvas.width < 16 || canvas.height < 16) return canvas;
  const level = ratio >= 0.3 ? 1 : ratio >= 0.15 ? 2 : 3;
  let e = cache.get(canvas);
  if (!e) {
    e = { levels: [], lastUsed: frame };
    cache.set(canvas, e);
  }
  e.lastUsed = frame;
  let src = canvas;
  for (let i = 0; i < level; i++) {
    if (!e.levels[i]) {
      if (budget <= 0) return src; // бюджет кадра исчерпан — временно рисуем более крупный уровень
      budget--;
      const c = createCanvas(Math.max(1, Math.round(src.width / 2)), Math.max(1, Math.round(src.height / 2)));
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, c.width, c.height);
      e.levels[i] = c;
    }
    src = e.levels[i];
    if (src.width < 8 || src.height < 8) break;
  }
  return src;
}

/** Память, занятая всеми копиями, байт. */
export function mipmapBytes(): number {
  let bytes = 0;
  for (const e of cache.values()) for (const m of e.levels) if (m) bytes += m.width * m.height * 4;
  return bytes;
}
