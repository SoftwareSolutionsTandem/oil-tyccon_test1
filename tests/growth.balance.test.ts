import { describe, expect, it } from 'vitest';
import { createNewGame, TECHS, techEffect, type GameState, type TechId } from '../src/core';
import { runBot } from './bot';

/**
 * Отчёт метрик роста (docs/M04_DESIGN.md, раздел 2; приёмка вехи 0.4 — docs/DECISIONS.md, В1).
 * Бот на картах 1–5, 120 минут, снимок раз в минуту; два прогона — без исследований (база) и с исследованиями.
 * Полный прогон долгий (~2 мин), поэтому запускается только с BALANCE_LOG=1, как и остальные отчёты баланса.
 *
 * V(a, b) — средняя добыча, барр./мин, в окне игровых минут (a, b]; G10(t) = V(t−10, t) / V(t−20, t−10) − 1;
 * R = V(80, 90) / V(30, 40) — справочно.
 */
const LOG = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BALANCE_LOG;

const SEEDS = [1, 2, 3, 4, 5];
const MINUTES = 120;
/**
 * Порог доли качалок «ограничено трубой» и допустимая длительность превышения подряд (этап 0 вехи 0.4).
 * Доля — средняя по всем шагам секунды: сеть бывает в двухшаговом колебании (на чётных шагах узкого места нет,
 * на нечётных есть), и одна проба в секунду видела бы только одну фазу.
 */
const THROTTLE_SHARE = 0.25;
const THROTTLE_MAX_RUN = 5 * 60;
/**
 * База выручки за 120 минут (бот после этапа 0 вехи 0.4, без механик 0.4) — для критерия В1 «не меньше базы +5%».
 * При изменении бота или баланса база пересчитывается этим же отчётом и обновляется здесь и в docs/M04_DESIGN.md.
 */
const BASELINE_REVENUE_120: Record<number, number> = { 1: 3_978_702, 2: 4_558_196, 3: 4_253_338, 4: 3_887_522, 5: 4_299_983 };

/** Выбор технологии ботом: момент старта, уровень, цена и оценка окупаемости на момент выбора. */
interface Pick {
  id: TechId;
  level: number;
  at: number;
  cost: number;
  /** Оценка окупаемости, с (цена / Δприбыль по опорным ценам); для «типового проекта» — null (экономия на качалке). */
  payback: number | null;
  pumpSaving: number;
}

interface Run {
  seed: number;
  research: boolean;
  /** Время целей, с. */
  reachedAt: Record<string, number>;
  picks: Pick[];
  /** Добыча по минутам, барр. (индекс m — минута (m, m+1]). */
  produced: number[];
  /** Выручка нарастающим итогом на конце минуты. */
  revenue: number[];
  /** Средняя доля качалок «ограничено трубой» по минутам. */
  throttled: number[];
  /** Самый длинный отрезок подряд с долей выше порога, с. */
  maxThrottleRun: number;
}

