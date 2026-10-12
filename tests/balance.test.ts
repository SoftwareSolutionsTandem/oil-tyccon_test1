import { describe, expect, it } from 'vitest';
import { createNewGame, OBJECTIVES } from '../src/core';
import { runBot } from './bot';

describe('баланс (автоматический игрок)', () => {
  it.each([1, 2, 3])('простая стратегия проходит основные цели за полтора часа (seed %i)', (seed) => {
    const s = createNewGame(seed);
    const { reachedAt, minCash } = runBot(s, 90);
    if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BALANCE_LOG) {
      const rows = OBJECTIVES.map((o) => `${o.id.padEnd(12)} ${reachedAt[o.id] ? (reachedAt[o.id] / 60).toFixed(1) + ' мин' : '—'}`);
      console.log(`seed ${seed}: деньги ${Math.round(s.cash)}, зданий ${s.buildings.length}\n${rows.join('\n')}`);
    }
    // Первые шаги должны быть быстрыми, чтобы игрок сразу почувствовал прогресс.
    expect(reachedAt.first_sales).toBeLessThan(5 * 60);
    expect(reachedAt.terminal).toBeLessThan(20 * 60);
    expect(reachedAt.pumps_10).toBeLessThan(60 * 60);
    expect(reachedAt.profit_6k).toBeLessThan(40 * 60);
    // Временный кассовый разрыв допустим, но разумная стратегия не должна уходить в глубокий долг.
    expect(minCash).toBeGreaterThan(-2000);
    // Итоговая касса шумная (зависит от момента последней покупки), поэтому прогресс меряем выручкой.
    expect(s.totals.revenue).toBeGreaterThan(1_500_000);
  }, 30_000);
});
