import {
  autoConnect,
  autoConnectBest,
  getNetwork,
  lastFlow,
  layPipes,
  build,
  buildCost,
  buyParcel,
  canBuild,
  canBuyParcel,
  countOf,
  levelSpec,
  OBJECTIVES,
  PARCELS_PER_SIDE,
  parcelSurvey,
  productionCapacity,
  sellManual,
  storageCapacity,
  terminalThroughput,
  tick,
  TICK,
  upgrade,
  upgradeCost,
  type BuildableType,
  type GameState,
} from '../src/core';

/** Простой «жадный» игрок для проверки баланса: показывает, проходима ли игра и с каким темпом. */
export function runBot(s: GameState, minutes: number): { reachedAt: Record<string, number>; minCash: number } {
  const reachedAt: Record<string, number> = {};
  let minCash = s.cash;
  const steps = Math.round((minutes * 60) / TICK);
  for (let i = 0; i < steps; i++) {
    for (const o of tick(s, TICK).completed) reachedAt[o.id] = s.time;
    minCash = Math.min(minCash, s.cash);
    if (i % 10 === 0) decide(s);
  }
  return { reachedAt, minCash };
}

function freeTiles(s: GameState, deposit: boolean): Array<{ x: number; y: number; reserve: number }> {
  const out = [];
  for (let y = 0; y < s.map.size; y++) {
    for (let x = 0; x < s.map.size; x++) {
      const type: BuildableType = deposit ? 'pumpjack' : 'tank';
      const r = canBuild({ ...s, cash: Infinity, unlocked: [type] }, type, x, y);
      if (r.ok) out.push({ x, y, reserve: s.map.reserve[y * s.map.size + x] });
    }
  }
  return out.sort((a, b) => b.reserve - a.reserve);
}

/** Строит и сразу подключает трубой (как сделал бы игрок кнопкой «Подключить»). */
function buildConnected(s: GameState, type: BuildableType, x: number, y: number): void {
  if (!build(s, type, x, y).ok) return;
  const id = s.buildings[s.buildings.length - 1].id;
  // Как игрок, который видит расчётный поток вариантов: берёт тот, где нефти больше.
  if (!autoConnectBest(s, id).ok) autoConnect(s, id);
}

/** Свободная клетка под резервуар/терминал, ближайшая к точке (x, y). */
function nearestFreeTile(s: GameState, x: number, y: number, maxDist = Infinity): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const t of freeTiles(s, false)) {
    const d = Math.abs(t.x - x) + Math.abs(t.y - y);
    if (d <= maxDist && (!best || d < best.d)) best = { ...t, d };
  }
  return best;
}

/**
 * Узкие места: маршрут ограниченной трубой качалки заменяется магистралью; если и магистраль перегружена —
 * рядом с качалкой ставится резервуар-коллектор, подключённый магистралью к сети: соседние качалки качают
 * в него коротким путём, а терминал забирает из него одним потоком.
 */
function fixBottlenecks(s: GameState): void {
  if (!lastFlow(s)) return;
  const net = getNetwork(s);
  for (const b of s.buildings) {
    if (b.type !== 'pumpjack' || (b.status !== 'throttled' && b.status !== 'full')) continue;
    if (b.status === 'full') {
      // Хранилище у качалки полно: не хватает вывоза — терминал прямо у ближайшего хранилища или его улучшение.
      const st = net.reach.get(b.id)?.[0]?.storage;
      if (!st || !s.unlocked.includes('terminal')) continue;
      const term = s.buildings.find((o) => o.type === 'terminal' && Math.abs(o.x - st.x) + Math.abs(o.y - st.y) === 1);
      if (term) {
        const c = upgradeCost(term);
        if (c !== null && s.cash >= c) upgrade(s, term.id);
      } else {
        const t = nearestFreeTile(s, st.x, st.y, 1);
        if (t && s.cash >= buildCost(s, 'terminal')) build(s, 'terminal', t.x, t.y);
      }
      return;
    }
    const route = net.routes.get(b.id) ?? [];
    const tiles = route.filter((t) => s.map.pipes[t] === 1).map((t) => [t % s.map.size, Math.floor(t / s.map.size)] as [number, number]);
    if (tiles.length) {
      if (s.cash > tiles.length * 60) layPipes(s, tiles, 2);
    } else {
      // Короткий маршрут перегружен чужими потоками — разгружать надо дальние качалки, а не эту.
      if ((net.reach.get(b.id)?.[0]?.length ?? 0) <= 3) continue;
      if (s.unlocked.includes('tank') && s.cash > buildCost(s, 'tank') * 1.5 + 500) {
        const t = nearestFreeTile(s, b.x, b.y, 4);
        if (t && build(s, 'tank', t.x, t.y).ok) autoConnect(s, s.buildings[s.buildings.length - 1].id, 2);
      }
    }
    return;
  }
}

