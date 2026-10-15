import * as core from '../core';
import type { GameState } from '../core';
import { money, num } from './format';

/** Окно графиков, минут. */
type Range = 60 | 240;

interface Series {
  field: core.HistoryField;
  color: string;
  label: string;
}

/** Графики панели: на одном графике — одна или две серии в общих единицах. */
const CHARTS: Array<{ title: string; series: Series[]; fmt: (v: number) => string }> = [
  { title: 'Добыча, барр./мин', series: [{ field: 'produced', color: '#d4a017', label: 'добыча' }], fmt: (v) => num(v) },
  {
    title: 'Выручка и прибыль, $/мин',
    series: [
      { field: 'revenue', color: '#6fb2cf', label: 'выручка' },
      { field: 'profit', color: '#6fcf7a', label: 'прибыль' },
    ],
    fmt: (v) => money(v),
  },
  { title: 'Цена лёгкой нефти, $/барр.', series: [{ field: 'price', color: '#c9c4b8', label: 'цена' }], fmt: (v) => `$${v.toFixed(1)}` },
  {
    title: 'Касса и долг, $',
    series: [
      { field: 'cash', color: '#6fcf7a', label: 'касса' },
      { field: 'debt', color: '#ef6b5b', label: 'долг' },
    ],
    fmt: (v) => money(v),
  },
];

const CHART_H = 64;
const GAP = 34;

/**
 * Панель «Статистика» (веха 0.5, этап 4): графики за 1 ч и 4 ч из кольцевого буфера ядра (core/history.ts),
 * отметки выполненных целей (золотые) и исследований (голубые). Перерисовывается, только когда закрылась
 * новая минута или сменилось окно. Без библиотек — Canvas 2D.
 */
export class StatsPanel {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private body: HTMLElement;
  private range: Range = 60;
  private drawnKey = '';
  private open: boolean;

  constructor(openByDefault: boolean) {
    this.open = openByDefault;
    this.el = document.createElement('div');
    this.el.className = 'panel stats';
    const head = document.createElement('h3');
    head.className = 'stats-head';
    head.onclick = () => this.toggle();
    this.el.append(head);
    this.body = document.createElement('div');
    this.body.className = 'stats-body';
    const ranges = document.createElement('div');
    ranges.className = 'stats-ranges';
    for (const [r, label] of [[60, '1 час'], [240, '4 часа']] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.range = String(r);
      b.onclick = () => {
        this.range = r;
        this.drawnKey = '';
      };
      ranges.append(b);
    }
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stats-chart';
    const legend = document.createElement('div');
    legend.className = 'small';
    legend.innerHTML = '<span style="color:#d4a017">│</span> выполнена цель · <span style="color:#5ac8e6">│</span> исследование · точка — минута игрового времени, офлайн тоже пишется';
    this.body.append(ranges, this.canvas, legend);
    this.el.append(this.body);
    this.setOpen(this.open);
  }

  private toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.body.style.display = on ? '' : 'none';
    (this.el.querySelector('.stats-head') as HTMLElement).textContent = `Статистика ${on ? '▾' : '▸'}`;
    this.drawnKey = '';
  }

  update(s: GameState): void {
    if (!this.open || this.el.offsetParent === null) return;
    const w = Math.max(160, Math.round(this.body.clientWidth));
    const key = `${s.history.total}:${this.range}:${w}`;
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('[data-range]')) b.classList.toggle('active', Number(b.dataset.range) === this.range);
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.draw(s, w);
  }

  private draw(s: GameState, w: number): void {
    const dpr = window.devicePixelRatio || 1;
    const h = CHARTS.length * (CHART_H + GAP);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    const pts = core.historyPoints(s.history, this.range);
    const last = s.history.total; // номер текущей (незакрытой) минуты
    const first = last - this.range;
    const xOf = (minute: number) => ((minute + 0.5 - first) / this.range) * w;
    CHARTS.forEach((chart, ci) => {
      const top = ci * (CHART_H + GAP) + 15;
      ctx.fillStyle = '#9aa6b2';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(chart.title, 0, top - 3);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, top, w, CHART_H);
      if (pts.length === 0) {
        ctx.fillStyle = '#6b7682';
        ctx.fillText('данных пока нет — точка появляется раз в минуту', 6, top + CHART_H / 2);
        return;
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) for (const sr of chart.series) {
        lo = Math.min(lo, p[sr.field]);
        hi = Math.max(hi, p[sr.field]);
      }
      if (chart.series[0].field !== 'price') lo = Math.min(lo, 0);
      if (hi - lo < 1e-9) hi = lo + 1;
      const yOf = (v: number) => top + CHART_H - ((v - lo) / (hi - lo)) * CHART_H;
      if (lo < 0 && hi > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.moveTo(0, yOf(0));
        ctx.lineTo(w, yOf(0));
        ctx.stroke();
      }
      // Отметки целей и исследований.
      for (const m of s.history.marks) {
        if (m.minute < first || m.minute > last) continue;
        ctx.strokeStyle = m.kind === 'goal' ? 'rgba(212,160,23,0.75)' : 'rgba(90,200,230,0.6)';
        ctx.beginPath();
        ctx.moveTo(xOf(m.minute), top);
        ctx.lineTo(xOf(m.minute), top + CHART_H);
        ctx.stroke();
      }
      for (const sr of chart.series) {
        ctx.strokeStyle = sr.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(xOf(p.minute), yOf(p[sr.field])) : ctx.moveTo(xOf(p.minute), yOf(p[sr.field]))));
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      // Подписи: максимум сверху, последнее значение серий справа внизу.
      ctx.fillStyle = '#6b7682';
      ctx.textAlign = 'right';
      ctx.fillText(chart.fmt(hi), w - 2, top + 11);
      const lastP = pts[pts.length - 1];
      ctx.textAlign = 'left';
      let x = 2;
      for (const sr of chart.series) {
        const text = `${sr.label} ${chart.fmt(lastP[sr.field])}`;
        ctx.fillStyle = sr.color;
        ctx.fillText(text, x, top + CHART_H + 13);
        x += ctx.measureText(text).width + 10;
      }
    });
  }
}
