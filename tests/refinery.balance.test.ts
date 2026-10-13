import { describe, expect, it } from 'vitest';
import { buildingUpkeep, createNewGame, syncOil, type GameState } from '../src/core';
import { runBot } from './bot';

/**
 * Баланс-прогон НПЗ (раздел 11.1 плана): бот на картах 1–5, отчёт на 60-й и 90-й минуте.
 * Метрики считает этот обвес по данным каждого шага; в GameState для них ничего не добавляется.
 * Полный прогон долгий, поэтому запускается с BALANCE_LOG=1 (как и отчёт основного баланс-теста).
 */
const LOG = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BALANCE_LOG;

interface Metrics {
  seed: number;
  minute: number;
  cash: number;
  minCash: number;
  crudeRevenue: number;
  productRevenue: number;
  refined: number;
  refinedByGrade: [number, number];
  builtAt: number | null;
  level: number;
  utilization: number | null;
  idle: Record<string, number>;
  stock: [number, number, number];
  paybackMin: number | null;
}

function runSeed(seed: number): Metrics[] {
  const s = createNewGame(seed);
  let builtAt: number | null = null;
  let capTime = 0; // Σ мощность · время с постройки
  let net = 0; // накопленный чистый результат НПЗ
  let paybackAt: number | null = null;
  const idle: Record<string, number> = { ok: 0, throttled: 0, waiting_margin: 0, product_full: 0, logistics: 0 };
  const refinedByGrade: [number, number] = [0, 0];
  let minCash = s.cash;
  const out: Metrics[] = [];
  const snapshot = (minute: number): Metrics => {
    const refs = s.buildings.filter((b) => b.type === 'refinery');
    const stock: [number, number, number] = [0, 0, 0];
    for (const r of refs) for (let i = 0; i < 3; i++) stock[i] += r.products![i];
    const total = Object.values(idle).reduce((a, v) => a + v, 0);
    const share: Record<string, number> = {};
    for (const k of Object.keys(idle)) share[k] = total > 0 ? idle[k] / total : 0;
    return {
      seed,
      minute,
      cash: s.cash,
      minCash,
      crudeRevenue: s.totals.revenue - s.totals.productRevenue,
      productRevenue: s.totals.productRevenue,
      refined: s.totals.refined,
      refinedByGrade: [...refinedByGrade] as [number, number],
      builtAt,
      level: refs[0]?.level ?? 0,
      utilization: capTime > 0 ? s.totals.refined / capTime : null,
      idle: share,
      stock,
      paybackMin: paybackAt !== null && builtAt !== null ? (paybackAt - builtAt) / 60 : null,
    };
  };
  const onTick = (ev: { refinedByGrade: [number, number]; refinedValue: number; productRevenue: number }, st: GameState) => {
    minCash = Math.min(minCash, st.cash);
    const refs = st.buildings.filter((b) => b.type === 'refinery');
    if (refs.length && builtAt === null) builtAt = st.time;
    if (!refs.length) return;
    const dt = 0.1;
    refinedByGrade[0] += ev.refinedByGrade[0];
    refinedByGrade[1] += ev.refinedByGrade[1];
    let invested = 0;
    for (const r of refs) {
      capTime += (r.level === 1 ? 2 : r.level === 2 ? 4.5 : 9) * dt;
      invested += r.invested;
      net -= buildingUpkeep(r) * dt;
      // ok — работает (в том числе неполно из-за нехватки нефти), throttled — работает, но труба ограничивает,
      // logistics — стоит: нет сырья в досягаемости или нет пути; waiting_margin, product_full — стоит по своей причине.
      const k = r.status === 'ok' || r.status === 'throttled' || r.status === 'waiting_margin' || r.status === 'product_full' ? r.status : 'logistics';
      idle[k] += dt;
    }
    net += ev.productRevenue - ev.refinedValue;
    if (paybackAt === null && net >= invested) paybackAt = st.time;
  };
  runBot(s, 60, onTick);
  out.push(snapshot(60));
  runBot(s, 30, onTick);
  out.push(snapshot(90));
  syncOil(s);
  return out;
}

describe('баланс НПЗ (отчёт раздела 11.1)', () => {
  it.skipIf(!LOG)('бот на пяти картах, 60 и 90 минут', () => {
    const rows: Metrics[] = [];
    for (const seed of [1, 2, 3, 4, 5]) rows.push(...runSeed(seed));
    const f = (v: number) => Math.round(v).toLocaleString('ru-RU');
    const p = (v: number) => `${Math.round(v * 100)}%`;
    console.log(
      'карта | мин | касса (мин.) | выручка нефть | выручка продукты | переработано (лёгк./тяж.) | НПЗ с мин, ур. | загрузка | работа / ограничен трубой | простой: маржа / склад / логистика | остатки Б/Д/М | окупаемость\n' +
        rows
          .map(
            (r) =>
              `${r.seed} | ${r.minute} | ${f(r.cash)} (${f(r.minCash)}) | ${f(r.crudeRevenue)} | ${f(r.productRevenue)} | ${f(r.refined)} (${f(r.refinedByGrade[0])}/${f(r.refinedByGrade[1])}) | ${r.builtAt !== null ? (r.builtAt / 60).toFixed(1) : '—'}, ${r.level || '—'} | ${r.utilization !== null ? p(r.utilization) : '—'} | ${p(r.idle.ok)} / ${p(r.idle.throttled)} | ${p(r.idle.waiting_margin)} / ${p(r.idle.product_full)} / ${p(r.idle.logistics)} | ${r.stock.map(f).join('/')} | ${r.paybackMin !== null ? r.paybackMin.toFixed(1) + ' мин' : 'не достигнута'}`,
          )
          .join('\n'),
    );
    for (const r of rows) {
      expect(r.minCash).toBeGreaterThan(-2000);
      for (const v of r.stock) expect(v).toBeGreaterThanOrEqual(0);
    }
  }, 600_000);
});
