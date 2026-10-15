import { describe, expect, it } from 'vitest';
import {
  autoConnect,
  BASE_MAP_SIZE,
  BUILDINGS,
  build,
  buyParcel,
  canBuild,
  canBuyParcel,
  checkObjectives,
  createNewGame,
  deserialize,
  drainageTiles,
  isConnected,
  layPipes,
  OBJECTIVES,
  PARCEL_SIZE,
  PIPE_REFUND,
  PIPES,
  planPipes,
  PLATFORM,
  pumpRate,
  REGIONS,
  removePipes,
  serialize,
  simulateOffline,
  START_CASH,
  survey,
  syncOil,
  tick,
  TICK,
  type Building,
  type GameState,
} from '../src/core';

const SHELF = 2;

/** Денежный инвариант вехи 0.4 (шельф новых членов не добавляет). */
function expectBalanced(s: GameState, start = START_CASH) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

/** Отсчёт инварианта от готовой сцены: покупка всей степи даёт суммы, где теряется точность. */
function resetMoney(s: GameState, cash = 200_000): void {
  s.cash = cash;
  s.totals = { ...s.totals, revenue: 0, rewards: 0, refunds: 0, expenses: 0, capex: 0, research: 0, salaries: 0, borrowed: 0, repaid: 0, interest: 0 };
}

/** Компания со всей степью и первым рядом участков шельфа; открыты все здания и регионы. */
function shelfCompany(seed: number): GameState {
  const s = createNewGame(seed);
  s.cash = 1e12;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery', 'platform'];
  s.features = ['research', 'loans', 'managers', 'desert', 'shelf'];
  const p0 = BASE_MAP_SIZE / PARCEL_SIZE;
  for (let pass = 0; pass < p0; pass++) for (let py = 0; py < p0; py++) for (let px = 0; px < p0; px++) buyParcel(s, px, py);
  for (let px = 0; px < p0; px++) expect(buyParcel(s, px, p0)).toEqual({ ok: true });
  return s;
}

/** Клетка морского месторождения на своём шельфе с наибольшей зоной платформы. */
function bestSpot(s: GameState): { x: number; y: number } {
  const n = s.map.size;
  let best: { x: number; y: number; zone: number } | null = null;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!canBuild(s, 'platform', x, y).ok) continue;
      const zone = drainageTiles(s, { id: -1, type: 'platform', x, y, level: 1, enabled: true, invested: 0, status: 'ok' }).length;
      if (!best || zone > best.zone) best = { x, y, zone };
    }
  if (!best) throw new Error('нет морского месторождения');
  return best;
}

/** Платформа на шельфе и резервуар на берегу, соединённые трубой (по морю). */
function offshoreField(seed: number): { s: GameState; rig: Building; tank: Building } {
  const s = shelfCompany(seed);
  const spot = bestSpot(s);
  expect(build(s, 'platform', spot.x, spot.y)).toEqual({ ok: true });
  const rig = s.buildings[s.buildings.length - 1];
  // Резервуар — на суше у берега напротив платформы.
  const coastY = BASE_MAP_SIZE - 1;
  let tank: Building | undefined;
  for (let d = 0; d < 8 && !tank; d++)
    for (const x of [spot.x - d, spot.x + d]) {
      if (build(s, 'tank', x, coastY).ok) {
        tank = s.buildings[s.buildings.length - 1];
        break;
      }
    }
  expect(tank).toBeDefined();
  expect(autoConnect(s, rig.id, 2)).toEqual({ ok: true });
  expect(isConnected(s, rig)).toBe(true);
  return { s, rig, tank: tank! };
}

describe('шельф: стройка', () => {
  it('на шельфе — только платформа; платформа — только на морском месторождении; между платформами ≥ 3 клеток', () => {
    const s = shelfCompany(1);
    const n = s.map.size;
    const spot = bestSpot(s);
    // Пустая морская клетка своего шельфа и клетка суши.
    let sea: { x: number; y: number } | null = null;
    for (let y = BASE_MAP_SIZE; y < n && !sea; y++) for (let x = 0; x < BASE_MAP_SIZE && !sea; x++) if (s.map.initial[y * n + x] === 0 && s.map.owned[Math.floor(y / PARCEL_SIZE) * 7 + Math.floor(x / PARCEL_SIZE)]) sea = { x, y };
    expect(sea).not.toBeNull();
    for (const type of ['pumpjack', 'tank', 'terminal', 'refinery'] as const) expect(canBuild(s, type, spot.x, spot.y).ok).toBe(false);
    expect(canBuild(s, 'tank', sea!.x, sea!.y).ok).toBe(false);
    expect(canBuild(s, 'platform', sea!.x, sea!.y).ok).toBe(false);
    // На суше платформа не ставится, даже на месторождение.
    for (let i = 0; i < n * n; i++) {
      if (s.map.region[i] !== 0 || s.map.initial[i] <= 0) continue;
      const x = i % n;
      const y = (i - x) / n;
      if (s.buildings.some((b) => b.x === x && b.y === y)) continue;
      expect(canBuild(s, 'platform', x, y).ok).toBe(false);
      break;
    }
    expect(build(s, 'platform', spot.x, spot.y)).toEqual({ ok: true });
    for (let y = spot.y - 3; y <= spot.y + 3; y++)
      for (let x = spot.x - 3; x <= spot.x + 3; x++) {
        if (Math.abs(x - spot.x) + Math.abs(y - spot.y) >= PLATFORM.minDistance) continue;
        expect(canBuild(s, 'platform', x, y).ok).toBe(false);
      }
  });

  it('зона дренирования: радиус 2 по сторонам, только морское месторождение одного сорта, без клеток под другими платформами', () => {
    const s = shelfCompany(3);
    const spot = bestSpot(s);
    build(s, 'platform', spot.x, spot.y);
    const rig = s.buildings[s.buildings.length - 1];
    const n = s.map.size;
    const zone = drainageTiles(s, rig);
    expect(zone.length).toBeGreaterThan(5);
    for (const i of zone) {
      const x = i % n;
      const y = (i - x) / n;
      expect(Math.abs(x - rig.x) + Math.abs(y - rig.y)).toBeLessThanOrEqual(PLATFORM.radius);
      expect(s.map.region[i]).toBe(SHELF);
      expect(s.map.grade[i]).toBe(0); // шельф — лёгкая нефть
      expect(s.map.initial[i]).toBeGreaterThan(0);
    }
    expect(pumpRate(s, rig)).toBeCloseTo(BUILDINGS.platform.levels[0].value, 9);
  });
});

