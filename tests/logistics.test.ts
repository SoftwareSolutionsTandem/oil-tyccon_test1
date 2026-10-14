import { describe, expect, it } from 'vitest';
import {
  applyConnect,
  autoConnect,
  connectOptions,
  productionCapacity,
  build,
  componentOf,
  createNewGame,
  demolish,
  deserialize,
  getNetwork,
  HQ_POS,
  HQ_STORAGE,
  isConnected,
  lastFlow,
  layPipes,
  manualSellable,
  pipePath,
  PIPES,
  planAutoConnect,
  removePipes,
  sellManual,
  serialize,
  setSellThreshold,
  SAVE_VERSION,
  START_CASH,
  syncOil,
  tick,
  TICK,
  type GameState,
} from '../src/core';
import { Rng } from '../src/core/rng';
import { runBot } from './bot';
import { legacyMap } from './legacy';

/**
 * Полигон: стартовый участок (16..23) без случайных месторождений, контора в (17,17).
 * Месторождения кладём точечно, чтобы потоки считались вручную.
 */
function field(cash = 1e6): GameState {
  const s = createNewGame(5);
  s.cash = cash;
  s.unlocked = ['pumpjack', 'tank', 'terminal'];
  for (let i = 0; i < s.map.reserve.length; i++) s.map.reserve[i] = s.map.initial[i] = 0;
  return s;
}

function deposit(s: GameState, x: number, y: number, amount = 1e6) {
  const i = y * s.map.size + x;
  s.map.reserve[i] = s.map.initial[i] = amount;
}

function pump(s: GameState, x: number, y: number) {
  deposit(s, x, y);
  expect(build(s, 'pumpjack', x, y).ok).toBe(true);
  return s.buildings[s.buildings.length - 1];
}

function run(s: GameState, seconds: number, dt = TICK) {
  for (let i = 0; i < Math.round(seconds / dt); i++) tick(s, dt);
}

/** Нефть нигде не появляется и не исчезает: всё добытое либо лежит в хранилищах, либо продано. */
function expectOilConserved(s: GameState) {
  const stored = s.buildings.reduce((a, b) => a + (b.stored ?? 0), 0);
  expect(stored).toBeCloseTo(s.oil, 6);
  expect(s.totals.produced - s.totals.sold).toBeCloseTo(s.oil, 6);
}

function expectBalanced(s: GameState, start: number) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

const HX = HQ_POS.x;
const HY = HQ_POS.y;

describe('подключение и разрыв', () => {
  it('неподключённая качалка не добывает, подключённая — добывает', () => {
    const s = field();
    const p = pump(s, HX + 4, HY);
    run(s, 10);
    expect(p.status).toBe('no_route');
    expect(s.totals.produced).toBe(0);
    expect(layPipes(s, pipePath([HX + 1, HY], [HX + 3, HY]), 1).ok).toBe(true);
    expect(isConnected(s, p)).toBe(true);
    run(s, 10);
    expect(p.status).toBe('ok');
    expect(s.totals.produced).toBeGreaterThan(1);
    expectOilConserved(s);
  });

  it('качалка вплотную к хранилищу работает без труб', () => {
    const s = field();
    const p = pump(s, HX + 1, HY);
    run(s, 5);
    expect(p.status).toBe('ok');
    expect(getNetwork(s).routes.get(p.id)).toEqual([]);
  });

  it('разрыв трубы останавливает добычу, нефть в хранилище остаётся', () => {
    const s = field();
    const p = pump(s, HX + 4, HY);
    layPipes(s, pipePath([HX + 1, HY], [HX + 3, HY]), 1);
    run(s, 20);
    const before = s.oil;
    expect(removePipes(s, [[HX + 2, HY]]).ok).toBe(true);
    run(s, 20);
    expect(p.status).toBe('no_route');
    expect(s.oil).toBeCloseTo(before, 6);
    expectOilConserved(s);
  });

  it('нельзя прокладывать трубу по чужой земле и строить здание на трубе', () => {
    const s = field();
    expect(layPipes(s, [[0, 0]], 1)).toEqual({ ok: false, reason: 'Трубу можно прокладывать только по своей земле' });
    layPipes(s, [[HX + 2, HY + 2]], 1);
    expect(build(s, 'tank', HX + 2, HY + 2).ok).toBe(false);
  });

  it('автоподключение прокладывает кратчайший путь и переиспользует трубы', () => {
    const s = field();
    const a = pump(s, HX + 5, HY);
    const plan = planAutoConnect(s, a.id);
    expect(plan.ok).toBe(true);
    expect(plan.tiles.length).toBe(4);
    expect(plan.cost).toBe(4 * PIPES[1].cost);
    expect(autoConnect(s, a.id).ok).toBe(true);
    const b = pump(s, HX + 5, HY + 2);
    const plan2 = planAutoConnect(s, b.id);
    expect(plan2.tiles.length).toBe(2); // две новые клетки до уже проложенной трубы (а не 6 до конторы)
  });
});

