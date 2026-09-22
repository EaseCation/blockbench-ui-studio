import type { Handle, Point, Rect } from './types';
export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
}
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}
export function bounds(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}
export function fromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}
export function resizeRect(
  start: Rect,
  handle: Handle,
  delta: Point,
  shift = false,
  alt = false,
  minWidth = 1,
  minHeight = 1,
): Rect {
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const factor = alt ? 2 : 1;
  let width = Math.max(minWidth, start.width + sx * Math.round(delta.x) * factor);
  let height = Math.max(minHeight, start.height + sy * Math.round(delta.y) * factor);
  if (shift) {
    let scale =
      sx && sy
        ? Math.abs(width / start.width - 1) > Math.abs(height / start.height - 1)
          ? width / start.width
          : height / start.height
        : sx
          ? width / start.width
          : height / start.height;
    scale = Math.max(scale, minWidth / start.width, minHeight / start.height);
    width = Math.max(minWidth, Math.round(start.width * scale));
    height = Math.max(minHeight, Math.round(start.height * scale));
  }
  if (alt) {
    width = Math.max(minWidth, start.width + 2 * Math.round((width - start.width) / 2));
    height = Math.max(minHeight, start.height + 2 * Math.round((height - start.height) / 2));
  }
  const x =
    alt || (!sx && shift)
      ? start.x + (start.width - width) / 2
      : sx < 0
        ? start.x + start.width - width
        : start.x;
  const y =
    alt || (!sy && shift)
      ? start.y + (start.height - height) / 2
      : sy < 0
        ? start.y + start.height - height
        : start.y;
  return { x, y, width, height };
}
export function mapRect(rect: Rect, from: Rect, to: Rect): Rect {
  return {
    x: to.x + Math.round(((rect.x - from.x) * to.width) / from.width),
    y: to.y + Math.round(((rect.y - from.y) * to.height) / from.height),
    width: Math.max(1, Math.round((rect.width * to.width) / from.width)),
    height: Math.max(1, Math.round((rect.height * to.height) / from.height)),
  };
}
export interface Measurement {
  from: Point;
  to: Point;
  value: number;
}
export function distances(a: Rect, b: Rect): Measurement[] {
  const lines: Measurement[] = [];
  const add = (from: Point, to: Point) =>
    lines.push({
      from,
      to,
      value: Math.round(Math.hypot(to.x - from.x, to.y - from.y) * 100) / 100,
    });
  const outer =
    contains(a, { x: b.x, y: b.y }) && contains(a, { x: b.x + b.width, y: b.y + b.height })
      ? a
      : contains(b, { x: a.x, y: a.y }) && contains(b, { x: a.x + a.width, y: a.y + a.height })
        ? b
        : null;
  if (outer) {
    const inner = outer === a ? b : a,
      cx = inner.x + inner.width / 2,
      cy = inner.y + inner.height / 2;
    add({ x: outer.x, y: cy }, { x: inner.x, y: cy });
    add({ x: inner.x + inner.width, y: cy }, { x: outer.x + outer.width, y: cy });
    add({ x: cx, y: outer.y }, { x: cx, y: inner.y });
    add({ x: cx, y: inner.y + inner.height }, { x: cx, y: outer.y + outer.height });
  } else {
    if (a.x + a.width <= b.x)
      add({ x: a.x + a.width, y: a.y + a.height / 2 }, { x: b.x, y: a.y + a.height / 2 });
    else if (b.x + b.width <= a.x)
      add({ x: b.x + b.width, y: a.y + a.height / 2 }, { x: a.x, y: a.y + a.height / 2 });
    if (a.y + a.height <= b.y)
      add({ x: a.x + a.width / 2, y: a.y + a.height }, { x: a.x + a.width / 2, y: b.y });
    else if (b.y + b.height <= a.y)
      add({ x: a.x + a.width / 2, y: b.y + b.height }, { x: a.x + a.width / 2, y: a.y });
    if (!lines.length) {
      add({ x: a.x, y: a.y }, { x: b.x, y: a.y });
      add({ x: a.x, y: a.y }, { x: a.x, y: b.y });
    }
  }
  return lines;
}
