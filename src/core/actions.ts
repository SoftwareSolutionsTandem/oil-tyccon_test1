import { BUILDINGS, MANUAL_SELL_FACTOR, PARCELS_PER_SIDE } from './config';
import {
  buildCost,
  demolishRefund,
  levelSpec,
  parcelPrice,
  recordStat,
  storageCapacity,
  upgradeCost,
} from './economy';
import type { ActionResult, BuildableType, GameState } from './types';
import {
  buildingAt,
  getBuilding,
  inBounds,
  isParcelAdjacentToOwned,
  isParcelOwned,
  isTileOwned,
  parcelIndex,
  tileIndex,
} from './world';

const fail = (reason: string): ActionResult => ({ ok: false, reason });
const OK: ActionResult = { ok: true };

export function canBuild(s: GameState, type: BuildableType, x: number, y: number): ActionResult {
  if (!s.unlocked.includes(type)) return fail('Это здание ещё не открыто');
  if (!inBounds(s, x, y)) return fail('За пределами карты');
  if (!isTileOwned(s, x, y)) return fail('Участок не принадлежит компании');
  if (buildingAt(s, x, y)) return fail('Клетка занята');
  const hasDeposit = s.map.initial[tileIndex(s, x, y)] > 0;
  if (type === 'pumpjack') {
    if (!hasDeposit) return fail('Качалку можно поставить только на месторождение');
    if (s.map.reserve[tileIndex(s, x, y)] <= 0) return fail('Месторождение исчерпано');
    if (hasNeighborPump(s, x, y)) return fail('Слишком близко к другой скважине: между ними нужна клетка');
  } else if (hasDeposit) {
    return fail('Не занимайте месторождение — здесь можно добывать нефть');
  }
  if (s.cash < buildCost(s, type)) return fail('Недостаточно денег');
  return OK;
}

/** Скважины не ставят вплотную: соседняя по стороне клетка уже в зоне дренирования соседа. */
export function hasNeighborPump(s: GameState, x: number, y: number): boolean {
  return s.buildings.some((b) => b.type === 'pumpjack' && Math.abs(b.x - x) + Math.abs(b.y - y) === 1);
}

export function build(s: GameState, type: BuildableType, x: number, y: number): ActionResult {
  const check = canBuild(s, type, x, y);
  if (!check.ok) return check;
  const cost = buildCost(s, type);
  s.cash -= cost;
  s.totals.capex += cost;
  s.map.decor[tileIndex(s, x, y)] = 0;
  s.buildings.push({ id: s.nextId++, type, x, y, level: 1, enabled: true, invested: cost, status: 'ok' });
  return OK;
}

export function upgrade(s: GameState, id: number): ActionResult {
  const b = getBuilding(s, id);
  if (!b) return fail('Здание не найдено');
  const cost = upgradeCost(b);
  if (cost === null) return fail('Максимальный уровень');
  if (s.cash < cost) return fail('Недостаточно денег');
  s.cash -= cost;
  s.totals.capex += cost;
  b.invested += cost;
  b.level++;
  return OK;
}

export function canDemolish(s: GameState, id: number): ActionResult {
  const b = getBuilding(s, id);
  if (!b) return fail('Здание не найдено');
  if (b.type === 'hq') return fail('Контору снести нельзя');
  if (b.type === 'tank' && s.oil > storageCapacity(s) - levelSpec(b).value) {
    return fail('Сначала продайте нефть — она не поместится в оставшиеся резервуары');
  }
  return OK;
}

export function demolish(s: GameState, id: number): ActionResult {
  const check = canDemolish(s, id);
  if (!check.ok) return check;
  const b = getBuilding(s, id)!;
  const refund = demolishRefund(b);
  s.cash += refund;
  s.totals.refunds += refund;
  s.buildings = s.buildings.filter((other) => other.id !== id);
  return OK;
}

export function toggleEnabled(s: GameState, id: number): ActionResult {
  const b = getBuilding(s, id);
  if (!b || b.type === 'hq') return fail('Нельзя законсервировать');
  b.enabled = !b.enabled;
  return OK;
}

export function manualSellPrice(s: GameState): number {
  return s.market.price * MANUAL_SELL_FACTOR;
}

/** Ручная продажа всей нефти перекупщику. Возвращает выручку. */
export function sellManual(s: GameState): { ok: true; amount: number; revenue: number } | { ok: false; reason: string } {
  if (s.oil < 1) return { ok: false, reason: 'На складе нет нефти' };
  const amount = s.oil;
  const revenue = amount * manualSellPrice(s);
  s.oil = 0;
  s.cash += revenue;
  s.totals.sold += amount;
  s.totals.revenue += revenue;
  recordStat(s, 'sold', amount);
  recordStat(s, 'revenue', revenue);
  return { ok: true, amount, revenue };
}

export function canBuyParcel(s: GameState, px: number, py: number): ActionResult {
  if (px < 0 || py < 0 || px >= PARCELS_PER_SIDE || py >= PARCELS_PER_SIDE) return fail('Нет такого участка');
  if (isParcelOwned(s, px, py)) return fail('Участок уже ваш');
  if (!isParcelAdjacentToOwned(s, px, py)) return fail('Можно купить только соседний участок');
  if (s.cash < parcelPrice(s)) return fail('Недостаточно денег');
  return OK;
}

export function buyParcel(s: GameState, px: number, py: number): ActionResult {
  const check = canBuyParcel(s, px, py);
  if (!check.ok) return check;
  const price = parcelPrice(s);
  s.cash -= price;
  s.totals.capex += price;
  s.map.owned[parcelIndex(px, py)] = true;
  return OK;
}

export function setSellThreshold(s: GameState, price: number): void {
  s.sellThreshold = Math.max(0, Math.round(price));
}

export function buildingName(type: GameState['buildings'][number]['type']): string {
  return type === 'hq' ? 'Контора' : BUILDINGS[type].name;
}
