import { describe, expect, it } from 'vitest';
import {
  buyParcel,
  canSurvey,
  createNewGame,
  deserialize,
  parcelEstimate,
  parcelPrice,
  parcelSurvey,
  PARCELS_PER_SIDE,
  serialize,
  START_PARCEL,
  survey,
  surveyCost,
  surveyLevel,
  SURVEY_EXACT,
  SURVEY_LEVELS,
  type GameState,
} from '../src/core';

const N = { px: START_PARCEL.px + 1, py: START_PARCEL.py };

function expectBalanced(s: GameState, start: number) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

describe('разведка', () => {
  it('в новой игре известен только стартовый участок; запасы соседей скрыты', () => {
    const s = createNewGame(3);
    expect(surveyLevel(s, START_PARCEL.px, START_PARCEL.py)).toBe(SURVEY_EXACT);
    const e = parcelEstimate(s, N.px, N.py);
    expect(e.level).toBe(0);
    expect(e.reserves).toBeNull();
    expect(e.tiles).toBeNull();
  });

  it('съёмка стоит 10% цены участка, идёт во вложения и даёт диапазон ±40% без сорта', () => {
    const s = createNewGame(3);
    s.cash = 10_000;
    const start = s.cash;
    const cost = surveyCost(s, 1);
    expect(cost).toBe(Math.round(parcelPrice(s) * SURVEY_LEVELS[0].costShare));
    expect(survey(s, N.px, N.py, 1).ok).toBe(true);
    expect(s.cash).toBe(start - cost);
    expect(s.totals.capex).toBe(cost);
    const truth = parcelSurvey(s, N.px, N.py);
    const e = parcelEstimate(s, N.px, N.py);
    expect(e.tiles).toBe(truth.tiles);
    expect(e.light).toBeNull();
    expect(e.heavy).toBeNull();
    if (truth.reserves > 0) {
      expect(e.reserves!.low).toBeLessThanOrEqual(truth.reserves + 50);
      expect(e.reserves!.high).toBeGreaterThanOrEqual(truth.reserves - 50);
    }
    expectBalanced(s, start);
    // Повторно — нельзя; своя земля — уже известна.
    expect(canSurvey(s, N.px, N.py, 1).ok).toBe(false);
    expect(canSurvey(s, START_PARCEL.px, START_PARCEL.py, 1).ok).toBe(false);
  });

  it('оценка не лотерея: истина всегда в диапазоне, сейсморазведка точнее и показывает сорт; оценка постоянна', () => {
    let narrower = 0;
    let total = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = createNewGame(seed);
      s.cash = 1e9;
      for (let py = 0; py < PARCELS_PER_SIDE; py++) {
        for (let px = 0; px < PARCELS_PER_SIDE; px++) {
          if (surveyLevel(s, px, py) >= SURVEY_EXACT) continue;
          const truth = parcelSurvey(s, px, py);
          survey(s, px, py, 1);
          const e1 = parcelEstimate(s, px, py);
          expect(parcelEstimate(s, px, py)).toEqual(e1); // повторный взгляд не меняет оценку
          survey(s, px, py, 2);
          const e2 = parcelEstimate(s, px, py);
          for (const [r, v] of [
            [e1.reserves!, truth.reserves],
            [e2.reserves!, truth.reserves],
            [e2.light!, truth.light],
            [e2.heavy!, truth.heavy],
          ] as const) {
            expect(r.low).toBeLessThanOrEqual(v + 50); // округление до сотен
            expect(r.high).toBeGreaterThanOrEqual(v - 50);
          }
          if (truth.reserves > 0) {
            total++;
            if (e2.reserves!.high - e2.reserves!.low < e1.reserves!.high - e1.reserves!.low) narrower++;
            expect(e1.reserves!.high - e1.reserves!.low).toBeLessThanOrEqual(truth.reserves * 0.8 + 100);
            expect(e2.reserves!.high - e2.reserves!.low).toBeLessThanOrEqual(truth.reserves * 0.2 + 100);
          }
        }
      }
    }
    expect(narrower).toBe(total);
  });

  it('купленный участок известен точно', () => {
    const s = createNewGame(3);
    s.cash = 1e6;
    expect(buyParcel(s, N.px, N.py).ok).toBe(true);
    const e = parcelEstimate(s, N.px, N.py);
    const truth = parcelSurvey(s, N.px, N.py);
    expect(e.level).toBe(SURVEY_EXACT);
    expect(e.reserves).toEqual({ low: truth.reserves, high: truth.reserves });
  });

  it('разведка переживает сохранение; старые сохранения (v3) видят все участки точно', () => {
    const s = createNewGame(3);
    s.cash = 1e6;
    survey(s, N.px, N.py, 1);
    const t = deserialize(serialize(s))!;
    expect(surveyLevel(t, N.px, N.py)).toBe(1);
    const old = JSON.parse(serialize(createNewGame(3)));
    old.version = 3;
    delete old.map.survey;
    const m = deserialize(JSON.stringify(old))!;
    for (let py = 0; py < PARCELS_PER_SIDE; py++) for (let px = 0; px < PARCELS_PER_SIDE; px++) expect(surveyLevel(m, px, py)).toBe(SURVEY_EXACT);
  });
});
