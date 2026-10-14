import { BUILDINGS, LOANS, MANUAL_SELL_FACTOR, PARCELS_PER_SIDE, PIPE_REFUND, PIPES, REGIONS, SURVEY_EXACT, SURVEY_LEVELS, TECHS } from './config';
import {
  buildCost,
  demolishRefund,
  gradePrice,
  levelSpec,
  oilByGrade,
  parcelPrice,
  productPrice,
  recordStat,
  techNextLevel,
  loanDebt,
  loanLimit,
  upgradeCost,
} from './economy';
import { componentOf, getNetwork, lastFlow, syncOil } from './network';
import type { ActionResult, BuildableType, Feed, GameState, Grade, ManagerRole, TechId } from './types';
import {
  buildingAt,
  getBuilding,
  inBounds,
  isParcelAdjacentToOwned,
  parcelRegion,
  regionOpen,
  isParcelOwned,
  isTileOwned,
  parcelIndex,
  surveyLevel,
  tileIndex,
} from './world';

const fail = (reason: string): ActionResult => ({ ok: false, reason });
const OK: ActionResult = { ok: true };

export function canBuild(s: GameState, type: BuildableType, x: number, y: number): ActionResult {
  if (!s.unlocked.includes(type)) return fail('Это здание ещё не открыто');
  if (!inBounds(s, x, y)) return fail('За пределами карты');
  if (!isTileOwned(s, x, y)) return fail('Участок не принадлежит компании');
  if (buildingAt(s, x, y)) return fail('Клетка занята');
  if (s.map.pipes[tileIndex(s, x, y)] > 0) return fail('Клетка занята трубопроводом — сначала уберите трубу');
  const hasDeposit = s.map.initial[tileIndex(s, x, y)] > 0;
  if (type === 'pumpjack') {
    if (!hasDeposit) return fail('Качалку можно поставить только на месторождение');
    if (s.map.reserve[tileIndex(s, x, y)] <= 0) return fail('Месторождение исчерпано');
    const why = rowConflict(s, x, y);
    if (why) return fail(why);
  } else if (hasDeposit) {
    return fail('Не занимайте месторождение — здесь можно добывать нефть');
  }
  if (s.cash < buildCost(s, type)) return fail('Недостаточно денег');
  return OK;
}

/**
 * Расстановка качалок рядами. Станок длинный вдоль балансира (1,2–1,4 клетки) и узкий поперёк (~0,45),
 * поэтому соседние по стороне качалки стоят бок о бок, только если их балансиры параллельны — поперёк ряда.
 * Отсюда правило: соседи по стороне у качалки — только вдоль одной оси (ряд вдоль x или вдоль y).
 * Ряды не поворачивают и не примыкают друг к другу вплотную: между параллельными рядами — проход в клетку.
 * По диагонали качалки ставить можно всегда.
 */
export type PumpOrient = 0 | 1 | 2;

/** Есть ли качалка на клетке (с учётом пробной клетки extra). */
function pumpAtTile(s: GameState, x: number, y: number, extra?: { x: number; y: number }): boolean {
  if (extra && extra.x === x && extra.y === y) return true;
  return s.buildings.some((b) => b.type === 'pumpjack' && b.x === x && b.y === y);
}

/** Соседи-качалки по сторонам: вдоль оси x и вдоль оси y. */
export function pumpNeighbors(s: GameState, x: number, y: number, extra?: { x: number; y: number }): { alongX: boolean; alongY: boolean } {
  return {
    alongX: pumpAtTile(s, x - 1, y, extra) || pumpAtTile(s, x + 1, y, extra),
    alongY: pumpAtTile(s, x, y - 1, extra) || pumpAtTile(s, x, y + 1, extra),
  };
}

/**
 * Ориентация качалки выводится из расстановки (не хранится): в ряду вдоль x балансир идёт вдоль y (2),
 * в ряду вдоль y — вдоль x (1); одиночная качалка и качалка в старом сплошном блоке (соседи по обеим осям,
 * допустимо в ранних сохранениях) — по диагонали клетки, профилем к зрителю (0).
 */
