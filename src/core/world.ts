import { PARCEL_SIZE, PARCELS_PER_SIDE, SURVEY_EXACT, SURVEY_LEVELS } from './config';
import { Rng } from './rng';
import type { Building, GameState } from './types';

export function inBounds(s: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.map.size && y < s.map.size;
}

export function tileIndex(s: GameState, x: number, y: number): number {
  return y * s.map.size + x;
}

export function parcelOf(x: number, y: number): { px: number; py: number } {
  return { px: Math.floor(x / PARCEL_SIZE), py: Math.floor(y / PARCEL_SIZE) };
}

export function parcelIndex(px: number, py: number): number {
  return py * PARCELS_PER_SIDE + px;
}

export function isParcelOwned(s: GameState, px: number, py: number): boolean {
  if (px < 0 || py < 0 || px >= PARCELS_PER_SIDE || py >= PARCELS_PER_SIDE) return false;
  return s.map.owned[parcelIndex(px, py)];
}

export function isTileOwned(s: GameState, x: number, y: number): boolean {
  const { px, py } = parcelOf(x, y);
  return isParcelOwned(s, px, py);
}

export function buildingAt(s: GameState, x: number, y: number): Building | undefined {
  return s.buildings.find((b) => b.x === x && b.y === y);
}

export function getBuilding(s: GameState, id: number): Building | undefined {
  return s.buildings.find((b) => b.id === id);
}

export function ownedParcelCount(s: GameState): number {
  return s.map.owned.filter(Boolean).length;
}

export function isParcelAdjacentToOwned(s: GameState, px: number, py: number): boolean {
  return (
    isParcelOwned(s, px - 1, py) ||
    isParcelOwned(s, px + 1, py) ||
    isParcelOwned(s, px, py - 1) ||
    isParcelOwned(s, px, py + 1)
  );
}

/** Сводка по месторождениям участка — то, что видит игрок до покупки. */
export function parcelSurvey(s: GameState, px: number, py: number): { tiles: number; reserves: number; light: number; heavy: number } {
  let tiles = 0;
  let reserves = 0;
  let light = 0;
  let heavy = 0;
  for (let y = py * PARCEL_SIZE; y < (py + 1) * PARCEL_SIZE; y++) {
    for (let x = px * PARCEL_SIZE; x < (px + 1) * PARCEL_SIZE; x++) {
      const i = tileIndex(s, x, y);
      const r = s.map.reserve[i];
      if (r > 0) {
        tiles++;
        reserves += r;
        if (s.map.grade[i] === 1) heavy += r;
        else light += r;
      }
    }
  }
  return { tiles, reserves, light, heavy };
}

/** Уровень разведки участка: свой участок всегда известен точно. */
export function surveyLevel(s: GameState, px: number, py: number): number {
  if (isParcelOwned(s, px, py)) return SURVEY_EXACT;
  return s.map.survey?.[parcelIndex(px, py)] ?? SURVEY_EXACT;
}

/** Известно ли игроку, есть ли на клетке месторождение (для подсказок и отрисовки пятен). */
export function tileSurveyLevel(s: GameState, x: number, y: number): number {
  return surveyLevel(s, Math.floor(x / PARCEL_SIZE), Math.floor(y / PARCEL_SIZE));
}

export interface Range {
  low: number;
  high: number;
}

/** Оценка участка, которую видит игрок на текущем уровне разведки. */
export interface ParcelEstimate {
  level: number;
  /** Клеток с нефтью — известно с геологической съёмки. */
  tiles: number | null;
  /** Запасы: точное значение (low = high) или диапазон; null — неизвестно. */
  reserves: Range | null;
  /** Запасы по сортам — с сейсморазведки. */
  light: Range | null;
  heavy: Range | null;
}

/**
 * Диапазон оценки: смещение центра постоянно для участка и уровня (от seed), поэтому повторный взгляд
 * не «перебрасывает кости»; полуширина — точность уровня; истинное значение всегда внутри диапазона.
 */
function estimateRange(s: GameState, px: number, py: number, level: number, salt: number, value: number): Range {
  if (value <= 0) return { low: 0, high: 0 };
  const acc = SURVEY_LEVELS[level - 1].accuracy;
  const rng = new Rng(((s.seed * 73856093) ^ (px * 19349663) ^ (py * 83492791) ^ (level * 2654435761) ^ (salt * 40503)) >>> 0);
  const shift = (rng.next() * 2 - 1) * acc * 0.8;
  const round = (v: number) => Math.round(v / 100) * 100;
  return { low: Math.max(0, round(value * (1 + shift - acc))), high: round(value * (1 + shift + acc)) };
}

export function parcelEstimate(s: GameState, px: number, py: number): ParcelEstimate {
  const level = surveyLevel(s, px, py);
  const truth = parcelSurvey(s, px, py);
  if (level >= SURVEY_EXACT) {
    const exact = (v: number): Range => ({ low: v, high: v });
    return { level, tiles: truth.tiles, reserves: exact(truth.reserves), light: exact(truth.light), heavy: exact(truth.heavy) };
  }
  if (level <= 0) return { level, tiles: null, reserves: null, light: null, heavy: null };
  const withGrade = SURVEY_LEVELS[level - 1].grade;
  return {
    level,
    tiles: truth.tiles,
    reserves: estimateRange(s, px, py, level, 0, truth.reserves),
    light: withGrade ? estimateRange(s, px, py, level, 1, truth.light) : null,
    heavy: withGrade ? estimateRange(s, px, py, level, 2, truth.heavy) : null,
  };
}
