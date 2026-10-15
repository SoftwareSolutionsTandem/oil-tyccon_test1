import { PIPES, REFINERY } from './config';
import { drainageTiles, gradePrice, isProducer, levelSpec, rateFromPool, productPrice, pumpGrade, refineryMargin, refineryProductCap, refineryShip } from './economy';
import type { Building, GameState, Grade } from './types';

/**
 * Логистика: сеть трубопроводов и хранилищ.
 *
 * Узлы сети — клетки с трубами и клетки хранилищ (контора, резервуары). Соседние по стороне узлы соединены.
 * Компонента связности — одна «сеть». Качалки и терминалы примыкают к соседней сети, но сами сети между собой
 * не соединяют — поэтому связность всегда совпадает с маршрутами, по которым идёт нефть.
 *
 * Нефть лежит в конкретном хранилище и сама между резервуарами не перетекает (иначе трубы можно было бы обойти,
 * поставив резервуар у каждой скважины). Качалка гонит нефть по трубам в ближайшее достижимое хранилище со
 * свободным местом; терминал забирает из ближайшего хранилища, где есть нефть. Нагрузка трубы — сумма этих потоков.
 *
 * Расчёт потока не зависит от порядка зданий в массиве: маршруты строятся поиском в ширину от всех хранилищ
 * сети сразу с фиксированным порядком соседей, ничьи решаются индексом клетки, а ограничения применяются
 * пропорционально ко всем, кто делит трубу или хранилище.
 */

export interface NetComponent {
  id: number;
  storages: Building[];
  pumps: Building[];
  terminals: Building[];
  refineries: Building[];
  /** Суммарная ёмкость хранилищ сети. */
  capacity: number;
  /** Клетки труб сети. */
  pipeTiles: number[];
}

export interface Network {
  sig: number;
  /** Номер сети для клеток труб и хранилищ, −1 — не узел. */
  compOfTile: Int32Array;
  components: NetComponent[];
  /** Сеть, к которой примыкает качалка или терминал (по id здания). */
  attach: Map<number, number>;
  /** Маршрут качалки к ближайшему хранилищу: клетки труб от качалки к хранилищу (пусто при прямом соседстве). */
  routes: Map<number, number[]>;
  /** Достижимые хранилища качалки или терминала по возрастанию длины пути, с маршрутами. */
  reach: Map<number, Array<{ storage: Building; si: number; path: number[]; length: number }>>;
  /** Хранилища сети по номерам (si в reach) — для быстрых массивов в расчёте потока. */
  storages: Building[];
  /** Зоны дренирования качалок (зависят только от расположения зданий — кешируются вместе с сетью). */
  drainage: Map<number, number[]>;
  /** Данные для поиска обходов и кеш обходов по набору насыщенных труб. */
  ctx: ReachContext;
  detours: Map<string, Reach>;
}

/** Состояние потоков последнего тика — для интерфейса и отрисовки (не сохраняется). */
export interface FlowInfo {
  /** Поток, который трубы должны были бы пропустить без ограничений, барр./с. */
  demand: Float32Array;
  /** Фактический поток, барр./с. */
  actual: Float32Array;
  /**
   * По качалке или терминалу (id здания): желаемый и фактический поток, барр./с, ограничивающая клетка трубы
   * (−1 — нет), фактический маршрут и хранилище на его конце.
   */
  clients: Map<number, ClientFlow>;
}

export interface ClientFlow {
  want: number;
  actual: number;
  bottleneck: number;
  path: number[];
  storage: number;
}

const SIDES = [1, -1, 0, 0];
const SIDES_Y = [0, 0, 1, -1];
const isStorage = (b: Building) => b.type === 'hq' || b.type === 'tank';

const cache = new WeakMap<GameState, Network>();
const flows = new WeakMap<GameState, FlowInfo>();

/** Быстрая подпись топологии: здания и трубы. Пересчёт сети только при её изменении. */
function signature(s: GameState): number {
  let h = 2166136261;
  const mix = (v: number) => {
    h = Math.imul(h ^ v, 16777619);
  };
  for (const b of s.buildings) {
    mix(b.id);
    mix(b.x * 131 + b.y);
    mix(b.type.charCodeAt(0));
  }
  const p = s.map.pipes;
  for (let i = 0; i < p.length; i++) if (p[i]) mix(i * 4 + p[i]);
  return h;
}

