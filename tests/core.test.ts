import { describe, expect, it } from 'vitest';
import {
  canBuild,
  pumpOrientAt,
  autoConnect,
  isConnected,
  syncOil,
  build,
  buildCost,
  buyParcel,
  createNewGame,
  demolish,
  deserialize,
  HQ_STORAGE,
  lastMinute,
  MANUAL_SELL_FACTOR,
  PARCEL_SIZE,
  sellManual,
  serialize,
  setSellThreshold,
  simulateOffline,
  START_CASH,
  START_PARCEL,
  storageCapacity,
  tick,
  TICK,
  upgrade,
  type GameState,
} from '../src/core';

function depositTiles(s: GameState): Array<{ x: number; y: number }> {
  const out = [];
  for (let y = 0; y < s.map.size; y++)
    for (let x = 0; x < s.map.size; x++) if (s.map.initial[y * s.map.size + x] > 0) out.push({ x, y });
  return out;
}

function ownedDeposits(s: GameState) {
  const x0 = START_PARCEL.px * PARCEL_SIZE;
  const y0 = START_PARCEL.py * PARCEL_SIZE;
  return depositTiles(s).filter((t) => t.x >= x0 && t.x < x0 + PARCEL_SIZE && t.y >= y0 && t.y < y0 + PARCEL_SIZE);
}

function freeOwnedTile(s: GameState) {
  const x0 = START_PARCEL.px * PARCEL_SIZE;
  const y0 = START_PARCEL.py * PARCEL_SIZE;
  for (let y = y0; y < y0 + PARCEL_SIZE; y++)
    for (let x = x0; x < x0 + PARCEL_SIZE; x++)
      if (s.map.initial[y * s.map.size + x] === 0 && !s.map.pipes[y * s.map.size + x] && !s.buildings.some((b) => b.x === x && b.y === y)) return { x, y };
  throw new Error('нет свободной клетки');
}

/** Оставляет у клетки только собственные запасы: соседние клетки месторождения обнуляются. */
function isolate(s: GameState, x: number, y: number, amount: number) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const j = (y + dy) * s.map.size + x + dx;
    s.map.reserve[j] = s.map.initial[j] = 0;
  }
  const i = y * s.map.size + x;
  s.map.reserve[i] = s.map.initial[i] = amount;
  return i;
}

/** Подключает трубами все неподключённые здания — как сделал бы аккуратный игрок. */
function connectAll(s: GameState) {
  for (const type of ['tank', 'pumpjack', 'terminal'])
    for (const b of s.buildings) if (b.type === type && !isConnectedAny(s, b)) autoConnect(s, b.id);
}

function isConnectedAny(s: GameState, b: GameState['buildings'][number]) {
  return b.type === 'tank' ? false : isConnected(s, b);
}

/** Кладёт нефть в контору (тесты продаж). */
function putOil(s: GameState, amount: number) {
  s.buildings.find((b) => b.type === 'hq')!.stored = amount;
  syncOil(s);
}

function run(s: GameState, seconds: number) {
  connectAll(s);
  for (let i = 0; i < Math.round(seconds / TICK); i++) tick(s, TICK);
}

/** Деньги всегда объясняются потоками: так экономика остаётся прозрачной для игрока. */
function expectBalanced(s: GameState, startCash = START_CASH) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(startCash + t.revenue + t.rewards + t.refunds - t.expenses - t.capex, 6);
}

describe('новая игра', () => {
  it('создаёт контору, стартовый участок и месторождение', () => {
    const s = createNewGame(42);
    expect(s.buildings).toHaveLength(1);
    expect(s.buildings[0].type).toBe('hq');
    expect(storageCapacity(s)).toBe(HQ_STORAGE);
    expect(s.map.owned.filter(Boolean)).toHaveLength(1);
    expect(ownedDeposits(s).length).toBeGreaterThanOrEqual(6);
  });

  it('генерация карты детерминирована по seed', () => {
    expect(createNewGame(7).map).toEqual(createNewGame(7).map);
  });
});