describe('пропускная способность', () => {
  it('общая труба ограничивает суммарный поток пропорционально', () => {
    const s = field();
    // Три качалки вдоль одной трубы y = HY+1; труба примыкает к конторе через (HX, HY+1).
    layPipes(s, pipePath([HX, HY + 1], [HX + 6, HY + 1]), 1);
    // Качалки по обе стороны трубы: 6 × 0,65 = 3,9 барр./с при пропускной способности промысловой трубы 2.
    const ps = [HX + 2, HX + 4, HX + 6].flatMap((x) => [pump(s, x, HY), pump(s, x, HY + 2)]);
    for (const p of ps) p.level = 3;
    expect(ps.length * 0.65).toBeGreaterThan(PIPES[1].capacity * 1.5);
    // Хранилище побольше, чтобы упиралось именно в трубу.
    expect(build(s, 'tank', HX - 1, HY + 1).ok).toBe(true);
    s.buildings[s.buildings.length - 1].level = 3;
    tick(s, TICK);
    run(s, 10);
    expect(ps.every((p) => p.status === 'throttled')).toBe(true);
    const rate = (s.totals.produced / 10.1);
    expect(rate).toBeLessThanOrEqual(PIPES[1].capacity + 1e-6);
    expect(rate).toBeGreaterThan(PIPES[1].capacity * 0.95);
    // Магистраль снимает ограничение.
    layPipes(s, pipePath([HX, HY + 1], [HX + 6, HY + 1]), 2);
    run(s, 2);
    expect(ps.every((p) => p.status === 'ok')).toBe(true);
    expectOilConserved(s);
  });

  it('перегруженная ветка: остаток потока уходит в другое хранилище по свободной трубе', () => {
    const make = (withTank: boolean) => {
      const s = field();
      layPipes(s, pipePath([HX, HY + 1], [HX + 5, HY + 1]), 1);
      // 4 × 0,65 = 2,6 барр./с при пропускной способности 2.
      const ps = [HX + 2, HX + 4].flatMap((x) => [pump(s, x, HY), pump(s, x, HY + 2)]);
      for (const p of ps) p.level = 3;
      // Резервуар на другом конце трубы: к нему ведут другие клетки, чем к конторе.
      if (withTank) {
        expect(build(s, 'tank', HX + 6, HY + 1).ok).toBe(true);
        s.buildings[s.buildings.length - 1].level = 3;
      }
      run(s, 20);
      return s;
    };
    const one = make(false);
    const two = make(true);
    expect(one.totals.produced / 20).toBeLessThanOrEqual(PIPES[1].capacity + 1e-6);
    expect(two.totals.produced / 20).toBeGreaterThan(PIPES[1].capacity * 1.2);
    expectOilConserved(two);
  });

  it('если все хранилища полны, причина простоя — склад, а не труба', () => {
    const s = field();
    layPipes(s, pipePath([HX, HY + 1], [HX + 6, HY + 1]), 1);
    const ps = [HX + 2, HX + 4, HX + 6].flatMap((x) => [pump(s, x, HY), pump(s, x, HY + 2)]);
    for (const p of ps) p.level = 3;
    run(s, 5);
    expect(ps.every((p) => p.status === 'throttled')).toBe(true);
    run(s, 60); // 60 барр. конторы заполняются за 30 с
    expect(s.oil).toBeCloseTo(HQ_STORAGE, 6);
    expect(ps.every((p) => p.status === 'full')).toBe(true);
  });

  it('результат не зависит от порядка зданий в массиве', () => {
    const make = () => {
      const s = field();
      layPipes(s, pipePath([HX, HY + 1], [HX + 6, HY + 1]), 1);
      for (const x of [HX + 2, HX + 4, HX + 6]) pump(s, x, HY).level = 3;
      return s;
    };
    const a = make();
    const b = make();
    const rng = new Rng(3);
    b.buildings.sort(() => rng.next() - 0.5);
    run(a, 30);
    run(b, 30);
    expect(b.oil).toBeCloseTo(a.oil, 9);
    expect([...b.map.reserve]).toEqual([...a.map.reserve]);
  });
});