export function pipeCapacity(kind: number): number {
  return kind === 1 || kind === 2 ? PIPES[kind].capacity : 0;
}

export function getNetwork(s: GameState): Network {
  const sig = signature(s);
  const cached = cache.get(s);
  if (cached && cached.sig === sig) return cached;
  const net = buildNetwork(s, sig);
  cache.set(s, net);
  return net;
}

function buildNetwork(s: GameState, sig: number): Network {
  const n = s.map.size;
  const total = n * n;
  const byTile = new Map<number, Building>();
  for (const b of s.buildings) byTile.set(b.y * n + b.x, b);
  const isNode = (i: number) => {
    const b = byTile.get(i);
    if (b) return isStorage(b);
    return s.map.pipes[i] > 0;
  };

  // Объединение узлов-соседей (система непересекающихся множеств).
  const parent = new Int32Array(total).fill(-1);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < total; i++) if (isNode(i)) parent[i] = i;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (parent[i] < 0) continue;
      for (const j of [x + 1 < n ? i + 1 : -1, y + 1 < n ? i + n : -1]) {
        if (j < 0 || parent[j] < 0) continue;
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }

  // Нумерация сетей по наименьшей клетке — детерминированно.
  const compOfTile = new Int32Array(total).fill(-1);
  const rootToComp = new Map<number, number>();
  const components: NetComponent[] = [];
  for (let i = 0; i < total; i++) {
    if (parent[i] < 0) continue;
    const r = find(i);
    let c = rootToComp.get(r);
    if (c === undefined) {
      c = components.length;
      rootToComp.set(r, c);
      components.push({ id: c, storages: [], pumps: [], terminals: [], refineries: [], capacity: 0, pipeTiles: [] });
    }
    compOfTile[i] = c;
    const b = byTile.get(i);
    if (b) {
      components[c].storages.push(b);
      components[c].capacity += levelSpec(b).value;
    } else components[c].pipeTiles.push(i);
  }

  // Качалки и терминалы примыкают к соседним сетям: могут качать в хранилища любой из них,
  // а для отображения закрепляются за одной (предпочтительно — с хранилищем, затем с меньшим номером).
  const attach = new Map<number, number>();
  const clientsOf = new Map<number, Building[]>();
  for (const b of [...s.buildings].sort((a, c) => a.id - c.id)) {
    if (!isProducer(b) && b.type !== 'terminal' && b.type !== 'refinery') continue;
    let best = -1;
    const seen = new Set<number>();
    for (let k = 0; k < 4; k++) {
      const x = b.x + SIDES[k];
      const y = b.y + SIDES_Y[k];
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const c = compOfTile[y * n + x];
      if (c < 0) continue;
      if (!seen.has(c)) {
        seen.add(c);
        if (!clientsOf.has(c)) clientsOf.set(c, []);
        clientsOf.get(c)!.push(b);
      }
      const better =
        best < 0 ||
        (components[c].storages.length > 0 && components[best].storages.length === 0) ||
        ((components[c].storages.length > 0) === (components[best].storages.length > 0) && c < best);
      if (better) best = c;
    }
    if (best < 0) continue;
    attach.set(b.id, best);
    (isProducer(b) ? components[best].pumps : b.type === 'terminal' ? components[best].terminals : components[best].refineries).push(b);
  }

  const storages = s.buildings.filter(isStorage);
  const ctx: ReachContext = { s, n, byTile, clients: [], storageIndex: new Map(storages.map((b, i) => [b, i])) };
  for (const comp of components) {
    if (comp.storages.length === 0) continue;
    const clients = clientsOf.get(comp.id) ?? [];
    if (clients.length) ctx.clients.push({ storages: comp.storages, clients });
  }
  const reach = computeReach(ctx, null);
  const routes = new Map<number, number[]>();
  for (const [id, list] of reach) routes.set(id, list[0].path);
  const drainage = new Map<number, number[]>();
  for (const b of s.buildings) if (isProducer(b)) drainage.set(b.id, drainageTiles(s, b));
  return { sig, compOfTile, components, attach, routes, reach, storages, drainage, ctx, detours: new Map() };
}

type Reach = Map<number, Array<{ storage: Building; si: number; path: number[]; length: number }>>;

/** Всё, что нужно для поиска маршрутов в сети: хранилища и примыкающие к ним клиенты по сетям. */
interface ReachContext {
  s: GameState;
  n: number;
  byTile: Map<number, Building>;
  clients: Array<{ storages: Building[]; clients: Building[] }>;
  storageIndex: Map<Building, number>;
}

