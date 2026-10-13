import { countOf, lastMinute } from './economy';
import type { BuildableType, GameState } from './types';
import { isConnected } from './network';
import { ownedParcelCount } from './world';

export interface Objective {
  id: string;
  title: string;
  description: string;
  reward: number;
  unlocks?: BuildableType[];
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
    id: 'refining',
    title: 'Переработка',
    description: 'Постройте НПЗ (6) и продайте 200 баррелей нефтепродуктов. Сравнивайте в панели НПЗ: продать нефть или переработать.',
    reward: 5000,
    progress: (s) => ({ current: s.totals.productsSold[0] + s.totals.productsSold[1] + s.totals.productsSold[2], target: 200 }),
  },
  {
    id: 'cash_500k',
    title: 'Нефтяная компания',
    description: 'Накопите $500 000.',
    reward: 0,
    progress: (s) => ({ current: s.cash, target: 500_000 }),
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
    s.objectiveIndex++;
    done.push(obj);
  }
  return done;
}
