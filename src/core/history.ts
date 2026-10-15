import { HISTORY } from './config';
import { loanDebt } from './economy';
import type { GameState, HistoryState } from './types';

/**
 * Статистика за длительный период (веха 0.5, этап 4): кольцевой буфер минутных корзин игрового времени.
 * Поля корзины (HISTORY_FIELDS): добыча (барр.), выручка ($), операционная прибыль ($) за минуту, средняя цена
 * лёгкой нефти ($/барр.), касса и долг по кредиту на конце минуты ($). Корзина закрывается внутри tick, поэтому
 * офлайн дописывает точки так же, как игра. Отметки — завершённые цели и исследования (номер минуты).
 */
export const HISTORY_FIELDS = ['produced', 'revenue', 'profit', 'price', 'cash', 'debt'] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];
const F = HISTORY_FIELDS.length;

export function emptyHistory(s?: GameState): HistoryState {
  return {
    data: [],
    head: 0,
    total: 0,
    acc: { t: 0, produced: s?.totals.produced ?? 0, revenue: s?.totals.revenue ?? 0, expenses: s?.totals.expenses ?? 0, price: 0 },
    marks: [],
  };
}

/** Шаг накопления: цена — интеграл по времени; на границе минуты корзина закрывается. */
export function advanceHistory(s: GameState, dt: number): void {
  const h = s.history;
  h.acc.t += dt;
  h.acc.price += s.market.price * dt;
  // Допуск: сумма шагов 0,1 с не даёт ровно 60.
  if (h.acc.t < HISTORY.minute - 1e-6) return;
  const t = s.totals;
  const point = [
    t.produced - h.acc.produced,
    t.revenue - h.acc.revenue,
    t.revenue - h.acc.revenue - (t.expenses - h.acc.expenses),
    h.acc.price / h.acc.t,
    s.cash,
    loanDebt(s),
  ];
  pushPoint(h, point);
  h.acc = { t: 0, produced: t.produced, revenue: t.revenue, expenses: t.expenses, price: 0 };
}

function pushPoint(h: HistoryState, point: number[]): void {
  if (h.data.length < HISTORY.points * F) {
    h.data.push(...point);
  } else {
    // Буфер полон: новая точка на место самой старой, начало сдвигается.
    for (let k = 0; k < F; k++) h.data[h.head * F + k] = point[k];
    h.head = (h.head + 1) % HISTORY.points;
  }
  h.total++;
  // Отметки старше буфера не нужны.
  const first = h.total - historyLength(h);
  while (h.marks.length && h.marks[0].minute < first) h.marks.shift();
}

export function historyLength(h: HistoryState): number {
  return h.data.length / F;
}

/** Точки за последние n минут (от старой к новой) с абсолютным номером минуты. */
export function historyPoints(h: HistoryState, n = HISTORY.points): Array<{ minute: number } & Record<HistoryField, number>> {
  const len = historyLength(h);
  const count = Math.min(n, len);
  const out = [];
  for (let i = len - count; i < len; i++) {
    const slot = (h.head + i) % len;
    const p = { minute: h.total - len + i } as { minute: number } & Record<HistoryField, number>;
    HISTORY_FIELDS.forEach((f, k) => (p[f] = h.data[slot * F + k]));
    out.push(p);
  }
  return out;
}

/** Отметка на текущей (незакрытой) минуте. */
export function addHistoryMark(s: GameState, kind: 'goal' | 'tech', label: string): void {
  s.history.marks.push({ minute: s.history.total, kind, label });
  if (s.history.marks.length > HISTORY.marks) s.history.marks.shift();
}

/** Проверка поля при загрузке: нет — пустая история (версия не повышается), испорчено — false. */
export function validHistory(s: GameState): boolean {
  const h = s.history as unknown;
  if (h === undefined) {
    s.history = emptyHistory(s);
    return true;
  }
  if (typeof h !== 'object' || h === null) return false;
  const v = h as HistoryState;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!Array.isArray(v.data) || v.data.length % F !== 0 || v.data.length > HISTORY.points * F || !v.data.every(num)) return false;
  const len = v.data.length / F;
  if (!Number.isInteger(v.head) || v.head < 0 || (len < HISTORY.points ? v.head !== 0 : v.head >= HISTORY.points)) return false;
  if (!Number.isInteger(v.total) || v.total < len) return false;
  const a = v.acc;
  if (!a || ![a.t, a.produced, a.revenue, a.expenses, a.price].every(num)) return false;
  if (!Array.isArray(v.marks) || v.marks.some((m) => !m || !Number.isInteger(m.minute) || (m.kind !== 'goal' && m.kind !== 'tech') || typeof m.label !== 'string')) return false;
  return true;
}
