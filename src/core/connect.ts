import { layPipes, planAutoConnect, planPipes, type PipeTile } from './actions';
import { PIPES } from './config';
import { levelSpec, pumpRate } from './economy';
import { getNetwork, lastFlow, pipeCapacity, stepLogistics, syncOil, type FlowInfo } from './network';
import type { ActionResult, Building, GameState } from './types';
import { buildingAt, getBuilding, inBounds, isTileOwned } from './world';

/**
 * Подключение с учётом загрузки сети.
 *
 * Кратчайшая труба (planAutoConnect) бесплатно переиспользует существующие трубы — и может привести новую
 * качалку в уже перегруженный участок. Здесь варианты подключения сравниваются по тому, сколько нефти реально
 * пройдёт: каждый вариант пробно применяется к копии состояния и считается тот же поток, что и в игре
 * (stepLogistics), при наполовину заполненных хранилищах — чтобы мерить именно трубы, а не склад.
 * Пропускная способность нигде не увеличивается скрыто: альтернативная ветка — это обычные трубы за обычную цену.
 */

export interface ConnectOption {
  /** 'short' — кратчайшая труба, 'branch' — отдельная ветка в обход перегруженных труб. */
  kind: 'short' | 'branch';
  /** Тип новых труб. */
  pipe: 1 | 2;
  /** Новые клетки трубы. */
  tiles: PipeTile[];
  /** Клетки промысловой трубы, которые заменяются магистралью. */
  upgrades: PipeTile[];
  cost: number;
  ok: boolean;
  reason?: string;
  /** Желаемый и ожидаемый поток здания после подключения, барр./с. */
  want: number;
  predicted: number;
  /** Ожидаемая суммарная добыча всех качалок после подключения, барр./с. */
  total: number;
}

/** К скольким ближайшим хранилищам пробовать отдельную ветку. */
const BRANCH_TARGETS = 4;

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Поток здания, к которому стремится подключение: добыча качалки или отгрузка терминала. */
function wantOf(s: GameState, b: Building): number {
  return b.type === 'pumpjack' ? pumpRate(s, b) : b.type === 'terminal' ? levelSpec(b).value : 0;
}

/** Пробный поток на копии состояния (меряем трубы, а не заполненность склада). Само состояние не меняется. */
export function trialFlow(s: GameState, tiles: PipeTile[] = [], pipe: 1 | 2 = 1, upgrades: PipeTile[] = []): FlowInfo {
  const copy: GameState = structuredClone(s);
  const n = copy.map.size;
  for (const [x, y] of tiles) copy.map.pipes[y * n + x] = Math.max(copy.map.pipes[y * n + x], pipe);
  for (const [x, y] of upgrades) copy.map.pipes[y * n + x] = 2;
  // Хранилища наполовину полны: у качалок есть куда качать, у терминалов — что забирать. Так проба меряет
  // установившийся режим работающего промысла, где отгрузка и добыча делят одни и те же трубы.
  for (const b of copy.buildings) if (b.type === 'hq' || b.type === 'tank') b.stored = levelSpec(b).value / 2;
  copy.sellThreshold = 0;
  syncOil(copy);
  stepLogistics(copy, 1);
  return lastFlow(copy)!;
}

function sumPumps(s: GameState, f: FlowInfo): number {
  let total = 0;
  for (const b of s.buildings) if (b.type === 'pumpjack') total += f.clients.get(b.id)?.actual ?? 0;
  return total;
}

/**
 * Отдельная ветка: путь минимальной цены от здания до заданного хранилища, где существующие трубы используются бесплатно,
 * только если у них хватает свободной пропускной способности; перегруженную промысловую трубу можно заменить
 * магистралью, если магистраль справится. Новые клетки рядом с перегруженными трубами дороже: ветка слилась бы
 * с ними, и нефть могла бы пойти прежним путём (это проверит пробный расчёт).
 */
