import { describe, expect, it } from 'vitest';
import {
  basketValue,
  build,
  createNewGame,
  demolish,
  deserialize,
  gradePrice,
  HQ_POS,
  layPipes,
  levelSpec,
  MANUAL_SELL_FACTOR,
  OBJECTIVES,
  pipePath,
  PIPES,
  productPrice,
  REFINERY,
  refineryMargin,
  refineryPlan,
  SAVE_VERSION,
  serialize,
  setProductThreshold,
  setRefineryFeed,
  setRefineryMarginOnly,
  simulateOffline,
  START_CASH,
  stepLogistics,
  syncOil,
  tick,
  TICK,
  upgrade,
  type Building,
  type GameState,
} from '../src/core';
import { Rng } from '../src/core/rng';

const HX = HQ_POS.x;
const HY = HQ_POS.y;

/** Полигон: стартовый участок без месторождений, всё открыто, денег много. */
function arena(cash = 1e6): GameState {
  const s = createNewGame(5);
  s.cash = cash;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery'];
  for (let i = 0; i < s.map.reserve.length; i++) s.map.reserve[i] = s.map.initial[i] = s.map.grade[i] = 0;
  return s;
}

function put(s: GameState, type: 'tank' | 'terminal' | 'refinery', x: number, y: number): Building {
  expect(build(s, type, x, y)).toEqual({ ok: true });
  return s.buildings[s.buildings.length - 1];
}

function fill(b: Building, amount: number, grade: 0 | 1) {
  b.stored = amount;
  b.grade = grade;
}

/** Состояние учёта до опыта: нефть в хранилищах и деньги (для инвариантов). */
function snapshot(s: GameState) {
  syncOil(s);
  const stock = [0, 0, 0];
  for (const b of s.buildings) if (b.type === 'refinery') for (let i = 0; i < 3; i++) stock[i] += b.products![i];
  return { oil: s.oil, cash: s.cash, stock, totals: JSON.parse(JSON.stringify(s.totals)) as GameState['totals'] };
}

/** Инварианты 1–4 плана: нефть, продукты, ёмкость складов, деньги. */
function expectInvariants(s: GameState, before: ReturnType<typeof snapshot>) {
  syncOil(s);
  const t = s.totals;
  // 1. Нефть: было + добыто − продано − переработано = в хранилищах.
  expect(before.oil + (t.produced - before.totals.produced) - (t.sold - before.totals.sold) - (t.refined - before.totals.refined)).toBeCloseTo(s.oil, 6);
  // 2. Продукты: произведено − продано = запас; сумма произведённого = переработано.
  const stock = [0, 0, 0];
  for (const b of s.buildings) if (b.type === 'refinery') for (let i = 0; i < 3; i++) stock[i] += b.products![i];
  let made = 0;
  for (let i = 0; i < 3; i++) {
    const madeI = t.productsMade[i] - before.totals.productsMade[i];
    const soldI = t.productsSold[i] - before.totals.productsSold[i];
    expect(before.stock[i] + madeI - soldI).toBeCloseTo(stock[i], 6);
    expect(stock[i]).toBeGreaterThanOrEqual(0);
    made += madeI;
  }
  expect(made).toBeCloseTo(t.refined - before.totals.refined, 6);
  // 4. Склад продукта не превышает ёмкость.
  for (const b of s.buildings) if (b.type === 'refinery') for (const v of b.products!) expect(v).toBeLessThanOrEqual(REFINERY.productCap[b.level - 1]);
  // 3. Деньги.
  expect(s.cash).toBeCloseTo(
    before.cash + (t.revenue - before.totals.revenue) + (t.rewards - before.totals.rewards) + (t.refunds - before.totals.refunds) - (t.expenses - before.totals.expenses) - (t.capex - before.totals.capex),
    6,
  );
}

/** Ищет момент времени, где выполняется условие по ценам (циклы цен детерминированы). */
function findTime(s: GameState, ok: () => boolean): void {
  for (let t = 0; t < 20000; t += 5) {
    s.time = t;
    if (ok()) return;
  }
  throw new Error('нет подходящего момента');
}

