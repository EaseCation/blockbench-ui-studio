import type { Studio } from './studio';
import { topSelection } from '../domain/document';
import { setDirection } from '../domain/layout-authoring';
import { fixed } from '../domain/types';

/** Figma semantics: modify a selected Frame in place, otherwise wrap the selected siblings. */
export function addAutoLayout(app: Studio): boolean {
  const ids = topSelection(app.state.doc, app.state.selection);
  const frame = ids.length === 1 ? app.state.doc.nodes[ids[0]!] : undefined;
  if (frame?.kind !== 'frame') return !!app.wrapAutoLayout();
  if (app.state.scene.nodes[frame.id]?.locked || frame.suspended) {
    app.report('请先解锁 Frame 并处理暂停的规则');
    return false;
  }
  if (frame.frame?.direction !== 'free') return true;
  return app.execute('启用自动布局', (doc) => {
    const n = doc.nodes[frame.id]!;
    const children = n.children
      .map((id) => doc.nodes[id]!)
      .filter((c) => c.visible && c.layout.positioning === 'flow');
    if (children.some((c) => c.suspended || app.state.scene.nodes[c.id]?.locked))
      throw new Error('请先解锁子项并处理暂停的规则');
    const spread = (axis: 'x' | 'y') =>
      children.length
        ? Math.max(...children.map((c) => c.rect[axis])) -
          Math.min(...children.map((c) => c.rect[axis]))
        : 0;
    const row = spread('x') >= spread('y');
    const sorted = [...children].sort((a, b) => (row ? a.rect.x - b.rect.x : a.rect.y - b.rect.y));
    const gaps = sorted
      .slice(1)
      .map((c, i) =>
        row
          ? c.rect.x - sorted[i]!.rect.x - sorted[i]!.rect.width
          : c.rect.y - sorted[i]!.rect.y - sorted[i]!.rect.height,
      );
    n.frame!.gap = gaps.length
      ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length))
      : 8;
    const flow = new Set(children.map((c) => c.id));
    let index = 0;
    n.children = n.children.map((id) => (flow.has(id) ? sorted[index++]!.id : id));
    for (const child of children) {
      child.layout.width = fixed(child.rect.width);
      child.layout.height = fixed(child.rect.height);
    }
    setDirection(doc, n, row ? 'row' : 'column');
  });
}

export function removeAutoLayout(app: Studio): boolean {
  const nodes = topSelection(app.state.doc, app.state.selection)
    .map((id) => app.state.doc.nodes[id]!)
    .filter((n) => n.kind === 'frame' && n.frame?.direction !== 'free');
  if (!nodes.length) return false;
  if (
    nodes.some(
      (n) =>
        n.suspended ||
        app.state.scene.nodes[n.id]?.locked ||
        n.children.some(
          (id) => app.state.doc.nodes[id]?.suspended || app.state.scene.nodes[id]?.locked,
        ),
    )
  ) {
    app.report('请先解锁选区与子项并处理暂停的规则');
    return false;
  }
  return app.execute('移除自动布局', (doc) => {
    for (const n of nodes) setDirection(doc, doc.nodes[n.id]!, 'free');
  });
}
