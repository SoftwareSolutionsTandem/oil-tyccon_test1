import {
  BUILDINGS,
  DEMOLISH_REFUND,
  DEPLETION_MIN_FACTOR,
  GRADES,
  HEAVY_SPREAD,
  HQ_STORAGE,
  MANUAL_SELL_FACTOR,
  PRODUCTS,
  REFINERY,
  MOTHBALL_UPKEEP,
  MARKET,
  PARCEL_BASE_PRICE,
  PARCEL_PRICE_GROWTH,
  STATS_WINDOW,
  TECHS,
  LOANS,
} from './config';
import type { BuildableType, Building, GameState, Grade, LoanState, StatBucket, TechId } from './types';
import { ownedParcelCount, tileIndex } from './world';

export function levelSpec(b: Building) {
  if (b.type === 'hq') return { cost: 0, upkeep: 0, value: HQ_STORAGE };
  return BUILDINGS[b.type].levels[b.level - 1];
}

export function maxLevel(type: BuildableType): number {
  return BUILDINGS[type].levels.length;
}

export function countOf(s: GameState, type: Building['type']): number {
  return s.buildings.filter((b) => b.type === type).length;
}

export function buildCost(s: GameState, type: BuildableType): number {
  const spec = BUILDINGS[type];
  // «Типовой проект станка» удешевляет только новые качалки; вложенное в построенные (invested) не меняется.
  const discount = type === 'pumpjack' ? 1 - TECHS.standard.step * techLevel(s, 'standard') : 1;
  return Math.round(spec.levels[0].cost * Math.pow(spec.costGrowth, countOf(s, type)) * discount);
}

// ——— Технологии (веха 0.4) ———

/** Достигнутый уровень технологии (0 — не исследована). */
export function techLevel(s: GameState, id: TechId): number {
  return s.research?.levels[id] ?? 0;
}

/** Множитель содержания от «энергосбережения» (1 — без технологии). */
export function upkeepFactor(s: GameState): number {
  return 1 - TECHS.energy.step * techLevel(s, 'energy');
}

/** Нижний предел добычи при истощении: DEPLETION_MIN_FACTOR, поднятый технологией «нефтеотдача». */
export function depletionFloor(s: GameState): number {
  return DEPLETION_MIN_FACTOR + TECHS.eor.step * techLevel(s, 'eor');
}

/** Цена следующего уровня технологии или null, если уровень максимальный. */
export function techNextLevel(s: GameState, id: TechId): { level: number; cost: number; time: number } | null {
  const k = techLevel(s, id);
  const spec = TECHS[id].levels[k];
  return spec ? { level: k + 1, ...spec } : null;
}

/** Опорная цена сорта для оценок окупаемости: средняя цена рынка и средняя скидка тяжёлой (без колебаний). */
export function referencePrice(g: Grade): number {
  return g === 1 ? MARKET.mean * (1 - HEAVY_SPREAD.mean) : MARKET.mean;
}

/**
 * Оценка эффекта следующего уровня технологии для текущего предприятия (для интерфейса и бота):
 * прирост добычи, барр./с; экономия содержания, $/с; прирост операционной прибыли, $/с, по опорным ценам;
 * для «типового проекта» — экономия на следующей качалке, $. Ограничения труб и сбыта не учитываются.
 */
export function techEffect(s: GameState, id: TechId): { rate: number; upkeep: number; profit: number; pumpSaving: number } {
  const k = techLevel(s, id);
  const step = TECHS[id].step;
  let rate = 0;
  let value = 0;
  let upkeep = 0;
  let pumpSaving = 0;
  if (id === 'yield' || id === 'eor') {
    const m = depletionFloor(s);
    for (const b of s.buildings) {
      if (b.type !== 'pumpjack' || !b.enabled) continue;
      const pool = drainagePool(s, b);
      if (pool.initial <= 0 || pool.reserve <= 0) continue;
      const x = pool.reserve / pool.initial;
      const now = nominalRate(s, b) * (m + (1 - m) * x);
      // yield: номинал ×(1 + step(k+1))/(1 + step·k); eor: предел m → m + step.
      const next = id === 'yield' ? (now * (1 + step * (k + 1))) / (1 + step * k) : nominalRate(s, b) * (m + step + (1 - m - step) * x);
      rate += next - now;
      value += (next - now) * referencePrice(pumpGrade(s, b));
    }
  } else if (id === 'energy') {
    // Содержание без технологии ×step — столько экономит следующий уровень.
    upkeep = (totalUpkeep(s) / (1 - step * k)) * step;
  } else {
    const base = BUILDINGS.pumpjack.levels[0].cost * Math.pow(BUILDINGS.pumpjack.costGrowth, countOf(s, 'pumpjack'));
    pumpSaving = base * step;
  }
  return { rate, upkeep, profit: value + upkeep, pumpSaving };
}

