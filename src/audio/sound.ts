/**
 * Процедурный звук (веха 0.5, этап 5): всё синтезируется WebAudio в браузере — без аудиофайлов и библиотек
 * (как графика собирается из примитивов, решение Q4). Ядро о звуке не знает: события приходят из game.ts и main.ts.
 *
 * - AudioContext создаётся после первого касания или нажатия клавиши (требование браузеров).
 * - Настройки (вкл/выкл, громкость) хранятся в браузере; при сбое хранилища — значения по умолчанию.
 * - Пауза (сворачивание, реклама, пауза платформы) — ctx.suspend(); музыка и фон качалок стоят.
 */
export type SoundKind = 'sale' | 'build' | 'goal' | 'error';

const KEY = 'oil-tycoon-sound';
/** Минимальный интервал между одинаковыми звуками, с: терминалы продают каждый шаг — не звеним каждый шаг. */
const MIN_GAP: Record<SoundKind, number> = { sale: 1.2, build: 0.08, goal: 0.5, error: 0.3 };
/** Пентатоника (до мажор) для фоновой музыки, Гц. */
const SCALE = [130.81, 146.83, 164.81, 196.0, 220.0, 261.63, 293.66, 329.63, 392.0, 440.0];

export interface SoundSettings {
  on: boolean;
  volume: number;
}

export class Sound {
  settings: SoundSettings = { on: true, volume: 0.6 };
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last: Partial<Record<SoundKind, number>> = {};
  private paused = false;
  private nextChug = 0;
  private nextNote = 0;
  private step = 0;
  /** Замер: суммарное время вызовов звука в кадре (мс) и число кадров — для отчёта о нагрузке. */
  readonly stats = { ms: 0, frames: 0, voices: 0 };

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw) as Partial<SoundSettings>;
        if (typeof v.on === 'boolean') this.settings.on = v.on;
        if (typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1) this.settings.volume = v.volume;
      }
    } catch {
      // Хранилище недоступно — настройки по умолчанию.
    }
    const unlock = () => {
      this.start();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  get started(): boolean {
    return this.ctx !== null;
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      // Не сохранилось — действует до перезагрузки.
    }
  }

  /** Создание аудиоконтекста — только из обработчика жеста пользователя. */
  start(): void {
    if (this.ctx) return;
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.music = this.ctx.createGain();
    this.music.gain.value = 0.35;
    this.music.connect(this.master);
    // Белый шум на 1 с — основа ударов и «пыхтения» качалок.
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      d[i] = (seed / 2 ** 32) * 2 - 1;
    }
    this.applyVolume();
    if (this.paused) void this.ctx.suspend();
  }

  setOn(on: boolean): void {
    this.settings.on = on;
    this.applyVolume();
    this.save();
  }

  setVolume(v: number): void {
    this.settings.volume = Math.max(0, Math.min(1, v));
    this.applyVolume();
    this.save();
  }

  private applyVolume(): void {
    if (!this.master || !this.ctx) return;
    const v = this.settings.on ? this.settings.volume * 0.5 : 0;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Пауза (сворачивание, реклама, пауза платформы): контекст останавливается целиком. */
  setPaused(p: boolean): void {
    this.paused = p;
    if (!this.ctx) return;
    if (p) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  private ready(): AudioContext | null {
    if (!this.ctx || !this.master || this.paused || !this.settings.on || this.settings.volume <= 0) return null;
    if (this.ctx.state !== 'running') return null;
    return this.ctx;
  }

  private tone(freq: number, at: number, dur: number, type: OscillatorType, gain: number, dest: AudioNode, glide?: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(dest);
    o.start(at);
    o.stop(at + dur + 0.02);
    this.stats.voices++;
  }

  private burst(at: number, dur: number, freq: number, gain: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(at, Math.random() * 0.5, dur + 0.05);
    this.stats.voices++;
  }

  /** Короткий звук события. */
  play(kind: SoundKind): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - (this.last[kind] ?? -Infinity) < MIN_GAP[kind]) return;
    this.last[kind] = t;
    const out = this.master!;
    if (kind === 'sale') {
      // Касса: две звонкие ноты.
      this.tone(1318.5, t, 0.18, 'sine', 0.22, out);
      this.tone(1975.5, t + 0.07, 0.3, 'sine', 0.18, out);
    } else if (kind === 'build') {
      // Стройка: глухой удар и стук металла.
      this.burst(t, 0.18, 600, 0.6, out);
      this.tone(110, t, 0.22, 'sine', 0.5, out, 55);
      this.tone(880, t + 0.05, 0.08, 'square', 0.05, out);
    } else if (kind === 'goal') {
      // Цель: восходящее арпеджио.
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, t + i * 0.09, 0.45, 'triangle', 0.2, out));
    } else {
      this.tone(220, t, 0.15, 'square', 0.06, out, 160);
    }
  }

  /**
   * Каждый кадр: фон качалок (мягкое «пыхтение» в ритме станков, громче при большем их числе) и генеративная
   * музыка — медленные ноты пентатоники по псевдослучайной последовательности, без файлов.
   */
  update(workingPumps: number, running: boolean): void {
    const t0 = performance.now();
    const ctx = this.ready();
    if (ctx && running) {
      const t = ctx.currentTime;
      if (workingPumps > 0 && t >= this.nextChug) {
        const level = Math.min(1, workingPumps / 12);
        this.burst(t + 0.01, 0.25, 260, 0.12 + 0.18 * level, this.master!);
        this.tone(55, t + 0.01, 0.3, 'sine', 0.08 + 0.1 * level, this.master!);
        this.nextChug = t + 1.6 - 0.4 * level;
      }
      if (t >= this.nextNote) {
        this.step++;
        const h = (this.step * 2654435761) >>> 0;
        const note = SCALE[(h >>> 7) % SCALE.length];
        // Аккорд из основного тона и квинты раз в четыре шага, иначе одиночная нота.
        this.tone(note, t + 0.02, 2.6, 'triangle', 0.12, this.music!);
        if (this.step % 4 === 0) this.tone(note * 1.5, t + 0.02, 3.2, 'sine', 0.06, this.music!);
        if (this.step % 8 === 0) this.tone(SCALE[0] / 2, t + 0.02, 4, 'sine', 0.1, this.music!);
        this.nextNote = t + 1.4 + ((h >>> 3) % 3) * 0.35;
      }
    }
    this.stats.ms += performance.now() - t0;
    this.stats.frames++;
  }
}
