import {
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

function decide(s: GameState): void {
  const cap = storageCapacity(s);
  const hasTerminal = countOf(s, 'terminal') > 0;
  if (s.oil > cap * 0.9 && (!hasTerminal || terminalThroughput(s) < productionCapacity(s) * 0.5)) sellManual(s);

  if (s.unlocked.includes('terminal') && terminalThroughput(s) < productionCapacity(s)) {
    const term = s.buildings.find((b) => b.type === 'terminal' && upgradeCost(b) !== null);
    if (term && s.cash >= upgradeCost(term)!) upgrade(s, term.id);
    else if (!term || countOf(s, 'terminal') === 0) {
      const t = freeTiles(s, false)[0];
      if (t && s.cash >= buildCost(s, 'terminal')) build(s, 'terminal', t.x, t.y);
    }
    if (!hasTerminal) return; // копим на терминал
  }

  if (s.unlocked.includes('tank') && s.oil > cap * 0.6 && countOf(s, 'tank') < Math.ceil(countOf(s, 'pumpjack') / 3)) {
    const t = freeTiles(s, false)[0];
    if (t && s.cash >= buildCost(s, 'tank')) build(s, 'tank', t.x, t.y);
  }

  const deposit = freeTiles(s, true)[0];
  if (deposit) {
    if (s.cash >= buildCost(s, 'pumpjack')) build(s, 'pumpjack', deposit.x, deposit.y);
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