describe('строительство', () => {
  it('качалка строится только на своём месторождении и при наличии денег', () => {
    const s = createNewGame(1);
    const deposit = ownedDeposits(s)[0];
    const plain = freeOwnedTile(s);
    expect(build(s, 'pumpjack', plain.x, plain.y).ok).toBe(false);
    expect(build(s, 'pumpjack', 0, 0).ok).toBe(false);
    expect(build(s, 'tank', plain.x, plain.y).ok).toBe(false); // ещё не открыт
    expect(build(s, 'pumpjack', deposit.x, deposit.y).ok).toBe(true);
    expect(build(s, 'pumpjack', deposit.x, deposit.y).ok).toBe(false);
    s.cash = 0;
    const other = ownedDeposits(s)[1];
    expect(build(s, 'pumpjack', other.x, other.y)).toEqual({ ok: false, reason: 'Недостаточно денег' });
  });

  it('стоимость растёт с количеством зданий', () => {
    const s = createNewGame(1);
    const first = buildCost(s, 'pumpjack');
    const d = ownedDeposits(s)[0];
    build(s, 'pumpjack', d.x, d.y);
    expect(buildCost(s, 'pumpjack')).toBeGreaterThan(first);
  });

  it('снос возвращает половину вложений', () => {
    const s = createNewGame(1);
    const d = ownedDeposits(s)[0];
    const cost = buildCost(s, 'pumpjack');
    build(s, 'pumpjack', d.x, d.y);
    const cashBefore = s.cash;
    const id = s.buildings[1].id;
    expect(demolish(s, id).ok).toBe(true);
    expect(s.cash - cashBefore).toBe(Math.round(cost / 2));
    expect(demolish(s, s.buildings[0].id).ok).toBe(false); // контора
    expectBalanced(s);
  });
});

describe('добыча и хранение', () => {
  it('добыча не превышает ёмкость хранилища, качалка простаивает при заполнении', () => {
    const s = createNewGame(3);
    const d = ownedDeposits(s)[0];
    build(s, 'pumpjack', d.x, d.y);
    run(s, 600);
    expect(s.oil).toBeCloseTo(HQ_STORAGE, 6);
    expect(s.buildings[1].status).toBe('full');
  });

  it('добытое равно убыли запасов месторождений', () => {
    const s = createNewGame(3);
    const before = s.map.reserve.reduce((a, b) => a + b, 0);
    s.cash = 1e6;
    for (const d of ownedDeposits(s)) build(s, 'pumpjack', d.x, d.y);
    expect(s.buildings.filter((b) => b.type === 'pumpjack').length).toBeGreaterThanOrEqual(2);
    run(s, 100);
    const after = s.map.reserve.reduce((a, b) => a + b, 0);
    expect(before - after).toBeCloseTo(s.totals.produced, 6);
    expect(s.totals.produced).toBeCloseTo(s.oil, 6);
  });

  it('месторождение истощается, добыча падает и останавливается', () => {
    const s = createNewGame(3);
    const d = ownedDeposits(s)[0];
    const i = isolate(s, d.x, d.y, 5);
    s.cash = 1e6;
    build(s, 'pumpjack', d.x, d.y);
    run(s, 120);
    expect(s.map.reserve[i]).toBe(0);
    expect(s.buildings[1].status).toBe('depleted');
    expect(s.oil).toBeCloseTo(5, 6);
  });
});

describe('продажи', () => {
  it('ручная продажа идёт со скидкой перекупщика', () => {
    const s = createNewGame(5);
    putOil(s, 50);
    const price = s.market.price;
    const r = sellManual(s);
    expect(r.ok).toBe(true);
    expect(s.oil).toBe(0);
    expect(s.totals.revenue).toBeCloseTo(50 * price * MANUAL_SELL_FACTOR, 6);
    expect(lastMinute(s).sold).toBe(50);
    expectBalanced(s);
  });

  it('терминал продаёт автоматически и уважает минимальную цену', () => {
    const s = createNewGame(5);
    s.unlocked.push('terminal');
    s.cash = 1e6;
    const t = freeOwnedTile(s);
    build(s, 'terminal', t.x, t.y);
    connectAll(s);
    putOil(s, 50);
    setSellThreshold(s, 1000);
    run(s, 5);
    expect(s.oil).toBe(50);
    expect(s.buildings[1].status).toBe('waiting_price');
    setSellThreshold(s, 0);
    run(s, 5);
    expect(s.oil).toBeCloseTo(45, 6);
    expectBalanced(s, 1e6);
  });
});

describe('земля и улучшения', () => {
  it('покупать можно только соседние участки', () => {
    const s = createNewGame(2);
    s.cash = 1e6;
    expect(buyParcel(s, 0, 0).ok).toBe(false);
    expect(buyParcel(s, START_PARCEL.px + 1, START_PARCEL.py).ok).toBe(true);
    expect(buyParcel(s, START_PARCEL.px + 2, START_PARCEL.py).ok).toBe(true);
    expectBalanced(s, 1e6);
  });

  it('улучшение повышает уровень и ограничено максимумом', () => {
    const s = createNewGame(2);
    s.cash = 1e6;
    const d = ownedDeposits(s)[0];
    build(s, 'pumpjack', d.x, d.y);
    const id = s.buildings[1].id;
    expect(upgrade(s, id).ok).toBe(true);
    expect(upgrade(s, id).ok).toBe(true);
    expect(upgrade(s, id).ok).toBe(false);
    expect(s.buildings[1].level).toBe(3);
  });
});

