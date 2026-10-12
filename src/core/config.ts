import type { BuildableType } from './types';

/** Шаг симуляции в секундах игрового времени. */
export const TICK = 0.1;

export const MAP_SIZE = 40;
export const PARCEL_SIZE = 8;
export const PARCELS_PER_SIDE = MAP_SIZE / PARCEL_SIZE;
export const START_PARCEL = { px: 2, py: 2 };
/** Клетка конторы внутри стартового участка. */
export const HQ_POS = { x: START_PARCEL.px * PARCEL_SIZE + 1, y: START_PARCEL.py * PARCEL_SIZE + 1 };

export const START_CASH = 1000;
/** Небольшой склад при конторе. */
export const HQ_STORAGE = 60;
/** Ручная продажа идёт через перекупщика — дешевле рыночной цены. */
export const MANUAL_SELL_FACTOR = 0.8;
/** Доля стоимости содержания, которую продолжает съедать законсервированное здание. */
export const MOTHBALL_UPKEEP = 0.25;
/** Доля вложений, возвращаемая при сносе. */
export const DEMOLISH_REFUND = 0.5;
/** Добыча падает по мере истощения: rate * (MIN + (1 - MIN) * остаток/начальные). */
export const DEPLETION_MIN_FACTOR = 0.4;

/** Максимум офлайн-прогресса, секунды. */
export const OFFLINE_CAP = 4 * 3600;
/** Окно статистики «за минуту», секунды. */
export const STATS_WINDOW = 60;

export const MARKET = {
  mean: 50,
  /** Медленный рыночный цикл: средняя цена колеблется вокруг mean. */
  cycleAmplitude: 12,
  cyclePeriod: 600,
  /** Скорость возврата к средней. */
  reversion: 0.03,
  /** Волатильность, $/√с. */
  volatility: 1.6,
  min: 22,
  max: 95,
  historyStep: 2,
  historyLength: 180,
};

export interface LevelSpec {
  /** Для уровня 1 — стоимость строительства, для остальных — стоимость улучшения до этого уровня. */
  cost: number;
  /** Содержание, $/с. */
  upkeep: number;
  /** Главный параметр: добыча (барр./с), ёмкость (барр.) или пропускная способность (барр./с). */
  value: number;
}

export interface BuildingSpec {
  name: string;
  description: string;
  valueLabel: string;
  valueUnit: string;
  levels: LevelSpec[];
  /** Каждое следующее здание этого типа дороже в costGrowth раз. */
  costGrowth: number;
  hotkey: string;
}

export const BUILDINGS: Record<BuildableType, BuildingSpec> = {
  pumpjack: {
    name: 'Станок-качалка',
    description: 'Добывает нефть из своей клетки и соседних клеток месторождения. Скважины не ставят вплотную: между ними нужна клетка.',
    valueLabel: 'Добыча',
    valueUnit: 'барр./с',
    levels: [
      { cost: 500, upkeep: 1.5, value: 0.2 },
      { cost: 1500, upkeep: 2.5, value: 0.36 },
      { cost: 4500, upkeep: 4, value: 0.65 },
    ],
    costGrowth: 1.2,
    hotkey: '1',
  },
  tank: {
    name: 'Резервуар',
    description: 'Увеличивает объём хранилища. Позволяет придерживать нефть до хорошей цены.',
    valueLabel: 'Ёмкость',
    valueUnit: 'барр.',
    levels: [
      { cost: 300, upkeep: 0.2, value: 150 },
      { cost: 600, upkeep: 0.35, value: 350 },
      { cost: 1500, upkeep: 0.6, value: 800 },
    ],
    costGrowth: 1.12,
    hotkey: '2',
  },
  terminal: {
    name: 'Наливной терминал',
    description: 'Автоматически продаёт нефть по полной рыночной цене, если она не ниже заданного порога.',
    valueLabel: 'Отгрузка',
    valueUnit: 'барр./с',
    levels: [
      { cost: 4000, upkeep: 3, value: 1 },
      { cost: 6000, upkeep: 4.5, value: 2.5 },
      { cost: 15000, upkeep: 7, value: 6 },
    ],
    costGrowth: 1.4,
    hotkey: '3',
  },
};

export const HQ_NAME = 'Контора';

export const PARCEL_BASE_PRICE = 3000;
export const PARCEL_PRICE_GROWTH = 1.7;
