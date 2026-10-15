import { afterEach, describe, expect, it } from 'vitest';
import {
  AD_REWARD,
  adCooldownLeft,
  adReward,
  build,
  canClaimAdReward,
  claimAdReward,
  createNewGame,
  deserialize,
  HQ_POS,
  serialize,
  simulateOffline,
  START_CASH,
  tick,
  TICK,
  type GameState,
} from '../src/core';
import { detectPlatform, LocalPlatform, pickSave, YandexPlatform } from '../src/platform';
import type { YandexSdk } from '../src/platform/yandex';

/** Денежный инвариант вехи 0.5: награды за рекламу — отдельный член. */
function expectBalanced(s: GameState, start = START_CASH) {
  const t = s.totals;
  expect(s.cash).toBeCloseTo(start + t.revenue + t.rewards + t.refunds + t.borrowed + t.adRewards - t.expenses - t.capex - t.research - t.repaid - t.interest, 6);
}

/** Заглушка SDK «Яндекс Игр»: журнал вызовов и ручное управление обратными вызовами рекламы. */
function stubSdk(opts: { failPlayer?: boolean; failGet?: boolean } = {}) {
  const log: string[] = [];
  const store: Record<string, unknown> = {};
  const handlers: Record<string, () => void> = {};
  let ad: { onOpen?: () => void; onRewarded?: () => void; onClose?: () => void; onError?: (e: unknown) => void } | null = null;
  const sdk: YandexSdk = {
    async getPlayer() {
      log.push('getPlayer');
      if (opts.failPlayer) throw new Error('нет игрока');
      return {
        async getData(keys) {
          if (opts.failGet) throw new Error('сеть');
          return Object.fromEntries((keys ?? Object.keys(store)).filter((k) => k in store).map((k) => [k, store[k]]));
        },
        async setData(data) {
          Object.assign(store, data);
        },
      };
    },
    adv: {
      showRewardedVideo({ callbacks }) {
        log.push('ad');
        ad = callbacks;
      },
    },
    features: {
      LoadingAPI: { ready: () => log.push('ready') },
      GameplayAPI: { start: () => log.push('start'), stop: () => log.push('stop') },
    },
    on(event, cb) {
      handlers[event] = cb;
    },
  };
  return { sdk, log, store, handlers, ad: () => ad! };
}

/** Промысел с прибылью: качалки у конторы и терминал. */
function profitable(): GameState {
  const s = createNewGame(5);
  s.cash = 100_000;
  s.unlocked = ['pumpjack', 'tank', 'terminal'];
  const n = s.map.size;
  for (const [x, y] of [[HQ_POS.x + 1, HQ_POS.y], [HQ_POS.x - 1, HQ_POS.y]]) {
    s.map.reserve[y * n + x] = s.map.initial[y * n + x] = 50_000;
    build(s, 'pumpjack', x, y);
    s.buildings[s.buildings.length - 1].level = 3;
  }
  build(s, 'terminal', HQ_POS.x, HQ_POS.y + 1);
  for (let i = 0; i < 900; i++) tick(s, TICK);
  return s;
}

describe('адаптер «Яндекс Игр» на заглушке SDK', () => {
  it('облачное сохранение: запись и чтение; без игрока или при ошибке — null, игра не падает', async () => {
    const a = stubSdk();
    const p = new YandexPlatform(a.sdk);
    expect(await p.loadCloud()).toBeNull();
    await p.saveCloud('{"x":1}');
    expect(await p.loadCloud()).toBe('{"x":1}');
    expect(a.log.filter((l) => l === 'getPlayer').length).toBe(1); // игрок берётся один раз
    const b = new YandexPlatform(stubSdk({ failPlayer: true }).sdk);
    expect(await b.loadCloud()).toBeNull();
    await expect(b.saveCloud('{}')).resolves.toBeUndefined();
    expect(await new YandexPlatform(stubSdk({ failGet: true }).sdk).loadCloud()).toBeNull();
  });

  it('реклама: onRewarded — один раз, даже если SDK вызвал его дважды; повторное нажатие во время показа не открывает вторую', () => {
    const a = stubSdk();
    const p = new YandexPlatform(a.sdk);
    const events: string[] = [];
    const cb = { onOpen: () => events.push('open'), onRewarded: () => events.push('reward'), onClose: () => events.push('close') };
    p.showRewardedAd(cb);
    p.showRewardedAd(cb);
    expect(a.log.filter((l) => l === 'ad').length).toBe(1);
    a.ad().onOpen!();
    a.ad().onRewarded!();
    a.ad().onRewarded!();
    a.ad().onClose!();
    a.ad().onClose!();
    expect(events).toEqual(['open', 'reward', 'close']);
    // После закрытия можно показать снова.
    p.showRewardedAd(cb);
    expect(a.log.filter((l) => l === 'ad').length).toBe(2);
  });

  it('ошибка рекламы — без награды, пауза снимается (onClose)', () => {
    const a = stubSdk();
    const p = new YandexPlatform(a.sdk);
    const events: string[] = [];
    p.showRewardedAd({ onRewarded: () => events.push('reward'), onClose: () => events.push('close'), onError: () => events.push('error') });
    a.ad().onError!(new Error('нет рекламы'));
    expect(events).toEqual(['error', 'close']);
  });

  it('пауза и возобновление от платформы, разметка геймплея, готовность', () => {
    const a = stubSdk();
    const p = new YandexPlatform(a.sdk);
    const events: string[] = [];
    p.onPause(() => events.push('pause'));
    p.onResume(() => events.push('resume'));
    a.handlers.game_api_pause();
    a.handlers.game_api_resume();
    expect(events).toEqual(['pause', 'resume']);
    p.ready();
    p.gameplayStart();
    p.gameplayStart();
    p.gameplayStop();
    p.gameplayStop();
    expect(a.log.filter((l) => l !== 'getPlayer')).toEqual(['ready', 'start', 'stop']);
  });

  it('локальная платформа: нет облака и рекламы; без SDK определяется local, с SDK — yandex', async () => {
    const l = new LocalPlatform();
    expect(l.hasRewardedAds).toBe(false);
    expect(await l.loadCloud()).toBeNull();
    expect((await detectPlatform(50)).name).toBe('local');
    const g = globalThis as unknown as { YaGames?: { init(): Promise<YandexSdk> } };
    g.YaGames = { init: async () => stubSdk().sdk };
    expect((await detectPlatform(50)).name).toBe('yandex');
    g.YaGames = { init: () => new Promise(() => {}) }; // SDK завис — по таймауту local
    expect((await detectPlatform(50)).name).toBe('local');
  });

  afterEach(() => {
    delete (globalThis as { YaGames?: unknown }).YaGames;
  });
});