describe('НПЗ: конфигурация и цены', () => {
  it('выходы продуктов по каждому сорту дают в сумме ровно 1, потерь нет', () => {
    for (const y of REFINERY.yields) {
      expect(y[0] + y[1] + y[2]).toBe(1);
      for (const v of y) expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(REFINERY.loss).toBe(0);
  });

  it('корзина и маржа воспроизводят расчёты плана (цены без циклов)', () => {
    const s = createNewGame(1);
    const at = (P: number) => {
      s.market.price = P;
      return [basketValue(s, 0, false), basketValue(s, 1, false)];
    };
    expect(at(50)[0]).toBeCloseTo(60.625, 9);
    expect(at(50)[1]).toBeCloseTo(53.125, 9);
    expect(at(30)[0]).toBeCloseTo(48.5, 9);
    expect(at(80)[0]).toBeCloseTo(78.8125, 9);
    s.market.price = 80;
    expect(refineryMargin(s, 0, false)).toBeCloseTo(-1.1875, 9);
    s.market.price = 50;
    expect(productPrice(s, 2, 0, 50, false)).toBeCloseTo(37.5, 9);
    // Сценарий C: все циклы 0,85 — корзина лёгкой 51,53125, тяжёлой 45,15625.
    expect(at(50)[0] * 0.85).toBeCloseTo(51.53125, 9);
    expect(at(50)[1] * 0.85).toBeCloseTo(45.15625, 9);
  });

  it('цены продуктов детерминированы и не сдвигают ГСЧ цены нефти', () => {
    const a = createNewGame(11);
    const b = createNewGame(11);
    b.cash = 1e6;
    b.unlocked.push('refinery');
    put(b, 'refinery', HX + 1, HY); // рядом с конторой
    for (let i = 0; i < 3000; i++) {
      tick(a, TICK);
      tick(b, TICK);
    }
    expect(b.market.price).toBe(a.market.price);
    expect(b.rng).toBe(a.rng);
    expect(productPrice(a, 0)).toBe(productPrice(b, 0));
  });
});

describe('НПЗ: переработка и сорта', () => {
  it('забирает нефть по трубе/вплотную и сразу превращает её в продукты по выходам сорта', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    setRefineryMarginOnly(s, r.id, false);
    fill(s.buildings[0], 50, 0);
    const before = snapshot(s);
    const res = stepLogistics(s, 1);
    expect(res.refined).toBeCloseTo(2, 9); // мощность 1-го уровня, 2 барр./с
    expect(r.products![0]).toBeCloseTo(0.9, 9);
    expect(r.products![1]).toBeCloseTo(0.7, 9);
    expect(r.products![2]).toBeCloseTo(0.4, 9);
    s.totals.refined += res.refined;
    for (let i = 0; i < 3; i++) s.totals.productsMade[i] += res.productsMade[i];
    expectInvariants(s, before);
    expect(r.status).toBe('ok');
  });

  it('фильтр сырья: «тяжёлая» не берёт лёгкую; терминал рядом забирает её целиком', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    setRefineryMarginOnly(s, r.id, false);
    setRefineryFeed(s, r.id, 'heavy');
    const t = put(s, 'terminal', HX, HY + 1);
    fill(s.buildings[0], 30, 0);
    const before = snapshot(s);
    for (let i = 0; i < 10; i++) tick(s, TICK);
    expect(s.totals.refined).toBe(0);
    expect(r.status).toBe('no_feed');
    expect(s.totals.sold).toBeCloseTo(1, 6); // терминал 1 барр./с × 1 с
    expect(t.status).toBe('ok');
    expectInvariants(s, before);
  });

  it('флажок маржи: при отрицательной марже нефть не забирается, статус «невыгодно»', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    fill(s.buildings[0], 30, 0);
    s.market.price = 90;
    findTime(s, () => refineryMargin(s, 0) < -1);
    const before = snapshot(s);
    stepLogistics(s, 0.1);
    expect(s.buildings[0].stored).toBe(30);
    expect(r.status).toBe('waiting_margin');
    // Без флажка — перерабатывает и в минус.
    setRefineryMarginOnly(s, r.id, false);
    stepLogistics(s, 0.1);
    expect(s.buildings[0].stored).toBeCloseTo(29.8, 9);
    void before;
  });

  it('полный склад продукта: нефть не забирается; почти полный — забирается ровно столько, сколько поместится', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    setRefineryMarginOnly(s, r.id, false);
    setProductThreshold(s, 2, 1e6); // мазут не продаётся
    fill(s.buildings[0], 100, 0);
    const cap = REFINERY.productCap[0];
    r.products = [0, 0, cap];
    const before = snapshot(s);
    stepLogistics(s, 1);
    expect(s.buildings[0].stored).toBe(100);
    expect(r.status).toBe('product_full');
    // Свободно 0,1 барр. мазута: лёгкая даёт 20% мазута → переработать можно ~0,5 барр.
    r.products = [0, 0, cap - 0.1];
    const plan = refineryPlan(s, r, 1, 1); // в досягаемости только лёгкая
    expect(plan.need).toBeCloseTo((0.1 - REFINERY.epsCap) / 0.2, 9);
    // Если бы в досягаемости была и тяжёлая — худший выход мазута 0,45.
    expect(refineryPlan(s, r, 1, 3).need).toBeCloseTo((0.1 - REFINERY.epsCap) / 0.45, 9);
    expect(plan.limitedBy).toBe(2);
    stepLogistics(s, 1);
    expect(r.products![2]).toBeLessThanOrEqual(cap);
    expect(100 - s.buildings[0].stored!).toBeCloseTo(plan.need, 9);
    void before;
  });

  it('смесь сортов не переполняет склад: допустимый объём считается по худшему выходу', () => {
    const s = arena();
    // НПЗ между резервуаром лёгкой (слева) и тяжёлой (справа): получает оба сорта в одном шаге.
    const r = put(s, 'refinery', HX + 3, HY + 3);
    setRefineryMarginOnly(s, r.id, false);
    setProductThreshold(s, 2, 1e6);
    const light = put(s, 'tank', HX + 2, HY + 3);
    const heavy = put(s, 'tank', HX + 4, HY + 3);
    fill(light, 0.5, 0);
    fill(heavy, 100, 1);
    const cap = REFINERY.productCap[0];
    r.products = [0, 0, cap - 0.5];
    const plan = refineryPlan(s, r, 1, 3);
    // Худший выход мазута — у тяжёлой (0,45), а не у лёгкой (0,2).
    expect(plan.need).toBeCloseTo((0.5 - REFINERY.epsCap) / 0.45, 9);
    const before = snapshot(s);
    const res = stepLogistics(s, 1);
    expect(res.refinedByGrade[0]).toBeGreaterThan(0);
    expect(res.refinedByGrade[1]).toBeGreaterThan(0);
    expect(r.products![2]).toBeLessThanOrEqual(cap);
    expect(res.refined).toBeLessThanOrEqual(plan.need + 1e-9);
    s.totals.refined += res.refined;
    for (let i = 0; i < 3; i++) s.totals.productsMade[i] += res.productsMade[i];
    expectInvariants(s, before);
  });

  it('порядок причин статуса: склад полон и маржа ≤ 0 → «невыгодно»; без сырья → «нет сырья»', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    r.products = [0, 0, REFINERY.productCap[0]];
    setProductThreshold(s, 2, 1e6);
    stepLogistics(s, 0.1);
    expect(r.status).toBe('no_feed'); // нефти нет вовсе
    fill(s.buildings[0], 30, 0);
    s.market.price = 90;
    findTime(s, () => refineryMargin(s, 0) < -1);
    stepLogistics(s, 0.1);
    expect(r.status).toBe('waiting_margin');
    setRefineryMarginOnly(s, r.id, false);
    stepLogistics(s, 0.1);
    expect(r.status).toBe('product_full');
  });
});

