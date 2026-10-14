import { describe, expect, it } from 'vitest';
import {
  BASE_MAP_SIZE,
  BUILDINGS,
  build,
  buildingUpkeep,
  buyParcel,
  canBuyParcel,
  checkObjectives,
  createNewGame,
  deserialize,
  GRADES,
  levelSpec,
  MAP_OFFSET,
  MAP_SIZE,
  OBJECTIVES,
  PARCEL_SIZE,
  PARCELS_PER_SIDE,
  parcelPrice,
  parcelRegion,
  REGIONS,
  SAVE_VERSION,
  serialize,
  simulateOffline,
  START_CASH,
  survey,
  surveyCost,
  SURVEY_LEVELS,
  syncOil,
  tick,
  TICK,
  type GameState,
} from '../src/core';
import { legacyMap } from './legacy';

const SEEDS = [1, 2, 3, 4, 5];
const DESERT = 1;

/** Денежный инвариант вехи 0.4 (регионы новых членов не добавляют). */
function expectBalanced(s: GameState, start = START_CASH) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

/** Связные месторождения карты. */
function deposits(s: GameState): number[][] {
  const n = s.map.size;
  const seen = new Uint8Array(n * n);
  const out: number[][] = [];
  for (let i = 0; i < n * n; i++) {
    if (s.map.initial[i] <= 0 || seen[i]) continue;
    const comp = [i];
    seen[i] = 1;
    for (let q = 0; q < comp.length; q++) {
      const x = comp[q] % n;
      const y = (comp[q] - x) / n;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        const j = ny * n + nx;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n || seen[j] || s.map.initial[j] <= 0) continue;
        seen[j] = 1;
        comp.push(j);
      }
    }
    out.push(comp);
  }
  return out;
}

/** Компания с открытой пустыней и полосой своей земли от старта до пустыни (ряд стартового участка). */
function desertCompany(seed: number): GameState {
  const s = createNewGame(seed);
  s.cash = 1e7;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery'];
  s.features = ['research', 'loans', 'managers', 'desert'];
  for (let px = 3; px <= 4; px++) expect(buyParcel(s, px, 2)).toEqual({ ok: true });
  return s;
}

describe('карта 56×56 и регионы', () => {
  it('регионы: степь — старая карта в углу, пустыня — восток, шельф — юг', () => {
    const s = createNewGame(1);
    const n = s.map.size;
    expect(n).toBe(MAP_SIZE);
    expect(s.map.region.length).toBe(n * n);
    expect(s.map.owned.length).toBe(PARCELS_PER_SIDE ** 2);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const bx = x - MAP_OFFSET.x;
        const by = y - MAP_OFFSET.y;
        const expected = by >= BASE_MAP_SIZE ? 2 : bx >= BASE_MAP_SIZE ? 1 : 0;
        expect(s.map.region[y * n + x]).toBe(expected);
        expect(parcelRegion(Math.floor(x / PARCEL_SIZE), Math.floor(y / PARCEL_SIZE))).toBe(expected);
      }
  });

  it('месторождение не переходит границу региона и не смешивает сорта; в пустыне почти вся нефть тяжёлая и крупнее', () => {
    for (const seed of SEEDS) {
      const s = createNewGame(seed);
      let desertTiles = 0;
      let desertHeavy = 0;
      let desertReserve = 0;
      let baseReserve = 0;
      let baseTiles = 0;
      for (const comp of deposits(s)) {
        const r = s.map.region[comp[0]];
        const g = s.map.grade[comp[0]];
        for (const j of comp) {
          expect(s.map.region[j]).toBe(r);
          expect(s.map.grade[j]).toBe(g);
          expect(s.map.initial[j]).toBe(s.map.reserve[j]);
        }
        if (r === DESERT) {
          desertTiles += comp.length;
          if (g === 1) desertHeavy += comp.length;
          for (const j of comp) desertReserve += s.map.initial[j] / (g === 1 ? GRADES[1].reserveFactor : 1);
        } else if (r === 0) {
          baseTiles += comp.length;
          for (const j of comp) baseReserve += s.map.initial[j] / (g === 1 ? GRADES[1].reserveFactor : 1);
        }
      }
      expect(desertTiles).toBeGreaterThan(20);
      expect(desertHeavy / desertTiles).toBeGreaterThan(0.6);
      // Клетка пустыни (без поправки на сорт) богаче средней клетки степи.
      expect(desertReserve / desertTiles).toBeGreaterThan(baseReserve / baseTiles);
    }
  });

  it('генерация детерминирована по seed', () => {
    expect(serialize(createNewGame(7)).replace(/"savedAt":\d+/, '')).toBe(serialize(createNewGame(7)).replace(/"savedAt":\d+/, ''));
  });
});

