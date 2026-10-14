import { describe, expect, it } from 'vitest';
import { autoConnectBest, build, createNewGame, isTileOwned, lastFlow, pumpRate, tick, TICK, type GameState } from '../src/core';
import { Rng } from '../src/core/rng';

/**
 * Одна формула добычи (economy.ts: rateFromPool): то, что показывает pumpRate, и то, что качает логистика
 * (желаемый поток качалки в расчёте шага), совпадают на случайных состояниях — с технологиями и без.
 */
function randomState(seed: number, research: boolean): GameState {
  const rng = new Rng(seed);
  const s = createNewGame(seed);
  s.cash = 1e7;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery'];
  for (let i = 0; i < s.map.owned.length; i++) s.map.owned[i] = true;
  const n = s.map.size;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (s.map.initial[i] <= 0 || !isTileOwned(s, x, y) || rng.next() < 0.6) continue;
      if (!build(s, 'pumpjack', x, y).ok) continue;
      const b = s.buildings[s.buildings.length - 1];
      b.level = rng.int(1, 3);
      autoConnectBest(s, b.id, 2);
    }
  // Истощение — случайная доля запасов каждой клетки.
  for (let i = 0; i < s.map.reserve.length; i++) if (s.map.initial[i] > 0) s.map.reserve[i] = s.map.initial[i] * (0.05 + 0.95 * rng.next());
  if (research) s.research.levels = { yield: rng.int(0, 3), eor: rng.int(0, 3) };
  return s;
}

describe('одна формула добычи', () => {
  it.each([1, 2, 3, 4, 5, 6])('pumpRate совпадает с потоком, который запрашивает логистика (seed %i)', (seed) => {
    for (const research of [false, true]) {
      const s = randomState(seed, research);
      const pumps = s.buildings.filter((b) => b.type === 'pumpjack');
      expect(pumps.length).toBeGreaterThan(3);
      const expected = new Map(pumps.map((b) => [b.id, pumpRate(s, b)]));
      tick(s, TICK);
      const flow = lastFlow(s)!;
      let checked = 0;
      for (const b of pumps) {
        const c = flow.clients.get(b.id);
        if (!c) continue; // не подключена — в расчёт не попала
        expect(c.want).toBe(expected.get(b.id));
        checked++;
      }
      expect(checked).toBeGreaterThan(3);
    }
  });
});
