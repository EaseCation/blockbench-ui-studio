import { corners, polygonContains, edgeDistance, pointBounds } from '../domain/transform';
import { contains } from '../domain/geometry';
import { descendants } from '../domain/document';
import type { Id, Point, Rect, UiDocument } from '../domain/types';
export interface PickNode {
  id: Id;
  kind: 'image' | 'frame';
  rect: Rect;
  polygon?: Point[];
  label?: Rect;
  labelBox?: Rect;
  labelAngle?: number;
  labelPolygon?: Point[];
  rank: number;
  level: number;
  disabled: boolean;
}
export interface DropIntent {
  parentId: Id;
  index?: number;
}
export interface DropTarget extends DropIntent {
  line?: { from: Point; to: Point };
}
const priority = (a: PickNode, b: PickNode) => b.level - a.level || b.rank - a.rank;
export function pickNode(
  nodes: PickNode[],
  point: Point,
  selection: readonly Id[] = [],
): Id | null {
  const available = nodes.filter((n) => !n.disabled && n.rect.width > 0 && n.rect.height > 0);
  const label = available
    .filter(
      (n) =>
        n.label &&
        (n.labelPolygon ? polygonContains(n.labelPolygon, point) : contains(n.label, point)),
    )
    .sort(priority)[0];
  if (label) return label.id;
  // A selected container is a drag surface, including its blank interior and children.
  // Test each actual polygon, not the bounding box spanning a multiple selection.
  const selected = available
    .filter((n) => selection.includes(n.id) && polygonContains(n.polygon ?? corners(n.rect), point))
    .sort(priority)[0];
  if (selected) return selected.id;
  const edge = available
    .filter((n) => n.kind === 'frame' && edgeDistance(n.polygon ?? corners(n.rect), point) <= 6)
    .sort(priority)[0];
  if (edge) return edge.id;
  return (
    available
      .filter((n) => n.kind === 'image' && polygonContains(n.polygon ?? corners(n.rect), point))
      .sort((a, b) => b.rank - a.rank)[0]?.id ?? null
  );
}
export function pickDrop(
  doc: UiDocument,
  nodes: PickNode[],
  ids: Id[],
  point: Point,
  automatic: boolean,
): DropTarget | null {
  const excluded = new Set(ids.flatMap((id) => descendants(doc, id)));
  let available = nodes.filter(
    (n) =>
      !n.disabled &&
      n.rect.width > 0 &&
      n.rect.height > 0 &&
      !doc.nodes[n.id]?.suspended &&
      !excluded.has(n.id) &&
      polygonContains(n.polygon ?? corners(n.rect), point),
  );
  if (!automatic)
    available = available.filter(
      (n) =>
        doc.nodes[n.id]?.frame?.engineType === 'stack_panel' &&
        ids.every((id) => doc.nodes[id]?.parent === n.id),
    );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const axes = (n: PickNode) => {
    const poly = n.polygon ?? corners(n.rect),
      origin = poly[0]!,
      w = Math.hypot(poly[1]!.x - origin.x, poly[1]!.y - origin.y),
      h = Math.hypot(poly[3]!.x - origin.x, poly[3]!.y - origin.y);
    const u = { x: (poly[1]!.x - origin.x) / w, y: (poly[1]!.y - origin.y) / w },
      v = { x: (poly[3]!.x - origin.x) / h, y: (poly[3]!.y - origin.y) / h };
    return {
      w,
      h,
      local: (p: Point) => ({
        x: (p.x - origin.x) * u.x + (p.y - origin.y) * u.y,
        y: (p.x - origin.x) * v.x + (p.y - origin.y) * v.y,
      }),
      world: (p: Point) => ({
        x: origin.x + p.x * u.x + p.y * v.x,
        y: origin.y + p.x * u.y + p.y * v.y,
      }),
    };
  };
  const childBounds = (id: Id, t: ReturnType<typeof axes>) => {
    const c = byId.get(id);
    return c ? pointBounds((c.polygon ?? corners(c.rect)).map(t.local)) : undefined;
  };
  const edgeStacks = available
    .filter((n) => {
      const f = doc.nodes[n.id]?.frame;
      if (f?.engineType !== 'stack_panel') return false;
      const t = axes(n),
        p = t.local(point),
        row = f.direction === 'row';
      return doc.nodes[n.id]!.children.some((id) => {
        const c = byId.get(id),
          r = childBounds(id, t);
        if (!c || !r || excluded.has(id) || c.disabled) return false;
        const along = row ? p.x : p.y,
          start = row ? r.x : r.y,
          end = start + (row ? r.width : r.height),
          cross = row ? p.y : p.x,
          crossStart = row ? r.y : r.x,
          crossEnd = crossStart + (row ? r.height : r.width);
        return (
          cross >= crossStart &&
          cross <= crossEnd &&
          Math.min(Math.abs(along - start), Math.abs(along - end)) <= 6
        );
      });
    })
    .sort(priority);
  const target = edgeStacks[0] ?? available.sort(priority)[0];
  if (!target) return null;
  const n = doc.nodes[target.id]!;
  if (n.frame?.engineType !== 'stack_panel')
    return ids.length > 0 && ids.every((id) => doc.nodes[id]?.parent === n.id)
      ? null
      : { parentId: n.id };
  const row = n.frame.direction === 'row',
    t = axes(target),
    p = t.local(point),
    coordinate = row ? p.x : p.y;
  const children = n.children.filter(
    (id) =>
      !excluded.has(id) && doc.nodes[id]?.visible && doc.nodes[id]?.layout.positioning === 'flow',
  );
  const before = children.find((id) => {
    const r = childBounds(id, t);
    return r && coordinate < (row ? r.x + r.width / 2 : r.y + r.height / 2);
  });
  const index = before ? n.children.indexOf(before) : n.children.length;
  const r = childBounds(before ?? children.at(-1) ?? '', t);
  const edge = r ? (row ? r.x + (before ? 0 : r.width) : r.y + (before ? 0 : r.height)) : 0;
  return {
    parentId: n.id,
    index,
    line: row
      ? { from: t.world({ x: edge, y: 0 }), to: t.world({ x: edge, y: t.h }) }
      : { from: t.world({ x: 0, y: edge }), to: t.world({ x: t.w, y: edge }) },
  };
}

/** Creation has no moving selection to exclude. */
export function pickDrawingParent(
  doc: UiDocument,
  nodes: PickNode[],
  point: Point,
  automatic: boolean,
): DropTarget | null {
  return automatic ? pickDrop(doc, nodes, [], point, true) : null;
}