describe('цена участков по регионам', () => {
  it('степь — прежняя формула 3000·1,7^(k−1); пустыня — base·g^k своих участков пустыни; кривые независимы', () => {
    const s = desertCompany(2);
    const base = REGIONS[0];
    const desert = REGIONS[DESERT];
    // В степи 3 своих участка (старт + 2 купленных).
    expect(parcelPrice(s)).toBe(Math.round(3000 * 1.7 ** 2));
    expect(parcelPrice(s, 1, 1)).toBe(Math.round(base.parcelBase * base.parcelGrowth ** 2));
    expect(parcelPrice(s, 5, 2)).toBe(desert.parcelBase);
    const capex = s.totals.capex;
    expect(buyParcel(s, 5, 2)).toEqual({ ok: true });
    expect(s.totals.capex - capex).toBe(desert.parcelBase);
    expect(parcelPrice(s, 5, 1)).toBe(Math.round(desert.parcelBase * desert.parcelGrowth));
    // Покупка в пустыне не меняет цену степи.
    expect(parcelPrice(s, 1, 1)).toBe(Math.round(3000 * 1.7 ** 2));
    expectBalanced(s, 1e7);
  });

  it('пустыня закрыта до цели; соседство обязательно; разведка работает и стоит долю цены участка пустыни', () => {
    const s = desertCompany(3);
    s.features = s.features.filter((f) => f !== 'desert');
    expect(canBuyParcel(s, 5, 2).ok).toBe(false);
    s.features.push('desert');
    expect(canBuyParcel(s, 5, 2)).toEqual({ ok: true });
    expect(canBuyParcel(s, 6, 2).ok).toBe(false); // не соседний
    expect(surveyCost(s, 1, 6, 4)).toBe(Math.round(REGIONS[DESERT].parcelBase * SURVEY_LEVELS[0].costShare));
    expect(survey(s, 6, 4, 1)).toEqual({ ok: true });
    expect(survey(s, 6, 4, 2)).toEqual({ ok: true });
    // Шельф в 2а не открыт.
    expect(canBuyParcel(s, 2, 5).ok).toBe(false);
  });

  it('цель «Выход в пустыню» — после «Нефтяной компании»: съёмка участка пустыни открывает покупку земли', () => {
    const ids = OBJECTIVES.map((o) => o.id);
    expect(ids.indexOf('desert')).toBe(ids.indexOf('cash_500k') + 1);
    const s = createNewGame(4);
    s.objectiveIndex = ids.indexOf('desert');
    s.cash = 50_000;
    expect(checkObjectives(s)).toEqual([]);
    expect(survey(s, 6, 1, 1)).toEqual({ ok: true });
    const cash = s.cash;
    expect(checkObjectives(s).map((o) => o.id)).toEqual(['desert']);
    expect(s.features).toContain('desert');
    expect(s.cash).toBe(cash + OBJECTIVES[ids.indexOf('desert')].reward);
  });
});

describe('промысел в пустыне', () => {
  /** Качалка 3-го уровня и резервуар на участке пустыни с месторождением; возвращает компанию и качалку. */
  function desertField(seed: number) {
    const s = desertCompany(seed);
    s.cash = 1e12;
    // Вся степь (покупка идёт волной от своих участков), затем столбец пустыни у её границы.
    const p0 = BASE_MAP_SIZE / PARCEL_SIZE;
    for (let pass = 0; pass < p0; pass++) for (let py = 0; py < p0; py++) for (let px = 0; px < p0; px++) buyParcel(s, px, py);
    for (let py = 0; py < p0; py++) expect(buyParcel(s, p0, py)).toEqual({ ok: true });
    const n = s.map.size;
    for (let i = 0; i < n * n; i++) {
      const x = i % n;
      const y = (i - x) / n;
      if (s.map.region[i] !== DESERT || s.map.initial[i] <= 0 || !s.map.owned[Math.floor(y / PARCEL_SIZE) * PARCELS_PER_SIDE + Math.floor(x / PARCEL_SIZE)]) continue;
      if (!build(s, 'pumpjack', x, y).ok) continue;
      const pump = s.buildings[s.buildings.length - 1];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (build(s, 'tank', x + dx, y + dy).ok) return { s, pump };
    }
    throw new Error('нет месторождения в пустыне');
  }

  it('содержание качалки в пустыне ×1,3; у других зданий и в степи — без изменений', () => {
    const { s, pump } = desertField(1);
    expect(buildingUpkeep(pump, s)).toBeCloseTo(levelSpec(pump).upkeep * REGIONS[DESERT].pumpUpkeep, 9);
    const tank = s.buildings[s.buildings.length - 1];
    expect(buildingUpkeep(tank, s)).toBeCloseTo(levelSpec(tank).upkeep, 9);
    expect(BUILDINGS.pumpjack.levels[0].upkeep).toBe(1.5);
  });

  it('инварианты денег и нефти с промыслом в пустыне, в игре и офлайне', () => {
    const { s } = desertField(2);
    // Отсчёт инварианта — от готового промысла (покупка всей степи даёт суммы, где теряется точность).
    s.cash = 100_000;
    s.totals = { ...s.totals, revenue: 0, rewards: 0, refunds: 0, expenses: 0, capex: 0, research: 0, salaries: 0, borrowed: 0, repaid: 0, interest: 0 };
    const startCash = s.cash;
    for (let i = 0; i < 600; i++) tick(s, TICK);
    simulateOffline(s, 300);
    expect(s.totals.produced).toBeGreaterThan(0);
    const stored = s.buildings.reduce((a, b) => a + (b.stored ?? 0), 0);
    expect(stored).toBeCloseTo(s.totals.produced - s.totals.sold - s.totals.refined, 6);
    syncOil(s);
    expect(s.oil).toBeCloseTo(stored, 9);
    expectBalanced(s, startCash);
  });
});