describe('цели', () => {
  it('продажа 100 баррелей открывает резервуар и даёт награду', () => {
    const s = createNewGame(9);
    const d = ownedDeposits(s)[0];
    build(s, 'pumpjack', d.x, d.y);
    tick(s, TICK);
    expect(s.objectiveIndex).toBe(1); // следующая цель — подключить качалку
    connectAll(s);
    tick(s, TICK);
    expect(s.objectiveIndex).toBe(2);
    putOil(s, 100);
    sellManual(s);
    const events = tick(s, TICK);
    expect(events.completed.map((o) => o.id)).toEqual(['first_sales']);
    expect(s.unlocked).toContain('tank');
    expectBalanced(s);
  });
});

describe('детерминизм, сохранения, офлайн', () => {
  it('одинаковые действия дают одинаковый результат', () => {
    const a = createNewGame(11);
    const b = createNewGame(11);
    for (const s of [a, b]) {
      const d = ownedDeposits(s)[0];
      build(s, 'pumpjack', d.x, d.y);
      run(s, 300);
    }
    expect(a).toEqual({ ...b, savedAt: a.savedAt });
  });

  it('сохранение и загрузка без потерь', () => {
    const s = createNewGame(13);
    const d = ownedDeposits(s)[0];
    build(s, 'pumpjack', d.x, d.y);
    run(s, 30);
    const loaded = deserialize(serialize(s));
    expect(loaded).toEqual(s);
  });

  it('повреждённое сохранение отклоняется', () => {
    expect(deserialize('{oops')).toBeNull();
    expect(deserialize('{"version":1}')).toBeNull();
    expect(deserialize('{"version":999}')).toBeNull();
  });

  it('офлайн-прогресс добывает нефть и сходится по деньгам', () => {
    const s = createNewGame(17);
    s.unlocked.push('terminal', 'tank');
    s.cash = 1e5;
    for (const d of ownedDeposits(s)) build(s, 'pumpjack', d.x, d.y);
    const t = freeOwnedTile(s);
    build(s, 'terminal', t.x, t.y);
    connectAll(s);
    const report = simulateOffline(s, 3600);
    expect(report.seconds).toBe(3600);
    expect(report.produced).toBeGreaterThan(1000);
    expect(report.revenue).toBeGreaterThan(report.expenses);
    expectBalanced(s, 1e5);
  });
});

describe('прогноз истощения', () => {
  it('совпадает с симуляцией', async () => {
    const { timeToDeplete } = await import('../src/core');
    const s = createNewGame(21);
    s.unlocked.push('terminal');
    s.cash = 1e6;
    const d = ownedDeposits(s)[0];
    const i = isolate(s, d.x, d.y, 40);
    build(s, 'pumpjack', d.x, d.y);
    const t = freeOwnedTile(s);
    build(s, 'terminal', t.x, t.y); // терминал не даёт складу переполниться
    connectAll(s);
    const predicted = timeToDeplete(s, s.buildings[1]);
    let elapsed = 0;
    while (s.map.reserve[i] > 1e-6 && elapsed < 10_000) {
      tick(s, TICK);
      elapsed += TICK;
    }
    // Хвост истощения асимптотически не бесконечен (добыча не ниже 40%), поэтому прогноз точен до шага.
    expect(Math.abs(elapsed - predicted)).toBeLessThan(predicted * 0.02 + 1);
  });
});

