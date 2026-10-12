import * as core from './core';
import type { BuildableType, GameState } from './core';
import type { Renderer } from './render/renderer';
import { money } from './ui/format';

export type Selection = { kind: 'building'; id: number } | { kind: 'parcel'; px: number; py: number } | null;
export type ToastKind = 'info' | 'good' | 'bad';

/**
 * Связующее звено между симуляцией, рендером и интерфейсом.
 * Все действия игрока проходят здесь: вызов логики ядра + обратная связь (подсказки, всплывающий текст).
 */
export class Game {
  speed = 1;
  mode: BuildableType | null = null;
  selection: Selection = null;
  hover: { x: number; y: number } | null = null;
  /** Курсор над окружением за границей игровой карты. */
  hoverOutside = false;
  onToast: (text: string, kind: ToastKind) => void = () => {};

  constructor(
    public state: GameState,
    private renderer: Renderer,
  ) {}

  setMode(type: BuildableType | null): void {
    if (type && !this.state.unlocked.includes(type)) {
      this.onToast('Здание ещё не открыто — выполняйте цели', 'bad');
      return;
    }
    this.mode = this.mode === type ? null : type;
    if (this.mode) this.selection = null;
  }

  cancel(): void {
    if (this.mode) this.mode = null;
    else this.selection = null;
  }

  click(x: number, y: number): void {
    const s = this.state;
    if (this.mode) {
      const type = this.mode;
      const cost = core.buildCost(s, type);
      const r = core.build(s, type, x, y);
      if (!r.ok) return this.onToast(r.reason, 'bad');
      this.renderer.floatText(x + 0.5, y + 0.5, `−${money(cost)}`, '#ff9d8a');
      return;
    }
    if (!core.inBounds(s, x, y)) {
      this.selection = null;
      return;
    }
    const b = core.buildingAt(s, x, y);
    if (b) {
      this.selection = { kind: 'building', id: b.id };
      return;
    }
    const { px, py } = core.parcelOf(x, y);
    this.selection = core.isParcelOwned(s, px, py) ? null : { kind: 'parcel', px, py };
  }

  upgrade(id: number): void {
    const b = core.getBuilding(this.state, id);
    const cost = b ? core.upgradeCost(b) : null;
    const r = core.upgrade(this.state, id);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    if (b && cost) this.renderer.floatText(b.x + 0.5, b.y + 0.5, `Уровень ${b.level}`, '#9fe8ff');
  }

  demolish(id: number): void {
    const b = core.getBuilding(this.state, id);
    const refund = b ? core.demolishRefund(b) : 0;
    const r = core.demolish(this.state, id);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    this.selection = null;
    if (b) this.renderer.floatText(b.x + 0.5, b.y + 0.5, `+${money(refund)}`);
  }

  toggle(id: number): void {
    const r = core.toggleEnabled(this.state, id);
    if (!r.ok) this.onToast(r.reason, 'bad');
  }

  sell(): void {
    const r = core.sellManual(this.state);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    const hq = this.state.buildings.find((b) => b.type === 'hq');
    if (hq) this.renderer.floatText(hq.x + 0.5, hq.y + 0.5, `+${money(r.revenue)}`);
    this.renderer.manualSale();
  }

  buyParcel(px: number, py: number): void {
    const r = core.buyParcel(this.state, px, py);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    this.selection = null;
    this.onToast('Участок куплен — новая территория ваша', 'good');
  }

  /** Шаг симуляции + реакция на события. */
  step(dt: number): void {
    const ev = core.tick(this.state, dt);
    if (ev.autoRevenue > 0) this.renderer.addTerminalRevenue(this.state, ev.autoRevenue);
    for (const o of ev.completed) this.announce(o);
  }

  announce(o: core.Objective): void {
    const unlocks = o.unlocks?.map((t) => core.BUILDINGS[t].name).join(', ');
    const reward = o.reward > 0 ? ` +${money(o.reward)}` : '';
    this.onToast(`Цель выполнена: «${o.title}»${reward}${unlocks ? `. Открыто: ${unlocks}` : ''}`, 'good');
  }
}
