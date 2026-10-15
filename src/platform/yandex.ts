import type { Platform, RewardedAdCallbacks } from './types';

/**
 * Минимальная часть SDK «Яндекс Игр», которой пользуется игра (по документации SDK v2: YaGames.init(),
 * ysdk.getPlayer, player.getData/setData, ysdk.adv.showRewardedVideo, ysdk.features.GameplayAPI / LoadingAPI,
 * события game_api_pause / game_api_resume). Описана здесь, чтобы адаптер проверялся на заглушке.
 */
export interface YandexPlayer {
  getData(keys?: string[]): Promise<Record<string, unknown>>;
  setData(data: Record<string, unknown>, flush?: boolean): Promise<void>;
}

export interface YandexSdk {
  getPlayer(opts?: { scopes?: boolean }): Promise<YandexPlayer>;
  adv: {
    showRewardedVideo(opts: { callbacks: { onOpen?: () => void; onRewarded?: () => void; onClose?: () => void; onError?: (e: unknown) => void } }): void;
  };
  features?: {
    LoadingAPI?: { ready(): void };
    GameplayAPI?: { start(): void; stop(): void };
  };
  on?(event: 'game_api_pause' | 'game_api_resume', cb: () => void): void;
}

/** Ключ сохранения в облачных данных игрока. */
const CLOUD_KEY = 'save';

export class YandexPlatform implements Platform {
  readonly name = 'yandex' as const;
  readonly hasRewardedAds = true;
  private player: YandexPlayer | null = null;
  private playing = false;
  /** Реклама показывается: повторное нажатие кнопки не открывает вторую. */
  private adOpen = false;

  constructor(private sdk: YandexSdk) {}

  private async getPlayer(): Promise<YandexPlayer | null> {
    if (this.player) return this.player;
    try {
      this.player = await this.sdk.getPlayer({ scopes: false });
    } catch {
      this.player = null;
    }
    return this.player;
  }

  async loadCloud(): Promise<string | null> {
    const p = await this.getPlayer();
    if (!p) return null;
    try {
      const data = await p.getData([CLOUD_KEY]);
      const v = data[CLOUD_KEY];
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  async saveCloud(json: string): Promise<void> {
    const p = await this.getPlayer();
    if (!p) return;
    try {
      await p.setData({ [CLOUD_KEY]: json });
    } catch {
      // Облако недоступно — остаётся локальное сохранение.
    }
  }

  showRewardedAd(cb: RewardedAdCallbacks): void {
    if (this.adOpen) return;
    this.adOpen = true;
    let rewarded = false;
    const done = () => {
      if (!this.adOpen) return;
      this.adOpen = false;
      cb.onClose?.();
    };
    try {
      this.sdk.adv.showRewardedVideo({
        callbacks: {
          onOpen: () => cb.onOpen?.(),
          // Платформа может вызвать onRewarded больше одного раза — награда только за первый.
          onRewarded: () => {
            if (rewarded) return;
            rewarded = true;
            cb.onRewarded();
          },
          onClose: done,
          onError: (e) => {
            cb.onError?.(e);
            done();
          },
        },
      });
    } catch (e) {
      cb.onError?.(e);
      done();
    }
  }

  onPause(cb: () => void): void {
    this.sdk.on?.('game_api_pause', cb);
  }

  onResume(cb: () => void): void {
    this.sdk.on?.('game_api_resume', cb);
  }

  gameplayStart(): void {
    if (this.playing) return;
    this.playing = true;
    this.sdk.features?.GameplayAPI?.start();
  }

  gameplayStop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.sdk.features?.GameplayAPI?.stop();
  }

  ready(): void {
    this.sdk.features?.LoadingAPI?.ready();
  }
}