/**
 * Достижимость: поиск в ширину по трубам от каждого хранилища отдельно (хранилищ немного).
 * Хранилища работают как коллекторы — путь может проходить через них; через качалки и терминалы — нет.
 * blocked — клетки труб, через которые идти нельзя (насыщенные в текущем расчёте потока): так находятся обходы.
 * Списки отсортированы: ближайшее хранилище первым, ничьи — по клетке хранилища (не по порядку зданий).
 */
function computeReach(ctx: ReachContext, blocked: Set<number> | null): Reach {
  const { s, n, byTile } = ctx;
  const total = n * n;
  const reach: Reach = new Map();
  const dist = new Int32Array(total);
  const prev = new Int32Array(total);
  for (const group of ctx.clients) {
    for (const st of group.storages) {
      dist.fill(-1);
      const start = st.y * n + st.x;
      dist[start] = 0;
      prev[start] = -1;
      const queue = [start];
      for (let q = 0; q < queue.length; q++) {
        const i = queue[q];
        const x = i % n;
        const y = (i - x) / n;
        for (let k = 0; k < 4; k++) {
          const nx = x + SIDES[k];
          const ny = y + SIDES_Y[k];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          if (dist[j] >= 0) continue;
          const nb = byTile.get(j);
          if (nb ? !isStorage(nb) : s.map.pipes[j] <= 0 || (blocked !== null && blocked.has(j))) continue;
          dist[j] = dist[i] + 1;
          prev[j] = i;
          queue.push(j);
        }
      }
      for (const c of group.clients) {
        let entry = -1;
        for (let k = 0; k < 4; k++) {
          const x = c.x + SIDES[k];
          const y = c.y + SIDES_Y[k];
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const j = y * n + x;
          if (dist[j] < 0) continue;
          if (entry < 0 || dist[j] < dist[entry] || (dist[j] === dist[entry] && j < entry)) entry = j;
        }
        if (entry < 0) continue;
        // В путь попадают только клетки труб: проход через хранилище-коллектор трубу не нагружает.
        const path: number[] = [];
        for (let t = entry; t >= 0 && dist[t] > 0; t = prev[t]) if (s.map.pipes[t] > 0 && !byTile.has(t)) path.push(t);
        let list = reach.get(c.id);
        if (!list) reach.set(c.id, (list = []));
        list.push({ storage: st, si: ctx.storageIndex.get(st)!, path, length: dist[entry] });
      }
    }
  }
  for (const list of reach.values()) list.sort((a, b) => a.length - b.length || a.storage.y * n + a.storage.x - (b.storage.y * n + b.storage.x));
  return reach;
}

/** Маршруты в обход насыщенных труб (кешируются по набору насыщенных клеток — он стабилен от тика к тику). */
function detourReach(net: Network, blocked: number[]): Reach {
  const key = blocked.join(',');
  let r = net.detours.get(key);
  if (!r) {
    if (net.detours.size > 16) net.detours.clear();
    r = computeReach(net.ctx, new Set(blocked));
    net.detours.set(key, r);
  }
  return r;
}

/** Сеть здания: для хранилища — его собственная, для качалки и терминала — та, к которой примыкает. */
export function componentOf(s: GameState, b: Building): NetComponent | null {
  const net = getNetwork(s);
  const c = isStorage(b) ? net.compOfTile[b.y * s.map.size + b.x] : net.attach.get(b.id);
  return c === undefined || c < 0 ? null : net.components[c];
}

/** Подключена ли качалка/терминал к сети с хранилищем. */
export function isConnected(s: GameState, b: Building): boolean {
  const c = componentOf(s, b);
  return !!c && c.storages.length > 0;
}

export function storedIn(c: NetComponent): number {
  return c.storages.reduce((sum, b) => sum + (b.stored ?? 0), 0);
}

/** Пересчитывает общий запас s.oil из хранилищ. */
export function syncOil(s: GameState): void {
  let total = 0;
  for (const b of s.buildings) if (isStorage(b)) total += b.stored ?? 0;
  s.oil = total;
}

export function lastFlow(s: GameState): FlowInfo | undefined {
  return flows.get(s);
}


const free = (b: Building) => Math.max(0, levelSpec(b).value - (b.stored ?? 0));

