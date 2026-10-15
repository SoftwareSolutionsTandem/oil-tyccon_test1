import { planAutoConnect } from './actions';
import { bestConnect } from './connect';
import { levelSpec } from './economy';
import { BASE_MAP_SIZE, MAP_OFFSET, PARCEL_SIZE, PARCELS_PER_SIDE, SURVEY_EXACT, TECH_IDS, TECHS } from './config';
import { syncOil } from './network';
import { isParcelOwned, parcelRegion } from './world';
import { createNewGame, SAVE_VERSION } from './state';
import type { Feature, GameState } from './types';

/** Известные возможности компании (проверка сохранений). */
const FEATURES: readonly Feature[] = ['research', 'loans', 'managers', 'desert', 'shelf'];

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
    !Array.isArray(s.map.reserve)
  ) {
    return null;
  }
  // v7 → v8: карта 40×40 ложится в угол карты 56×56 — до остальных миграций, которые сверяют длины массивов с новой игрой.
  if (s.version < 8) {
    if (!expandMap(s, reference)) return null;
  } else if (
    s.map.size !== reference.map.size ||
    !Array.isArray(s.map.region) ||
    s.map.region.length !== reference.map.region.length ||
    !Array.isArray(s.map.owned) ||
    s.map.owned.length !== reference.map.owned.length
  ) {
    return null;
  }
  if (s.map.reserve.length !== reference.map.reserve.length) return null;
  const state: GameState = { ...reference, ...s };
  // Сорта не зависят от труб, а подключение при миграции v1 уже считает поток с сортами — поэтому сначала сорта.
  if (s.version < 3) migrateV2(state, reference);
  else if (!Array.isArray(state.map.grade) || state.map.grade.length !== reference.map.grade.length) return null;
  if (s.version < 2) migrateV1(state, reference);
  else if (!Array.isArray(state.map.pipes) || state.map.pipes.length !== reference.map.pipes.length) return null;
  if (s.version < 5) migrateV4(state, reference);
  else if (!Array.isArray(state.productThresholds) || state.productThresholds.length !== 3) return null;
  // v5 → v6 — после v4 → v5: обе миграции сдвигают номер цели, каждая по своей цепочке.
  if (s.version < 6) migrateV5(state);
  else if (!validResearch(state)) return null;
  // v6 → v7 — после v5 → v6: номер цели сдвигается по цепочке v6.
  if (s.version < 7) migrateV6(state);
  else if (!validCompany(state)) return null;
  // v3 → v4: разведка. Старые игры видели запасы всех участков бесплатно — это знание сохраняется («известно точно»).
  // Участки новых регионов (веха 0.5) старые игры не видели — они не разведаны.
  if (s.version < 4) state.map = { ...state.map, survey: state.map.owned.map((_, i) => (parcelRegion(i % PARCELS_PER_SIDE, Math.floor(i / PARCELS_PER_SIDE)) === 0 ? SURVEY_EXACT : 0)) };
  else if (!Array.isArray(state.map.survey) || state.map.survey.length !== reference.map.survey.length) return null;
  // Реклама (веха 0.5, этап 3): поля без повышения версии — отсутствующие получают значения по умолчанию.
  if (typeof state.totals.adRewards !== 'number') state.totals = { ...state.totals, adRewards: 0 };
  if (!Number.isFinite(state.totals.adRewards) || state.totals.adRewards < 0) return null;
  if (state.adLastAt === undefined) state.adLastAt = null;
  if (state.adLastAt !== null && (typeof state.adLastAt !== 'number' || !Number.isFinite(state.adLastAt))) return null;
  state.version = SAVE_VERSION;
  return state;
}

/**
 * v7 → v8: регионы (веха 0.5). Карта 40×40 копируется в карту 56×56 со смещением MAP_OFFSET; клетки и участки
 * новых регионов — как в новой игре с тем же seed (их не было, поэтому они нетронуты). Земля, трубы, разведка и
 * здания не меняются (смещение — константа; здания сдвигаются на него же). Нумерация целей не сдвигается: цель
 * региона добавлена в конец цепочки. Массивы, которых в старой версии ещё нет (трубы v1, сорта v2, разведка v3),
 * создают следующие миграции уже в размере новой карты.
 */
