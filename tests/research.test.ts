import { describe, expect, it } from 'vitest';
import {
  build,
  buildCost,
  buildingUpkeep,
  checkObjectives,
  createNewGame,
  demolishRefund,
  depletionFloor,
  deserialize,
  HQ_POS,
  nominalRate,
  OBJECTIVES,
  pumpRate,
  SAVE_VERSION,
  serialize,
  simulateOffline,
  START_CASH,
  startResearch,
  syncOil,
  TECH_IDS,
  TECHS,
  techEffect,
  tick,
  TICK,
  toggleEnabled,
  totalUpkeep,
  type Building,
  type GameState,
  type TechId,
} from '../src/core';
import { legacyMap } from './legacy';

const HX = HQ_POS.x;
const HY = HQ_POS.y;

/** Денежный инвариант вехи 0.4: исследования — отдельный член. */
function expectBalanced(s: GameState, start = START_CASH) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

/**
 * Полигон: месторождений нет, кроме одной клетки (x, y) с запасом reserve из initial; рядом резервуар —
 * качалка качает в него без трубы и без ограничений. Исследования открыты, денег много.
 */
function field(reserve = 50_000, initial = 50_000): { s: GameState; pump: Building; tank: Building } {
  const s = createNewGame(5);
  s.cash = 1e7;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery'];
  s.features = ['research'];
  for (let i = 0; i < s.map.reserve.length; i++) s.map.reserve[i] = s.map.initial[i] = s.map.grade[i] = 0;
  const px = HX + 3;
  const py = HY;
  const i = py * s.map.size + px;
  s.map.reserve[i] = reserve;
  s.map.initial[i] = initial;
  expect(build(s, 'tank', HX + 2, HY)).toEqual({ ok: true });
  const tank = s.buildings[s.buildings.length - 1];
  tank.level = 3; // 800 барр. — склад не ограничивает за время опыта
  expect(build(s, 'pumpjack', px, py)).toEqual({ ok: true });
  const pump = s.buildings[s.buildings.length - 1];
  return { s, pump, tank };
}

/** Шагает по TICK, пока до завершения исследования не останется ровно один шаг. */
function runUntilLastStep(s: GameState): void {
  // Остаток — ровно целое число секунд; последний шаг завершает исследование.
  while (s.research.active && s.research.active.remaining > TICK + 1e-6) tick(s, TICK);
  expect(s.research.active!.remaining).toBeCloseTo(TICK, 6);
}

describe('исследования: действие startResearch', () => {
  it('отказы: не открыто, уже идёт другое, максимум, нет денег — касса и состояние не меняются', () => {
    const s = createNewGame(1);
    s.cash = 1e6;
    expect(startResearch(s, 'yield').ok).toBe(false); // не открыто
    expect(s.totals.research).toBe(0);
    s.features = ['research'];
    expect(startResearch(s, 'yield')).toEqual({ ok: true });
    expect(s.cash).toBe(1e6 - TECHS.yield.levels[0].cost);
    expect(s.totals.research).toBe(TECHS.yield.levels[0].cost);
    const cash = s.cash;
    expect(startResearch(s, 'energy').ok).toBe(false); // идёт другое
    expect(startResearch(s, 'yield').ok).toBe(false);
    expect(s.cash).toBe(cash);
    s.research.active = null;
    s.research.levels.energy = TECHS.energy.levels.length;
    expect(startResearch(s, 'energy').ok).toBe(false); // максимум
    s.cash = TECHS.eor.levels[0].cost - 1;
    expect(startResearch(s, 'eor').ok).toBe(false); // нет денег
    expect(s.research.active).toBeNull();
    expect(s.cash).toBe(TECHS.eor.levels[0].cost - 1);
  });

  it('цена и длительность — по следующему уровню; уровни идут подряд до максимума', () => {
    const s = createNewGame(1);
    s.cash = 1e7;
    s.features = ['research'];
    let spent = 0;
    for (let k = 0; k < TECHS.standard.levels.length; k++) {
      expect(startResearch(s, 'standard')).toEqual({ ok: true });
      expect(s.research.active).toEqual({ id: 'standard', remaining: TECHS.standard.levels[k].time });
      spent += TECHS.standard.levels[k].cost;
      while (s.research.active) tick(s, 1);
      expect(s.research.levels.standard).toBe(k + 1);
    }
    expect(s.totals.research).toBe(spent);
    expect(startResearch(s, 'standard').ok).toBe(false);
    expectBalanced(s, 1e7); // касса задана вручную — инвариант от неё
  });
});