/**
 * Сколько раундов перераспределения за тик: остаток спроса уходит к следующему по дальности хранилищу,
 * а место, освобождённое забором в раунде, принимает закачку в следующем.
 */
const ROUNDS = 6;

interface Client {
  b: Building;
  /** Достижимые хранилища по возрастанию длины пути. */
  list: Array<{ storage: Building; si: number; path: number[] }>;
  /** Сколько ещё нужно перекачать за этот тик, барр. */
  need: number;
  /** Желаемый поток, барр./с. */
  want: number;
  moved: number;
  /** Ограничивающая клетка первого раунда (−1 — нет) и упирался ли поток в трубы. */
  bottleneck: number;
  piped: boolean;
  firstPath: number[] | null;
  firstStorage: number;
  /** Сколько перекачано в каждое хранилище (из каждого — для терминала). */
  deliveries: Map<Building, number>;
  /** Сорт нефти качалки; −1 — клиент, который забирает нефть (терминал, НПЗ). */
  grade: number;
  /** Для забирающих клиентов: маска допустимых сортов (бит 0 — лёгкая, бит 1 — тяжёлая). */
  mask: number;
}
/** Рабочие массивы расчёта потока за тик (переиспользуются между тиками). */
interface Scratch {
  /** Остаток пропускной способности трубы за тик, NaN — труба в этом тике ещё не использовалась. */
  spare: Float64Array;
  /** Клетки, у которых spare задан. */
  touched: number[];
  load: Float64Array;
}


/**
 * Общий расчёт потока шага: забирающие клиенты (терминалы, НПЗ; grade < 0) и качалки (grade ≥ 0) в одних раундах
 * и делят пропускную способность каждой трубы пропорционально запросам — без приоритета фазы. Иначе у
 * хранилища-тупика забор и закачка через одну трубу чередовались бы по шагам (нейтральное двухшаговое колебание).
 * oil — нефть, которую можно забрать (только запас на начало шага); room — свободное место для закачки;
 * level — запас хранилища; grades — сорт запаса на начало шага (−1 — пусто). Всё применяется одновременно
 * в конце раунда, поэтому результат не зависит от порядка клиентов.
 */
