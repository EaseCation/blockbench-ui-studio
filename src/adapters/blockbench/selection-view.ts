import type { Studio } from '../../application/studio';
import { BindingIndex } from './binding-index';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

/** Keep native recursive selection for host commands, present only explicit UI layers. */
export class SelectionView {
  private life = new Disposables();
  private index = new BindingIndex();
  private enabled = false;
  private outlines = new Set<HostObject>();
  private key = '';
  private bindings: unknown;
  constructor(
    private bb: HostRuntime,
    private studio: Studio,
  ) {
    this.life.add(
      bb.Cube.preview_controller.on('update_selection', ({ element }: HostObject) => {
        if (this.enabled) this.hideOutline(element);
      }),
    );
    this.life.add(
      bb.Blockbench.on('get_outliner_node_classes', ({ node, classes }: HostObject) => {
        if (!this.enabled) return;
        const doc = this.studio.state.doc,
          id = this.index.get(doc).get(node.uuid);
        if (!id) return;
        const selected =
          doc.bindings[id]?.containerId === node.uuid && this.studio.state.selection.includes(id);
        const at = classes.indexOf('selected');
        if (!selected && at >= 0) classes.splice(at, 1);
        if (selected && at < 0) classes.push('selected');
      }),
    );
  }
  private hideOutline(element: HostObject) {
    const doc = this.studio.state.doc,
      id = this.index.get(doc).get(element.uuid);
    if (!id || doc.bindings[id]?.surfaceId !== element.uuid || !element.mesh?.outline) return;
    this.outlines.add(element);
    element.mesh.outline.visible = false;
  }
  update(enabled: boolean) {
    const changed = enabled !== this.enabled;
    this.enabled = enabled;
    if (changed && !enabled) this.restore();
    const { doc, selection } = this.studio.state;
    const key = JSON.stringify([enabled, doc.id, selection]);
    if (key !== this.key) {
      this.key = key;
      this.bb.Outliner.updateNodeDisplayRules();
    }
    if (enabled && (changed || this.bindings !== doc.bindings)) {
      this.bindings = doc.bindings;
      const elements = new Set<HostObject>(this.bb.Cube.all);
      for (const element of this.outlines)
        if (!elements.has(element)) this.outlines.delete(element);
      for (const element of elements) this.hideOutline(element);
    }
  }
  private restore() {
    for (const element of this.outlines) element.preview_controller.updateSelection(element);
    this.outlines.clear();
  }
  dispose() {
    this.enabled = false;
    this.life.dispose();
    this.restore();
    this.bb.Outliner.updateNodeDisplayRules();
  }
}
