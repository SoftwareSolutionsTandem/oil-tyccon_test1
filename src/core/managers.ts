import { MANAGERS } from './config';
import { upgrade } from './actions';
import {
  heavySpread,
  levelSpec,
  nominalRate,
  oilByGrade,
  productPrice,
  pumpGrade,
  pumpRate,
  referencePrice,
  refineryProductCap,
  storageCapacity,
  upgradeCost,
  upkeepFactor,
} from './economy';
import type { GameState } from './types';

/**
 * Менеджеры (веха 0.4, M04_DESIGN §6): решения внутри tick, раз в MANAGERS.period секунд игрового времени —
 * на границе периода, поэтому моменты решений совпадают при шаге 0,1 с и 1 с (офлайн). Решения — по состоянию,
 * в фиксированном порядке (по окупаемости, затем по id), деньги тратятся только через действия игрока (upgrade).
 */
export function managersSalary(s: GameState): number {
  return (s.managers.dispatcher ? MANAGERS.dispatcher.salary : 0) + (s.managers.mechanic ? MANAGERS.mechanic.salary : 0);
}

export function managersStep(s: GameState, dt: number): void {
  const p = MANAGERS.period;
  if (Math.floor((s.time + 1e-9) / p) === Math.floor((s.time - dt + 1e-9) / p)) return;
  if (s.managers.dispatcher) dispatch(s);
  if (s.managers.mechanic) mechanic(s);
}

/** Средняя цена лёгкой нефти за окно диспетчера (по истории рынка). */
function averagePrice(s: GameState): number {
  const n = Math.max(1, Math.round(MANAGERS.dispatcher.avgWindow / 2));
  const h = s.market.history.slice(-n);
  return h.length ? h.reduce((a, v) => a + v, 0) / h.length : s.market.price;
}

/** Порог с надбавкой, которая сходит на нет по мере заполнения складов; от fullFill — 0 (продавать всё). */
function threshold(ref: number, fill: number): number {
  const d = MANAGERS.dispatcher;
  return fill >= d.fullFill ? 0 : Math.round(ref * (1 + d.premium * (1 - fill / d.fullFill)));
}

/**
 * Диспетчер сбыта. Порог нефти — по самому дешёвому сорту из имеющихся (решение В6): порог один на оба сорта,
 * и порог по лёгкой держал бы тяжёлую. Пороги продуктов — от базовых цен продуктов при средней цене нефти.
 */
function dispatch(s: GameState): void {
  const avg = averagePrice(s);
  const [, heavy] = oilByGrade(s);
  const ref = heavy > 1e-6 ? avg * (1 - heavySpread(s)) : avg;
  const cap = storageCapacity(s);
  s.sellThreshold = threshold(ref, cap > 0 ? s.oil / cap : 1);
  const refs = s.buildings.filter((b) => b.type === 'refinery' && b.products);
  for (let i = 0; i < 3; i++) {
    let stock = 0;
    let room = 0;
    for (const r of refs) {
      stock += r.products![i];
      room += refineryProductCap(r);
    }
    s.productThresholds[i] = threshold(productPrice(s, i, s.time, avg, false), room > 0 ? stock / room : 1);
  }
}

/**
 * Главный механик: улучшает качалку с наименьшей окупаемостью (цена улучшения / прирост прибыли в секунду по
 * опорным ценам с учётом истощения зоны), если окупаемость не дольше MANAGERS.mechanic.payback и после покупки
 * в кассе остаётся резерв. Одно улучшение за решение.
 */
function mechanic(s: GameState): void {
  let best: { id: number; payback: number; cost: number } | null = null;
  for (const b of s.buildings) {
    if (b.type !== 'pumpjack' || !b.enabled) continue;
    const cost = upgradeCost(b);
    if (cost === null) continue;
    const nom = nominalRate(s, b);
    const rate = pumpRate(s, b);
    if (nom <= 0 || rate <= 0) continue;
    const next = { ...b, level: b.level + 1 };
    const gain = (nominalRate(s, next) - nom) * (rate / nom) * referencePrice(pumpGrade(s, b)) - (levelSpec(next).upkeep - levelSpec(b).upkeep) * upkeepFactor(s);
    if (gain <= 0) continue;
    const payback = cost / gain;
    if (payback > MANAGERS.mechanic.payback) continue;
    if (!best || payback < best.payback || (payback === best.payback && b.id < best.id)) best = { id: b.id, payback, cost };
  }
  if (best && s.cash - best.cost >= s.managers.reserve) upgrade(s, best.id);
}
