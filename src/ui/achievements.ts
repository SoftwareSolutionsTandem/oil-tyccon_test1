import * as core from '../core';
import type { GameState } from '../core';

/**
 * Панель «Достижения» (M06-GOALS): значки за вехи развития вне цепочки целей и звание компании по их числу.
 * Награды — только значок и звание. Перерисовывается, только когда изменилось число достижений.
 */
export class AchievementsPanel {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private open: boolean;
  private drawn = -1;
  private count = 0;

  constructor(openByDefault: boolean) {
    this.open = openByDefault;
    this.el = document.createElement('div');
    this.el.className = 'panel achievements';
    this.head = document.createElement('h3');
    this.head.className = 'ach-head';
    this.head.onclick = () => this.setOpen(!this.open);
    this.body = document.createElement('div');
    this.body.className = 'ach-body';
    this.el.append(this.head, this.body);
    this.setOpen(this.open);
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.body.style.display = on ? '' : 'none';
    this.drawn = -1;
    this.renderHead();
  }

  private renderHead(): void {
    this.head.textContent = `Достижения ${this.count}/${core.ACHIEVEMENTS.length} ${this.open ? '▾' : '▸'}`;
  }

  update(s: GameState): void {
    const n = s.achievements.length;
    if (n !== this.count) {
      this.count = n;
      this.renderHead();
    }
    if (!this.open || this.drawn === n) return;
    this.drawn = n;
    const got = new Set(s.achievements);
    const rank = core.companyRank(s);
    const next = core.RANKS.find(([k]) => k > n);
    const items = core.ACHIEVEMENTS.map((a) => {
      const on = got.has(a.id);
      return `<div class="ach${on ? ' got' : ''}" data-ach="${a.id}" title="${a.description}"><span class="icon">${on ? a.icon : '🔒'}</span><span class="text"><b>${a.title}</b><span class="small">${a.description}</span></span></div>`;
    });
    this.body.innerHTML = `<div class="rank">Звание: <b>${rank}</b>${next ? ` <span class="small">· до «${next[1]}» — ещё ${next[0] - n}</span>` : ''}</div><div class="ach-list">${items.join('')}</div>`;
  }
}
