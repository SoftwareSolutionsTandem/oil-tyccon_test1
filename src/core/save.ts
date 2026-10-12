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
  // Миграции будущих версий сохранений добавляются здесь.
  return { ...reference, ...s, version: SAVE_VERSION };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