export function pumpOrientAt(s: GameState, x: number, y: number, extra?: { x: number; y: number }): PumpOrient {
  const { alongX, alongY } = pumpNeighbors(s, x, y, extra);
  if (alongX === alongY) return 0;
  return alongX ? 2 : 1;
}

/** Причина, по которой качалку нельзя поставить в (x, y) из-за соседей, или null. */
export function rowConflict(s: GameState, x: number, y: number): string | null {
  const here = { x, y };
  const own = pumpNeighbors(s, x, y);
  if (own.alongX && own.alongY) return 'Качалки ставят рядами: здесь ряд поворачивал бы — между рядами нужен проход в одну клетку';
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (!pumpAtTile(s, nx, ny)) continue;
    const n = pumpNeighbors(s, nx, ny, here);
    if (n.alongX && n.alongY) {
      return 'Соседняя качалка уже стоит в ряду другого направления: ряды не примыкают вплотную — нужен проход в одну клетку';
    }
  }
  return null;
}

export function build(s: GameState, type: BuildableType, x: number, y: number): ActionResult {
  const check = canBuild(s, type, x, y);
  if (!check.ok) return check;
  const cost = buildCost(s, type);
  s.cash -= cost;
  s.totals.capex += cost;
  s.map.decor[tileIndex(s, x, y)] = 0;
  const b: GameState['buildings'][number] = { id: s.nextId++, type, x, y, level: 1, enabled: true, invested: cost, status: 'ok' };
  if (type === 'tank') b.stored = 0;
  if (type === 'refinery') {
    b.products = [0, 0, 0];
    b.feed = 'any';
    b.marginOnly = true;
  }
  s.buildings.push(b);
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
  if (b.type === 'tank' && (b.stored ?? 0) > 1e-6) {
    // Нефть резервуара перетекает в остальные хранилища его сети — если там есть место для её сорта.
    if (spillRoom(s, b).total < (b.stored ?? 0)) return fail('Сначала продайте нефть — она не поместится в оставшиеся хранилища сети (с учётом сорта)');
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
  // НПЗ: остаток нефтепродуктов продаётся перекупщику по 80% цены — без потерь и с учётом как продажа.
  if (b.type === 'refinery' && b.products) sellRefineryStock(s, b, MANUAL_SELL_FACTOR);
  const oil = b.stored ?? 0;
  const spill = b.type === 'tank' && oil > 0 ? spillRoom(s, b) : null;
  s.buildings = s.buildings.filter((other) => other.id !== id);
  if (spill && spill.total > 0) {
    // Переливаем в бывших соседей по сети (пустые или того же сорта) пропорционально свободному месту.
    spill.targets.forEach(({ o, free }) => {
      o.stored = (o.stored ?? 0) + (oil * free) / spill.total;
      o.grade = b.grade ?? 0;
    });
  }
  syncOil(s);
  return OK;
}

/** Куда можно перелить нефть сносимого резервуара: хранилища его сети, пустые или с нефтью того же сорта. */
function spillRoom(s: GameState, b: GameState['buildings'][number]) {
  const g = b.grade ?? 0;
  const targets = (componentOf(s, b)?.storages ?? [])
    .filter((o) => o.id !== b.id && ((o.stored ?? 0) <= 1e-9 || (o.grade ?? 0) === g))
    .map((o) => ({ o, free: Math.max(0, levelSpec(o).value - (o.stored ?? 0)) }));
  return { targets, total: targets.reduce((a, t) => a + t.free, 0) };
}

/** Продажа всех запасов нефтепродуктов НПЗ по доле factor от цены (снос — перекупщику). */
function sellRefineryStock(s: GameState, b: GameState['buildings'][number], factor: number): number {
  let revenue = 0;
  for (let i = 0; i < 3; i++) {
    const amount = b.products![i];
    if (amount <= 0) continue;
    const r = amount * productPrice(s, i) * factor;
    b.products![i] = 0;
    s.totals.productsSold[i] += amount;
    revenue += r;
  }
  s.cash += revenue;
  s.totals.revenue += revenue;
  s.totals.productRevenue += revenue;
  recordStat(s, 'revenue', revenue);
  recordStat(s, 'productRevenue', revenue);
  return revenue;
}

/** Фильтр сырья НПЗ. */
export function setRefineryFeed(s: GameState, id: number, feed: Feed): ActionResult {
  const b = getBuilding(s, id);
  if (!b || b.type !== 'refinery') return fail('Это не НПЗ');
  b.feed = feed;
  return OK;
}

/** Режим «только при положительной марже». */
export function setRefineryMarginOnly(s: GameState, id: number, on: boolean): ActionResult {
  const b = getBuilding(s, id);
  if (!b || b.type !== 'refinery') return fail('Это не НПЗ');
  b.marginOnly = on;
  return OK;
}

/** Минимальная цена продажи нефтепродукта i — общая для всех НПЗ компании. */
export function setProductThreshold(s: GameState, i: number, price: number): void {
  if (i < 0 || i > 2) return;
  s.productThresholds[i] = Math.max(0, Math.round(price));
}

export function toggleEnabled(s: GameState, id: number): ActionResult {
  const b = getBuilding(s, id);
  if (!b || b.type === 'hq') return fail('Нельзя законсервировать');
  b.enabled = !b.enabled;
  return OK;
}

/** Цена перекупщика за баррель лёгкой (по умолчанию) или тяжёлой нефти. */
export function manualSellPrice(s: GameState, g: Grade = 0): number {
  return gradePrice(s, g) * MANUAL_SELL_FACTOR;
}

/** Сколько заплатит перекупщик за всю нефть сейчас (каждый сорт по своей цене). */
export function manualSellValue(s: GameState): number {
  const [light, heavy] = oilByGrade(s);
  return light * manualSellPrice(s, 0) + heavy * manualSellPrice(s, 1);
}

/** Ручная продажа всей нефти перекупщику. Возвращает выручку. */
/** Нефть, которую можно продать перекупщику: его бензовозы забирают из всех хранилищ компании. */
export function manualSellable(s: GameState): number {
  return s.oil;
}

export function sellManual(s: GameState): { ok: true; amount: number; revenue: number } | { ok: false; reason: string } {
  syncOil(s);
  if (s.oil < 1) return { ok: false, reason: 'На складе нет нефти' };
  const amount = s.oil;
  const revenue = manualSellValue(s);
  for (const b of s.buildings) if (b.stored !== undefined) b.stored = 0;
  syncOil(s);
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
  if (!regionOpen(s, parcelRegion(px, py))) return fail(`${REGIONS[parcelRegion(px, py)].name}: регион ещё не открыт`);
  if (!isParcelAdjacentToOwned(s, px, py)) return fail('Можно купить только соседний участок');
  if (s.cash < parcelPrice(s, px, py)) return fail('Недостаточно денег');
  return OK;
}

export function buyParcel(s: GameState, px: number, py: number): ActionResult {
  const check = canBuyParcel(s, px, py);
  if (!check.ok) return check;
  const price = parcelPrice(s, px, py);
  s.cash -= price;
  s.totals.capex += price;
  s.map.owned[parcelIndex(px, py)] = true;
  s.map.survey[parcelIndex(px, py)] = SURVEY_EXACT;
  return OK;
}

/**
 * Цена разведки участка до уровня level (1 — съёмка, 2 — сейсморазведка): доля текущей цены этого участка
 * (цена — по его региону). Без участка — по цене следующего участка степи.
 */
export function surveyCost(s: GameState, level: number, px?: number, py?: number): number {
  return Math.round(parcelPrice(s, px, py) * SURVEY_LEVELS[level - 1].costShare);
}

export function canSurvey(s: GameState, px: number, py: number, level: number): ActionResult {
  if (px < 0 || py < 0 || px >= PARCELS_PER_SIDE || py >= PARCELS_PER_SIDE) return fail('Нет такого участка');
  if (level < 1 || level > SURVEY_LEVELS.length) return fail('Нет такого вида разведки');
  if (surveyLevel(s, px, py) >= level) return fail('Уже разведано');
  if (s.cash < surveyCost(s, level, px, py)) return fail('Недостаточно денег');
  return OK;
}

/** Разведка чужого участка: деньги — во вложения (как земля и строительство). */
export function survey(s: GameState, px: number, py: number, level: number): ActionResult {
  const check = canSurvey(s, px, py, level);
  if (!check.ok) return check;
  const cost = surveyCost(s, level, px, py);
  s.cash -= cost;
  s.totals.capex += cost;
  s.map.survey[parcelIndex(px, py)] = level;
  return OK;
}

/**
 * Начать исследование следующего уровня технологии. Отказ, если исследования не открыты, идёт другое,
 * достигнут максимум или не хватает денег. Деньги списываются сразу (totals.research). Отмены нет.
 */
export function startResearch(s: GameState, id: TechId): ActionResult {
  if (!s.features.includes('research')) return fail('Исследования ещё не открыты — выполняйте цели');
  if (!TECHS[id]) return fail('Неизвестная технология');
  if (s.research.active) return fail('Уже идёт исследование — дождитесь его завершения');
  const next = techNextLevel(s, id);
  if (!next) return fail('Технология изучена полностью');
  if (s.cash < next.cost) return fail('Недостаточно денег');
  s.cash -= next.cost;
  s.totals.research += next.cost;
  s.research.active = { id, remaining: next.time };
  return OK;
}

/** Нанять или уволить менеджера. Найм бесплатный, зарплата идёт с каждой секунды работы. */
export function setManager(s: GameState, role: ManagerRole, on: boolean): ActionResult {
  if (!s.features.includes('managers')) return fail('Персонал ещё не открыт — выполняйте цели');
  s.managers = { ...s.managers, [role]: on };
  return OK;
}

/** Резерв кассы для главного механика. */
export function setManagerReserve(s: GameState, value: number): void {
  s.managers = { ...s.managers, reserve: Math.max(0, Math.round(value)) };
}

/**
 * Взять кредит: один за раз, не больше лимита, не при отрицательной кассе. Деньги поступают сразу
 * (totals.borrowed), погашение — аннуитетом в tick.
 */
export function takeLoan(s: GameState, amount = loanLimit(s)): ActionResult {
  if (!s.features.includes('loans')) return fail('Кредиты ещё не открыты — выполняйте цели');
  if (s.loan) return fail('Уже есть кредит — сначала погасите его');
  if (s.cash < 0) return fail('Касса в минусе — банк не выдаёт кредит');
  const limit = loanLimit(s);
  const L = Math.round(Math.min(amount, limit));
  if (L < 1000) return fail('Лимит кредита слишком мал — нарастите добычу');
  s.loan = { principal: L, start: s.time, rate: LOANS.ratePerMinute, term: LOANS.termMinutes * 60 };
  s.cash += L;
  s.totals.borrowed += L;
  return OK;
}

/** Досрочное погашение: вся сумма долга сразу, без штрафа. */
export function repayLoan(s: GameState): ActionResult {
  if (!s.loan) return fail('Кредита нет');
  const debt = loanDebt(s);
  if (s.cash < debt) return fail('Недостаточно денег для погашения');
  s.cash -= debt;
  s.totals.repaid += debt;
  s.loan = null;
  return OK;
}

export function setSellThreshold(s: GameState, price: number): void {
  s.sellThreshold = Math.max(0, Math.round(price));
}

export function buildingName(type: GameState['buildings'][number]['type']): string {
  return type === 'hq' ? 'Контора' : BUILDINGS[type].name;
}

// ——— Трубопроводы ———

export type PipeTile = [number, number];

/** Ломаная из двух отрезков от a к b через угол: сначала по более длинной оси (так тянут трубу мышью). */
export function pipePath(a: PipeTile, b: PipeTile): PipeTile[] {
  const corner: PipeTile = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]];
  const out: PipeTile[] = [[a[0], a[1]]];
  for (const target of [corner, b]) {
    let [x, y] = out[out.length - 1];
    while (x !== target[0] || y !== target[1]) {
      x += Math.sign(target[0] - x);
      y += Math.sign(target[1] - y);
      out.push([x, y]);
    }
  }
  return out;
}