describe('сохранения v8', () => {
  /** Сохранение версии 7 из текущего состояния: карта 40×40 без регионов. */
  function asV7(s: GameState): string {
    const o = JSON.parse(serialize(s));
    o.version = 7;
    legacyMap(o);
    return JSON.stringify(o);
  }

  it('миграция v7 → v8 для каждого номера цели 0–15 (v7): номер, открытия, деньги, земля и здания не меняются', () => {
    for (let v7 = 0; v7 <= 15; v7++) {
      const s = createNewGame(9);
      s.cash = 33_333;
      s.objectiveIndex = v7;
      s.features = v7 >= 11 ? ['research', 'loans', 'managers'] : [];
      s.unlocked = ['pumpjack', 'tank', 'terminal'];
      s.cash = 1e6;
      buyParcel(s, 3, 2);
      survey(s, 1, 1, 2);
      build(s, 'tank', 20, 18);
      s.cash = 33_333;
      const json = asV7(s);
      const m = deserialize(json)!;
      expect(m).not.toBeNull();
      expect(m.version).toBe(SAVE_VERSION);
      expect(m.objectiveIndex).toBe(v7);
      expect(m.features).toEqual(s.features);
      expect(m.cash).toBe(33_333);
      expect(m.totals).toEqual(s.totals);
      expect(m.buildings).toEqual(s.buildings);
      // Вся карта — как в новой игре с тем же seed и теми же действиями: старая часть из сохранения, новая — из генерации.
      expect(m.map).toEqual(s.map);
      // Цель 15 у v7 — «все цели пройдены»; в v8 это новая цель «Выход в пустыню».
      if (v7 === 15) expect(OBJECTIVES[m.objectiveIndex].id).toBe('desert');
    }
  });

  it('старая часть карты в сохранении v7 переносится как есть (тронутые запасы и трубы)', () => {
    const s = createNewGame(5);
    const o = JSON.parse(asV7(s));
    o.map.reserve[3] = 7;
    o.map.pipes[5] = 2;
    const m = deserialize(JSON.stringify(o))!;
    expect(m.map.reserve[3]).toBe(7);
    expect(m.map.pipes[5]).toBe(2);
    expect(m.map.reserve.length).toBe(MAP_SIZE * MAP_SIZE);
  });

  it('сохранение и загрузка v8; повреждённые массивы регионов и участков отклоняются', () => {
    const s = desertCompany(6);
    const t = deserialize(serialize(s))!;
    expect(t.map).toEqual(s.map);
    expect(t.features).toContain('desert');
    const bad = JSON.parse(serialize(s));
    bad.map.region = bad.map.region.slice(1);
    expect(deserialize(JSON.stringify(bad))).toBeNull();
    const bad2 = JSON.parse(serialize(s));
    bad2.map.owned = bad2.map.owned.slice(1);
    expect(deserialize(JSON.stringify(bad2))).toBeNull();
    const bad3 = JSON.parse(asV7(s));
    bad3.map.reserve = bad3.map.reserve.slice(1);
    expect(deserialize(JSON.stringify(bad3))).toBeNull();
    const bad4 = JSON.parse(serialize(s));
    bad4.features = ['desert', 'sea'];
    expect(deserialize(JSON.stringify(bad4))).toBeNull();
  });
});
