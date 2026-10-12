export type BuildingType = 'hq' | 'pumpjack' | 'tank' | 'terminal';
export type BuildableType = Exclude<BuildingType, 'hq'>;

/**
 * Состояние здания после последнего тика:
 * ok — работает; off — законсервировано игроком; depleted — месторождение исчерпано;
 * full — добыча ограничена заполненным хранилищем; waiting_price — терминал ждёт нужной цены;
 * no_oil — терминалу нечего продавать.
 */
export type BuildingStatus = 'ok' | 'off' | 'depleted' | 'full' | 'waiting_price' | 'no_oil';

export interface Building {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  /** Уровень, начиная с 1. */
  level: number;
  enabled: boolean;
  /** Сколько денег вложено в здание (строительство + улучшения) — основа для компенсации при сносе. */
  invested: number;
  status: BuildingStatus;
}

export interface WorldMap {
  size: number;
  /** Оставшиеся запасы нефти в каждой клетке, баррели. Индекс: y * size + x. */
  reserve: number[];
  /** Начальные запасы клетки (0 — нет месторождения). */
  initial: number[];
  /** Декоративные объекты (кусты, камни): 0 — нет. */
  decor: number[];
  /** Принадлежит ли игроку участок. Индекс: py * parcelsPerSide + px. */
  owned: boolean[];
}

/** Денежные и товарные потоки за одну секунду игрового времени. */
export interface StatBucket {
  produced: number;
  sold: number;
  revenue: number;
  expenses: number;
}

export interface Totals {
  produced: number;
  sold: number;
  /** Выручка от продажи нефти. */
  revenue: number;
  /** Операционные расходы (содержание зданий). */
  expenses: number;
  /** Капитальные вложения: строительство, улучшения, покупка земли. */
  capex: number;
  /** Компенсации при сносе зданий. */
  refunds: number;
  /** Награды за цели. */
  rewards: number;
}

export interface GameState {
  version: number;
  seed: number;
  /** Состояние ГСЧ симуляции. */
  rng: number;
  /** Игровое время, секунды. */
  time: number;
  cash: number;
  /** Нефть на складе, баррели. */
  oil: number;
  map: WorldMap;
  buildings: Building[];
  nextId: number;
  market: {
    price: number;
    /** История цены (одна точка раз в MARKET.historyStep секунд). */
    history: number[];
    historyAcc: number;
  };
  /** Минимальная цена, при которой терминалы продают нефть автоматически. */
  sellThreshold: number;
  unlocked: BuildableType[];
  /** Индекс текущей цели в списке OBJECTIVES. */
  objectiveIndex: number;
  totals: Totals;
  stats: {
    /** Завершённые секунды, не более STATS_WINDOW штук. */
    buckets: StatBucket[];
    current: StatBucket;
    currentTime: number;
  };
  /** Реальное время последнего сохранения (Date.now()), для офлайн-прогресса. */
  savedAt: number;
}

export type ActionResult = { ok: true } | { ok: false; reason: string };
