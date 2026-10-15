import './style.css';
import * as core from './core';
import { createDemoState } from './demo';
import { createLateState } from './late';
import { Game, isPipeTool } from './game';
import { Camera, worldToTile } from './render/iso';
import { Renderer } from './render/renderer';
import { duration, money, num } from './ui/format';
import { Hud } from './ui/hud';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const camera = new Camera();
const renderer = new Renderer(canvas, camera);

/** Версия сохранения до загрузки: по ней показываем пояснение о переходе на сеть трубопроводов. */
let loadedVersion = core.SAVE_VERSION;

function loadSave(): core.GameState | null {
  try {
    const raw = localStorage.getItem(core.SAVE_KEY);
    if (!raw) return null;
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === 'number') loadedVersion = v;
    return core.deserialize(raw);
  } catch {
    return null;
  }
}

function save(): void {
  if (demo) return; // демо-сцена не перезаписывает настоящее сохранение
  try {
    localStorage.setItem(core.SAVE_KEY, core.serialize(game.state));
  } catch {
    // Хранилище недоступно (приватный режим) — игра продолжается без сохранения.
  }
}

const params = new URLSearchParams(location.search);
/** Сцены для проверки (?demo — эталон графики, ?late — поздняя игра для замеров) не трогают настоящее сохранение. */
const late = params.has('late');
const demo = params.has('demo') || late;
const loaded = demo ? null : loadSave();
const game = new Game(loaded ?? (late ? createLateState() : demo ? createDemoState() : core.createNewGame()), renderer);
const DAYNIGHT_KEY = 'oil-tycoon-daynight';
try {
  renderer.dayNight = localStorage.getItem(DAYNIGHT_KEY) !== 'off';
} catch {
  // Настройка недоступна — остаётся по умолчанию.
}
const hud = new Hud(game, {
  newGame: startNewGame,
  dayNight: () => renderer.dayNight,
  toggleDayNight: () => {
    renderer.dayNight = !renderer.dayNight;
    try {
      localStorage.setItem(DAYNIGHT_KEY, renderer.dayNight ? 'on' : 'off');
    } catch {
      // Не удалось сохранить настройку — действует до перезагрузки.
    }
  },
  hour: () => renderer.lighting.hour,
});
renderer.adopt(game.state);
camera.centerOnTile(core.HQ_POS.x + 3, core.HQ_POS.y + 3);

if (loaded) {
  if (loadedVersion < 2) {
    hud.modal(
      'Появились трубопроводы',
      `<p>Теперь нефть идёт от качалок к хранилищам только по трубам, а у каждой трубы есть пропускная способность.</p>
       <p>Ваши деньги, нефть, здания и земля сохранены. Все качалки, резервуары и терминалы бесплатно подключены
       магистральными трубами по вашей земле. Нефть со склада разложена по хранилищам.</p>
       <p class="small">Если какие-то качалки отмечены значком ≈, их ограничивает труба: выберите качалку — узкое место
       будет подсвечено. Помогут вторая ветка к другому резервуару, резервуар с терминалом рядом с промыслом
       или отдельная сеть. Инструменты: 4 — труба, 5 — магистраль, X — демонтаж.</p>`,
      [{ label: 'Понятно', primary: true }],
    );
  }
  runOffline((Date.now() - loaded.savedAt) / 1000, 'Пока вас не было');
} else if (!demo) {
  hud.showHelp();
}

function startNewGame(): void {
  game.state = core.createNewGame();
  game.selection = null;
  game.mode = null;
  renderer.adopt(game.state);
  camera.centerOnTile(core.HQ_POS.x + 3, core.HQ_POS.y + 3);
  save();
  hud.showHelp();
}

/** Догоняем время, которое игра провела закрытой или в фоновой вкладке. */
function runOffline(seconds: number, title: string): void {
  if (seconds < 5) return;
  const report = core.simulateOffline(game.state, seconds);
  for (const o of report.completed) game.announce(o);
  for (const r of report.researched) game.announceResearch(r);
  if (report.seconds < 30) return;
  const capped = seconds > core.OFFLINE_CAP ? ` (учтено не более ${duration(core.OFFLINE_CAP)})` : '';
  hud.modal(
    title,
    `<p>Прошло ${duration(seconds)}${capped}. Предприятие работало без вас:</p>
     <ul>
       <li>Добыто: ${num(report.produced)} барр.</li>
       <li>Продано: ${num(report.sold)} барр.</li>
       <li>Выручка: ${money(report.revenue)}</li>
       <li>Расходы на содержание: ${money(report.expenses)}</li>
       <li><b>Итого: ${money(report.revenue - report.expenses)}</b></li>
     </ul>
     ${report.researched.length ? `<p>Завершены исследования:</p><ul>${report.researched.map((r) => `<li>${core.TECHS[r.id].name} — уровень ${r.level}</li>`).join('')}</ul>` : ''}
     ${report.sold < report.produced * 0.5 && report.produced > 0 ? '<p class="small">Совет: без терминала нефть копится на складе, а качалки простаивают. Терминал продаёт автоматически.</p>' : ''}`,
    [{ label: 'Отлично', primary: true }],
  );
}

