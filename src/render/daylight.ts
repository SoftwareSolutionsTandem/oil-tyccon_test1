/**
 * Смена дня и ночи — компромисс без перепекания: спрайты и земля запечены при дневном свете,
 * а время суток передаётся цветокоррекцией кадра, силой теней и локальными источниками света.
 * Время берётся из игрового времени состояния, поэтому цикл следует скорости игры и восстанавливается из сохранения.
 */

/** Длительность суток в игровых секундах (10 минут на скорости ×1). */
export const DAY_LENGTH = 600;
/** Игра начинается утром. */
const START_HOUR = 8;

export interface Lighting {
  /** Часы 0..24. */
  hour: number;
  /** Множитель цвета кадра (multiply), 0..1 по каналам. */
  tint: [number, number, number];
  /** Сила солнечных теней 0..1. */
  shadow: number;
  /** Насколько темно для искусственного света 0..1. */
  night: number;
}

interface Key {
  h: number;
  tint: [number, number, number];
  shadow: number;
  night: number;
}

// Ночь не делается слишком тёмной, чтобы объекты и экономика оставались читаемыми.
const NIGHT: [number, number, number] = [0.5, 0.56, 0.76];
const KEYS: Key[] = [
  { h: 0, tint: NIGHT, shadow: 0.12, night: 1 },
  { h: 4.5, tint: NIGHT, shadow: 0.12, night: 1 },
  { h: 6, tint: [0.9, 0.78, 0.7], shadow: 0.5, night: 0.45 },
  { h: 7.5, tint: [1, 0.94, 0.86], shadow: 0.9, night: 0 },
  { h: 9, tint: [1, 1, 1], shadow: 1, night: 0 },
  { h: 16.5, tint: [1, 1, 1], shadow: 1, night: 0 },
  { h: 18, tint: [1, 0.92, 0.8], shadow: 0.9, night: 0.05 },
  { h: 19.5, tint: [0.8, 0.68, 0.68], shadow: 0.45, night: 0.55 },
  { h: 21, tint: NIGHT, shadow: 0.12, night: 1 },
  { h: 24, tint: NIGHT, shadow: 0.12, night: 1 },
];

export function hourAt(time: number): number {
  return (START_HOUR + (time / DAY_LENGTH) * 24) % 24;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export function lightingAt(time: number): Lighting {
  const hour = hourAt(time);
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = smooth((hour - a.h) / (b.h - a.h || 1));
  const lerp = (x: number, y: number) => x + (y - x) * t;
  return {
    hour,
    tint: [lerp(a.tint[0], b.tint[0]), lerp(a.tint[1], b.tint[1]), lerp(a.tint[2], b.tint[2])],
    shadow: lerp(a.shadow, b.shadow),
    night: lerp(a.night, b.night),
  };
}

export const NOON: Lighting = { hour: 12, tint: [1, 1, 1], shadow: 1, night: 0 };

export function formatClock(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
