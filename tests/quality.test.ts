import { describe, expect, it } from 'vitest';
import {
  build,
  createNewGame,
  deserialize,
  GRADES,
  gradePrice,
  heavySpread,
  HQ_POS,
  layPipes,
  manualSellPrice,
  manualSellValue,
  oilByGrade,
  PIPES,
  pipePath,
  pumpGrade,
  SAVE_VERSION,
  sellManual,
  serialize,
  setSellThreshold,
  simulateOffline,
  START_PARCEL,
  PARCEL_SIZE,
  tick,
  TICK,
  isParcelOwned,
  type GameState,
} from '../src/core';

const HX = HQ_POS.x;
const HY = HQ_POS.y;

/** Полигон без месторождений; клетки кладём вручную со своим сортом. */
function field(cash = 1e6): GameState {
  const s = createNewGame(5);
  s.cash = cash;
  s.unlocked = ['pumpjack', 'tank', 'terminal'];
  for (let i = 0; i < s.map.reserve.length; i++) s.map.reserve[i] = s.map.initial[i] = s.map.grade[i] = 0;
  return s;
}

function pump(s: GameState, x: number, y: number, grade: 0 | 1, amount = 1e6) {
  const i = y * s.map.size + x;
  s.map.reserve[i] = s.map.initial[i] = amount;
  s.map.grade[i] = grade;
  expect(build(s, 'pumpjack', x, y).ok).toBe(true);
  return s.buildings[s.buildings.length - 1];
}

function run(s: GameState, seconds: number, dt = TICK, check?: () => void) {
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    tick(s, dt);
    check?.();
  }
}

function expectConserved(s: GameState) {
  const stored = s.buildings.reduce((a, b) => a + (b.stored ?? 0), 0);
  expect(stored).toBeCloseTo(s.oil, 6);
  expect(s.totals.produced - s.totals.sold).toBeCloseTo(s.oil, 6);
  const [l, h] = oilByGrade(s);
  expect(l + h).toBeCloseTo(s.oil, 6);
}

function expectBalanced(s: GameState, start: number) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds - t.expenses - t.capex, 6);
}

/** Следит, что хранилище не меняет сорт, пока в нём есть нефть (сорта не смешиваются). */
function gradeWatcher(s: GameState) {
  const last = new Map<number, number>();
  return () => {
    for (const b of s.buildings) {
      if (b.type !== 'hq' && b.type !== 'tank') continue;
      const has = (b.stored ?? 0) > 1e-9;
      const prev = last.get(b.id);
      if (has && prev !== undefined) expect(b.grade).toBe(prev);
      if (has) last.set(b.id, b.grade ?? 0);
      else last.delete(b.id);
    }
  };
}

describe('сорта нефти: генерация', () => {
  it('стартовый участок — лёгкая нефть; месторождение целиком одного сорта; тяжёлые встречаются', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = createNewGame(seed);
      const n = s.map.size;
      let heavy = 0;
      for (let i = 0; i < n * n; i++) {
        if (s.map.initial[i] <= 0) continue;
        const x = i % n;
        const y = Math.floor(i / n);
        if (Math.floor(x / PARCEL_SIZE) === START_PARCEL.px && Math.floor(y / PARCEL_SIZE) === START_PARCEL.py) expect(s.map.grade[i]).toBe(0);
        if (s.map.grade[i] === 1) heavy++;
        // Соседняя клетка месторождения — того же сорта: зона дренирования не смешивает сорта.
        for (const j of [i + 1, i + n]) if (j < n * n && s.map.initial[j] > 0 && (j !== i + 1 || x + 1 < n)) expect(s.map.grade[j]).toBe(s.map.grade[i]);
      }
      expect(heavy).toBeGreaterThan(0);
    }
  });
});

