import { MARKET, OFFLINE_CAP } from './config';
import { advanceStats, buildingUpkeep, drainageTiles, pumpRate, recordStat, storageCapacity, terminalThroughput } from './economy';
import { checkObjectives, type Objective } from './objectives';
import { Rng } from './rng';
import type { GameState, Totals } from './types';

export interface TickEvents {
  autoSold: number;
  autoRevenue: number;
  completed: Objective[];
}

/** Один шаг симуляции. Чистая логика без DOM — её можно гонять в тестах и офлайн. */
export function tick(s: GameState, dt: number): TickEvents {
  s.time += dt;
  updateMarket(s, dt);

  // 1. Добыча: качалки делят свободное место в хранилище пропорционально своей добыче.
  //    Каждая тянет нефть из своей зоны дренирования пропорционально остаткам клеток (зона истощается равномерно).
  const pumps: Array<{ tiles: number[]; amount: number; b: GameState['buildings'][number] }> = [];
  let wanted = 0;
  for (const b of s.buildings) {
    if (b.type !== 'pumpjack') continue;
    const tiles = drainageTiles(s, b);
    const pool = tiles.reduce((sum, i) => sum + s.map.reserve[i], 0);
    if (pool <= 0) {
      b.status = 'depleted';
      continue;
    }
    if (!b.enabled) {
      b.status = 'off';
      continue;
    }
    const amount = Math.min(pool, pumpRate(s, b) * dt);
    pumps.push({ tiles, amount, b });
    wanted += amount;
  }
  const free = Math.max(0, storageCapacity(s) - s.oil);
  const share = wanted > 0 ? Math.min(1, free / wanted) : 1;
  let produced = 0;
  for (const p of pumps) {
    const target = p.amount * share;
    // Остатки зоны пересчитываются здесь: соседние скважины могут делить клетку.
    const pool = p.tiles.reduce((sum, i) => sum + s.map.reserve[i], 0);
    if (pool > 0) {
      for (const i of p.tiles) {
        const take = Math.min(s.map.reserve[i], (target * s.map.reserve[i]) / pool);
        s.map.reserve[i] -= take;
        produced += take;
      }
    }
    p.b.status = share < 0.999 ? 'full' : 'ok';
  }
  s.oil += produced;
  s.totals.produced += produced;
  recordStat(s, 'produced', produced);

  // 2. Автоматическая продажа через терминалы.
  const terminals = s.buildings.filter((b) => b.type === 'terminal');
  const throughput = terminalThroughput(s);
  const priceOk = s.market.price >= s.sellThreshold;
  const autoSold = priceOk ? Math.min(s.oil, throughput * dt) : 0;
  const autoRevenue = autoSold * s.market.price;
  s.oil -= autoSold;
  s.cash += autoRevenue;
  s.totals.sold += autoSold;
  s.totals.revenue += autoRevenue;
  recordStat(s, 'sold', autoSold);
  recordStat(s, 'revenue', autoRevenue);
  for (const b of terminals) {
    if (!b.enabled) b.status = 'off';
    else if (!priceOk) b.status = 'waiting_price';
    else if (autoSold <= 1e-9) b.status = 'no_oil';
    else b.status = 'ok';
  }

  // 3. Содержание зданий.
  let upkeep = 0;
  for (const b of s.buildings) upkeep += buildingUpkeep(b);
  const expenses = upkeep * dt;
  s.cash -= expenses;
  s.totals.expenses += expenses;
  recordStat(s, 'expenses', expenses);

  advanceStats(s, dt);
  const completed = checkObjectives(s);
  return { autoSold, autoRevenue, completed };
}

function updateMarket(s: GameState, dt: number): void {
  const rng = new Rng(s.rng);
  const cycleMean = MARKET.mean + MARKET.cycleAmplitude * Math.sin((2 * Math.PI * s.time) / MARKET.cyclePeriod);
  let p = s.market.price;
  p += MARKET.reversion * (cycleMean - p) * dt + MARKET.volatility * Math.sqrt(dt) * rng.gaussian();
  s.market.price = Math.min(MARKET.max, Math.max(MARKET.min, p));
  s.rng = rng.state;

  s.market.historyAcc += dt;
  while (s.market.historyAcc >= MARKET.historyStep) {
    s.market.historyAcc -= MARKET.historyStep;
    s.market.history.push(s.market.price);
    if (s.market.history.length > MARKET.historyLength) s.market.history.shift();
  }
}

export interface OfflineReport {
  seconds: number;
  produced: number;
  sold: number;
  revenue: number;
  expenses: number;
  completed: Objective[];
}

/** Догоняет время, прошедшее без игрока (с ограничением OFFLINE_CAP), крупными шагами по 1 с. */
export function simulateOffline(s: GameState, seconds: number): OfflineReport {
  const total = Math.min(Math.max(0, Math.floor(seconds)), OFFLINE_CAP);
  const before: Totals = { ...s.totals };
  const completed: Objective[] = [];
  for (let i = 0; i < total; i++) completed.push(...tick(s, 1).completed);
  return {
    seconds: total,
    produced: s.totals.produced - before.produced,
    sold: s.totals.sold - before.sold,
    revenue: s.totals.revenue - before.revenue,
    expenses: s.totals.expenses - before.expenses,
    completed,
  };
}
