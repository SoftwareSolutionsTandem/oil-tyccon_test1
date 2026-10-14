import { describe, expect, it } from 'vitest';
import { build, createNewGame, layPipes, syncOil, tick, TICK, type Building, type GameState } from '../src/core';

/**
 * Хранилище-тупик D за промысловой трубой T: качалки закачивают в D через T, терминал забирает из D через ту же T.
 * Раньше забор шёл первым и занимал трубу, закачка получала остаток: запас D скакал через шаг
 * (x → C − x), а качалки мигали «работает» / «ограничено трубой». Теперь забор и закачка делят трубу
 * пропорционально в одном расчёте — в установившемся режиме статусы и поток не прыгают.
 *
 *   y=19:      P1
 *   y=20:  D   T  ─ ─ ─ ─  Term
 *   y=21:      P2
 */
function deadEnd(): { s: GameState; pumps: Building[]; d: Building; term: Building } {
  const s = createNewGame(5);
  s.cash = 1e6;
  s.unlocked = ['pumpjack', 'tank', 'terminal'];
  for (let i = 0; i < s.map.reserve.length; i++) s.map.reserve[i] = s.map.initial[i] = s.map.grade[i] = 0;
  const n = s.map.size;
  for (const [x, y] of [[17, 19], [17, 21]]) s.map.reserve[y * n + x] = s.map.initial[y * n + x] = 1e6;
  expect(build(s, 'tank', 16, 20).ok).toBe(true);
  const d = s.buildings[s.buildings.length - 1];
  expect(layPipes(s, [[17, 20], [18, 20], [19, 20], [20, 20], [21, 20]], 1).ok).toBe(true);
  expect(build(s, 'terminal', 22, 20).ok).toBe(true);
  const term = s.buildings[s.buildings.length - 1];
  term.level = 3; // 6 барр./с — забирает всё, что пропустит труба
  const pumps: Building[] = [];
  for (const [x, y] of [[17, 19], [17, 21]]) {
    expect(build(s, 'pumpjack', x, y).ok).toBe(true);
    const p = s.buildings[s.buildings.length - 1];
    p.level = 3; // 2 × 0,65 барр./с — вместе с забором больше пропускной способности трубы (2 барр./с)
    pumps.push(p);
  }
  return { s, pumps, d, term };
}

describe('общее деление трубы между забором и закачкой', () => {
  it('у хранилища-тупика статусы и поток не мигают между соседними шагами', () => {
    const { s, pumps, d, term } = deadEnd();
    for (let i = 0; i < 200; i++) tick(s, TICK);
    const statuses: string[] = [];
    const produced: number[] = [];
    const sold: number[] = [];
    for (let i = 0; i < 60; i++) {
      const p0 = s.totals.produced;
      const s0 = s.totals.sold;
      tick(s, TICK);
      statuses.push([...pumps, term].map((b) => b.status).join(','));
      produced.push(s.totals.produced - p0);
      sold.push(s.totals.sold - s0);
    }
    // Статусы одинаковы на всех шагах окна.
    expect(new Set(statuses).size).toBe(1);
    // Поток между соседними шагами не прыгает.
    for (let i = 1; i < produced.length; i++) {
      expect(Math.abs(produced[i] - produced[i - 1])).toBeLessThan(1e-6);
      expect(Math.abs(sold[i] - sold[i - 1])).toBeLessThan(1e-6);
    }
    // Труба занята полностью: закачка + забор = пропускная способность T за шаг.
    expect(produced[produced.length - 1] + sold[sold.length - 1]).toBeCloseTo(2 * TICK, 6);
    expect(d.stored ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('нефть сохраняется: добыто − продано = запасы хранилищ', () => {
    const { s } = deadEnd();
    for (let i = 0; i < 500; i++) tick(s, TICK);
    syncOil(s);
    expect(s.totals.produced - s.totals.sold).toBeCloseTo(s.oil, 6);
  });
});
