import * as core from './core';
import type { BuildableType, GameState } from './core';
import type { Renderer } from './render/renderer';
import { money } from './ui/format';

export type Selection =
  | { kind: 'building'; id: number }
  | { kind: 'parcel'; px: number; py: number }
  | { kind: 'pipe'; x: number; y: number }
  | null;
/** Инструменты трубопровода: промысловая труба, магистраль, демонтаж. */
export type PipeTool = 'pipe' | 'trunk' | 'unpipe';
export type Mode = BuildableType | PipeTool;

export const PIPE_TOOLS: Record<PipeTool, { kind: 1 | 2 | 0; name: string; hotkey: string }> = {
  pipe: { kind: 1, name: 'Промысловая труба', hotkey: '4' },
  trunk: { kind: 2, name: 'Магистраль', hotkey: '5' },
  unpipe: { kind: 0, name: 'Демонтаж трубы', hotkey: 'X' },
};

export function isPipeTool(m: Mode | null): m is PipeTool {
  return m === 'pipe' || m === 'trunk' || m === 'unpipe';
}

/** Предпросмотр прокладки или демонтажа трубы под курсором. */
export interface PipePreview {
  tool: PipeTool;
  /** Все клетки протяжки (для подсветки). */
  path: core.PipeTile[];
  ok: boolean;
  reason?: string;
  /** Стоимость прокладки или сумма возврата при демонтаже. */
  cost: number;
  /** Клетки, которые реально изменятся. */
  count: number;
}
export type ToastKind = 'info' | 'good' | 'bad';

/**
 * Связующее звено между симуляцией, рендером и интерфейсом.
 * Все действия игрока проходят здесь: вызов логики ядра + обратная связь (подсказки, всплывающий текст).
 */
export class Game {
  speed = 1;
  mode: Mode | null = null;
  /** Начало протяжки трубы (клетка, где нажата кнопка мыши). */
  pipeStart: core.PipeTile | null = null;
  selection: Selection = null;
  hover: { x: number; y: number } | null = null;
  /** Курсор над окружением за границей игровой карты. */
  hoverOutside = false;
  onToast: (text: string, kind: ToastKind) => void = () => {};

  constructor(
    public state: GameState,
    private renderer: Renderer,
  ) {}

  setMode(type: Mode | null): void {
    this.pipeStart = null;
    if (type && !isPipeTool(type) && !this.state.unlocked.includes(type)) {
      this.onToast('Здание ещё не открыто — выполняйте цели', 'bad');
      return;
    }
    this.mode = this.mode === type ? null : type;
    if (this.mode) this.selection = null;
  }

  cancel(): void {
    if (this.pipeStart) this.pipeStart = null;
    else if (this.mode) this.mode = null;
    else this.selection = null;
  }

  click(x: number, y: number): void {
    const s = this.state;
    if (isPipeTool(this.mode)) return; // трубы прокладываются протяжкой: pipeDown/pipeUp
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
    if (s.map.pipes[core.tileIndex(s, x, y)] > 0) {
      this.selection = { kind: 'pipe', x, y };
      return;
    }
    const { px, py } = core.parcelOf(x, y);
    this.selection = core.isParcelOwned(s, px, py) ? null : { kind: 'parcel', px, py };
  }

  // ——— Трубопроводы ———

  pipeDown(x: number, y: number): void {
    this.pipeStart = [x, y];
  }

  /** Предпросмотр от точки нажатия (или от клетки под курсором) до курсора. */
  pipePreview(): PipePreview | null {
    const tool = this.mode;
    if (!isPipeTool(tool) || !this.hover) return null;
    const end: core.PipeTile = [this.hover.x, this.hover.y];
    const path = core.pipePath(this.pipeStart ?? end, end);
    const s = this.state;
    if (tool === 'unpipe') {
      let cost = 0;
      let count = 0;
      for (const [x, y] of path) {
        const have = core.inBounds(s, x, y) ? s.map.pipes[core.tileIndex(s, x, y)] : 0;
        if (have === 1 || have === 2) {
          cost += Math.round(core.PIPES[have].cost * core.PIPE_REFUND);
          count++;
        }
      }
      return { tool, path, ok: count > 0, reason: count > 0 ? undefined : 'Здесь нет трубы', cost, count };
    }
    const plan = core.planPipes(s, path, PIPE_TOOLS[tool].kind as 1 | 2);
    return { tool, path, ok: plan.ok, reason: plan.reason, cost: plan.cost, count: plan.tiles.length };
  }