export interface PipePlan {
  ok: boolean;
  reason?: string;
  /** Клетки, где появится или улучшится труба. */
  tiles: PipeTile[];
  cost: number;
}

/** Проверка прокладки: только своя свободная земля; существующая труба того же или лучшего типа — бесплатно. */
export function planPipes(s: GameState, tiles: PipeTile[], kind: 1 | 2): PipePlan {
  const out: PipeTile[] = [];
  let cost = 0;
  for (const [x, y] of tiles) {
    if (!inBounds(s, x, y)) return { ok: false, reason: 'За пределами карты', tiles: [], cost: 0 };
    if (!isTileOwned(s, x, y)) return { ok: false, reason: 'Трубу можно прокладывать только по своей земле', tiles: [], cost: 0 };
    if (buildingAt(s, x, y)) continue; // здание само является узлом — труба подходит к нему вплотную
    const have = s.map.pipes[tileIndex(s, x, y)];
    if (have >= kind) continue;
    cost += PIPES[kind].cost - (have > 0 ? PIPES[have as 1 | 2].cost : 0);
    out.push([x, y]);
  }
  if (out.length === 0) return { ok: false, reason: 'Здесь уже есть такая труба', tiles: [], cost: 0 };
  if (s.cash < cost) return { ok: false, reason: 'Недостаточно денег', tiles: out, cost };
  return { ok: true, tiles: out, cost };
}