describe('сорта нефти: добыча и хранение', () => {
  it('качалка добывает сорт своего месторождения; станок 1-го уровня тянет тяжёлую медленнее', () => {
    const s = field();
    const light = pump(s, HX + 1, HY, 0); // вплотную к конторе
    const t = field();
    const heavy = pump(t, HX + 1, HY, 1);
    expect(pumpGrade(s, light)).toBe(0);
    expect(pumpGrade(t, heavy)).toBe(1);
    run(s, 10);
    run(t, 10);
    expect(t.totals.produced / s.totals.produced).toBeCloseTo(GRADES[1].level1Rate, 3);
    expect(t.buildings[0].grade).toBe(1);
    // Со 2-го уровня разницы нет.
    light.level = 2;
    heavy.level = 2;
    const a = s.totals.produced;
    const b = t.totals.produced;
    run(s, 10);
    run(t, 10);
    expect(t.totals.produced - b).toBeCloseTo(s.totals.produced - a, 4);
    expectConserved(t);
  });

  it('хранилище хранит один сорт: тяжёлая не идёт в контору с лёгкой, а занимает пустой резервуар', () => {
    const s = field();
    const watch = gradeWatcher(s);
    pump(s, HX + 1, HY, 0);
    const h = pump(s, HX, HY + 2, 1); // через клетку от конторы
    layPipes(s, [[HX, HY + 1]], 1);
    run(s, 5, TICK, watch);
    // Контора успела принять один сорт; второй ждёт своего хранилища.
    const hq = s.buildings[0];
    const stuck = hq.grade === 0 ? h : s.buildings[1];
    expect(stuck.status).toBe('wrong_grade');
    const before = s.totals.produced;
    run(s, 5, TICK, watch);
    const onlyOne = s.totals.produced - before;
    // Пустой резервуар рядом с качалкой — и второй сорт пошёл в него.
    expect(build(s, 'tank', stuck.x - 1, stuck.y).ok).toBe(true);
    const tank = s.buildings[s.buildings.length - 1];
    run(s, 5, TICK, watch);
    expect(stuck.status).toBe('ok');
    expect(tank.grade).toBe(pumpGrade(s, stuck));
    expect(s.totals.produced - before - onlyOne).toBeGreaterThan(onlyOne * 0.5);
    expectConserved(s);
  });

  it('два сорта в один пустой резервуар в одном тике: принимается один, второй — в другое хранилище', () => {
    const s = field();
    const watch = gradeWatcher(s);
    // Общий резервуар справа, оба сорта подходят к нему с разных сторон; контора тоже достижима.
    expect(build(s, 'tank', HX + 4, HY + 2).ok).toBe(true);
    const tank = s.buildings[1];
    pump(s, HX + 4, HY + 1, 0);
    pump(s, HX + 4, HY + 3, 1).level = 3; // тяжёлой больше — она и займёт резервуар
    layPipes(s, pipePath([HX + 3, HY + 3], [HX, HY + 3]), 1);
    layPipes(s, pipePath([HX, HY + 2], [HX, HY + 1]), 1);
    layPipes(s, pipePath([HX + 3, HY + 1], [HX + 1, HY + 1]), 1);
    tick(s, TICK);
    watch();
    expect(tank.grade).toBe(1);
    run(s, 20, TICK, watch);
    expect(s.buildings[0].grade).toBe(0);
    expect(oilByGrade(s)[0]).toBeGreaterThan(0);
    expect(oilByGrade(s)[1]).toBeGreaterThan(0);
    expectConserved(s);
  });

  it('трубы переносят оба сорта, пропускная способность — общая', () => {
    const s = field();
    expect(build(s, 'tank', HX - 1, HY + 1).ok).toBe(true);
    layPipes(s, pipePath([HX, HY + 1], [HX + 5, HY + 1]), 1);
    // Лёгкая и тяжёлая на одной линии: 2 × 0,65 + 2 × 0,65 = 2,6 барр./с при пропускной способности 2.
    for (const [x, g] of [[HX + 2, 0], [HX + 4, 1]] as const) {
      pump(s, x, HY, g).level = 3;
      pump(s, x, HY + 2, g).level = 3;
    }
    run(s, 10);
    const rate = s.totals.produced / 10;
    expect(rate).toBeLessThanOrEqual(PIPES[1].capacity + 1e-6);
    expect(rate).toBeGreaterThan(PIPES[1].capacity * 0.9);
    const [l, h] = oilByGrade(s);
    expect(l).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expectConserved(s);
  });
});

