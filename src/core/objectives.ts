import { capital, countOf, lastMinute } from './economy';
import type { BuildableType, Feature, GameState } from './types';
import { isConnected } from './network';
import { ownedParcelCount, surveyedParcelsInRegion } from './world';

export interface Objective {
  id: string;
  title: string;
  description: string;
  reward: number;
  unlocks?: BuildableType[];
  /** Открываемые возможности компании (не здания). */
  features?: Feature[];
  progress: (s: GameState) => { current: number; target: number };
}

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
];

export function currentObjective(s: GameState): Objective | undefined {
  return OBJECTIVES[s.objectiveIndex];
}

/** Проверяет цели по порядку, выдаёт награды. Возвращает выполненные цели. */
export function checkObjectives(s: GameState): Objective[] {
  const done: Objective[] = [];
  for (let obj = currentObjective(s); obj; obj = currentObjective(s)) {
    const p = obj.progress(s);
    if (p.current < p.target) break;
    s.cash += obj.reward;
    s.totals.rewards += obj.reward;
    for (const t of obj.unlocks ?? []) if (!s.unlocked.includes(t)) s.unlocked.push(t);
    for (const f of obj.features ?? []) if (!s.features.includes(f)) s.features.push(f);
    s.objectiveIndex++;
    done.push(obj);
  }
  return done;
}
