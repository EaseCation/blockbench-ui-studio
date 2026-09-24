import type { Id, Point, Rect, ResolvedScene, UiDocument } from './types';
import { bounds } from './geometry';
export interface Transform {
  angle: number;
  x: number;
  y: number;
}
export const identity = (): Transform => ({ angle: 0, x: 0, y: 0 });
export const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
/** Figma angles: positive counterclockwise in the UI's downward Y coordinate system. */
export function rotateVector(p: Point, angle: number): Point {
  const a = (-angle * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}
export function normalizeAngle(angle: number) {
  if (!Number.isFinite(angle)) throw new Error('旋转角度必须是有限数值');
  const value = ((((angle + 180) % 360) + 360) % 360) - 180;
  return Math.round(value * 1000) / 1000;
}
export function transformPoint(p: Point, t: Transform): Point {
  const r = rotateVector(p, t.angle);
  return { x: r.x + t.x, y: r.y + t.y };
}
export function inversePoint(p: Point, t: Transform): Point {
  return rotateVector({ x: p.x - t.x, y: p.y - t.y }, -t.angle);
}
export function around(c: Point, angle: number): Transform {
  const r = rotateVector(c, angle);
  return { angle, x: c.x - r.x, y: c.y - r.y };
}
export function compose(parent: Transform, own: Transform): Transform {
  const p = transformPoint(own, parent);
  return { angle: parent.angle + own.angle, x: p.x, y: p.y };
}
export function corners(r: Rect, t = identity()): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ].map((p) => transformPoint(p, t));
}
export function pointBounds(points: Point[]): Rect {
  return bounds(points.map((p) => ({ ...p, width: 0, height: 0 })))!;
}
export function documentTransforms(doc: UiDocument): Map<Id, Transform> {
  const result = new Map<Id, Transform>();
  const visit = (id: Id, parent: Transform) => {
    const n = doc.nodes[id]!;
    const t = compose(parent, around(center(n.rect), n.rotation ?? 0));
    result.set(id, t);
    n.children.forEach((child) => visit(child, t));
  };
  doc.roots.forEach((id) => visit(id, identity()));
  return result;
}
export function resolveTransforms(doc: UiDocument, scene: ResolvedScene) {
  for (const id of scene.order) {
    const n = doc.nodes[id]!,
      r = scene.nodes[id]!;
    r.transform = compose(
      n.parent ? scene.nodes[n.parent]!.transform! : identity(),
      around(center(r.rect), n.rotation ?? 0),
    );
    r.corners = corners(r.rect, r.transform);
    r.bounds = pointBounds(r.corners);
  }
}
export function worldRotation(doc: UiDocument, id: Id | null) {
  let result = 0;
  for (let n = id ? doc.nodes[id] : undefined; n; n = n.parent ? doc.nodes[n.parent] : undefined)
    result += n.rotation ?? 0;
  return result;
}
/** A pose retains intrinsic dimensions; its x/y encode the visual center before own rotation. */
export function worldPose(doc: UiDocument, id: Id, transforms = documentTransforms(doc)) {
  const n = doc.nodes[id]!,
    t = transforms.get(id)!,
    c = transformPoint(center(n.rect), t);
  return {
    rect: {
      x: c.x - n.rect.width / 2,
      y: c.y - n.rect.height / 2,
      width: n.rect.width,
      height: n.rect.height,
    },
    rotation: t.angle,
  };
}
export function poseInParent(
  doc: UiDocument,
  parent: Id | null,
  rect: Rect,
  rotation: number,
  transforms = documentTransforms(doc),
) {
  const t = parent ? transforms.get(parent)! : identity(),
    c = inversePoint(center(rect), t);
  return {
    rect: { ...rect, x: c.x - rect.width / 2, y: c.y - rect.height / 2 },
    rotation: normalizeAngle(rotation - t.angle),
  };
}
export function polygonContains(poly: Point[], p: Point): boolean {
  const signs = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  });
  return signs.every((v) => v >= -1e-7) || signs.every((v) => v <= 1e-7);
}
export function edgeDistance(poly: Point[], p: Point) {
  return Math.min(
    ...poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length]!,
        dx = b.x - a.x,
        dy = b.y - a.y;
      const t = Math.max(
        0,
        Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
      );
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    }),
  );
}
export function polygonsIntersect(a: Point[], b: Point[]) {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!,
        q = poly[(i + 1) % poly.length]!,
        axis = { x: p.y - q.y, y: q.x - p.x };
      const aa = a.map((p) => p.x * axis.x + p.y * axis.y),
        bb = b.map((p) => p.x * axis.x + p.y * axis.y);
      if (Math.max(...aa) < Math.min(...bb) || Math.max(...bb) < Math.min(...aa)) return false;
    }
  return true;
}
