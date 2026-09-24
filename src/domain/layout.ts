import { autoFrames } from './auto-frame';
import { sizeTerms } from './expression';
import { resolveTransforms } from './transform';
import type { Axis, Id, Rect, ResolvedScene, UiDocument, UiNode } from './types';
import { defaultFrame } from './types';

export type ContentMeasure = (
  node: UiNode,
  width?: number,
) => { width: number; height: number } | undefined;
export function layout(doc: UiDocument, contentMeasure?: ContentMeasure): ResolvedScene {
  const scene: ResolvedScene = { nodes: {}, order: [] };
  const rawSizes = new Map<string, number>();
  const sizes = new Map<string, number>(),
    resolving = new Set<string>();
  const node = (id: Id): UiNode => {
    const n = doc.nodes[id];
    if (!n) throw new Error(`图层不存在: ${id}`);
    return n;
  };
  const flows = new Map<Id, UiNode[]>();
  const allocationsByParent = new Map<string, Map<Id, number>>();
  const flow = (n: UiNode) => {
    let result = flows.get(n.id);
    if (!result) {
      result = n.children.map(node).filter((c) => c.visible && c.layout.positioning === 'flow');
      flows.set(n.id, result);
    }
    return result;
  };
  function limits(n: UiNode, axis: Axis, value: number): number {
    const nine = n.content?.kind === 'nine-slice' ? n.content : null;
    const border = nine
      ? axis === 'width'
        ? nine.insets[1] + nine.insets[3] + 1
        : nine.insets[0] + nine.insets[2] + 1
      : 0;
    const explicitMin = axis === 'width' ? n.layout.minWidth : n.layout.minHeight;
    if (Number.isFinite(value) && value <= 0 && explicitMin === 0) return 0;
    const min = Math.max(border, axis === 'width' ? n.layout.minWidth : n.layout.minHeight);
    const max = axis === 'width' ? n.layout.maxWidth : n.layout.maxHeight;
    if (!Number.isFinite(value) || (max !== undefined && max < min))
      throw new Error(`${n.name}: 无效尺寸约束`);
    return Math.max(min, Math.min(value, max ?? Infinity));
  }
  const auto = autoFrames(doc, measure);
  function measure(n: UiNode, axis: Axis): number {
    const key = `${n.id}:${axis}`;
    if (sizes.has(key)) return sizes.get(key)!;
    if (resolving.has(key))
      throw new Error(`${n.name}: 尺寸形成循环依赖（自身、父子或同级），请设置一个确定的尺寸参照`);
    resolving.add(key);
    const rule = n.layout[axis];
    if (rule.kind === 'auto' && n.kind !== 'frame')
      throw new Error(`${n.name}: 自动尺寸仅适用于 Frame`);
    let value: number;
    if (n.suspended || (rule.kind === 'auto' && !auto.active(n))) value = n.rect[axis];
    else if (rule.kind === 'auto' && auto.free(n)) value = auto.extent(n, axis).size;
    else if (rule.kind === 'auto' && !flow(n).length) value = n.rect[axis];
    else if (rule.kind === 'fixed') value = rule.value;
    else if (rule.kind === 'expression' || rule.kind === 'sum' || rule.kind === 'default') {
      const terms =
        rule.kind === 'default' ? [{ unit: '%' as const, percent: 1 }] : sizeTerms(rule);
      value = rule.kind === 'default' ? 0 : rule.pixels;
      for (const term of terms) {
        if (!term.percent) continue;
        let basis: number;
        if (term.unit === '%') {
          if (!n.parent) throw new Error(`${n.name}: 此尺寸需要父级参照，请把画板设为像素尺寸`);
          basis = measure(node(n.parent), axis);
        } else if (term.unit === '%x' || term.unit === '%y')
          basis = measure(n, term.unit === '%x' ? 'width' : 'height');
        else if (term.unit === '%c' || term.unit === '%cm') {
          const children = n.children.map(node).filter((c) => term.unit === '%c' || c.visible);
          const values = children.map((c) => measure(c, axis));
          basis = term.unit === '%c' ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values);
        } else {
          const peers = (n.parent ? node(n.parent).children : doc.roots).filter(
            (id) => id !== n.id,
          );
          basis = Math.max(0, ...peers.map((id) => measure(node(id), axis)));
        }
        value += basis * term.percent;
      }
    } else if (rule.kind === 'hug' || rule.kind === 'auto') {
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
      if (!n.parent) throw new Error(`${n.name}: fill 需要父级剩余空间`);
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
          const allocationKey = `${parent.id}:${axis}`;
          let allocations = allocationsByParent.get(allocationKey);
          if (!allocations) {
            const children = flow(parent),
              fills = children.filter((c) => c.layout[axis].kind === 'fill');
            let remaining = available - Math.max(0, children.length - 1) * f.gap;
            for (const c of children)
              if (c.layout[axis].kind !== 'fill') remaining -= measure(c, axis);
            // Redistribute after min/max constraints, so a clamped Fill does not leave unused space.
            let pending = [...fills];
            allocations = new Map<Id, number>();
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
              pending = pending.filter((c) => !allocations!.has(c.id));
            }
            allocationsByParent.set(allocationKey, allocations);
          }
          value = allocations.get(n.id) ?? 0;
        }
      }
    }
    rawSizes.set(key, value);
    value = limits(n, axis, value);
    sizes.set(key, value);
    resolving.delete(key);
    return value;
  }
  const visiting = new Set<Id>(),
    visited = new Set<Id>();
  function place(
    n: UiNode,
    rect: Rect,
    parentVisible: boolean,
    parentLocked: boolean,
    parentPrecise = false,
  ) {
    if (visiting.has(n.id) || visited.has(n.id)) throw new Error('图层层级存在循环或重复引用');
    visiting.add(n.id);
    const shift = auto.originShift(n),
      min = auto.minimum(n);
    rect = { ...rect, x: rect.x + shift.x, y: rect.y + shift.y };
    // Preserve explicit fractional offsets/rotation; otherwise round shared edges for adjacent Fill items.
    const precise =
      auto.active(n) ||
      n.layout.subpixel === true ||
      parentPrecise ||
      !!n.rotation ||
      !Number.isInteger(n.layout.offset.x) ||
      !Number.isInteger(n.layout.offset.y);
    const parent = n.parent ? doc.nodes[n.parent] : undefined;
    const flowChild =
      parent?.frame?.engineType === 'stack_panel' && n.layout.positioning === 'flow' && n.visible;
    const origin = n.parent ? scene.nodes[n.parent]!.rect : { x: 0, y: 0 };
    // Flow edges share the parent's fractional origin, preserving Fill adjacency after a half-pixel move.
    const x = flowChild
        ? origin.x + Math.round(rect.x - origin.x)
        : precise
          ? rect.x
          : Math.round(rect.x),
      y = flowChild
        ? origin.y + Math.round(rect.y - origin.y)
        : precise
          ? rect.y
          : Math.round(rect.y);
    const actual = {
      x,
      y,
      width: Math.max(
        0,
        n.layout.width.kind === 'auto'
          ? rect.width
          : flowChild
            ? Math.round(rect.x - origin.x + rect.width) - Math.round(rect.x - origin.x)
            : precise
              ? n.kind === 'frame'
                ? rect.width
                : Math.round(rect.width)
              : Math.round(rect.x + rect.width) - x,
      ),
      height: Math.max(
        0,
        n.layout.height.kind === 'auto'
          ? rect.height
          : flowChild
            ? Math.round(rect.y - origin.y + rect.height) - Math.round(rect.y - origin.y)
            : precise
              ? n.kind === 'frame'
                ? rect.height
                : Math.round(rect.height)
              : Math.round(rect.y + rect.height) - y,
      ),
    };
    scene.nodes[n.id] = {
      id: n.id,
      requested: {
        width: rawSizes.get(`${n.id}:width`) ?? rect.width,
        height: rawSizes.get(`${n.id}:height`) ?? rect.height,
      },
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
          rect.x -
          min.x +
          (auto.free(n) ? auto.reference(n, 'width') : rect.width) *
            (c.layout.anchorFrom[0] + (c.layout.offsetPercent?.x ?? 0)) -
          (auto.free(c) ? auto.reference(c, 'width') : width) * c.layout.anchorTo[0] +
          c.layout.offset.x;
        cy =
          rect.y -
          min.y +
          (auto.free(n) ? auto.reference(n, 'height') : rect.height) *
            (c.layout.anchorFrom[1] + (c.layout.offsetPercent?.y ?? 0)) -
          (auto.free(c) ? auto.reference(c, 'height') : height) * c.layout.anchorTo[1] +
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
        precise,
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
  auto.offsets(scene);
  resolveTransforms(doc, scene);
  return scene;
}
