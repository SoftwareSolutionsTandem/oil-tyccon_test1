import { BASE_MAP_SIZE, GRADES, HEAVY_CHANCE, HQ_POS, MAP_OFFSET, SURVEY_EXACT, MAP_SIZE, MARKET, PARCEL_SIZE, PARCELS_PER_SIDE, REGIONS, START_CASH, START_PARCEL } from './config';
import { regionAt } from './world';
import { emptyHistory } from './history';
import { emptyBucket } from './economy';
import { Rng } from './rng';
import type { GameState, WorldMap } from './types';

export const SAVE_VERSION = 8;

export function createNewGame(seed: number = (Math.random() * 2 ** 31) | 0): GameState {
  const map = generateMap(seed);
  const state: GameState = {
    version: SAVE_VERSION,
    seed,
    rng: seed ^ 0x5bd1e995,
    time: 0,
    cash: START_CASH,
    oil: 0,
    map,
    buildings: [],
    nextId: 1,
    market: { price: MARKET.mean, history: [MARKET.mean], historyAcc: 0 },
    sellThreshold: 0,
    productThresholds: [0, 0, 0],
    unlocked: ['pumpjack'],
    features: [],
    research: { levels: {}, active: null },
    managers: { dispatcher: false, mechanic: false, reserve: 0 },
    loan: null,
    adLastAt: null,
    history: emptyHistory(),
    objectiveIndex: 0,
    stage: 0,
    achievements: [],
    totals: {
      produced: 0,
      sold: 0,
      revenue: 0,
      expenses: 0,
      capex: 0,
      refunds: 0,
      rewards: 0,
      refined: 0,
      productsMade: [0, 0, 0],
      productsSold: [0, 0, 0],
      productRevenue: 0,
      research: 0,
      salaries: 0,
      borrowed: 0,
      repaid: 0,
      interest: 0,
      adRewards: 0,
    },
    stats: { buckets: [], current: emptyBucket(), currentTime: 0 },
    savedAt: Date.now(),
  };
  state.buildings.push({
    id: state.nextId++,
    type: 'hq',
    x: HQ_POS.x,
    y: HQ_POS.y,
    level: 1,
    enabled: true,
    invested: 0,
    status: 'ok',
    stored: 0,
  });
  return state;
}

/**
 * Карта 56×56 (веха 0.5): старая карта 40×40 генерируется прежним кодом и тем же ГСЧ (поэтому степь новой игры
 * совпадает с картой до вехи 0.5 при том же seed) и ложится со смещением MAP_OFFSET; полосы новых регионов —
 * своим ГСЧ от seed, после неё. Миграция v7 → v8 берёт полосы из этой же генерации.
 */
function generateMap(seed: number): WorldMap {
  const base = generateBaseMap(seed);
  const size = MAP_SIZE;
  const cells = size * size;
  const reserve = new Array<number>(cells).fill(0);
  const decor = new Array<number>(cells).fill(0);
  const grade = new Array<number>(cells).fill(0);
  const region = new Array<number>(cells).fill(0);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) region[y * size + x] = regionAt(x, y);
  const bn = BASE_MAP_SIZE;
  for (let y = 0; y < bn; y++)
    for (let x = 0; x < bn; x++) {
      const i = (y + MAP_OFFSET.y) * size + x + MAP_OFFSET.x;
      reserve[i] = base.reserve[y * bn + x];
      decor[i] = base.decor[y * bn + x];
      grade[i] = base.grade[y * bn + x];
    }
  generateRegions(seed, reserve, decor, grade, region, size);
  const owned = new Array<boolean>(PARCELS_PER_SIDE * PARCELS_PER_SIDE).fill(false);
  owned[START_PARCEL.py * PARCELS_PER_SIDE + START_PARCEL.px] = true;
  // Стартовый участок известен точно, остальные не разведаны.
  const survey = owned.map((o) => (o ? SURVEY_EXACT : 0));
  return { size, reserve, initial: [...reserve], decor, owned, pipes: new Array<number>(cells).fill(0), grade, survey, region };
}

