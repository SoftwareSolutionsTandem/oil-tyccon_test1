import * as core from '../core';
import type { BuildableType, Building, GameState } from '../core';
import type { Game, ToastKind } from '../game';
import { formatClock } from '../render/daylight';
import { bbl, duration, money, num, price, rate } from './format';

const BUILDABLE: BuildableType[] = ['pumpjack', 'tank', 'terminal'];

const STATUS_TEXT: Record<Building['status'], [string, 'ok' | 'warn' | 'bad']> = {
  ok: ['Работает', 'ok'],
  off: ['Законсервировано', 'warn'],
  depleted: ['Месторождение исчерпано', 'bad'],
  full: ['Простой: хранилище заполнено', 'bad'],
  waiting_price: ['Ждёт цену выше порога', 'warn'],
  no_oil: ['Нет нефти для отгрузки', 'warn'],
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
  private speedButtons = new Map<number, HTMLButtonElement>();
  private selectionPanel: HTMLElement;
  private selectionInfo: HTMLElement;
  private selectionActions: HTMLElement;
  private selectionKey = '';
  private toastBox: HTMLElement;
  private sparkline: HTMLCanvasElement;
  private wasNegative = false;

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
    this.toastBox = this.root.appendChild(el('div', 'toasts'));
    game.onToast = (text, kind) => this.toast(text, kind);
  }

  private get s(): GameState {
    return this.game.state;
  }

  private buildTopbar(): HTMLElement {
    const bar = el('div', 'topbar panel');
    bar.innerHTML = `
      <div class="brand">OIL TYCOON</div>
      <div class="stat"><span class="label">Деньги</span><span class="value" data-ref="cash"></span></div>
      <div class="stat" style="min-width:150px"><span class="label">Нефть на складе</span><span class="value" data-ref="oil"></span><div class="bar" data-ref="oilbar"><div></div></div></div>
      <div class="stat"><span class="label">Цена нефти</span><div class="price-row"><span class="value" data-ref="price"></span><span class="trend" data-ref="trend"></span><canvas class="spark" width="110" height="28" style="width:110px;height:28px"></canvas></div></div>
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
    const objective = el('div', 'panel objective', '<h3>Цель</h3><div class="body"></div>');
    this.refs.objective = objective.querySelector('.body')!;
    left.append(build, objective);
    return left;
  }

  private buildRight(): HTMLElement {
    const right = el('div', 'right');
    const selection = el('div', 'panel selection', '<div class="info"></div><div class="actions"></div>');
    const finance = el('div', 'panel', '<h3>Финансы · последние 60 с</h3><div class="body"></div>');
    this.refs.finance = finance.querySelector('.body')!;
    right.append(selection, finance);
    return right;
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
    const fill = Math.min(1, s.oil / cap);
    (this.refs.oilbar.firstElementChild as HTMLElement).style.width = `${fill * 100}%`;
    this.refs.oilbar.classList.toggle('full', fill > 0.97);

    const hist = s.market.history;
    const prev = hist[Math.max(0, hist.length - 15)] ?? s.market.price;
    const diff = s.market.price - prev;
    this.refs.price.textContent = price(s.market.price);
    this.refs.trend.textContent = diff > 0.5 ? '▲' : diff < -0.5 ? '▼' : '•';
    this.refs.trend.style.color = diff > 0.5 ? 'var(--good)' : diff < -0.5 ? 'var(--bad)' : 'var(--muted)';
    this.drawSparkline();

    this.refs.profit.textContent = money(profit);
    this.refs.profit.className = `value ${profit < 0 ? 'neg' : profit > 0 ? 'pos' : ''}`;
    this.refs.sell.textContent = `Продать ${num(s.oil)} барр. · ${money(s.oil * core.manualSellPrice(s))}`;
    (this.refs.sell as HTMLButtonElement).disabled = s.oil < 1;
    for (const [v, b] of this.speedButtons) b.classList.toggle('active', this.game.speed === v);
    const hour = this.handlers.hour();
    const dayTime = hour >= 6 && hour < 20;
    this.refs.clock.textContent = this.handlers.dayNight() ? `${dayTime ? '☀' : '☾'} ${formatClock(hour)}` : '☀ —';

    this.updateBuildCards();
    this.updateObjective();
    this.updateFinance(minute, cap);
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
        meta = `${spec.valueLabel}: ${num(lvl.value * (type === 'tank' ? 1 : 60))} ${type === 'tank' ? 'барр.' : 'барр./мин'} · содержание ${money(lvl.upkeep * 60)}/мин`;
      } else {
        const by = core.OBJECTIVES.find((o) => o.unlocks?.includes(type));
        meta = by ? `Откроется после цели «${by.title}»` : 'Пока недоступно';
      }
      const metaEl = card.querySelector('.meta')!;
      if (metaEl.textContent !== meta) metaEl.textContent = meta;
      card.disabled = unlocked && s.cash < cost && this.game.mode !== type;
    }
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
      `<div class="small" style="margin-top:6px">Вложения в строительство и землю — это инвестиции, они не входят в операционные расходы.</div>`;
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
    } else if (sel?.kind === 'parcel') {
      key = `p:${sel.px}:${sel.py}`;
      const survey = core.parcelSurvey(s, sel.px, sel.py);
      const priceValue = core.parcelPrice(s);
      const check = core.canBuyParcel(s, sel.px, sel.py);
      this.selectionInfo.innerHTML = `
        <div class="sel-title">Участок земли</div>
        <div class="small" style="margin-bottom:8px">Покупка расширяет территорию компании. Тёмные пятна — разведанные месторождения.</div>
        ${kv('Клеток с нефтью', num(survey.tiles))}
        ${kv('Разведанные запасы', bbl(survey.reserves))}
        ${kv('Цена', money(priceValue))}
        ${!check.ok ? `<div class="small" style="color:var(--bad);margin-top:6px">${check.reason}</div>` : ''}`;
      if (key !== this.selectionKey) {
        const buy = el('button', 'primary', 'Купить участок');
        buy.dataset.role = 'buy';
        buy.onclick = () => this.game.buyParcel(sel.px, sel.py);
        this.selectionActions.replaceChildren(buy);
      }
      (this.selectionActions.querySelector('[data-role=buy]') as HTMLButtonElement).disabled = !check.ok;
    }
    this.selectionKey = key;
    this.selectionPanel.style.display = key ? '' : 'none';
  }

  private buildingInfo(b: Building): string {
    const s = this.s;
    const name = core.buildingName(b.type);
    const [statusText, statusCls] = STATUS_TEXT[b.status];
    const head = `<div class="sel-title">${name}${b.type !== 'hq' ? ` · ур. ${b.level}` : ''}</div><span class="status ${statusCls}">${statusText}</span>`;
    const upkeep = kv('Содержание', `${money(core.buildingUpkeep(b) * 60)}/мин`);
    if (b.type === 'hq') {
      return `${head}${kv('Склад при конторе', bbl(core.HQ_STORAGE))}${kv('Продажа перекупщику', `${price(core.manualSellPrice(s))} за барр.`)}<div class="small">Здесь начинается ваша компания. Перекупщик забирает нефть сразу, но платит на 20% меньше рынка.</div>`;
    }
    const spec = core.levelSpec(b);
    const next = core.upgradeCost(b) !== null ? core.BUILDINGS[b.type].levels[b.level] : null;
    if (b.type === 'pumpjack') {
      const r = core.pumpRate(s, b);
      const pool = core.drainagePool(s, b);
      const zone = core.drainageTiles(s, b).length;
      const timeLeft = core.timeToDeplete(s, b);
      return `${head}
        ${kv('Добыча', rate(r * 60))}
        ${kv('Выручка при текущей цене', `${money(r * 60 * s.market.price)}/мин`)}
        ${upkeep}
        ${kv(`Запасы зоны (${zone} кл.)`, `${num(pool.reserve)} / ${num(pool.initial)}`)}
        ${kv('Хватит при работе без простоев', r > 0 ? duration(timeLeft) : '—')}
        ${next ? `<div class="sep"></div>${kv('След. уровень: добыча', rate(next.value * 60 * (r / spec.value || 1)))}${kv('След. уровень: содержание', `${money(next.upkeep * 60)}/мин`)}` : ''}
        <div class="small" style="margin-top:6px">Скважина тянет нефть из своей клетки и соседних по сторонам клеток месторождения (зона подсвечена). Добыча снижается по мере истощения (до ${Math.round(core.DEPLETION_MIN_FACTOR * 100)}% от номинала).</div>`;
    }
    if (b.type === 'tank') {
      return `${head}${kv('Ёмкость', bbl(spec.value))}${upkeep}${kv('Всё хранилище', `${num(s.oil)} / ${num(core.storageCapacity(s))}`)}${next ? `<div class="sep"></div>${kv('След. уровень: ёмкость', bbl(next.value))}` : ''}`;
    }
    return `${head}
      ${kv('Отгрузка', rate(spec.value * 60))}
      ${upkeep}
      ${next ? `<div class="sep"></div>${kv('След. уровень: отгрузка', rate(next.value * 60))}` : ''}
      <div class="sep"></div>
      ${kv('Мин. цена продажи', s.sellThreshold > 0 ? price(s.sellThreshold) : 'любая')}
      <div class="small">Порог общий для всех терминалов. Если цена ниже — нефть копится в резервуарах.</div>`;
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
    if (b.type === 'terminal') {
      const slider = el('input') as HTMLInputElement;
      slider.type = 'range';
      slider.min = '0';
      slider.max = String(core.MARKET.max);
      slider.step = '1';
      slider.value = String(this.s.sellThreshold);
      slider.title = 'Минимальная цена продажи';
      slider.oninput = () => core.setSellThreshold(this.s, Number(slider.value));
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
    if (g.mode) {
      const name = core.BUILDINGS[g.mode].name;
      let reason = '';
      if (g.hover) {
        const r = core.canBuild(s, g.mode, g.hover.x, g.hover.y);
        if (r.ok && g.mode === 'pumpjack') {
          const probe = { id: -1, type: 'pumpjack' as const, x: g.hover.x, y: g.hover.y, level: 1, enabled: true, invested: 0, status: 'ok' as const };
          reason = ` · зона: ${core.drainageTiles(s, probe).length} кл., ${bbl(core.drainagePool(s, probe).reserve)}`;
        } else reason = r.ok ? ' · можно строить' : ` · ${r.reason}`;
      }
      text = `Строительство: ${name} (${money(core.buildCost(s, g.mode))})${reason}. ЛКМ — поставить, ПКМ или Esc — отмена`;
    } else if (g.hover && core.inBounds(s, g.hover.x, g.hover.y)) {
      const i = core.tileIndex(s, g.hover.x, g.hover.y);
      const b = core.buildingAt(s, g.hover.x, g.hover.y);
      if (b) text = core.buildingName(b.type);
      else if (s.map.initial[i] > 0) text = `Месторождение: ${bbl(s.map.reserve[i])}${core.isTileOwned(s, g.hover.x, g.hover.y) ? ' — постройте качалку (1)' : ''}`;
      else if (!core.isTileOwned(s, g.hover.x, g.hover.y)) text = 'Чужой участок — щёлкните, чтобы узнать цену';
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
        <li><b>Добыча.</b> Ставьте станки-качалки на тёмные пятна месторождений. Запасы истощаются — добыча постепенно падает.</li>
        <li><b>Хранение.</b> Нефть копится на складе. Когда он полон, качалки простаивают, но содержание платить всё равно нужно.</li>
        <li><b>Продажа.</b> Вручную — перекупщику со скидкой 20%. Наливной терминал продаёт сам и по полной цене, можно задать минимальную цену.</li>
        <li><b>Рынок.</b> Цена колеблется. Резервуары позволяют придержать нефть до роста цены.</li>
        <li><b>Развитие.</b> Улучшайте здания, покупайте соседние участки с новыми месторождениями.</li>
      </ul>
      <p class="small">Управление: перетаскивание или стрелки — камера, колесо — масштаб, 1/2/3 — строительство, S — продать, пробел — пауза, Esc — отмена. Игра сохраняется автоматически и продолжает работать, пока вас нет (до 4 часов).</p>`,
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