function decide(s: GameState): void {
  // Всё построенное ранее, но не подключённое (например, после покупки земли появился путь), подключаем.
  for (const b of s.buildings) if (b.type !== 'hq' && b.status === 'no_route') autoConnect(s, b.id);
  fixBottlenecks(s);
  const cap = storageCapacity(s);
  const hasTerminal = countOf(s, 'terminal') > 0;
  // Продаём вручную, когда качалки упёрлись в заполненные хранилища (так это видит игрок по статусу «склад полон»).
  // Склад почти полон, а качалки упираются в трубу к единственному свободному хранилищу — тоже повод продать.
  const stuck = s.buildings.some((b) => b.type === 'pumpjack' && (b.status === 'full' || (b.status === 'throttled' && s.oil > cap * 0.7)));
  if (stuck || (s.oil > cap * 0.9 && (!hasTerminal || terminalThroughput(s) < productionCapacity(s) * 0.5))) sellManual(s);

  if (s.unlocked.includes('terminal') && terminalThroughput(s) < productionCapacity(s)) {
    const term = s.buildings.find((b) => b.type === 'terminal' && upgradeCost(b) !== null);
    if (term && s.cash >= upgradeCost(term)!) upgrade(s, term.id);
    else if (!term || countOf(s, 'terminal') === 0) {
      // Терминал — вплотную к конторе: забирает нефть без трубы.
      const hq = s.buildings.find((b) => b.type === 'hq')!;
      const t = nearestFreeTile(s, hq.x, hq.y);
      if (t && s.cash >= buildCost(s, 'terminal')) buildConnected(s, 'terminal', t.x, t.y);
    }
    if (!hasTerminal) return; // копим на терминал
  }

  if (s.unlocked.includes('tank') && s.oil > cap * 0.6 && countOf(s, 'tank') < Math.ceil(countOf(s, 'pumpjack') / 3)) {
    const t = freeTiles(s, false)[0];
    if (t && s.cash >= buildCost(s, 'tank')) buildConnected(s, 'tank', t.x, t.y);
  }

  const deposit = freeTiles(s, true)[0];
  if (deposit) {
    if (s.cash >= buildCost(s, 'pumpjack')) buildConnected(s, 'pumpjack', deposit.x, deposit.y);
  } else {
    let best: { px: number; py: number; reserves: number } | null = null;
    for (let py = 0; py < PARCELS_PER_SIDE; py++) {
      for (let px = 0; px < PARCELS_PER_SIDE; px++) {
        if (!canBuyParcel({ ...s, cash: Infinity }, px, py).ok) continue;
        const { reserves } = parcelSurvey(s, px, py);
        if (!best || reserves > best.reserves) best = { px, py, reserves };
      }
    }
    if (best) buyParcel(s, best.px, best.py);
  }

  for (const b of s.buildings) {
    const cost = b.type === 'pumpjack' ? upgradeCost(b) : null;
    if (cost !== null && s.cash > cost * 2 && levelSpec(b).value > 0) upgrade(s, b.id);
  }
}

export const objectiveIds = OBJECTIVES.map((o) => o.id);
