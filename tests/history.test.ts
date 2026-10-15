import { describe, expect, it } from 'vitest';
import {
  build,
  createNewGame,
  deserialize,
  HISTORY,
  historyLength,
  historyPoints,
  HQ_POS,
  MARKET,
  OBJECTIVES,
  serialize,
  simulateOffline,
  tick,
  TICK,
  type GameState,
} from '../src/core';

/** Промысел с добычей и продажей: две качалки 3-го уровня у конторы и терминал. */
function field(seed = 5): GameState {
  const s = createNewGame(seed);
  s.cash = 100_000;
  s.unlocked = ['pumpjack', 'tank', 'terminal'];
  const n = s.map.size;
  for (const [x, y] of [[HQ_POS.x + 1, HQ_POS.y], [HQ_POS.x - 1, HQ_POS.y]]) {
    s.map.reserve[y * n + x] = s.map.initial[y * n + x] = 500_000;
    build(s, 'pumpjack', x, y);
    s.buildings[s.buildings.length - 1].level = 3;
  }
  build(s, 'terminal', HQ_POS.x, HQ_POS.y + 1);
  return s;
}

const play = (s: GameState, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / TICK); i++) tick(s, TICK);
};

describe('статистика за 4 часа: кольцевой буфер минутных корзин', () => {
  it('корзина на каждую минуту: добыча, выручка, прибыль за минуту, средняя цена, касса и долг на конце', () => {
    const s = field();
    const produced0 = s.totals.produced;
    play(s, 180);
    expect(historyLength(s.history)).toBe(3);
    const pts = historyPoints(s.history);
    expect(pts.map((p) => p.minute)).toEqual([0, 1, 2]);
    expect(pts.reduce((a, p) => a + p.produced, 0)).toBeCloseTo(s.totals.produced - produced0, 6);
    expect(pts.reduce((a, p) => a + p.revenue, 0)).toBeCloseTo(s.totals.revenue, 6);
    expect(pts.reduce((a, p) => a + p.profit, 0)).toBeCloseTo(s.totals.revenue - s.totals.expenses, 6);
    for (const p of pts) {
      expect(p.price).toBeGreaterThanOrEqual(MARKET.min);
      expect(p.price).toBeLessThanOrEqual(MARKET.max);
      expect(p.debt).toBe(0);
    }
    expect(pts[2].cash).toBeCloseTo(s.cash, 6); // минута закрылась на последнем шаге
  });

  it('офлайн (шаг 1 с) дописывает точки так же, как игра (0,1 с)', () => {
    const a = field(7);
    const b = field(7);
    play(a, 600);
    simulateOffline(b, 600);
    expect(historyLength(b.history)).toBe(historyLength(a.history));
    const pa = historyPoints(a.history);
    const pb = historyPoints(b.history);
    // Крупный шаг офлайна чуть иначе заполняет склады — добыча за минуту совпадает с точностью до 3%.
    for (let i = 0; i < pa.length; i++) expect(Math.abs(pb[i].produced - pa[i].produced)).toBeLessThanOrEqual(pa[i].produced * 0.03 + 1e-9);
    expect(pb.reduce((x, p) => x + p.produced, 0)).toBeCloseTo(b.totals.produced, 6);
  });

  it('переполнение: хранится 240 последних минут, номера подряд, отметки старше буфера удаляются', () => {
    const s = field(3);
    s.history.marks.push({ minute: 0, kind: 'goal', label: 'старая' });
    simulateOffline(s, 4 * 3600);
    simulateOffline(s, 15 * 60);
    expect(historyLength(s.history)).toBe(HISTORY.points);
    expect(s.history.total).toBe(255);
    const pts = historyPoints(s.history);
    expect(pts[0].minute).toBe(15);
    expect(pts[pts.length - 1].minute).toBe(254);
    for (let i = 1; i < pts.length; i++) expect(pts[i].minute).toBe(pts[i - 1].minute + 1);
    expect(s.history.marks.some((m) => m.label === 'старая')).toBe(false);
    expect(historyPoints(s.history, 60).length).toBe(60);
    // Размер в сохранении — в пределах плана (10–15 КБ на буфер).
    expect(JSON.stringify(s.history).length).toBeLessThan(40_000);
  });

  it('сохранение и загрузка: буфер тот же, дальше игра идёт одинаково', () => {
    const a = field(9);
    simulateOffline(a, 300);
    play(a, 25);
    const b = deserialize(serialize(a))!;
    expect(b.history).toEqual(a.history);
    play(a, 120);
    play(b, 120);
    expect(b.history).toEqual(a.history);
  });

  it('старое сохранение без статистики: пустой буфер, первая минута считает только свой прирост', () => {
    const s = field(4);
    simulateOffline(s, 300);
    const old = JSON.parse(serialize(s));
    delete old.history;
    const m = deserialize(JSON.stringify(old))!;
    expect(m.history.data).toEqual([]);
    const before = m.totals.produced;
    play(m, 60);
    expect(historyLength(m.history)).toBe(1);
    expect(historyPoints(m.history)[0].produced).toBeCloseTo(m.totals.produced - before, 6);
    const bad = JSON.parse(serialize(s));
    bad.history.data = [1, 2, 3];
    expect(deserialize(JSON.stringify(bad))).toBeNull();
  });

  it('отметки: выполненная цель — на минуте выполнения', () => {
    const s = createNewGame(2);
    s.cash = 10_000;
    play(s, 61);
    const n = s.map.size;
    const i = s.map.initial.findIndex((r, k) => r > 0 && Math.floor((k % n) / 8) === 2 && Math.floor(k / n / 8) === 2);
    build(s, 'pumpjack', i % n, Math.floor(i / n));
    tick(s, TICK);
    expect(s.history.marks).toEqual([{ minute: 1, kind: 'goal', label: OBJECTIVES[0].title }]);
  });
});
