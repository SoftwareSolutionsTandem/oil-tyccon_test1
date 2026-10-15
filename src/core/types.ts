export type BuildingType = 'hq' | 'pumpjack' | 'tank' | 'terminal' | 'refinery' | 'platform';
export type BuildableType = Exclude<BuildingType, 'hq'>;

/**
 * Состояние здания после последнего тика:
 * ok — работает; off — законсервировано игроком; depleted — месторождение исчерпано;
 * full — добыча ограничена заполненным хранилищем своей сети; waiting_price — терминал ждёт нужной цены;
 * no_oil — терминалу нечего продавать; no_route — нет трубопровода к хранилищу;
 * wrong_grade — места в достижимых хранилищах нет для этого сорта (они заняты нефтью другого сорта);
 * throttled — добыча ограничена пропускной способностью трубопровода.
 * НПЗ: no_feed — нет сырья подходящего сорта; waiting_margin — переработка сейчас невыгодна;
 * product_full — нет места на складе нефтепродукта.
 */
export type BuildingStatus =
  | 'ok'
  | 'off'
  | 'depleted'
  | 'full'
  | 'waiting_price'
  | 'no_oil'
  | 'no_route'
  | 'throttled'
  | 'wrong_grade'
  | 'no_feed'
  | 'waiting_margin'
  | 'product_full';

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
  /** НПЗ: запасы нефтепродуктов во внутренних складах [бензин, дизель, мазут], баррели. */
  products?: [number, number, number];
  /** НПЗ: какой сорт сырья принимать. */
  feed?: Feed;
  /** НПЗ: перерабатывать только сорта с положительной маржой. */
  marginOnly?: boolean;
}

/** Возможности компании, которые открываются целями (не здания): исследования, кредиты, менеджеры (веха 0.4). */
export type Feature = 'research' | 'loans' | 'managers' | 'desert' | 'shelf';

/** Технологии (веха 0.4, docs/M04_DESIGN.md §4): добыча, нефтеотдача, энергосбережение, типовой проект станка. */
export type TechId = 'yield' | 'eor' | 'energy' | 'standard';

/** Исследования: достигнутые уровни и текущее исследование (одно за раз, отмены нет). */
export interface ResearchState {
  levels: Partial<Record<TechId, number>>;
  /** remaining — сколько секунд игрового времени осталось до завершения. */
  active: { id: TechId; remaining: number } | null;
}

/** Менеджеры (веха 0.4): диспетчер сбыта ведёт пороги цен, главный механик улучшает качалки. */
export type ManagerRole = 'dispatcher' | 'mechanic';

export interface ManagersState {
  dispatcher: boolean;
  mechanic: boolean;
  /** Резерв кассы, ниже которого главный механик не тратит деньги, $. */
  reserve: number;
}

/** Кредит-аннуитет: долг считается формулой от времени с выдачи (не накапливает ошибку и одинаков в офлайне). */
export interface LoanState {
  principal: number;
  /** Игровое время выдачи, с. */
  start: number;
  /** Ставка за игровую минуту (доля). */
  rate: number;
  /** Срок, с. */
  term: number;
}

/** Фильтр сырья НПЗ. */
export type Feed = 'any' | 'light' | 'heavy';

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
  /** Регион клетки (индекс REGIONS): 0 — степь, 1 — пустыня, 2 — шельф. Индекс как у reserve. */
  region: number[];
}

/** Денежные и товарные потоки за одну секунду игрового времени. */
export interface StatBucket {
  produced: number;
  sold: number;
  revenue: number;
  expenses: number;
  /** Переработано нефти на НПЗ, барр. */
  refined: number;
  /** Выручка от нефтепродуктов (входит и в revenue). */
  productRevenue: number;
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
  /** Переработано нефти на НПЗ, барр. (sold — только сырая нефть). */
  refined: number;
  /** Произведено и продано нефтепродуктов [бензин, дизель, мазут], барр. */
  productsMade: [number, number, number];
  productsSold: [number, number, number];
  /** Выручка от нефтепродуктов (часть revenue). */
  productRevenue: number;
  /** Деньги, потраченные на исследования (не входят в capex: не возвращаются при сносе). */
  research: number;
  /** Зарплаты менеджеров — часть expenses (операционные расходы), отдельно для разбивки. */
  salaries: number;
  /** Кредиты: получено, погашено основного долга, уплачено процентов. */
  borrowed: number;
  repaid: number;
  interest: number;
  /** Награды за просмотр рекламы (веха 0.5, этап 3) — отдельный член денежного инварианта. */
  adRewards: number;
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
  /** Минимальные цены продажи нефтепродуктов [бензин, дизель, мазут] — общие для всех НПЗ компании. */
  productThresholds: [number, number, number];
  unlocked: BuildableType[];
  /** Открытые возможности компании (не здания). */
  features: Feature[];
  research: ResearchState;
  managers: ManagersState;
  loan: LoanState | null;
  /** Игровое время последней награды за рекламу, с (null — не было). */
  adLastAt: number | null;
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