function planBranch(s: GameState, b: Building, base: FlowInfo, pipe: 1 | 2, target: Building): { tiles: PipeTile[]; upgrades: PipeTile[] } | null {
  const n = s.map.size;
  const want = wantOf(s, b);
  if (want <= 0) return null;
  const spare = (i: number, kind = s.map.pipes[i]) => pipeCapacity(kind) - base.actual[i];
  const congested = (i: number) => s.map.pipes[i] > 0 && spare(i) < want - 1e-9;
  const passable = (x: number, y: number) => inBounds(s, x, y) && isTileOwned(s, x, y) && !buildingAt(s, x, y);
  const nearCongested = (x: number, y: number) =>
    SIDES.some(([dx, dy]) => inBounds(s, x + dx, y + dy) && congested((y + dy) * n + x + dx));
  // Цена шага в единицах «клетка новой трубы»: своя свободная труба почти бесплатна, замена — по разнице цен.
  const unit = PIPES[pipe].cost;
  const stepCost = (i: number, x: number, y: number): number => {
    const have = s.map.pipes[i];
    if (have > 0) {
      if (!congested(i)) return 0.01;
      if (have === 1 && spare(i, 2) >= want) return (PIPES[2].cost - PIPES[1].cost) / unit;
      return Infinity;
    }
    // Рядом с перегруженной трубой можно, но дороже: такая клетка сольётся с ней в одну сеть.
    return nearCongested(x, y) ? 4 : 1;
  };
  const isTarget = (x: number, y: number) => Math.abs(x - target.x) + Math.abs(y - target.y) === 1;

  // Дейкстра по клеткам (карта небольшая — хватает линейного выбора минимума из списка открытых).
  const dist = new Float64Array(n * n).fill(Infinity);
  const prev = new Int32Array(n * n).fill(-1);
  const open: number[] = [];
  for (const [dx, dy] of SIDES) {
    const x = b.x + dx;
    const y = b.y + dy;
    if (!passable(x, y)) continue;
    const i = y * n + x;
    const c = stepCost(i, x, y);
    if (c < dist[i]) {
      dist[i] = c;
      open.push(i);
    }
  }
  const done = new Uint8Array(n * n);
  let found = -1;
  while (open.length) {
    let k = 0;
    for (let j = 1; j < open.length; j++) if (dist[open[j]] < dist[open[k]] || (dist[open[j]] === dist[open[k]] && open[j] < open[k])) k = j;
    const i = open[k];
    open.splice(k, 1);
    if (done[i]) continue;
    done[i] = 1;
    const x = i % n;
    const y = (i - x) / n;
    if (isTarget(x, y)) {
      found = i;
      break;
    }
    for (const [dx, dy] of SIDES) {
      const nx = x + dx;
      const ny = y + dy;
      if (!passable(nx, ny)) continue;
      const j = ny * n + nx;
      if (done[j]) continue;
      const d = dist[i] + stepCost(j, nx, ny);
      if (d < dist[j]) {
        dist[j] = d;
        prev[j] = i;
        open.push(j);
      }
    }
  }
  if (found < 0) return null;
  const tiles: PipeTile[] = [];
  const upgrades: PipeTile[] = [];
  for (let t = found; t >= 0; t = prev[t]) {
    const p: PipeTile = [t % n, Math.floor(t / n)];
    if (s.map.pipes[t] === 0) tiles.push(p);
    else if (congested(t)) upgrades.push(p);
  }
  if (tiles.length === 0 && upgrades.length === 0) return null;
  return { tiles, upgrades };
}

function costOf(s: GameState, tiles: PipeTile[], pipe: 1 | 2, upgrades: PipeTile[]): { cost: number; ok: boolean; reason?: string } {
  const a = tiles.length ? planPipes(s, tiles, pipe) : { cost: 0, ok: true, reason: undefined, tiles: [] };
  const b = upgrades.length ? planPipes(s, upgrades, 2) : { cost: 0, ok: true, reason: undefined, tiles: [] };
  const cost = a.cost + b.cost;
  const ok = s.cash >= cost && (a.ok || a.reason === 'Недостаточно денег') && (b.ok || b.reason === 'Недостаточно денег');
  return { cost, ok, reason: ok ? undefined : s.cash < cost ? 'Недостаточно денег' : a.reason ?? b.reason };
}

const cache = new WeakMap<GameState, Map<string, ConnectOption[]>>();

/**
 * Варианты подключения здания (качалки или терминала): кратчайший — если здание не подключено, и отдельная
 * ветка — если она даёт заметно больший поток. Для уже подключённой ограниченной трубой качалки это способ
 * разгрузить её маршрут. Пробные расчёты кешируются до изменения сети; цена и «хватает ли денег» — всегда свежие.
 */
