import { deserialize } from '../core';
import { LocalPlatform } from './local';
import type { Platform } from './types';
import { YandexPlatform, type YandexSdk } from './yandex';

export type { Platform, RewardedAdCallbacks } from './types';

/**
 * Выбор сохранения при расхождении локального и облачного: берётся то, где больше игрового времени
 * (дальше продвинутая игра); повреждённое или отсутствующее — не берётся. Локальное остаётся запасным.
 */
export function pickSave(local: string | null, cloud: string | null): { json: string; from: 'local' | 'cloud' } | null {
  const l = local ? deserialize(local) : null;
  const c = cloud ? deserialize(cloud) : null;
  if (l && c) return c.time > l.time ? { json: cloud!, from: 'cloud' } : { json: local!, from: 'local' };
  if (c) return { json: cloud!, from: 'cloud' };
  if (l) return { json: local!, from: 'local' };
  return null;
}

/** Похоже ли, что игра запущена на «Яндекс Играх» (или явно ?platform=yandex для проверки). */
function onYandex(): boolean {
  if (typeof location === 'undefined') return false;
  if (new URLSearchParams(location.search).get('platform') === 'yandex') return true;
  return /(^|\.)(yandex\.(ru|net|com|by|kz|uz|com\.tr)|playhop\.com|yandex-games\.)/.test(location.hostname) || /yandex/.test(document.referrer);
}

interface YaGlobal {
  YaGames?: { init(): Promise<YandexSdk> };
}

/** Подгружает SDK платформы скриптом; null — не загрузился за отведённое время. */
function loadSdkScript(src: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    const timer = setTimeout(() => resolve(false), timeoutMs);
    s.src = src;
    s.async = true;
    s.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    s.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.append(s);
  });
}

/**
 * Платформа, на которой запущена игра. SDK «Яндекс Игр» подгружается только на их домене (или с ?platform=yandex);
 * любая ошибка — игра работает как обычно (local). Реальной проверки в консоли платформы не было.
 */
export async function detectPlatform(timeoutMs = 4000): Promise<Platform> {
  try {
    const g = globalThis as unknown as YaGlobal;
    if (!g.YaGames && onYandex()) await loadSdkScript('/sdk.js', timeoutMs);
    if (!g.YaGames) return new LocalPlatform();
    const sdk = await Promise.race([g.YaGames.init(), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    return sdk ? new YandexPlatform(sdk) : new LocalPlatform();
  } catch {
    return new LocalPlatform();
  }
}

export { LocalPlatform, YandexPlatform };