/** Стоимость улучшения до следующего уровня или null, если уровень максимальный. */
export function upgradeCost(b: Building): number | null {
  if (b.type === 'hq' || b.level >= maxLevel(b.type)) return null;
  return BUILDINGS[b.type].levels[b.level].cost;
}

export function demolishRefund(b: Building): number {
  return Math.round(b.invested * DEMOLISH_REFUND);
}

export function storageCapacity(s: GameState): number {
  let cap = 0;
  for (const b of s.buildings) {
    if (b.type === 'hq' || b.type === 'tank') cap += levelSpec(b).value;
  }
  return cap;
}

const SIDES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Зона дренирования скважины: своя клетка и соседние по сторонам клетки месторождения,
 * не занятые другими качалками. Скважина тянет нефть из всей зоны.
 */
export function drainageTiles(s: GameState, b: Building): number[] {
  const own = tileIndex(s, b.x, b.y);
  const out = [own];
  for (const [dx, dy] of SIDES) {
    const x = b.x + dx;
    const y = b.y + dy;
    if (x < 0 || y < 0 || x >= s.map.size || y >= s.map.size) continue;
    const i = tileIndex(s, x, y);
    if (s.map.initial[i] <= 0) continue;
    if (s.buildings.some((o) => o.type === 'pumpjack' && o.x === x && o.y === y)) continue;
    out.push(i);
  }
  return out;
}

/** Остаток и начальные запасы зоны дренирования. */
export function drainagePool(s: GameState, b: Building): { reserve: number; initial: number } {
  let reserve = 0;
  let initial = 0;
  for (const i of drainageTiles(s, b)) {
    reserve += s.map.reserve[i];
    initial += s.map.initial[i];
  }
  return { reserve, initial };
}

/** Текущая добыча качалки без учёта ограничения хранилища, барр./с. */
export function pumpRate(s: GameState, b: Building): number {
  const pool = drainagePool(s, b);
  return rateFromPool(s, b, pool.reserve, pool.initial);
}

/**
 * Единственная формула добычи: номинал × (m + (1 − m) · остаток/начальные), m — порог истощения с учётом
 * технологии. По уже посчитанной зоне дренирования — её использует и логистика (network.ts) без повторного обхода.
 */
export function rateFromPool(s: GameState, b: Building, reserve: number, initial: number): number {
  if (initial <= 0 || reserve <= 0) return 0;
  const m = depletionFloor(s);
  return nominalRate(s, b) * (m + (1 - m) * (reserve / initial));
}

/** Сорт нефти, которую добывает качалка: сорт месторождения её клетки (зона дренирования одного сорта). */
export function pumpGrade(s: GameState, b: Building): Grade {
  return (s.map.grade[tileIndex(s, b.x, b.y)] ?? 0) as Grade;
}

/**
 * Номинальная добыча качалки с учётом сорта (старые станки 1-го уровня медленнее тянут тяжёлую нефть)
 * и технологии «оптимизация режимов» (множитель после поправки на сорт).
 */
export function nominalRate(s: GameState, b: Building): number {
  const v = levelSpec(b).value;
  const graded = b.level === 1 ? v * GRADES[pumpGrade(s, b)].level1Rate : v;
  return graded * (1 + TECHS.yield.step * techLevel(s, 'yield'));
}

/**
 * Скидка на тяжёлую нефть, доля цены лёгкой. Зависит только от времени и seed (два цикла с фазами от seed),
 * поэтому не требует состояния и не сдвигает ГСЧ цены лёгкой нефти.
 */
export function heavySpread(s: GameState): number {
  const ph = ((s.seed >>> 0) % 997) / 997;
  const h = HEAVY_SPREAD;
  const v =
    h.mean +
    h.slowAmplitude * Math.sin((2 * Math.PI * s.time) / h.slowPeriod + ph * 6.283) +
    h.fastAmplitude * Math.sin((2 * Math.PI * s.time) / h.fastPeriod + ph * 17.3);
  return Math.min(h.max, Math.max(h.min, v));
}

