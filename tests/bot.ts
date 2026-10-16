import {
  applyConnect,
  connectOptions,
  planRouteUpgrade,
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
  isProducer,
  drainagePool,
  parcelRegion,
  regionOpen,
  REGIONS,
  parcelEstimate,
  parcelPrice,
  survey,
  surveyCost,
  surveyLevel,
  productionCapacity,
  sellManual,
  storageCapacity,
  terminalThroughput,
  tick,
  TICK,
  upgrade,
  upgradeCost,
  BUILDINGS,
  lastMinute,
  oilByGrade,
  refineryCapacity,
  refineryMargin,
  setProductThreshold,
  startResearch,
  takeLoan,
  setManager,
  LOANS,
  MANAGERS,
  techEffect,
  techLevel,
  techNextLevel,
  referencePrice,
  totalUpkeep,
  pumpGrade,
  TECH_IDS,
  TECHS,
  loanDebt,
  repayLoan,
  type BuildableType,
  type TechId,
  type GameState,
  type TickEvents,
} from '../src/core';

/**
 * Настройки бота. research / loans / managers: false — механика не используется (базовые прогоны для сравнения).
 * По умолчанию всё включено.
 */
export interface BotOptions {
  research?: boolean;
  loans?: boolean;
  managers?: boolean;
  /** Регионы (веха 0.5): false — бот не разведывает и не покупает землю новых регионов (прогон «без регионов»). */
  regions?: boolean;
}

/** Цена самого дешёвого участка, который можно купить (по соседству и в открытых регионах); Infinity — нет такого. */
function cheapestParcelPrice(s: GameState, opts: BotOptions = {}): number {
  let best = Infinity;
  for (let py = 0; py < PARCELS_PER_SIDE; py++)
    for (let px = 0; px < PARCELS_PER_SIDE; px++) {
      if ((opts.regions ?? true) === false && parcelRegion(px, py) !== 0) continue;
      if (canBuyParcel({ ...s, cash: Infinity }, px, py).ok) best = Math.min(best, parcelPrice(s, px, py));
    }
  return best === Infinity ? parcelPrice(s) : best;
}

/** Прибыль качалки 3-го уровня на клетке, $/с: опорная цена сорта клетки, технологии и содержание с поправкой региона. */
function topPumpGain(s: GameState, deposit: { x: number; y: number } | undefined): number {
  const top = BUILDINGS.pumpjack.levels[2];
  const grade = deposit ? pumpGrade(s, { x: deposit.x, y: deposit.y } as GameState['buildings'][number]) : 0;
  const region = deposit ? REGIONS[s.map.region[deposit.y * s.map.size + deposit.x]] : REGIONS[0];
  return top.value * (1 + TECHS.yield.step * techLevel(s, 'yield')) * referencePrice(grade) - top.upkeep * region.pumpUpkeep * (1 - TECHS.energy.step * techLevel(s, 'energy'));
}

/**
 * Простой «жадный» игрок для проверки баланса: показывает, проходима ли игра и с каким темпом.
 * onTick — наблюдатель за каждым шагом (метрики баланс-прогона НПЗ), состояние не меняет.
 */
export function runBot(
  s: GameState,
  minutes: number,
  onTick?: (ev: TickEvents, s: GameState) => void,
  opts: BotOptions = {},
): { reachedAt: Record<string, number>; minCash: number } {
  const reachedAt: Record<string, number> = {};
  let minCash = s.cash;
  const steps = Math.round((minutes * 60) / TICK);
  for (let i = 0; i < steps; i++) {
    const ev = tick(s, TICK);
    for (const o of ev.completed) reachedAt[o.id] = s.time;
    onTick?.(ev, s);
    minCash = Math.min(minCash, s.cash);
    noteIssues(s);
    if (i % 10 === 0) {
      decide(s, opts);
      recentIssues.delete(s);
    }
  }
  return { reachedAt, minCash };
}

/** Узкое место, замеченное за шаги между решениями: статус и поток того шага, где оно было. */
interface Issue {
  status: 'throttled' | 'full';
  bottleneck: number;
  path: number[];
}
/**
 * Узкие места за все шаги между решениями бота. Статус бывает на границе (хранилище то полно, то почти полно)
 * и меняется через шаг; бот, глядящий только на последний шаг, видел бы одну фазу и не реагировал.
 */
const recentIssues = new WeakMap<GameState, Map<number, Issue>>();

