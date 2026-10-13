export type BuildingType = 'hq' | 'pumpjack' | 'tank' | 'terminal';
export type BuildableType = Exclude<BuildingType, 'hq'>;

/**
 * Состояние здания после последнего тика:
 * ok — работает; off — законсервировано игроком; depleted — месторождение исчерпано;
 * full — добыча ограничена заполненным хранилищем своей сети; waiting_price — терминал ждёт нужной цены;
 * no_oil — терминалу нечего продавать; no_route — нет трубопровода к хранилищу;
 * wrong_grade — места в достижимых хранилищах нет для этого сорта (они заняты нефтью другого сорта);
 * throttled — добыча ограничена пропускной способностью трубопровода.
 */
export type BuildingStatus = 'ok' | 'off' | 'depleted' | 'full' | 'waiting_price' | 'no_oil' | 'no_route' | 'throttled' | 'wrong_grade';

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
  /** Нефть в этом хранилище (только у конторы и резервуаров), баррели. */
  stored?: number;
  /** Сорт нефти в хранилище (0 — лёгкая, 1 — тяжёлая); имеет смысл, пока stored > 0. Хранилище не смешивает сорта. */
  grade?: Grade;
}

/** Сорт нефти: 0 — лёгкая, 1 — тяжёлая. */
export type Grade = 0 | 1;

/** Тип трубопровода на клетке: 0 — нет, 1 — промысловый, 2 — магистральный. */
export type PipeKind = 0 | 1 | 2;

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
  /** Трубопровод на клетке (PipeKind). Индекс как у reserve. */
  pipes: number[];
  /** Сорт нефти месторождения в клетке (Grade); одинаков для всех клеток одного месторождения. */
  grade: number[];
  /** Уровень разведки участка (0–2, 3 — известно точно). Индекс как у owned. */
  survey: number[];
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
  /** Вся нефть во всех хранилищах, баррели. Производная величина: сумма Building.stored, пересчитывается после каждого изменения. */
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
