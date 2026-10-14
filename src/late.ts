import * as core from './core';
import type { GameState } from './core';

/**
 * Сцена поздней игры (?late): ~70 зданий на 8 участках, все механики открыты. Нужна для замеров рендера
 * на телефонах (вместе с ?perf) и сравнительных кадров. Строится обычными действиями игрока, детерминированно
 * (seed 1); настоящее сохранение не трогает.
 */
export function createLateState(): GameState {
  const s = core.createNewGame(1);
  s.cash = 1e8;
  s.unlocked = ['pumpjack', 'tank', 'terminal', 'refinery'];
  s.features = ['research', 'loans', 'managers'];
  s.research.levels = { yield: 3, eor: 2, energy: 2, standard: 2 };
  s.objectiveIndex = core.OBJECTIVES.findIndex((o) => o.id === 'cash_500k');
  s.map.survey = s.map.survey.map(() => core.SURVEY_EXACT);

  // Земля: семь соседних участков с наибольшими запасами (жадно, по одному).
  for (let k = 0; k < 7; k++) {
    let best: { px: number; py: number; r: number } | null = null;
    for (let py = 0; py < core.PARCELS_PER_SIDE; py++)
      for (let px = 0; px < core.PARCELS_PER_SIDE; px++) {
        if (!core.canBuyParcel(s, px, py).ok) continue;
        const r = core.parcelSurvey(s, px, py).reserves;
        if (!best || r > best.r) best = { px, py, r };
      }
    if (best) core.buyParcel(s, best.px, best.py);
  }

  // Хозяйство у конторы: резервуары, терминалы, НПЗ.
  const { x: hx, y: hy } = core.HQ_POS;
  const near: Array<[number, number, 'tank' | 'terminal' | 'refinery']> = [
    [hx + 1, hy, 'terminal'],
    [hx - 1, hy, 'terminal'],
    [hx, hy - 1, 'terminal'],
    [hx + 2, hy, 'tank'],
    [hx + 3, hy, 'tank'],
    [hx, hy + 2, 'tank'],
    [hx + 1, hy + 2, 'refinery'],
  ];
  for (const [x, y, type] of near) {
    if (!core.build(s, type, x, y).ok) continue;
    const b = core.buildingAt(s, x, y)!;
    while (core.upgradeCost(b) !== null) core.upgrade(s, b.id);
  }

  // Качалки 3-го уровня на всех месторождениях своей земли (правило рядов отклоняет лишние клетки).
  const n = s.map.size;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (s.map.initial[y * n + x] <= 0 || !core.isTileOwned(s, x, y)) continue;
      if (!core.build(s, 'pumpjack', x, y).ok) continue;
      const b = core.buildingAt(s, x, y)!;
      while (core.upgradeCost(b) !== null) core.upgrade(s, b.id);
    }

  // Сеть: всё подключается магистралью — резервуары и терминалы сначала, затем качалки.
  const ordered = [...s.buildings].sort((a, b) => (a.type === 'pumpjack' ? 1 : 0) - (b.type === 'pumpjack' ? 1 : 0) || a.id - b.id);
  for (const b of ordered) if (b.type !== 'hq' && !core.autoConnectBest(s, b.id, 2).ok) core.autoConnect(s, b.id, 2);

  // Коллекторы у дальних групп качалок: резервуар рядом с качалкой, которой не хватает места.
  core.simulateOffline(s, 120);
  for (const b of [...s.buildings]) {
    if (b.type !== 'pumpjack' || (b.status !== 'throttled' && b.status !== 'full')) continue;
    // Один коллектор на группу: рядом уже есть резервуар — пропускаем.
    if (s.buildings.some((o) => o.type === 'tank' && Math.abs(o.x - b.x) + Math.abs(o.y - b.y) <= 5)) continue;
    for (const [dx, dy] of [[2, 0], [0, 2], [-2, 0], [0, -2], [1, 1], [-1, -1]]) {
      if (core.build(s, 'tank', b.x + dx, b.y + dy).ok) {
        core.autoConnect(s, s.buildings[s.buildings.length - 1].id, 2);
        break;
      }
    }
  }
  s.managers = { dispatcher: true, mechanic: true, reserve: 0 };
  core.simulateOffline(s, 600);
  s.cash = 250_000;
  return s;
}