describe('шельф: трубы по морю ×3', () => {
  it('прокладка, улучшение и демонтаж: цена и компенсация клетки моря — ×3, у суши — как раньше', () => {
    const s = shelfCompany(2);
    resetMoney(s);
    const k = REGIONS[SHELF].pipeCost;
    expect(k).toBe(3);
    const y = BASE_MAP_SIZE + 2;
    // Свободные клетки ряда шельфа и ряда суши (без месторождений и зданий).
    const n = s.map.size;
    const freeRow = (yy: number) => {
      const out: Array<[number, number]> = [];
      for (let x = 0; x < BASE_MAP_SIZE && out.length < 3; x++) if (s.map.initial[yy * n + x] === 0 && !s.buildings.some((b) => b.x === x && b.y === yy)) out.push([x, yy]);
      return out;
    };
    const sea = freeRow(y);
    const land = freeRow(BASE_MAP_SIZE - 3);
    expect(sea.length).toBe(3);
    expect(land.length).toBe(3);
    expect(planPipes(s, sea, 1).cost).toBe(3 * PIPES[1].cost * k);
    expect(planPipes(s, land, 1).cost).toBe(3 * PIPES[1].cost);
    const cash = s.cash;
    expect(layPipes(s, sea, 1)).toEqual({ ok: true });
    expect(cash - s.cash).toBe(3 * PIPES[1].cost * k);
    expect(planPipes(s, sea, 2).cost).toBe(3 * (PIPES[2].cost - PIPES[1].cost) * k);
    expect(layPipes(s, sea, 2)).toEqual({ ok: true });
    const r = removePipes(s, sea);
    expect(r.refund).toBe(3 * Math.round(PIPES[2].cost * k * PIPE_REFUND));
    expectBalanced(s, 200_000);
  });
});

describe('шельф: добыча и инварианты', () => {
  it('платформа качает по морской трубе в резервуар на берегу; нефть и деньги сходятся в игре и офлайне', () => {
    const { s, rig } = offshoreField(4);
    resetMoney(s);
    for (let i = 0; i < 600; i++) tick(s, TICK);
    simulateOffline(s, 300);
    expect(s.totals.produced).toBeGreaterThan(0);
    expect(['ok', 'full', 'throttled']).toContain(rig.status);
    const stored = s.buildings.reduce((a, b) => a + (b.stored ?? 0), 0);
    expect(stored).toBeCloseTo(s.totals.produced - s.totals.sold - s.totals.refined, 6);
    syncOil(s);
    expect(s.oil).toBeCloseTo(stored, 9);
    expectBalanced(s, 200_000);
  });

  it('сохранение и загрузка с платформой и трубами по морю', () => {
    const { s } = offshoreField(5);
    const t = deserialize(serialize(s))!;
    expect(t.buildings).toEqual(s.buildings);
    expect(t.map.pipes).toEqual(s.map.pipes);
  });
});

describe('шельф: цель и земля', () => {
  it('«Выход на шельф» — после «Выхода в пустыню»: съёмка участка шельфа открывает землю и платформу', () => {
    const ids = OBJECTIVES.map((o) => o.id);
    expect(ids.indexOf('shelf')).toBe(ids.indexOf('desert') + 1);
    const s = createNewGame(6);
    s.objectiveIndex = ids.indexOf('shelf');
    s.cash = 100_000;
    expect(checkObjectives(s)).toEqual([]);
    // До цели участок шельфа не купить, даже соседний со своим.
    s.cash = 1e9;
    buyParcel(s, 2, 3);
    buyParcel(s, 2, 4);
    expect(canBuyParcel(s, 2, 5).ok).toBe(false);
    expect(survey(s, 2, 6, 1)).toEqual({ ok: true });
    expect(checkObjectives(s).map((o) => o.id)).toEqual(['shelf']);
    expect(s.unlocked).toContain('platform');
    expect(s.features).toContain('shelf');
    expect(canBuyParcel(s, 2, 5)).toEqual({ ok: true });
  });
});
