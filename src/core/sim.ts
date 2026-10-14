import { MARKET, OFFLINE_CAP, RESEARCH_EPS } from './config';
import { advanceStats, buildingUpkeep, loanDebtAt, loanPayment, recordStat } from './economy';
import { managersSalary, managersStep } from './managers';
import { stepLogistics } from './network';
import { checkObjectives, type Objective } from './objectives';
import { Rng } from './rng';
import type { GameState, TechId, Totals } from './types';

export interface TickEvents {
  autoSold: number;
  /** Вся автоматическая выручка шага: терминалы и нефтепродукты. */
  autoRevenue: number;
  completed: Objective[];
  /** НПЗ за шаг: переработано (по сортам), ценность переработанной нефти по ценам сортов, выручка от продуктов. */
  refined: number;
  refinedByGrade: [number, number];
  refinedValue: number;
  productRevenue: number;
  /** Завершённые на этом шаге исследования: технология и достигнутый уровень. */
  researched: Array<{ id: TechId; level: number }>;
}

/** Один шаг симуляции. Чистая логика без DOM — её можно гонять в тестах и офлайн. */
export function tick(s: GameState, dt: number): TickEvents {
  s.time += dt;
  updateMarket(s, dt);
  // Исследование завершается в начале шага: эффект действует уже в логистике и содержании этого шага.
  const researched = advanceResearch(s, dt);

  // 1–2. Логистика: добыча через сеть трубопроводов в хранилища своей сети и продажа через терминалы этой сети (по цене сорта).
  const flow = stepLogistics(s, dt);
  s.totals.produced += flow.produced;
  recordStat(s, 'produced', flow.produced);
  const autoSold = flow.sold;
  const autoRevenue = flow.revenue;
  s.cash += autoRevenue;
  s.totals.sold += autoSold;
  s.totals.revenue += autoRevenue;
  recordStat(s, 'sold', autoSold);
  recordStat(s, 'revenue', autoRevenue);
  // НПЗ: переработка и нефтепродукты (выручка от них уже в autoRevenue).
  const t = s.totals;
  t.refined += flow.refined;
  t.productRevenue += flow.productRevenue;
  for (let i = 0; i < 3; i++) {
    t.productsMade[i] += flow.productsMade[i];
    t.productsSold[i] += flow.productsSold[i];
  }
  recordStat(s, 'refined', flow.refined);
  recordStat(s, 'productRevenue', flow.productRevenue);

  // 3. Содержание зданий.
  let upkeep = 0;
  for (const b of s.buildings) upkeep += buildingUpkeep(b, s);
  // Зарплаты менеджеров — операционный расход (входят в expenses), отдельно — для разбивки в финансах.
  const salaries = managersSalary(s) * dt;
  const expenses = upkeep * dt + salaries;
  s.cash -= expenses;
  s.totals.expenses += expenses;
  s.totals.salaries += salaries;
  recordStat(s, 'expenses', expenses);

  // 4. Кредит: платёж аннуитета за шаг (основной долг и проценты — по замкнутой формуле, без накопления ошибки).
  payLoan(s, dt);

  // 5. Менеджеры: решения на границе периода (после доходов и расходов шага).
  managersStep(s, dt);

  advanceStats(s, dt);
  const completed = checkObjectives(s);
  return {
    autoSold,
    autoRevenue,
    completed,
    refined: flow.refined,
    refinedByGrade: flow.refinedByGrade,
    refinedValue: flow.refinedValue,
    productRevenue: flow.productRevenue,
    researched,
  };
}

/**
 * Ход исследования: остаток уменьшается на dt; на шаге, где он стал не больше RESEARCH_EPS, уровень растёт на 1.
 * Допуск нужен, чтобы сумма шагов 0,1 с завершала исследование в ту же секунду, что и шаги по 1 с (офлайн).
 */
function advanceResearch(s: GameState, dt: number): Array<{ id: TechId; level: number }> {
  const a = s.research.active;
  if (!a) return [];
  a.remaining -= dt;
  if (a.remaining > RESEARCH_EPS) return [];
  const level = (s.research.levels[a.id] ?? 0) + 1;
  s.research.levels[a.id] = level;
  s.research.active = null;
  return [{ id: a.id, level }];
}

/**
 * Платёж по кредиту за шаг: a·Δτ, где основной долг — разность долга в начале и в конце шага, проценты — остаток.
 * На последнем шаге срока долг становится ровно нулём и кредит закрывается. Платёж списывается и при минусе кассы.
 */
function payLoan(s: GameState, dt: number): void {
  const loan = s.loan;
  if (!loan) return;
  const t0 = Math.min(loan.term, Math.max(0, s.time - dt - loan.start));
  const t1 = Math.min(loan.term, Math.max(0, s.time - loan.start));
  if (t1 <= t0) return;
  const d0 = loanDebtAt(loan, t0);
  const d1 = t1 >= loan.term ? 0 : loanDebtAt(loan, t1);
  const pay = loanPayment(loan) * (t1 - t0);
  const principal = d0 - d1;
  s.cash -= pay;
  s.totals.repaid += principal;
  s.totals.interest += pay - principal;
  if (t1 >= loan.term) s.loan = null;
}

function updateMarket(s: GameState, dt: number): void {
  const rng = new Rng(s.rng);
  const cycleMean = MARKET.mean + MARKET.cycleAmplitude * Math.sin((2 * Math.PI * s.time) / MARKET.cyclePeriod);
  let p = s.market.price;
  p += MARKET.reversion * (cycleMean - p) * dt + MARKET.volatility * Math.sqrt(dt) * rng.gaussian();
  s.market.price = Math.min(MARKET.max, Math.max(MARKET.min, p));
  s.rng = rng.state;

  s.market.historyAcc += dt;
  while (s.market.historyAcc >= MARKET.historyStep) {
    s.market.historyAcc -= MARKET.historyStep;
    s.market.history.push(s.market.price);
    if (s.market.history.length > MARKET.historyLength) s.market.history.shift();
  }
}

export interface OfflineReport {
  seconds: number;
  produced: number;
  sold: number;
  revenue: number;
  expenses: number;
  /** Переработано на НПЗ, барр., и выручка от нефтепродуктов (входит в revenue). */
  refined: number;
  productRevenue: number;
  completed: Objective[];
  /** Исследования, завершённые за время отсутствия. */
  researched: Array<{ id: TechId; level: number }>;
}

/** Догоняет время, прошедшее без игрока (с ограничением OFFLINE_CAP), крупными шагами по 1 с. */
export function simulateOffline(s: GameState, seconds: number): OfflineReport {
  const total = Math.min(Math.max(0, Math.floor(seconds)), OFFLINE_CAP);
  const before: Totals = { ...s.totals };
  const completed: Objective[] = [];
  const researched: OfflineReport['researched'] = [];
  for (let i = 0; i < total; i++) {
    const ev = tick(s, 1);
    completed.push(...ev.completed);
    researched.push(...ev.researched);
  }
  return {
    seconds: total,
    produced: s.totals.produced - before.produced,
    sold: s.totals.sold - before.sold,
    revenue: s.totals.revenue - before.revenue,
    expenses: s.totals.expenses - before.expenses,
    refined: s.totals.refined - before.refined,
    productRevenue: s.totals.productRevenue - before.productRevenue,
    completed,
    researched,
  };
}