  pipeUp(x: number, y: number): void {
    const tool = this.mode;
    if (!isPipeTool(tool)) return;
    const path = core.pipePath(this.pipeStart ?? [x, y], [x, y]);
    this.pipeStart = null;
    const s = this.state;
    const [mx, my] = path[Math.floor(path.length / 2)];
    if (tool === 'unpipe') {
      const r = core.removePipes(s, path);
      if (!r.ok) return this.onToast(r.reason!, 'bad');
      this.renderer.floatText(mx + 0.5, my + 0.5, `+${money(r.refund)}`);
      return;
    }
    const plan = core.planPipes(s, path, PIPE_TOOLS[tool].kind as 1 | 2);
    const r = core.layPipes(s, path, PIPE_TOOLS[tool].kind as 1 | 2);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    this.renderer.floatText(mx + 0.5, my + 0.5, `−${money(plan.cost)}`, '#ff9d8a');
  }

  /** Кнопка «Подключить»: кратчайшая труба до сети с хранилищем. */
  connect(id: number): void {
    const plan = core.planAutoConnect(this.state, id);
    const r = core.autoConnect(this.state, id);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    const b = core.getBuilding(this.state, id);
    if (b) this.renderer.floatText(b.x + 0.5, b.y + 0.5, `−${money(plan.cost)}`, '#ff9d8a');
    this.onToast(`Проложено ${plan.tiles.length} кл. трубы`, 'good');
  }

  /** Вариант подключения из панели здания (кратчайший или отдельная ветка с учётом загрузки сети). */
  connectOption(id: number, idx: number): void {
    const o = core.connectOptions(this.state, id)[idx];
    if (!o) return this.onToast('Вариант подключения устарел — выберите снова', 'bad');
    const r = core.applyConnect(this.state, o);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    const b = core.getBuilding(this.state, id);
    if (b) this.renderer.floatText(b.x + 0.5, b.y + 0.5, `−${money(o.cost)}`, '#ff9d8a');
    const extra = o.upgrades.length ? `, ${o.upgrades.length} кл. заменено магистралью` : '';
    this.onToast(`Проложено ${o.tiles.length} кл. трубы${extra}`, 'good');
  }

  /** Замена промысловых участков маршрута магистралью. */
  upgradeRoute(id: number): void {
    const plan = core.planRouteUpgrade(this.state, id);
    if (!plan.ok) return this.onToast(plan.reason!, 'bad');
    const r = core.layPipes(this.state, plan.tiles, 2);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    this.onToast(`Маршрут усилен магистралью: ${plan.tiles.length} кл. за ${money(plan.cost)}`, 'good');
  }

  /** Улучшение или демонтаж одной клетки трубы из панели выбора. */
  pipeTile(x: number, y: number, action: 'upgrade' | 'remove'): void {
    const s = this.state;
    if (action === 'upgrade') {
      const r = core.layPipes(s, [[x, y]], 2);
      if (!r.ok) return this.onToast(r.reason, 'bad');
      this.renderer.floatText(x + 0.5, y + 0.5, `−${money(core.PIPES[2].cost - core.PIPES[1].cost)}`, '#ff9d8a');
      return;
    }
    const r = core.removePipes(s, [[x, y]]);
    if (!r.ok) return this.onToast(r.reason!, 'bad');
    this.selection = null;
    this.renderer.floatText(x + 0.5, y + 0.5, `+${money(r.refund)}`);
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

  surveyParcel(px: number, py: number, level: number): void {
    const cost = core.surveyCost(this.state, level);
    const r = core.survey(this.state, px, py, level);
    if (!r.ok) return this.onToast(r.reason, 'bad');
    this.onToast(`${core.SURVEY_LEVELS[level - 1].name}: −${money(cost)}. Оценка — в панели участка`, 'good');
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
