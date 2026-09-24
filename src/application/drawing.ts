import { createNode, type Id, type Point, type Rect, type UiDocument } from '../domain/types';
import { reparentNodes, retainWorldRect } from '../domain/tree-editing';
import { layout } from '../domain/layout';
import type { DropIntent } from './targets';
export type DrawKind = 'frame' | 'image';
export interface DrawingPoint {
  world: Point;
  screen: Point;
  shift: boolean;
  alt: boolean;
  space: boolean;
  control?: boolean;
  inside?: boolean;
}
export interface DrawRequest {
  kind: DrawKind;
  rect: Rect;
  target: DropIntent | null;
}

export function drawingRect(start: Point, end: Point, shift: boolean, alt: boolean): Rect {
  const x = Math.round(start.x),
    y = Math.round(start.y);
  let dx = Math.round(end.x) - x,
    dy = Math.round(end.y) - y;
  if (shift) {
    const size = Math.max(1, Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }
  const w = Math.max(1, Math.abs(dx)),
    h = Math.max(1, Math.abs(dy));
  return alt
    ? { x: x - w, y: y - h, width: w * 2, height: h * 2 }
    : { x: dx < 0 ? x - w : x, y: dy < 0 ? y - h : y, width: w, height: h };
}
export function insertDrawing(doc: UiDocument, id: Id, request: DrawRequest) {
  const { kind, rect, target } = request;
  if (!Object.values(rect).every(Number.isSafeInteger) || rect.width < 1 || rect.height < 1)
    throw new Error('绘制尺寸必须是正整数像素');
  if (kind === 'image' && rect.width * rect.height > 16_777_216)
    throw new Error('Image 超过 1600 万像素限制');
  if (target) {
    const parent = doc.nodes[target.parentId];
    if (!parent) throw new Error('绘制的目标容器已不存在');
    let ancestor: typeof parent | undefined = parent;
    while (ancestor) {
      if (ancestor.locked || !ancestor.visible || ancestor.suspended)
        throw new Error('绘制的目标容器已不可编辑');
      ancestor = ancestor.parent ? doc.nodes[ancestor.parent] : undefined;
    }
  }
  const base = kind === 'frame' ? 'Frame' : 'Image',
    names = new Set(Object.values(doc.nodes).map((n) => n.name));
  let name = base,
    index = 2;
  while (names.has(name)) name = base + ' ' + index++;
  const node = createNode(id, name, kind, { ...rect });
  doc.nodes[id] = node;
  doc.roots.push(id);
  if (target) reparentNodes(doc, [id], target.parentId, target.index);
  if (!target) retainWorldRect(doc, node, rect);
  return node;
}
export function previewDrawing(doc: UiDocument, request: DrawRequest): Rect {
  const candidate: UiDocument = {
    ...doc,
    roots: [...doc.roots],
    nodes: Object.fromEntries(
      Object.entries(doc.nodes).map(([id, n]) => [id, { ...n, children: [...n.children] }]),
    ),
  };
  let id = 'mcui-drawing-preview';
  while (candidate.nodes[id]) id += '-';
  insertDrawing(candidate, id, request);
  const result = layout(candidate).nodes[id]!;
  return result.bounds ?? result.rect;
}
/** Gesture state is pure and never writes the document, a bitmap or Undo. */
export class DrawingMachine {
  constructor(private snap?: (rect: Rect, origin: Point, point: DrawingPoint) => Rect) {}
  request: DrawRequest | null = null;
  private origin: Point = { x: 0, y: 0 };
  private startScreen: Point = { x: 0, y: 0 };
  private last: DrawingPoint | null = null;
  private moved = false;
  begin(kind: DrawKind, point: DrawingPoint, target: DropIntent | null) {
    this.origin = { ...point.world };
    this.startScreen = { ...point.screen };
    this.last = point;
    this.moved = false;
    this.request = {
      kind,
      rect: drawingRect(this.origin, point.world, point.shift, point.alt),
      target: target ? { ...target } : null,
    };
  }
  update(point: DrawingPoint) {
    if (!this.request || !this.last) return;
    if (Math.hypot(point.screen.x - this.startScreen.x, point.screen.y - this.startScreen.y) >= 3)
      this.moved = true;
    if (point.space) {
      this.origin.x += point.world.x - this.last.world.x;
      this.origin.y += point.world.y - this.last.world.y;
    }
    this.last = point;
    const rect = drawingRect(this.origin, point.world, point.shift, point.alt);
    this.request.rect = this.snap?.(rect, this.origin, point) ?? rect;
  }
  modifiers(shift: boolean, alt: boolean, space: boolean, control = false) {
    if (this.last) this.update({ ...this.last, shift, alt, space, control });
  }
  finish(): DrawRequest | null {
    const result = this.moved ? this.request : null;
    this.cancel();
    return result;
  }
  cancel() {
    this.request = null;
    this.last = null;
    this.moved = false;
  }
}