export function layPipes(s: GameState, tiles: PipeTile[], kind: 1 | 2): ActionResult {
  const plan = planPipes(s, tiles, kind);
  if (!plan.ok) return fail(plan.reason!);
  s.cash -= plan.cost;
  s.totals.capex += plan.cost;
  for (const [x, y] of plan.tiles) {
    s.map.pipes[tileIndex(s, x, y)] = kind;
    s.map.decor[tileIndex(s, x, y)] = 0;
  }
  return OK;
}

/** Демонтаж труб с компенсацией половины стоимости. */
export function removePipes(s: GameState, tiles: PipeTile[]): { ok: boolean; reason?: string; refund: number; count: number } {
  let refund = 0;
  let count = 0;
  for (const [x, y] of tiles) {
    if (!inBounds(s, x, y)) continue;
    const i = tileIndex(s, x, y);
    const have = s.map.pipes[i];
    if (!have) continue;
    refund += Math.round(PIPES[have as 1 | 2].cost * PIPE_REFUND);
    s.map.pipes[i] = 0;
    count++;
  }
  if (count === 0) return { ok: false, reason: 'Здесь нет трубы', refund: 0, count: 0 };
  s.cash += refund;
  s.totals.refunds += refund;
  return { ok: true, refund, count };
}

/**
 * Кратчайший маршрут трубы от здания к сети с хранилищем по своей свободной земле.
 * Существующие трубы используются бесплатно (0–1 поиск в ширину), поэтому новые ветки примыкают к старым.
 * Для резервуара цель — другая сеть с хранилищем (подключение к общему хозяйству).
 */
