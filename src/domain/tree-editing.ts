import { sizeTerms } from './expression';
import { layout } from './layout';
import { documentTransforms, worldPose, poseInParent } from './transform';
import { descendants, siblings, topSelection } from './document';
import { fixed, type Id, type Rect, type UiDocument, type UiNode } from './types';

export function retainWorldRect(doc: UiDocument, n: UiNode, rect: Rect, rebaseSize = true) {
  if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y)) n.layout.subpixel = true;
  const p = n.parent ? doc.nodes[n.parent]!.rect : { x: 0, y: 0, width: 0, height: 0 };
  for (const axis of rebaseSize ? (['width', 'height'] as const) : []) {
    const rule = n.layout[axis];
    const parentAuto = n.parent && doc.nodes[n.parent]!.layout[axis].kind === 'auto';
    if (
      parentAuto &&
      (rule.kind === 'fill' ||
        rule.kind === 'default' ||
        sizeTerms(rule).some((t) => t.unit === '%' && t.percent))
    )
      n.layout[axis] = fixed(rect[axis]);
    else if (rule.kind === 'expression' && (!rule.unit || rule.unit === '%'))
      n.layout[axis] = n.parent
        ? { ...rule, pixels: rect[axis] - p[axis] * rule.percent }
        : fixed(rect[axis]);
    else if (rule.kind === 'expression' || rule.kind === 'sum') {
      const other = axis === 'width' ? 'height' : 'width';
      const candidate = {
        ...doc,
        nodes: {
          ...doc.nodes,
          [n.id]: { ...n, layout: { ...n.layout, [other]: fixed(rect[other]) } },
        },
      };
      const requested = layout(candidate).nodes[n.id]!.requested![axis];
      n.layout[axis] = { ...rule, pixels: rule.pixels + rect[axis] - requested };
    } else if (rule.kind !== 'hug' && rule.kind !== 'auto') n.layout[axis] = fixed(rect[axis]);
  }
  if (!n.parent) delete n.layout.offsetPercent;
  n.layout.offset = {
    x:
      rect.x -
      p.x -
      p.width * (n.layout.anchorFrom[0] + (n.layout.offsetPercent?.x ?? 0)) +
      rect.width * n.layout.anchorTo[0],
    y:
      rect.y -
      p.y -
      p.height * (n.layout.anchorFrom[1] + (n.layout.offsetPercent?.y ?? 0)) +
      rect.height * n.layout.anchorTo[1],
  };
  n.rect = { ...rect };
}
export function reparentNodes(
  doc: UiDocument,
  ids: Id[],
  parent: Id | null,
  index?: number,
  rects?: Record<Id, Rect>,
) {
  const roots = topSelection(doc, ids);
  const transforms = documentTransforms(doc);
  const poses = new Map(roots.map((id) => [id, worldPose(doc, id, transforms)]));
  if (parent && !doc.nodes[parent]) throw new Error('目标容器不存在');
  for (const id of roots)
    if (parent && descendants(doc, id).includes(parent)) throw new Error('不能移入自身或后代');
  const target = parent ? doc.nodes[parent]!.children : doc.roots;
  const before = index === undefined ? null : target.slice(index).find((id) => !roots.includes(id));
  for (const id of roots) {
    const n = doc.nodes[id]!;
    const list = siblings(doc, n);
    list.splice(list.indexOf(id), 1);
  }
  target.splice(before ? target.indexOf(before) : target.length, 0, ...roots);
  const stack = parent && doc.nodes[parent]?.frame?.engineType === 'stack_panel';
  for (const id of roots) doc.nodes[id]!.parent = parent;
  for (const id of roots) {
    const n = doc.nodes[id]!;
    const pose = poses.get(id)!;
    const placement = poseInParent(
      doc,
      parent,
      rects?.[id] ?? pose.rect,
      pose.rotation,
      transforms,
    );
    const rect = placement.rect;
    if (n.rotation !== undefined || placement.rotation !== 0) n.rotation = placement.rotation;
    n.parent = parent;
    if (stack) n.layout.positioning = 'flow';
    else retainWorldRect(doc, n, rect);
  }
}
