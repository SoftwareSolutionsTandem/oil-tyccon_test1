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
  techEffect,
  techLevel,
  techNextLevel,
  referencePrice,
  totalUpkeep,
  pumpGrade,
  TECH_IDS,
  TECHS,
  type BuildableType,
  type TechId,
  type GameState,
  type TickEvents,
} from '../src/core';

/** Настройки бота. research: false — исследования не ведутся (базовые прогоны для сравнения с этапом 0). */
export interface BotOptions {
  research?: boolean;
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
    if (i % 10 === 0) decide(s, opts.research ?? true);
  }
  return { reachedAt, minCash };
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
  if (refineries.length === 0) {
    const cost = buildCost(s, 'refinery');
    if (s.cash < cost * 1.5 || !marginOk) return;
    const cap1 = BUILDINGS.refinery.levels[0].value;
    // Нефти в целом должно хватать: НПЗ делит её с терминалами пропорционально запросам, поэтому «остаток после
    // терминалов» не нужен — его фактическую долю проверяет пробный расчёт ниже (не меньше 75% мощности).
    if (lastMinute(s).produced / 60 < cap1 * 1.5) return;
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
    if (!best || best.flow < cap1 * 0.75) return;
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
    if (c !== null && busy >= 2 && marginOk && s.cash >= c * 1.5) {
      upgrade(s, r.id);
      refineryBusy.set(s, 0);
    }
  }
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
  const xy = (t: number) => [t % s.map.size, Math.floor(t / s.map.size)] as [number, number];
  // Вывоз упирается в промысловую трубу (терминал или НПЗ «ограничен трубой») — она меняется на магистраль,
  // как кнопкой «Усилить маршрут»: иначе нефть копится в дальних коллекторах, а качалки стоят.
  for (const o of s.buildings) {
    if ((o.type !== 'terminal' && o.type !== 'refinery') || o.status !== 'throttled') continue;
    const c = flow.clients.get(o.id);
    const bt = c?.bottleneck ?? -1;
    if (bt < 0 || s.map.pipes[bt] !== 1) continue;
    const path = [...new Set([bt, ...c!.path])].filter((t) => s.map.pipes[t] === 1).map(xy);
    if (s.cash > path.length * 60) layPipes(s, path, 2);
    return;
  }
  for (const b of s.buildings) {
    if (b.type !== 'pumpjack' || (b.status !== 'throttled' && b.status !== 'full')) continue;
    const st = net.reach.get(b.id)?.[0]?.storage;
    if (b.status === 'full') {
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
      const c = flow.clients.get(b.id);
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
function manageResearch(s: GameState): void {
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
  const grade = deposit ? pumpGrade(s, { x: deposit.x, y: deposit.y } as GameState['buildings'][number]) : 0;
  const pumpGain = top.value * (1 + TECHS.yield.step * techLevel(s, 'yield')) * referencePrice(grade) - top.upkeep * (1 - TECHS.energy.step * techLevel(s, 'energy'));
  const pumpCost = buildCost(s, 'pumpjack') + BUILDINGS.pumpjack.levels[1].cost + top.cost + (deposit ? 0 : parcelPrice(s));
  const pumpPayback = pumpCost / pumpGain;
  if (!best || best.payback >= pumpPayback) {
    researchGoal.set(s, null);
    return;
  }
  if (s.cash >= best.cost + totalUpkeep(s) * 60 && startResearch(s, best.id).ok) researchGoal.set(s, null);
  else researchGoal.set(s, best.id);
}

function decide(s: GameState, research = true): void {
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
  if (research && Math.floor(s.time) % 10 === 0) manageResearch(s);
  // Копим на технологию — новые качалки, разведку и землю откладываем (улучшения и логистика идут дальше).
  const saving = research && !!researchGoal.get(s);

  const deposit = saving ? undefined : freeTiles(s, true)[0];
  if (saving) {
    // ничего не строим и не покупаем
  } else if (deposit) {
    if (s.cash >= buildCost(s, 'pumpjack')) buildConnected(s, 'pumpjack', deposit.x, deposit.y);
  } else {
    // Земля: сначала геологическая съёмка всех соседних участков (по одному за ход), затем сейсморазведка
    // лучшего, если денег с запасом, и покупка по оценке. Тяжёлая нефть дешевле — её запасы бот ценит ниже.
    const cands: Array<{ px: number; py: number }> = [];
    for (let py = 0; py < PARCELS_PER_SIDE; py++)
      for (let px = 0; px < PARCELS_PER_SIDE; px++) if (canBuyParcel({ ...s, cash: Infinity }, px, py).ok) cands.push({ px, py });
    const unknown = cands.find((c) => surveyLevel(s, c.px, c.py) === 0);
    if (unknown) {
      if (s.cash >= surveyCost(s, 1)) survey(s, unknown.px, unknown.py, 1);
      return;
    }
    const mid = (r: { low: number; high: number } | null) => (r ? (r.low + r.high) / 2 : 0);
    const value = (c: { px: number; py: number }) => {
      const e = parcelEstimate(s, c.px, c.py);
      return e.light && e.heavy ? mid(e.light) + mid(e.heavy) * 0.7 : mid(e.reserves) * 0.85;
    };
    let best: { px: number; py: number; reserves: number } | null = null;
    for (const c of cands) {
      const reserves = value(c);
      if (!best || reserves > best.reserves) best = { ...c, reserves };
    }
    if (!best) return;
    if (surveyLevel(s, best.px, best.py) < 2 && s.cash >= parcelPrice(s) * 1.25 + surveyCost(s, 2)) {
      survey(s, best.px, best.py, 2);
      return;
    }
    buyParcel(s, best.px, best.py);
  }

  for (const b of s.buildings) {
    const cost = b.type === 'pumpjack' ? upgradeCost(b) : null;
    if (cost !== null && s.cash > cost * 2 && levelSpec(b).value > 0) upgrade(s, b.id);
  }
}

export const objectiveIds = OBJECTIVES.map((o) => o.id);
