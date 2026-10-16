// Мобильный бот-тестировщик интерфейса: играет как новичок на телефоне 390×844 (касания, без мыши и клавиатуры)
// и проверяет, что каждое действие доступно касанием, ничего не вылезает за экран и не обрезано.
// Запуск: npm run test:mobile (поднимает dev-сервер Vite сам). Браузер: Chromium Playwright
// (`npx playwright install chromium`) или путь в переменной CHROMIUM_PATH.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = 5199;
const VIEWPORT = { width: 390, height: 844 };
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const exe = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const wait = (ms) => page.waitForTimeout(ms);
const visible = (sel) => page.locator(sel).first().isVisible().catch(() => false);
const tapEl = async (sel) => {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) throw new Error(`нет элемента ${sel}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await wait(250);
};
/** Камера на клетку и касание её центра (палец игрока). */
const tapTile = async (x, y) => {
  const p = await page.evaluate(([x, y]) => {
    const o = window.oilTycoon;
    o.camera.x = (x - y) * 32;
    o.camera.y = (x + y + 1) * 16;
    return { x: innerWidth / 2, y: innerHeight / 2 };
  }, [x, y]);
  await wait(150);
  await page.touchscreen.tap(p.x, p.y);
  await wait(250);
};
const state = () => page.evaluate(() => {
  const s = window.oilTycoon.game.state;
  return { cash: s.cash, oil: s.oil, speed: window.oilTycoon.game.speed, mode: window.oilTycoon.game.mode, buildings: s.buildings.map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, status: b.status })) };
});

/** Всё видимое в интерфейсе — в пределах экрана; у кнопок текст не обрезан; кнопки не меньше 40×40. */
const layoutProblems = (scope) => page.evaluate((scope) => {
  const out = [];
  const W = innerWidth;
  for (const el of document.querySelectorAll(`${scope} button, ${scope} .panel, ${scope} .stat, ${scope} .hint`)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const name = (el.textContent || el.className).trim().slice(0, 30);
    if (r.left < -1 || r.right > W + 1) out.push(`за краем экрана: «${name}» (${Math.round(r.left)}…${Math.round(r.right)})`);
    if (el.tagName === 'BUTTON') {
      if (el.scrollWidth > el.clientWidth + 2) out.push(`текст кнопки обрезан: «${name}»`);
      if (r.width < 40 || r.height < 40) out.push(`кнопка меньше 40 px: «${name}» ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  return out;
}, scope);

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.oilTycoon, null, { timeout: 30000 });
  await wait(800);

  // 1. Первое окно «Как играть» закрывается касанием.
  if (await visible('.modal')) await tapEl('.modal .buttons button.primary');
  check('окно «Как играть» закрывается', !(await visible('.modal')));

  // 2. Компоновка без окон.
  let probs = await layoutProblems('#hud');
  check('интерфейс в пределах экрана, кнопки ≥ 40 px, текст не обрезан', probs.length === 0, probs.join('; '));
  const mapPct = await page.evaluate(() => {
    const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const bottom = document.querySelector('.sheet').getBoundingClientRect().top;
    return Math.round(((bottom - top) / innerHeight) * 100);
  });
  check('карта ≥ 60% экрана', mapPct >= 60, `${mapPct}%`);

  // 3. Ускорение времени — видно в верхней строке, без меню.
  const speedSel = '.topbar [data-ref=speed-cycle]';
  const hasSpeed = await visible(speedSel);
  check('ускорение времени видно в верхней строке', hasSpeed);
  if (hasSpeed) {
    const s0 = (await state()).speed;
    await tapEl(speedSel);
    const s1 = (await state()).speed;
    check('касание кнопки скорости меняет скорость', s1 !== s0, `${s0}× → ${s1}×`);
    while ((await state()).speed !== 4) await tapEl(speedSel);
  }

  // 4. Меню: все кнопки видны целиком.
  await tapEl('.topbar [data-ref=menu]');
  probs = await layoutProblems('.modal');
  check('меню: все кнопки на экране и с целым текстом', probs.length === 0, probs.join('; '));
  await tapEl('.modal .buttons button.primary');
  check('меню закрывается', !(await visible('.modal')));

  // 5. Стройка качалки: вкладка → карточка → режим виден с кнопкой отмены → касание месторождения → подтверждение.
  const deposit = await page.evaluate(() => {
    const s = window.oilTycoon.game.state;
    const c = window.oilTycoon.core;
    const n = s.map.size;
    for (let i = 0; i < n * n; i++) {
      const x = i % n;
      const y = Math.floor(i / n);
      if (s.map.initial[i] > 0 && c.canBuild({ ...s, cash: 1e9 }, 'pumpjack', x, y).ok) return { x, y };
    }
    return null;
  });
  await tapEl('.sheet .tabs button[data-tab=build]');
  await tapEl('.build-card[data-type=pumpjack]');
  check('после выбора качалки виден режим стройки с кнопкой отмены', (await visible('.mode-bar.open')) && (await visible('.mode-bar.open [data-role=mode-cancel]')));
  const modeText = await page.locator('.mode-bar .text').first().textContent().catch(() => '');
  check('подсказка режима — для касаний (без «ЛКМ», «ПКМ», «Esc»)', !/ЛКМ|ПКМ|Esc/.test(modeText ?? ''), modeText ?? '');
  await tapTile(deposit.x, deposit.y);
  check('касание клетки показывает подтверждение стройки', await visible('.confirm-bar.open'));
  await tapEl('[data-role=confirm-yes]');
  let st = await state();
  const pump = st.buildings.find((b) => b.type === 'pumpjack');
  check('качалка построена', !!pump);

  // 6. Труба касаниями: Стройка → Трубопровод → начало у конторы → конец у качалки → подтверждение.
  const hq = st.buildings.find((b) => b.type === 'hq');
  const route = await page.evaluate(([hq, pump]) => {
    const c = window.oilTycoon.core;
    const s = window.oilTycoon.game.state;
    const plan = c.planAutoConnect(s, s.buildings.find((b) => b.x === pump.x && b.y === pump.y).id, 1);
    return plan.ok ? plan.tiles : null;
  }, [hq, pump]);
  if (route && route.length) {
    await tapEl('.sheet .tabs button[data-tab=build]');
    await tapEl('.build-card[data-tool=pipe]');
    check('после выбора трубы виден режим с подсказкой', await visible('.mode-bar.open'));
    // Кратчайший маршрут — прямая «уголком» от первой до последней клетки (как кладёт инструмент).
    const [a, b] = [route[0], route[route.length - 1]];
    await tapTile(a[0], a[1]);
    const t1 = await page.locator('.mode-bar .text').first().textContent().catch(() => '');
    check('первое касание — начало трубы (подсказка просит конец)', /конец|конеч/i.test(t1 ?? ''), t1 ?? '');
    await tapTile(b[0], b[1]);
    check('второе касание — подтверждение трубы с ценой', await visible('.confirm-bar.open'));
    await tapEl('[data-role=confirm-yes]');
    await wait(400);
    const connected = await page.evaluate((pump) => {
      const s = window.oilTycoon.game.state;
      const b = s.buildings.find((q) => q.x === pump.x && q.y === pump.y);
      return window.oilTycoon.core.isConnected(s, b);
    }, pump);
    check('труба, проложенная двумя касаниями, подключила качалку', connected);
    if (!connected) {
      // Возможно, маршрут не прямой: доподключаем кнопкой «Подключить» у качалки.
      await tapTile(pump.x, pump.y);
      if (await visible('.sel-sheet.open [data-role=option-0]')) await tapEl('.sel-sheet.open [data-role=option-0]');
    }
    const connected2 = await page.evaluate((pump) => {
      const s = window.oilTycoon.game.state;
      return window.oilTycoon.core.isConnected(s, s.buildings.find((q) => q.x === pump.x && q.y === pump.y));
    }, pump);
    check('качалка подключена (трубой или кнопкой «Подключить»)', connected2);
    if (await visible('.mode-bar.open [data-role=mode-cancel]')) await tapEl('.mode-bar.open [data-role=mode-cancel]');
    check('режим трубы отменяется кнопкой', (await state()).mode === null);
  } else check('маршрут трубы найден', false);

  // 7. Нефть пошла — продажа касанием.
  await page.waitForFunction(() => window.oilTycoon.game.state.oil >= 5, null, { timeout: 30000 }).catch(() => {});
  const cash0 = (await state()).cash;
  await tapEl('.topbar [data-ref=sell]');
  check('продажа нефти касанием', (await state()).cash > cash0);

  // 8. Все вкладки: открываются, содержимое в экране, карта ≥ 60%.
  for (const tab of ['build', 'objective', 'finance', 'tech', 'company', 'stats', 'achievements']) {
    await tapEl(`.sheet .tabs button[data-tab=${tab}]`);
    const p = await layoutProblems('.sheet');
    const shown = await page.evaluate((tab) => !!document.querySelector(`.sheet-body [data-tab=${tab}]:not(.tab-hidden)`), tab);
    check(`вкладка «${tab}» открывается, всё в экране`, shown && p.length === 0, p.join('; '));
  }
  await tapEl('.sheet .tabs button[data-tab=stats]');

  // 9. Выбор качалки касанием: лист здания и кнопка закрытия.
  await tapTile(pump.x, pump.y);
  check('касание здания открывает его лист', await visible('.sel-sheet.open'));
  probs = await layoutProblems('.sel-sheet');
  check('лист здания в пределах экрана', probs.length === 0, probs.join('; '));
  if (await visible('.sel-sheet .close')) await tapEl('.sel-sheet .close');
  check('лист здания закрывается', !(await visible('.sel-sheet.open')));

  check('нет ошибок в консоли', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: 'e2e/mobile-bot.png' });
} catch (e) {
  check('сценарий выполнен до конца', false, String(e?.message ?? e).split('\n')[0]);
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length} проверок прошли.`);
process.exit(failed.length ? 1 : 0);