describe('подключение с учётом загрузки сети', () => {
  /** Перегруженная промысловая линия у конторы: 4 качалки 3-го ур. (2,6 барр./с) на трубе 2 барр./с. */
  function overloaded() {
    const s = field();
    layPipes(s, pipePath([HX, HY + 1], [HX + 5, HY + 1]), 1);
    const ps = [HX + 2, HX + 4].flatMap((x) => [pump(s, x, HY), pump(s, x, HY + 2)]);
    for (const p of ps) p.level = 3;
    run(s, 2);
    expect(ps.every((p) => p.status === 'throttled')).toBe(true);
    return s;
  }

  it('кратчайшая труба в перегруженную сеть дала бы мало; предлагается отдельная ветка с полным потоком', () => {
    const s = overloaded();
    const p = pump(s, HX + 4, HY + 4);
    p.level = 3;
    const opts = connectOptions(s, p.id);
    const short = opts.find((o) => o.kind === 'short')!;
    const branch = opts.find((o) => o.kind === 'branch')!;
    expect(short).toBeTruthy();
    expect(branch).toBeTruthy();
    expect(short.predicted).toBeLessThan(short.want * 0.9);
    expect(branch.predicted).toBeGreaterThan(branch.want * 0.95);
    expect(branch.total).toBeGreaterThan(short.total);
    // Пропускная способность не увеличивается скрыто: ветка — обычные трубы за обычную цену.
    const cash = s.cash;
    expect(applyConnect(s, branch).ok).toBe(true);
    expect(cash - s.cash).toBe(branch.cost);
    expect(branch.cost).toBe(branch.tiles.length * PIPES[1].cost + branch.upgrades.length * (PIPES[2].cost - PIPES[1].cost));
    const before = s.totals.produced;
    run(s, 10);
    expect(p.status).toBe('ok');
    expect((s.totals.produced - before) / 10).toBeGreaterThan(PIPES[1].capacity + 0.6);
    expectOilConserved(s);
  });

  it('уже подключённой качалке, упёршейся в трубу, предлагается разгрузка отдельной веткой', () => {
    const s = overloaded();
    const p = s.buildings.find((b) => b.type === 'pumpjack' && b.x === HX + 4 && b.y === HY + 2)!;
    const opts = connectOptions(s, p.id);
    expect(opts.some((o) => o.kind === 'short')).toBe(false);
    const branch = opts.find((o) => o.kind === 'branch');
    expect(branch).toBeTruthy();
    expect(branch!.predicted).toBeGreaterThan(lastFlowOf(s, p.id) + 0.05);
  });

  it('альтернативная ветка: после насыщения кратчайшего пути нефть идёт в обход по другой трубе', () => {
    const make = (bypass: boolean) => {
      const s = overloaded();
      // Обход: от конторы с другой стороны (через x = HX−1) до дальнего конца линии.
      if (bypass) {
        layPipes(s, pipePath([HX - 1, HY], [HX - 1, HY + 3]), 1);
        layPipes(s, pipePath([HX, HY + 3], [HX + 5, HY + 3]), 1);
        layPipes(s, [[HX + 5, HY + 2]], 1);
      }
      const before = s.totals.produced;
      run(s, 10);
      return { s, rate: (s.totals.produced - before) / 10 };
    };
    const single = make(false);
    const both = make(true);
    expect(single.rate).toBeLessThanOrEqual(PIPES[1].capacity + 1e-6);
    // Обход забирает почти всё: 2,45 из 2,6 барр./с. Недобор — у качалки, чей единственный вход в сеть —
    // насыщенная клетка основной линии (честное ограничение, а не ошибка распределения).
    expect(both.rate).toBeGreaterThan(single.rate + 0.4);
    expect(both.s.buildings.filter((b) => b.type === 'pumpjack' && b.status === 'ok').length).toBe(3);
    expectOilConserved(both.s);
  });

  it('миграция крупного предприятия не сводит сеть в одну перегруженную клетку', () => {
    // Крупное предприятие (40 минут игры бота) переводится в формат v1: без труб, нефть в общем пуле.
    const s = createNewGame(3);
    runBot(s, 40);
    const old = JSON.parse(serialize(s));
    old.version = 1;
    delete old.map.pipes;
    for (const b of old.buildings) delete b.stored;
    legacyMap(old);
    const migrated = deserialize(JSON.stringify(old))!;
    const pumps = migrated.buildings.filter((b) => b.type === 'pumpjack' && b.enabled);
    expect(pumps.length).toBeGreaterThan(15);
    // Меряем трубы: хранилища пусты, места хватает — добыча должна идти почти на полную мощность.
    for (const b of migrated.buildings) if (b.type === 'hq' || b.type === 'tank') b.stored = 0;
    syncOil(migrated);
    const cap = productionCapacity(migrated);
    const before = migrated.totals.produced;
    run(migrated, 5);
    expect((migrated.totals.produced - before) / 5).toBeGreaterThan(cap * 0.95);
    expect(migrated.buildings.filter((b) => b.status === 'throttled').length).toBe(0);
  }, 30_000);
});

