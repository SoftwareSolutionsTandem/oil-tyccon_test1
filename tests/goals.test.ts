import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  checkAchievements,
  checkObjectives,
  companyRank,
  createNewGame,
  currentObjective,
  deserialize,
  OBJECTIVES,
  serialize,
  stageObjective,
  stageReward,
  stageTarget,
  START_CASH,
  STAGES,
  tick,
  TICK,
  type GameState,
} from '../src/core';

/** Денежный инвариант (награды целей и ступеней — в totals.rewards). */
function expectBalanced(s: GameState, start = START_CASH) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed + t.adRewards - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

/** Цепочка до M06 — номера, id и награды не меняются (правило задачи M06-GOALS). */
const OLD_CHAIN: Array<[string, number]> = [
  ['first_pump', 150], ['connect', 150], ['first_sales', 300], ['storage', 200], ['revenue_8k', 500], ['terminal', 800],
  ['land', 1000], ['upgrade', 800], ['pumps_10', 3000], ['profit_6k', 5000], ['credit', 2000], ['engineering', 3000],
  ['refining', 5000], ['staff', 5000], ['cash_500k', 0], ['desert', 10_000], ['shelf', 10_000],
];
const NEW_START = OLD_CHAIN.length;

/** Здание без постройки (условия целей считаются по списку зданий). */
function put(s: GameState, type: GameState['buildings'][number]['type'], level: number, x = 0, y = 0): void {
  s.buildings.push({ id: s.nextId++, type, x, y, level, enabled: true, invested: 0, status: 'ok' });
}

/** Игрок прошёл всю старую цепочку: дальше — первая новая цель. */
function afterOldChain(seed = 3): GameState {
  const s = createNewGame(seed);
  s.objectiveIndex = NEW_START;
  return s;
}

describe('цепочка целей M06: продолжение после «Выхода на шельф»', () => {
  it('старые 17 целей не тронуты; новые 12–15 — в конце, id уникальны, у каждой награда', () => {
    expect(OBJECTIVES.slice(0, NEW_START).map((o) => [o.id, o.reward])).toEqual(OLD_CHAIN);
    const added = OBJECTIVES.slice(NEW_START);
    expect(added.length).toBeGreaterThanOrEqual(12);
    expect(added.length).toBeLessThanOrEqual(15);
    expect(new Set(OBJECTIVES.map((o) => o.id)).size).toBe(OBJECTIVES.length);
    for (const o of added) expect(o.reward).toBeGreaterThan(0);
  });

  it('цели выполняются строго по порядку: выполненная дальше по цепочке ждёт, пока не пройдены предыдущие', () => {
    const s = afterOldChain();
    // Выполнено условие «Второго НПЗ» (2-я новая цель), но не «Морского промысла» (1-я).
    put(s, 'refinery', 3);
    put(s, 'refinery', 3, 1);
    expect(checkObjectives(s)).toEqual([]);
    expect(currentObjective(s).id).toBe('offshore');
    put(s, 'platform', 3, 2);
    expect(checkObjectives(s).map((o) => o.id)).toEqual(['offshore', 'refinery_pair']);
    expect(currentObjective(s).id).toBe('fleet_7');
  });

  it('награда выдаётся один раз; деньги — в totals.rewards, инвариант сходится', () => {
    const s = afterOldChain();
    put(s, 'platform', 3);
    const cash = s.cash;
    const done = checkObjectives(s);
    expect(done.map((o) => o.id)).toEqual(['offshore']);
    expect(s.cash).toBe(cash + done[0].reward);
    expect(s.totals.rewards).toBe(done[0].reward);
    expect(checkObjectives(s)).toEqual([]);
    expect(s.totals.rewards).toBe(done[0].reward);
    for (let i = 0; i < 100; i++) tick(s, TICK);
    expect(s.totals.rewards).toBe(done[0].reward);
    expectBalanced(s);
  });

  it('цель-список: прогресс — число выполненных пунктов, цель — когда выполнены все', () => {
    const s = afterOldChain();
    s.objectiveIndex = OBJECTIVES.findIndex((o) => o.id === 'autopilot');
    const o = currentObjective(s);
    expect(o.items!(s).length).toBe(3);
    s.managers.dispatcher = true;
    s.managers.mechanic = true;
    expect(o.progress(s)).toEqual({ current: 2, target: 3 });
    expect(checkObjectives(s)).toEqual([]);
    // Кредит взят и закрыт.
    s.totals.borrowed = 1000;
    s.totals.repaid = 1000;
    s.loan = null;
    expect(o.progress(s)).toEqual({ current: 3, target: 3 });
    expect(checkObjectives(s).map((x) => x.id)).toEqual(['autopilot']);
  });

  it('старое сохранение «пройдены все 17» загружается и получает первую новую цель; без ретро-наград', () => {
    const s = afterOldChain(5);
    const old = JSON.parse(serialize(s));
    delete old.stage;
    delete old.achievements;
    const m = deserialize(JSON.stringify(old))!;
    expect(m).not.toBeNull();
    expect(m.objectiveIndex).toBe(NEW_START);
    expect(m.stage).toBe(0);
    expect(m.achievements).toEqual([]);
    expect(currentObjective(m).id).toBe(OBJECTIVES[NEW_START].id);
    const rewards = m.totals.rewards;
    expect(checkObjectives(m)).toEqual([]);
    expect(m.totals.rewards).toBe(rewards);
    // Условие новой цели уже выполнено к моменту открытия — засчитывается по обычному правилу.
    put(m, 'platform', 3);
    expect(checkObjectives(m).map((o) => o.id)).toEqual(['offshore']);
  });

  it('испорченные поля ступени и достижений отклоняются; неизвестные и повторные достижения отбрасываются', () => {
    const s = afterOldChain();
    const a = JSON.parse(serialize(s));
    a.stage = -1;
    expect(deserialize(JSON.stringify(a))).toBeNull();
    a.stage = 1.5;
    expect(deserialize(JSON.stringify(a))).toBeNull();
    a.stage = 2;
    a.achievements = 'x';
    expect(deserialize(JSON.stringify(a))).toBeNull();
    a.achievements = ['first_barrel', 'first_barrel', 'нет_такого'];
    const m = deserialize(JSON.stringify(a))!;
    expect(m.stage).toBe(2);
    expect(m.achievements).toEqual(['first_barrel']);
    a.objectiveIndex = OBJECTIVES.length + 1;
    expect(deserialize(JSON.stringify(a))).toBeNull();
  });
});