describe('расстановка скважин и зона дренирования', () => {
  it('качалки ставятся рядами бок о бок; ряд не поворачивает и не примыкает к соседнему ряду', () => {
    const s = createNewGame(4);
    s.cash = 1e6;
    const x = 18;
    const y = 18;
    for (let dy = 0; dy < 4; dy++)
      for (let dx = 0; dx < 4; dx++) {
        const i = (y + dy) * s.map.size + x + dx;
        s.map.reserve[i] = s.map.initial[i] = 1000;
      }
    // Ряд вдоль x: соседи по стороне разрешены, балансиры разворачиваются поперёк ряда (вдоль y).
    for (const dx of [0, 1, 2]) expect(build(s, 'pumpjack', x + dx, y).ok).toBe(true);
    expect(pumpOrientAt(s, x + 1, y)).toBe(2);
    // Поворот ряда и вплотную примыкающий ряд запрещены — с понятной причиной.
    const turn = canBuild(s, 'pumpjack', x, y + 1);
    expect(turn.ok).toBe(false);
    expect(turn.ok ? '' : turn.reason).toMatch(/проход/);
    expect(canBuild(s, 'pumpjack', x + 3, y + 1).ok).toBe(true); // по диагонали к концу ряда — можно
    // Через проход — новый параллельный ряд.
    for (const dx of [0, 1, 2]) expect(build(s, 'pumpjack', x + dx, y + 2).ok).toBe(true);
    expect(s.buildings.filter((b) => b.type === 'pumpjack').length).toBe(6);
    expect(build(s, 'pumpjack', x + 3, y + 2).ok).toBe(true); // продолжение ряда
  });

  it('ориентация выводится из расстановки; старый сплошной блок отображается по-старому и работает', () => {
    const s = createNewGame(4);
    s.cash = 1e6;
    const x = 18;
    const y = 18;
    // Блок 2×2 вплотную из старых сохранений (до правила рядов) — добавлен напрямую.
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const i = (y + dy) * s.map.size + x + dx;
      s.map.reserve[i] = s.map.initial[i] = 1000;
      s.buildings.push({ id: s.nextId++, type: 'pumpjack', x: x + dx, y: y + dy, level: 1, enabled: true, invested: 500, status: 'ok' });
    }
    for (const b of s.buildings.filter((o) => o.type === 'pumpjack')) expect(pumpOrientAt(s, b.x, b.y)).toBe(0);
    connectAll(s);
    run(s, 30);
    expect(s.buildings.filter((b) => b.type === 'pumpjack').every((b) => b.status === 'ok' || b.status === 'full')).toBe(true);
    expect(s.totals.produced).toBeGreaterThan(0);
    // Одиночная качалка — по диагонали, ряд вдоль y — балансир вдоль x.
    const t = createNewGame(4);
    t.cash = 1e6;
    for (const dy of [0, 1]) {
      const i = (y + dy) * t.map.size + x;
      t.map.reserve[i] = t.map.initial[i] = 1000;
    }
    build(t, 'pumpjack', x, y);
    expect(pumpOrientAt(t, x, y)).toBe(0);
    build(t, 'pumpjack', x, y + 1);
    expect(pumpOrientAt(t, x, y)).toBe(1);
  });

  it('скважина тянет нефть из соседних клеток месторождения равномерно', async () => {
    const { drainageTiles } = await import('../src/core');
    const s = createNewGame(4);
    s.cash = 1e6;
    const x = 20;
    const y = 20;
    const own = isolate(s, x, y, 1000);
    const side = y * s.map.size + x + 1;
    s.map.reserve[side] = s.map.initial[side] = 1000;
    build(s, 'pumpjack', x, y);
    expect(drainageTiles(s, s.buildings[1])).toEqual([own, side]);
    s.unlocked.push('terminal');
    const t = freeOwnedTile(s);
    build(s, 'terminal', t.x, t.y);
    run(s, 200);
    expect(s.map.reserve[own]).toBeLessThan(1000);
    expect(s.map.reserve[own]).toBeCloseTo(s.map.reserve[side], 6);
    expect(2000 - s.map.reserve[own] - s.map.reserve[side]).toBeCloseTo(s.totals.produced, 6);
  });

  it('две скважины, делящие клетку, не уводят запасы в минус', () => {
    const s = createNewGame(4);
    s.cash = 1e6;
    s.unlocked.push('terminal');
    const x = 20;
    const y = 20;
    for (let dy = -2; dy <= 3; dy++)
      for (let dx = -2; dx <= 3; dx++) {
        const i = (y + dy) * s.map.size + x + dx;
        s.map.reserve[i] = s.map.initial[i] = dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1 ? 30 : 0;
      }
    build(s, 'pumpjack', x, y);
    build(s, 'pumpjack', x + 1, y + 1);
    const t = freeOwnedTile(s);
    build(s, 'terminal', t.x, t.y);
    run(s, 600);
    expect(Math.min(...s.map.reserve)).toBeGreaterThanOrEqual(0);
    expect(s.totals.produced).toBeCloseTo(120, 6);
    expect(s.buildings.filter((b) => b.type === 'pumpjack').every((b) => b.status === 'depleted')).toBe(true);
  });
});