function noteIssues(s: GameState): void {
  const flow = lastFlow(s);
  if (!flow) return;
  let m = recentIssues.get(s);
  for (const b of s.buildings) {
    if (b.status !== 'throttled' && b.status !== 'full') continue;
    if (!isProducer(b) && b.type !== 'terminal' && b.type !== 'refinery') continue;
    if (!m) recentIssues.set(s, (m = new Map()));
    const c = flow.clients.get(b.id);
    m.set(b.id, { status: b.status, bottleneck: c?.bottleneck ?? -1, path: c ? [...c.path] : [] });
  }
}

/** Сорта нефти, которые сейчас есть в хранилищах компании (битовая маска). */
function presentGrades(s: GameState): number {
  const [light, heavy] = oilByGrade(s);
  return (light > 1 ? 1 : 0) | (heavy > 1 ? 2 : 0);
}

/**
 * НПЗ (раздел 8 плана). Строит первый НПЗ, только если: он открыт и денег не меньше 1,5 его цены; добыча за минуту
 * не меньше 1,5 мощности 1-го уровня; клетка рядом с хранилищем даёт по пробной работе на копии состояния (10 с обычной
 * симуляции: фактические запасы, добыча, конкуренция терминалов, трубы) не меньше 75% мощности; у какого-то из
 * имеющихся сортов маржа по базовым ценам положительна. Продукты не держит (пороги 0), флажок маржи не снимает.
 * Улучшает НПЗ, если загрузка выше 90% две проверки подряд, маржа доступного сорта положительна и денег с запасом.
 */
const refineryBusy = new WeakMap<GameState, number>();
/** Длительность пробной работы НПЗ на копии состояния при выборе места, с. */
const TRIAL_SECONDS = 10;

export function manageRefinery(s: GameState): void {
  if (!s.unlocked.includes('refinery')) return;
  const refineries = s.buildings.filter((b) => b.type === 'refinery');
  const present = presentGrades(s) || 1;
  const marginOk = ([0, 1] as const).some((g) => ((present >> g) & 1) === 1 && refineryMargin(s, g, false) > 0);
  // Цель M06 «Второй НПЗ»: второй завод — как первый, но без требования запаса нефти и с пробной загрузкой от 25%.
  const pair = OBJECTIVES[s.objectiveIndex]?.id === 'refinery_pair';
  if (refineries.length === 0 || (pair && refineries.length === 1 && refineries[0].level === 3)) {
    const cost = buildCost(s, 'refinery');
    if (s.cash < cost * 1.5 || !marginOk) return;
    const cap1 = BUILDINGS.refinery.levels[0].value;
    // Нефти в целом должно хватать: НПЗ делит её с терминалами пропорционально запросам, поэтому «остаток после
    // терминалов» не нужен — его фактическую долю проверяет пробный расчёт ниже (не меньше 75% мощности).
    if (!pair && lastMinute(s).produced / 60 < cap1 * 1.5) return;
    // Клетки рядом с хранилищами: пробный расчёт потока на копии состояния — берём лучшую.
    let best: { x: number; y: number; flow: number } | null = null;
    for (const st of s.buildings) {
      if (st.type !== 'hq' && st.type !== 'tank') continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = st.x + dx;
        const y = st.y + dy;
        if (!canBuild({ ...s, cash: Infinity }, 'refinery', x, y).ok) continue;
        // Пробная работа на копии: 10 с обычной симуляции (добыча, терминалы, трубы) с фактическими запасами.
        // Нефть лежит не везде поровну, и НПЗ полезен там, куда она реально доходит; средний поток за 10 с
        // честнее одного шага, когда терминалы держат хранилища почти пустыми.
        const copy: GameState = structuredClone(s);
        copy.cash = Infinity;
        if (!build(copy, 'refinery', x, y).ok) continue;
        const r = copy.buildings[copy.buildings.length - 1];
        r.marginOnly = false;
        let refined = 0;
        for (let k = 0; k < TRIAL_SECONDS; k++) refined += tick(copy, 1).refined;
        const flow = refined / TRIAL_SECONDS;
        if (!best || flow > best.flow) best = { x, y, flow };
      }
    }
    if (!best || best.flow < cap1 * (pair ? 0.25 : 0.75)) return;
    build(s, 'refinery', best.x, best.y);
    return;
  }
  for (const r of refineries) {
    // Склад продукта полон — продукт продаётся сразу (порог 0).
    if (r.status === 'product_full') for (let i = 0; i < 3; i++) setProductThreshold(s, i, 0);
    // НПЗ упирается в трубу — как игрок кнопками панели: отдельная ветка, если она даёт больше, иначе магистраль.
    if (r.status === 'throttled') {
      const branch = connectOptions(s, r.id, 2).find((o) => o.kind === 'branch' && o.ok);
      if (branch && s.cash >= branch.cost * 2) applyConnect(s, branch);
      else {
        const plan = planRouteUpgrade(s, r.id);
        if (plan.ok && s.cash >= plan.cost * 2) layPipes(s, plan.tiles, 2);
      }
    }
    const cap = levelSpec(r).value;
    const busy = lastMinute(s).refined / 60 >= cap * 0.9 ? (refineryBusy.get(s) ?? 0) + 1 : 0;
    refineryBusy.set(s, busy);
    const c = upgradeCost(r);
    if (c !== null && (busy >= 2 || pair) && marginOk && s.cash >= c * 1.5) {
      upgrade(s, r.id);
      refineryBusy.set(s, 0);
    }
  }
}