describe('сорта нефти: продажи', () => {
  it('терминал продаёт каждый сорт по его цене; порог проверяется для каждого сорта', () => {
    const s = field();
    s.market.price = 60;
    s.time = 100;
    expect(build(s, 'tank', HX + 2, HY).ok).toBe(true);
    const tank = s.buildings[1];
    expect(build(s, 'terminal', HX + 3, HY).ok).toBe(true);
    const term = s.buildings[2];
    s.buildings[0].stored = 40;
    s.buildings[0].grade = 0;
    tank.stored = 100;
    tank.grade = 1;
    layPipes(s, [[HX + 1, HY]], 1); // контора — труба — резервуар — терминал
    // Порог между ценами сортов: лёгкая продаётся, тяжёлая ждёт.
    setSellThreshold(s, 55);
    expect(gradePrice(s, 1)).toBeLessThan(55);
    const r0 = s.totals.revenue;
    run(s, 2);
    expect(tank.stored).toBeCloseTo(100, 9);
    expect(s.buildings[0].stored).toBeLessThan(40);

    expect(s.totals.revenue - r0).toBeGreaterThan(0);
    // Только тяжёлая в достижимых хранилищах — терминал ждёт цену, а не «нет нефти».
    s.buildings[0].stored = 0;
    run(s, 0.2);
    expect(term.status).toBe('waiting_price');
    // Без порога продаётся тяжёлая по своей цене.
    setSellThreshold(s, 0);
    const before = { sold: s.totals.sold, revenue: s.totals.revenue };
    tick(s, TICK);
    const sold = s.totals.sold - before.sold;
    expect(sold).toBeGreaterThan(0);
    expect((s.totals.revenue - before.revenue) / sold).toBeCloseTo(gradePrice(s, 1), 6);
  });

  it('перекупщик платит за каждый сорт свою цену', () => {
    const s = field();
    s.market.price = 50;
    s.time = 300;
    expect(build(s, 'tank', HX + 2, HY).ok).toBe(true);
    s.buildings[0].stored = 30;
    s.buildings[0].grade = 0;
    s.buildings[1].stored = 70;
    s.buildings[1].grade = 1;
    const expected = 30 * manualSellPrice(s, 0) + 70 * manualSellPrice(s, 1);
    expect(manualSellValue(s)).toBeCloseTo(expected, 9);
    const r = sellManual(s);
    expect(r.ok && r.revenue).toBeCloseTo(expected, 9);
    expect(s.oil).toBe(0);
  });

  it('скидка на тяжёлую меняется и иногда почти исчезает — ни один сорт не выгоднее всегда', () => {
    const s = createNewGame(9);
    let min = 1;
    let max = 0;
    for (let t = 0; t < 3600; t += 10) {
      s.time = t;
      const v = heavySpread(s);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeLessThan(0.1);
    expect(max).toBeGreaterThan(0.3);
  });
});

describe('сорта нефти: сохранения и офлайн', () => {
  it('сорта месторождений и хранилищ переживают сохранение', () => {
    const s = field();
    pump(s, HX + 1, HY, 1);
    run(s, 5);
    const t = deserialize(serialize(s))!;
    expect(t.map.grade).toEqual(s.map.grade);
    expect(t.buildings[0].grade).toBe(1);
    expect(t.oil).toBeCloseTo(s.oil, 9);
  });

  it('миграция v2: нефть и тронутые месторождения — лёгкие, объём и деньги не меняются; нетронутые чужие получают сорт', () => {
    const s = createNewGame(4);
    s.cash = 12345;
    s.buildings[0].stored = 50;
    s.oil = 50;
    s.market.price = 47;
    const old = JSON.parse(serialize(s));
    old.version = 2;
    delete old.map.grade;
    for (const b of old.buildings) delete b.grade;
    // В v2 запасы тяжёлых месторождений не были увеличены: возвращаем «старые» запасы.
    for (let i = 0; i < old.map.reserve.length; i++) {
      if (s.map.grade[i] === 1) old.map.reserve[i] = old.map.initial[i] = Math.round(s.map.initial[i] / GRADES[1].reserveFactor);
    }
    // Одно чужое месторождение «тронуто» (запасы меньше начальных) — оно должно остаться лёгким.
    const touched = old.map.reserve.findIndex((r: number, i: number) => r > 0 && s.map.grade[i] === 1);
    old.map.reserve[touched] -= 1;
    const m = deserialize(JSON.stringify(old))!;
    expect(m.version).toBe(SAVE_VERSION);
    expect(m.cash).toBe(12345);
    expect(m.oil).toBeCloseTo(50, 9);
    expect(m.buildings[0].grade).toBe(0);
    expect(manualSellValue(m)).toBeCloseTo(50 * manualSellPrice(m, 0), 9);
    const n = m.map.size;
    let heavy = 0;
    for (let i = 0; i < n * n; i++) {
      if (m.map.initial[i] <= 0) continue;
      const owned = isParcelOwned(m, Math.floor((i % n) / PARCEL_SIZE), Math.floor(i / n / PARCEL_SIZE));
      if (owned) expect(m.map.grade[i]).toBe(0);
      if (m.map.grade[i] === 1) {
        heavy++;
        expect(m.map.initial[i]).toBe(s.map.initial[i]);
      }
    }
    expect(heavy).toBeGreaterThan(0);
    expect(m.map.grade[touched]).toBe(0);
  });

  it('офлайн-прогресс с двумя сортами сохраняет нефть и деньги', () => {
    const s = field(10_000);
    const start = s.cash;
    pump(s, HX + 1, HY, 0);
    pump(s, HX, HY + 2, 1);
    layPipes(s, [[HX, HY + 1]], 1);
    expect(build(s, 'tank', HX - 1, HY + 2).ok).toBe(true);
    expect(build(s, 'terminal', HX + 2, HY + 1).ok).toBe(true);
    layPipes(s, [[HX + 1, HY + 1]], 1);
    simulateOffline(s, 1800);
    expectConserved(s);
    expectBalanced(s, start);
    expect(s.totals.sold).toBeGreaterThan(0);
  });
});