/** Рыночная цена сорта, $/барр. Лёгкая — рыночная цена, тяжёлая — со скидкой. */
export function gradePrice(s: GameState, g: Grade): number {
  return g === 1 ? s.market.price * (1 - heavySpread(s)) : s.market.price;
}

/** Цена перекупщика для сорта. */
export function manualGradePrice(s: GameState, g: Grade): number {
  return gradePrice(s, g) * MANUAL_SELL_FACTOR;
}

// ——— Нефтепродукты и НПЗ ———

/** Цикл цены продукта i в момент t: синус с фазой от seed, без ГСЧ и без состояния. */
export function productCycle(s: GameState, i: number, t = s.time): number {
  const ph = (((s.seed >>> 0) * (i + 3) * 2654435761) >>> 0) / 4294967296;
  const v = 1 + PRODUCTS.amplitude * Math.sin((2 * Math.PI * t) / PRODUCTS.periods[i] + ph * 2 * Math.PI);
  return Math.min(PRODUCTS.max, Math.max(PRODUCTS.min, v));
}

/** Цена нефтепродукта i, $/барр.: база · (1 + alpha·(P/50 − 1)) · цикл. Частично следует за ценой нефти. */
export function productPrice(s: GameState, i: number, t = s.time, crude = s.market.price, cycle = true): number {
  const follow = 1 + PRODUCTS.alpha * (crude / 50 - 1);
  return PRODUCTS.base[i] * follow * (cycle ? productCycle(s, i, t) : 1);
}

/** Стоимость корзины продуктов из одного барреля сорта g по текущим ценам (cycle = false — по базовым циклам). */
export function basketValue(s: GameState, g: Grade, cycle = true): number {
  const y = REFINERY.yields[g];
  return y[0] * productPrice(s, 0, s.time, s.market.price, cycle) + y[1] * productPrice(s, 1, s.time, s.market.price, cycle) + y[2] * productPrice(s, 2, s.time, s.market.price, cycle);
}

/**
 * Маржа переработки барреля сорта g против его прямой продажи через терминал: предельная выгода,
 * без содержания НПЗ (оно платится и при простое) — основа флажка «только при выгоде».
 */
export function refineryMargin(s: GameState, g: Grade, cycle = true): number {
  return basketValue(s, g, cycle) - gradePrice(s, g);
}

/** Ёмкость склада каждого продукта и мощность отгрузки НПЗ его уровня. */
export function refineryProductCap(b: Building): number {
  return REFINERY.productCap[b.level - 1] ?? REFINERY.productCap[0];
}
export function refineryShip(b: Building): number {
  return REFINERY.ship[b.level - 1] ?? REFINERY.ship[0];
}

/** Суммарная мощность переработки работающих НПЗ, барр./с. */
export function refineryCapacity(s: GameState): number {
  let total = 0;
  for (const b of s.buildings) if (b.type === 'refinery' && b.enabled) total += levelSpec(b).value;
  return total;
}

/** Нефть по сортам во всех хранилищах. */
export function oilByGrade(s: GameState): [number, number] {
  const out: [number, number] = [0, 0];
  for (const b of s.buildings) if ((b.type === 'hq' || b.type === 'tank') && (b.stored ?? 0) > 0) out[b.grade ?? 0] += b.stored!;
  return out;
}

/**
 * Сколько секунд проработает качалка до полного истощения зоны (если её не делят с другими скважинами).
 * Добыча падает вместе с запасами: dr/dt = −v·(m + (1−m)·r/R), откуда t = R/(v(1−m))·ln(1 + (1−m)·r/(m·R)).
 */
export function timeToDeplete(s: GameState, b: Building): number {
  const { reserve: r, initial: R } = drainagePool(s, b);
  if (R <= 0 || r <= 0) return 0;
  const m = depletionFloor(s);
  const v = nominalRate(s, b);
  return (R / (v * (1 - m))) * Math.log(1 + ((1 - m) * r) / (m * R));
}

/** Суммарная мощность добычи работающих качалок, барр./с. */
export function productionCapacity(s: GameState): number {
  let total = 0;
  for (const b of s.buildings) {
    if (b.type === 'pumpjack' && b.enabled) total += pumpRate(s, b);
  }
  return total;
}

