import { corners, polygonContains, polygonsIntersect } from '../domain/transform';
import { contains } from '../domain/geometry';
import { topSelection } from '../domain/document';
import type { Id, Point, Rect, UiDocument } from '../domain/types';
import type { PickNode } from './targets';

/** Scope is a containing container, never a plain drawable leaf under the pointer. */
export function marqueeScope(doc: UiDocument, nodes: PickNode[], start: Point): Id | null {
  return (
    nodes
      .filter(
        (n) =>
          !n.disabled &&
          (n.kind === 'frame' || doc.nodes[n.id]!.children.length > 0) &&
          polygonContains(n.polygon ?? corners(n.rect), start),
      )
      .sort((a, b) => b.level - a.level || b.rank - a.rank)[0]?.id ?? null
  );
}

/** A normal marquee chooses outer branches of its scope; deep selection keeps inner hits. */
export function selectMarquee(
  doc: UiDocument,
  nodes: PickNode[],
  rect: Rect,
  initialScope: Id | null,
  deep: boolean,
  previous: Id[] = [],
): Id[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const eligible = new Set<Id>();
  for (const n of nodes) {
    if (n.disabled) continue;
    let parent = doc.nodes[n.id]?.parent,
      blocked = false;
    while (parent) {
      if (byId.get(parent)?.disabled) {
        blocked = true;
        break;
      }
      parent = doc.nodes[parent]?.parent;
    }
    if (!blocked) eligible.add(n.id);
  }
  let scope = initialScope;
  // Crossing the starting container expands to the common outer scope.
  while (
    scope &&
    (!byId.has(scope) ||
      !corners(rect).every((p) =>
        polygonContains(byId.get(scope!)!.polygon ?? corners(byId.get(scope!)!.rect), p),
      ))
  )
    scope = doc.nodes[scope]?.parent ?? null;
  if (!deep && previous.length) {
    const within = (id: Id, ancestor: Id) => {
      for (let parent = doc.nodes[id]?.parent; parent; parent = doc.nodes[parent]?.parent)
        if (parent === ancestor) return true;
      return false;
    };
    while (scope && previous.some((id) => eligible.has(id) && !within(id, scope!)))
      scope = doc.nodes[scope]?.parent ?? null;
  }
  const excluded = new Set<Id>();
  for (let id = scope; id; id = doc.nodes[id]?.parent ?? null) excluded.add(id);
  const hits = nodes
    .filter(
      (n) =>
        eligible.has(n.id) &&
        !excluded.has(n.id) &&
        (n.kind === 'image'
          ? polygonsIntersect(corners(rect), n.polygon ?? corners(n.rect))
          : (n.polygon ?? corners(n.rect)).every((p) => contains(rect, p))),
    )
    .map((n) => n.id);
  let selected: Id[];
  if (deep) {
    selected = hits;
  } else {
    selected = [];
    for (const id of [...previous.filter((id) => eligible.has(id)), ...hits]) {
      let branch = id;
      while (doc.nodes[branch]?.parent && doc.nodes[branch]!.parent !== scope)
        branch = doc.nodes[branch]!.parent!;
      if (doc.nodes[branch]?.parent === scope && eligible.has(branch)) selected.push(branch);
    }
  }
  const candidates = new Set([
    ...(deep ? previous.filter((id) => eligible.has(id)) : []),
    ...selected,
  ]);
  if (deep) {
    // New inner hits supersede an old outer selection, including Shift+deep marquee.
    for (const id of [...candidates])
      for (let p = doc.nodes[id]?.parent; p; p = doc.nodes[p]?.parent) candidates.delete(p);
  }
  const roots = topSelection(doc, [...candidates]);
  const chosen = new Set(roots);
  return nodes.filter((n) => chosen.has(n.id)).map((n) => n.id);
}