export function planAutoConnect(s: GameState, id: number, kind: 1 | 2 = 1): PipePlan {
  const b = getBuilding(s, id);
  if (!b || b.type === 'hq') return { ok: false, reason: 'Нечего подключать', tiles: [], cost: 0 };
  const net = getNetwork(s);
  const n = s.map.size;
  const own = b.type === 'tank' ? net.compOfTile[b.y * n + b.x] : -1;
  const good = (c: number) => c >= 0 && c !== own && net.components[c].storages.length > 0;
  const already = b.type === 'tank' ? false : (() => {
    const c = net.attach.get(b.id);
    return c !== undefined && net.components[c].storages.length > 0;
  })();
  if (already) return { ok: false, reason: 'Уже подключено', tiles: [], cost: 0 };
  const passable = (x: number, y: number) => inBounds(s, x, y) && isTileOwned(s, x, y) && !buildingAt(s, x, y);
  // Клетка — цель, если на ней труба нужной сети или она примыкает к хранилищу нужной сети.
  const isTarget = (x: number, y: number) => {
    const i = y * n + x;
    if (s.map.pipes[i] > 0 && good(net.compOfTile[i])) return true;
    for (let k = 0; k < 4; k++) {
      const nx = x + [1, -1, 0, 0][k];
      const ny = y + [0, 0, 1, -1][k];
      if (!inBounds(s, nx, ny)) continue;
      const j = ny * n + nx;
      const nb = buildingAt(s, nx, ny);
      if (nb && nb.id !== b.id && (nb.type === 'hq' || nb.type === 'tank') && good(net.compOfTile[j])) return true;
    }
    return false;
  };
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const deque: number[] = [];
  for (let k = 0; k < 4; k++) {
    const x = b.x + [1, -1, 0, 0][k];
    const y = b.y + [0, 0, 1, -1][k];
    if (!passable(x, y)) continue;
    const i = y * n + x;
    const w = s.map.pipes[i] > 0 ? 0 : 1;
    if (!dist.has(i) || w < dist.get(i)!) {
      dist.set(i, w);
      if (w === 0) deque.unshift(i);
      else deque.push(i);
    }
  }
  let found = -1;
  const done = new Set<number>();
  while (deque.length) {
    const i = deque.shift()!;
    if (done.has(i)) continue;
    done.add(i);
    const x = i % n;
    const y = (i - x) / n;
    if (isTarget(x, y)) {
      found = i;
      break;
    }
    for (let k = 0; k < 4; k++) {
      const nx = x + [1, -1, 0, 0][k];
      const ny = y + [0, 0, 1, -1][k];
      if (!passable(nx, ny)) continue;
      const j = ny * n + nx;
      const d = dist.get(i)! + (s.map.pipes[j] > 0 ? 0 : 1);
      if (!dist.has(j) || d < dist.get(j)!) {
        dist.set(j, d);
        prev.set(j, i);
        if (d === dist.get(i)) deque.unshift(j);
        else deque.push(j);
      }
    }
  }
  if (found < 0) return { ok: false, reason: 'Нет пути по своей земле до хранилища', tiles: [], cost: 0 };
  const path: PipeTile[] = [];
  for (let t: number | undefined = found; t !== undefined; t = prev.get(t)) path.push([t % n, Math.floor(t / n)]);
  const missing = path.filter(([x, y]) => s.map.pipes[y * n + x] === 0);
  const cost = missing.length * PIPES[kind].cost;
  if (missing.length === 0) return { ok: false, reason: 'Уже подключено', tiles: [], cost: 0 };
  return { ok: s.cash >= cost, reason: s.cash >= cost ? undefined : 'Недостаточно денег', tiles: missing, cost };
}

/** Замена промысловых участков маршрута качалки или терминала магистралью — снятие узкого места одной кнопкой. */
export function planRouteUpgrade(s: GameState, id: number): PipePlan {
  // Фактический маршрут последнего тика (нефть могла пойти в дальнее хранилище), иначе — к ближайшему.
  const route = lastFlow(s)?.clients.get(id)?.path ?? getNetwork(s).routes.get(id);
  const n = s.map.size;
  if (!route) return { ok: false, reason: 'Нет маршрута до хранилища', tiles: [], cost: 0 };
  const tiles = route.filter((t) => s.map.pipes[t] === 1).map((t) => [t % n, Math.floor(t / n)] as PipeTile);
  if (tiles.length === 0) return { ok: false, reason: 'Маршрут уже магистральный', tiles: [], cost: 0 };
  return planPipes(s, tiles, 2);
}

export function autoConnect(s: GameState, id: number, kind: 1 | 2 = 1): ActionResult {
  const plan = planAutoConnect(s, id, kind);
  if (!plan.ok) return fail(plan.reason!);
  return layPipes(s, plan.tiles, kind);
}
