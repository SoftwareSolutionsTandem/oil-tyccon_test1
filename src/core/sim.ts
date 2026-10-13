import { MARKET, OFFLINE_CAP } from './config';
import { advanceStats, buildingUpkeep, recordStat } from './economy';
import { stepLogistics } from './network';
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

  // 1–2. Логистика: добыча через сеть трубопроводов в хранилища своей сети и продажа через терминалы этой сети (по цене сорта).
  const flow = stepLogistics(s, dt);
  s.totals.produced += flow.produced;
  recordStat(s, 'produced', flow.produced);
  const autoSold = flow.sold;
  const autoRevenue = flow.revenue;
  s.cash += autoRevenue;
  s.totals.sold += autoSold;
  s.totals.revenue += autoRevenue;
  recordStat(s, 'sold', autoSold);
  recordStat(s, 'revenue', autoRevenue);

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
