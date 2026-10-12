import { PARCEL_SIZE, PARCELS_PER_SIDE } from './config';
import type { Building, GameState } from './types';

export function inBounds(s: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.map.size && y < s.map.size;
}

export function tileIndex(s: GameState, x: number, y: number): number {
  return y * s.map.size + x;
}

export function parcelOf(x: number, y: number): { px: number; py: number } {
  return { px: Math.floor(x / PARCEL_SIZE), py: Math.floor(y / PARCEL_SIZE) };
}

export function parcelIndex(px: number, py: number): number {
  return py * PARCELS_PER_SIDE + px;
}

export function isParcelOwned(s: GameState, px: number, py: number): boolean {
  if (px < 0 || py < 0 || px >= PARCELS_PER_SIDE || py >= PARCELS_PER_SIDE) return false;
  return s.map.owned[parcelIndex(px, py)];
}

export function isTileOwned(s: GameState, x: number, y: number): boolean {
  const { px, py } = parcelOf(x, y);
  return isParcelOwned(s, px, py);
}

export function buildingAt(s: GameState, x: number, y: number): Building | undefined {
  return s.buildings.find((b) => b.x === x && b.y === y);
}

export function getBuilding(s: GameState, id: number): Building | undefined {
  return s.buildings.find((b) => b.id === id);
}

export function ownedParcelCount(s: GameState): number {
  return s.map.owned.filter(Boolean).length;
}

export function isParcelAdjacentToOwned(s: GameState, px: number, py: number): boolean {
  return (
    isParcelOwned(s, px - 1, py) ||
    isParcelOwned(s, px + 1, py) ||
    isParcelOwned(s, px, py - 1) ||
    isParcelOwned(s, px, py + 1)
  );
}

/** Сводка по месторождениям участка — то, что видит игрок до покупки. */
export function parcelSurvey(s: GameState, px: number, py: number): { tiles: number; reserves: number } {
  let tiles = 0;
  let reserves = 0;
  for (let y = py * PARCEL_SIZE; y < (py + 1) * PARCEL_SIZE; y++) {
    for (let x = px * PARCEL_SIZE; x < (px + 1) * PARCEL_SIZE; x++) {
      const r = s.map.reserve[tileIndex(s, x, y)];
      if (r > 0) {
        tiles++;
        reserves += r;
      }
    }
  }
  return { tiles, reserves };
}