function allocate(
  net: Network,
  clients: Client[],
  oil: Float64Array,
  room: Float64Array,
  level: Float64Array,
  grades: Int8Array,
  sc: Scratch,
  cap: (tile: number) => number,
  info: FlowInfo,
  dt: number,
): void {
  const { spare, touched, load } = sc;
  const left = (t: number) => (spare[t] === spare[t] ? spare[t] : cap(t) * dt);
  // Сорт содержимого для закачки: меняется, когда хранилище опустело забором или в него закачали.
  const content = Int8Array.from(grades);
  const pushGrade = new Int8Array(grades.length);
  // Качалка: хранилище своего сорта или пустое. Забирающий клиент: хранилище с нефтью сорта из его маски
  // (у терминала — сорта не ниже порога цены, у НПЗ — фильтр сырья и маржа, 2.1 плана НПЗ).
  const fits = (c: Client, si: number) =>
    c.grade >= 0 ? room[si] > 1e-9 && (pushGrade[si] < 0 || pushGrade[si] === c.grade) : oil[si] > 1e-9 && grades[si] >= 0 && ((c.mask >> grades[si]) & 1) === 1;
  const asked = new Float64Array(room.length);
  const askedPull = new Float64Array(room.length);
  const askedBy = [new Float64Array(room.length), new Float64Array(room.length)];
  for (let round = 0; round < ROUNDS; round++) {
    for (let si = 0; si < level.length; si++) pushGrade[si] = level[si] > 1e-9 ? content[si] : -1;
    const saturated: number[] = [];
    for (const t of touched) if (spare[t] <= 1e-9) saturated.push(t);
    saturated.sort((a, b) => a - b);
    const reach = saturated.length ? detourReach(net, saturated) : net.reach;
    const active: Array<{ c: Client; si: number; path: number[]; amount: number; req: number }> = [];
    for (const c of clients) {
      if (c.need <= 1e-9) continue;
      c.list = reach.get(c.b.id) ?? [];
      // Ближайшее подходящее хранилище. Маршруты этого раунда уже обходят насыщенные трубы.
      const to = c.list.find((r) => fits(c, r.si));
      if (!to) continue;
      // Заявка на трубу (req) — не больше, чем можно забрать из хранилища (налить в него): иначе клиент занял бы
      // долю трубы, которую не использует, и соседи получали бы её только в следующем раунде — при общем
      // хранилище это снова давало бы чередование «забор x, закачка C − x» по шагам. Доля самого хранилища
      // делится по полному запросу (amount), если труба его не ограничила.
      const avail = c.grade >= 0 ? room[to.si] : oil[to.si];
      active.push({ c, si: to.si, path: to.path, amount: c.need, req: Math.min(c.need, avail) });
      if (round === 0) {
        c.firstPath = to.path;
        c.firstStorage = to.storage.id;
      }
    }
    if (!active.length) return;
    // Нагрузка труб в этом раунде — забор и закачка вместе — и масштаб по самому узкому месту пути.
    for (const a of active) for (const t of a.path) load[t] += a.req;
    if (round === 0) for (const a of active) for (const t of a.path) info.demand[t] += a.req / dt;
    for (const a of active) {
      let k = 1;
      let worst = -1;
      for (const t of a.path) {
        const q = left(t) / load[t];
        if (q < k) {
          k = q;
          worst = t;
        }
      }
      if (k < 1) a.amount = a.req * Math.max(0, k);
      if (worst >= 0 && k < 0.999) {
        a.c.piped = true;
        if (a.c.bottleneck < 0) a.c.bottleneck = worst;
      }
    }
    for (const a of active) for (const t of a.path) load[t] = 0;
    // Пустое хранилище, в которое в одном раунде просятся оба сорта, принимает сорт с большим потоком
    // (при равенстве — лёгкую); другой сорт ищет место в следующем раунде.
    askedBy[0].fill(0);
    askedBy[1].fill(0);
    for (const a of active) if (a.c.grade >= 0 && pushGrade[a.si] < 0) askedBy[a.c.grade][a.si] += a.amount;
    for (const a of active) {
      if (a.c.grade < 0 || pushGrade[a.si] >= 0) continue;
      const winner = askedBy[1][a.si] > askedBy[0][a.si] ? 1 : 0;
      if (a.c.grade !== winner && askedBy[winner][a.si] > 0) a.amount = 0;
    }
    // Доля хранилища: если просят больше, чем есть места (нефти), — пропорционально; место и нефть — раздельно.
    asked.fill(0);
    askedPull.fill(0);
    for (const a of active) (a.c.grade >= 0 ? asked : askedPull)[a.si] += a.amount;
    for (const a of active) {
      const want = a.c.grade >= 0 ? asked[a.si] : askedPull[a.si];
      const have = a.c.grade >= 0 ? room[a.si] : oil[a.si];
      if (want > 0) a.amount *= Math.min(1, have / want);
    }
    let movedAny = false;
    for (const a of active) {
      if (a.amount <= 0) continue;
      movedAny = true;
      if (a.c.grade >= 0) {
        room[a.si] = Math.max(0, room[a.si] - a.amount);
        level[a.si] += a.amount;
        content[a.si] = a.c.grade;
      } else {
        oil[a.si] = Math.max(0, oil[a.si] - a.amount);
        level[a.si] = Math.max(0, level[a.si] - a.amount);
        // Забранное освобождает место — закачка может занять его в следующем раунде.
        room[a.si] += a.amount;
      }
      a.c.need -= a.amount;
      a.c.moved += a.amount;
      const st = net.storages[a.si];
      a.c.deliveries.set(st, (a.c.deliveries.get(st) ?? 0) + a.amount);
      for (const t of a.path) {
        if (spare[t] !== spare[t]) touched.push(t);
        spare[t] = Math.max(0, left(t) - a.amount);
        info.actual[t] += a.amount / dt;
      }
    }
    if (!movedAny) return;
  }
}

const scratch = new WeakMap<GameState, Scratch>();

/**
 * Один шаг логистики. Терминалы, НПЗ и качалки — клиенты одного распределения (allocate): трубы делятся
 * пропорционально заявкам забора и закачки вместе; забор берёт запас начала шага, а освобождённое им место
 * принимает закачку в следующем раунде.
 * Добытое ровно равно убыли запасов месторождений и ровно попадает в хранилища; проданное ровно уходит из них.
 */
