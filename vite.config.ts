import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Файлы из public/ (копируются в сборку как есть) — тоже в кеш service worker. Новый файл в public/ — добавить сюда. */
const PUBLIC_FILES = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'];

/** FNV-1a: короткий хеш списка файлов сборки (без зависимостей от Node-типов). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Service worker для PWA: генерируется при сборке со списком файлов сборки. Версия кеша — хеш этого списка
 * (имена ассетов уже содержат хеш содержимого), поэтому новая сборка получает новый кеш, старый удаляется.
 * Стратегия: кеш сначала, сеть — если в кеше нет; навигация офлайн отдаёт index.html.
 */
function serviceWorker(): Plugin {
  return {
    name: 'oil-tycoon-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['./', 'index.html', ...Object.keys(bundle), ...PUBLIC_FILES].filter((f) => f !== 'sw.js');
      const version = hash([...files].sort().join('\n'));
      const source = `// Сгенерировано при сборке (vite.config.ts). Версия кеша привязана к сборке.
const CACHE = 'oil-tycoon-${version}';
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('oil-tycoon-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate', ignoreVary: true }).then(
      (hit) => hit || fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
    ),
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Относительные пути — сборку можно открыть с любого хостинга (например, GitHub Pages).
  base: './',
  plugins: [serviceWorker()],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
