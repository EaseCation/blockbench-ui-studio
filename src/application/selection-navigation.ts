import { topSelection } from '../domain/document';
import type { Id, ResolvedScene, UiDocument } from '../domain/types';

/** Navigate logical layers only. Native Image carrier Cubes are never children here. */
export function navigateSelection(
  doc: UiDocument,
  scene: ResolvedScene,
  ids: Id[],
  direction: 'children' | 'parent',
): Id[] {
  const eligible = (id: Id) => {
    const resolved = scene.nodes[id];
    if (!resolved?.visible || resolved.locked) return false;
    for (let n = doc.nodes[id]; n; n = n.parent ? doc.nodes[n.parent] : undefined)
      if (n.suspended) return false;
    return !!doc.nodes[id];
  };
  const candidates = topSelection(doc, [...new Set(ids)])
    .filter(eligible)
    .flatMap((id) => {
      const node = doc.nodes[id]!;
      const next =
        direction === 'children'
          ? node.children.filter(eligible)
          : node.parent && eligible(node.parent)
            ? [node.parent]
            : [];
      // Keep branches that reached a leaf/root instead of silently losing a partial selection.
      return next.length ? next : [id];
    });
  const selected = new Set(topSelection(doc, [...new Set(candidates)]));
  return scene.order.filter((id) => selected.has(id));
}