describe('НПЗ: общая очередь с терминалами', () => {
  /** Резервуар с нефтью, вокруг — НПЗ и терминал вплотную (без труб). */
  function contest(order: 'rt' | 'tr', amount: number) {
    const s = arena();
    const tank = put(s, 'tank', HX + 3, HY + 3);
    const make = (k: 'r' | 't') => (k === 'r' ? put(s, 'refinery', HX + 3, HY + 2) : put(s, 'terminal', HX + 3, HY + 4));
    const [a, b] = order === 'rt' ? [make('r'), make('t')] : [make('t'), make('r')];
    const r = a.type === 'refinery' ? a : b;
    setRefineryMarginOnly(s, r.id, false);
    fill(tank, amount, 0);
    const res = stepLogistics(s, 1);
    return { s, res };
  }

  it('одно хранилище делится пропорционально запросам: 1,5 барр. → терминал 0,5, НПЗ 1,0', () => {
    for (const order of ['rt', 'tr'] as const) {
      const { res } = contest(order, 1.5);
      expect(res.sold).toBeCloseTo(0.5, 9);
      expect(res.refined).toBeCloseTo(1.0, 9);
    }
  });

  it('перестановка зданий и идентификаторов не меняет результат', () => {
    const base = contest('rt', 1.5);
    const swapped = contest('tr', 1.5);
    const rng = new Rng(9);
    // Перемешанный массив и переназначенные id при той же геометрии.
    const s = arena();
    const tank = put(s, 'tank', HX + 3, HY + 3);
    const r = put(s, 'refinery', HX + 3, HY + 2);
    const t = put(s, 'terminal', HX + 3, HY + 4);
    setRefineryMarginOnly(s, r.id, false);
    [r.id, t.id] = [t.id, r.id];
    s.buildings.sort(() => rng.next() - 0.5);
    fill(tank, 1.5, 0);
    const res = stepLogistics(s, 1);
    for (const x of [swapped.res, res]) {
      expect(x.sold).toBeCloseTo(base.res.sold, 12);
      expect(x.refined).toBeCloseTo(base.res.refined, 12);
    }
  });

  it('общая перегруженная труба: через неё не больше пропускной способности, доли пропорциональны', () => {
    const s = arena();
    fill(s.buildings[0], 1000, 0);
    // Контора → промысловая труба → развилка: НПЗ и терминал (2-го уровня, 2,5 барр./с) по сторонам конца трубы.
    layPipes(s, pipePath([HX, HY + 1], [HX, HY + 4]), 1);
    const r = put(s, 'refinery', HX - 1, HY + 4);
    const t = put(s, 'terminal', HX + 1, HY + 4);
    upgrade(s, t.id);
    setRefineryMarginOnly(s, r.id, false);
    const before = snapshot(s);
    const res = stepLogistics(s, 1);
    expect(res.sold + res.refined).toBeCloseTo(PIPES[1].capacity, 9);
    expect(res.sold / res.refined).toBeCloseTo(2.5 / 2, 9);
    expect(r.status).toBe('throttled');
    s.totals.refined += res.refined;
    s.totals.sold += res.sold;
    s.totals.revenue += res.revenue;
    s.cash += res.revenue;
    for (let i = 0; i < 3; i++) s.totals.productsMade[i] += res.productsMade[i];
    expectInvariants(s, before);
  });

  it('альтернативный путь: после насыщения кратчайшего пути нефть идёт к НПЗ в обход', () => {
    const make = (bypass: boolean) => {
      const s = arena();
      fill(s.buildings[0], 1000, 0);
      layPipes(s, pipePath([HX, HY + 1], [HX, HY + 4]), 1);
      const r = put(s, 'refinery', HX, HY + 5);
      upgrade(s, r.id); // 4,5 барр./с — больше одной промысловой трубы
      setRefineryMarginOnly(s, r.id, false);
      if (bypass) {
        layPipes(s, pipePath([HX - 1, HY], [HX - 1, HY + 5]), 1);
      }
      return stepLogistics(s, 1);
    };
    expect(make(false).refined).toBeCloseTo(PIPES[1].capacity, 9);
    expect(make(true).refined).toBeGreaterThan(PIPES[1].capacity * 1.5);
  });

  it('клиенты с разными наборами хранилищ: общее делится, недобор уходит к своим следующим', () => {
    const run = (shuffle: boolean) => {
      const s = arena();
      // X — только у НПЗ, Y — общий, Z — только у терминала. Хранилища по диагонали — разные сети.
      const r = put(s, 'refinery', HX + 2, HY + 2);
      const x = put(s, 'tank', HX + 1, HY + 2);
      const y = put(s, 'tank', HX + 2, HY + 3);
      put(s, 'terminal', HX + 3, HY + 3);
      const z = put(s, 'tank', HX + 4, HY + 3);
      setRefineryMarginOnly(s, r.id, false);
      fill(x, 0, 0);
      fill(y, 1.5, 0);
      fill(z, 10, 0);
      if (shuffle) s.buildings.reverse();
      const res = stepLogistics(s, 1);
      return { res, x, y, z };
    };
    const a = run(false);
    const b = run(true);
    // Y: НПЗ просит 2, терминал 1 → 1,0 и 0,5; терминал добирает 0,5 из Z, НПЗ добирать неоткуда.
    expect(a.res.refined).toBeCloseTo(1.0, 9);
    expect(a.res.sold).toBeCloseTo(1.0, 9);
    expect(a.z.stored).toBeCloseTo(9.5, 9);
    expect(b.res.refined).toBeCloseTo(a.res.refined, 12);
    expect(b.res.sold).toBeCloseTo(a.res.sold, 12);
  });

  it('разные наборы по сорту: НПЗ на тяжёлой, терминал берёт лёгкую целиком', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 2, HY + 2);
    const light = put(s, 'tank', HX + 2, HY + 3);
    const heavy = put(s, 'tank', HX + 2, HY + 1);
    put(s, 'terminal', HX + 3, HY + 3);
    setRefineryMarginOnly(s, r.id, false);
    setRefineryFeed(s, r.id, 'heavy');
    fill(light, 1, 0);
    fill(heavy, 50, 1);
    const res = stepLogistics(s, 1);
    expect(res.refinedByGrade[0]).toBe(0);
    expect(res.refinedByGrade[1]).toBeCloseTo(2, 9);
    expect(res.sold).toBeCloseTo(1, 9);
  });
});

