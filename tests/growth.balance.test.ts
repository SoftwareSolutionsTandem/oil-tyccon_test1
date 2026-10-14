import { describe, expect, it } from 'vitest';
import { createNewGame, type GameState } from '../src/core';
import { runBot } from './bot';

/**
 * Отчёт метрик роста (docs/M04_DESIGN.md, раздел 2; приёмка вехи 0.4 — docs/DECISIONS.md, В1).
 * Бот на картах 1–5, 120 минут, снимок раз в минуту. Полный прогон долгий (~1 мин), поэтому запускается
 * только с BALANCE_LOG=1, как и остальные отчёты баланса.
 *
 * V(a, b) — средняя добыча, барр./мин, в окне игровых минут (a, b]; G10(t) = V(t−10, t) / V(t−20, t−10) − 1;
 * R = V(80, 90) / V(30, 40) — справочно.
 */
const LOG = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BALANCE_LOG;

const SEEDS = [1, 2, 3, 4, 5];
const MINUTES = 120;
/** Порог доли качалок «ограничено трубой» и допустимая длительность превышения подряд (этап 0 вехи 0.4). */
const THROTTLE_SHARE = 0.25;
const THROTTLE_MAX_RUN = 5 * 60;
/**
 * База выручки за 120 минут (бот после этапа 0 вехи 0.4, без механик 0.4) — для критерия В1 «не меньше базы +5%».
 * При изменении бота или баланса база пересчитывается этим же отчётом и обновляется здесь и в docs/M04_DESIGN.md.
 */
const BASELINE_REVENUE_120: Record<number, number> = { 1: 3_978_702, 2: 4_558_196, 3: 4_253_338, 4: 3_887_522, 5: 4_299_983 };

interface Run {
  seed: number;
  /** Добыча по минутам, барр. (индекс m — минута (m, m+1]). */
  produced: number[];
  /** Выручка нарастающим итогом на конце минуты. */
  revenue: number[];
  /** Средняя доля качалок «ограничено трубой» по минутам. */
  throttled: number[];
  /** Самый длинный отрезок подряд с долей выше порога, с. */
  maxThrottleRun: number;
}

function runSeed(seed: number): Run {
  const s = createNewGame(seed);
  const produced: number[] = [];
  const revenue: number[] = [];
  const throttled: number[] = [];
  let lastProduced = 0;
  let shareSum = 0;
  let shareCount = 0;
  let run = 0;
  let maxRun = 0;
  let step = 0;
  runBot(s, MINUTES, (_ev, st: GameState) => {
    step++;
    // Раз в секунду: доля качалок, ограниченных трубой.
    if (step % 10 === 0) {
      let pumps = 0;
      let thr = 0;
      for (const b of st.buildings) {
        if (b.type !== 'pumpjack') continue;
        pumps++;
        if (b.status === 'throttled') thr++;
      }
      const share = pumps ? thr / pumps : 0;
      shareSum += share;
      shareCount++;
      run = share > THROTTLE_SHARE ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }
    // Раз в минуту: снимок.
    if (step % 600 === 0) {
      produced.push(st.totals.produced - lastProduced);
      lastProduced = st.totals.produced;
      revenue.push(st.totals.revenue);
      throttled.push(shareCount ? shareSum / shareCount : 0);
      shareSum = 0;
      shareCount = 0;
    }
  });
  return { seed, produced, revenue, throttled, maxThrottleRun: maxRun };
}

/** Среднее по минутам окна (a, b]. */
const V = (r: Run, a: number, b: number) => r.produced.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
const G10 = (r: Run, t: number) => V(r, t - 10, t) / V(r, t - 20, t - 10) - 1;
const num = (v: number) => Math.round(v).toLocaleString('ru-RU');
const pct = (v: number) => {
  const s = Math.abs(v * 100).toFixed(1);
  return `${s === '0.0' ? '' : v >= 0 ? '+' : '−'}${s.replace('.', ',')}%`;
};
const dec = (v: number) => v.toFixed(2).replace('.', ',');
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

describe('метрики роста (отчёт вехи 0.4)', () => {
  it.skipIf(!LOG)(
    'бот на пяти картах, 120 минут',
    () => {
      const runs = SEEDS.map(runSeed);
      const windows = Array.from({ length: MINUTES / 10 }, (_, i) => [i * 10, i * 10 + 10] as const);
      const out: string[] = [];

      out.push('V по окнам, барр./мин:');
      out.push(table(['Карта', ...windows.map(([a, b]) => `${a}–${b}`)], runs.map((r) => [String(r.seed), ...windows.map(([a, b]) => num(V(r, a, b)))])));

      const gAt = windows.slice(2).map(([, b]) => b);
      out.push('\nG10 — темп роста добычи за 10 минут (окно, которым заканчивается период):');
      out.push(table(['Карта', ...gAt.map(String)], runs.map((r) => [String(r.seed), ...gAt.map((t) => pct(G10(r, t)))])));

      out.push('\nИтог и критерии В1 (Временно): V(110,120) ≥ 0,95·V(80,90), G10(90) ≥ 0, выручка за 120 мин ≥ база +5% — каждое на 4 картах из 5:');
      out.push(
        table(
          ['Карта', 'V(30,40)', 'V(80,90)', 'R (справочно)', 'V(110,120)/V(80,90)', 'G10(90)', 'Выручка 60 мин', 'Выручка 90 мин', 'Выручка 120 мин', 'к базе'],
          runs.map((r) => [
            String(r.seed),
            num(V(r, 30, 40)),
            num(V(r, 80, 90)),
            dec(V(r, 80, 90) / V(r, 30, 40)),
            dec(V(r, 110, 120) / V(r, 80, 90)),
            pct(G10(r, 90)),
            num(r.revenue[59]),
            num(r.revenue[89]),
            num(r.revenue[119]),
            pct(r.revenue[119] / BASELINE_REVENUE_120[r.seed] - 1),
          ]),
        ),
      );
      const ok = (f: (r: Run) => boolean) => runs.filter(f).length;
      out.push(
        `Выполнено на картах: V(110,120) ≥ 0,95·V(80,90) — ${ok((r) => V(r, 110, 120) >= 0.95 * V(r, 80, 90))} из 5; ` +
          `G10(90) ≥ 0 — ${ok((r) => G10(r, 90) >= 0)} из 5; выручка ≥ база +5% — ${ok((r) => r.revenue[119] >= BASELINE_REVENUE_120[r.seed] * 1.05)} из 5.`,
      );

      out.push(`\nДоля качалок «ограничено трубой» (средняя по окну) и самый длинный отрезок подряд с долей > ${THROTTLE_SHARE * 100}%:`);
      out.push(
        table(
          ['Карта', ...windows.map(([a, b]) => `${a}–${b}`), 'Макс. подряд, мин'],
          runs.map((r) => [
            String(r.seed),
            ...windows.map(([a, b]) => `${Math.round((r.throttled.slice(a, b).reduce((x, y) => x + y, 0) / (b - a)) * 100)}%`),
            dec(r.maxThrottleRun / 60),
          ]),
        ),
      );
      console.log(out.join('\n'));

      // Критерий этапа 0: бот не застревает с перегруженными трубами.
      for (const r of runs) expect(r.maxThrottleRun).toBeLessThanOrEqual(THROTTLE_MAX_RUN);
    },
    600_000,
  );
});
