import * as core from './core';
import type { GameState } from './core';

/**
 * Демонстрационная сцена (открывается по адресу ?demo): готовое предприятие на стартовом участке.
 * Нужна для визуальной проверки графики и сравнительных скриншотов — строится обычными действиями игрока.
 */
export function createDemoState(): GameState {
  const s = core.createNewGame(2024);
  s.cash = 1e6;
  s.unlocked = ['pumpjack', 'tank', 'terminal'];
  const { x: hx, y: hy } = core.HQ_POS;
  const deposits: Array<[number, number]> = [];
  for (let y = 0; y < s.map.size; y++)
    for (let x = 0; x < s.map.size; x++)
      if (s.map.initial[core.tileIndex(s, x, y)] > 0 && core.isTileOwned(s, x, y)) deposits.push([x, y]);
  deposits.forEach(([x, y], i) => {
    core.build(s, 'pumpjack', x, y);
    const b = core.buildingAt(s, x, y)!;
    for (let l = 1; l < 1 + (i % 3); l++) core.upgrade(s, b.id);
  });
  const spots: Array<[number, number, 'tank' | 'terminal', number]> = [
    [hx + 2, hy, 'tank', 1],
    [hx + 3, hy, 'tank', 2],
    [hx + 4, hy, 'tank', 3],
    [hx, hy + 2, 'terminal', 1],
    [hx + 1, hy + 2, 'tank', 1],
  ];
  for (const [x, y, type, level] of spots) {
    if (!core.build(s, type, x, y).ok) continue;
    const b = core.buildingAt(s, x, y)!;
    for (let l = 1; l < level; l++) core.upgrade(s, b.id);
  }
  core.buyParcel(s, core.START_PARCEL.px + 1, core.START_PARCEL.py);
  for (let i = 0; i < 1200; i++) core.tick(s, core.TICK);
  return s;
}
