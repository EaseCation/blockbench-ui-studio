import type { Id, UiDocument, UiNode } from './types';
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function descendants(doc: UiDocument, id: Id): Id[] {
  const out: Id[] = [],
    seen = new Set<Id>();
  const visit = (key: Id) => {
    if (seen.has(key)) throw new Error('图层层级循环');
    seen.add(key);
    out.push(key);
    for (const child of doc.nodes[key]?.children ?? []) visit(child);
  };
  visit(id);
  return out;
}
export function topSelection(doc: UiDocument, ids: Id[]): Id[] {
  const selected = new Set(ids);
  return ids.filter((id) => {
    let p = doc.nodes[id]?.parent;
    const seen = new Set<Id>();
    while (p) {
      if (selected.has(p)) return false;
      if (seen.has(p)) return false;
      seen.add(p);
      p = doc.nodes[p]?.parent;
    }
    return !!doc.nodes[id];
  });
}
export function siblings(doc: UiDocument, node: UiNode): Id[] {
  return node.parent ? doc.nodes[node.parent]!.children : doc.roots;
}
export function removeNode(doc: UiDocument, id: Id): void {
  const n = doc.nodes[id];
  if (!n) return;
  const list = siblings(doc, n);
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  for (const key of descendants(doc, id)) {
    delete doc.nodes[key];
    delete doc.bindings[key];
  }
}
export function validateDocument(value: unknown): UiDocument {
  if (!value || typeof value !== 'object') throw new Error('项目数据损坏');
  const d = value as UiDocument;
  if (d.schemaVersion !== 1) throw new Error('此项目使用其他版本的数据格式，原生内容仍可使用');
  if (!d.id || !Array.isArray(d.roots) || !d.nodes || !d.assets || !d.bindings)
    throw new Error('项目数据不完整');
  const seen = new Set<Id>();
  const visit = (id: Id, parent: Id | null) => {
    const n = d.nodes[id];
    if (
      !n ||
      seen.has(id) ||
      n.id !== id ||
      n.parent !== parent ||
      !Array.isArray(n.children) ||
      !n.rect ||
      !n.layout
    )
      throw new Error('图层结构无效');
    seen.add(id);
    if (!Object.values(n.rect).every(Number.isFinite) || n.rect.width <= 0 || n.rect.height <= 0)
      throw new Error('图层尺寸无效');
    if (n.content && !d.assets[n.content.source]) throw new Error(`${n.name}: 缺少源图`);
    for (const c of n.children) visit(c, id);
  };
  for (const id of d.roots) visit(id, null);
  if (seen.size !== Object.keys(d.nodes).length) throw new Error('项目含未归属图层');
  return d;
}
