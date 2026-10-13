import { planAutoConnect } from './actions';
import { bestConnect } from './connect';
import { levelSpec } from './economy';
import { PARCEL_SIZE, SURVEY_EXACT } from './config';
import { syncOil } from './network';
import { isParcelOwned } from './world';
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
  // Сорта не зависят от труб, а подключение при миграции v1 уже считает поток с сортами — поэтому сначала сорта.
  if (s.version < 3) migrateV2(state, reference);
  else if (!Array.isArray(state.map.grade) || state.map.grade.length !== reference.map.grade.length) return null;
  if (s.version < 2) migrateV1(state, reference);
  else if (!Array.isArray(state.map.pipes) || state.map.pipes.length !== reference.map.pipes.length) return null;
  // v3 → v4: разведка. Старые игры видели запасы всех участков бесплатно — это знание сохраняется («известно точно»).
  if (s.version < 4) state.map = { ...state.map, survey: state.map.owned.map(() => SURVEY_EXACT) };
  else if (!Array.isArray(state.map.survey) || state.map.survey.length !== reference.map.survey.length) return null;
  state.version = SAVE_VERSION;
  return state;
}

/**
 * v2 → v3: сорта нефти.
 * - Вся нефть в хранилищах и все месторождения, которые игрок уже мог видеть или трогать, — лёгкие:
 *   лёгкая продаётся по прежней рыночной цене, поэтому ни объём, ни стоимость запасов не меняются.
 * - Месторождения целиком на чужих участках и нетронутые получают сорт и запасы как в новой игре с тем же
 *   seed (генерация совпадает, отличаются только сорта и запасы тяжёлых) — старые игры тоже встретят тяжёлую нефть.
 */
function migrateV2(s: GameState, reference: GameState): void {
  const n = s.map.size;
  const grade = new Array<number>(n * n).fill(0);
  const reserve = [...s.map.reserve];
  const initial = [...s.map.initial];
  const seen = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (initial[i] <= 0 || seen[i]) continue;
    const comp: number[] = [i];
    seen[i] = 1;
    for (let q = 0; q < comp.length; q++) {
      const x = comp[q] % n;
      const y = (comp[q] - x) / n;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (initial[j] > 0 && !seen[j]) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    const untouched = comp.every(
      (j) =>
        reserve[j] === initial[j] &&
        !isParcelOwned(s, Math.floor((j % n) / PARCEL_SIZE), Math.floor(j / n / PARCEL_SIZE)) &&
        reference.map.initial[j] > 0,
    );
    if (!untouched) continue;
    for (const j of comp) {
      grade[j] = reference.map.grade[j];
      reserve[j] = reference.map.reserve[j];
      initial[j] = reference.map.initial[j];
    }
  }
  s.map = { ...s.map, grade, reserve, initial };
  for (const b of s.buildings) if (b.type === 'hq' || b.type === 'tank') b.grade = 0;
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
  for (const type of ['tank', 'terminal', 'pumpjack'] as const) {
    for (const b of order) {
      if (b.type !== type) continue;
      // Магистралью: старое предприятие не должно внезапно упереться в пропускную способность труб,
      // которые игрок не прокладывал. Качалки — вариантом с наибольшим расчётным потоком: если кратчайшая труба
      // привела бы в уже загруженный участок, прокладывается отдельная ветка (обычные трубы, без скрытых бонусов).
      // Дальше игрок развивает сеть уже по новым правилам.
      const free = { ...s, cash: Infinity };
      let tiles: Array<[number, number]> = [];
      if (type === 'pumpjack') {
        const opt = bestConnect(free, b.id, 2);
        if (opt) tiles = [...opt.tiles, ...opt.upgrades];
      } else {
        const plan = planAutoConnect(free, b.id, 2);
        if (plan.ok) tiles = plan.tiles;
      }
      // Пусто — уже подключено или нет пути по своей земле: интерфейс покажет предупреждение.
      for (const [x, y] of tiles) {
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
