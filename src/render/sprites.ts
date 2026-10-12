import { bakeSprite, type ModelPainter, type Sprite } from './model';
import * as models from './models';
import { createCanvas, grimeTexture } from './noise';

/** Кадров в цикле качания станка-качалки. */
export const PUMP_FRAMES = 48;

/**
 * Библиотека запечённых спрайтов. Модели рисуются один раз при первом обращении и кешируются,
 * поэтому в кадре остаются только дешёвые drawImage.
 */
export class SpriteLibrary {
  private cache = new Map<string, Sprite>();
  private grime = grimeTexture(128, 7, { contrast: 1 });
  private streaks = grimeTexture(128, 11, { streaks: true, contrast: 1.1 });
  private foliage = grimeTexture(64, 3, { contrast: 2.4 });

  canvases(): HTMLCanvasElement[] {
    return [...this.cache.values()].map((s) => s.canvas);
  }

  private get(key: string, build: () => Sprite): Sprite {
    let s = this.cache.get(key);
    if (!s) {
      s = build();
      this.cache.set(key, s);
    }
    return s;
  }

  private bake(draw: (p: ModelPainter) => void, texture: HTMLCanvasElement, strength: number): Sprite {
    return bakeSprite(draw, { texture, strength });
  }

  pumpjack(level: number, phase: number, orient = 0): Sprite {
    const turn = phase / (Math.PI * 2);
    const frame = Math.floor((turn - Math.floor(turn)) * PUMP_FRAMES) % PUMP_FRAMES;
    return this.get(`pump:${level}:${orient}:${frame}`, () =>
      this.bake((p) => models.pumpjack(p, level, (frame / PUMP_FRAMES) * Math.PI * 2, orient), this.grime, 0.45),
    );
  }

  tank(level: number): Sprite {
    return this.get(`tank:${level}`, () => this.bake((p) => models.tank(p, level), this.streaks, 0.55));
  }

  terminalBack(level: number): Sprite {
    return this.get(`termB:${level}`, () => this.bake((p) => models.terminalBack(p, level), this.grime, 0.45));
  }

  terminalFront(level: number): Sprite {
    return this.get(`termF:${level}`, () => this.bake((p) => models.terminalFront(p, level), this.grime, 0.4));
  }

  truck(): Sprite {
    return this.get('truck', () => this.bake((p) => models.truck(p), this.grime, 0.35));
  }

  truckReverse(): Sprite {
    return this.get('truckR', () => this.bake((p) => models.truckReverse(p), this.grime, 0.35));
  }

  headquarters(): Sprite {
    return this.get('hq', () => this.bake((p) => models.headquarters(p), this.grime, 0.4));
  }

  /** Декор: 1 — куст, 2 — камень, 3 — дерево. dim — вариант для чужой (затемнённой) земли. */
  decor(kind: number, variant: number, dim: boolean): Sprite {
    const key = `decor:${kind}:${variant}`;
    if (dim) return this.get(`${key}:dim`, () => dimmed(this.decor(kind, variant, false)));
    return this.get(key, () => {
      if (kind === 2) return this.bake((p) => models.rock(p, variant), this.grime, 0.7);
      if (kind === 3) return this.bake((p) => models.tree(p, variant), this.foliage, 0.6);
      return this.bake((p) => models.shrub(p, variant), this.foliage, 0.6);
    });
  }
}

/** Копия спрайта, приглушённая так же, как чужая земля. */
function dimmed(src: Sprite): Sprite {
  const canvas = createCanvas(src.canvas.width, src.canvas.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(src.canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = 'rgba(14,20,30,0.5)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { ...src, canvas };
}
