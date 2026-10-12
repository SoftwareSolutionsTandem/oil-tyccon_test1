import { TerrainLayer } from './terrain';

export interface SourceImage {
  image: CanvasImageSource;
  pad: number;
  width: number;
  height: number;
}

/**
 * Поставщик исходных текстур земли: запросы уходят в Web Worker, готовые картинки кешируются.
 * Пока картинки нет, get() возвращает null — вызывающий оставляет прежнее изображение или заглушку.
 * Без поддержки Worker/OffscreenCanvas генерирует синхронно в основном потоке.
 */
export class TerrainSource {
  private ready = new Map<string, SourceImage>();
  private pending = new Set<string>();
  private worker: Worker | null = null;
  /** Синхронный генератор основного потока (запасной путь и первый кадр). */
  private local: TerrainLayer;

  constructor(
    readonly seed: number,
    size: number,
  ) {
    this.local = new TerrainLayer(seed, size);
    try {
      if (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
        this.worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
        this.worker.postMessage({ type: 'init', seed, size });
        this.worker.onmessage = (e: MessageEvent) => {
          const { key, bitmap, pad } = e.data as { key: string; bitmap: ImageBitmap; pad: number };
          this.pending.delete(key);
          this.ready.set(key, { image: bitmap, pad, width: bitmap.width, height: bitmap.height });
        };
        this.worker.onerror = () => this.fallback();
      }
    } catch {
      this.fallback();
    }
  }

  private fallback(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  private key(x0: number, y0: number, cell: number, tex: number): string {
    return `${x0},${y0},${cell},${tex}`;
  }

  /** Картинка участка или null (запрос поставлен в очередь). sync — сгенерировать немедленно в основном потоке. */
  get(x0: number, y0: number, cell: number, tex: number, sync = false): SourceImage | null {
    const key = this.key(x0, y0, cell, tex);
    const have = this.ready.get(key);
    if (have) return have;
    if (sync || !this.worker) {
      const { canvas, pad } = this.local.bake(x0, y0, cell, tex);
      this.local.release(x0, y0, cell, tex);
      const img = { image: canvas, pad, width: canvas.width, height: canvas.height };
      this.ready.set(key, img);
      return img;
    }
    if (!this.pending.has(key)) {
      this.pending.add(key);
      this.worker.postMessage({ type: 'bake', key, x0, y0, cell, tex });
    }
    return null;
  }

  release(x0: number, y0: number, cell: number, tex: number): void {
    const key = this.key(x0, y0, cell, tex);
    const img = this.ready.get(key);
    if (img && 'close' in img.image) (img.image as ImageBitmap).close();
    this.ready.delete(key);
  }

  /** Сколько запросов ещё в работе (для отладки и фоновой подготовки). */
  get backlog(): number {
    return this.pending.size;
  }

  bytes(): number {
    let b = 0;
    for (const img of this.ready.values()) b += img.width * img.height * 4;
    return b;
  }

  dispose(): void {
    this.worker?.terminate();
    for (const img of this.ready.values()) if ('close' in img.image) (img.image as ImageBitmap).close();
    this.ready.clear();
  }
}
