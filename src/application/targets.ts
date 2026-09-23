import { contains } from '../domain/geometry';
import { descendants } from '../domain/document';
import type { Id, Point, Rect, UiDocument } from '../domain/types';
export interface PickNode {
  id: Id;
  kind: 'image' | 'frame';
  rect: Rect;
  label?: Rect;
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
export function pickNode(nodes: PickNode[], point: Point): Id | null {
  const available = nodes.filter((n) => !n.disabled);
  const label = available.filter((n) => n.label && contains(n.label, point)).sort(priority)[0];
  if (label) return label.id;
  const edge = available
    .filter(
      (n) =>
        n.kind === 'frame' &&
        contains(
          {
            x: n.rect.x - 6,
            y: n.rect.y - 6,
            width: n.rect.width + 12,
            height: n.rect.height + 12,
          },
          point,
        ) &&
        Math.min(
          Math.abs(point.x - n.rect.x),
          Math.abs(point.x - n.rect.x - n.rect.width),
          Math.abs(point.y - n.rect.y),
          Math.abs(point.y - n.rect.y - n.rect.height),
        ) <= 6,
    )
    .sort(priority)[0];
  if (edge) return edge.id;
  return (
    available
      .filter((n) => n.kind === 'image' && contains(n.rect, point))
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
      !n.disabled && !doc.nodes[n.id]?.suspended && !excluded.has(n.id) && contains(n.rect, point),
  );
  if (!automatic)
    available = available.filter(
      (n) =>
        doc.nodes[n.id]?.frame?.engineType === 'stack_panel' &&
        ids.every((id) => doc.nodes[id]?.parent === n.id),
    );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edgeStacks = available
    .filter((n) => {
      const f = doc.nodes[n.id]?.frame;
      if (f?.engineType !== 'stack_panel') return false;
      return doc.nodes[n.id]!.children.some((id) => {
        const c = byId.get(id);
        if (!c || excluded.has(id) || c.disabled) return false;
        const r = c.rect,
          row = f.direction === 'row';
        const along = row ? point.x : point.y,
          start = row ? r.x : r.y,
          end = start + (row ? r.width : r.height);
        const cross = row ? point.y : point.x,
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
    coordinate = row ? point.x : point.y;
  const children = n.children.filter(
    (id) =>
      !excluded.has(id) && doc.nodes[id]?.visible && doc.nodes[id]?.layout.positioning === 'flow',
  );
  const before = children.find((id) => {
    const r = byId.get(id)?.rect;
    return r && coordinate < (row ? r.x + r.width / 2 : r.y + r.height / 2);
  });
  const index = before ? n.children.indexOf(before) : n.children.length;
  const r = before ? byId.get(before)?.rect : byId.get(children.at(-1) ?? '')?.rect;
  const edge = r
    ? row
      ? r.x + (before ? 0 : r.width)
      : r.y + (before ? 0 : r.height)
    : row
      ? target.rect.x
      : target.rect.y;
  return {
    parentId: n.id,
    index,
    line: row
      ? {
          from: { x: edge, y: target.rect.y },
          to: { x: edge, y: target.rect.y + target.rect.height },
        }
      : {
          from: { x: target.rect.x, y: edge },
          to: { x: target.rect.x + target.rect.width, y: edge },
        },
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