export interface StepResult {
  produced: number;
  /** Продано сырой нефти через терминалы, барр. */
  sold: number;
  /** Вся выручка шага: нефть и нефтепродукты. */
  revenue: number;
  /** Переработано на НПЗ, барр.; по сортам; ценность переработанной нефти по ценам сортов (упущенная прямая продажа). */
  refined: number;
  refinedByGrade: [number, number];
  refinedValue: number;
  productsMade: [number, number, number];
  productsSold: [number, number, number];
  productRevenue: number;
}

export function stepLogistics(s: GameState, dt: number): StepResult {
  const net = getNetwork(s);
  const total = s.map.size * s.map.size;
  let info = flows.get(s);
  if (!info || info.demand.length !== total) {
    info = { demand: new Float32Array(total), actual: new Float32Array(total), clients: new Map() };
    flows.set(s, info);
  }
  info.demand.fill(0);
  info.actual.fill(0);
  info.clients.clear();
  let sc = scratch.get(s);
  if (!sc || sc.spare.length !== total) {
    sc = { spare: new Float64Array(total).fill(NaN), touched: [], load: new Float64Array(total) };
    scratch.set(s, sc);
  }
  for (const t of sc.touched) sc.spare[t] = NaN;
  sc.touched.length = 0;
  const cap = (t: number) => pipeCapacity(s.map.pipes[t]);
  const client = (b: Building, want: number): Client => ({
    b,
    list: net.reach.get(b.id)!,
    need: want * dt,
    want,
    moved: 0,
    bottleneck: -1,
    piped: false,
    firstPath: null,
    firstStorage: -1,
    deliveries: new Map(),
    grade: -1,
    mask: 0,
  });
  const record = (c: Client) =>
    info!.clients.set(c.b.id, {
      want: c.want,
      actual: c.moved / dt,
      bottleneck: c.piped ? c.bottleneck : -1,
      path: c.firstPath ?? [],
      storage: c.firstStorage,
    });

  // Сорт хранилища: −1 — пусто (примет любой).
  const grades = new Int8Array(net.storages.length);
  net.storages.forEach((st, i) => (grades[i] = (st.stored ?? 0) > 1e-9 ? (st.grade ?? 0) : -1));

  // 0. Продажа нефтепродуктов с НПЗ — до забора нефти, чтобы проданное освободило место в этом же шаге.
  const productsSold: [number, number, number] = [0, 0, 0];
  let productRevenue = 0;
  const pPrice = [productPrice(s, 0), productPrice(s, 1), productPrice(s, 2)];
  for (const b of s.buildings) {
    if (b.type !== 'refinery' || !b.products) continue;
    const sell = [0, 1, 2].map((i) => (b.enabled && pPrice[i] >= s.productThresholds[i] ? b.products![i] : 0));
    const want = sell[0] + sell[1] + sell[2];
    if (want <= 0) continue;
    // Мощность отгрузки — общая на продукты; если продаваемого больше, она делится пропорционально запасам.
    const k = Math.min(1, (refineryShip(b) * dt) / want);
    for (let i = 0; i < 3; i++) {
      const amount = sell[i] * k;
      if (amount <= 0) continue;
      b.products[i] -= amount;
      if (b.products[i] < 1e-12) b.products[i] = 0;
      productsSold[i] += amount;
      productRevenue += amount * pPrice[i];
    }
  }

  // 1. Забор нефти: терминалы и НПЗ — клиенты одного распределения, без приоритета по типу здания.
  // Порог цены терминалов проверяется для каждого сорта; у НПЗ — фильтр сырья и маржа.
  const sellable = [gradePrice(s, 0) >= s.sellThreshold, gradePrice(s, 1) >= s.sellThreshold];
  const terms: Client[] = [];
  const refs: Array<Client & { okMask: number; storageLimited: number }> = [];
  for (const b of s.buildings) {
    if (b.type === 'terminal') {
      if (!b.enabled) b.status = 'off';
      else if (!net.reach.has(b.id)) b.status = 'no_route';
      else if (!sellable[0] && !sellable[1]) b.status = 'waiting_price';
      else terms.push({ ...client(b, levelSpec(b).value), mask: (sellable[0] ? 1 : 0) | (sellable[1] ? 2 : 0) });
      continue;
    }
    if (b.type !== 'refinery') continue;
    if (!b.enabled) {
      b.status = 'off';
      continue;
    }
    if (!net.reach.has(b.id)) {
      b.status = 'no_route';
      continue;
    }
    if (!b.products) b.products = [0, 0, 0];
    const reachable = net.reach.get(b.id)!;
    // Сорта, нефть которых сейчас есть в достижимых хранилищах (без учёта насыщения труб).
    let present = 0;
    for (const r of reachable) if (grades[r.si] >= 0) present |= 1 << grades[r.si];
    const plan = refineryPlan(s, b, dt, present);
    // Порядок причин статуса (2.3 плана): сырьё → маржа → склад → труба.
    const c = { ...client(b, levelSpec(b).value), mask: plan.mask, okMask: plan.filterMask, storageLimited: plan.limitedBy };
    c.need = plan.need;
    if ((plan.filterMask & present) === 0) b.status = 'no_feed';
    else if ((plan.mask & present) === 0) b.status = 'waiting_margin';
    else if (plan.need <= REFINERY.eps) b.status = 'product_full';
    else {
      refs.push(c);
      continue;
    }
    record(c);
  }
  // Качалки — клиенты того же расчёта: забор и закачка делят трубы пропорционально.
  const pumps: Array<Client & { tiles: number[]; pool: number }> = [];
  for (const b of s.buildings) {
    if (!isProducer(b)) continue;
    const tiles = net.drainage.get(b.id)!;
    let pool = 0;
    let initial = 0;
    for (const i of tiles) {
      pool += s.map.reserve[i];
      initial += s.map.initial[i];
    }
    if (pool <= 0) b.status = 'depleted';
    else if (!b.enabled) b.status = 'off';
    else if (!net.reach.has(b.id)) b.status = 'no_route';
    else pumps.push({ ...client(b, Math.min(pool / dt, rateFromPool(s, b, pool, initial))), tiles, pool, grade: pumpGrade(s, b) });
  }
  const oil = new Float64Array(net.storages.length);
  const room = new Float64Array(net.storages.length);
  const level = new Float64Array(net.storages.length);
  net.storages.forEach((st, i) => {
    oil[i] = grades[i] >= 0 ? (st.stored ?? 0) : 0;
    room[i] = free(st);
    level[i] = st.stored ?? 0;
  });
  allocate(net, [...terms, ...refs, ...pumps], oil, room, level, grades, sc, cap, info, dt);
  let sold = 0;
  let revenue = productRevenue;
  for (const c of terms) {
    for (const [st, v] of c.deliveries) {
      // Остаток меньше погрешности забирается целиком: хранилище пустеет и снова принимает любой сорт.
      const have = st.stored ?? 0;
      const amount = have - v < 1e-9 ? have : v;
      st.stored = have - amount;
      sold += amount;
      revenue += amount * gradePrice(s, st.grade ?? 0);
    }
    const reachable = net.reach.get(c.b.id) ?? [];
    const oilLeft = reachable.some((r) => oil[r.si] > 1e-6 && ((c.mask >> grades[r.si]) & 1) === 1);
    const heldBack = reachable.some((r) => (r.storage.stored ?? 0) > 1e-6 && !sellable[r.storage.grade ?? 0]);
    c.b.status =
      c.need <= 1e-6 ? 'ok' : c.piped && oilLeft ? 'throttled' : c.moved <= 1e-9 ? (heldBack ? 'waiting_price' : 'no_oil') : 'ok';
    record(c);
  }
  // НПЗ: забранное сразу переработано; мазут — остаток, поэтому сумма продуктов ровно равна сырью (2.2 плана).
  let refined = 0;
  let refinedValue = 0;
  const productsMade: [number, number, number] = [0, 0, 0];
  const refinedByGrade: [number, number] = [0, 0];
  for (const c of refs) {
    const b = c.b;
    let got = 0;
    for (const [st, v] of c.deliveries) {
      const have = st.stored ?? 0;
      const amount = have - v < 1e-9 ? have : v;
      st.stored = have - amount;
      const g = (st.grade ?? 0) as Grade;
      const y = REFINERY.yields[g];
      const gas = amount * y[0];
      const dsl = amount * y[1];
      const maz = amount - gas - dsl;
      b.products![0] += gas;
      b.products![1] += dsl;
      b.products![2] += maz;
      productsMade[0] += gas;
      productsMade[1] += dsl;
      productsMade[2] += maz;
      refinedByGrade[g] += amount;
      refinedValue += amount * gradePrice(s, g);
      got += amount;
    }
    refined += got;
    const reachable = net.reach.get(b.id) ?? [];
    const oilLeft = reachable.some((r) => oil[r.si] > 1e-6 && ((c.mask >> grades[r.si]) & 1) === 1);
    b.status = c.need <= 1e-6 ? 'ok' : c.piped && oilLeft ? 'throttled' : got <= REFINERY.eps ? 'no_feed' : 'ok';
    record(c);
  }

  // 2. Добыча: принятое хранилищами зачисляется после забора (забор брал только запас начала шага).
  let produced = 0;
  for (const c of pumps) {
    // Извлечение из зоны дренирования пропорционально запасам клеток; ровно столько, сколько принято хранилищами.
    let got = 0;
    // Запас перечитывается: клетку могла уже частично выкачать соседняя скважина в этом тике.
    const pool = c.tiles.reduce((sum, i) => sum + s.map.reserve[i], 0);
    if (c.moved > 0 && pool > 0) {
      for (const i of c.tiles) {
        const take = Math.min(s.map.reserve[i], (c.moved * s.map.reserve[i]) / pool);
        s.map.reserve[i] -= take;
        got += take;
      }
    }
    // Зачисляется ровно добытое (got может отличаться от moved на погрешность округления).
    const k = c.moved > 0 ? got / c.moved : 0;
    for (const [st, v] of c.deliveries) {
      st.stored = (st.stored ?? 0) + v * k;
      st.grade = c.grade as Grade;
    }
    c.moved = got;
    produced += got;
  }
  // Сорт хранилищ после шага — по нему видно, осталось ли место для сорта качалки.
  net.storages.forEach((st, i) => (grades[i] = (st.stored ?? 0) > 1e-9 ? (st.grade ?? 0) : -1));
  for (const c of pumps) {
    // Недобор из-за трубы — только если в достижимых хранилищах осталось место; иначе причина — заполненный склад.
    const reachable = net.reach.get(c.b.id) ?? [];
    const roomLeft = reachable.some((r) => room[r.si] > 1e-6 && (grades[r.si] < 0 || grades[r.si] === c.grade));
    // Место есть, но только в хранилищах с нефтью другого сорта: нужен свой резервуар.
    const otherGrade = !roomLeft && reachable.some((r) => room[r.si] > 1e-6);
    c.b.status =
      c.need <= 1e-6 * Math.max(1, c.want) ? 'ok' : c.piped && roomLeft ? 'throttled' : otherGrade && c.moved <= c.want * dt * 0.5 ? 'wrong_grade' : 'full';
    record(c);
  }
  syncOil(s);
  return { produced, sold, revenue, refined, refinedByGrade, refinedValue, productsMade, productsSold, productRevenue };
}

