import { BASE_MAP_SIZE, MAP_OFFSET, PARCEL_SIZE, PARCELS_PER_SIDE } from '../src/core';

/**
 * Карта сохранения до v8 (веха 0.5): 40×40 без регионов. Тесты миграций собирают «старое» сохранение из текущей
 * игры; карта обрезается до степи (регион 0) со смещения MAP_OFFSET — так она выглядела в старой версии.
 * o — разобранный JSON сохранения; меняется на месте.
 */
export function legacyMap(o: { map: Record<string, unknown> }): void {
  const n = PARCELS_PER_SIDE * PARCEL_SIZE;
  const n0 = BASE_MAP_SIZE;
  const p0 = n0 / PARCEL_SIZE;
  const m = o.map;
  for (const key of ['reserve', 'initial', 'decor', 'pipes', 'grade']) {
    const a = m[key] as number[] | undefined;
    if (!a) continue;
    const out: number[] = [];
    for (let y = 0; y < n0; y++) for (let x = 0; x < n0; x++) out.push(a[(y + MAP_OFFSET.y) * n + x + MAP_OFFSET.x]);
    m[key] = out;
  }
  for (const key of ['owned', 'survey']) {
    const a = m[key] as unknown[] | undefined;
    if (!a) continue;
    const out: unknown[] = [];
    for (let py = 0; py < p0; py++)
      for (let px = 0; px < p0; px++) out.push(a[(py + MAP_OFFSET.y / PARCEL_SIZE) * PARCELS_PER_SIDE + px + MAP_OFFSET.x / PARCEL_SIZE]);
    m[key] = out;
  }
  delete m.region;
  m.size = n0;
}
