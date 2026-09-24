import type { Axis, Id, Point, ResolvedScene, UiDocument, UiNode } from './types';

/** Auto is a group boundary, not Hug's origin-relative content extent. No document mutation here. */
export function autoFrames(doc: UiDocument, measure: (n: UiNode, axis: Axis) => number) {
  const protectedNodes = new Map<Id, boolean>();
  const protectedTree = (n: UiNode): boolean => {
    if (protectedNodes.has(n.id)) return protectedNodes.get(n.id)!;
    const value = !!n.suspended || n.children.some((id) => protectedTree(doc.nodes[id]!));
    protectedNodes.set(n.id, value);
    return value;
  };
  const hasAuto = (n: UiNode) => n.layout.width.kind === 'auto' || n.layout.height.kind === 'auto';
  const active = (n: UiNode) => n.kind === 'frame' && hasAuto(n) && !protectedTree(n);
  const free = (n: UiNode) => active(n) && n.frame?.direction === 'free';
  const reference = (n: UiNode, axis: Axis): number =>
    n.layout[axis].kind === 'auto' ? n.rect[axis] : measure(n, axis);
  const size = (n: UiNode, axis: Axis) =>
    n.kind === 'frame' ? measure(n, axis) : Math.round(measure(n, axis));
  const cache = new Map<string, { min: number; size: number }>();
  const resolving = new Set<string>();
  const coordinate = (axis: Axis) => (axis === 'width' ? 'x' : 'y');
  const otherAxis = (axis: Axis): Axis => (axis === 'width' ? 'height' : 'width');
  const trig = (n: UiNode) => {
    const angle = ((n.rotation ?? 0) * Math.PI) / 180;
    const sine = Math.sin(angle),
      cosine = Math.cos(angle);
    return {
      sine: Math.abs(sine) < 1e-12 ? 0 : sine,
      cosine: Math.abs(cosine) < 1e-12 ? 0 : cosine,
    };
  };
  // Measure each axis independently. A square whose H references Auto W is not a cycle
  // unless a child's geometry actually makes W depend on H (for example rotation).
  function extent(n: UiNode, axis: Axis): { min: number; size: number } {
    const key = `${n.id}:${axis}`,
      saved = cache.get(key);
    if (saved) return saved;
    if (resolving.has(key)) throw new Error(`${n.name}: 自动尺寸与子项形成循环依赖`);
    resolving.add(key);
    const children = n.children.map((id) => doc.nodes[id]!).filter((c) => c.visible);
    let result = { min: 0, size: n.rect[axis] };
    if (children.length) {
      const index = axis === 'width' ? 0 : 1,
        coord = coordinate(axis);
      let low = Infinity,
        high = -Infinity;
      for (const c of children) {
        const length = size(c, axis),
          { sine, cosine } = trig(c);
        const ratio = c.layout.anchorFrom[index] + (c.layout.offsetPercent?.[coord] ?? 0);
        const start =
          (ratio ? reference(n, axis) * ratio : 0) -
          (free(c) ? reference(c, axis) : length) * c.layout.anchorTo[index] +
          c.layout.offset[coord] +
          shiftAxis(c, axis);
        const radius =
          (Math.abs(cosine) * length + (sine ? Math.abs(sine) * size(c, otherAxis(axis)) : 0)) / 2;
        low = Math.min(low, start + length / 2 - radius);
        high = Math.max(high, start + length / 2 + radius);
      }
      const p = n.frame!.padding,
        before = axis === 'width' ? p[3] : p[0],
        after = axis === 'width' ? p[1] : p[2];
      result = { min: low - before, size: high - low + before + after };
    }
    cache.set(key, result);
    resolving.delete(key);
    return result;
  }
  const minAxis = (n: UiNode, axis: Axis) =>
    free(n) && n.layout[axis].kind === 'auto' ? extent(n, axis).min : 0;
  const minimum = (n: UiNode): Point => ({ x: minAxis(n, 'width'), y: minAxis(n, 'height') });
  function shiftAxis(n: UiNode, axis: Axis): number {
    if (!free(n)) return 0;
    const parent = n.parent ? doc.nodes[n.parent] : undefined;
    if (parent?.frame?.engineType === 'stack_panel' && n.layout.positioning === 'flow' && n.visible)
      return 0;
    const { sine, cosine } = trig(n),
      min = minAxis(n, axis);
    if (cosine === 1 && !sine) return min;
    const before = reference(n, axis) / 2,
      length = size(n, axis);
    const delta = min + length / 2 - before;
    const other = otherAxis(axis);
    const cross = sine ? minAxis(n, other) + size(n, other) / 2 - reference(n, other) / 2 : 0;
    return before + cosine * delta + (axis === 'width' ? sine : -sine) * cross - length / 2;
  }
  const originShift = (n: UiNode): Point => ({
    x: shiftAxis(n, 'width'),
    y: shiftAxis(n, 'height'),
  });
  function offsets(scene: ResolvedScene) {
    for (const id of scene.order) {
      const n = doc.nodes[id]!,
        parent = n.parent ? doc.nodes[n.parent] : undefined;
      if (n.suspended || (!free(n) && !(parent && free(parent)))) continue;
      if (
        parent?.frame?.engineType === 'stack_panel' &&
        n.layout.positioning === 'flow' &&
        n.visible
      )
        continue;
      const r = scene.nodes[id]!.rect,
        p = parent ? scene.nodes[parent.id]!.rect : { x: 0, y: 0, width: 0, height: 0 };
      const offset = {
        x:
          r.x -
          p.x -
          p.width * (n.layout.anchorFrom[0] + (n.layout.offsetPercent?.x ?? 0)) +
          r.width * n.layout.anchorTo[0],
        y:
          r.y -
          p.y -
          p.height * (n.layout.anchorFrom[1] + (n.layout.offsetPercent?.y ?? 0)) +
          r.height * n.layout.anchorTo[1],
      };
      if (
        Math.abs(offset.x - n.layout.offset.x) > 1e-8 ||
        Math.abs(offset.y - n.layout.offset.y) > 1e-8
      )
        (scene.offsets ??= {})[id] = offset;
    }
  }
  return { active, free, extent, reference, minimum, originShift, offsets };
}

/** Persist derived geometry and rebasing together; callers own the document transaction. */
export function applyResolvedLayout(doc: UiDocument, scene: ResolvedScene) {
  for (const id of scene.order) {
    const n = doc.nodes[id]!;
    n.rect = { ...scene.nodes[id]!.rect };
    if (scene.offsets?.[id]) n.layout.offset = { ...scene.offsets[id]! };
  }
}