describe('НПЗ: продажа продуктов, действия, сохранения', () => {
  it('отгрузка ограничена мощностью и делится пропорционально запасам; порог держит продукт', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    r.enabled = true;
    r.products = [100, 50, 50];
    const res = stepLogistics(s, 1);
    // Мощность 4 барр./с, запас 200 → продаётся 4 барр. пропорционально 100:50:50.
    expect(res.productsSold[0]).toBeCloseTo(2, 9);
    expect(res.productsSold[1]).toBeCloseTo(1, 9);
    expect(res.productsSold[2]).toBeCloseTo(1, 9);
    expect(res.productRevenue).toBeCloseTo(2 * productPrice(s, 0) + productPrice(s, 1) + productPrice(s, 2), 9);
    // Порог мазута выше цены — мазут ждёт, остальные продаются (мощность — на них).
    setProductThreshold(s, 2, 1e6);
    const res2 = stepLogistics(s, 1);
    expect(res2.productsSold[2]).toBe(0);
    expect(res2.productsSold[0] + res2.productsSold[1]).toBeCloseTo(4, 9);
  });

  it('продажа идёт до забора нефти: проданное освобождает место в том же шаге', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    setRefineryMarginOnly(s, r.id, false);
    fill(s.buildings[0], 50, 0);
    const cap = REFINERY.productCap[0];
    r.products = [0, 0, cap]; // мазут полон, но продаётся (порог 0)
    const res = stepLogistics(s, 1);
    expect(res.productsSold[2]).toBeGreaterThan(0);
    expect(res.refined).toBeGreaterThan(0);
  });

  it('инварианты на каждом шаге без подлива (нефть только из конторы)', () => {
    const s = arena(50_000);
    const r = put(s, 'refinery', HX + 1, HY);
    put(s, 'terminal', HX, HY + 1);
    setRefineryMarginOnly(s, r.id, false);
    fill(s.buildings[0], 60, 0);
    const before = snapshot(s);
    for (let i = 0; i < 400; i++) {
      tick(s, TICK);
      expectInvariants(s, before);
    }
    expect(s.totals.refined).toBeGreaterThan(0);
    expect(s.totals.productsSold.reduce((a, v) => a + v, 0)).toBeGreaterThan(0);
  });

  it('снос продаёт остаток продуктов по 80% цены — без потерь, деньги сходятся', () => {
    const s = arena(100_000);
    const r = put(s, 'refinery', HX + 1, HY);
    r.products = [10, 20, 30];
    const before = snapshot(s);
    const expected = (10 * productPrice(s, 0) + 20 * productPrice(s, 1) + 30 * productPrice(s, 2)) * MANUAL_SELL_FACTOR;
    const refund = Math.round(r.invested * 0.5);
    expect(demolish(s, r.id).ok).toBe(true);
    expect(s.totals.productRevenue).toBeCloseTo(expected, 9);
    expect(s.cash - before.cash).toBeCloseTo(expected + refund, 9);
    expect(s.totals.productsSold).toEqual([10, 20, 30]);
    // Учёт продуктов: произведено 0 в опыте, но запас был задан вручную — проверяем деньги.
    expect(s.cash).toBeCloseTo(before.cash + (s.totals.revenue - before.totals.revenue) + (s.totals.refunds - before.totals.refunds), 9);
  });

  it('улучшение повышает мощность, склад и отгрузку', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    upgrade(s, r.id);
    expect(levelSpec(r).value).toBe(4.5);
    setRefineryMarginOnly(s, r.id, false);
    fill(s.buildings[0], 50, 0);
    expect(stepLogistics(s, 1).refined).toBeCloseTo(4.5, 9);
  });

  it('офлайн (шаг 1 с) и обычный шаг дают сопоставимый итог и сохраняют инварианты', () => {
    const make = () => {
      const s = arena(50_000);
      const r = put(s, 'refinery', HX + 1, HY);
      put(s, 'terminal', HX, HY + 1);
      setRefineryMarginOnly(s, r.id, false);
      fill(s.buildings[0], 60, 0);
      return s;
    };
    const a = make();
    const b = make();
    const ba = snapshot(a);
    const bb = snapshot(b);
    for (let i = 0; i < 600; i++) tick(a, TICK);
    simulateOffline(b, 60);
    expectInvariants(a, ba);
    expectInvariants(b, bb);
    expect(b.totals.refined).toBeCloseTo(a.totals.refined, 0);
  });

  it('сохранение и загрузка сохраняют НПЗ, продукты, настройки и пороги', () => {
    const s = arena();
    const r = put(s, 'refinery', HX + 1, HY);
    r.products = [1, 2, 3];
    setRefineryFeed(s, r.id, 'light');
    setRefineryMarginOnly(s, r.id, false);
    setProductThreshold(s, 1, 70);
    const t = deserialize(serialize(s))!;
    const r2 = t.buildings.find((b) => b.type === 'refinery')!;
    expect(r2.products).toEqual([1, 2, 3]);
    expect(r2.feed).toBe('light');
    expect(r2.marginOnly).toBe(false);
    expect(t.productThresholds).toEqual([0, 70, 0]);
  });

  it('миграция v4 → v5: поля учёта нулевые, пороги 0, цель сдвинута, НПЗ открыт после «Стабильной прибыли»', () => {
    const s = createNewGame(4);
    s.cash = 12345;
    s.objectiveIndex = 10; // в v4 это «Нефтяная компания» — «Стабильная прибыль» пройдена
    const old = JSON.parse(serialize(s));
    old.version = 4;
    delete old.productThresholds;
    for (const k of ['refined', 'productsMade', 'productsSold', 'productRevenue']) delete old.totals[k];
    delete old.stats.current.refined;
    delete old.stats.current.productRevenue;
    old.unlocked = ['pumpjack', 'tank', 'terminal'];
    const m = deserialize(JSON.stringify(old))!;
    expect(m.version).toBe(SAVE_VERSION);
    expect(m.cash).toBe(12345);
    expect(m.productThresholds).toEqual([0, 0, 0]);
    expect(m.totals.refined).toBe(0);
    expect(m.totals.productsSold).toEqual([0, 0, 0]);
    expect(m.objectiveIndex).toBe(11);
    expect(OBJECTIVES[m.objectiveIndex].id).toBe('cash_500k');
    expect(m.unlocked).toContain('refinery');
    // Раньше «Стабильной прибыли» — номер и открытые здания не меняются.
    old.objectiveIndex = 5;
    const m2 = deserialize(JSON.stringify(old))!;
    expect(m2.objectiveIndex).toBe(5);
    expect(m2.unlocked).not.toContain('refinery');
  });

  it('цель «Переработка» открывается «Стабильной прибылью» и даёт награду', () => {
    const i = OBJECTIVES.findIndex((o) => o.id === 'refining');
    expect(OBJECTIVES[i - 1].id).toBe('profit_6k');
    expect(OBJECTIVES[i - 1].unlocks).toContain('refinery');
    expect(OBJECTIVES[i].reward).toBe(5000);
    expect(START_CASH).toBeGreaterThan(0);
    expect(gradePrice(createNewGame(1), 0)).toBeGreaterThan(0);
  });
});
