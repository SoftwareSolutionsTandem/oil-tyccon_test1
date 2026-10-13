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
    description: 'Добывает нефть из своей клетки и соседних клеток месторождения. Качалки ставят рядами бок о бок; между рядами — проход в клетку.',
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
  refinery: {
    name: 'НПЗ',
    description: 'Нефтеперерабатывающий завод: забирает нефть из сети по трубам и сразу перерабатывает её в бензин, дизель и мазут, которые продаёт сам.',
    valueLabel: 'Переработка',
    valueUnit: 'барр./с',
    levels: [
      { cost: 15000, upkeep: 6, value: 2 },
      { cost: 20000, upkeep: 10, value: 4.5 },
      { cost: 45000, upkeep: 16, value: 9 },
    ],
    costGrowth: 1.5,
    hotkey: '6',
  },
};

/**
 * НПЗ (веха 0.3, docs/REFINERY_PLAN.md). Нефть перерабатывается сразу, без бака сырья; продукты лежат во внутренних
 * складах (ёмкость — на каждый продукт) и отгружаются с завода с ограниченной мощностью (сумма по продуктам).
 * yields[сорт] — выход [бензин, дизель, мазут]; сумма по сорту ровно 1 (потерь в первой версии нет).
 */
export const REFINERY = {
  productCap: [200, 400, 800],
  ship: [4, 9, 18],
  yields: [
    [0.45, 0.35, 0.2],
    [0.2, 0.35, 0.45],
  ] as ReadonlyArray<readonly [number, number, number]>,
  loss: 0,
  /** Запас места на складе на погрешность вычислений, барр. */
  epsCap: 1e-6,
  /** Минимальный осмысленный объём за шаг, барр. */
  eps: 1e-9,
};

/**
 * Нефтепродукты: цена = база · (1 + alpha·(P/50 − 1)) · цикл(t). Цикл — синус с фазой от seed (без ГСЧ и без
 * состояния, как скидка тяжёлой нефти), ограничен [min, max].
 */
export const PRODUCTS = {
  names: ['Бензин', 'Дизель', 'Мазут'] as const,
  short: ['бенз.', 'диз.', 'маз.'] as const,
  base: [67.5, 65, 37.5],
  alpha: 0.5,
  amplitude: 0.15,
  periods: [800, 1100, 1300],
  min: 0.8,
  max: 1.2,
};

export const HQ_NAME = 'Контора';

/**
 * Сорта нефти. Лёгкая продаётся по рыночной цене. Тяжёлая — со скидкой, которая меняется по своему циклу
 * (иногда разница почти исчезает); зато месторождения тяжёлой нефти крупнее. Вязкую нефть хуже тянут
 * старые станки 1-го уровня с газовым двигателем — модернизация важнее.
 */
export const GRADES = [
  { name: 'Лёгкая', short: 'лёгк.', reserveFactor: 1, level1Rate: 1 },
  { name: 'Тяжёлая', short: 'тяж.', reserveFactor: 1.6, level1Rate: 0.8 },
] as const;

/** Скидка на тяжёлую нефть (доля цены лёгкой): средняя, медленный и быстрый циклы, границы. */
export const HEAVY_SPREAD = {
  mean: 0.2,
  slowAmplitude: 0.12,
  slowPeriod: 1500,
  fastAmplitude: 0.05,
  fastPeriod: 370,
  min: 0.06,
  max: 0.42,
};

/** Доля тяжёлых месторождений по удалённости участка от стартового (старт — всегда лёгкая). */
export const HEAVY_CHANCE = [0, 0.3, 0.5, 0.55, 0.6];

export interface PipeSpec {
  name: string;
  /** Стоимость клетки, $. */
  cost: number;
  /** Пропускная способность, барр./с. */
  capacity: number;
}

/**
 * Трубопроводы. Цена за клетку мала по сравнению со зданиями: длинное подключение — это решение о маршруте,
 * а не денежный штраф. Пропускная способность — ограничение, которое со временем требует магистрали.
 */
export const PIPES: Record<1 | 2, PipeSpec> = {
  1: { name: 'Промысловый трубопровод', cost: 10, capacity: 2 },
  2: { name: 'Магистральный трубопровод', cost: 30, capacity: 16 },
};
/** Доля стоимости трубы, возвращаемая при демонтаже. */
export const PIPE_REFUND = 0.5;

export const PARCEL_BASE_PRICE = 3000;
export const PARCEL_PRICE_GROWTH = 1.7;

/**
 * Разведка чужих участков. Уровни: 0 — ничего не известно, 1 — геологическая съёмка, 2 — сейсморазведка;
 * 3 — точно известно (свой участок или старое сохранение). Цена — доля текущей цены участка.
 * accuracy — полуширина показываемого диапазона запасов (доля); истинное значение всегда внутри диапазона.
 */
export const SURVEY_LEVELS = [
  { name: 'Геологическая съёмка', costShare: 0.1, accuracy: 0.4, grade: false },
  { name: 'Сейсморазведка', costShare: 0.25, accuracy: 0.1, grade: true },
] as const;
/** Уровень «известно точно». */
export const SURVEY_EXACT = 3;
