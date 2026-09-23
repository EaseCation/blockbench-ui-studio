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
  constructor(
    private bb: HostRuntime,
    private current: () => Studio | null,
  ) {
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
    if (wanted === this.owner) return;
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
  private restore() {
    if (!this.owner || this.updating) return;
    this.updating = true;
    this.owner = null;
    try {
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
