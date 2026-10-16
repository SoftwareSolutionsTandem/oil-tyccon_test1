import { capital, countOf, lastMinute, stageReward, stageTarget } from './economy';
import { TECH_IDS } from './config';
import { historyPoints } from './history';
import type { BuildableType, Feature, GameState } from './types';
import { isConnected } from './network';
import { ownedParcelCount, ownedParcelsInRegion, surveyedParcelsInRegion } from './world';

/** Пункт цели-списка: своё условие «текущее / нужно». */
export interface ObjectiveItem {
  label: string;
  current: number;
  target: number;
  /** Пункт в деньгах (формат интерфейса). */
  money?: boolean;
}

export interface Objective {
  id: string;
  title: string;
  description: string;
  reward: number;
  unlocks?: BuildableType[];
  /** Открываемые возможности компании (не здания). */
  features?: Feature[];
  progress: (s: GameState) => { current: number; target: number };
  /** Прогресс — в деньгах (формат интерфейса). */
  money?: boolean;
  /**
   * Цель-список (новый тип условия M06): несколько условий сразу; прогресс — сумма долей пунктов.
   * Интерфейс показывает пункты с галочками.
   */
  items?: (s: GameState) => ObjectiveItem[];
  /** Номер ступени — для бесконечной части после цепочки (её цели не лежат в OBJECTIVES). */
  stage?: number;
}

/** Цель-список: прогресс — сумма долей пунктов (каждый не больше 1); цель выполнена, когда выполнены все пункты. */
function checklist(items: (s: GameState) => ObjectiveItem[]): Pick<Objective, 'items' | 'progress'> {
  return {
    items,
    progress: (s) => {
      const list = items(s);
      return { current: list.reduce((a, i) => a + Math.min(1, Math.max(0, i.current / i.target)), 0), target: list.length };
    },
  };
}