describe('исследования: эффекты на шаге завершения', () => {
  it('yield: номинал и фактическая добыча растут ровно на шаге завершения', () => {
    const { s, pump } = field();
    expect(startResearch(s, 'yield')).toEqual({ ok: true });
    runUntilLastStep(s);
    const before = nominalRate(s, pump);
    const p0 = s.totals.produced;
    tick(s, TICK); // остаток был ровно TICK — этот шаг завершает исследование
    // Уровень действует уже в логистике шага завершения.
    expect(s.research.levels.yield).toBe(1);
    expect(nominalRate(s, pump)).toBeCloseTo(before * 1.08, 9);
    expect(s.totals.produced - p0).toBeCloseTo(pumpRate(s, pump) * TICK, 4);
  });

  it('yield: шаг до завершения добывает по старому номиналу, шаг завершения — по новому', () => {
    const { s } = field();
    expect(startResearch(s, 'yield')).toEqual({ ok: true });
    while (s.research.active!.remaining > 2 * TICK + 1e-6) tick(s, TICK);
    let p = s.totals.produced;
    tick(s, TICK);
    expect(s.research.levels.yield ?? 0).toBe(0);
    const before = (s.totals.produced - p) / TICK;
    p = s.totals.produced;
    tick(s, TICK);
    expect(s.research.levels.yield).toBe(1);
    // За один шаг истощение почти не меняется: добыча шага завершения — ровно в 1,08 раза выше.
    expect((s.totals.produced - p) / TICK / before).toBeCloseTo(1.08, 5);
  });

  it('eor: порог истощения поднимается на шаг на шаге завершения; добыча не выше номинала на максимуме', () => {
    const { s, pump } = field(10_000, 40_000); // остаток — четверть
    expect(depletionFloor(s)).toBeCloseTo(0.4, 12);
    expect(startResearch(s, 'eor')).toEqual({ ok: true });
    while (s.research.active!.remaining > 2 * TICK + 1e-6) tick(s, TICK);
    let p = s.totals.produced;
    tick(s, TICK);
    const nom = nominalRate(s, pump);
    expect(s.totals.produced - p).toBeCloseTo(nom * (0.4 + 0.6 * (s.map.reserve[pump.y * s.map.size + pump.x] / 40_000)) * TICK, 3);
    p = s.totals.produced;
    tick(s, TICK);
    expect(s.research.levels.eor).toBe(1);
    const m1 = 0.4 + TECHS.eor.step;
    expect(depletionFloor(s)).toBeCloseTo(m1, 12);
    const x = s.map.reserve[pump.y * s.map.size + pump.x] / 40_000;
    expect(s.totals.produced - p).toBeCloseTo(nom * (m1 + (1 - m1) * x) * TICK, 3);
    // Максимальный уровень: m = 0,4 + 3·шаг < 1, добыча при любом остатке не больше номинала.
    s.research.levels.eor = 3;
    expect(depletionFloor(s)).toBeCloseTo(0.4 + 3 * TECHS.eor.step, 12);
    expect(depletionFloor(s)).toBeLessThan(1);
    for (const r of [0.001, 10_000, 39_999, 40_000]) {
      s.map.reserve[pump.y * s.map.size + pump.x] = r;
      expect(pumpRate(s, pump)).toBeLessThanOrEqual(nominalRate(s, pump) + 1e-12);
    }
  });

  it('energy: содержание всех зданий, в том числе законсервированных, ×0,93 на шаге завершения', () => {
    const { s, pump, tank } = field();
    expect(toggleEnabled(s, tank.id)).toEqual({ ok: true }); // законсервирован
    const base = totalUpkeep(s);
    const tankBase = buildingUpkeep(tank, s);
    expect(startResearch(s, 'energy')).toEqual({ ok: true });
    while (s.research.active!.remaining > 2 * TICK + 1e-6) tick(s, TICK);
    let e = s.totals.expenses;
    tick(s, TICK);
    expect(s.totals.expenses - e).toBeCloseTo(base * TICK, 9);
    e = s.totals.expenses;
    tick(s, TICK);
    expect(s.research.levels.energy).toBe(1);
    expect(s.totals.expenses - e).toBeCloseTo(base * 0.93 * TICK, 9);
    expect(buildingUpkeep(tank, s)).toBeCloseTo(tankBase * 0.93, 12);
    expect(buildingUpkeep(pump, s)).toBeCloseTo(buildingUpkeep(pump) * 0.93, 12);
  });

  it('standard: цена новой качалки ×0,9 на шаге завершения; построенные и компенсация не меняются', () => {
    const { s, pump } = field();
    const invested = pump.invested;
    const refund = demolishRefund(pump);
    const price = buildCost(s, 'pumpjack');
    const tankPrice = buildCost(s, 'tank');
    expect(startResearch(s, 'standard')).toEqual({ ok: true });
    runUntilLastStep(s);
    expect(buildCost(s, 'pumpjack')).toBe(price);
    tick(s, TICK);
    expect(s.research.levels.standard).toBe(1);
    // Цена округляется до доллара: 500·1,2^n·0,9.
    expect(Math.abs(buildCost(s, 'pumpjack') - price * 0.9)).toBeLessThanOrEqual(1);
    expect(buildCost(s, 'tank')).toBe(tankPrice);
    expect(pump.invested).toBe(invested);
    expect(demolishRefund(pump)).toBe(refund);
  });

  it('эффекты сохраняют запасы: добыто − продано − переработано = Σ хранилищ', () => {
    const { s } = field(30_000, 50_000);
    s.research.levels = { yield: 3, eor: 3 };
    for (let i = 0; i < 600; i++) tick(s, TICK);
    syncOil(s);
    expect(s.totals.produced - s.totals.sold - s.totals.refined).toBeCloseTo(s.oil, 6);
  });
});

