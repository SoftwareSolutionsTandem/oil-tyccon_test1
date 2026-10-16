import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, averageProfit, checkAchievements, createNewGame, currentObjective, OBJECTIVES } from '../src/core';
import { runBot } from './bot';

/**
 * Отчёт M06-GOALS: бот с регионами на картах 1–5, 240 минут — минута каждой цели продолжения цепочки и ступеней,
 * отношение награды к средней прибыли за 5 минут в момент цели, проверка «у игрока всегда есть цель».
 * Долгий (~10 мин), поэтому только с BALANCE_LOG=1.
 */
const LOG = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BALANCE_LOG;
const SEEDS = [1, 2, 3, 4, 5];
const MINUTES = 240;
const CHUNK = 10;
/** Первая цель продолжения (после «Выхода на шельф»). */
const FIRST_NEW = OBJECTIVES.findIndex((o) => o.id === 'shelf') + 1;

describe.skipIf(!LOG)('отчёт: цели продолжения и ступени (M06)', () => {
  it('бот проходит цепочку по порядку; цель есть в каждую минуту', async () => {
    const table = new Map<string, string[]>();
    const lines: string[] = [];
    for (const seed of SEEDS) {
      const s = createNewGame(seed);
      const at: Record<string, string> = {};
      let lastMinute = -1;
      let withoutGoal = 0;
      const onTick: Parameters<typeof runBot>[2] = (ev, st) => {
        for (const o of ev.completed) {
          const p5 = averageProfit(st, 5);
          at[o.id] = `${(st.time / 60).toFixed(0)} (${p5 > 0 ? (o.reward / p5).toFixed(1) : '—'})`;
        }
        const m = Math.floor(st.time / 60);
        if (m !== lastMinute) {
          lastMinute = m;
          if (!currentObjective(st)) withoutGoal++;
          checkAchievements(st); // как игра после шага (раз в минуту достаточно для отчёта)
        }
      };
      // Кусками по 10 минут с отдачей управления: долгий синхронный прогон блокирует воркер vitest (таймаут RPC).
      // 10 мин = 6000 шагов — кратно периоду решений бота (10 шагов), поэтому прогон тот же, что одним вызовом.
      for (let m = 0; m < MINUTES; m += CHUNK) {
        runBot(s, CHUNK, onTick, { regions: true });
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(withoutGoal).toBe(0);
      const ids = [...OBJECTIVES.slice(FIRST_NEW - 2).map((o) => o.id), ...Array.from({ length: 4 }, (_, i) => `stage_${i + 1}`)];
      for (const id of ids) {
        if (!table.has(id)) table.set(id, []);
        table.get(id)!.push(at[id] ?? '—');
      }
      lines.push(`карта ${seed}: к ${MINUTES}-й мин — цель «${currentObjective(s).title}», ступеней ${s.stage}, достижений ${s.achievements.length}/${ACHIEVEMENTS.length}`);
    }
    console.log(`\nM06: минута цели (награда / средняя прибыль за 5 мин), карты ${SEEDS.join(', ')}, ${MINUTES} мин`);
    for (const [id, cells] of table) console.log(`${id.padEnd(16)} ${cells.map((c) => c.padEnd(12)).join('')}`);
    for (const l of lines) console.log(l);
  }, 1_800_000);
});
