/**
 * Адаптер игровой платформы (веха 0.5, этап 3). Игра работает с этим интерфейсом и не знает, где запущена:
 * `local` — обычный браузер, `yandex` — «Яндекс Игры» через их SDK. Ядро (src/core) о платформе не знает.
 */
export interface RewardedAdCallbacks {
  /** Реклама началась: игра и звук на паузе. */
  onOpen?: () => void;
  /** Платформа подтвердила просмотр — только здесь выдаётся награда. */
  onRewarded: () => void;
  /** Реклама закрыта (с наградой или без): снять паузу. */
  onClose?: () => void;
  onError?: (e: unknown) => void;
}

export interface Platform {
  readonly name: 'local' | 'yandex';
  /** Есть ли реклама за награду (без SDK — нет, кнопку не показываем). */
  readonly hasRewardedAds: boolean;
  /** Облачное сохранение или null (нет облака или в облаке пусто). */
  loadCloud(): Promise<string | null>;
  saveCloud(json: string): Promise<void>;
  showRewardedAd(cb: RewardedAdCallbacks): void;
  /** Подписка на паузу и возобновление от платформы (например, при её собственной рекламе или меню). */
  onPause(cb: () => void): void;
  onResume(cb: () => void): void;
  /** Игрок играет / не играет (разметка геймплея для платформы). */
  gameplayStart(): void;
  gameplayStop(): void;
  /** Игра загружена и готова (платформа убирает свой экран загрузки). */
  ready(): void;
}