function runSeed(seed: number, research: boolean): Run {
  const s = createNewGame(seed);
  const picks: Pick[] = [];
  const produced: number[] = [];
  const revenue: number[] = [];
  const throttled: number[] = [];
  let lastProduced = 0;
  let secShare = 0;
  let shareSum = 0;
  let shareCount = 0;
  let run = 0;
  let maxRun = 0;
  let step = 0;
  // Выбор технологии бот делает после шага — следующий шаг видит новое активное исследование.
  let seenActive = false;
  const result = runBot(
    s,
    MINUTES,
    (_ev, st: GameState) => {
    step++;
    const a = st.research.active;
    if (a && !seenActive) {
      const level = (st.research.levels[a.id] ?? 0) + 1;
      const e = techEffect(st, a.id);
      picks.push({ id: a.id, level, at: st.time, cost: TECHS[a.id].levels[level - 1].cost, payback: a.id === 'standard' || e.profit <= 0 ? null : TECHS[a.id].levels[level - 1].cost / e.profit, pumpSaving: e.pumpSaving });
    }
    seenActive = !!a;
    // Каждый шаг: доля качалок, ограниченных трубой; раз в секунду — среднее за секунду.
    let pumps = 0;
    let thr = 0;
    for (const b of st.buildings) {
      if (b.type !== 'pumpjack') continue;
      pumps++;
      if (b.status === 'throttled') thr++;
    }
    secShare += pumps ? thr / pumps : 0;
    if (step % 10 === 0) {
      const share = secShare / 10;
      secShare = 0;
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
    },
    { research, loans: research, managers: research },
  );
  return { seed, research, reachedAt: result.reachedAt, picks, produced, revenue, throttled, maxThrottleRun: maxRun };
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
    'бот на пяти картах, 120 минут: без механик 0.4 и с ними',
    async () => {
      const windows = Array.from({ length: MINUTES / 10 }, (_, i) => [i * 10, i * 10 + 10] as const);
      const gAt = windows.slice(2).map(([, b]) => b);
      const out: string[] = [];
      const all: Run[][] = [];
      for (const research of [false, true]) {
        const runs: Run[] = [];
        for (const seed of SEEDS) {
          runs.push(runSeed(seed, research));
          // Прогон карты занимает секунды — отдаём управление, чтобы воркер vitest не терял связь.
          await new Promise((r) => setTimeout(r, 0));
        }
        all.push(runs);
        out.push(`\n## ${research ? 'Механики 0.4: исследования, кредит, персонал' : 'База: без механик 0.4'}\n`);
        out.push('V по окнам, барр./мин:');
        out.push(table(['Карта', ...windows.map(([a, b]) => `${a}–${b}`)], runs.map((r) => [String(r.seed), ...windows.map(([a, b]) => num(V(r, a, b)))])));
        out.push('\nG10 — темп роста добычи за 10 минут (окно, которым заканчивается период):');
        out.push(table(['Карта', ...gAt.map(String)], runs.map((r) => [String(r.seed), ...gAt.map((t) => pct(G10(r, t)))])));
        out.push('\nИтог и критерии В1 (Временно): V(110,120) ≥ 0,95·V(80,90), G10(90) ≥ 0, выручка за 120 мин ≥ база +5% — каждое на 4 картах из 5. База выручки — этап 0:');
        out.push(
          table(
            ['Карта', 'V(30,40)', 'V(80,90)', 'R (справочно)', 'V(110,120)/V(80,90)', 'G10(90)', 'Выручка 60 мин', 'Выручка 90 мин', 'Выручка 120 мин', 'к базе этапа 0'],
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
      }

      const [base, res] = all;
      const min = (v: number | undefined) => (v === undefined ? '—' : (v / 60).toFixed(1).replace('.', ','));
      out.push('\n## Сравнение\n');
      out.push(
        table(
          ['Карта', '«Инженерный центр», мин', '«Переработка» без / с исследованиями, мин', 'Δ «Переработки»', 'Выручка 120 мин без / с'],
          SEEDS.map((seed, i) => {
            const a = base[i].reachedAt.refining;
            const b = res[i].reachedAt.refining;
            return [String(seed), min(res[i].reachedAt.engineering), `${min(a)} / ${min(b)}`, a && b ? pct(b / a - 1) : '—', `${num(base[i].revenue[119])} / ${num(res[i].revenue[119])}`];
          }),
        ),
      );
      out.push('\nВыбор технологий ботом (минута старта, уровень; оценка окупаемости на момент выбора или экономия на качалке):');
      for (const r of res)
        out.push(
          `${r.seed}: ` +
            r.picks
              .map((p) => `${(p.at / 60).toFixed(1)} ${p.id}${p.level} (${p.payback !== null ? `${(p.payback / 60).toFixed(0)} мин` : `−${num(p.pumpSaving)} $ на качалке`})`)
              .join(' → '),
        );
      console.log(out.join('\n'));

      // Критерий этапа 0: бот не застревает с перегруженными трубами — и без исследований, и с ними.
      for (const r of [...base, ...res]) expect(r.maxThrottleRun).toBeLessThanOrEqual(THROTTLE_MAX_RUN);
    },
    900_000,
  );
});
