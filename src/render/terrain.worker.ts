/// <reference lib="webworker" />
import { TerrainLayer } from './terrain';

/**
 * Генерация исходной текстуры земли в отдельном потоке: самая дорогая часть запекания земли
 * (шум, пиксели, трава и камешки) не отнимает время у кадров основного потока.
 */
let layer: TerrainLayer | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    layer = new TerrainLayer(m.seed, m.size);
    return;
  }
  if (m.type === 'bake' && layer) {
    const { canvas, pad } = layer.bake(m.x0, m.y0, m.cell, m.tex);
    layer.release(m.x0, m.y0, m.cell, m.tex);
    const bitmap = (canvas as unknown as OffscreenCanvas).transferToImageBitmap();
    (self as unknown as Worker).postMessage({ key: m.key, bitmap, pad }, [bitmap]);
  }
};