describe('исследования: офлайн, деньги, ГСЧ', () => {
  it('завершение одинаково при dt = 0,1 и dt = 1 (офлайн)', () => {
    for (const id of TECH_IDS) {
      const a = field().s;
      const b = field().s;
      expect(startResearch(a, id)).toEqual({ ok: true });
      expect(startResearch(b, id)).toEqual({ ok: true });
      const T = TECHS[id].levels[0].time;
      // За секунду до срока — не завершено ни там, ни там.
      for (let i = 0; i < (T - 1) * 10; i++) tick(a, TICK);
      simulateOffline(b, T - 1);
      expect(a.research.levels[id] ?? 0).toBe(0);
      expect(b.research.levels[id] ?? 0).toBe(0);
      // Ровно в срок — завершено в обоих.
      for (let i = 0; i < 10; i++) tick(a, TICK);
      const report = simulateOffline(b, 1);
      expect(a.research.levels[id]).toBe(1);
      expect(b.research.levels[id]).toBe(1);
      expect(report.researched).toEqual([{ id, level: 1 }]);
      expect(a.time).toBeCloseTo(b.time, 6);
    }
  });

  it('инвариант денег после старта и завершения исследований, в том числе офлайн', () => {
    const s = createNewGame(3);
    s.cash = 500_000;
    s.features = ['research'];
    const start = 500_000;
    expect(startResearch(s, 'energy')).toEqual({ ok: true });
    expectBalanced(s, start);
    for (let i = 0; i < 1300; i++) tick(s, TICK);
    expect(s.research.levels.energy).toBe(1);
    expectBalanced(s, start);
    expect(startResearch(s, 'yield')).toEqual({ ok: true });
    simulateOffline(s, 3600);
    expect(s.research.levels.yield).toBe(1);
    expectBalanced(s, start);
  });

  it('исследования не сдвигают ГСЧ рынка: цены совпадают с игрой без исследований', () => {
    const a = createNewGame(11);
    const b = createNewGame(11);
    b.cash = 1e6;
    b.features = ['research'];
    expect(startResearch(b, 'yield')).toEqual({ ok: true });
    const prices: Array<[number, number]> = [];
    for (let i = 0; i < 3000; i++) {
      tick(a, TICK);
      tick(b, TICK);
      if (i % 100 === 0) prices.push([a.market.price, b.market.price]);
    }
    expect(b.research.levels.yield).toBe(1);
    expect(b.rng).toBe(a.rng);
    for (const [pa, pb] of prices) expect(pb).toBe(pa);
  });
});