/** Деньги для текста целей ядра: $1 500 000 (без локали браузера — одинаково везде). */
export function usd(v: number): string {
  return '$' + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

const platformsAtLevel = (s: GameState, level: number) => s.buildings.filter((b) => b.type === 'platform' && b.level >= level).length;
const refineriesAtLevel = (s: GameState, level: number) => s.buildings.filter((b) => b.type === 'refinery' && b.level >= level).length;
const techLevelsTotal = (s: GameState) => Object.values(s.research.levels).reduce((a: number, v) => a + (v ?? 0), 0);
/** Кредит взят и закрыт полностью (досрочно или в срок). */
const loanRepaid = (s: GameState) => s.totals.borrowed > 0 && !s.loan;
/** Средняя прибыль за последние n минут статистики, $/мин; если минут меньше n — 0 (нужна полная история окна). */
export function averageProfit(s: GameState, n: number): number {
  const pts = historyPoints(s.history, n);
  return pts.length < n ? 0 : pts.reduce((a, p) => a + p.profit, 0) / n;
}

/** Окно и порог средней прибыли цели «Стабильный доход»: мин, $/мин (Временно). */
export const STABLE_WINDOW = 30;
const STABLE_PROFIT = 75_000;

/**
 * Цепочка целей ведёт игрока по игре и постепенно открывает механики:
 * сначала добыча и ручная продажа, затем хранение, автоматизация, земля и модернизация.
 */
export const OBJECTIVES: Objective[] = [
  {
    id: 'first_pump',
    title: 'Первая скважина',
    description: 'Постройте станок-качалку на тёмном пятне месторождения.',
    reward: 150,
    progress: (s) => ({ current: countOf(s, 'pumpjack'), target: 1 }),
  },
  {
    id: 'connect',
    title: 'Нефть в трубу',
    description: 'Подключите качалку к конторе трубопроводом: инструмент «Трубопровод» (4) или кнопка «Подключить» у качалки.',
    reward: 150,
    progress: (s) => ({ current: s.buildings.some((b) => b.type === 'pumpjack' && isConnected(s, b)) ? 1 : 0, target: 1 }),
  },
  {
    id: 'first_sales',
    title: 'Первые продажи',
    description: 'Продайте 100 баррелей нефти (кнопка «Продать» или клавиша S).',
    reward: 300,
    unlocks: ['tank'],
    progress: (s) => ({ current: s.totals.sold, target: 100 }),
  },
  {
    id: 'storage',
    title: 'Запасы',
    description: 'Постройте резервуар, чтобы качалки не простаивали.',
    reward: 200,
    progress: (s) => ({ current: countOf(s, 'tank'), target: 1 }),
  },
  {
    id: 'revenue_8k',
    title: 'Малый бизнес',
    description: 'Получите $8 000 выручки.',
    reward: 500,
    unlocks: ['terminal'],
    progress: (s) => ({ current: s.totals.revenue, target: 8000 }),
  },
  {
    id: 'terminal',
    title: 'Автоматизация продаж',
    description: 'Постройте наливной терминал — он продаёт нефть сам и по полной цене.',
    reward: 800,
    progress: (s) => ({ current: countOf(s, 'terminal'), target: 1 }),
  },
  {
    id: 'land',
    title: 'Новые земли',
    description: 'Купите соседний участок земли. Щёлкните по затемнённой территории.',
    reward: 1000,
    progress: (s) => ({ current: ownedParcelCount(s), target: 2 }),
  },
  {
    id: 'upgrade',
    title: 'Модернизация',
    description: 'Улучшите любое здание до 2-го уровня.',
    reward: 800,
    progress: (s) => ({ current: Math.max(...s.buildings.map((b) => (b.type === 'hq' ? 0 : b.level))), target: 2 }),
  },
  {
    id: 'pumps_10',
    title: 'Нефтепромысел',
    description: 'Доведите число станков-качалок до 10.',
    reward: 3000,
    progress: (s) => ({ current: countOf(s, 'pumpjack'), target: 10 }),
  },
  {
    id: 'profit_6k',
    title: 'Стабильная прибыль',
    description: 'Выйдите на операционную прибыль $6 000 в минуту.',
    reward: 5000,
    unlocks: ['refinery'],
    progress: (s) => {
      const m = lastMinute(s);
      return { current: m.revenue - m.expenses, target: 6000 };
    },
  },
  {
    id: 'credit',
    title: 'Кредит доверия',
    description: 'Выйдите на добычу 400 баррелей в минуту. Банк откроет кредитную линию: деньги сейчас, аннуитет из будущей прибыли.',
    reward: 2000,
    features: ['loans'],
    progress: (s) => ({ current: lastMinute(s).produced, target: 400 }),
  },
  {
    id: 'engineering',
    title: 'Инженерный центр',
    description: 'Выйдите на добычу 600 баррелей в минуту. Откроются исследования: технологии усиливают весь промысел сразу.',
    reward: 3000,
    features: ['research'],
    progress: (s) => ({ current: lastMinute(s).produced, target: 600 }),
  },
  {
    id: 'refining',
    title: 'Переработка',
    description: 'Постройте НПЗ (6) и продайте 200 баррелей нефтепродуктов. Сравнивайте в панели НПЗ: продать нефть или переработать.',
    reward: 5000,
    progress: (s) => ({ current: s.totals.productsSold[0] + s.totals.productsSold[1] + s.totals.productsSold[2], target: 200 }),
  },
  {
    id: 'staff',
    title: 'Штат специалистов',
    description: 'Исследуйте 3 уровня технологий. Откроется персонал: диспетчер сбыта и главный механик работают и без вас.',
    reward: 5000,
    features: ['managers'],
    progress: (s) => ({ current: Object.values(s.research.levels).reduce((a: number, v) => a + (v ?? 0), 0), target: 3 }),
  },
  {
    id: 'cash_500k',
    title: 'Нефтяная компания',
    description: 'Нарастите капитал до $500 000: касса минус долг по кредиту.',
    reward: 0,
    progress: (s) => ({ current: capital(s), target: 500_000 }),
  },
  {
    id: 'desert',
    title: 'Выход в пустыню',
    description: 'Закажите геологическую съёмку любого участка пустыни на востоке. Откроется покупка земли в пустыне: крупные месторождения, почти вся нефть тяжёлая, земля дешевле, но качалки там дороже в содержании.',
    reward: 10_000,
    features: ['desert'],
    progress: (s) => ({ current: surveyedParcelsInRegion(s, 1), target: 1 }),
  },
  {
    id: 'shelf',
    title: 'Выход на шельф',
    description: 'Закажите геологическую съёмку любого участка шельфа на юге. Откроются участки шельфа и морская платформа (7): лёгкая нефть, большая зона дренирования, трубы по морю втрое дороже.',
    reward: 10_000,
    unlocks: ['platform'],
    features: ['shelf'],
    progress: (s) => ({ current: surveyedParcelsInRegion(s, 2), target: 1 }),
  },
  // ——— M06-GOALS: продолжение цепочки (числа и награды — «Временно», награда ≈ 5–10 мин прибыли бота в момент цели) ———
  {
    id: 'offshore',
    title: 'Морской промысел',
    description: 'Поставьте морскую платформу (7) и улучшите её до 3-го уровня: одна платформа заменяет несколько качалок.',
    reward: 400_000,
    progress: (s) => ({ current: platformsAtLevel(s, 3), target: 1 }),
  },
  {
    id: 'refinery_pair',
    title: 'Второй НПЗ',
    description: 'Доведите до 3-го уровня два НПЗ: переработка забирает больше нефти, а цены продуктов не зависят от цены сырья.',
    reward: 400_000,
    progress: (s) => ({ current: refineriesAtLevel(s, 3), target: 2 }),
  },
  {
    id: 'fleet_7',
    title: 'Морской флот',
    description: 'Доведите число морских платформ до 7.',
    reward: 450_000,
    progress: (s) => ({ current: countOf(s, 'platform'), target: 7 }),
  },
  {
    id: 'science_2',
    title: 'Инженерная школа',
    description: 'Исследуйте каждую из четырёх технологий хотя бы до 2-го уровня.',
    reward: 450_000,
    progress: (s) => ({ current: TECH_IDS.reduce((a, id) => a + Math.min(2, s.research.levels[id] ?? 0), 0), target: TECH_IDS.length * 2 }),
  },
  {
    id: 'three_regions',
    title: 'Три региона',
    description: 'Владейте шестью участками в пустыне и шестью на шельфе: в пустыне — крупные месторождения тяжёлой нефти, на шельфе — платформы.',
    reward: 500_000,
    ...checklist((s) => [
      { label: 'Участки пустыни', current: ownedParcelsInRegion(s, 1), target: 6 },
      { label: 'Участки шельфа', current: ownedParcelsInRegion(s, 2), target: 6 },
    ]),
  },
  {
    id: 'stable_income',
    title: 'Стабильный доход',
    description: `Средняя операционная прибыль за последние ${STABLE_WINDOW} минут (панель «Статистика») — не меньше $${STABLE_PROFIT / 1000} 000 в минуту.`,
    reward: 500_000,
    money: true,
    progress: (s) => ({ current: averageProfit(s, STABLE_WINDOW), target: STABLE_PROFIT }),
  },
  {
    id: 'autopilot',
    title: 'Компания на автопилоте',
    description: 'Наймите обоих специалистов и закройте кредит полностью — досрочно (панель «Компания») или в срок.',
    reward: 550_000,
    ...checklist((s) => [
      { label: 'Диспетчер сбыта нанят', current: s.managers.dispatcher ? 1 : 0, target: 1 },
      { label: 'Главный механик нанят', current: s.managers.mechanic ? 1 : 0, target: 1 },
      { label: 'Кредит взят и погашен', current: loanRepaid(s) ? 1 : 0, target: 1 },
    ]),
  },
  {
    id: 'fleet_10',
    title: 'Морская держава',
    description: 'Доведите число морских платформ 3-го уровня до 10.',
    reward: 550_000,
    progress: (s) => ({ current: platformsAtLevel(s, 3), target: 10 }),
  },
  {
    id: 'science',
    title: 'Наукоёмкая компания',
    description: 'Исследуйте все технологии до 3-го уровня.',
    reward: 600_000,
    progress: (s) => ({ current: techLevelsTotal(s), target: TECH_IDS.length * 3 }),
  },
  {
    id: 'parcels_28',
    title: 'Земельный фонд',
    description: 'Владейте 28 участками земли в любых регионах.',
    reward: 600_000,
    progress: (s) => ({ current: ownedParcelCount(s), target: 28 }),
  },
  {
    id: 'capital_1m',
    title: 'Миллионер',
    description: 'Нарастите капитал до $1 000 000: касса минус долг по кредиту.',
    reward: 650_000,
    money: true,
    progress: (s) => ({ current: capital(s), target: 1_000_000 }),
  },
  {
    id: 'revenue_12m',
    title: 'Оборот $12 млн',
    description: 'Получите $12 000 000 выручки за всё время.',
    reward: 700_000,
    money: true,
    progress: (s) => ({ current: s.totals.revenue, target: 12_000_000 }),
  },
  {
    id: 'empire',
    title: 'Нефтяная империя',
    description: 'Капитал $1 500 000 (касса минус долг) и 250 000 баррелей добычи за всё время. Дальше — бесконечные ступени.',
    reward: 800_000,
    ...checklist((s) => [
      { label: 'Капитал', current: capital(s), target: 1_500_000, money: true },
      { label: 'Добыто, барр.', current: s.totals.produced, target: 250_000 },
    ]),
  },
];

/** Ступень N после цепочки: выручка за всё время — порог растёт геометрически (STAGES). Чистая функция от N. */
export function stageObjective(n: number): Objective {
  const target = stageTarget(n);
  return {
    id: `stage_${n}`,
    title: `Ступень ${n}`,
    description: `Доведите выручку за всё время до ${usd(target)}.`,
    reward: stageReward(n),
    money: true,
    stage: n,
    progress: (s) => ({ current: s.totals.revenue, target }),
  };
}

/** Текущая цель: из цепочки, а после неё — следующая ступень (цель есть всегда). */
export function currentObjective(s: GameState): Objective {
  return OBJECTIVES[s.objectiveIndex] ?? stageObjective(s.stage + 1);
}

/** Проверяет цели по порядку, выдаёт награды. Возвращает выполненные цели. */
export function checkObjectives(s: GameState): Objective[] {
  const done: Objective[] = [];
  for (;;) {
    const obj = currentObjective(s);
    const p = obj.progress(s);
    if (p.current < p.target) break;
    s.cash += obj.reward;
    s.totals.rewards += obj.reward;
    for (const t of obj.unlocks ?? []) if (!s.unlocked.includes(t)) s.unlocked.push(t);
    for (const f of obj.features ?? []) if (!s.features.includes(f)) s.features.push(f);
    if (obj.stage) s.stage++;
    else s.objectiveIndex++;
    done.push(obj);
  }
  return done;
}

// ——— Достижения (M06-GOALS): отдельный список вне цепочки, без денег, ничего не открывают и не блокируют ———

export interface Achievement {
  id: string;
  /** Значок (символ) для панели и уведомления. */
  icon: string;
  title: string;
  description: string;
  check: (s: GameState) => boolean;
}

const productsSold = (s: GameState) => s.totals.productsSold[0] + s.totals.productsSold[1] + s.totals.productsSold[2];

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_barrel', icon: '🛢', title: 'Первый баррель', description: 'Продать первую нефть.', check: (s) => s.totals.sold >= 1 },
  { id: 'pumps_25', icon: '⚙', title: 'Лес качалок', description: '25 станков-качалок.', check: (s) => countOf(s, 'pumpjack') >= 25 },
  { id: 'pumps_40', icon: '🏭', title: 'Промысел-гигант', description: '40 станков-качалок.', check: (s) => countOf(s, 'pumpjack') >= 40 },
  { id: 'produced_100k', icon: '💧', title: 'Сто тысяч баррелей', description: 'Добыть 100 000 баррелей.', check: (s) => s.totals.produced >= 100_000 },
  { id: 'produced_1m', icon: '🌊', title: 'Миллион баррелей', description: 'Добыть 1 000 000 баррелей.', check: (s) => s.totals.produced >= 1_000_000 },
  { id: 'revenue_1m', icon: '💵', title: 'Первый миллион', description: 'Выручка $1 млн за всё время.', check: (s) => s.totals.revenue >= 1e6 },
  { id: 'revenue_10m', icon: '💰', title: 'Десять миллионов', description: 'Выручка $10 млн за всё время.', check: (s) => s.totals.revenue >= 1e7 },
  { id: 'revenue_100m', icon: '👑', title: 'Сто миллионов', description: 'Выручка $100 млн за всё время.', check: (s) => s.totals.revenue >= 1e8 },
  { id: 'profit_100k', icon: '📈', title: 'Прибыльная минута', description: 'Операционная прибыль $100 000 за минуту.', check: (s) => lastMinute(s).revenue - lastMinute(s).expenses >= 100_000 },
  { id: 'land_10', icon: '🗺', title: 'Землевладелец', description: '10 участков земли.', check: (s) => ownedParcelCount(s) >= 10 },
  { id: 'land_30', icon: '🧭', title: 'Хозяин недр', description: '30 участков земли.', check: (s) => ownedParcelCount(s) >= 30 },
  { id: 'seismic', icon: '📡', title: 'Сейсморазведчик', description: 'Сейсморазведка чужого участка.', check: (s) => s.map.survey.some((v) => v === 2) },
  { id: 'desert', icon: '🏜', title: 'Первые шаги в пустыне', description: 'Купить участок пустыни.', check: (s) => ownedParcelsInRegion(s, 1) >= 1 },
  { id: 'shelf', icon: '🌅', title: 'Выход в море', description: 'Купить участок шельфа.', check: (s) => ownedParcelsInRegion(s, 2) >= 1 },
  { id: 'heavy_oil', icon: '⚫', title: 'Тяжёлый случай', description: 'Хранить тяжёлую нефть.', check: (s) => s.buildings.some((b) => b.grade === 1 && (b.stored ?? 0) > 1) },
  { id: 'platform', icon: '🛳', title: 'Первая платформа', description: 'Построить морскую платформу.', check: (s) => countOf(s, 'platform') >= 1 },
  { id: 'platforms_10', icon: '⚓', title: 'Флотилия', description: '10 морских платформ.', check: (s) => countOf(s, 'platform') >= 10 },
  { id: 'refinery', icon: '🏗', title: 'Свой бензин', description: 'Построить НПЗ.', check: (s) => countOf(s, 'refinery') >= 1 },
  { id: 'products_all', icon: '⛽', title: 'Полная линейка', description: 'Продать бензин, дизель и мазут.', check: (s) => s.totals.productsSold.every((v) => v >= 1) },
  { id: 'products_10k', icon: '🚚', title: 'Нефтехимия', description: 'Продать 10 000 баррелей нефтепродуктов.', check: (s) => productsSold(s) >= 10_000 },
  { id: 'first_tech', icon: '🔬', title: 'Первое открытие', description: 'Исследовать первую технологию.', check: (s) => techLevelsTotal(s) >= 1 },
  { id: 'all_tech', icon: '🎓', title: 'Академик', description: 'Все технологии на 3-м уровне.', check: (s) => techLevelsTotal(s) >= TECH_IDS.length * 3 },
  { id: 'first_loan', icon: '🏦', title: 'Кредит доверия', description: 'Взять кредит.', check: (s) => s.totals.borrowed > 0 },
  { id: 'loan_repaid', icon: '✅', title: 'Чистая история', description: 'Погасить кредит полностью.', check: loanRepaid },
  { id: 'staff', icon: '👷', title: 'Полный штат', description: 'Нанять диспетчера и механика.', check: (s) => s.managers.dispatcher && s.managers.mechanic },
  { id: 'chain', icon: '🏆', title: 'Вся цепочка', description: 'Выполнить все цели цепочки.', check: (s) => s.objectiveIndex >= OBJECTIVES.length },
  { id: 'stage_5', icon: '🥉', title: 'Пятая ступень', description: 'Пройти 5 ступеней.', check: (s) => s.stage >= 5 },
  { id: 'stage_10', icon: '🥇', title: 'Десятая ступень', description: 'Пройти 10 ступеней.', check: (s) => s.stage >= 10 },
  { id: 'veteran', icon: '⏳', title: 'Ветеран промысла', description: '4 часа игрового времени.', check: (s) => s.time >= 4 * 3600 },
];

/** Звания компании по числу достижений (только надпись, без бонусов). */
export const RANKS: ReadonlyArray<readonly [number, string]> = [
  [0, 'Старатель'],
  [3, 'Буровик'],
  [8, 'Нефтяник'],
  [14, 'Магнат'],
  [20, 'Нефтяной барон'],
  [ACHIEVEMENTS.length, 'Король нефти'],
];

export function companyRank(s: GameState): string {
  let title = RANKS[0][1];
  for (const [n, t] of RANKS) if (s.achievements.length >= n) title = t;
  return title;
}

/** Выдаёт новые достижения (каждое — один раз). Возвращает полученные сейчас. */
export function checkAchievements(s: GameState): Achievement[] {
  const got: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (s.achievements.includes(a.id) || !a.check(s)) continue;
    s.achievements.push(a.id);
    got.push(a);
  }
  return got;
}