describe('выбор сохранения: облако или локальное', () => {
  it('берётся сохранение с большим игровым временем; повреждённое не берётся; локальное — запасное', () => {
    const a = createNewGame(3);
    const b = createNewGame(3);
    simulateOffline(b, 120);
    const sa = serialize(a);
    const sb = serialize(b);
    expect(pickSave(sa, sb)?.from).toBe('cloud');
    expect(pickSave(sb, sa)?.from).toBe('local');
    expect(pickSave(sa, null)?.from).toBe('local');
    expect(pickSave(sa, '{испорчено')?.from).toBe('local');
    expect(pickSave(null, sb)?.from).toBe('cloud');
    expect(pickSave(null, null)).toBeNull();
  });
});

describe('награда за рекламу в ядре', () => {
  it('награда = 5 минут операционной прибыли; деньги в totals.adRewards; инвариант денег сходится', () => {
    const s = profitable();
    const startCash = s.cash - (s.totals.revenue + s.totals.rewards + s.totals.refunds + s.totals.borrowed - s.totals.expenses - s.totals.capex - s.totals.research - s.totals.repaid - s.totals.interest);
    expect(s.totals.adRewards).toBe(0);
    const expected = adReward(s);
    expect(expected).toBeGreaterThan(0);
    const cash = s.cash;
    const r = claimAdReward(s);
    expect(r).toEqual({ ok: true, amount: expected });
    expect(s.cash).toBe(cash + expected);
    expect(s.totals.adRewards).toBe(expected);
    for (let i = 0; i < 300; i++) tick(s, TICK);
    simulateOffline(s, 120);
    expectBalanced(s, startCash);
  });

  it('награда выдаётся один раз: повтор в паузе 10 минут отклоняется, после паузы — снова доступна', () => {
    const s = profitable();
    expect(claimAdReward(s).ok).toBe(true);
    const after = s.totals.adRewards;
    expect(claimAdReward(s)).toMatchObject({ ok: false, amount: 0 });
    expect(s.totals.adRewards).toBe(after);
    expect(adCooldownLeft(s)).toBeCloseTo(AD_REWARD.cooldownMinutes * 60, 6);
    simulateOffline(s, AD_REWARD.cooldownMinutes * 60);
    expect(adCooldownLeft(s)).toBe(0);
    expect(canClaimAdReward(s).ok).toBe(true);
  });

  it('без прибыли награды нет', () => {
    const s = createNewGame(2);
    expect(adReward(s)).toBe(0);
    expect(claimAdReward(s).ok).toBe(false);
    expect(s.totals.adRewards).toBe(0);
  });

  it('сохранения без полей рекламы загружаются со значениями по умолчанию; испорченные отклоняются', () => {
    const s = profitable();
    claimAdReward(s);
    const t = deserialize(serialize(s))!;
    expect(t.totals.adRewards).toBe(s.totals.adRewards);
    expect(t.adLastAt).toBe(s.adLastAt);
    const old = JSON.parse(serialize(createNewGame(4)));
    delete old.totals.adRewards;
    delete old.adLastAt;
    const m = deserialize(JSON.stringify(old))!;
    expect(m).not.toBeNull();
    expect(m.totals.adRewards).toBe(0);
    expect(m.adLastAt).toBeNull();
    const bad = JSON.parse(serialize(s));
    bad.totals.adRewards = -5;
    expect(deserialize(JSON.stringify(bad))).toBeNull();
  });
});
