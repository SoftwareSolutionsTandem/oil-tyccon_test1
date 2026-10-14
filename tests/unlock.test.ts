import { describe, expect, it } from 'vitest';
import {
  build,
  canBuild,
  checkObjectives,
  createNewGame,
  isTileOwned,
  OBJECTIVES,
  tileIndex,
  type BuildableType,
  type GameState,
} from '../src/core';

const LOCKED = 'Это здание ещё не открыто';

/** Свободная клетка своей земли без месторождения, здания и трубы. */
function freeTile(s: GameState): { x: number; y: number } {
  for (let y = 0; y < s.map.size; y++)
    for (let x = 0; x < s.map.size; x++) {
      const i = tileIndex(s, x, y);
      if (!isTileOwned(s, x, y) || s.map.initial[i] > 0 || s.map.pipes[i] > 0) continue;
      if (s.buildings.some((b) => b.x === x && b.y === y)) continue;
      return { x, y };
    }
  throw new Error('нет свободной клетки');
}

/**
 * Здания открываются только наградой цели (objectives.ts → s.unlocked, проверка — canBuild).
 * Для каждой цели, открывающей здание: игрок стоит на ней, условие не выполнено — стройка запрещена;
 * условие выполнено, награда выдана — стройка разрешена. Остальные условия стройки (деньги, клетка) выполнены.
 */
const CASES: Array<{ id: string; type: BuildableType; reach: (s: GameState, done: boolean) => void }> = [
  { id: 'first_sales', type: 'tank', reach: (s, done) => (s.totals.sold = done ? 100 : 99) },
  { id: 'revenue_8k', type: 'terminal', reach: (s, done) => (s.totals.revenue = done ? 8000 : 7999) },
  {
    id: 'profit_6k',
    type: 'refinery',
    // Операционная прибыль за последнюю минуту: выручка − содержание по окну статистики.
    reach: (s, done) => {
      s.stats.current.revenue = done ? 6000 : 5999;
      s.stats.current.expenses = 0;
    },
  },
];

describe('открытие зданий целями', () => {
  it('новая игра открывает только качалку', () => {
    expect(createNewGame(1).unlocked).toEqual(['pumpjack']);
  });

  it.each(CASES)('$type: запрещено до цели «$id», разрешено после её награды', ({ id, type, reach }) => {
    const s = createNewGame(7);
    s.cash = 1e6;
    const idx = OBJECTIVES.findIndex((o) => o.id === id);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(OBJECTIVES[idx].unlocks).toContain(type);
    s.objectiveIndex = idx;
    const t = freeTile(s);

    // Цель не выполнена — здание закрыто, стройка не меняет ни здания, ни кассу.
    reach(s, false);
    expect(checkObjectives(s)).toEqual([]);
    expect(s.unlocked).not.toContain(type);
    expect(canBuild(s, type, t.x, t.y)).toEqual({ ok: false, reason: LOCKED });
    const before = { cash: s.cash, count: s.buildings.length };
    expect(build(s, type, t.x, t.y).ok).toBe(false);
    expect({ cash: s.cash, count: s.buildings.length }).toEqual(before);

    // Цель выполнена — награда выдана, здание открыто и строится.
    reach(s, true);
    expect(checkObjectives(s).map((o) => o.id)).toContain(id);
    expect(s.unlocked).toContain(type);
    expect(canBuild(s, type, t.x, t.y)).toEqual({ ok: true });
    expect(build(s, type, t.x, t.y).ok).toBe(true);
  });

  it('каждое здание, кроме качалки, открывает ровно одна цель', () => {
    for (const type of ['tank', 'terminal', 'refinery'] as const) {
      expect(OBJECTIVES.filter((o) => o.unlocks?.includes(type)).map((o) => o.id)).toEqual([CASES.find((c) => c.type === type)!.id]);
    }
  });
});