/**
 * Допустимый объём переработки НПЗ за шаг (2.1 плана). Маска M = фильтр ∩ (маржа > 0, если marginOnly);
 * need = min(мощность·dt, min по продуктам free_i / ŷ_i), где ŷ_i — худший выход продукта среди сортов M.
 * Гарантия: при любой смеси сортов из M суммарно не больше need продукты помещаются на склады.
 */
export function refineryPlan(
  s: GameState,
  b: Building,
  dt: number,
  present = 3,
): { need: number; mask: number; filterMask: number; limitedBy: number } {
  const feed = b.feed ?? 'any';
  const filterMask = feed === 'light' ? 1 : feed === 'heavy' ? 2 : 3;
  let mask = filterMask;
  if (b.marginOnly !== false) for (const g of [0, 1] as const) if (refineryMargin(s, g) <= 0) mask &= ~(1 << g);
  let need = levelSpec(b).value * dt;
  let limitedBy = -1;
  if (mask === 0) return { need: 0, mask, filterMask, limitedBy };
  const capP = refineryProductCap(b);
  // Худший выход — по сортам, которые НПЗ может реально получить в этом шаге: допустимым и имеющимся в достижимых
  // хранилищах на начало забора (в фазе забора хранилища только отдают нефть, новый сорт появиться не может).
  const possible = mask & present;
  for (let i = 0; i < 3; i++) {
    let worst = 0;
    for (const g of [0, 1] as const) if ((possible >> g) & 1) worst = Math.max(worst, REFINERY.yields[g][i]);
    if (worst <= 0) continue;
    const freeI = Math.max(0, capP - (b.products?.[i] ?? 0) - REFINERY.epsCap);
    if (freeI / worst < need) {
      need = freeI / worst;
      limitedBy = i;
    }
  }
  if (need <= REFINERY.eps) need = 0;
  return { need, mask, filterMask, limitedBy };
}