function expandMap(s: GameState, reference: GameState): boolean {
  const old = s.map as unknown as Record<string, unknown>;
  const n0 = BASE_MAP_SIZE;
  const n = reference.map.size;
  const p0 = BASE_MAP_SIZE / PARCEL_SIZE;
  const ox = MAP_OFFSET.x;
  const oy = MAP_OFFSET.y;
  if (!Array.isArray(old.reserve) || old.reserve.length !== n0 * n0) return false;
  if (!Array.isArray(old.owned) || old.owned.length !== p0 * p0) return false;
  const map = { ...s.map, size: n, region: [...reference.map.region] } as GameState['map'];
  for (const key of ['reserve', 'initial', 'decor', 'pipes', 'grade'] as const) {
    const src = old[key];
    if (src === undefined) continue;
    if (!Array.isArray(src) || src.length !== n0 * n0) return false;
    const out = key === 'pipes' ? new Array<number>(n * n).fill(0) : [...reference.map[key]];
    for (let y = 0; y < n0; y++) for (let x = 0; x < n0; x++) out[(y + oy) * n + x + ox] = src[y * n0 + x];
    map[key] = out;
  }
  for (const key of ['owned', 'survey'] as const) {
    const src = old[key];
    if (src === undefined) continue;
    if (!Array.isArray(src) || src.length !== p0 * p0) return false;
    const out: Array<boolean | number> = key === 'owned' ? new Array<boolean>(PARCELS_PER_SIDE ** 2).fill(false) : new Array<number>(PARCELS_PER_SIDE ** 2).fill(0);
    for (let py = 0; py < p0; py++)
      for (let px = 0; px < p0; px++) out[(py + oy / PARCEL_SIZE) * PARCELS_PER_SIDE + px + ox / PARCEL_SIZE] = src[py * p0 + px];
    (map as unknown as Record<string, unknown>)[key] = out;
  }
  s.map = map;
  for (const b of s.buildings) {
    b.x += ox;
    b.y += oy;
  }
  return true;
}

/** Индекс цели «Переработка» в цепочке v5 (в v6 перед ней вставлен «Инженерный центр»). */
const REFINING_OBJECTIVE_V5 = 10;

/**
 * v5 → v6: исследования (веха 0.4). Новые поля — пустые; в цепочку перед «Переработкой» вставлен
 * «Инженерный центр» (индекс 10).
 * - objectiveIndex ≤ 10 — без изменений: игрок на «Переработке» (10) сначала проходит новую цель, затем
 *   «Переработка» засчитывается сразу, если её условие выполнено (награда за неё ещё не выдавалась).
 * - objectiveIndex ≥ 11 («Переработка» пройдена) — сдвиг на одну; новая цель пропускается без награды,
 *   исследования открываются, как дала бы она.
 */
function migrateV5(s: GameState): void {
  s.totals = { ...s.totals, research: 0 };
  s.features = [];
  s.research = { levels: {}, active: null };
  if (s.objectiveIndex > REFINING_OBJECTIVE_V5) {
    s.objectiveIndex += 1;
    s.features.push('research');
  }
}

/**
 * v6 → v7: кредиты и персонал (веха 0.4). Новые поля — пустые. В цепочку v6 вставлены «Кредит доверия»
 * (перед «Инженерным центром», индекс 10) и «Штат специалистов» (после «Переработки»).
 * - objectiveIndex ≤ 10 — без изменений: игрок на «Инженерном центре» сначала проходит «Кредит доверия».
 * - 11 («Переработка», центр пройден) → 12; кредиты открыты, как дала бы пропущенная цель (без награды).
 * - 12 («Нефтяная компания», переработка пройдена) → 14; открыты кредиты и персонал.
 * - 13 (все цели пройдены) → 15; открыты кредиты и персонал.
 */
function migrateV6(s: GameState): void {
  s.totals = { ...s.totals, salaries: 0, borrowed: 0, repaid: 0, interest: 0 };
  s.managers = { dispatcher: false, mechanic: false, reserve: 0 };
  s.loan = null;
  const i = s.objectiveIndex;
  const grant = (f: 'loans' | 'managers') => {
    if (!s.features.includes(f)) s.features = [...s.features, f];
  };
  if (i === 11) {
    s.objectiveIndex = 12;
    grant('loans');
  } else if (i >= 12) {
    s.objectiveIndex = i + 2;
    grant('loans');
    grant('managers');
  }
}

