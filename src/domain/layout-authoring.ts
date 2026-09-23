import { layout } from './layout';
import {
  fixed,
  type Axis,
  type FrameSpec,
  type Id,
  type LayoutSpec,
  type SizeRule,
  type UiDocument,
  type UiNode,
} from './types';

export function setPositioning(doc: UiDocument, node: UiNode, mode: LayoutSpec['positioning']) {
  if (mode === 'absolute' && node.layout.positioning !== mode) {
    for (const axis of ['width', 'height'] as const)
      if (node.layout[axis].kind === 'fill') node.layout[axis] = fixed(node.rect[axis]);
    const parent = node.parent ? doc.nodes[node.parent] : undefined;
    if (parent)
      node.layout.offset = {
        x:
          node.rect.x -
          parent.rect.x -
          parent.rect.width * (node.layout.anchorFrom[0] + (node.layout.offsetPercent?.x ?? 0)) +
          node.rect.width * node.layout.anchorTo[0],
        y:
          node.rect.y -
          parent.rect.y -
          parent.rect.height * (node.layout.anchorFrom[1] + (node.layout.offsetPercent?.y ?? 0)) +
          node.rect.height * node.layout.anchorTo[1],
      };
  }
  node.layout.positioning = mode;
}
export function setDirection(doc: UiDocument, node: UiNode, direction: FrameSpec['direction']) {
  const frame = node.frame;
  if (!frame || frame.direction === direction) return;
  if (direction === 'free') {
    for (const id of node.children) {
      const child = doc.nodes[id]!;
      if (child.layout.positioning !== 'flow' || child.suspended) continue;
      for (const axis of ['width', 'height'] as const)
        if (child.layout[axis].kind === 'fill') child.layout[axis] = fixed(child.rect[axis]);
      child.layout.anchorFrom = [0, 0];
      child.layout.anchorTo = [0, 0];
      child.layout.offset = { x: child.rect.x - node.rect.x, y: child.rect.y - node.rect.y };
      delete child.layout.offsetPercent;
    }
    // Leaving auto layout freezes Hug dimensions so the frame and its children do not jump.
    for (const axis of ['width', 'height'] as const)
      if (node.layout[axis].kind === 'hug') node.layout[axis] = fixed(node.rect[axis]);
  } else if (frame.direction !== 'free' && frame.justify !== 'space-between') {
    const previous = frame.justify;
    frame.justify = frame.align;
    frame.align = previous;
  }
  frame.direction = direction;
  frame.engineType = direction === 'free' ? 'panel' : 'stack_panel';
}
export function setSizeMode(node: UiNode, axis: Axis, mode: SizeRule['kind']) {
  if (node.layout[axis].kind === mode) return;
  if (mode === 'fixed') node.layout[axis] = fixed(node.rect[axis]);
  else if (mode === 'expression') node.layout[axis] = { kind: 'expression', percent: 1, pixels: 0 };
  else node.layout[axis] = { kind: mode };
}
/** Dry-run only layout, without cloning images or baking textures. */
export function sizeModeError(
  doc: UiDocument,
  ids: Id[],
  axis: Axis,
  mode: SizeRule['kind'],
): string | null {
  const candidate = { ...doc, nodes: { ...doc.nodes } };
  try {
    for (const id of ids) {
      const n = doc.nodes[id]!;
      if (!n.parent && (mode === 'fill' || mode === 'expression'))
        throw new Error('根节点没有父级；请选择固定或包裹');
      const copy = (candidate.nodes[id] = { ...n, layout: { ...n.layout } });
      setSizeMode(copy, axis, mode);
    }
    layout(candidate);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