// ——— Ввод ———

function tileAtScreen(sx: number, sy: number): { x: number; y: number } {
  const { w, h } = renderer.size;
  const world = camera.screenToWorld(sx, sy, w, h);
  const t = worldToTile(world.x, world.y);
  return { x: Math.floor(t.x), y: Math.floor(t.y) };
}

let drag: { x: number; y: number; button: number; moved: boolean } | null = null;

/** Протяжка трубы левой кнопкой: камера при этом не двигается. */
let pipeDrag = false;

/** Касания: щипок двумя пальцами — масштаб и сдвиг; после щипка до отпускания всех пальцев кликов нет. */
const touches = new Map<number, { x: number; y: number }>();
let pinch: { dist: number; mx: number; my: number } | null = null;
let pinched = false;
/** Стройка касанием ждёт подтверждения: место выбрано, здание показано призраком. */
let pendingBuild: { x: number; y: number } | null = null;

function pinchState(): { dist: number; mx: number; my: number } {
  const [a, b] = [...touches.values()];
  return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

function clearPendingBuild(): void {
  pendingBuild = null;
  hud.showBuildConfirm(null, false, () => {}, () => {});
}

/** Касание в режиме стройки: здание не ставится сразу — сначала подтверждение (палец не строит при прокрутке). */
function proposeBuild(x: number, y: number): void {
  const type = game.mode;
  if (!type || isPipeTool(type)) return;
  pendingBuild = { x, y };
  game.hover = pendingBuild;
  const check = core.canBuild(game.state, type, x, y);
  const text = check.ok ? `${core.BUILDINGS[type].name} · ${money(core.buildCost(game.state, type))}` : check.reason;
  hud.showBuildConfirm(
    text,
    check.ok,
    () => {
      game.click(x, y);
      clearPendingBuild();
      hud.update();
    },
    () => {
      clearPendingBuild();
      game.hover = null;
    },
  );
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      // Второй палец: щипок. Начатые протяжка трубы и сдвиг камеры отменяются.
      pinch = pinchState();
      pinched = true;
      drag = null;
      if (pipeDrag) {
        pipeDrag = false;
        game.pipeStart = null;
      }
      return;
    }
  }
  if (e.button === 0 && isPipeTool(game.mode)) {
    const t = tileAtScreen(e.clientX, e.clientY);
    game.pipeDown(t.x, t.y);
    pipeDrag = true;
    return;
  }
  drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) {
      const now = pinchState();
      const { w, h } = renderer.size;
      camera.x -= (now.mx - pinch.mx) / camera.zoom;
      camera.y -= (now.my - pinch.my) / camera.zoom;
      camera.zoomAt(now.dist / pinch.dist, now.mx, now.my, w, h);
      pinch = now;
      return;
    }
  }
  if (e.pointerType !== 'touch' || pipeDrag) {
    const tile = tileAtScreen(e.clientX, e.clientY);
    const inside = core.inBounds(game.state, tile.x, tile.y);
    game.hover = inside ? tile : null;
    game.hoverOutside = !inside;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 10 : 5)) return;
  drag.moved = true;
  camera.x -= dx / camera.zoom;
  camera.y -= dy / camera.zoom;
  drag.x = e.clientX;
  drag.y = e.clientY;
});

function releasePointer(e: PointerEvent): boolean {
  if (e.pointerType !== 'touch') return false;
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
  if (!pinched) return false;
  if (touches.size === 0) pinched = false;
  drag = null;
  return true;
}

canvas.addEventListener('pointerup', (e) => {
  if (releasePointer(e)) return;
  if (pipeDrag && e.button === 0) {
    pipeDrag = false;
    const t = tileAtScreen(e.clientX, e.clientY);
    game.pipeUp(t.x, t.y);
    hud.update();
    return;
  }
  if (drag && !drag.moved) {
    if (drag.button === 0) {
      const t = tileAtScreen(e.clientX, e.clientY);
      if (e.pointerType === 'touch' && game.mode && !isPipeTool(game.mode)) proposeBuild(t.x, t.y);
      else {
        game.click(t.x, t.y);
        hud.update();
      }
    } else if (drag.button === 2) {
      game.cancel();
    }
  }
  drag = null;
});

canvas.addEventListener('pointercancel', (e) => {
  releasePointer(e);
  drag = null;
  pipeDrag = false;
});

canvas.addEventListener('pointerleave', (e) => {
  // После касания указатель «уходит» сразу — призрак выбранного места стройки остаётся.
  if (e.pointerType === 'touch') return;
  game.hover = null;
  game.hoverOutside = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const { w, h } = renderer.size;
    camera.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY, w, h);
  },
  { passive: false },
);

