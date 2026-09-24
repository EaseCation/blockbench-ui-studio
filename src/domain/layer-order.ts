import { topSelection, siblings } from './document';
import type { Id, UiDocument } from './types';
export type LayerOrder = 'forward' | 'backward' | 'front' | 'back';
/** Sibling arrays are back-to-front. Each parent is processed independently. */
export function reorderSelection(doc: UiDocument, ids: Id[], order: LayerOrder): boolean {
  const lists = new Map<Id[], Set<Id>>();
  for (const id of topSelection(doc, ids)) {
    const n = doc.nodes[id]!,
      list = siblings(doc, n);
    if (!lists.has(list)) lists.set(list, new Set());
    lists.get(list)!.add(id);
  }
  let changed = false;
  for (const [list, selected] of lists) {
    const next = [...list];
    if (order === 'front' || order === 'back') {
      const moved = list.filter((id) => selected.has(id)),
        rest = list.filter((id) => !selected.has(id));
      next.splice(
        0,
        next.length,
        ...(order === 'front' ? [...rest, ...moved] : [...moved, ...rest]),
      );
    } else if (order === 'forward') {
      for (let i = next.length - 2; i >= 0; i--)
        if (selected.has(next[i]!) && !selected.has(next[i + 1]!))
          [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
    } else {
      for (let i = 1; i < next.length; i++)
        if (selected.has(next[i]!) && !selected.has(next[i - 1]!))
          [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
    }
    if (next.some((id, i) => id !== list[i])) {
      list.splice(0, list.length, ...next);
      changed = true;
    }
  }
  return changed;
}