function lastFlowOf(s: GameState, id: number): number {
  return lastFlow(s)?.clients.get(id)?.actual ?? 0;
}

describe('хранилища', () => {
  it('заполненное хранилище сети останавливает добычу этой сети', () => {
    const s = field();
    const p = pump(s, HX + 1, HY);
    run(s, 600);
    expect(s.oil).toBeCloseTo(HQ_STORAGE, 6);
    expect(p.status).toBe('full');
    expectOilConserved(s);
  });

  it('качалка заполняет ближайшее хранилище, затем следующее; отдельная сеть не получает ничего', () => {
    const s = field();
    const p = pump(s, HX + 1, HY); // вплотную к конторе
    expect(build(s, 'tank', HX + 1, HY + 1).ok).toBe(true); // вплотную к качалке? нет — соседство по стороне с конторой нет
    const near = s.buildings[2];
    layPipes(s, [[HX + 2, HY + 1]], 1); // соединяем резервуар с качалкой трубой
    expect(build(s, 'tank', HX + 5, HY + 5).ok).toBe(true); // отдельная сеть
    const far = s.buildings[3];
    const hq = s.buildings[0];
    run(s, 200); // 0,2 барр./с × 200 с = 40 < 60: всё в конторе
    expect(hq.stored).toBeCloseTo(s.totals.produced, 6);
    expect(near.stored).toBe(0);
    run(s, 400); // контора заполнена — дальше резервуар
    expect(hq.stored).toBeCloseTo(HQ_STORAGE, 6);
    expect(near.stored).toBeGreaterThan(0);
    expect(far.stored).toBe(0);
    expect(p.status).toBe('ok');
    expectOilConserved(s);
  });

  it('несколько скважин и хранилищ: подключение и отключение не перемещает и не теряет нефть', () => {
    const s = field();
    pump(s, HX + 1, HY);
    expect(build(s, 'tank', HX + 4, HY + 4).ok).toBe(true);
    const tank = s.buildings[2];
    pump(s, HX + 5, HY + 4);
    run(s, 60);
    const inTank = tank.stored!;
    const inHq = s.buildings[0].stored!;
    expect(inTank).toBeGreaterThan(0); // вторая качалка качает в свой резервуар
    expect(layPipes(s, pipePath([HX, HY + 1], [HX + 4, HY + 3]), 1).ok).toBe(true);
    expect(componentOf(s, tank)).toBe(componentOf(s, s.buildings[0]));
    expect(tank.stored).toBe(inTank);
    expect(s.buildings[0].stored).toBe(inHq);
    run(s, 10);
    expectOilConserved(s);
  });

  it('снос резервуара переливает нефть в сеть или запрещается, если места нет', () => {
    const s = field();
    pump(s, HX + 1, HY);
    build(s, 'tank', HX, HY + 1);
    const tank = s.buildings[2];
    run(s, 30);
    const before = s.oil;
    expect(demolish(s, tank.id).ok).toBe(true);
    expect(s.oil).toBeCloseTo(before, 6);
    expect(s.oil).toBeLessThanOrEqual(HQ_STORAGE + 1e-9);
  });

  it('продажа: перекупщик забирает из всех хранилищ, терминал — только из достижимых по трубам', () => {
    const s = field();
    build(s, 'tank', HX + 6, HY + 6);
    const far = s.buildings[1];
    far.stored = 30;
    s.buildings[0].stored = 20;
    syncOil(s);
    expect(manualSellable(s)).toBeCloseTo(50, 9);
    sellManual(s);
    expect(s.oil).toBe(0);
    far.stored = 100;
    s.buildings[0].stored = 20;
    syncOil(s);
    build(s, 'terminal', HX + 6, HY + 5); // примыкает к дальнему резервуару
    setSellThreshold(s, 0);
    run(s, 10);
    expect(far.stored).toBeCloseTo(90, 6); // 1 барр./с × 10 с
    expect(s.buildings[0].stored).toBe(20); // контора не связана с этим терминалом
  });
});

