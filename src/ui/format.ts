const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function money(n: number): string {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}$${nf2.format(a / 1e6)} млн`;
  return `${sign}$${nf.format(a)}`;
}

export function price(n: number): string {
  return `$${nf2.format(n)}`;
}

export function bbl(n: number): string {
  return `${nf.format(n)} барр.`;
}

export function rate(n: number, unit = 'барр./мин'): string {
  return `${nf1.format(n)} ${unit}`;
}

export function num(n: number): string {
  return nf.format(n);
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин`;
  return `${Math.floor(seconds)} с`;
}