/**
 * Клетка под морскую платформу на своём шельфе: наибольшие запасы зоны дренирования; окупается ли она —
 * запасы зоны по опорной цене не меньше 4 цен постройки и улучшений до 3-го уровня.
 */
function platformSpot(s: GameState): { x: number; y: number; pool: number } | null {
  if (!s.unlocked.includes('platform')) return null;
  let best: { x: number; y: number; pool: number } | null = null;
  const free = { ...s, cash: Infinity };
  for (let y = 0; y < s.map.size; y++)
    for (let x = 0; x < s.map.size; x++) {
      if (s.map.region[y * s.map.size + x] !== 2 || s.map.initial[y * s.map.size + x] <= 0) continue;
      if (!canBuild(free, 'platform', x, y).ok) continue;
      const probe = { id: -1, type: 'platform', x, y, level: 1, enabled: true, invested: 0, status: 'ok' } as GameState['buildings'][number];
      const pool = drainagePool(s, probe).reserve;
      if (!best || pool > best.pool) best = { x, y, pool };
    }
  if (!best) return null;
  const full = buildCost(s, 'platform') + BUILDINGS.platform.levels[1].cost + BUILDINGS.platform.levels[2].cost;
  return best.pool * referencePrice(0) >= 4 * full ? best : null;
}

/**
 * Окупаемость следующего добывающего здания, с: постройка и улучшения до 3-го уровня / прибыль 3-го уровня по опорной
 * цене сорта клетки (с технологиями и поправкой региона на содержание).
 */
/** Окупаемость следующей качалки, с, дольше которой бот с регионами покупает землю нового региона. */
const LAND_SWITCH = 1800;

/** Можно ли купить (при деньгах) участок открытого нового региона рядом со своей землёй — или «мост» к нему. */
function regionParcelAvailable(s: GameState): boolean {
  for (let py = 0; py < PARCELS_PER_SIDE; py++)
    for (let px = 0; px < PARCELS_PER_SIDE; px++) {
      if (!canBuyParcel({ ...s, cash: Infinity }, px, py).ok) continue;
      if (parcelRegion(px, py) !== 0 || bridgeTo(s, px, py) > 0) return true;
    }
  return false;
}

/** Условная оценка запасов неразведанного участка нового региона для «моста», барр. (Временно, только для бота). */
const BRIDGE_GUESS = 40_000;

/**
 * «Мостовой» участок степи (решение 2б-3): соседний с ним участок открытого нового региона пока не купить (нет своей
 * земли рядом). Возвращает оценку запасов лучшего такого соседа — её бот добавляет к ценности участка степи.
 */
function bridgeTo(s: GameState, px: number, py: number): number {
  if (parcelRegion(px, py) !== 0) return 0;
  let best = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const qx = px + dx;
    const qy = py + dy;
    if (qx < 0 || qy < 0 || qx >= PARCELS_PER_SIDE || qy >= PARCELS_PER_SIDE) continue;
    const r = parcelRegion(qx, qy);
    if (r === 0 || !regionOpen(s, r) || s.map.owned[qy * PARCELS_PER_SIDE + qx]) continue;
    if (canBuyParcel({ ...s, cash: Infinity }, qx, qy).ok) return 0; // уже есть путь — мост не нужен
    const e = parcelEstimate(s, qx, qy);
    best = Math.max(best, e.reserves ? (e.reserves.low + e.reserves.high) / 2 : BRIDGE_GUESS);
  }
  return best;
}