export function terminalThroughput(s: GameState): number {
  let total = 0;
  for (const b of s.buildings) {
    if (b.type === 'terminal' && b.enabled) total += levelSpec(b).value;
  }
  return total;
}

/**
 * Содержание здания, $/с. С состоянием s учитывается «энергосбережение» (и для законсервированных зданий);
 * без s — базовое содержание уровня (для справочных расчётов, где компании нет).
 */
export function buildingUpkeep(b: Building, s?: GameState): number {
  const upkeep = levelSpec(b).upkeep * (s ? upkeepFactor(s) : 1);
  return b.enabled ? upkeep : upkeep * MOTHBALL_UPKEEP;
}

export function totalUpkeep(s: GameState): number {
  return s.buildings.reduce((sum, b) => sum + buildingUpkeep(b, s), 0);
}

export function parcelPrice(s: GameState): number {
  return Math.round(PARCEL_BASE_PRICE * Math.pow(PARCEL_PRICE_GROWTH, ownedParcelCount(s) - 1));
}

export function emptyBucket(): StatBucket {
  return { produced: 0, sold: 0, revenue: 0, expenses: 0, refined: 0, productRevenue: 0 };
}

export function recordStat(s: GameState, key: keyof StatBucket, value: number): void {
  s.stats.current[key] += value;
}

export function advanceStats(s: GameState, dt: number): void {
  s.stats.currentTime += dt;
  while (s.stats.currentTime >= 1) {
    s.stats.currentTime -= 1;
    s.stats.buckets.push(s.stats.current);
    if (s.stats.buckets.length > STATS_WINDOW) s.stats.buckets.shift();
    s.stats.current = emptyBucket();
  }
}

/** Потоки за последнюю минуту (скользящее окно). */
export function lastMinute(s: GameState): StatBucket {
  const sum = emptyBucket();
  for (const b of [...s.stats.buckets, s.stats.current]) {
    sum.produced += b.produced;
    sum.sold += b.sold;
    sum.revenue += b.revenue;
    sum.expenses += b.expenses;
    // ?? 0 — у секунд из сохранений до v5 этих полей нет.
    sum.refined += b.refined ?? 0;
    sum.productRevenue += b.productRevenue ?? 0;
  }
  return sum;
}

// ——— Кредит (веха 0.4) ———

/** Непрерывная ставка за секунду: (1 + r) за минуту. */
function loanDelta(loan: LoanState): number {
  return Math.log(1 + loan.rate) / 60;
}

/** Платёж аннуитета, $/с: долг гасится ровно к концу срока. */
export function loanPayment(loan: LoanState): number {
  const d = loanDelta(loan);
  const e = Math.exp(d * loan.term);
  return (loan.principal * d * e) / (e - 1);
}

/** Долг через tau секунд после выдачи (замкнутая форма, не зависит от длины шага). */
export function loanDebtAt(loan: LoanState, tau: number): number {
  if (tau >= loan.term) return 0;
  const t = Math.max(0, tau);
  const d = loanDelta(loan);
  const e = Math.exp(d * t);
  return Math.max(0, loan.principal * e - (loanPayment(loan) * (e - 1)) / d);
}

/** Текущий долг компании, $. */
export function loanDebt(s: GameState): number {
  return s.loan ? loanDebtAt(s.loan, s.time - s.loan.start) : 0;
}

/** Переплата по кредиту за весь срок, $ (для интерфейса). */
export function loanOverpay(loan: LoanState): number {
  return loanPayment(loan) * loan.term - loan.principal;
}

/**
 * «Доходность компании», $/мин: мощность добычи по опорным ценам сортов минус содержание. Основа лимита кредита —
 * не прибыль последней минуты (она скачет с ценой), а то, что промысел может заработать.
 */
export function companyEarning(s: GameState): number {
  let value = 0;
  for (const b of s.buildings) if (b.type === 'pumpjack' && b.enabled) value += pumpRate(s, b) * referencePrice(pumpGrade(s, b));
  return 60 * (value - totalUpkeep(s));
}

/** Лимит кредита, $ (округлён до сотни). */
export function loanLimit(s: GameState): number {
  return Math.max(0, Math.floor((LOANS.limitMinutes * companyEarning(s)) / 100) * 100);
}

/** Капитал компании: касса минус долг (цель «Нефтяная компания», решение В3). */
export function capital(s: GameState): number {
  return s.cash - loanDebt(s);
}
