import { planAutoConnect } from './actions';
import { levelSpec } from './economy';
import { syncOil } from './network';
import { createNewGame, SAVE_VERSION } from './state';
import type { GameState } from './types';

export const SAVE_KEY = 'oil-tycoon-save';

export function serialize(s: GameState): string {
  s.savedAt = Date.now();
  return JSON.stringify(s);
}

/** Разбирает сохранение. Возвращает null, если данные повреждены или несовместимы. */
export function deserialize(json: string): GameState | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.version !== 'number' || data.version > SAVE_VERSION) return null;
  const s = data as unknown as GameState;
  const reference = createNewGame(typeof s.seed === 'number' ? s.seed : 1);
  if (
    typeof s.cash !== 'number' ||
    !Array.isArray(s.buildings) ||
    !isRecord(s.map) ||
    !Array.isArray(s.map.reserve) ||
    s.map.reserve.length !== reference.map.reserve.length
  ) {
    return null;
  }
  const state: GameState = { ...reference, ...s };
  if (s.version < 2) migrateV1(state, reference);
  else if (!Array.isArray(state.map.pipes) || state.map.pipes.length !== reference.map.pipes.length) return null;
  state.version = SAVE_VERSION;
  return state;
}

/**
 * v1 → v2: появилась сеть трубопроводов и локальные хранилища.
 * - Общий запас нефти распределяется по хранилищам пропорционально ёмкости (ни баррель не теряется).
 * - Старые предприятия работали «по воздуху»; чтобы ничего не сломалось, существующие резервуары, качалки и терминалы
 *   бесплатно подключаются кратчайшими магистралями по своей земле — аналог трубопроводов, которые раньше только рисовались.
 *   Деньги, здания и земля не меняются; бесплатные трубы не входят во вложения.
 * - В цепочку целей вставлена цель «Нефть в трубу» (индекс 1): номер текущей цели сдвигается.
 */
function migrateV1(s: GameState, reference: GameState): void {
  s.map = { ...s.map, pipes: new Array<number>(reference.map.pipes.length).fill(0) };
  const storages = s.buildings.filter((b) => b.type === 'hq' || b.type === 'tank');
  const cap = storages.reduce((sum, b) => sum + levelSpec(b).value, 0);
  for (const b of storages) b.stored = cap > 0 ? (s.oil * levelSpec(b).value) / cap : 0;
  const order = [...s.buildings].sort((a, b) => a.id - b.id);
  for (const type of ['tank', 'pumpjack', 'terminal'] as const) {
    for (const b of order) {
      if (b.type !== type) continue;
      // Магистралью: старое предприятие не должно внезапно упереться в пропускную способность труб,
      // которые игрок не прокладывал. Дальше он развивает сеть уже по новым правилам.
      const plan = planAutoConnect({ ...s, cash: Infinity }, b.id, 2);
      if (!plan.ok) continue; // уже подключено или нет пути по своей земле — интерфейс покажет предупреждение
      for (const [x, y] of plan.tiles) {
        s.map.pipes[y * s.map.size + x] = 2;
        s.map.decor[y * s.map.size + x] = 0;
      }
    }
  }
  syncOil(s);
  if (s.objectiveIndex >= 1) s.objectiveIndex += 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
