import type { UiDocument } from '../../domain/types';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

/** Presentation only: actual saved hierarchy stays ordinary Group + Cube. */
export class OutlinerView {
  private life = new Disposables();
  private surfaces = new Set<string>();
  private icons = new Map<
    HostObject,
    { icon?: string; title?: string; ownIcon: boolean; ownTitle: boolean }
  >();
  private key = '';
  raw = false;
  constructor(private bb: HostRuntime) {
    const rule = {
      id: 'mcui_content_surfaces',
      test: (node: HostObject) => this.raw || !this.surfaces.has(node.uuid),
    };
    bb.Outliner.node_display_rules.push(rule);
    this.life.add(() => {
      const i = bb.Outliner.node_display_rules.indexOf(rule);
      if (i >= 0) bb.Outliner.node_display_rules.splice(i, 1);
      bb.Outliner.updateNodeDisplayRules();
    });
  }
  update(doc: UiDocument | null) {
    const key = doc
      ? JSON.stringify([
          this.raw,
          Object.entries(doc.bindings).map(([id, b]) => [
            id,
            b.containerId,
            b.surfaceId,
            doc.nodes[id]?.kind,
            doc.nodes[id]?.content?.kind,
            doc.nodes[id]?.frame?.direction,
          ]),
        ])
      : '';
    if (key === this.key) return;
    this.restore();
    this.key = key;
    if (doc)
      for (const [id, b] of Object.entries(doc.bindings)) {
        const n = doc.nodes[id],
          group = this.bb.OutlinerNode.uuids[b.containerId];
        if (!n || !group) continue;
        if (b.surfaceId && b.surfaceId !== b.containerId) this.surfaces.add(b.surfaceId);
        if (this.raw) {
          if (n.kind === 'image') group.isOpen = true;
          continue;
        }
        this.icons.set(group, {
          icon: group.icon,
          title: group.title,
          ownIcon: Object.hasOwn(group, 'icon'),
          ownTitle: Object.hasOwn(group, 'title'),
        });
        this.bb.Vue.set(
          group,
          'icon',
          n.kind === 'image'
            ? n.content?.kind === 'generated'
              ? 'text_fields'
              : 'image'
            : n.frame?.engineType === 'stack_panel'
              ? 'view_week'
              : 'crop_free',
        );
        this.bb.Vue.set(
          group,
          'title',
          n.kind === 'image'
            ? n.content?.kind === 'generated'
              ? '文字'
              : 'Image'
            : `Frame · ${n.frame?.engineType}`,
        );
      }
    this.bb.Outliner.updateNodeDisplayRules();
  }
  private restore() {
    this.surfaces.clear();
    for (const [node, old] of this.icons) {
      if (old.ownIcon) this.bb.Vue.set(node, 'icon', old.icon);
      else this.bb.Vue.delete(node, 'icon');
      if (old.ownTitle) this.bb.Vue.set(node, 'title', old.title);
      else this.bb.Vue.delete(node, 'title');
    }
    this.icons.clear();
  }
  dispose() {
    this.restore();
    this.life.dispose();
  }
}