const held = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();
  held.add(key);
  if (key === 'escape') game.cancel();
  else if (key === '1') game.setMode('pumpjack');
  else if (key === '2') game.setMode('tank');
  else if (key === '3') game.setMode('terminal');
  else if (key === '6') game.setMode('refinery');
  else if (key === '7') game.setMode('platform');
  else if (key === '4') game.setMode('pipe');
  else if (key === '5') game.setMode('trunk');
  else if (key === 'x' || key === 'ч') game.setMode('unpipe');
  else if (key === 's' || key === 'ы') game.sell();
  else if (key === ' ') {
    e.preventDefault();
    game.speed = game.speed === 0 ? 1 : 0;
  } else return;
  hud.update();
});
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());
window.addEventListener('resize', () => renderer.resize());

// ——— Жизненный цикл: сохранение и фоновый режим ———

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    save();
  } else if (hiddenAt) {
    if (game.speed > 0) runOffline(((Date.now() - hiddenAt) / 1000) * game.speed, 'С возвращением');
    hiddenAt = 0;
  }
});
window.addEventListener('beforeunload', save);

// ——— Игровой цикл ———

let last = performance.now();
let accumulator = 0;
let uiTimer = 0;
let saveTimer = 0;
const PAN_SPEED = 600;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  accumulator += dt * game.speed;
  let steps = 0;
  while (accumulator >= core.TICK && steps < 200) {
    game.step(core.TICK);
    accumulator -= core.TICK;
    steps++;
  }

  const pan = (PAN_SPEED * dt) / camera.zoom;
  if (held.has('arrowleft')) camera.x -= pan;
  if (held.has('arrowright')) camera.x += pan;
  if (held.has('arrowup')) camera.y -= pan;
  if (held.has('arrowdown')) camera.y += pan;

  // Место стройки, выбранное касанием, держится до подтверждения или смены режима.
  if (pendingBuild) {
    if (!game.mode || isPipeTool(game.mode)) clearPendingBuild();
    else game.hover = pendingBuild;
  }
  const building = game.mode && !isPipeTool(game.mode) ? game.mode : null;
  const ghost = building && game.hover ? { type: building, ok: core.canBuild(game.state, building, game.hover.x, game.hover.y).ok } : null;
  const preview = game.pipePreview();
  const sel = game.selection;
  let highlightParcel = sel?.kind === 'parcel' ? { px: sel.px, py: sel.py } : null;
  if (!highlightParcel && !game.mode && game.hover && !core.isTileOwned(game.state, game.hover.x, game.hover.y)) {
    highlightParcel = core.parcelOf(game.hover.x, game.hover.y);
  }
  renderer.draw(
    game.state,
    {
      hover: game.hover,
      ghost,
      selectedBuilding: sel?.kind === 'building' ? sel.id : null,
      highlightParcel,
      pipePlan: preview ? { tiles: preview.path, ok: preview.ok, remove: preview.tool === 'unpipe' } : null,
      // Слой сети: при работе с трубами, выборе трубы и выборе здания сети.
      network: isPipeTool(game.mode) ? 'full' : sel?.kind === 'pipe' || sel?.kind === 'building' ? 'selection' : null,
      selectedPipe: sel?.kind === 'pipe' ? { x: sel.x, y: sel.y } : null,
    },
    dt,
    game.speed,
  );

  uiTimer += dt;
  if (uiTimer > 0.2) {
    uiTimer = 0;
    hud.update();
  }
  saveTimer += dt;
  if (saveTimer > 10) {
    saveTimer = 0;
    save();
  }
  requestAnimationFrame(frame);
}

hud.update();
requestAnimationFrame(frame);

// ?perf — частота кадров, время кадра и память рендера на экране (для замеров на телефоне).
if (params.has('perf')) {
  const box = document.createElement('div');
  box.className = 'perf panel';
  document.body.append(box);
  let frames = 0;
  let since = performance.now();
  let frameMsSum = 0;
  const count = (now: number) => {
    frames++;
    frameMsSum += renderer.frameMs;
    if (now - since >= 1000) {
      const mem = renderer.memoryStats();
      box.textContent = `${((frames * 1000) / (now - since)).toFixed(0)} к/с · кадр ${(frameMsSum / frames).toFixed(1)} мс · ${mem.total.toFixed(0)} МБ · ${game.state.buildings.length} зд.`;
      frames = 0;
      frameMsSum = 0;
      since = now;
    }
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
}

// PWA: service worker только в продакшен-сборке. Сбой регистрации (например, игра в iframe платформы,
// где service worker запрещён) не мешает игре — она просто работает без офлайн-кеша.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  try {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch {
    // нет доступа к service worker — играем без него
  }
}

// Доступ из консоли браузера и автотестов (Playwright).
Object.assign(window, { oilTycoon: { game, camera, renderer, core } });