describe('ступени после цепочки', () => {
  it('детерминированы: одно N — одно условие и одна награда; порог и награда растут', () => {
    for (let n = 1; n <= 30; n++) {
      const a = stageObjective(n);
      const b = stageObjective(n);
      expect(a.id).toBe(`stage_${n}`);
      expect(a.title).toBe(`Ступень ${n}`);
      expect(a.progress(createNewGame(1)).target).toBe(b.progress(createNewGame(2)).target);
      expect(a.progress(createNewGame(1)).target).toBe(stageTarget(n));
      expect(a.reward).toBe(stageReward(n));
      if (n > 1) {
        expect(stageTarget(n)).toBeGreaterThan(stageTarget(n - 1));
        expect(stageReward(n)).toBeGreaterThanOrEqual(stageReward(n - 1));
      }
    }
    expect(stageTarget(1)).toBe(STAGES.revenueBase);
  });

  it('после цепочки цель есть всегда: ступени идут подряд, в сохранении — только номер', () => {
    const s = createNewGame(4);
    s.objectiveIndex = OBJECTIVES.length;
    expect(currentObjective(s).id).toBe('stage_1');
    // Выручка с запасом на три ступени — засчитываются три подряд, каждая со своей наградой.
    s.totals.revenue = stageTarget(3);
    s.cash += stageTarget(3); // деньги выручки (для инварианта)
    const done = checkObjectives(s);
    expect(done.map((o) => o.id)).toEqual(['stage_1', 'stage_2', 'stage_3']);
    expect(s.stage).toBe(3);
    expect(s.objectiveIndex).toBe(OBJECTIVES.length);
    expect(s.totals.rewards).toBe(stageReward(1) + stageReward(2) + stageReward(3));
    expect(currentObjective(s).id).toBe('stage_4');
    expectBalanced(s);
    const saved = JSON.parse(serialize(s));
    expect(saved.stage).toBe(3);
    expect(JSON.stringify(saved)).not.toContain('stage_');
    const m = deserialize(JSON.stringify(saved))!;
    expect(currentObjective(m).progress(m)).toEqual(currentObjective(s).progress(s));
  });
});

describe('достижения', () => {
  it('20–30 штук, id уникальны; выдаются один раз; денег не дают', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(20);
    expect(ACHIEVEMENTS.length).toBeLessThanOrEqual(30);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    const s = createNewGame(2);
    expect(checkAchievements(s)).toEqual([]);
    expect(companyRank(s)).toBe('Старатель');
    s.totals.sold = 5;
    s.totals.borrowed = 1000;
    s.loan = { principal: 1000, start: 0, rate: 0.01, term: 1800 };
    const cash = s.cash;
    const totals = { ...s.totals };
    expect(checkAchievements(s).map((a) => a.id)).toEqual(['first_barrel', 'first_loan']);
    expect(checkAchievements(s)).toEqual([]);
    expect(s.achievements).toEqual(['first_barrel', 'first_loan']);
    expect(s.cash).toBe(cash);
    expect(s.totals).toEqual(totals);
    // Условие пропало (кредит закрыт) — достижение остаётся.
    s.totals.sold = 0;
    s.loan = null;
    expect(checkAchievements(s).map((a) => a.id)).toEqual(['loan_repaid']);
    expect(s.achievements).toContain('first_barrel');
    const m = deserialize(serialize(s))!;
    expect(m.achievements).toEqual(s.achievements);
    expect(checkAchievements(m)).toEqual([]);
  });
});