describe('исследования: цель и сохранения', () => {
  it('«Инженерный центр» — после «Стабильной прибыли», перед «Переработкой», $3 000, открывает исследования', () => {
    const i = OBJECTIVES.findIndex((o) => o.id === 'engineering');
    // С v7 между ними — «Кредит доверия».
    expect(OBJECTIVES.findIndex((o) => o.id === 'profit_6k')).toBeLessThan(i);
    expect(OBJECTIVES[i + 1].id).toBe('refining');
    expect(OBJECTIVES[i].reward).toBe(3000);
    const s = createNewGame(2);
    s.objectiveIndex = i;
    s.stats.current.produced = 599;
    expect(checkObjectives(s)).toEqual([]);
    expect(s.features).not.toContain('research');
    expect(startResearch({ ...s, cash: 1e6 }, 'yield').ok).toBe(false);
    s.stats.current.produced = 600;
    const cash = s.cash;
    expect(checkObjectives(s).map((o) => o.id)).toEqual(['engineering']);
    expect(s.features).toContain('research');
    expect(s.cash).toBe(cash + 3000);
  });

  /** Сохранение версии 5 из текущего состояния: без полей v6. */
  function asV5(s: GameState): string {
    const old = JSON.parse(serialize(s));
    old.version = 5;
    legacyMap(old);
    delete old.features;
    delete old.research;
    delete old.totals.research;
    return JSON.stringify(old);
  }

  it('миграция v5 → v6 → v7 для каждого номера цели 0–12 (v5): сдвиг, открытие, без наград', () => {
    for (let v5 = 0; v5 <= 12; v5++) {
      const s = createNewGame(8);
      s.cash = 77_777;
      s.objectiveIndex = v5;
      const m = deserialize(asV5(s))!;
      expect(m).not.toBeNull();
      expect(m.version).toBe(SAVE_VERSION);
      expect(m.cash).toBe(77_777); // пропущенные цели наград не дают
      expect(m.totals.rewards).toBe(s.totals.rewards);
      expect(m.totals.research).toBe(0);
      expect(m.research).toEqual({ levels: {}, active: null });
      // v5 → v6 вставляет «Инженерный центр» (10), v6 → v7 — «Кредит доверия» (10) и «Штат специалистов» (после «Переработки»).
      const expected = v5 <= 10 ? v5 : v5 + 3;
      expect(m.objectiveIndex).toBe(expected);
      expect(m.features).toEqual(v5 >= 11 ? ['research', 'loans', 'managers'] : []);
      // Цель по смыслу та же: до 9 — те же id; 10 — первая из новых («Кредит доверия»); 11 и 12 — прежние.
      const v5ids = OBJECTIVES.filter((o) => !['engineering', 'credit', 'staff'].includes(o.id)).map((o) => o.id);
      if (v5 !== 10) expect(OBJECTIVES[m.objectiveIndex]?.id).toBe(v5ids[v5]);
      else expect(OBJECTIVES[m.objectiveIndex].id).toBe('credit');
    }
  });

  it('миграция: игрок на «Переработке» проходит новые цели, затем «Переработка» засчитывается сразу', () => {
    const s = createNewGame(8);
    s.objectiveIndex = 10; // v5: «Переработка»
    s.totals.productsSold = [150, 50, 0];
    const m = deserialize(asV5(s))!;
    m.stats.current.produced = 600;
    const cash = m.cash;
    expect(checkObjectives(m).map((o) => o.id)).toEqual(['credit', 'engineering', 'refining']);
    expect(m.cash).toBe(cash + 2000 + 3000 + 5000); // каждая награда — один раз
    expect(m.features).toContain('research');
  });

  it('сохранение и загрузка с активным исследованием: завершается в тот же момент', () => {
    const a = field().s;
    expect(startResearch(a, 'eor')).toEqual({ ok: true });
    for (let i = 0; i < 500; i++) tick(a, TICK);
    const b = deserialize(serialize(a))!;
    expect(b.research).toEqual(a.research);
    expect(b.totals.research).toBe(a.totals.research);
    while (a.research.active) {
      tick(a, TICK);
      tick(b, TICK);
      expect(b.research.active?.remaining ?? -1).toBeCloseTo(a.research.active?.remaining ?? -1, 9);
    }
    expect(b.research.levels.eor).toBe(1);
    expect(b.time).toBeCloseTo(a.time, 9);
  });

  it('повреждённые данные v6 отклоняются, отсутствующие поля получают значения по умолчанию', () => {
    const s = createNewGame(9);
    s.features = ['research'];
    const ok = JSON.parse(serialize(s));
    const bad = (patch: (o: Record<string, any>) => void) => {
      const o = JSON.parse(JSON.stringify(ok));
      patch(o);
      return deserialize(JSON.stringify(o));
    };
    expect(bad(() => {})).not.toBeNull();
    expect(bad((o) => (o.research.levels.yield = -1))).toBeNull();
    expect(bad((o) => (o.research.levels.yield = 1.5))).toBeNull();
    expect(bad((o) => (o.research.levels.yield = 4))).toBeNull();
    expect(bad((o) => (o.research.levels.magic = 1))).toBeNull();
    expect(bad((o) => (o.research.active = { id: 'magic', remaining: 10 }))).toBeNull();
    expect(bad((o) => (o.research.active = { id: 'yield', remaining: -1 }))).toBeNull();
    expect(bad((o) => (o.research.active = { id: 'yield', remaining: 'x' }))).toBeNull();
    expect(bad((o) => ((o.research.levels.yield = 3), (o.research.active = { id: 'yield', remaining: 5 })))).toBeNull();
    expect(bad((o) => (o.features = ['flying']))).toBeNull();
    expect(bad((o) => (o.totals.research = -5))).toBeNull();
    // Нет полей — значения по умолчанию (В2).
    const missing = bad((o) => {
      delete o.research;
      delete o.features;
      delete o.totals.research;
    })!;
    expect(missing.research).toEqual({ levels: {}, active: null });
    expect(missing.features).toEqual([]);
    expect(missing.totals.research).toBe(0);
  });

  it('оценка эффекта следующего уровня: положительна для парка, «типовой проект» — экономия на качалке', () => {
    const { s } = field(10_000, 40_000);
    for (const id of ['yield', 'eor'] as TechId[]) expect(techEffect(s, id).rate).toBeGreaterThan(0);
    // eor: при полном запасе зоны добыча и так номинальная — прирост нулевой.
    expect(techEffect(field().s, 'eor').rate).toBe(0);
    expect(techEffect(s, 'energy').upkeep).toBeCloseTo(totalUpkeep(s) * 0.07, 9);
    expect(techEffect(s, 'standard').pumpSaving).toBeCloseTo(buildCost(s, 'pumpjack') * 0.1, 0);
  });
});
