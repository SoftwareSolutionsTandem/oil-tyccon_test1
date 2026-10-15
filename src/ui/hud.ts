import * as core from '../core';
import type { BuildableType, Building, GameState } from '../core';
import { isPipeTool, PIPE_TOOLS, type Game, type PipeTool, type ToastKind } from '../game';
import { formatClock } from '../render/daylight';
import { bbl, duration, money, num, price, rate } from './format';

const BUILDABLE: BuildableType[] = ['pumpjack', 'tank', 'terminal', 'refinery', 'platform'];

/** Вкладки нижнего листа на узком экране. */
type MobileTab = 'build' | 'objective' | 'finance' | 'tech' | 'company';
const MOBILE_TABS: Array<[MobileTab, string]> = [
  ['build', 'Стройка'],
  ['objective', 'Цель'],
  ['finance', 'Финансы'],
  ['tech', 'Технологии'],
  ['company', 'Компания'],
];
/** Узкий экран: нижний лист вместо боковых колонок. Десктоп не меняется. */
const MOBILE_QUERY = '(max-width: 600px)';

const STATUS_TEXT: Record<Building['status'], [string, 'ok' | 'warn' | 'bad']> = {
  ok: ['Работает', 'ok'],
  off: ['Законсервировано', 'warn'],
  depleted: ['Месторождение исчерпано', 'bad'],
  full: ['Простой: хранилище заполнено', 'bad'],
  waiting_price: ['Ждёт цену выше порога', 'warn'],
  no_oil: ['Нет нефти для отгрузки', 'warn'],
  no_route: ['Не подключено к хранилищу', 'bad'],
  throttled: ['Ограничено пропускной способностью трубы', 'warn'],
  wrong_grade: ['Простой: нет хранилища для этого сорта', 'bad'],
  no_feed: ['Нет сырья подходящего сорта', 'warn'],
  waiting_margin: ['Переработка сейчас невыгодна', 'warn'],
  product_full: ['Склад нефтепродукта заполнен', 'bad'],
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html) e.innerHTML = html;
  return e;
}