/** Старая карта 40×40 — код и порядок ГСЧ до вехи 0.5 без изменений (в локальных координатах). */
function generateBaseMap(seed: number): { reserve: number[]; decor: number[]; grade: number[] } {
  const rng = new Rng(seed);
  const size = BASE_MAP_SIZE;
  const perSide = BASE_MAP_SIZE / PARCEL_SIZE;
  const start = { px: START_PARCEL.px - MAP_OFFSET.x / PARCEL_SIZE, py: START_PARCEL.py - MAP_OFFSET.y / PARCEL_SIZE };
  const hq = { x: HQ_POS.x - MAP_OFFSET.x, y: HQ_POS.y - MAP_OFFSET.y };
  const reserve = new Array<number>(size * size).fill(0);
  const decor = new Array<number>(size * size).fill(0);
  const keep = (x: number, y: number) => !(x === hq.x && y === hq.y);

  for (let py = 0; py < perSide; py++) {
    for (let px = 0; px < perSide; px++) {
      const dist = Math.abs(px - start.px) + Math.abs(py - start.py);
      if (dist === 0) {
        // Стартовый участок: гарантированное месторождение среднего размера вдали от конторы.
        growBlob(rng, reserve, size, px, py, { x: 5, y: 5 }, 9, () => rng.range(900, 1500), keep);
        continue;
      }
      // Дальние участки дороже, но богаче: больше пятен и крупнее запасы.
      const blobs = rng.next() < 0.35 ? 0 : 1 + (dist >= 2 && rng.next() < 0.5 ? 1 : 0);
      for (let i = 0; i < blobs; i++) {
        const local = { x: rng.int(1, PARCEL_SIZE - 2), y: rng.int(1, PARCEL_SIZE - 2) };
        const tiles = rng.int(4, 8 + dist * 2);
        const amount = 900 + dist * 600;
        growBlob(rng, reserve, size, px, py, local, tiles, () => amount * rng.range(0.6, 1.5), keep);
      }
    }
  }

  for (let i = 0; i < reserve.length; i++) {
    reserve[i] = Math.round(reserve[i]);
    if (reserve[i] === 0 && rng.next() < 0.07) decor[i] = rng.int(1, 3);
  }
  decor[hq.y * size + hq.x] = 0;

  const grade = assignGrades(seed, reserve, size, start);
  return { reserve, decor, grade };
}

/**
 * Полосы новых регионов: месторождения по правилам региона (условная удалённость, множитель запасов, доля тяжёлых),
 * камни в пустыне, у моря декора нет. Клетки у границы региона остаются без нефти: месторождение не переходит
 * границу, и у каждого месторождения одни правила и один сорт.
 */
function generateRegions(seed: number, reserve: number[], decor: number[], grade: number[], region: number[], size: number): void {
  const rng = new Rng((seed ^ 0x6d2b79f5) >>> 0);
  const inner = (x: number, y: number) => {
    const r = region[y * size + x];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < size && ny < size && region[ny * size + nx] !== r) return false;
    }
    return true;
  };
  for (let py = 0; py < PARCELS_PER_SIDE; py++) {
    for (let px = 0; px < PARCELS_PER_SIDE; px++) {
      const r = regionAt(px * PARCEL_SIZE, py * PARCEL_SIZE);
      if (r === 0) continue;
      const spec = REGIONS[r];
      const dist = spec.remoteness;
      const blobs = rng.next() < spec.emptyChance ? 0 : 1 + (rng.next() < 0.5 ? 1 : 0);
      for (let i = 0; i < blobs; i++) {
        const local = { x: rng.int(1, PARCEL_SIZE - 2), y: rng.int(1, PARCEL_SIZE - 2) };
        const tiles = rng.int(4, 8 + dist * 2);
        const amount = (900 + dist * 600) * spec.reserveFactor;
        growBlob(rng, reserve, size, px, py, local, tiles, () => amount * rng.range(0.6, 1.5), inner);
      }
    }
  }
  const comps = components(reserve, size, (i) => region[i] !== 0);
  for (const comp of comps) {
    if (rng.next() >= REGIONS[region[comp[0]]].heavyChance) continue;
    for (const j of comp) {
      grade[j] = 1;
      reserve[j] = reserve[j] * GRADES[1].reserveFactor;
    }
  }
  for (let i = 0; i < reserve.length; i++) {
    if (region[i] === 0) continue;
    reserve[i] = Math.round(reserve[i]);
    // В пустыне — только камни (декор 2): кустов и деревьев там нет.
    if (region[i] === 1 && reserve[i] === 0 && rng.next() < 0.05) decor[i] = 2;
  }
}

