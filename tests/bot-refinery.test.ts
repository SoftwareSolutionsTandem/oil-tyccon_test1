import { describe, expect, it } from 'vitest';
import { build, countOf, createNewGame, HQ_POS, refineryMargin, type GameState } from '../src/core';
import { manageRefinery } from './bot';

const HX = HQ_POS.x;
const HY = HQ_POS.y;

/** Предприятие для решения бота: НПЗ открыт, денег много, добыча за минуту — produced барр./с. */
function company(produced: number): GameState {
  const s = createNewGame(5);
  s.cash = 1e6;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery'];
  s.stats.buckets = Array.from({ length: 60 }, () => ({ produced, sold: 0, revenue: 0, expenses: 0, refined: 0, productRevenue: 0 }));
  return s;
}

/** Нефть «течёт» в контору: качалки 3-го уровня вплотную к ней дают поток для пробной работы. */
function withPumps(s: GameState): void {
  for (const [x, y] of [[HX + 1, HY], [HX - 1, HY], [HX, HY - 1]]) {
    const i = y * s.map.size + x;
    s.map.reserve[i] = s.map.initial[i] = 1e6;
    s.map.grade[i] = 0;
    expect(build(s, 'pumpjack', x, y).ok).toBe(true);
    s.buildings[s.buildings.length - 1].level = 3;
  }
}

describe('бот и НПЗ', () => {
  it('строит НПЗ, когда есть деньги, нефть, рабочее место и маржа', () => {
    const s = company(4);
    withPumps(s);
    s.market.price = 50;
    s.time = 0;
    manageRefinery(s);
    expect(countOf(s, 'refinery')).toBe(1);
  });

  it('не строит без достаточной добычи', () => {
    const s = company(1);
    withPumps(s);
    manageRefinery(s);
    expect(countOf(s, 'refinery')).toBe(0);
  });

  it('не строит, если на лучшем месте НПЗ не получит нефть (логистика/подключение)', () => {
    const s = company(4); // статистика добычи есть, но нефти в сети нет — пробная работа даёт 0
    manageRefinery(s);
    expect(countOf(s, 'refinery')).toBe(0);
  });

  it('не строит, если маржа имеющихся сортов неположительна', () => {
    const s = company(4);
    withPumps(s);
    s.market.price = 95;
    expect(refineryMargin(s, 0, false)).toBeLessThan(0);
    manageRefinery(s);
    expect(countOf(s, 'refinery')).toBe(0);
  });

  it('не строит без денег (меньше 1,5 цены НПЗ)', () => {
    const s = company(4);
    withPumps(s);
    s.cash = 20000;
    manageRefinery(s);
    expect(countOf(s, 'refinery')).toBe(0);
  });
});