function kv(k: string, v: string, cls = ''): string {
  return `<div class="kv ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

/** Интерфейс поверх холста: DOM создаётся один раз, затем обновляются только значения. */
export class Hud {
  private root: HTMLElement;
  private refs: Record<string, HTMLElement> = {};
  private buildCards = new Map<BuildableType, HTMLButtonElement>();
  private pipeCards = new Map<PipeTool, HTMLButtonElement>();
  private speedButtons = new Map<number, HTMLButtonElement>();
  private selectionPanel: HTMLElement;
  private selectionInfo: HTMLElement;
  private selectionActions: HTMLElement;
  private selectionKey = '';
  private toastBox: HTMLElement;
  private sparkline: HTMLCanvasElement;
  private wasNegative = false;
  private techCards = new Map<core.TechId, HTMLElement>();
  /** Панели HUD — для переноса в нижний лист на узком экране. */
  private panels: Record<string, HTMLElement> = {};
  private mobile = false;
  private activeTab: MobileTab | null = null;
  private sheet!: HTMLElement;
  private selSheet!: HTMLElement;
  /** Подтверждение стройки касанием (узкий экран). */
  private confirmBar!: HTMLElement;

  constructor(
    private game: Game,
    private handlers: {
      newGame: () => void;
      dayNight: () => boolean;
      toggleDayNight: () => void;
      hour: () => number;
    },
  ) {
    this.root = document.getElementById('hud')!;
    this.root.append(this.buildTopbar(), this.buildLeft(), this.buildRight());
    this.selectionPanel = this.root.querySelector('.selection')!;
    this.selectionInfo = this.selectionPanel.querySelector('.info')!;
    this.selectionActions = this.selectionPanel.querySelector('.actions')!;
    this.sparkline = this.root.querySelector('canvas.spark')!;
    this.refs.hint = this.root.appendChild(el('div', 'hint panel'));
    this.buildMobile();
    this.toastBox = this.root.appendChild(el('div', 'toasts'));
    game.onToast = (text, kind) => this.toast(text, kind);
  }

  /**
   * Узкий экран: панели переносятся в нижний лист с вкладками (по умолчанию свёрнут — видна только строка вкладок),
   * выбранное здание — в отдельный лист с кнопкой закрытия. На широком экране панели возвращаются в колонки.
   */
  private buildMobile(): void {
    this.sheet = el('div', 'sheet panel');
    const tabs = el('div', 'tabs');
    for (const [id, label] of MOBILE_TABS) {
      const b = el('button', '', label);
      b.dataset.tab = id;
      b.onclick = () => this.setTab(this.activeTab === id ? null : id);
      tabs.append(b);
    }
    this.sheet.append(el('div', 'sheet-body'), tabs);
    this.selSheet = el('div', 'sel-sheet panel');
    const close = el('button', 'close', '✕');
    close.title = 'Закрыть';
    close.onclick = () => this.game.cancel();
    this.selSheet.append(close);
    this.confirmBar = el('div', 'confirm-bar panel', '<span class="text"></span>');
    const yes = el('button', 'primary', 'Построить ✓');
    yes.dataset.role = 'confirm-yes';
    const no = el('button', '', '✕');
    no.dataset.role = 'confirm-no';
    this.confirmBar.append(yes, no);
    this.root.append(this.sheet, this.selSheet, this.confirmBar);
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => this.setMobile(mq.matches);
    mq.addEventListener('change', apply);
    apply();
  }

  private setMobile(on: boolean): void {
    this.mobile = on;
    document.body.classList.toggle('mobile', on);
    const left = this.root.querySelector('.left')!;
    const right = this.root.querySelector('.right')!;
    const body = this.sheet.querySelector('.sheet-body')!;
    if (on) {
      for (const [id] of MOBILE_TABS) {
        this.panels[id].dataset.tab = id;
        body.append(this.panels[id]);
      }
      this.selSheet.append(this.panels.selection);
    } else {
      left.append(this.panels.build, this.panels.objective, this.panels.tech);
      right.append(this.panels.selection, this.panels.finance, this.panels.company);
    }
    this.setTab(this.activeTab);
  }

  private setTab(tab: MobileTab | null): void {
    this.activeTab = tab;
    for (const [id] of MOBILE_TABS) {
      this.panels[id].classList.toggle('tab-hidden', this.mobile && id !== tab);
      this.sheet.querySelector(`[data-tab=${id}]`)?.classList.toggle('active', id === tab);
    }
    this.sheet.classList.toggle('open', tab !== null);
  }

  /** Узкий экран: выбор места для стройки касанием ждёт подтверждения. null — убрать панель. */
  showBuildConfirm(text: string | null, ok: boolean, onYes: () => void, onNo: () => void): void {
    this.confirmBar.classList.toggle('open', text !== null);
    if (text === null) return;
    this.confirmBar.querySelector('.text')!.textContent = text;
    const yes = this.confirmBar.querySelector<HTMLButtonElement>('[data-role=confirm-yes]')!;
    yes.disabled = !ok;
    yes.onclick = onYes;
    this.confirmBar.querySelector<HTMLButtonElement>('[data-role=confirm-no]')!.onclick = onNo;
  }

  get isMobile(): boolean {
    return this.mobile;
  }

  private get s(): GameState {
    return this.game.state;
  }

  private buildTopbar(): HTMLElement {
    const bar = el('div', 'topbar panel');
    bar.innerHTML = `
      <div class="brand">OIL TYCOON</div>
      <div class="stat"><span class="label">Деньги</span><span class="value" data-ref="cash"></span></div>
      <div class="stat" style="min-width:150px"><span class="label">Нефть на складе</span><span class="value" data-ref="oil"></span><span class="sub" data-ref="oilgrades"></span><div class="bar" data-ref="oilbar"><div></div></div></div>
      <div class="stat"><span class="label">Цена нефти</span><div class="price-row"><span class="value" data-ref="price"></span><span class="trend" data-ref="trend"></span><canvas class="spark" width="110" height="28" style="width:110px;height:28px"></canvas></div><span class="sub" data-ref="heavyprice"></span></div>
      <div class="stat"><span class="label">Прибыль за минуту</span><span class="value" data-ref="profit"></span></div>
      <button class="primary" data-ref="sell" title="Продать всю нефть перекупщику со скидкой 20% (S)"></button>
      <div class="spacer"></div>
      <div class="stat" style="min-width:64px" title="Время суток. Сутки длятся 10 минут игры на скорости ×1"><span class="label">Время</span><span class="value" data-ref="clock"></span></div>
      <div class="speed"></div>
      <button data-ref="menu" title="Меню">☰</button>`;
    bar.querySelectorAll<HTMLElement>('[data-ref]').forEach((e) => (this.refs[e.dataset.ref!] = e));
    this.refs.sell.onclick = () => this.game.sell();
    this.refs.menu.onclick = () => this.showMenu();
    const speed = bar.querySelector('.speed')!;
    for (const [v, label] of [[0, '❚❚'], [1, '1×'], [2, '2×'], [4, '4×']] as const) {
      const b = el('button', '', label);
      b.title = v === 0 ? 'Пауза (пробел)' : `Скорость ${label}`;
      b.onclick = () => (this.game.speed = v);
      this.speedButtons.set(v, b);
      speed.append(b);
    }
    return bar;
  }

  private buildLeft(): HTMLElement {
    const left = el('div', 'left');
    const build = el('div', 'panel', '<h3>Строительство</h3>');
    for (const type of BUILDABLE) {
      const spec = core.BUILDINGS[type];
      const card = el('button', 'build-card');
      card.innerHTML = `<div class="row"><span><span class="name">${spec.name}</span><span class="key">${spec.hotkey}</span></span><span class="cost"></span></div><div class="meta"></div>`;
      card.title = spec.description;
      card.onclick = () => this.game.setMode(type);
      this.buildCards.set(type, card);
      build.append(card);
    }
    const pipes = el('div', 'tools');
    for (const tool of ['pipe', 'trunk', 'unpipe'] as PipeTool[]) {
      const spec = PIPE_TOOLS[tool];
      const card = el('button', 'build-card');
      const meta =
        spec.kind === 0
          ? `Возврат ${Math.round(core.PIPE_REFUND * 100)}% стоимости`
          : `Пропускная способность ${num(core.PIPES[spec.kind].capacity * 60)} барр./мин`;
      const cost = spec.kind === 0 ? '' : `${money(core.PIPES[spec.kind].cost)}/кл.`;
      card.innerHTML = `<div class="row"><span><span class="name">${spec.name}</span><span class="key">${spec.hotkey}</span></span><span class="cost">${cost}</span></div><div class="meta">${meta}</div>`;
      card.title =
        spec.kind === 0
          ? 'Протяните по трубам, которые нужно убрать'
          : `Протяните мышью от здания или трубы: труба ляжет по своей свободной земле уголком. Поверх промысловой трубы магистраль ляжет как улучшение. По морю (шельф) — в ${core.REGIONS[2].pipeCost} раза дороже.`;
      card.onclick = () => this.game.setMode(tool);
      this.pipeCards.set(tool, card);
      pipes.append(card);
    }
    build.append(el('h3', '', 'Трубопроводы'), pipes);
    const objective = el('div', 'panel objective', '<h3>Цель</h3><div class="body"></div>');
    this.refs.objective = objective.querySelector('.body')!;
    const tech = this.buildTech();
    this.panels.build = build;
    this.panels.objective = objective;
    this.panels.tech = tech;
    left.append(build, objective, tech);
    return left;
  }

  /** Панель «Технологии»: карточки создаются один раз, значения обновляются в updateTech. */
  private buildTech(): HTMLElement {
    const panel = el('div', 'panel tech', '<h3>Технологии</h3><div class="locked-note small"></div><div class="active-research"></div>');
    this.refs.techLocked = panel.querySelector('.locked-note')!;
    this.refs.techActive = panel.querySelector('.active-research')!;
    for (const id of core.TECH_IDS) {
      const spec = core.TECHS[id];
      const card = el('div', 'tech-card');
      card.dataset.tech = id;
      card.innerHTML = `<div class="row"><span class="name">${spec.name}</span><span class="lvl"></span></div><div class="effect small"></div><div class="payback small"></div><button class="go"></button>`;
      card.title = spec.description;
      card.querySelector<HTMLButtonElement>('button.go')!.onclick = () => this.game.research(id);
      this.techCards.set(id, card);
      panel.append(card);
    }
    return panel;
  }

  private buildRight(): HTMLElement {
    const right = el('div', 'right');
    const selection = el('div', 'panel selection', '<div class="info"></div><div class="actions"></div>');
    const finance = el('div', 'panel', '<h3>Финансы · последние 60 с</h3><div class="body"></div>');
    this.refs.finance = finance.querySelector('.body')!;
    const company = this.buildCompany();
    this.panels.selection = selection;
    this.panels.finance = finance;
    this.panels.company = company;
    right.append(selection, finance, company);
    return right;
  }

  /** Панель «Компания»: персонал и кредит. Кнопки создаются один раз, значения обновляются в updateCompany. */
  private buildCompany(): HTMLElement {
    const panel = el(
      'div',
      'panel company',
      `<h3>Персонал</h3><div class="staff-note small"></div>
       <div class="staff" data-role="dispatcher"><div class="row"><span class="name">${core.MANAGERS.dispatcher.name}</span><span class="pay small"></span></div><div class="small">Ведёт пороги цен нефти и продуктов: держит до цены выше средней, при заполнении складов продаёт всё.</div><button></button></div>
       <div class="staff" data-role="mechanic"><div class="row"><span class="name">${core.MANAGERS.mechanic.name}</span><span class="pay small"></span></div><div class="small">Улучшает качалку с лучшей окупаемостью (не дольше ${Math.round(core.MANAGERS.mechanic.payback / 60)} мин), не трогая резерв кассы.</div><label class="small">Резерв кассы, $ <input type="number" min="0" step="1000" data-role="reserve"></label><button></button></div>
       <h3 style="margin-top:10px">Кредит</h3><div class="loan-body small"></div><div class="row2"><button data-role="take"></button><button data-role="repay">Погасить досрочно</button></div>`,
    );
    for (const role of ['dispatcher', 'mechanic'] as const) {
      const box = panel.querySelector<HTMLElement>(`.staff[data-role=${role}]`)!;
      box.querySelector('button')!.onclick = () => this.game.setManager(role, !this.s.managers[role]);
    }
    const reserve = panel.querySelector<HTMLInputElement>('[data-role=reserve]')!;
    reserve.onchange = () => core.setManagerReserve(this.s, Number(reserve.value));
    panel.querySelector<HTMLButtonElement>('[data-role=take]')!.onclick = () => this.game.takeLoan();
    panel.querySelector<HTMLButtonElement>('[data-role=repay]')!.onclick = () => this.game.repayLoan();
    this.refs.company = panel;
    return panel;
  }

  update(): void {
    const s = this.s;
    const cap = core.storageCapacity(s);
    const minute = core.lastMinute(s);
    const profit = minute.revenue - minute.expenses;

    this.refs.cash.textContent = money(s.cash);
    this.refs.cash.classList.toggle('neg', s.cash < 0);
    if (s.cash < 0 && !this.wasNegative) this.toast('Касса ушла в минус: содержание зданий превышает доходы. Продайте нефть или законсервируйте лишнее.', 'bad');
    this.wasNegative = s.cash < 0;

    this.refs.oil.textContent = `${num(s.oil)} / ${num(cap)}`;
    const [light, heavy] = core.oilByGrade(s);
    this.refs.oilgrades.textContent = heavy > 0.5 ? `лёгк. ${num(light)} · тяж. ${num(heavy)}` : '';
    const fill = Math.min(1, s.oil / cap);
    (this.refs.oilbar.firstElementChild as HTMLElement).style.width = `${fill * 100}%`;
    this.refs.oilbar.classList.toggle('full', fill > 0.97);

    const hist = s.market.history;
    const prev = hist[Math.max(0, hist.length - 15)] ?? s.market.price;
    const diff = s.market.price - prev;
    this.refs.price.textContent = price(s.market.price);
    this.refs.heavyprice.textContent = `тяж. ${price(core.gradePrice(s, 1))} (−${Math.round(core.heavySpread(s) * 100)}%)`;
    this.refs.heavyprice.title = 'Тяжёлая нефть продаётся со скидкой к цене лёгкой. Скидка меняется по своему циклу: иногда разница почти исчезает.';
    this.refs.trend.textContent = diff > 0.5 ? '▲' : diff < -0.5 ? '▼' : '•';
    this.refs.trend.style.color = diff > 0.5 ? 'var(--good)' : diff < -0.5 ? 'var(--bad)' : 'var(--muted)';
    this.drawSparkline();

    this.refs.profit.textContent = money(profit);
    this.refs.profit.className = `value ${profit < 0 ? 'neg' : profit > 0 ? 'pos' : ''}`;
    this.refs.sell.textContent = `Продать ${num(s.oil)} барр. · ${money(core.manualSellValue(s))}`;
    (this.refs.sell as HTMLButtonElement).disabled = s.oil < 1;
    for (const [v, b] of this.speedButtons) b.classList.toggle('active', this.game.speed === v);
    const hour = this.handlers.hour();
    const dayTime = hour >= 6 && hour < 20;
    this.refs.clock.textContent = this.handlers.dayNight() ? `${dayTime ? '☀' : '☾'} ${formatClock(hour)}` : '☀ —';

    this.updateBuildCards();
    this.updateObjective();
    this.updateTech();
    this.updateFinance(minute, cap);
    this.updateCompany();
    this.updateSelection();
    this.updateHint();
  }

  private drawSparkline(): void {
    const c = this.sparkline;
    const ctx = c.getContext('2d')!;
    const h = this.s.market.history;
    ctx.clearRect(0, 0, c.width, c.height);
    if (h.length < 2) return;
    const min = Math.min(...h);
    const max = Math.max(...h);
    const span = Math.max(1, max - min);
    ctx.strokeStyle = '#d4a017';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    h.forEach((p, i) => {
      const x = (i / (h.length - 1)) * (c.width - 2) + 1;
      const y = c.height - 2 - ((p - min) / span) * (c.height - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (this.s.sellThreshold > min && this.s.sellThreshold < max && core.countOf(this.s, 'terminal') > 0) {
      const y = c.height - 2 - ((this.s.sellThreshold - min) / span) * (c.height - 4);
      ctx.strokeStyle = 'rgba(111,207,122,0.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(c.width, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private updateBuildCards(): void {
    const s = this.s;
    for (const [type, card] of this.buildCards) {
      const spec = core.BUILDINGS[type];
      const unlocked = s.unlocked.includes(type);
      const cost = core.buildCost(s, type);
      const lvl = spec.levels[0];
      card.classList.toggle('locked', !unlocked);
      card.classList.toggle('active', this.game.mode === type);
      card.querySelector('.cost')!.textContent = unlocked ? money(cost) : '🔒';
      let meta: string;
      if (unlocked) {
        meta = `${spec.valueLabel}: ${num(lvl.value * (type === 'tank' ? 1 : 60))} ${type === 'tank' ? 'барр.' : 'барр./мин'} · содержание ${money(lvl.upkeep * core.upkeepFactor(s) * 60)}/мин`;
      } else {
        const by = core.OBJECTIVES.find((o) => o.unlocks?.includes(type));
        meta = by ? `Откроется после цели «${by.title}»` : 'Пока недоступно';
      }
      const metaEl = card.querySelector('.meta')!;
      if (metaEl.textContent !== meta) metaEl.textContent = meta;
      card.disabled = unlocked && s.cash < cost && this.game.mode !== type;
    }
    for (const [tool, card] of this.pipeCards) card.classList.toggle('active', this.game.mode === tool);
  }

  private updateObjective(): void {
    const s = this.s;
    const o = core.currentObjective(s);
    if (!o) {
      this.refs.objective.innerHTML = '<div class="title">Все цели выполнены!</div><div class="desc">Вы построили нефтяную компанию. Продолжайте развитие — новые механики уже в планах.</div>';
      return;
    }
    const p = o.progress(s);
    const k = Math.max(0, Math.min(1, p.current / p.target));
    const isMoney = /revenue|cash|profit/.test(o.id);
    const fmt = (v: number) => (isMoney ? money(v) : num(v));
    this.refs.objective.innerHTML = `
      <div class="title">${o.title}</div>
      <div class="desc">${o.description}</div>
      <div class="progress"><span>${fmt(Math.max(0, p.current))} / ${fmt(p.target)}</span><span>${Math.floor(k * 100)}%</span></div>
      <div class="bar"><div style="width:${k * 100}%"></div></div>
      ${o.reward ? `<div class="reward">Награда: ${money(o.reward)}${o.unlocks ? ' · открывает: ' + o.unlocks.map((t) => core.BUILDINGS[t].name).join(', ') : ''}</div>` : ''}
      <div class="small" style="margin-top:6px">Цель ${s.objectiveIndex + 1} из ${core.OBJECTIVES.length}</div>`;
  }

  private updateTech(): void {
    const s = this.s;
    const open = s.features.includes('research');
    const by = core.OBJECTIVES.find((o) => o.features?.includes('research'));
    this.refs.techLocked.textContent = open ? '' : `Откроется после цели «${by?.title ?? '—'}»`;
    const a = s.research.active;
    if (a) {
      const lvl = (s.research.levels[a.id] ?? 0) + 1;
      const total = core.TECHS[a.id].levels[lvl - 1].time;
      const k = Math.max(0, Math.min(1, 1 - a.remaining / total));
      this.refs.techActive.innerHTML = `<div class="small">Идёт: ${core.TECHS[a.id].name} ${lvl} · осталось ${duration(Math.ceil(a.remaining))}</div><div class="bar"><div style="width:${k * 100}%"></div></div>`;
    } else this.refs.techActive.innerHTML = '';
    for (const [id, card] of this.techCards) {
      const level = core.techLevel(s, id);
      const max = core.TECHS[id].levels.length;
      const next = core.techNextLevel(s, id);
      card.classList.toggle('locked', !open);
      card.querySelector('.lvl')!.textContent = `${level}/${max}`;
      const btn = card.querySelector<HTMLButtonElement>('button.go')!;
      const effect = card.querySelector('.effect')!;
      const payback = card.querySelector('.payback')!;
      if (!next) {
        effect.textContent = 'Изучено полностью';
        payback.textContent = '';
        btn.style.display = 'none';
        continue;
      }
      btn.style.display = '';
      const e = core.techEffect(s, id);
      // Эффект следующего уровня для текущего промысла (по средним ценам, без учёта ограничений труб и сбыта).
      effect.textContent =
        id === 'standard'
          ? `Следующая качалка дешевле на ${money(e.pumpSaving)}`
          : id === 'energy'
            ? `Содержание −${money(e.upkeep * 60)}/мин`
            : `Добыча +${rate(e.rate * 60)} · ≈ +${money(e.profit * 60)}/мин`;
      payback.textContent =
        id === 'standard' ? `${next.level}-й уровень · ${duration(next.time)}` : `${next.level}-й уровень · ${duration(next.time)} · ${e.profit * 60 >= 1 ? `окупится за ${duration(next.cost / e.profit)}` : id === 'eor' ? 'эффект появится по мере истощения' : 'сейчас нет эффекта'}`;
      btn.textContent = `Исследовать · ${money(next.cost)}`;
      btn.disabled = !open || !!a || s.cash < next.cost;
    }
  }

  private updateCompany(): void {
    const s = this.s;
    const p = this.refs.company;
    const staffOpen = s.features.includes('managers');
    const loansOpen = s.features.includes('loans');
    const goal = (f: 'loans' | 'managers') => core.OBJECTIVES.find((o) => o.features?.includes(f))?.title ?? '—';
    p.querySelector('.staff-note')!.textContent = staffOpen ? '' : `Откроется после цели «${goal('managers')}»`;
    for (const role of ['dispatcher', 'mechanic'] as const) {
      const box = p.querySelector<HTMLElement>(`.staff[data-role=${role}]`)!;
      box.classList.toggle('locked', !staffOpen);
      box.querySelector('.pay')!.textContent = `${money(core.MANAGERS[role].salary * 60)}/мин`;
      const btn = box.querySelector('button')!;
      btn.textContent = s.managers[role] ? 'Уволить' : 'Нанять';
      btn.disabled = !staffOpen;
    }
    const reserve = p.querySelector<HTMLInputElement>('[data-role=reserve]')!;
    if (document.activeElement !== reserve) reserve.value = String(s.managers.reserve);
    reserve.disabled = !staffOpen;
    const take = p.querySelector<HTMLButtonElement>('[data-role=take]')!;
    const repay = p.querySelector<HTMLButtonElement>('[data-role=repay]')!;
    const body = p.querySelector('.loan-body')!;
    if (!loansOpen) {
      body.textContent = `Откроется после цели «${goal('loans')}»`;
      take.textContent = 'Взять кредит';
      take.disabled = true;
      repay.style.display = 'none';
      return;
    }
    if (s.loan) {
      const debt = core.loanDebt(s);
      const left = s.loan.term - (s.time - s.loan.start);
      body.innerHTML =
        kv('Долг', money(debt)) +
        kv('Платёж', `${money(core.loanPayment(s.loan) * 60)}/мин`) +
        kv('Осталось', duration(Math.max(0, left))) +
        kv('Переплата за срок', money(core.loanOverpay(s.loan)));
      take.textContent = 'Взять кредит';
      take.disabled = true;
      repay.style.display = '';
      repay.disabled = s.cash < debt;
      repay.textContent = `Погасить досрочно · ${money(debt)}`;
    } else {
      const limit = core.loanLimit(s);
      const L = { principal: Math.max(1, limit), start: 0, rate: core.LOANS.ratePerMinute, term: core.LOANS.termMinutes * 60 };
      body.innerHTML =
        kv('Лимит', money(limit)) +
        kv('Ставка', `${String(core.LOANS.ratePerMinute * 100).replace('.', ',')}% в минуту`) +
        kv('Срок', `${core.LOANS.termMinutes} мин`) +
        kv('Платёж при полном лимите', `${money(core.loanPayment(L) * 60)}/мин`) +
        `<div class="small">Лимит — ${core.LOANS.limitMinutes} мин доходности промысла. Платёж списывается и при минусе кассы.</div>`;
      take.textContent = `Взять ${money(limit)}`;
      take.disabled = limit < 1000 || s.cash < 0;
      repay.style.display = 'none';
    }
  }

  private updateFinance(m: core.StatBucket, cap: number): void {
    const s = this.s;
    const capacity = core.productionCapacity(s) * 60;
    const upkeep = core.totalUpkeep(s) * 60;
    const throughput = core.terminalThroughput(s) * 60;
    const t = s.totals;
    this.refs.finance.innerHTML =
      kv('Добыто', rate(m.produced, 'барр.')) +
      kv('Продано', rate(m.sold, 'барр.')) +
      kv('Выручка', money(m.revenue)) +
      (core.countOf(s, 'refinery') > 0 || t.refined > 0 ? kv('в т.ч. нефтепродукты', money(m.productRevenue)) + kv('Переработано', rate(m.refined, 'барр.')) : '') +
      kv('Расходы на содержание', money(-m.expenses)) +
      kv('Операционная прибыль', money(m.revenue - m.expenses), 'total') +
      '<div class="sep"></div>' +
      kv('Мощность добычи', rate(capacity)) +
      kv('Отгрузка терминалов', throughput > 0 ? rate(throughput) : '—') +
      kv('Содержание зданий', `${money(upkeep)}/мин`) +
      kv('Хранилище', bbl(cap)) +
      '<div class="sep"></div>' +
      kv('Всего выручки', money(t.revenue)) +
      kv('Всего вложено', money(t.capex)) +
      (s.features.includes('research') || t.research > 0 ? kv('Исследования', money(t.research)) : '') +
      (t.salaries > 0 ? kv('в т.ч. зарплаты (в расходах)', money(t.salaries)) : '') +
      (t.borrowed > 0 ? kv('Кредиты: получено / погашено', `${money(t.borrowed)} / ${money(t.repaid)}`) + kv('Проценты', money(t.interest)) : '') +
      `<div class="small" style="margin-top:6px">Вложения в строительство и землю — это инвестиции, они не входят в операционные расходы. Исследования тоже не входят и при сносе не возвращаются.</div>`;
  }

  private updateSelection(): void {
    const sel = this.game.selection;
    const s = this.s;
    let key = '';
    if (sel?.kind === 'building') {
      const b = core.getBuilding(s, sel.id);
      if (!b) {
        this.game.selection = null;
      } else {
        key = `b:${b.id}:${b.level}:${b.enabled}:${core.countOf(s, 'terminal')}`;
        this.selectionInfo.innerHTML = this.buildingInfo(b);
        if (key !== this.selectionKey) this.selectionActions.replaceChildren(...this.buildingActions(b));
        this.refreshActionState(b);
      }
    } else if (sel?.kind === 'pipe') {
      const i = core.tileIndex(s, sel.x, sel.y);
      const kind = s.map.pipes[i];
      if (!kind) {
        this.game.selection = null;
      } else {
        key = `pipe:${sel.x}:${sel.y}:${kind}`;
        this.selectionInfo.innerHTML = this.pipeInfo(i, kind as 1 | 2);
        if (key !== this.selectionKey) {
          const out: HTMLElement[] = [];
          if (kind === 1) {
            const up = el('button', 'primary', `Заменить на магистраль · ${money(core.pipeCostAt(s, i, 2) - core.pipeCostAt(s, i, 1))}`);
            up.dataset.role = 'pipe-up';
            up.onclick = () => this.game.pipeTile(sel.x, sel.y, 'upgrade');
            out.push(up);
          }
          const rm = el('button', 'danger', `Демонтировать (+${money(Math.round(core.pipeCostAt(s, i, kind as 1 | 2) * core.PIPE_REFUND))})`);
          rm.onclick = () => this.game.pipeTile(sel.x, sel.y, 'remove');
          out.push(rm);
          this.selectionActions.replaceChildren(...out);
        }
        const up = this.selectionActions.querySelector<HTMLButtonElement>('[data-role=pipe-up]');
        if (up) up.disabled = s.cash < core.pipeCostAt(s, i, 2) - core.pipeCostAt(s, i, 1);
      }
    } else if (sel?.kind === 'parcel') {
      const est = core.parcelEstimate(s, sel.px, sel.py);
      key = `p:${sel.px}:${sel.py}:${est.level}`;
      const priceValue = core.parcelPrice(s, sel.px, sel.py);
      const region = core.parcelRegion(sel.px, sel.py);
      const check = core.canBuyParcel(s, sel.px, sel.py);
      const range = (r: { low: number; high: number } | null) => (!r ? '?' : r.low === r.high ? `${num(r.low)} барр.` : `${num(r.low)}–${num(r.high)} барр.`);
      const levelText =
        est.level >= core.SURVEY_EXACT
          ? 'известно точно'
          : est.level === 0
            ? 'не разведан'
            : `${core.SURVEY_LEVELS[est.level - 1].name.toLowerCase()} (точность ±${Math.round(core.SURVEY_LEVELS[est.level - 1].accuracy * 100)}%)`;
      let body = kv('Разведка', levelText);
      if (est.level === 0) {
        body += `<div class="small" style="margin-top:4px">Запасы неизвестны. В среднем дальние участки богаче, но месторождения есть не везде. Разведка покажет, где нефть, и даст оценку запасов — диапазон, в котором точно лежит истинное значение.</div>`;
      } else if ((est.tiles ?? 0) === 0) {
        body += kv('Результат', 'нефти не обнаружено');
      } else {
        body += kv('Клеток с нефтью', num(est.tiles ?? 0)) + kv('Запасы', range(est.reserves));
        if (est.light && est.heavy && (est.reserves?.high ?? 0) > 0) body += kv('Лёгкой / тяжёлой', `${range(est.light)} / ${range(est.heavy)}`);
        else if ((est.reserves?.high ?? 0) > 0) body += `<div class="small">Сорт нефти покажет сейсморазведка.</div>`;
        if ((est.heavy?.high ?? 0) > 0)
          body += `<div class="small" style="margin-top:4px">Тяжёлая нефть дешевле (сейчас −${Math.round(core.heavySpread(s) * 100)}%), её месторождения крупнее; станки 1-го уровня качают её на ${Math.round((1 - core.GRADES[1].level1Rate) * 100)}% медленнее. Сорта не смешиваются: для тяжёлой нужен свой резервуар.</div>`;
      }
      this.selectionInfo.innerHTML = `
        <div class="sel-title">Участок земли</div>
        <div class="small" style="margin-bottom:8px">Покупка расширяет территорию компании. После покупки запасы известны точно.</div>
        ${kv('Регион', core.REGIONS[region].name)}
        ${region === 1 ? `<div class="small" style="margin-bottom:6px">Пустыня: месторождения крупнее, почти вся нефть тяжёлая; содержание качалок ×${core.REGIONS[1].pumpUpkeep.toLocaleString('ru-RU')}. Цена земли пустыни растёт отдельно от степи.</div>` : ''}
        ${region === 2 ? `<div class="small" style="margin-bottom:6px">Шельф: море, лёгкая нефть. Строится только морская платформа (7) — на морском месторождении, с зоной в радиусе ${core.PLATFORM.radius} клеток. Трубы по морю в ${core.REGIONS[2].pipeCost} раза дороже; хранилища — на берегу.</div>` : ''}
        ${body}
        ${kv('Цена', money(priceValue))}
        ${!check.ok ? `<div class="small" style="color:var(--bad);margin-top:6px">${check.reason}</div>` : ''}`;
      if (key !== this.selectionKey) {
        const out: HTMLElement[] = [];
        core.SURVEY_LEVELS.forEach((lv, i) => {
          const level = i + 1;
          if (est.level >= level || (est.level >= 1 && est.tiles === 0)) return;
          const btn = el('button', '');
          btn.dataset.role = `survey-${level}`;
          btn.title = `${lv.name}: точность ±${Math.round(lv.accuracy * 100)}%${lv.grade ? ', сорт нефти' : ', где нефть'}`;
          btn.onclick = () => this.game.surveyParcel(sel.px, sel.py, level);
          out.push(btn);
        });
        const buy = el('button', 'primary', 'Купить участок');
        buy.dataset.role = 'buy';
        buy.onclick = () => this.game.buyParcel(sel.px, sel.py);
        out.push(buy);
        this.selectionActions.replaceChildren(...out);
      }
      core.SURVEY_LEVELS.forEach((lv, i) => {
        const btn = this.selectionActions.querySelector<HTMLButtonElement>(`[data-role=survey-${i + 1}]`);
        if (!btn) return;
        const cost = core.surveyCost(s, i + 1, sel.px, sel.py);
        btn.textContent = `${lv.name} · ${money(cost)} — ±${Math.round(lv.accuracy * 100)}%${lv.grade ? ' и сорт' : ''}`;
        btn.disabled = !core.canSurvey(s, sel.px, sel.py, i + 1).ok;
      });
      (this.selectionActions.querySelector('[data-role=buy]') as HTMLButtonElement).disabled = !check.ok;
    }
    this.selectionKey = key;
    this.selectionPanel.style.display = key ? '' : 'none';
    this.selSheet.classList.toggle('open', this.mobile && !!key);
    // Стройка на узком экране: лист сворачивается, чтобы карта была видна.
    if (this.mobile && this.game.mode && this.activeTab === 'build') this.setTab(null);
  }

  /** Панель НПЗ: загрузка, причины простоя, продукты, сравнение «продать или переработать». */
  private refineryInfo(b: Building, head: string, upkeep: string): string {
    const s = this.s;
    const cap = core.levelSpec(b).value;
    const f = core.lastFlow(s)?.clients.get(b.id);
    const actual = f?.actual ?? 0;
    const pcap = core.refineryProductCap(b);
    const products = b.products ?? [0, 0, 0];
    // Дополнительные причины (2.3 плана): основная — в статусе, остальные — строками «Также».
    const also: string[] = [];
    const plan = core.refineryPlan(s, b, 1);
    if (b.status !== 'waiting_margin' && b.marginOnly !== false && plan.mask !== plan.filterMask) also.push('переработка одного из сортов сейчас невыгодна');
    if (b.status !== 'product_full' && plan.limitedBy >= 0 && plan.need < cap * 0.999)
      also.push(`склад «${core.PRODUCTS.names[plan.limitedBy].toLowerCase()}» почти заполнен — переработка ограничена`);
    const productRows = [0, 1, 2]
      .map((i) => {
        const p = core.productPrice(s, i);
        const prev = core.productPrice(s, i, s.time - 30, s.market.history[Math.max(0, s.market.history.length - 15)] ?? s.market.price);
        const trend = p > prev + 0.3 ? '▲' : p < prev - 0.3 ? '▼' : '•';
        const held = p < s.productThresholds[i] ? ' · <span style="color:var(--warn)">ждёт цену</span>' : '';
        return kv(core.PRODUCTS.names[i], `${num(products[i])} / ${num(pcap)} · ${price(p)} ${trend}${held}`);
      })
      .join('');
    const grades = ([0, 1] as const)
      .map((g) => {
        const crude = core.gradePrice(s, g);
        const basket = core.basketValue(s, g);
        const m = basket - crude;
        return kv(`1 барр. ${core.GRADES[g].short}`, `продать ${price(crude)} / переработать ${price(basket)} <span style="color:${m > 0 ? 'var(--good)' : 'var(--bad)'}">(${m >= 0 ? '+' : '−'}${price(Math.abs(m))})</span>`);
      })
      .join('');
    // Чистый результат при полной загрузке лучшим допустимым сортом (3.1 плана): мощность · маржа − содержание.
    const allowed = ([0, 1] as const).filter((g) => (plan.filterMask >> g) & 1);
    const best = Math.max(...allowed.map((g) => core.refineryMargin(s, g)));
    const running = b.marginOnly === false || best > 0;
    const net = ((running ? cap * best : 0) - core.buildingUpkeep(b, s)) * 60;
    return `${head}
      ${also.map((a) => `<div class="small" style="color:var(--warn)">Также: ${a}</div>`).join('')}
      ${kv('Переработка', `${rate(actual * 60)} из ${rate(cap * 60)} · ${Math.round((actual / cap) * 100)}%`)}
      ${upkeep}
      ${this.connectionInfo(b)}
      <div class="sep"></div>
      ${productRows}
      ${kv('Отгрузка продуктов', `до ${rate(core.refineryShip(b) * 60)}`)}
      <div class="sep"></div>
      ${grades}
      ${kv('При полной загрузке', `<span style="color:${net >= 0 ? 'var(--good)' : 'var(--bad)'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}/мин</span>`)}
      <div class="small">Сравнение с продажей той же нефти через терминал; содержание НПЗ учтено. Нефть забирается, только если продукты поместятся на склады; если склад одного продукта полон — завод стоит. Терминалы и НПЗ делят нефть пропорционально запросам.</div>`;
  }

  /** Сорт нефти в хранилище (хранилище не смешивает сорта). */
  private storageGrade(b: Building): string {
    if ((b.stored ?? 0) <= 1e-6) return kv('Сорт', 'пусто — примет любой');
    return kv('Сорт', core.GRADES[b.grade ?? 0].name);
  }

  /** Сеть, в которую входит клетка: хранилища, запас, подключённые здания. */
  private networkSummary(comp: core.NetComponent | null): string {
    if (!comp) return kv('Сеть', 'нет');
    if (comp.storages.length === 0) return kv('Сеть', '<span style="color:var(--bad)">без хранилища — нефть не идёт</span>');
    return (
      kv('Хранилищ в сети', `${comp.storages.length} · ${num(core.storedIn(comp))} / ${num(comp.capacity)} барр.`) +
      kv('Подключено', `качалок ${comp.pumps.length}, терминалов ${comp.terminals.length}`)
    );
  }

  private pipeInfo(i: number, kind: 1 | 2): string {
    const s = this.s;
    const spec = core.PIPES[kind];
    const flow = core.lastFlow(s);
    const demand = flow ? flow.demand[i] : 0;
    const actual = flow ? flow.actual[i] : 0;
    const load = demand / spec.capacity;
    const net = core.getNetwork(s);
    const comp = net.components[net.compOfTile[i]] ?? null;
    const state =
      load > 1.0001
        ? `<span class="status bad">Узкое место: нужно ${rate(demand * 60)}</span>`
        : load > 0.8
          ? '<span class="status warn">Почти на пределе</span>'
          : '<span class="status ok">Есть запас пропускной способности</span>';
    return `<div class="sel-title">${spec.name}</div>${state}
      ${kv('Пропускная способность', rate(spec.capacity * 60))}
      ${kv('Поток сейчас', `${rate(actual * 60)} · ${Math.round(Math.min(load, 9.99) * 100)}%`)}
      ${this.networkSummary(comp)}
      <div class="small" style="margin-top:6px">${kind === 1 ? 'Промысловую трубу можно заменить магистралью: протяните инструментом «Магистраль» (5) поверх или нажмите кнопку ниже.' : 'Магистраль пропускает в 4 раза больше промысловой трубы.'} Каждая качалка гонит нефть в ближайшее хранилище сети со свободным местом; нагрузка трубы — сумма потоков через неё.</div>`;
  }

  /** Подключение качалки или терминала: куда идёт нефть и что её ограничивает. */
  private connectionInfo(b: Building): string {
    const s = this.s;
    const f = core.lastFlow(s)?.clients.get(b.id);
    if (b.status === 'no_route') {
      const plan = core.planAutoConnect(s, b.id);
      return `<div class="sep"></div>${kv('Подключение', '<span style="color:var(--bad)">нет пути до хранилища</span>')}
        <div class="small">${core.isProducer(b) ? 'Нефть не добывается' : 'Терминал не может забирать нефть'}, пока здание не соединено трубой с конторой или резервуаром. ${plan.tiles.length ? `Кратчайшая труба: ${plan.tiles.length} кл. за ${money(plan.cost)}.` : plan.reason ?? ''}</div>`;
    }
    if (!f) return '';
    if (b.status === 'wrong_grade') return `<div class="sep"></div>${kv('Нефть идёт в', '<span style="color:var(--bad)">некуда: хранилища заняты другим сортом</span>')}`;
    const target = core.getBuilding(s, f.storage);
    const where = target ? `${core.buildingName(target.type)}${f.path.length ? `, ${f.path.length} кл. трубы` : ', вплотную'}` : '—';
    let out = `<div class="sep"></div>${kv(core.isProducer(b) ? 'Нефть идёт в' : 'Забирает из', where)}`;
    if (f.bottleneck >= 0) {
      const kind = s.map.pipes[f.bottleneck] as 1 | 2;
      const demand = core.lastFlow(s)!.demand[f.bottleneck];
      out +=
        kv('Фактически / возможно', `${rate(f.actual * 60)} / ${rate(f.want * 60)}`) +
        `<div class="small" style="color:var(--warn)">Узкое место — ${core.PIPES[kind].name.toLowerCase()} (подсвечена): через неё хотят пройти ${rate(demand * 60)} при пропускной способности ${rate(core.PIPES[kind].capacity * 60)}. Замените участок магистралью, проложите отдельную трубу или поставьте резервуар ближе.</div>`;
    }
    return out;
  }

  private buildingInfo(b: Building): string {
    const s = this.s;
    const name = core.buildingName(b.type);
    const [statusText, statusCls] = STATUS_TEXT[b.status];
    const head = `<div class="sel-title">${name}${b.type !== 'hq' ? ` · ур. ${b.level}` : ''}</div><span class="status ${statusCls}">${statusText}</span>`;
    const upkeep = kv('Содержание', `${money(core.buildingUpkeep(b, s) * 60)}/мин`);
    if (b.type === 'hq') {
      return `${head}${kv('Склад при конторе', `${num(b.stored ?? 0)} / ${num(core.HQ_STORAGE)} барр.`)}${this.storageGrade(b)}${this.networkSummary(core.componentOf(s, b))}${kv('Перекупщик платит', `лёгк. ${price(core.manualSellPrice(s, 0))} · тяж. ${price(core.manualSellPrice(s, 1))}`)}<div class="small">Здесь начинается ваша компания. Перекупщик забирает нефть из всех хранилищ сразу (своими машинами, трубы не нужны), но платит на 20% меньше рынка.</div>`;
    }
    const spec = core.levelSpec(b);
    const next = core.upgradeCost(b) !== null ? core.BUILDINGS[b.type].levels[b.level] : null;
    if (core.isProducer(b)) {
      const r = core.pumpRate(s, b);
      const pool = core.drainagePool(s, b);
      const zone = core.drainageTiles(s, b).length;
      const timeLeft = core.timeToDeplete(s, b);
      const g = core.pumpGrade(s, b);
      const slow = g === 1 && b.level === 1 ? ` <span class="small">(тяжёлую станок 1-го ур. тянет на ${Math.round((1 - core.GRADES[1].level1Rate) * 100)}% медленнее)</span>` : '';
      return `${head}
        ${kv('Сорт нефти', `${core.GRADES[g].name}${g === 1 ? ` · ${price(core.gradePrice(s, 1))} (−${Math.round(core.heavySpread(s) * 100)}%)` : ''}`)}
        ${kv('Добыча', rate(r * 60) + slow)}
        ${kv('Выручка при текущей цене', `${money(r * 60 * core.gradePrice(s, g))}/мин`)}
        ${b.status === 'wrong_grade' ? `<div class="small" style="color:var(--bad)">Хранилища сети заняты нефтью другого сорта: резервуар хранит только один сорт. Поставьте для этой качалки свой резервуар или продайте нефть — пустой резервуар примет любой сорт.</div>` : ''}
        ${upkeep}
        ${kv(`Запасы зоны (${zone} кл.)`, `${num(pool.reserve)} / ${num(pool.initial)}`)}
        ${kv('Хватит при работе без простоев', r > 0 ? duration(timeLeft) : '—')}
        ${this.connectionInfo(b)}
        ${next ? `<div class="sep"></div>${kv('След. уровень: добыча', rate(next.value * 60 * (r / core.nominalRate(s, b) || 1)))}${kv('След. уровень: содержание', `${money(next.upkeep * core.upkeepFactor(s) * 60)}/мин`)}` : ''}
        <div class="small" style="margin-top:6px">${b.type === 'platform' ? `Платформа тянет нефть из клеток морского месторождения в радиусе ${core.PLATFORM.radius} клеток (зона подсвечена).` : 'Скважина тянет нефть из своей клетки и соседних по сторонам клеток месторождения (зона подсвечена).'} Добыча снижается по мере истощения (до ${Math.round(core.depletionFloor(s) * 100)}% от номинала).</div>`;
    }
    if (b.type === 'tank') {
      return `${head}${kv('В резервуаре', `${num(b.stored ?? 0)} / ${num(spec.value)} барр.`)}${this.storageGrade(b)}${upkeep}<div class="sep"></div>${this.networkSummary(core.componentOf(s, b))}${kv('Вся нефть компании', `${num(s.oil)} / ${num(core.storageCapacity(s))}`)}${next ? `<div class="sep"></div>${kv('След. уровень: ёмкость', bbl(next.value))}` : ''}
        <div class="small" style="margin-top:6px">Нефть хранится по месту: качалки сети заполняют сначала ближайшее хранилище. Сами резервуары между собой не перекачивают, но терминал забирает из ближайшего, где есть нефть. Резервуар хранит один сорт: пока в нём есть нефть, другой сорт сюда не пойдёт.</div>`;
    }
    if (b.type === 'refinery') return this.refineryInfo(b, head, upkeep);
    return `${head}
      ${kv('Отгрузка', rate(spec.value * 60))}
      ${upkeep}
      ${this.connectionInfo(b)}
      ${next ? `<div class="sep"></div>${kv('След. уровень: отгрузка', rate(next.value * 60))}` : ''}
      <div class="sep"></div>
      ${kv('Мин. цена продажи', s.sellThreshold > 0 ? price(s.sellThreshold) : 'любая')}
      ${kv('Сейчас', `лёгк. ${price(core.gradePrice(s, 0))} · тяж. ${price(core.gradePrice(s, 1))}`)}
      <div class="small">Порог общий для всех терминалов и проверяется для каждого сорта: если цена сорта ниже — эта нефть копится в резервуарах, а другой сорт продаётся.</div>`;
  }

  private buildingActions(b: Building): HTMLElement[] {
    if (b.type === 'hq') {
      const sell = el('button', 'primary', 'Продать нефть перекупщику');
      sell.onclick = () => this.game.sell();
      return [sell];
    }
    const out: HTMLElement[] = [];
    const up = el('button', 'primary');
    up.dataset.role = 'upgrade';
    up.onclick = () => this.game.upgrade(b.id);
    out.push(up);
    if (core.isProducer(b) || b.type === 'terminal' || b.type === 'refinery') {
      // До двух вариантов подключения: кратчайший и отдельная ветка (с расчётным потоком).
      for (const idx of [0, 1]) {
        const connect = el('button', idx === 0 ? 'primary' : '');
        connect.dataset.role = `option-${idx}`;
        connect.onclick = () => this.game.connectOption(b.id, idx);
        out.push(connect);
      }
      const route = el('button');
      route.dataset.role = 'route';
      route.onclick = () => this.game.upgradeRoute(b.id);
      out.push(route);
    }
    if (b.type === 'tank') {
      const connect = el('button');
      connect.dataset.role = 'connect';
      connect.onclick = () => this.game.connect(b.id);
      out.push(connect);
    }
    if (b.type === 'refinery') {
      // Сырьё: фильтр сорта и режим «только при выгоде».
      const feeds = el('div', 'row3');
      for (const [feed, label] of [['any', 'Любая'], ['light', 'Лёгкая'], ['heavy', 'Тяжёлая']] as const) {
        const btn = el('button', '', label);
        btn.dataset.role = `feed-${feed}`;
        btn.title = 'Какой сорт нефти принимать';
        btn.onclick = () => this.game.refineryFeed(b.id, feed);
        feeds.append(btn);
      }
      const marginLabel = el('label', 'check');
      const margin = el('input') as HTMLInputElement;
      margin.type = 'checkbox';
      margin.dataset.role = 'margin';
      margin.onchange = () => this.game.refineryMarginOnly(b.id, margin.checked);
      marginLabel.append(margin, document.createTextNode(' Только при выгоде (маржа > 0)'));
      out.push(feeds, marginLabel);
      // Пороги цены продуктов — общие для всех НПЗ.
      for (let i = 0; i < 3; i++) {
        const label = el('div', 'small');
        label.dataset.role = `thr-label-${i}`;
        const slider = el('input') as HTMLInputElement;
        slider.type = 'range';
        slider.min = '0';
        slider.max = '160';
        slider.step = '1';
        slider.value = String(this.s.productThresholds[i]);
        slider.title = `Минимальная цена продажи: ${core.PRODUCTS.names[i].toLowerCase()}`;
        slider.oninput = () => core.setProductThreshold(this.s, i, Number(slider.value));
        slider.dataset.role = `thr-${i}`;
        out.push(label, slider);
      }
    }
    if (b.type === 'terminal') {
      const slider = el('input') as HTMLInputElement;
      slider.type = 'range';
      slider.min = '0';
      slider.max = String(core.MARKET.max);
      slider.step = '1';
      slider.value = String(this.s.sellThreshold);
      slider.title = 'Минимальная цена продажи';
      slider.oninput = () => core.setSellThreshold(this.s, Number(slider.value));
      slider.dataset.role = 'sell-thr';
      out.push(slider);
    }
    const row = el('div', 'row2');
    const toggle = el('button');
    toggle.textContent = b.enabled ? 'Законсервировать' : 'Запустить';
    toggle.title = `Законсервированное здание не работает и стоит ${Math.round(core.MOTHBALL_UPKEEP * 100)}% содержания`;
    toggle.onclick = () => this.game.toggle(b.id);
    const demolish = el('button', 'danger', `Снести (+${money(core.demolishRefund(b))})`);
    demolish.onclick = () => this.game.demolish(b.id);
    row.append(toggle, demolish);
    out.push(row);
    return out;
  }

  private refreshActionState(b: Building): void {
    const s = this.s;
    const connect = this.selectionActions.querySelector<HTMLButtonElement>('[data-role=connect]');
    if (connect) {
      // Кнопка видна, только когда подключение нужно (резервуар — к другой сети с хранилищем).
      const needed = b.type === 'tank' ? true : b.status === 'no_route';
      const plan = needed ? core.planAutoConnect(s, b.id) : null;
      const show = !!plan && plan.tiles.length > 0;
      connect.style.display = show ? '' : 'none';
      if (plan && show) {
        connect.textContent = `${b.type === 'tank' ? 'Соединить с хранилищами' : 'Подключить трубой'} · ${plan.tiles.length} кл. · ${money(plan.cost)}`;
        connect.disabled = !plan.ok;
      }
    }
    // Пороги ведёт диспетчер сбыта — ручные ползунки заблокированы и показывают его значения.
    const disp = s.managers.dispatcher;
    const sellThr = this.selectionActions.querySelector<HTMLInputElement>('[data-role=sell-thr]');
    if (sellThr) {
      sellThr.disabled = disp;
      sellThr.title = disp ? 'Порог ведёт диспетчер сбыта' : 'Минимальная цена продажи';
      if (disp) sellThr.value = String(s.sellThreshold);
    }
    for (let i = 0; i < 3; i++) {
      const sl = this.selectionActions.querySelector<HTMLInputElement>(`[data-role=thr-${i}]`);
      if (!sl) continue;
      sl.disabled = disp;
      if (disp) sl.value = String(s.productThresholds[i]);
    }
    if (b.type === 'refinery') {
      for (const feed of ['any', 'light', 'heavy']) {
        this.selectionActions.querySelector(`[data-role=feed-${feed}]`)?.classList.toggle('active', (b.feed ?? 'any') === feed);
      }
      const margin = this.selectionActions.querySelector<HTMLInputElement>('[data-role=margin]');
      if (margin) margin.checked = b.marginOnly !== false;
      for (let i = 0; i < 3; i++) {
        const label = this.selectionActions.querySelector<HTMLElement>(`[data-role=thr-label-${i}]`);
        if (label) label.textContent = `Мин. цена: ${core.PRODUCTS.names[i].toLowerCase()} — ${s.productThresholds[i] > 0 ? price(s.productThresholds[i]) : 'любая'}${disp ? ' (диспетчер)' : ''}`;
      }
    }
    if (core.isProducer(b) || b.type === 'terminal' || b.type === 'refinery') {
      // Варианты считаются, только когда они нужны: здание не подключено или упирается в трубу.
      const opts = b.status === 'no_route' || b.status === 'throttled' ? core.connectOptions(s, b.id) : [];
      for (const idx of [0, 1]) {
        const btn = this.selectionActions.querySelector<HTMLButtonElement>(`[data-role=option-${idx}]`);
        if (!btn) continue;
        const o = opts[idx];
        btn.style.display = o ? '' : 'none';
        if (!o) continue;
        const what = o.kind === 'short' ? 'Подключить трубой' : b.status === 'no_route' ? 'Отдельной веткой' : 'Разгрузить: отдельная ветка';
        const tiles = `${o.tiles.length} кл.${o.upgrades.length ? ` + ${o.upgrades.length} замен на магистраль` : ''}`;
        const flow = o.predicted >= o.want * 0.995 ? 'полный поток' : `поток ${num(o.predicted * 60)} из ${num(o.want * 60)} барр./мин`;
        btn.textContent = `${what} · ${tiles} · ${money(o.cost)} — ${flow}`;
        btn.disabled = !o.ok;
        // Выделен вариант, где нефти больше (при равенстве — первый, он дешевле).
        const best = opts.reduce((a, c, i) => (c.predicted > opts[a].predicted + 1e-6 ? i : a), 0);
        btn.classList.toggle('primary', idx === best);
      }
    }
    const route = this.selectionActions.querySelector<HTMLButtonElement>('[data-role=route]');
    if (route) {
      const throttled = b.status === 'throttled';
      const plan = throttled ? core.planRouteUpgrade(s, b.id) : null;
      const show = !!plan && plan.tiles.length > 0;
      route.style.display = show ? '' : 'none';
      if (plan && show) {
        route.textContent = `Усилить маршрут магистралью · ${plan.tiles.length} кл. · ${money(plan.cost)}`;
        route.disabled = !plan.ok;
      }
    }
    const up = this.selectionActions.querySelector<HTMLButtonElement>('[data-role=upgrade]');
    if (!up) return;
    const cost = core.upgradeCost(b);
    up.textContent = cost === null ? 'Максимальный уровень' : `Улучшить до ур. ${b.level + 1} · ${money(cost)}`;
    up.disabled = cost === null || this.s.cash < cost;
  }

  private updateHint(): void {
    const g = this.game;
    const s = this.s;
    let text = '';
    if (g.hoverOutside) {
      text = 'За границей лицензионной территории: эта земля не продаётся и не застраивается';
    } else if (isPipeTool(g.mode)) {
      const p = g.pipePreview();
      const spec = PIPE_TOOLS[g.mode];
      if (!p) text = `${spec.name}: наведите на карту`;
      else if (p.tool === 'unpipe') text = p.ok ? `Демонтаж: ${p.count} кл., возврат ${money(p.cost)}` : `Демонтаж: ${p.reason}`;
      else {
        const cap = core.PIPES[spec.kind as 1 | 2].capacity * 60;
        const what = p.ok ? `${p.count} кл. · ${money(p.cost)}` : p.reason;
        text = `${spec.name} (${num(cap)} барр./мин): ${what}. ${g.pipeStart ? 'Отпустите кнопку, чтобы проложить' : 'Нажмите и протяните от здания или трубы'}; ПКМ или Esc — отмена`;
      }
    } else if (g.mode) {
      const name = core.BUILDINGS[g.mode].name;
      let reason = '';
      if (g.hover) {
        const r = core.canBuild(s, g.mode, g.hover.x, g.hover.y);
        if (r.ok && (g.mode === 'pumpjack' || g.mode === 'platform')) {
          const probe = { id: -1, type: g.mode, x: g.hover.x, y: g.hover.y, level: 1, enabled: true, invested: 0, status: 'ok' as const };
          const n = core.pumpNeighbors(s, g.hover.x, g.hover.y);
          const row = g.mode === 'pumpjack' && (n.alongX || n.alongY) ? ' · встанет в ряд бок о бок' : '';
          const grade = core.GRADES[core.pumpGrade(s, probe)].name.toLowerCase();
          reason = ` · ${grade} нефть, зона: ${core.drainageTiles(s, probe).length} кл., ${bbl(core.drainagePool(s, probe).reserve)}${row}`;
        } else reason = r.ok ? ' · можно строить' : ` · ${r.reason}`;
      }
      text = `Строительство: ${name} (${money(core.buildCost(s, g.mode))})${reason.replace(/\.$/, "")}. ЛКМ — поставить, ПКМ или Esc — отмена`;
    } else if (g.hover && core.inBounds(s, g.hover.x, g.hover.y)) {
      const i = core.tileIndex(s, g.hover.x, g.hover.y);
      const b = core.buildingAt(s, g.hover.x, g.hover.y);
      if (b) text = core.buildingName(b.type);
      else if (s.map.pipes[i] > 0) text = `${core.PIPES[s.map.pipes[i] as 1 | 2].name} — щёлкните, чтобы увидеть загрузку`;
      else if (s.map.initial[i] > 0 && core.tileSurveyLevel(s, g.hover.x, g.hover.y) === 0) text = 'Чужой неразведанный участок — щёлкните, чтобы заказать разведку или узнать цену';
      else if (s.map.initial[i] > 0 && core.tileSurveyLevel(s, g.hover.x, g.hover.y) < core.SURVEY_EXACT) text = 'Признаки нефти (по данным разведки) — оценка запасов в панели участка';
      else if (s.map.initial[i] > 0) text = `Месторождение (${core.GRADES[(s.map.grade[i] ?? 0) as 0 | 1].name.toLowerCase()} нефть): ${bbl(s.map.reserve[i])}${core.isTileOwned(s, g.hover.x, g.hover.y) ? ' — постройте качалку (1)' : ''}`;
      else if (!core.isTileOwned(s, g.hover.x, g.hover.y)) text = 'Чужой участок — щёлкните, чтобы узнать цену и заказать разведку';
    }
    if (this.refs.hint.textContent !== text) this.refs.hint.textContent = text;
  }

  toast(text: string, kind: ToastKind = 'info'): void {
    const t = el('div', `toast panel ${kind}`);
    t.textContent = text;
    this.toastBox.append(t);
    while (this.toastBox.children.length > 4) this.toastBox.firstElementChild!.remove();
    setTimeout(() => t.classList.add('fade'), kind === 'good' ? 4500 : 3000);
    setTimeout(() => t.remove(), kind === 'good' ? 5000 : 3500);
  }

  modal(title: string, html: string, buttons: Array<{ label: string; primary?: boolean; onClick?: () => void }>): void {
    const backdrop = el('div', 'modal-backdrop');
    const box = el('div', 'modal panel', `<h2>${title}</h2>${html}<div class="buttons"></div>`);
    for (const b of buttons) {
      const btn = el('button', b.primary ? 'primary' : '', b.label);
      btn.onclick = () => {
        backdrop.remove();
        b.onClick?.();
      };
      box.querySelector('.buttons')!.append(btn);
    }
    backdrop.append(box);
    this.root.append(backdrop);
  }

  showHelp(): void {
    this.modal(
      'Как играть',
      `<p>Вы — владелец маленькой нефтяной компании. Превратите одну скважину в нефтяную империю.</p>
      <ul>
        <li><b>Добыча.</b> Ставьте станки-качалки на тёмные пятна месторождений. Качалки встают рядами бок о бок (балансиры разворачиваются поперёк ряда), между рядами оставляйте проход в клетку — там удобно вести трубу. Запасы истощаются — добыча постепенно падает.</li>
        <li><b>Трубопроводы.</b> Качалка отдаёт нефть только по трубе в контору или резервуар (или стоя вплотную к ним). Тяните трубу инструментом «Трубопровод» (4) или нажмите «Подключить» у качалки. Труба пропускает ограниченный поток — перегруженный участок замените магистралью (5).</li>
        <li><b>Хранение.</b> Нефть копится на складе. Когда он полон, качалки простаивают, но содержание платить всё равно нужно.</li>
        <li><b>Продажа.</b> Вручную — перекупщику со скидкой 20%. Наливной терминал продаёт сам и по полной цене, можно задать минимальную цену.</li>
        <li><b>Сорта нефти.</b> Лёгкая продаётся по рыночной цене, тяжёлая — со скидкой, которая меняется (то больше, то почти исчезает); зато тяжёлые месторождения крупнее. Резервуар хранит один сорт — для тяжёлой нефти нужен свой.</li>
        <li><b>НПЗ.</b> Открывается целью «Стабильная прибыль». Забирает нефть по трубам наравне с терминалами и сразу перерабатывает в бензин, дизель и мазут; продаёт их сам. Выгодно, когда продукты дороги относительно нефти; панель НПЗ сравнивает переработку с прямой продажей.</li>
        <li><b>Рынок.</b> Цена колеблется. Резервуары позволяют придержать нефть до роста цены.</li>
        <li><b>Разведка.</b> Запасы чужих участков не видны. Геологическая съёмка покажет, где нефть, и оценку запасов (±40%), сейсморазведка — точнее (±10%) и сорт. Своя земля известна точно.</li>
        <li><b>Развитие.</b> Улучшайте здания, покупайте соседние участки с новыми месторождениями.</li>
      </ul>
      <p class="small">Управление: перетаскивание или стрелки — камера, колесо — масштаб, 1/2/3/6 — строительство, 4/5 — трубы, X — демонтаж трубы, S — продать, пробел — пауза, Esc — отмена. Игра сохраняется автоматически и продолжает работать, пока вас нет (до 4 часов).</p>`,
      [{ label: 'Начать', primary: true }],
    );
  }

  private showMenu(): void {
    this.modal(
      'Меню',
      '<p>Игра сохраняется автоматически каждые 10 секунд.</p>',
      [
        { label: 'Как играть', onClick: () => this.showHelp() },
        {
          // На узком экране кнопок скорости в верхней строке нет — переключение здесь (пауза → 1× → 2× → 4×).
          label: `Скорость: ${this.game.speed === 0 ? 'пауза' : this.game.speed + '×'} (сменить)`,
          onClick: () => (this.game.speed = [1, 2, 4, 0][([0, 1, 2, 4].indexOf(this.game.speed) + 1) % 4]),
        },
        {
          label: `Смена дня и ночи: ${this.handlers.dayNight() ? 'вкл' : 'выкл'}`,
          onClick: () => this.handlers.toggleDayNight(),
        },
        {
          label: 'Новая игра',
          onClick: () =>
            this.modal('Начать заново?', '<p>Текущий прогресс будет удалён без возможности восстановления.</p>', [
              { label: 'Отмена' },
              { label: 'Начать заново', primary: true, onClick: this.handlers.newGame },
            ]),
        },
        { label: 'Продолжить', primary: true },
      ],
    );
  }
}
