import type { Platform, RewardedAdCallbacks } from './types';

/** Обычный браузер: облака и рекламы нет, сохранение — только локальное (main.ts). */
export class LocalPlatform implements Platform {
  readonly name = 'local' as const;
  readonly hasRewardedAds = false;
  async loadCloud(): Promise<string | null> {
    return null;
  }
  async saveCloud(): Promise<void> {}
  showRewardedAd(cb: RewardedAdCallbacks): void {
    cb.onError?.(new Error('Реклама недоступна'));
  }
  onPause(): void {}
  onResume(): void {}
  gameplayStart(): void {}
  gameplayStop(): void {}
  ready(): void {}
}