/**
 * Проверка полей v7: отсутствующие получают значения по умолчанию (В2), испорченные — сохранение отклоняется.
 */
function validCompany(s: GameState): boolean {
  for (const k of ['salaries', 'borrowed', 'repaid', 'interest'] as const) {
    if (typeof s.totals[k] !== 'number') s.totals = { ...s.totals, [k]: 0 };
    if (!Number.isFinite(s.totals[k]) || s.totals[k] < 0) return false;
  }
  const m = s.managers as unknown;
  if (!isRecord(m) || typeof m.dispatcher !== 'boolean' || typeof m.mechanic !== 'boolean') return false;
  if (typeof m.reserve !== 'number' || !Number.isFinite(m.reserve) || m.reserve < 0) return false;
  const l = s.loan as unknown;
  if (l !== null) {
    if (!isRecord(l)) return false;
    const ok = (v: unknown, min: number) => typeof v === 'number' && Number.isFinite(v) && v >= min;
    if (!ok(l.principal, 1) || !ok(l.start, 0) || !ok(l.rate, 0) || !ok(l.term, 1)) return false;
  }
  return true;
}

/**
 * Проверка полей v6 (В2: поле, которого нет, получает значение по умолчанию; испорченное — сохранение отклоняется).
 * Уровни — целые от 0 до максимума, только известные технологии; активное исследование — известная технология
 * не на максимуме, остаток — конечное неотрицательное число.
 */
function validResearch(s: GameState): boolean {
  if (typeof s.totals.research !== 'number') s.totals = { ...s.totals, research: 0 };
  if (!Number.isFinite(s.totals.research) || s.totals.research < 0) return false;
  if (!Array.isArray(s.features) || s.features.some((f) => !FEATURES.includes(f))) return false;
  const r = s.research as unknown;
  if (!isRecord(r) || !isRecord(r.levels)) return false;
  for (const [id, lvl] of Object.entries(r.levels)) {
    if (!(TECH_IDS as readonly string[]).includes(id)) return false;
    const max = TECHS[id as keyof typeof TECHS].levels.length;
    if (typeof lvl !== 'number' || !Number.isInteger(lvl) || lvl < 0 || lvl > max) return false;
  }
  if (r.active !== null) {
    if (!isRecord(r.active)) return false;
    const { id, remaining } = r.active;
    if (typeof id !== 'string' || !(TECH_IDS as readonly string[]).includes(id)) return false;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) return false;
    if (((r.levels as Record<string, number>)[id] ?? 0) >= TECHS[id as keyof typeof TECHS].levels.length) return false;
  }
  return true;
}

/** Индекс цели «Переработка» в цепочке (вставлена в v5 перед «Нефтяной компанией»). */
const REFINING_OBJECTIVE = 10;

/**
 * v4 → v5: НПЗ. Новые поля учёта — нулевые, пороги продуктов — 0 (продавать сразу). В цепочку целей вставлена
 * «Переработка» перед «Нефтяной компанией»: у тех, кто уже прошёл «Стабильную прибыль» (индекс ≥ 10), номер
 * цели сдвигается на одну (новую цель пропускают, награды за неё нет), а НПЗ сразу открыт — как дала бы та цель.
 */
function migrateV4(s: GameState, reference: GameState): void {
  s.totals = { ...reference.totals, ...s.totals, refined: 0, productsMade: [0, 0, 0], productsSold: [0, 0, 0], productRevenue: 0 };
  s.productThresholds = [0, 0, 0];
  const fix = (b: GameState['stats']['current']) => ({ ...b, refined: b.refined ?? 0, productRevenue: b.productRevenue ?? 0 });
  s.stats = { ...s.stats, current: fix(s.stats.current), buckets: s.stats.buckets.map(fix) };
  if (s.objectiveIndex >= REFINING_OBJECTIVE) {
    s.objectiveIndex += 1;
    if (!s.unlocked.includes('refinery')) s.unlocked = [...s.unlocked, 'refinery'];
  }
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