export function connectOptions(s: GameState, id: number, pipe: 1 | 2 = 1): ConnectOption[] {
  const b = getBuilding(s, id);
  if (!b || (b.type !== 'pumpjack' && b.type !== 'terminal')) return [];
  const key = `${getNetwork(s).sig}:${id}:${pipe}`;
  let byState = cache.get(s);
  if (!byState) cache.set(s, (byState = new Map()));
  let raw = byState.get(key);
  if (!raw) {
    if (byState.size > 32) byState.clear();
    raw = computeOptions(s, b, pipe);
    byState.set(key, raw);
  }
  return raw.map((o) => ({ ...o, ...costOf(s, o.tiles, o.pipe, o.upgrades) }));
}

function computeOptions(s: GameState, b: Building, pipe: 1 | 2): ConnectOption[] {
  const id = b.id;
  const want = wantOf(s, b);
  const base = trialFlow(s);
  const now = base.clients.get(id)?.actual ?? 0;
  const out: ConnectOption[] = [];
  const evaluate = (kind: ConnectOption['kind'], tiles: PipeTile[], upgrades: PipeTile[]): ConnectOption => {
    const f = trialFlow(s, tiles, pipe, upgrades);
    return { kind, pipe, tiles, upgrades, ...costOf(s, tiles, pipe, upgrades), want, predicted: f.clients.get(id)?.actual ?? 0, total: sumPumps(s, f) };
  };
  const short = planAutoConnect({ ...s, cash: Infinity }, id, pipe);
  if (short.tiles.length) out.push(evaluate('short', short.tiles, []));
  // Отдельные ветки к нескольким ближайшим хранилищам; лучшая по пробному потоку (при равенстве — дешевле).
  const storages = s.buildings
    .filter((o) => o.type === 'hq' || o.type === 'tank')
    .sort((p, q) => Math.abs(p.x - b.x) + Math.abs(p.y - b.y) - (Math.abs(q.x - b.x) + Math.abs(q.y - b.y)) || p.id - q.id)
    .slice(0, BRANCH_TARGETS);
  let best: ConnectOption | null = null;
  const seen = new Set<string>();
  for (const st of storages) {
    const branch = planBranch(s, b, base, pipe, st);
    if (!branch) continue;
    const sig = [...branch.tiles, ...branch.upgrades].map((p) => p.join(',')).sort().join(';');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const opt = evaluate('branch', branch.tiles, branch.upgrades);
    if (!best || opt.predicted > best.predicted + 1e-6 || (Math.abs(opt.predicted - best.predicted) <= 1e-6 && opt.cost < best.cost)) best = opt;
  }
  if (best) {
    const ref = out[0]?.predicted ?? now;
    // Ветка предлагается, только если реально даёт больше нефти и не отнимает её у других качалок.
    const refTotal = out[0]?.total ?? sumPumps(s, base);
    if (best.predicted > ref + Math.max(0.02, want * 0.05) && best.total >= refTotal - 1e-6) out.push(best);
  }
  return out;
}

export function applyConnect(s: GameState, opt: ConnectOption): ActionResult {
  const check = costOf(s, opt.tiles, opt.pipe, opt.upgrades);
  if (!check.ok) return { ok: false, reason: check.reason ?? 'Нельзя проложить' };
  if (opt.upgrades.length) {
    const r = layPipes(s, opt.upgrades, 2);
    if (!r.ok) return r;
  }
  if (opt.tiles.length) return layPipes(s, opt.tiles, opt.pipe);
  return { ok: true };
}

/** Подключение с наибольшим ожидаемым потоком (при равенстве — более дешёвое). */
export function bestConnect(s: GameState, id: number, pipe: 1 | 2 = 1): ConnectOption | null {
  const opts = connectOptions(s, id, pipe).filter((o) => o.ok);
  if (!opts.length) return null;
  return opts.reduce((a, o) => (o.predicted > a.predicted + 1e-6 || (Math.abs(o.predicted - a.predicted) <= 1e-6 && o.cost < a.cost) ? o : a));
}

export function autoConnectBest(s: GameState, id: number, pipe: 1 | 2 = 1): ActionResult {
  const opt = bestConnect(s, id, pipe);
  if (!opt) return { ok: false, reason: 'Нет подходящего маршрута' };
  return applyConnect(s, opt);
}
