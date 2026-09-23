import type { Axis, Id, Rect, ResolvedScene, UiDocument, UiNode } from './types';
import { defaultFrame } from './types';

export type ContentMeasure = (
  node: UiNode,
  width?: number,
) => { width: number; height: number } | undefined;
export function layout(doc: UiDocument, contentMeasure?: ContentMeasure): ResolvedScene {
  const scene: ResolvedScene = { nodes: {}, order: [] };
  const sizes = new Map<string, number>(),
    resolving = new Set<string>();
  const node = (id: Id): UiNode => {
    const n = doc.nodes[id];
    if (!n) throw new Error(`图层不存在: ${id}`);
    return n;
  };
  const flow = (n: UiNode) =>
    n.children.map(node).filter((c) => c.visible && c.layout.positioning === 'flow');
  function limits(n: UiNode, axis: Axis, value: number): number {
    const nine = n.content?.kind === 'nine-slice' ? n.content : null;
    const border = nine
      ? axis === 'width'
        ? nine.insets[1] + nine.insets[3] + 1
        : nine.insets[0] + nine.insets[2] + 1
      : 1;
    const min = Math.max(border, axis === 'width' ? n.layout.minWidth : n.layout.minHeight);
    const max = axis === 'width' ? n.layout.maxWidth : n.layout.maxHeight;
    if (!Number.isFinite(value) || (max !== undefined && max < min))
      throw new Error(`${n.name}: 无效尺寸约束`);
    return Math.max(min, Math.min(value, max ?? Infinity));
  }
  function measure(n: UiNode, axis: Axis): number {
    const key = `${n.id}:${axis}`;
    if (sizes.has(key)) return sizes.get(key)!;
    if (resolving.has(key))
      throw new Error(`${n.name}: 父子尺寸形成循环依赖，请把其中一方改为固定尺寸`);
    resolving.add(key);
    const rule = n.layout[axis];
    let value: number;
    if (n.suspended) value = n.rect[axis];
    else if (rule.kind === 'fixed') value = rule.value;
    else if (rule.kind === 'expression') {
      if (!n.parent) throw new Error(`${n.name}: 根节点没有百分比参照父级`);
      value = measure(node(n.parent), axis) * rule.percent + rule.pixels;
    } else if (rule.kind === 'hug') {
      if (n.kind === 'image') {
        const generated = n.content?.kind === 'generated' ? n.content : undefined;
        const measured =
          generated && contentMeasure?.(n, axis === 'height' ? measure(n, 'width') : undefined);
        const a = n.content && doc.assets[n.content.source];
        value = measured
          ? measured[axis]
          : generated
            ? generated.logicalSize[axis]
            : a
              ? a[axis]
              : n.rect[axis];
      } else {
        const f = n.frame ?? defaultFrame(),
          children = flow(n);
        if (
          f.direction === 'free' &&
          children.some((c) =>
            axis === 'width' ? c.layout.offsetPercent?.x : c.layout.offsetPercent?.y,
          )
        )
          throw new Error(`${n.name}: Hug 与子项百分比坐标形成循环依赖`);
        const linear =
          (axis === 'width' && f.direction === 'row') ||
          (axis === 'height' && f.direction === 'column');
        const pad = axis === 'width' ? f.padding[1] + f.padding[3] : f.padding[0] + f.padding[2];
        value =
          pad +
          (linear
            ? children.reduce((sum, c) => sum + measure(c, axis), 0) +
              Math.max(0, children.length - 1) * f.gap
            : Math.max(
                0,
                ...children.map(
                  (c) =>
                    measure(c, axis) +
                    (f.direction === 'free'
                      ? axis === 'width'
                        ? c.layout.offset.x
                        : c.layout.offset.y
                      : 0),
                ),
              ));
      }
    } else {
      if (!n.parent) value = n.rect[axis];
      else {
        const parent = node(n.parent),
          f = parent.frame ?? defaultFrame();
        const available =
          measure(parent, axis) -
          (axis === 'width' ? f.padding[1] + f.padding[3] : f.padding[0] + f.padding[2]);
        const linear =
          n.layout.positioning === 'flow' &&
          ((axis === 'width' && f.direction === 'row') ||
            (axis === 'height' && f.direction === 'column'));
        if (!linear) value = available;
        else {
          const children = flow(parent),
            fills = children.filter((c) => c.layout[axis].kind === 'fill');
          let remaining = available - Math.max(0, children.length - 1) * f.gap;
          for (const c of children)
            if (c.layout[axis].kind !== 'fill') remaining -= measure(c, axis);
          // Redistribute after min/max constraints, so a clamped Fill does not leave unused space.
          let pending = [...fills];
          const allocations = new Map<Id, number>();
          while (pending.length) {
            const share = remaining / pending.length;
            const clamped = pending.filter((c) => limits(c, axis, share) !== share);
            if (!clamped.length) {
              for (const c of pending) allocations.set(c.id, share);
              break;
            }
            for (const c of clamped) {
              const v = limits(c, axis, share);
              allocations.set(c.id, v);
              remaining -= v;
            }
            pending = pending.filter((c) => !allocations.has(c.id));
          }
          value = allocations.get(n.id) ?? 0;
        }
      }
    }
    value = limits(n, axis, value);
    sizes.set(key, value);
    resolving.delete(key);
    return value;
  }
  const visiting = new Set<Id>(),
    visited = new Set<Id>();
  function place(n: UiNode, rect: Rect, parentVisible: boolean, parentLocked: boolean) {
    if (visiting.has(n.id) || visited.has(n.id)) throw new Error('图层层级存在循环或重复引用');
    visiting.add(n.id);
    // Round shared edges rather than independent widths. Adjacent Fill items cannot acquire gaps.
    const x = Math.round(rect.x),
      y = Math.round(rect.y);
    const actual = {
      x,
      y,
      width: Math.max(1, Math.round(rect.x + rect.width) - x),
      height: Math.max(1, Math.round(rect.y + rect.height) - y),
    };
    scene.nodes[n.id] = {
      id: n.id,
      rect: actual,
      visible: parentVisible && n.visible,
      locked: parentLocked || n.locked,
      depth: scene.order.length,
    };
    scene.order.push(n.id);
    const f = n.frame ?? defaultFrame(),
      children = n.children.map(node);
    const arranged = flow(n),
      horizontal = f.direction === 'row',
      main: Axis = horizontal ? 'width' : 'height';
    const padStart = horizontal ? f.padding[3] : f.padding[0];
    const padEnd = horizontal ? f.padding[1] : f.padding[2];
    const used =
      arranged.reduce((sum, c) => sum + measure(c, main), 0) +
      Math.max(0, arranged.length - 1) * f.gap;
    const extra = Math.max(0, rect[main] - padStart - padEnd - used);
    const gap =
      f.gap +
      (f.justify === 'space-between' && arranged.length > 1 ? extra / (arranged.length - 1) : 0);
    let cursor = padStart + (f.justify === 'center' ? extra / 2 : f.justify === 'end' ? extra : 0);
    for (const c of children) {
      const width = measure(c, 'width'),
        height = measure(c, 'height');
      let cx: number, cy: number;
      if (c.suspended) {
        cx = c.rect.x;
        cy = c.rect.y;
      } else if (f.direction === 'free' || c.layout.positioning === 'absolute' || !c.visible) {
        cx =
          rect.x +
          rect.width * (c.layout.anchorFrom[0] + (c.layout.offsetPercent?.x ?? 0)) -
          width * c.layout.anchorTo[0] +
          c.layout.offset.x;
        cy =
          rect.y +
          rect.height * (c.layout.anchorFrom[1] + (c.layout.offsetPercent?.y ?? 0)) -
          height * c.layout.anchorTo[1] +
          c.layout.offset.y;
      } else {
        const crossAvailable = horizontal
          ? rect.height - f.padding[0] - f.padding[2]
          : rect.width - f.padding[1] - f.padding[3];
        const crossSize = horizontal ? height : width;
        const alignment =
          Math.max(0, crossAvailable - crossSize) *
          (f.align === 'center' ? 0.5 : f.align === 'end' ? 1 : 0);
        cx = rect.x + (horizontal ? cursor : f.padding[3] + alignment);
        cy = rect.y + (horizontal ? f.padding[0] + alignment : cursor);
        cursor += (horizontal ? width : height) + gap;
      }
      place(
        c,
        { x: cx, y: cy, width, height },
        scene.nodes[n.id]!.visible,
        scene.nodes[n.id]!.locked,
      );
    }
    visiting.delete(n.id);
    visited.add(n.id);
  }
  for (const id of doc.roots) {
    const n = node(id);
    if (n.layout.offsetPercent?.x || n.layout.offsetPercent?.y)
      throw new Error(`${n.name}: 根节点没有百分比坐标的参照父级`);
    place(
      n,
      {
        x: n.layout.offset.x,
        y: n.layout.offset.y,
        width: measure(n, 'width'),
        height: measure(n, 'height'),
      },
      true,
      false,
    );
  }
  return scene;
}
