import { descendants, siblings, topSelection } from './document';
import { bounds } from './geometry';
import { retainWorldRect } from './tree-editing';
import { createNode, type Id, type UiDocument } from './types';

function ordered(doc: UiDocument, ids: Id[]) {
  const wanted = new Set(topSelection(doc, ids));
  return doc.roots.flatMap((id) => descendants(doc, id)).filter((id) => wanted.has(id));
}
function editable(doc: UiDocument, ids: Id[]) {
  for (const id of ids) {
    let n = doc.nodes[id];
    while (n) {
      if (n.locked || n.suspended) throw new Error('请先解锁选区并处理暂停的规则');
      n = n.parent ? doc.nodes[n.parent] : undefined;
    }
    if (descendants(doc, id).some((key) => doc.nodes[key]?.suspended))
      throw new Error('选区包含暂停的图层，请先处理原生差异');
  }
}
function chain(doc: UiDocument, id: Id): (Id | null)[] {
  const result: (Id | null)[] = [];
  let parent = doc.nodes[id]!.parent;
  while (parent) {
    result.push(parent);
    parent = doc.nodes[parent]!.parent;
  }
  result.push(null);
  return result;
}

/** Logical grouping never treats an Image's native content Cube as a child layer. */
export function groupNodes(doc: UiDocument, selection: Id[], id: Id): Id {
  const ids = ordered(doc, selection);
  if (!ids.length) throw new Error('请先选择需要编组的图层');
  if (doc.nodes[id]) throw new Error('Frame ID 已存在');
  editable(doc, ids);
  const paths = ids.map((key) => chain(doc, key));
  const parent = paths[0]!.find((key) => paths.every((path) => path.includes(key))) ?? null;
  const nodes = ids.map((key) => doc.nodes[key]!);
  const target = parent ? doc.nodes[parent]! : null;
  const list = target ? target.children : doc.roots;
  const sameParent = nodes.every((n) => n.parent === parent);
  const stack = target?.frame?.engineType === 'stack_panel';
  if (
    nodes.some((n) => n.parent && doc.nodes[n.parent]?.frame?.engineType === 'stack_panel') ||
    stack
  ) {
    const positions = nodes.map((n) => n.layout.positioning);
    const flow = list.filter(
      (key) => doc.nodes[key]!.visible && doc.nodes[key]!.layout.positioning === 'flow',
    );
    const selectedFlow = flow.filter((key) => ids.includes(key));
    const contiguous =
      selectedFlow.length === ids.length &&
      flow.indexOf(selectedFlow.at(-1)!) - flow.indexOf(selectedFlow[0]!) + 1 === ids.length;
    if (
      !sameParent ||
      !(
        positions.every((p) => p === 'absolute') ||
        (positions.every((p) => p === 'flow') && contiguous)
      )
    )
      throw new Error('自动布局中请编组连续的流式子项，或先切换为自由布局');
  }
  const rect = bounds(nodes.map((n) => n.rect))!;
  const frame = createNode(id, 'Frame', 'frame', rect);
  frame.parent = parent;
  frame.layout.positioning = stack ? nodes[0]!.layout.positioning : 'flow';
  const firstBranch = (key: Id) => {
    while (doc.nodes[key]!.parent !== parent) key = doc.nodes[key]!.parent!;
    return key;
  };
  const at = Math.min(...ids.map((key) => list.indexOf(firstBranch(key))));
  list.splice(at, 0, id);
  doc.nodes[id] = frame;
  retainWorldRect(doc, frame, rect);
  for (const n of nodes) {
    const old = siblings(doc, n);
    old.splice(old.indexOf(n.id), 1);
    n.parent = id;
    frame.children.push(n.id);
    retainWorldRect(doc, n, n.rect);
  }
  return id;
}

/** Frames dissolve; Images keep their content and release their logical children. */
export function ungroupNodes(doc: UiDocument, selection: Id[], recursive = false): Id[] {
  const ids = ordered(doc, selection);
  editable(doc, ids);
  for (const id of ids) {
    const n = doc.nodes[id]!;
    if (
      (n.kind === 'frame' || n.children.length) &&
      n.parent &&
      doc.nodes[n.parent]?.frame?.engineType === 'stack_panel'
    )
      throw new Error('请先将父级自动布局切换为自由布局，再解除编组');
  }
  const effective = new Map<Id, { visible: boolean; locked: boolean }>();
  for (const root of ids)
    for (const id of descendants(doc, root)) {
      let n = doc.nodes[id];
      let visible = true,
        locked = false;
      while (n) {
        visible &&= n.visible;
        locked ||= n.locked;
        n = n.parent ? doc.nodes[n.parent] : undefined;
      }
      effective.set(id, { visible, locked });
    }
  const flatten = (id: Id): Id[] => {
    const n = doc.nodes[id]!,
      children = [...n.children];
    n.children = [];
    const promoted = recursive ? children.flatMap(flatten) : children;
    if (n.kind === 'image') return [id, ...promoted];
    delete doc.nodes[id];
    delete doc.bindings[id];
    return promoted;
  };
  const next: Id[] = [];
  for (const id of ids) {
    const n = doc.nodes[id]!,
      parent = n.parent;
    if (n.kind === 'image' && !n.children.length) {
      next.push(id);
      continue;
    }
    const list = siblings(doc, n),
      at = list.indexOf(id);
    const promoted = flatten(id);
    list.splice(at, 1, ...promoted);
    for (const key of promoted) {
      const child = doc.nodes[key]!;
      child.parent = parent;
      Object.assign(child, effective.get(key));
      retainWorldRect(doc, child, child.rect);
    }
    next.push(...promoted);
  }
  return next;
}