describe('надёжность', () => {
  it('случайные прокладки и демонтаж труб не создают и не теряют нефть', () => {
    const s = field();
    for (const [x, y] of [[HX + 2, HY + 3], [HX + 5, HY + 1], [HX + 4, HY + 5]]) pump(s, x, y);
    build(s, 'tank', HX + 3, HY);
    const rng = new Rng(9);
    for (let step = 0; step < 300; step++) {
      const x = 16 + rng.int(0, 7);
      const y = 16 + rng.int(0, 7);
      if (rng.next() < 0.6) layPipes(s, [[x, y]], rng.next() < 0.7 ? 1 : 2);
      else removePipes(s, [[x, y]]);
      run(s, 1);
      expectOilConserved(s);
    }
    expect(s.totals.produced).toBeGreaterThan(0);
    expectBalanced(s, 1e6);
  });

  it('пауза (dt = 0 не вызывается), крупный шаг офлайна и мелкий шаг дают сопоставимый итог', () => {
    const a = field();
    const b = field();
    for (const s of [a, b]) {
      pump(s, HX + 1, HY);
      build(s, 'tank', HX, HY + 1);
      s.buildings[2].level = 3;
    }
    run(a, 120, 0.1);
    run(b, 120, 1);
    expect(b.totals.produced).toBeCloseTo(a.totals.produced, 0);
    expectOilConserved(b);
  });
});

describe('сохранения', () => {
  it('сеть и запасы хранилищ переживают сохранение', () => {
    const s = field();
    pump(s, HX + 4, HY);
    layPipes(s, pipePath([HX + 1, HY], [HX + 3, HY]), 2);
    run(s, 20);
    const loaded = deserialize(serialize(s))!;
    expect(loaded.map.pipes).toEqual(s.map.pipes);
    expect(loaded.buildings[0].stored).toBeCloseTo(s.buildings[0].stored!, 9);
    run(loaded, 5);
    expect(loaded.buildings[1].status).toBe('ok');
  });

  it('миграция v1: деньги, нефть, здания и земля сохраняются, старые объекты подключаются', () => {
    // Собираем «старое» предприятие по правилам v1: без труб, нефть в общем пуле.
    const s = createNewGame(7);
    s.cash = 50_000;
    s.unlocked = ['pumpjack', 'tank', 'terminal'];
    const deps: Array<[number, number]> = [];
    for (let y = 16; y < 24; y++) for (let x = 16; x < 24; x++) if (s.map.initial[y * s.map.size + x] > 0) deps.push([x, y]);
    for (const [x, y] of deps) build(s, 'pumpjack', x, y);
    build(s, 'tank', HX + 2, HY);
    build(s, 'terminal', HX, HY + 2);
    s.objectiveIndex = 3;
    const old = JSON.parse(serialize(s));
    old.version = 1;
    delete old.map.pipes;
    delete old.map.grade; // в v1 не было ни труб, ни сортов
    for (const b of old.buildings) {
      delete b.stored;
      delete b.grade;
    }
    old.oil = 123.5;
    legacyMap(old);
    const cashBefore = old.cash;
    const migrated = deserialize(JSON.stringify(old))!;
    expect(migrated.version).toBe(SAVE_VERSION);
    expect(migrated.cash).toBe(cashBefore);
    expect(migrated.oil).toBeCloseTo(123.5, 9);
    expect(migrated.buildings.length).toBe(old.buildings.length);
    expect(migrated.map.owned).toEqual(s.map.owned);
    expect(migrated.objectiveIndex).toBe(4);
    for (const b of migrated.buildings) if (b.type === 'pumpjack' || b.type === 'terminal') expect(isConnected(migrated, b)).toBe(true);
    // Бесплатные трубы не меняют финансовый инвариант.
    run(migrated, 30);
    expectBalanced(migrated, START_CASH + (cashBefore - (START_CASH + s.totals.revenue + s.totals.rewards + s.totals.refunds - s.totals.expenses - s.totals.capex)));
  });
});
