import { describe, expect, it } from 'vitest';
import {
  build,
  capital,
  checkObjectives,
  createNewGame,
  deserialize,
  HQ_POS,
  LOANS,
  loanDebt,
  loanDebtAt,
  loanLimit,
  loanPayment,
  MANAGERS,
  OBJECTIVES,
  repayLoan,
  SAVE_VERSION,
  serialize,
  setManager,
  setManagerReserve,
  simulateOffline,
  START_CASH,
  syncOil,
  takeLoan,
  tick,
  TICK,
  type Building,
  type GameState,
} from '../src/core';
import { Rng } from '../src/core/rng';
import { legacyMap } from './legacy';

const HX = HQ_POS.x;
const HY = HQ_POS.y;

/** Денежный инвариант вехи 0.4: кредиты и исследования — отдельные члены, зарплаты — в расходах. */
function expectBalanced(s: GameState, start = START_CASH) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

/** Промысел: n клеток месторождения рядом с конторой, качалки на них, резервуар; всё открыто. */
function field(pumps = 6, level = 3): { s: GameState; list: Building[] } {
  const s = createNewGame(5);
  s.cash = 50_000;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery'];
  s.features = ['research', 'loans', 'managers'];
  for (let i = 0; i < s.map.reserve.length; i++) s.map.reserve[i] = s.map.initial[i] = s.map.grade[i] = 0;
  const n = s.map.size;
  expect(build(s, 'tank', HX + 1, HY)).toEqual({ ok: true });
  s.buildings[s.buildings.length - 1].level = 3;
  const list: Building[] = [];
  // Ряд качалок вдоль x рядом с резервуаром и конторой: каждая примыкает к соседней клетке-хранилищу через трубы нет —
  // поэтому ставим их вплотную к резервуару по одной и к конторе.
  const spots: Array<[number, number]> = [
    [HX + 2, HY],
    [HX + 1, HY + 1],
    [HX + 1, HY - 1],
    [HX - 1, HY],
    [HX, HY + 1],
    [HX, HY - 1],
  ];
  for (const [x, y] of spots.slice(0, pumps)) {
    s.map.reserve[y * n + x] = s.map.initial[y * n + x] = 20_000;
    if (build(s, 'pumpjack', x, y).ok) {
      const b = s.buildings[s.buildings.length - 1];
      b.level = level;
      list.push(b);
    }
  }
  return { s, list };
}

