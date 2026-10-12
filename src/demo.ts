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
  // Скважины ставятся жадно: соседние по стороне клетки отклоняются правилом расстановки.
  let placed = 0;
  for (const [x, y] of deposits) {
    if (!core.build(s, 'pumpjack', x, y).ok) continue;
    const b = core.buildingAt(s, x, y)!;
    for (let l = 1; l < 1 + (placed % 3); l++) core.upgrade(s, b.id);
    placed++;
  }
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
  // Сеть: резервуары и терминал соединяются с конторой, качалки — к ближайшей трубе или хранилищу
  // (кнопка «Подключить»); участок от конторы к резервуарам — магистраль.
  const ordered = [...s.buildings].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === 'tank' ? -1 : b.type === 'tank' ? 1 : 0));
  for (const b of ordered) if (b.type !== 'hq') core.autoConnect(s, b.id);
  core.layPipes(s, core.pipePath([hx + 1, hy], [hx + 1, hy + 1]), 2);
  core.buyParcel(s, core.START_PARCEL.px + 1, core.START_PARCEL.py);
  for (let i = 0; i < 1200; i++) core.tick(s, core.TICK);
  return s;
}
