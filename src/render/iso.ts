/** Размер ромба клетки в пикселях мира. */
export const TW = 64;
export const TH = 32;

/** Клеточные координаты (могут быть дробными) → пиксели мира. */
export function isoX(x: number, y: number): number {
  return ((x - y) * TW) / 2;
}

export function isoY(x: number, y: number): number {
  return ((x + y) * TH) / 2;
}

/** Пиксели мира → дробные клеточные координаты (на уровне земли). */
export function worldToTile(wx: number, wy: number): { x: number; y: number } {
  const a = wx / (TW / 2);
  const b = wy / (TH / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  readonly minZoom = 0.35;
  readonly maxZoom = 2.2;

  screenToWorld(sx: number, sy: number, w: number, h: number): { x: number; y: number } {
    return { x: (sx - w / 2) / this.zoom + this.x, y: (sy - h / 2) / this.zoom + this.y };
  }

  /** Масштабирование с сохранением точки под курсором. */
  zoomAt(factor: number, sx: number, sy: number, w: number, h: number): void {
    const before = this.screenToWorld(sx, sy, w, h);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy, w, h);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Держит центр камеры над игровой картой с небольшим запасом: за пределами — только окружение, улететь в пустоту нельзя. */
  clampToTiles(min: number, max: number): void {
    const t = worldToTile(this.x, this.y);
    const x = Math.min(max, Math.max(min, t.x));
    const y = Math.min(max, Math.max(min, t.y));
    if (x !== t.x || y !== t.y) this.centerOnTile(x, y);
  }

  centerOnTile(x: number, y: number): void {
    this.x = isoX(x, y);
    this.y = isoY(x, y);
  }
}
