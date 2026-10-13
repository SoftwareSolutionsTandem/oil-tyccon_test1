import { GRADES, HEAVY_CHANCE, HQ_POS, SURVEY_EXACT, MAP_SIZE, MARKET, PARCEL_SIZE, PARCELS_PER_SIDE, START_CASH, START_PARCEL } from './config';
import { emptyBucket } from './economy';
import { Rng } from './rng';
import type { GameState, WorldMap } from './types';

export const SAVE_VERSION = 4;

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
    unlocked: ['pumpjack'],
    objectiveIndex: 0,
    totals: { produced: 0, sold: 0, revenue: 0, expenses: 0, capex: 0, refunds: 0, rewards: 0 },
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

function generateMap(seed: number): WorldMap {
  const rng = new Rng(seed);
  const size = MAP_SIZE;
  const reserve = new Array<number>(size * size).fill(0);
  const decor = new Array<number>(size * size).fill(0);
  const owned = new Array<boolean>(PARCELS_PER_SIDE * PARCELS_PER_SIDE).fill(false);
  owned[START_PARCEL.py * PARCELS_PER_SIDE + START_PARCEL.px] = true;

  for (let py = 0; py < PARCELS_PER_SIDE; py++) {
    for (let px = 0; px < PARCELS_PER_SIDE; px++) {
      const dist = Math.abs(px - START_PARCEL.px) + Math.abs(py - START_PARCEL.py);
      if (dist === 0) {
        // Стартовый участок: гарантированное месторождение среднего размера вдали от конторы.
        growBlob(rng, reserve, size, px, py, { x: 5, y: 5 }, 9, () => rng.range(900, 1500));
        continue;
      }
      // Дальние участки дороже, но богаче: больше пятен и крупнее запасы.
      const blobs = rng.next() < 0.35 ? 0 : 1 + (dist >= 2 && rng.next() < 0.5 ? 1 : 0);
      for (let i = 0; i < blobs; i++) {
        const start = { x: rng.int(1, PARCEL_SIZE - 2), y: rng.int(1, PARCEL_SIZE - 2) };
        const tiles = rng.int(4, 8 + dist * 2);
        const base = 900 + dist * 600;
        growBlob(rng, reserve, size, px, py, start, tiles, () => base * rng.range(0.6, 1.5));
      }
    }
  }

  for (let i = 0; i < reserve.length; i++) {
    reserve[i] = Math.round(reserve[i]);
    if (reserve[i] === 0 && rng.next() < 0.07) decor[i] = rng.int(1, 3);
  }
  decor[HQ_POS.y * size + HQ_POS.x] = 0;

  const grade = assignGrades(seed, reserve, size);
  // Стартовый участок известен точно, остальные не разведаны.
  const survey = owned.map((o) => (o ? SURVEY_EXACT : 0));
  return { size, reserve, initial: [...reserve], decor, owned, pipes: new Array<number>(size * size).fill(0), grade, survey };
}

/**
 * Сорта месторождений. Месторождение — связная группа клеток с запасами: у всех его клеток один сорт,
 * поэтому зона дренирования качалки никогда не смешивает сорта. Стартовый участок — лёгкая нефть, дальше
 * тяжёлые встречаются чаще. Отдельный ГСЧ от seed: сорта не сдвигают генерацию запасов и декора.
 * Запасы тяжёлых месторождений умножаются на GRADES[1].reserveFactor.
 */
function assignGrades(seed: number, reserve: number[], size: number): number[] {
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
      dist = Math.min(dist, Math.abs(px - START_PARCEL.px) + Math.abs(py - START_PARCEL.py));
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
    if (x === HQ_POS.x && y === HQ_POS.y) continue;
    reserve[y * size + x] = Math.max(reserve[y * size + x], amount());
  }
}
