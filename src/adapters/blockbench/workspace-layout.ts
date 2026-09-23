import type { Studio } from '../../application/studio';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

interface SavedPanel {
  panel: HostObject;
  data: HostObject;
  before: HostObject;
  previousSlot: unknown;
  changed: string[];
  slotChanged: boolean;
}

/** Native docking only, applied on workspace transitions, never on individual selections. */
export class WorkspaceLayout {
  private life = new Disposables();
  private saved: SavedPanel[] = [];
  private owner: Studio | null = null;
  private updating = false;
  private disposed = false;
  private sidebars?: { left: boolean; right: boolean };
  private inspectors = new Map<HTMLElement, { height: string; priority: string; role: string }>();
  constructor(
    private bb: HostRuntime,
    private current: () => Studio | null,
  ) {
    const style = document.createElement('style');
    style.textContent = `
      #right_bar > .mcui-fill-inspector:not(.folded){flex:1 1 0;min-height:90px;height:auto!important;overflow:hidden}
      #right_bar > .mcui-fill-inspector > .panel{flex:1 1 0;min-height:0;height:0;overflow-y:auto;overflow-x:hidden}
      #right_bar > .mcui-fill-inspector > .panel > .form{flex-shrink:0}
      #right_bar > .mcui-compact-inspector:not(.folded){flex:0 1 auto;min-height:0;max-height:30%;height:auto!important;overflow:hidden}
      #right_bar > .mcui-compact-inspector > .panel{flex:1 1 auto;min-height:0;height:auto;overflow-y:auto;overflow-x:hidden}
      #right_bar > .mcui-compact-inspector > .panel > .form{flex-shrink:0}
    `;
    document.head.append(style);
    this.life.add(() => style.remove());
    this.life.add(bb.Blockbench.on('render_frame', () => this.update()));
    this.life.add(bb.Blockbench.on('select_mode', () => this.update()));
    // Restore edit-mode data while that mode still owns position_data.
    this.life.add(bb.Blockbench.on('unselect_mode', () => this.restore()));
    this.life.add(bb.Blockbench.on('unselect_project', () => this.restore()));
    this.life.listen(window, 'beforeunload', () => this.restore());
    this.update();
  }
  update() {
    if (this.disposed || this.updating) return;
    const app = this.current();
    const wanted =
      !this.bb.Blockbench.isMobile && this.bb.Modes.edit && app?.state.interaction === 'figma'
        ? app
        : null;
    if (wanted === this.owner) {
      if (wanted && this.syncInspectorSizing()) this.bb.updateInterfacePanels();
      return;
    }
    this.restore();
    if (!wanted) return;
    this.updating = true;
    try {
      const panels = this.bb.Interface.Panels;
      // moveTo may also adjust the previous sidebar's flexible panel. Preserve those native values.
      this.saved = Object.values(panels).map((panel: HostObject) => ({
        panel,
        data: panel.position_data,
        before: structuredClone(panel.position_data),
        previousSlot: panel.previous_slot,
        changed: [],
        slotChanged: false,
      }));
      this.owner = wanted;
      this.sidebars = { left: this.bb.Prop.show_left_bar, right: this.bb.Prop.show_right_bar };
      this.bb.Prop.show_left_bar = this.bb.Prop.show_right_bar = true;
      const outliner = panels.outliner;
      const propertyHost = panels.element.getContainerPanel();
      const leftIndex = Math.min(
        0,
        ...this.bb.Interface.getLeftPanels().map((p: HostObject) => p.position_data.sidebar_index),
      );
      outliner.moveTo('left_bar');
      outliner.customizePosition({ sidebar_index: leftIndex - 1, fixed_height: false });
      outliner.fold(false);
      if (propertyHost !== outliner) propertyHost.moveTo('right_bar');
      for (const id of ['uv', 'textures']) {
        const host = panels[id]?.getContainerPanel();
        if (host && host !== outliner && host !== propertyHost) host.fold(true);
      }
      this.syncInspectorSizing();
      this.bb.updateInterfacePanels();
      for (const entry of this.saved) {
        entry.changed = [
          ...new Set([...Object.keys(entry.before), ...Object.keys(entry.data)]),
        ].filter(
          (key) =>
            key !== 'open_tab' &&
            JSON.stringify(entry.before[key]) !== JSON.stringify(entry.data[key]),
        );
        entry.slotChanged = entry.previousSlot !== entry.panel.previous_slot;
      }
    } finally {
      this.updating = false;
    }
  }
  private restoreInspector(container: HTMLElement) {
    const saved = this.inspectors.get(container);
    if (!saved) return;
    container.classList.remove('mcui-fill-inspector', 'mcui-compact-inspector');
    if (saved.height)
      container.style.setProperty('--main-panel-height', saved.height, saved.priority);
    else container.style.removeProperty('--main-panel-height');
    this.inspectors.delete(container);
  }
  /** Follow actual docking, including saved standalone panels and live native tab dragging. */
  private syncInspectorSizing(): boolean {
    const panels = this.bb.Interface.Panels;
    const base = panels.element.getContainerPanel();
    const docked = (panel: HostObject) => panel?.slot === 'right_bar' && !panel.attached_to;
    const hosts = new Set<HostObject>();
    for (const id of ['mcui_layout', 'mcui_content']) {
      const panel = panels[id];
      if (!panel || !this.bb.BARS.condition(panel.condition)) continue;
      const host = panel.getContainerPanel();
      if (docked(host)) hosts.add(host);
    }
    const hasSeparateUi = [...hosts].some((host) => host !== base);
    const nativeTab = [panels.element, panels.transform].includes(base.open_attached_panel);
    if (hasSeparateUi && nativeTab) hosts.delete(base);
    if (!hosts.size && docked(base)) hosts.add(base);
    const desired = new Map<HTMLElement, string>();
    for (const host of hosts) desired.set(host.container, 'mcui-fill-inspector');
    if (hosts.size && !hosts.has(base) && docked(base))
      desired.set(base.container, 'mcui-compact-inspector');
    let changed = false;
    for (const container of this.inspectors.keys()) {
      if (!desired.has(container)) {
        this.restoreInspector(container);
        changed = true;
      }
    }
    for (const [container, role] of desired) {
      let saved = this.inspectors.get(container);
      if (saved?.role === role) continue;
      if (!saved) {
        saved = {
          height: container.style.getPropertyValue('--main-panel-height'),
          priority: container.style.getPropertyPriority('--main-panel-height'),
          role,
        };
        this.inspectors.set(container, saved);
      }
      saved.role = role;
      container.classList.remove('mcui-fill-inspector', 'mcui-compact-inspector');
      container.classList.add(role);
      changed = true;
    }
    return changed;
  }
  private restore() {
    if (!this.owner || this.updating) return;
    this.updating = true;
    this.owner = null;
    try {
      for (const container of this.inspectors.keys()) this.restoreInspector(container);
      const panels = this.bb.Interface.Panels;
      const currentMode = this.bb.Interface.getUIMode();
      for (const { panel, data, before, previousSlot, changed, slotChanged } of this.saved) {
        if (panels[panel.id] !== panel) continue;
        for (const key of changed) {
          if (Object.hasOwn(before, key)) data[key] = structuredClone(before[key]);
          else delete data[key];
        }
        if (slotChanged) panel.previous_slot = previousSlot;
      }
      // updateSlot restores native containers, floating state, fold icons and attached tabs.
      for (const { panel, changed, slotChanged } of this.saved) {
        if (panels[panel.id] !== panel || (!changed.length && !slotChanged)) continue;
        if (changed.includes('folded')) panel.fold(panel.folded);
        panel.updateSlot();
      }
      if (this.sidebars) {
        this.bb.Prop.show_left_bar = this.sidebars.left;
        this.bb.Prop.show_right_bar = this.sidebars.right;
        this.sidebars = undefined;
      }
      this.saved = [];
      if (currentMode) this.bb.updateInterfacePanels();
    } finally {
      this.updating = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.life.dispose();
    this.restore();
  }
}
