import {
  BUILDINGS,
  DEMOLISH_REFUND,
  DEPLETION_MIN_FACTOR,
  HQ_STORAGE,
  MOTHBALL_UPKEEP,
  PARCEL_BASE_PRICE,
  PARCEL_PRICE_GROWTH,
  STATS_WINDOW,
} from './config';
import type { BuildableType, Building, GameState, StatBucket } from './types';
import { ownedParcelCount, tileIndex } from './world';

export function levelSpec(b: Building) {
  if (b.type === 'hq') return { cost: 0, upkeep: 0, value: HQ_STORAGE };
  return BUILDINGS[b.type].levels[b.level - 1];
}

export function maxLevel(type: BuildableType): number {
  return BUILDINGS[type].levels.length;
}

export function countOf(s: GameState, type: Building['type']): number {
  return s.buildings.filter((b) => b.type === type).length;
}

export function buildCost(s: GameState, type: BuildableType): number {
  const spec = BUILDINGS[type];
  return Math.round(spec.levels[0].cost * Math.pow(spec.costGrowth, countOf(s, type)));
}

/** Стоимость улучшения до следующего уровня или null, если уровень максимальный. */
export function upgradeCost(b: Building): number | null {
  if (b.type === 'hq' || b.level >= maxLevel(b.type)) return null;
  return BUILDINGS[b.type].levels[b.level].cost;
}

export function demolishRefund(b: Building): number {
  return Math.round(b.invested * DEMOLISH_REFUND);
}

export function storageCapacity(s: GameState): number {
  let cap = 0;
  for (const b of s.buildings) {
    if (b.type === 'hq' || b.type === 'tank') cap += levelSpec(b).value;
  }
  return cap;
}

/** Текущая добыча качалки без учёта ограничения хранилища, барр./с. */
export function pumpRate(s: GameState, b: Building): number {
  const i = tileIndex(s, b.x, b.y);
  const initial = s.map.initial[i];
  const reserve = s.map.reserve[i];
  if (initial <= 0 || reserve <= 0) return 0;
  const factor = DEPLETION_MIN_FACTOR + (1 - DEPLETION_MIN_FACTOR) * (reserve / initial);
  return levelSpec(b).value * factor;
}

/**
 * Сколько секунд проработает качалка до полного истощения клетки.
 * Добыча падает вместе с запасами: dr/dt = −v·(m + (1−m)·r/R), откуда t = R/(v(1−m))·ln(1 + (1−m)·r/(m·R)).
 */
export function timeToDeplete(s: GameState, b: Building): number {
  const i = tileIndex(s, b.x, b.y);
  const R = s.map.initial[i];
  const r = s.map.reserve[i];
  if (R <= 0 || r <= 0) return 0;
  const m = DEPLETION_MIN_FACTOR;
  const v = levelSpec(b).value;
  return (R / (v * (1 - m))) * Math.log(1 + ((1 - m) * r) / (m * R));
}

/** Суммарная мощность добычи работающих качалок, барр./с. */
export function productionCapacity(s: GameState): number {
  let total = 0;
  for (const b of s.buildings) {
    if (b.type === 'pumpjack' && b.enabled) total += pumpRate(s, b);
  }
  return total;
}

export function terminalThroughput(s: GameState): number {
  let total = 0;
  for (const b of s.buildings) {
    if (b.type === 'terminal' && b.enabled) total += levelSpec(b).value;
  }
  return total;
}

export function buildingUpkeep(b: Building): number {
  const upkeep = levelSpec(b).upkeep;
  return b.enabled ? upkeep : upkeep * MOTHBALL_UPKEEP;
}

export function totalUpkeep(s: GameState): number {
  return s.buildings.reduce((sum, b) => sum + buildingUpkeep(b), 0);
}

export function parcelPrice(s: GameState): number {
  return Math.round(PARCEL_BASE_PRICE * Math.pow(PARCEL_PRICE_GROWTH, ownedParcelCount(s) - 1));
}

export function emptyBucket(): StatBucket {
  return { produced: 0, sold: 0, revenue: 0, expenses: 0 };
}

export function recordStat(s: GameState, key: keyof StatBucket, value: number): void {
  s.stats.current[key] += value;
}

export function advanceStats(s: GameState, dt: number): void {
  s.stats.currentTime += dt;
  while (s.stats.currentTime >= 1) {
    s.stats.currentTime -= 1;
    s.stats.buckets.push(s.stats.current);
    if (s.stats.buckets.length > STATS_WINDOW) s.stats.buckets.shift();
    s.stats.current = emptyBucket();
  }
}

/** Потоки за последнюю минуту (скользящее окно). */
export function lastMinute(s: GameState): StatBucket {
  const sum = emptyBucket();
  for (const b of [...s.stats.buckets, s.stats.current]) {
    sum.produced += b.produced;
    sum.sold += b.sold;
    sum.revenue += b.revenue;
    sum.expenses += b.expenses;
  }
  return sum;
}