describe('кредит', () => {
  it('замкнутая форма: долг гасится ровно к сроку, сумма платежей = a·T', () => {
    const loan = { principal: 100_000, start: 0, rate: 0.01, term: 1800 };
    expect(loanDebtAt(loan, 0)).toBeCloseTo(100_000, 6);
    expect(loanDebtAt(loan, 1800)).toBe(0);
    expect(loanDebtAt(loan, 1799.999)).toBeLessThan(1);
    // Ставка 1% в минуту на 30 минут: платёж ≈ 3,875% суммы в минуту, переплата ≈ 16%.
    expect((loanPayment(loan) * 60) / 100_000).toBeCloseTo(0.03875, 3);
    // Долг убывает монотонно.
    let prev = Infinity;
    for (let t = 0; t <= 1800; t += 60) {
      const d = loanDebtAt(loan, t);
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
  });

  it('отказы: не открыто, второй кредит, касса в минусе, маленький лимит', () => {
    const fresh = createNewGame(1);
    expect(takeLoan(fresh).ok).toBe(false);
    fresh.features = ['loans'];
    expect(takeLoan(fresh).ok).toBe(false); // добычи нет — лимит 0
    const { s } = field();
    expect(loanLimit(s)).toBeGreaterThan(1000);
    s.cash = -1;
    expect(takeLoan(s).ok).toBe(false);
    s.cash = 50_000;
    expect(takeLoan(s)).toEqual({ ok: true });
    expect(takeLoan(s).ok).toBe(false);
  });

  it('погашение по графику: долг = получено − погашено на каждом шаге, кредит закрывается в срок; инвариант денег', () => {
    const { s } = field();
    // База инварианта: касса до опыта минус всё уже учтённое в totals (стройка полигона).
    const t0 = s.totals;
    const start = s.cash - (t0.revenue + t0.rewards + t0.refunds + t0.borrowed - t0.expenses - t0.capex - t0.research - t0.repaid - t0.interest);
    const cash0 = s.cash;
    const L = loanLimit(s);
    expect(takeLoan(s)).toEqual({ ok: true });
    expect(s.cash).toBe(cash0 + L);
    const term = LOANS.termMinutes * 60;
    for (let i = 0; i < term * 10 + 5; i++) {
      tick(s, TICK);
      if (i % 500 === 0) {
        expect(loanDebt(s)).toBeCloseTo(s.totals.borrowed - s.totals.repaid, 4);
        expectBalanced(s, start);
      }
    }
    expect(s.loan).toBeNull();
    expect(s.totals.repaid).toBeCloseTo(L, 4);
    expect(s.totals.interest).toBeCloseTo(loanPayment({ principal: L, start: 0, rate: LOANS.ratePerMinute, term }) * term - L, 2);
    expectBalanced(s, start);
  });

  it('офлайн (шаг 1 с) и игра (0,1 с) платят одинаково', () => {
    const a = field().s;
    const b = field().s;
    expect(takeLoan(a)).toEqual({ ok: true });
    expect(takeLoan(b)).toEqual({ ok: true });
    for (let i = 0; i < 6000; i++) tick(a, TICK);
    simulateOffline(b, 600);
    expect(b.totals.repaid).toBeCloseTo(a.totals.repaid, 4);
    expect(b.totals.interest).toBeCloseTo(a.totals.interest, 4);
    expect(loanDebt(b)).toBeCloseTo(loanDebt(a), 4);
  });

  it('досрочное погашение и платежи при отрицательной кассе', () => {
    const { s } = field();
    const start = s.cash;
    expect(takeLoan(s)).toEqual({ ok: true });
    for (let i = 0; i < 600; i++) tick(s, TICK);
    const debt = loanDebt(s);
    s.cash = debt - 1;
    expect(repayLoan(s).ok).toBe(false);
    // Касса в минусе — платёж всё равно списывается.
    s.cash = -500;
    const repaid = s.totals.repaid;
    tick(s, TICK);
    expect(s.totals.repaid).toBeGreaterThan(repaid);
    expect(s.cash).toBeLessThan(-500 + 100);
    s.cash = 1e6;
    const before = loanDebt(s);
    expect(repayLoan(s)).toEqual({ ok: true });
    expect(s.loan).toBeNull();
    expect(s.cash).toBeCloseTo(1e6 - before, 6);
    expect(s.totals.repaid).toBeCloseTo(s.totals.borrowed, 6);
    // Касса задавалась вручную — проверяем только кредитную часть.
    expect(start).toBeGreaterThan(0);
  });

  it('цель «Нефтяная компания» считает капитал: касса минус долг', () => {
    const s = createNewGame(1);
    s.objectiveIndex = OBJECTIVES.findIndex((o) => o.id === 'cash_500k');
    s.cash = 600_000;
    s.loan = { principal: 200_000, start: s.time, rate: 0.01, term: 1800 };
    expect(capital(s)).toBeCloseTo(400_000, 6);
    expect(checkObjectives(s)).toEqual([]);
    s.loan = null;
    expect(checkObjectives(s).map((o) => o.id)).toEqual(['cash_500k']);
  });
});

describe('менеджеры', () => {
  it('найм только после открытия; зарплата — в расходах и в totals.salaries; инвариант', () => {
    const s = createNewGame(1);
    expect(setManager(s, 'dispatcher', true).ok).toBe(false);
    s.features = ['managers'];
    s.cash = 10_000;
    expect(setManager(s, 'dispatcher', true)).toEqual({ ok: true });
    expect(setManager(s, 'mechanic', true)).toEqual({ ok: true });
    for (let i = 0; i < 100; i++) tick(s, TICK);
    expect(s.totals.salaries).toBeCloseTo((MANAGERS.dispatcher.salary + MANAGERS.mechanic.salary) * 10, 6);
    expect(s.totals.expenses).toBeGreaterThanOrEqual(s.totals.salaries);
    expectBalanced(s, 10_000);
  });

  it('решения — только на границе периода', () => {
    const { s } = field();
    expect(setManager(s, 'dispatcher', true)).toEqual({ ok: true });
    s.sellThreshold = 12_345;
    const changes: number[] = [];
    for (let i = 0; i < 400; i++) {
      const before = s.sellThreshold;
      tick(s, TICK);
      if (s.sellThreshold !== before || (i === 0 && s.sellThreshold !== 12_345)) changes.push(s.time);
    }
    expect(changes.length).toBeGreaterThan(0);
    for (const t of changes) expect(Math.abs(t / MANAGERS.period - Math.round(t / MANAGERS.period))).toBeLessThan(0.011);
  });

  it('диспетчер: при полных складах порог 0, при свободных — выше средней цены; тяжёлая — по её цене', () => {
    const { s, list } = field(1);
    expect(setManager(s, 'dispatcher', true)).toEqual({ ok: true });
    for (const b of s.buildings) if (b.type === 'hq' || b.type === 'tank') b.stored = 0;
    syncOil(s);
    while (Math.floor(s.time / MANAGERS.period) < 1) tick(s, TICK);
    const avg = s.market.history.reduce((a, v) => a + v, 0) / s.market.history.length;
    expect(s.sellThreshold).toBeGreaterThan(avg * 0.99);
    // Склады полны (≥ 85%) — продавать всё.
    for (const b of s.buildings) if (b.type === 'hq' || b.type === 'tank') b.stored = b.type === 'hq' ? 60 : 800;
    syncOil(s);
    const t0 = Math.floor(s.time / MANAGERS.period);
    while (Math.floor(s.time / MANAGERS.period) === t0) tick(s, TICK);
    expect(s.sellThreshold).toBe(0);
    expect(list.length).toBe(1);
  });

  it('механик: улучшает качалку с лучшей окупаемостью, держит резерв, не зависит от порядка зданий', () => {
    const run = (shuffle: boolean, reserve: number) => {
      const { s } = field(4, 1);
      s.cash = 3000;
      expect(setManager(s, 'mechanic', true)).toEqual({ ok: true });
      setManagerReserve(s, reserve);
      if (shuffle) {
        const rng = new Rng(3);
        s.buildings.sort(() => rng.next() - 0.5);
      }
      while (Math.floor(s.time / MANAGERS.period) < 1) tick(s, TICK);
      return s.buildings
        .filter((b) => b.type === 'pumpjack')
        .sort((a, b) => a.id - b.id)
        .map((b) => b.level);
    };
    const a = run(false, 0);
    expect(a.filter((l) => l === 2).length).toBe(1); // одно улучшение за решение
    expect(run(true, 0)).toEqual(a);
    // Резерв больше кассы после покупки — механик ждёт.
    expect(run(false, 2500).every((l) => l === 1)).toBe(true);
  });
});

describe('сохранения v7', () => {
  /** Сохранение версии 6 из текущего состояния: без полей v7. */
  function asV6(s: GameState): string {
    const o = JSON.parse(serialize(s));
    o.version = 6;
    legacyMap(o);
    delete o.managers;
    delete o.loan;
    for (const k of ['salaries', 'borrowed', 'repaid', 'interest']) delete o.totals[k];
    return JSON.stringify(o);
  }

  it('миграция v6 → v7 для каждого номера цели 0–13 (v6): сдвиг, открытия, без наград', () => {
    const v6ids = OBJECTIVES.filter((o) => o.id !== 'credit' && o.id !== 'staff').map((o) => o.id);
    for (let v6 = 0; v6 <= 13; v6++) {
      const s = createNewGame(8);
      s.cash = 55_555;
      s.objectiveIndex = v6;
      s.features = v6 >= 11 ? ['research'] : [];
      const m = deserialize(asV6(s))!;
      expect(m).not.toBeNull();
      expect(m.version).toBe(SAVE_VERSION);
      expect(m.cash).toBe(55_555);
      expect(m.loan).toBeNull();
      expect(m.managers).toEqual({ dispatcher: false, mechanic: false, reserve: 0 });
      expect(m.totals.borrowed).toBe(0);
      const expected = v6 <= 10 ? v6 : v6 === 11 ? 12 : v6 + 2;
      expect(m.objectiveIndex).toBe(expected);
      expect(m.features.includes('loans')).toBe(v6 >= 11);
      expect(m.features.includes('managers')).toBe(v6 >= 12);
      if (v6 === 10) expect(OBJECTIVES[m.objectiveIndex].id).toBe('credit');
      else expect(OBJECTIVES[m.objectiveIndex]?.id).toBe(v6ids[v6]);
    }
  });

  it('сохранение и загрузка с кредитом и менеджерами; повреждённые данные отклоняются', () => {
    const { s } = field();
    expect(takeLoan(s)).toEqual({ ok: true });
    setManager(s, 'mechanic', true);
    setManagerReserve(s, 1234);
    for (let i = 0; i < 300; i++) tick(s, TICK);
    const json = serialize(s);
    const b = deserialize(json)!;
    expect(b.loan).toEqual(s.loan);
    expect(b.managers).toEqual(s.managers);
    expect(loanDebt(b)).toBeCloseTo(loanDebt(s), 9);
    const bad = (patch: (o: Record<string, any>) => void) => {
      const o = JSON.parse(json);
      patch(o);
      return deserialize(JSON.stringify(o));
    };
    expect(bad((o) => (o.loan.principal = -5))).toBeNull();
    expect(bad((o) => (o.loan.term = 'x'))).toBeNull();
    expect(bad((o) => (o.managers.reserve = -1))).toBeNull();
    expect(bad((o) => (o.managers.dispatcher = 'yes'))).toBeNull();
    expect(bad((o) => (o.totals.interest = -1))).toBeNull();
    const missing = bad((o) => {
      delete o.loan;
      delete o.managers;
      delete o.totals.salaries;
    })!;
    expect(missing.loan).toBeNull();
    expect(missing.managers).toEqual({ dispatcher: false, mechanic: false, reserve: 0 });
    expect(missing.totals.salaries).toBe(0);
  });

  it('новые цели: «Кредит доверия» открывает кредиты, «Штат специалистов» — персонал', () => {
    const credit = OBJECTIVES.findIndex((o) => o.id === 'credit');
    const staff = OBJECTIVES.findIndex((o) => o.id === 'staff');
    expect(OBJECTIVES[credit - 1].id).toBe('profit_6k');
    expect(OBJECTIVES[credit + 1].id).toBe('engineering');
    expect(OBJECTIVES[staff - 1].id).toBe('refining');
    expect(OBJECTIVES[staff + 1].id).toBe('cash_500k');
    const s = createNewGame(2);
    s.objectiveIndex = credit;
    s.stats.current.produced = 400;
    expect(checkObjectives(s).map((o) => o.id)).toEqual(['credit']);
    expect(s.features).toContain('loans');
    s.objectiveIndex = staff;
    s.research.levels = { yield: 2, energy: 1 };
    expect(checkObjectives(s).map((o) => o.id)).toEqual(['staff']);
    expect(s.features).toContain('managers');
  });
});