/** Связные группы клеток с запасами (месторождения) среди клеток, где within(i). */
function components(reserve: number[], size: number, within: (i: number) => boolean): number[][] {
  const seen = new Uint8Array(size * size);
  const out: number[][] = [];
  for (let i = 0; i < reserve.length; i++) {
    if (reserve[i] <= 0 || seen[i] || !within(i)) continue;
    const comp: number[] = [i];
    seen[i] = 1;
    for (let q = 0; q < comp.length; q++) {
      const x = comp[q] % size;
      const y = (comp[q] - x) / size;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (reserve[j] > 0 && !seen[j] && within(j)) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Сорта месторождений. Месторождение — связная группа клеток с запасами: у всех его клеток один сорт,
 * поэтому зона дренирования качалки никогда не смешивает сорта. Стартовый участок — лёгкая нефть, дальше
 * тяжёлые встречаются чаще. Отдельный ГСЧ от seed: сорта не сдвигают генерацию запасов и декора.
 * Запасы тяжёлых месторождений умножаются на GRADES[1].reserveFactor.
 */
function assignGrades(seed: number, reserve: number[], size: number, start: { px: number; py: number }): number[] {
  const rng = new Rng((seed ^ 0x2c1b3c6d) >>> 0);
  const grade = new Array<number>(size * size).fill(0);
  const seen = new Uint8Array(size * size);
  for (let i = 0; i < reserve.length; i++) {
    if (reserve[i] <= 0 || seen[i]) continue;
    const comp: number[] = [i];
    seen[i] = 1;
    for (let q = 0; q < comp.length; q++) {
      const x = comp[q] % size;
      const y = (comp[q] - x) / size;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (reserve[j] > 0 && !seen[j]) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    // Удалённость участка — по самой близкой к старту клетке месторождения.
    let dist = Infinity;
    for (const j of comp) {
      const px = Math.floor((j % size) / PARCEL_SIZE);
      const py = Math.floor(j / size / PARCEL_SIZE);
      dist = Math.min(dist, Math.abs(px - start.px) + Math.abs(py - start.py));
    }
    const chance = HEAVY_CHANCE[Math.min(dist, HEAVY_CHANCE.length - 1)];
    if (rng.next() < chance) {
      for (const j of comp) {
        grade[j] = 1;
        reserve[j] = Math.round(reserve[j] * GRADES[1].reserveFactor);
      }
    }
  }
  return grade;
}

function growBlob(
  rng: Rng,
  reserve: number[],
  size: number,
  px: number,
  py: number,
  local: { x: number; y: number },
  count: number,
  amount: () => number,
  keep: (x: number, y: number) => boolean,
): void {
  const x0 = px * PARCEL_SIZE;
  const y0 = py * PARCEL_SIZE;
  const cells: Array<[number, number]> = [[local.x, local.y]];
  const taken = new Set<string>([`${local.x},${local.y}`]);
  while (cells.length < count) {
    const [cx, cy] = cells[rng.int(0, cells.length - 1)];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const [dx, dy] = dirs[rng.int(0, 3)];
    const nx = cx + dx;
    const ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= PARCEL_SIZE || ny >= PARCEL_SIZE) continue;
    const key = `${nx},${ny}`;
    if (taken.has(key)) continue;
    taken.add(key);
    cells.push([nx, ny]);
  }
  for (const [lx, ly] of cells) {
    const x = x0 + lx;
    const y = y0 + ly;
    if (!keep(x, y)) continue;
    reserve[y * size + x] = Math.max(reserve[y * size + x], amount());
  }
}
