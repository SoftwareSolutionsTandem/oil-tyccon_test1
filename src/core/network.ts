import { DEPLETION_MIN_FACTOR, PIPES } from './config';
import { drainageTiles, levelSpec } from './economy';
import type { Building, GameState } from './types';

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
  reach: Map<number, Array<{ storage: Building; path: number[]; length: number }>>;
  /** Зоны дренирования качалок (зависят только от расположения зданий — кешируются вместе с сетью). */
  drainage: Map<number, number[]>;
}

/** Состояние потоков последнего тика — для интерфейса и отрисовки (не сохраняется). */
export interface FlowInfo {
  /** Поток, который трубы должны были бы пропустить без ограничений, барр./с. */
  demand: Float32Array;
  /** Фактический поток, барр./с. */
  actual: Float32Array;
  /** По качалке: желаемый и фактический поток, барр./с, и ограничивающая клетка трубы (если есть). */
  pumps: Map<number, { want: number; actual: number; bottleneck: number }>;
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
      components.push({ id: c, storages: [], pumps: [], terminals: [], capacity: 0, pipeTiles: [] });
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
    if (b.type !== 'pumpjack' && b.type !== 'terminal') continue;
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
    (b.type === 'pumpjack' ? components[best].pumps : components[best].terminals).push(b);
  }

  // Достижимость: поиск в ширину по трубам от каждого хранилища отдельно (хранилищ немного).
  // Хранилища работают как коллекторы — путь может проходить через них; через качалки и терминалы — нет.
  // Так «одна сеть» всегда означает «всё в ней достижимо».
  const routes = new Map<number, number[]>();
  const reach = new Map<number, Array<{ storage: Building; path: number[]; length: number }>>();
  const dist = new Int32Array(total);
  const prev = new Int32Array(total);
  for (const comp of components) {
    if (comp.storages.length === 0) continue;
    const clients = clientsOf.get(comp.id) ?? [];
    if (clients.length === 0) continue;
    for (const st of comp.storages) {
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
          if (nb ? !isStorage(nb) : s.map.pipes[j] <= 0) continue;
          dist[j] = dist[i] + 1;
          prev[j] = i;
          queue.push(j);
        }
      }
      for (const c of clients) {
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
        list.push({ storage: st, path, length: dist[entry] });
      }
    }
  }
  for (const [id, list] of reach) {
    // Ближайшее — первым; ничьи — по клетке хранилища (детерминированно, не по порядку зданий).
    list.sort((a, b) => a.length - b.length || a.storage.y * n + a.storage.x - (b.storage.y * n + b.storage.x));
    routes.set(id, list[0].path);
  }
  const drainage = new Map<number, number[]>();
  for (const b of s.buildings) if (b.type === 'pumpjack') drainage.set(b.id, drainageTiles(s, b));
  return { sig, compOfTile, components, attach, routes, reach, drainage };
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

/** То же, что pumpRate, но по уже посчитанной зоне (без повторного обхода зданий). */
function rateOf(b: Building, reserve: number, initial: number): number {
  if (initial <= 0 || reserve <= 0) return 0;
  return levelSpec(b).value * (DEPLETION_MIN_FACTOR + (1 - DEPLETION_MIN_FACTOR) * (reserve / initial));
}

const free = (b: Building) => Math.max(0, levelSpec(b).value - (b.stored ?? 0));

/**
 * Один шаг логистики: добыча через сеть и продажа через терминалы.
 * Все ограничения применяются пропорционально ко всем, кто делит трубу или хранилище, — результат не зависит
 * от порядка обхода зданий. Добытое ровно равно убыли запасов и ровно попадает в хранилища.
 */
