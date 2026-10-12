import './style.css';
import * as core from './core';
import { createDemoState } from './demo';
import { Game } from './game';
import { Camera, worldToTile } from './render/iso';
import { Renderer } from './render/renderer';
import { duration, money, num } from './ui/format';
import { Hud } from './ui/hud';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const camera = new Camera();
const renderer = new Renderer(canvas, camera);

function loadSave(): core.GameState | null {
  try {
    const raw = localStorage.getItem(core.SAVE_KEY);
    return raw ? core.deserialize(raw) : null;
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

const demo = new URLSearchParams(location.search).has('demo');
const loaded = demo ? null : loadSave();
const game = new Game(loaded ?? (demo ? createDemoState() : core.createNewGame()), renderer);
const hud = new Hud(game, { newGame: startNewGame });
renderer.adopt(game.state);
camera.centerOnTile(core.HQ_POS.x + 3, core.HQ_POS.y + 3);

if (loaded) {
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

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
});

canvas.addEventListener('pointermove', (e) => {
  const tile = tileAtScreen(e.clientX, e.clientY);
  game.hover = core.inBounds(game.state, tile.x, tile.y) ? tile : null;
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  drag.moved = true;
  camera.x -= dx / camera.zoom;
  camera.y -= dy / camera.zoom;
  drag.x = e.clientX;
  drag.y = e.clientY;
});

canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    if (drag.button === 0) {
      const t = tileAtScreen(e.clientX, e.clientY);
      game.click(t.x, t.y);
      hud.update();
    } else if (drag.button === 2) {
      game.cancel();
    }
  }
  drag = null;
});

canvas.addEventListener('pointerleave', () => (game.hover = null));
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

  const ghost = game.mode && game.hover ? { type: game.mode, ok: core.canBuild(game.state, game.mode, game.hover.x, game.hover.y).ok } : null;
  const sel = game.selection;
  let highlightParcel = sel?.kind === 'parcel' ? { px: sel.px, py: sel.py } : null;
  if (!highlightParcel && !game.mode && game.hover && !core.isTileOwned(game.state, game.hover.x, game.hover.y)) {
    highlightParcel = core.parcelOf(game.hover.x, game.hover.y);
  }
  renderer.draw(
    game.state,
    { hover: game.hover, ghost, selectedBuilding: sel?.kind === 'building' ? sel.id : null, highlightParcel },
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

// Доступ из консоли браузера и автотестов (Playwright).
Object.assign(window, { oilTycoon: { game, camera, renderer, core } });
