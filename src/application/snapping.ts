import { descendants, topSelection } from '../domain/document';
import type { Id, Point, Rect, ResolvedScene, UiDocument } from '../domain/types';
export interface SnapReference {
  id: Id;
  rect: Rect;
  parent: boolean;
}
export interface SnapGuide {
  from: Point;
  to: Point;
  axis: 'x' | 'y';
}
type Axis = 'x' | 'y';
interface Match {
  ref: SnapReference;
  source: number;
  target: number;
  coordinate: number;
  delta: number;
}
const size = (axis: Axis) => (axis === 'x' ? 'width' : 'height');
const anchor = (r: Rect, axis: Axis, fraction: number) => r[axis] + r[size(axis)] * fraction;

/** Scope is the shared containing layer (or the prospective drop parent), never the whole tree. */
export function snapReferences(
  doc: UiDocument,
  scene: ResolvedScene,
  ids: Id[],
  hint?: Id | null,
): SnapReference[] {
  const roots = topSelection(doc, ids),
    excluded = new Set(roots.flatMap((id) => descendants(doc, id)));
  const chain = (id: Id) => {
    const result: Id[] = [];
    for (let p = doc.nodes[id]?.parent; p; p = doc.nodes[p]?.parent) result.push(p);
    return result;
  };
  const paths = roots.map(chain);
  const parent =
    hint !== undefined
      ? hint
      : (paths[0]?.find((id) => paths.every((p) => p.includes(id))) ?? null);
  const candidates = parent ? [parent, ...(doc.nodes[parent]?.children ?? [])] : doc.roots;
  return candidates
    .filter((id) => {
      if (excluded.has(id) || !scene.nodes[id]?.visible) return false;
      // Do not align a mixed-depth selection to one of its own containing branches.
      if (id !== parent && roots.some((root) => chain(root).includes(id))) return false;
      for (let n = doc.nodes[id]; n; n = n.parent ? doc.nodes[n.parent] : undefined)
        if (n.suspended) return false;
      return true;
    })
    .map((id) => ({
      id,
      rect: scene.nodes[id]!.bounds ?? scene.nodes[id]!.rect,
      parent: id === parent,
    }));
}

/** One session owns hysteresis only; references and all coordinates are pure world-space data. */
export class SnapSession {
  private matches: Partial<Record<Axis, Match>> = {};
  constructor(readonly references: SnapReference[]) {}
  clear() {
    this.matches = {};
  }
  align(
    rect: Rect,
    threshold: number,
    options: { x?: number[]; y?: number[]; accept?: (axis: Axis, delta: number) => boolean } = {},
  ) {
    const delta: Point = { x: 0, y: 0 };
    for (const axis of ['x', 'y'] as const) {
      const sources = options[axis] ?? [0, 0.5, 1],
        accept = (value: number) => options.accept?.(axis, value) ?? true;
      const old = this.matches[axis];
      let match: Match | undefined;
      if (old && sources.includes(old.source)) {
        const correction = old.coordinate - anchor(rect, axis, old.source);
        if (Math.abs(correction) <= threshold * 1.5 && accept(correction))
          match = { ...old, delta: correction };
      }
      if (!match) {
        const candidates: Match[] = [];
        for (const ref of this.references)
          for (const source of sources)
            for (const target of [0, 0.5, 1]) {
              const coordinate = anchor(ref.rect, axis, target),
                d = coordinate - anchor(rect, axis, source);
              if (Math.abs(d) <= threshold && accept(d))
                candidates.push({ ref, source, target, coordinate, delta: d });
            }
        const priority = (m: Match) =>
          (m.ref.parent ? 0 : 4) +
          (m.source === m.target ? 0 : 2) +
          (m.source === 0.5 && m.target === 0.5 ? 0 : 1);
        candidates.sort(
          (a, b) => Math.abs(a.delta) - Math.abs(b.delta) || priority(a) - priority(b),
        );
        match = candidates[0];
      }
      if (match) {
        this.matches[axis] = match;
        delta[axis] = match.delta;
      } else delete this.matches[axis];
    }
    return delta;
  }
  guides(rect: Rect, padding = 0): SnapGuide[] {
    const result: SnapGuide[] = [];
    for (const axis of ['x', 'y'] as const) {
      const m = this.matches[axis];
      if (!m || Math.abs(anchor(rect, axis, m.source) - m.coordinate) > 1e-5) continue;
      const cross = axis === 'x' ? 'y' : 'x',
        r = m.ref.rect;
      const start = Math.min(rect[cross], r[cross]) - padding,
        end = Math.max(rect[cross] + rect[size(cross)], r[cross] + r[size(cross)]) + padding;
      result.push(
        axis === 'x'
          ? { axis, from: { x: m.coordinate, y: start }, to: { x: m.coordinate, y: end } }
          : { axis, from: { x: start, y: m.coordinate }, to: { x: end, y: m.coordinate } },
      );
    }
    return result;
  }
}