export function stepLogistics(s: GameState, dt: number, price: number, priceOk: boolean): { produced: number; sold: number; revenue: number } {
  const net = getNetwork(s);
  const total = s.map.size * s.map.size;
  let info = flows.get(s);
  if (!info || info.demand.length !== total) {
    info = { demand: new Float32Array(total), actual: new Float32Array(total), pumps: new Map() };
    flows.set(s, info);
  }
  info.demand.fill(0);
  info.actual.fill(0);
  info.pumps.clear();

  interface Flow {
    b: Building;
    target: Building;
    path: number[];
    /** Желаемый поток, барр./с. */
    want: number;
    scale: number;
    bottleneck: number;
    tiles?: number[];
  }
  // 1. Качалки: ближайшее достижимое хранилище со свободным местом.
  const pumps: Flow[] = [];
  for (const b of s.buildings) {
    if (b.type !== 'pumpjack') continue;
    const tiles = net.drainage.get(b.id)!;
    let pool = 0;
    let initial = 0;
    for (const i of tiles) {
      pool += s.map.reserve[i];
      initial += s.map.initial[i];
    }
    if (pool <= 0) {
      b.status = 'depleted';
      continue;
    }
    if (!b.enabled) {
      b.status = 'off';
      continue;
    }
    const list = net.reach.get(b.id);
    if (!list) {
      b.status = 'no_route';
      continue;
    }
    const to = list.find((r) => free(r.storage) > 1e-9);
    if (!to) {
      b.status = 'full';
      continue;
    }
    pumps.push({ b, target: to.storage, path: to.path, want: Math.min(pool / dt, rateOf(b, pool, initial)), scale: 1, bottleneck: -1, tiles });
  }
  // 2. Терминалы: ближайшее хранилище, где есть нефть.
  const terms: Flow[] = [];
  for (const b of s.buildings) {
    if (b.type !== 'terminal') continue;
    const list = net.reach.get(b.id);
    if (!b.enabled) b.status = 'off';
    else if (!list) b.status = 'no_route';
    else if (!priceOk) b.status = 'waiting_price';
    else {
      const from = list.find((r) => (r.storage.stored ?? 0) > 1e-9);
      if (!from) b.status = 'no_oil';
      else terms.push({ b, target: from.storage, path: from.path, want: levelSpec(b).value, scale: 1, bottleneck: -1 });
    }
  }
  // 3. Нагрузка труб и узкие места: каждый поток ограничен самой перегруженной трубой своего пути.
  const all = [...pumps, ...terms];
  for (const f of all) for (const t of f.path) info.demand[t] += f.want;
  for (const f of all) {
    for (const t of f.path) {
      const cap = pipeCapacity(s.map.pipes[t]);
      const k = info.demand[t] > cap ? cap / info.demand[t] : 1;
      if (k < f.scale) {
        f.scale = k;
        f.bottleneck = t;
      }
    }
  }
  // 4. Свободное место хранилища делится между качалками, которые в него качают.
  const into = new Map<Building, number>();
  for (const f of pumps) into.set(f.target, (into.get(f.target) ?? 0) + f.want * f.scale * dt);
  let produced = 0;
  for (const f of pumps) {
    const req = into.get(f.target)!;
    const sh = req > 0 ? Math.min(1, free(f.target) / req) : 1;
    const target = f.want * f.scale * sh * dt;
    const pool = f.tiles!.reduce((sum, i) => sum + s.map.reserve[i], 0);
    let got = 0;
    if (pool > 0) {
      for (const i of f.tiles!) {
        const take = Math.min(s.map.reserve[i], (target * s.map.reserve[i]) / pool);
        s.map.reserve[i] -= take;
        got += take;
      }
    }
    (f as Flow & { got: number }).got = got;
    produced += got;
    const rate = got / dt;
    for (const t of f.path) info.actual[t] += rate;
    info.pumps.set(f.b.id, { want: f.want, actual: rate, bottleneck: f.scale < 0.999 ? f.bottleneck : -1 });
    f.b.status = f.scale < 0.999 ? 'throttled' : sh < 0.999 ? 'full' : 'ok';
  }
  // Зачисление после расчёта долей — порядок качалок не влияет на результат.
  for (const f of pumps) f.target.stored = (f.target.stored ?? 0) + (f as Flow & { got: number }).got;
  // 5. Терминалы забирают нефть; если несколько тянут из одного хранилища — пропорционально.
  const outOf = new Map<Building, number>();
  for (const f of terms) outOf.set(f.target, (outOf.get(f.target) ?? 0) + f.want * f.scale * dt);
  let sold = 0;
  const taken = new Map<Building, number>();
  for (const f of terms) {
    const req = outOf.get(f.target)!;
    const sh = req > 0 ? Math.min(1, (f.target.stored ?? 0) / req) : 1;
    const amount = f.want * f.scale * sh * dt;
    taken.set(f.target, (taken.get(f.target) ?? 0) + amount);
    sold += amount;
    for (const t of f.path) info.actual[t] += amount / dt;
    f.b.status = f.scale < 0.999 ? 'throttled' : 'ok';
  }
  for (const [st, amount] of taken) st.stored = Math.max(0, (st.stored ?? 0) - amount);
  syncOil(s);
  return { produced, sold, revenue: sold * price };
}