function producerPayback(s: GameState, type: 'pumpjack' | 'platform', at: { x: number; y: number }): number {
  const levels = BUILDINGS[type].levels;
  const cost = buildCost(s, type) + levels[1].cost + levels[2].cost;
  if (type === 'pumpjack') return cost / Math.max(1e-9, topPumpGain(s, at));
  const gain = levels[2].value * (1 + TECHS.yield.step * techLevel(s, 'yield')) * referencePrice(0) - levels[2].upkeep * (1 - TECHS.energy.step * techLevel(s, 'energy'));
  return cost / Math.max(1e-9, gain);
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

/** Радиус, в котором бот ставит и улучшает терминал у полного хранилища, клеток. */
const SELL_RADIUS = 3;

/**
 * Вывоз у полного хранилища: улучшить его терминал; если терминалы рядом на максимуме — поставить ещё один.
 * 'acted' — сделано, 'wait' — копим деньги, 'none' — у этого хранилища сделать нечего (нет места).
 */
function sellAtStorage(s: GameState, st: GameState['buildings'][number]): 'acted' | 'wait' | 'none' {
  // Терминалы этого хранилища — в пределах SELL_RADIUS (дальние подключены магистралью, см. ниже).
  const terms = s.buildings.filter((o) => o.type === 'terminal' && Math.abs(o.x - st.x) + Math.abs(o.y - st.y) <= SELL_RADIUS);
  const term = terms.find((o) => upgradeCost(o) !== null);
  if (term) {
    const c = upgradeCost(term)!;
    if (s.cash < c) return 'wait';
    upgrade(s, term.id);
    return 'acted';
  }
  // Вплотную — без трубы; если рядом места нет — в паре клеток с подключением магистралью.
  const t = nearestFreeTile(s, st.x, st.y, SELL_RADIUS);
  if (!t) return 'none';
  if (s.cash < buildCost(s, 'terminal')) return 'wait';
  if (!build(s, 'terminal', t.x, t.y).ok) return 'none';
  if (Math.abs(t.x - st.x) + Math.abs(t.y - st.y) > 1) autoConnect(s, s.buildings[s.buildings.length - 1].id, 2);
  return 'acted';
}

/**
 * Узкие места, по порядку:
 * 1) терминал или НПЗ упирается в промысловую трубу — она меняется на магистраль («Усилить маршрут»);
 * 2) у качалки «склад полон» — терминал у ближайшего хранилища или его улучшение;
 * 3) промысловые трубы на маршруте качалки к ближайшему хранилищу — на магистраль;
 * 4) ближайшее хранилище полно и нефть идёт дальше — по узкой клетке фактического пути качалки: промысловая
 *    труба — на магистраль; магистраль — вывоз у источника (терминал у полного хранилища), как в п. 2;
 * 5) иначе, если и магистраль перегружена, — резервуар-коллектор рядом с качалкой, подключённый магистралью:
 *    соседние качалки качают в него коротким путём, а терминал забирает из него одним потоком.
 * Если для качалки сделать нечего, бот смотрит следующую, а не застревает на ней.
 */
function fixBottlenecks(s: GameState): void {
  if (!lastFlow(s)) return;
  // Качалке другого сорта некуда качать (хранилища заняты другим сортом) — свой резервуар рядом с ней.
  const stuck = s.buildings.find((b) => b.type === 'pumpjack' && b.status === 'wrong_grade');
  if (stuck && s.unlocked.includes('tank') && s.cash >= buildCost(s, 'tank')) {
    const t = nearestFreeTile(s, stuck.x, stuck.y, 6);
    if (t && build(s, 'tank', t.x, t.y).ok) {
      const id = s.buildings[s.buildings.length - 1].id;
      // Отдельная сеть для резервуара другого сорта не нужна: хватает подключения качалки к нему.
      autoConnect(s, stuck.id);
      if (stuck.status === 'wrong_grade') autoConnect(s, id);
    }
    return;
  }
  const net = getNetwork(s);
  const flow = lastFlow(s)!;
  const issues = recentIssues.get(s);
  // Статус и поток: текущий шаг, а если сейчас проблемы нет — последний шаг, где она была.
  const statusOf = (b: GameState['buildings'][number]) => (b.status === 'throttled' || b.status === 'full' ? b.status : (issues?.get(b.id)?.status ?? b.status));
  const flowOf = (b: GameState['buildings'][number]) =>
    b.status === 'throttled' || b.status === 'full' ? flow.clients.get(b.id) : (issues?.get(b.id) ?? flow.clients.get(b.id));
  const xy = (t: number) => [t % s.map.size, Math.floor(t / s.map.size)] as [number, number];
  // Вывоз упирается в промысловую трубу (терминал или НПЗ «ограничен трубой») — она меняется на магистраль,
  // как кнопкой «Усилить маршрут»: иначе нефть копится в дальних коллекторах, а качалки стоят.
  for (const o of s.buildings) {
    if ((o.type !== 'terminal' && o.type !== 'refinery') || statusOf(o) !== 'throttled') continue;
    const c = flowOf(o);
    const bt = c?.bottleneck ?? -1;
    if (bt < 0 || s.map.pipes[bt] !== 1) continue;
    const path = [...new Set([bt, ...c!.path])].filter((t) => s.map.pipes[t] === 1).map(xy);
    if (s.cash > path.length * 60) layPipes(s, path, 2);
    return;
  }
  for (const b of s.buildings) {
    const status = statusOf(b);
    if (!isProducer(b) || (status !== 'throttled' && status !== 'full')) continue;
    const st = net.reach.get(b.id)?.[0]?.storage;
    if (status === 'full') {
      // Хранилище у качалки полно: не хватает вывоза — терминал прямо у ближайшего хранилища или его улучшение.
      if (!st || !s.unlocked.includes('terminal')) continue;
      if (sellAtStorage(s, st) === 'none') continue; // у этого хранилища делать нечего — следующая качалка
      return;
    }
    const route = net.routes.get(b.id) ?? [];
    const tiles = route.filter((t) => s.map.pipes[t] === 1).map(xy);
    if (tiles.length) {
      if (s.cash > tiles.length * 60) layPipes(s, tiles, 2);
      return;
    }
    // Ближайшее хранилище полно — нефть идёт дальше, и узкое место лежит на фактическом пути качалки, а не на
    // маршруте к ближайшему хранилищу: промысловую трубу там меняем на магистраль; если упирается магистраль,
    // улучшать нечего — вывоз у источника, как при «склад полон» (дальний промысел за единственной магистралью).
    if (st && levelSpec(st).value - (st.stored ?? 0) <= 1e-6) {
      const c = flowOf(b);
      const bt = c?.bottleneck ?? -1;
      if (bt >= 0 && s.map.pipes[bt] === 1) {
        const path = [...new Set([bt, ...c!.path])].filter((t) => s.map.pipes[t] === 1).map(xy);
        if (s.cash > path.length * 60) layPipes(s, path, 2);
        return;
      }
      if (bt >= 0 && s.map.pipes[bt] === 2 && s.unlocked.includes('terminal') && sellAtStorage(s, st) !== 'none') return;
    }
    // Короткий маршрут перегружен чужими потоками — разгружать надо дальние качалки, а не эту.
    if ((net.reach.get(b.id)?.[0]?.length ?? 0) <= 3) continue;
    if (s.unlocked.includes('tank') && s.cash > buildCost(s, 'tank') * 1.5 + 500) {
      const t = nearestFreeTile(s, b.x, b.y, 4);
      if (t && build(s, 'tank', t.x, t.y).ok) autoConnect(s, s.buildings[s.buildings.length - 1].id, 2);
    }
    return;
  }
}

/** Технология, на которую бот копит (не строит новые качалки и не покупает землю), — до покупки или пересмотра. */
const researchGoal = new WeakMap<GameState, TechId | null>();
/** История числа качалок (время, число) — темп покупки для оценки «типового проекта». */
const pumpHistory = new WeakMap<GameState, Array<[number, number]>>();
/** Окно оценки темпа покупки качалок, с. */
const PUMP_RATE_WINDOW = 600;

/**
 * Исследования (раздел 4.6 M04_DESIGN): раз в 10 с окупаемость следующего уровня каждой технологии
 * `цена / Δприбыль в секунду` сравнивается с окупаемостью следующей качалки (постройка и улучшение до 3-го уровня,
 * а если свободных клеток месторождений нет — плюс участок). Если технология окупается быстрее, бот копит на неё
 * и начинает исследование, когда денег хватает на цену и минуту содержания. Для «типового проекта» прибыль —
 * экономия на каждой качалке × темп их покупки за последние 10 минут.
 */
function manageResearch(s: GameState, opts: BotOptions): void {
  const hist = pumpHistory.get(s) ?? [];
  hist.push([s.time, countOf(s, 'pumpjack')]);
  while (hist.length > 1 && hist[0][0] < s.time - PUMP_RATE_WINDOW) hist.shift();
  pumpHistory.set(s, hist);
  if (!s.features.includes('research') || s.research.active) {
    researchGoal.set(s, null);
    return;
  }
  const pumpRateNow = hist.length > 1 ? (hist[hist.length - 1][1] - hist[0][1]) / Math.max(1, hist[hist.length - 1][0] - hist[0][0]) : 0;
  let best: { id: TechId; cost: number; payback: number } | null = null;
  for (const id of TECH_IDS) {
    const next = techNextLevel(s, id);
    if (!next) continue;
    const e = techEffect(s, id);
    const gain = id === 'standard' ? e.pumpSaving * pumpRateNow : e.profit;
    if (gain <= 0) continue;
    const payback = next.cost / gain;
    if (!best || payback < best.payback) best = { id, cost: next.cost, payback };
  }
  // Следующая качалка: постройка + улучшения до 3-го уровня; прибыль 3-го уровня по опорной цене сорта клетки.
  const deposit = freeTiles(s, true)[0];
  const top = BUILDINGS.pumpjack.levels[2];
  const pumpGain = topPumpGain(s, deposit);
  const pumpCost = buildCost(s, 'pumpjack') + BUILDINGS.pumpjack.levels[1].cost + top.cost + (deposit ? 0 : cheapestParcelPrice(s, opts));
  const pumpPayback = pumpCost / pumpGain;
  if (!best || best.payback >= pumpPayback) {
    researchGoal.set(s, null);
    return;
  }
  if (s.cash >= best.cost + totalUpkeep(s) * 60 && startResearch(s, best.id).ok) researchGoal.set(s, null);
  else researchGoal.set(s, best.id);
}

/**
 * Кредит и персонал (раз в 10 с). Кредит — на весь лимит, если минутная отдача следующей качалки
 * (прибыль 3-го уровня / её полная цена) выше ставки в 1,5 раза: заём окупается быстрее, чем растут проценты.
 * Персонал — нанимается, как только открыт и в кассе есть 10 минут зарплаты.
 */
function manageCompany(s: GameState, opts: BotOptions): void {
  if ((opts.loans ?? true) && !capitalGoal(s, opts) && s.features.includes('loans') && !s.loan && s.cash >= 0) {
    const deposit = freeTiles(s, true)[0];
    const top = BUILDINGS.pumpjack.levels[2];
    const gain = topPumpGain(s, deposit);
    const cost = buildCost(s, 'pumpjack') + BUILDINGS.pumpjack.levels[1].cost + top.cost + (deposit ? 0 : cheapestParcelPrice(s, opts));
    if ((gain * 60) / cost > 1.5 * LOANS.ratePerMinute) takeLoan(s);
  }
  if ((opts.managers ?? true) && s.features.includes('managers')) {
    const pay = (MANAGERS.dispatcher.salary + MANAGERS.mechanic.salary) * 600;
    if (!s.managers.dispatcher && s.cash > pay) setManager(s, 'dispatcher', true);
    if (!s.managers.mechanic && s.cash > pay) setManager(s, 'mechanic', true);
  }
}

/**
 * Цель «Нефтяная компания» (капитал $500 000), за которой открывается пустыня (веха 0.5): бот с регионами копит —
 * не покупает и не разведывает землю, не начинает исследования и не берёт новый кредит; качалки на своих
 * месторождениях, улучшения и логистика идут как обычно.
 */
function capitalGoal(s: GameState, opts: BotOptions): boolean {
  return (opts.regions ?? true) && CAPITAL_GOALS.has(goalId(s));
}

/** Цели с капиталом «касса − долг» (cash_500k и цели M06 capital_1m, empire): бот копит, как описано выше. */
const CAPITAL_GOALS = new Set(['cash_500k', 'capital_1m', 'empire']);
/** id текущей цели цепочки ('' — цепочка пройдена, идут ступени). */
const goalId = (s: GameState) => OBJECTIVES[s.objectiveIndex]?.id ?? '';

/**
 * Цели M06, требующие решения (как сделал бы игрок, читая цель): «Наукоёмкая компания» — исследует самый дешёвый
 * доступный уровень, когда денег хватает на него и минуту содержания (без сравнения окупаемости); «Компания на
 * автопилоте» — гасит кредит досрочно, когда касса покрывает долг с запасом 20%.
 */
function pursueGoal(s: GameState): void {
  const id = goalId(s);
  if ((id === 'science' || id === 'science_2') && s.features.includes('research') && !s.research.active) {
    let pick: { id: TechId; cost: number } | null = null;
    for (const t of TECH_IDS) {
      const next = techNextLevel(s, t);
      if (id === 'science_2' && techLevel(s, t) >= 2) continue;
      if (next && (!pick || next.cost < pick.cost)) pick = { id: t, cost: next.cost };
    }
    if (pick && s.cash >= pick.cost + totalUpkeep(s) * 60) startResearch(s, pick.id);
  }
  if (id === 'autopilot' && s.loan && s.cash > loanDebt(s) * 1.2) repayLoan(s);
}

function decide(s: GameState, opts: BotOptions = {}): void {
  const research = opts.research ?? true;
  // Всё построенное ранее, но не подключённое (например, после покупки земли появился путь), подключаем.
  for (const b of s.buildings) if (b.type !== 'hq' && b.status === 'no_route') autoConnect(s, b.id);
  fixBottlenecks(s);
  const cap = storageCapacity(s);
  const hasTerminal = countOf(s, 'terminal') > 0;
  // Продаём вручную, когда качалки упёрлись в заполненные хранилища (так это видит игрок по статусу «склад полон»).
  // Склад почти полон, а качалки упираются в трубу к единственному свободному хранилищу — тоже повод продать.
  const stuck = s.buildings.some((b) => b.type === 'pumpjack' && (b.status === 'full' || b.status === 'wrong_grade' || (b.status === 'throttled' && s.oil > cap * 0.7)));
  // Касса ушла в минус (цена провалилась, а содержание идёт) — продаём запасы, как сделал бы игрок.
  if (s.cash < 0 && s.oil > 50) sellManual(s);
  if (stuck || (s.oil > cap * 0.9 && (!hasTerminal || terminalThroughput(s) < productionCapacity(s) * 0.5))) sellManual(s);

  // Терминалам нужна мощность только на ту нефть, которую не забирает НПЗ.
  if (s.unlocked.includes('terminal') && terminalThroughput(s) + refineryCapacity(s) < productionCapacity(s)) {
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

  // Раз в 10 решений (примерно раз в 10 с) — НПЗ: пробный расчёт мест дорогой.
  if (Math.floor(s.time) % 10 === 0) manageRefinery(s);
  if (research && !capitalGoal(s, opts) && Math.floor(s.time) % 10 === 0) manageResearch(s, opts);
  if (Math.floor(s.time) % 10 === 0) manageCompany(s, opts);
  if (Math.floor(s.time) % 10 === 0) pursueGoal(s);
  // Цели «Выход в пустыню» и «Выход на шельф»: съёмка участка региона, ближайшего к своей земле.
  const goalRegion = { desert: 1, shelf: 2 }[OBJECTIVES[s.objectiveIndex]?.id ?? ''];
  if ((opts.regions ?? true) && goalRegion !== undefined) {
    let pick: { px: number; py: number; d: number } | null = null;
    for (let py = 0; py < PARCELS_PER_SIDE; py++)
      for (let px = 0; px < PARCELS_PER_SIDE; px++) {
        if (parcelRegion(px, py) !== goalRegion) continue;
        let d = Infinity;
        for (let qy = 0; qy < PARCELS_PER_SIDE; qy++)
          for (let qx = 0; qx < PARCELS_PER_SIDE; qx++) if (s.map.owned[qy * PARCELS_PER_SIDE + qx]) d = Math.min(d, Math.abs(qx - px) + Math.abs(qy - py));
        if (!pick || d < pick.d) pick = { px, py, d };
      }
    if (pick && s.cash >= surveyCost(s, 1, pick.px, pick.py)) survey(s, pick.px, pick.py, 1);
  }
  // Копим на технологию — новые качалки, разведку и землю откладываем (улучшения и логистика идут дальше).
  // Цели капитала M06 (capital_1m, empire) — так же: новых зданий и земли нет, пока капитал не набран.
  const saving = (research && !!researchGoal.get(s)) || (CAPITAL_GOALS.has(goalId(s)) && goalId(s) !== 'cash_500k');

  let deposit = saving ? undefined : freeTiles(s, true)[0];
  const spot = saving ? null : platformSpot(s);
  // Качалка дорожает ×1,2 за каждую: если следующая окупается дольше LAND_SWITCH, а рядом есть участок нового
  // региона, бот идёт за землёй (там — платформы со своей кривой цены), а не копит на качалку.
  if (deposit && !spot && (opts.regions ?? true) && !capitalGoal(s, opts) && producerPayback(s, 'pumpjack', deposit) > LAND_SWITCH && regionParcelAvailable(s)) deposit = undefined;
  if (saving) {
    // ничего не строим и не покупаем
  } else if (spot && (!deposit || producerPayback(s, 'platform', spot) < producerPayback(s, 'pumpjack', deposit))) {
    // Качалка дорожает ×1,2 за каждую — поздно платформа (своя кривая цены) окупается быстрее.
    if (s.cash >= buildCost(s, 'platform') * 1.2) buildConnected(s, 'platform', spot.x, spot.y);
  } else if (deposit) {
    if (s.cash >= buildCost(s, 'pumpjack')) buildConnected(s, 'pumpjack', deposit.x, deposit.y);
  } else if (capitalGoal(s, opts)) {
    // копим капитал: землю не разведываем и не покупаем
  } else {
    // Земля: сначала геологическая съёмка всех соседних участков (по одному за ход), затем сейсморазведка
    // лучшего, если денег с запасом, и покупка по оценке. Тяжёлая нефть дешевле — её запасы бот ценит ниже.
    const cands: Array<{ px: number; py: number }> = [];
    for (let py = 0; py < PARCELS_PER_SIDE; py++)
      for (let px = 0; px < PARCELS_PER_SIDE; px++) {
        if ((opts.regions ?? true) === false && parcelRegion(px, py) !== 0) continue;
        if (canBuyParcel({ ...s, cash: Infinity }, px, py).ok) cands.push({ px, py });
      }
    const unknown = cands.find((c) => surveyLevel(s, c.px, c.py) === 0);
    if (unknown) {
      if (s.cash >= surveyCost(s, 1, unknown.px, unknown.py)) survey(s, unknown.px, unknown.py, 1);
      return;
    }
    const mid = (r: { low: number; high: number } | null) => (r ? (r.low + r.high) / 2 : 0);
    const value = (c: { px: number; py: number }) => {
      const e = parcelEstimate(s, c.px, c.py);
      return e.light && e.heavy ? mid(e.light) + mid(e.heavy) * 0.7 : mid(e.reserves) * 0.85;
    };
    // Регион и участок — по цене барреля оценённых запасов (в одном регионе цена одна, и это выбор по запасам).
    let best: { px: number; py: number; perBarrel: number } | null = null;
    for (const c of cands) {
      // Пустой по оценке участок (нужен ради соседства) — в конце очереди, среди них — дешёвый.
      // Мост к региону: участок степи ценится и по запасам соседа из нового региона (только в прогонах с регионами).
      const bridge = (opts.regions ?? true) ? bridgeTo(s, c.px, c.py) : 0;
      const perBarrel = (parcelPrice(s, c.px, c.py) + (bridge > 0 ? REGIONS[1].parcelBase : 0)) / Math.max(1, value(c) + bridge);
      if (!best || perBarrel < best.perBarrel) best = { ...c, perBarrel };
    }
    if (!best) return;
    if (surveyLevel(s, best.px, best.py) < 2 && s.cash >= parcelPrice(s, best.px, best.py) * 1.25 + surveyCost(s, 2, best.px, best.py)) {
      survey(s, best.px, best.py, 2);
      return;
    }
    buyParcel(s, best.px, best.py);
  }

  for (const b of s.buildings) {
    const cost = isProducer(b) ? upgradeCost(b) : null;
    if (cost !== null && s.cash > cost * 2 && levelSpec(b).value > 0) upgrade(s, b.id);
  }
}

export const objectiveIds = OBJECTIVES.map((o) => o.id);
