import type { Studio } from '../../application/studio';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

/** A scoped presentation of the native toolbar; never rewrites Toolbar.children or saves layout. */
export class OutlinerToolbar {
  private life = new Disposables();
  private active = false;
  private previousMenu?: HostObject;
  private hadOwnMenu = false;
  private menu?: HostObject;
  constructor(
    private bb: HostRuntime,
    private current: () => Studio | null,
  ) {
    const style = document.createElement('style');
    style.textContent = `
      .toolbar.mcui-outliner-2d > .content [toolbar_item=add_element],
      .toolbar.mcui-outliner-2d > .content [toolbar_item=add_group],
      .toolbar.mcui-outliner-2d > .content [toolbar_item=outliner_toggle],
      .toolbar.mcui-outliner-2d > .content [toolbar_item=mcui_show_native]{display:none!important}
      .toolbar.mcui-outliner-2d > .content [toolbar_item=mcui_add_frame]{order:-20}
      .toolbar.mcui-outliner-2d > .content [toolbar_item=mcui_add_layer]{order:-19}
    `;
    document.head.append(style);
    this.life.add(() => style.remove());
    // Also covers project changes and native camera/mode changes, without replacing their handlers.
    this.life.add(bb.Blockbench.on('render_frame', () => this.update()));
    this.life.add(bb.Blockbench.on('select_mode', () => this.update()));
    this.update();
  }
  private update() {
    const app = this.current();
    const active =
      !!app &&
      !!this.bb.Modes.edit &&
      app.state.view === '2d' &&
      !!this.bb.Preview.selected?.isOrtho &&
      this.bb.Preview.selected?.angle === 'top';
    if (active === this.active) return;
    this.active = active;
    const toolbar = this.bb.Toolbars.outliner;
    toolbar.node.classList.toggle('mcui-outliner-2d', active);
    if (!active) {
      this.restoreMenu();
      return;
    }
    this.previousMenu = toolbar.menu;
    this.hadOwnMenu = Object.hasOwn(toolbar, 'menu');
    this.menu = new this.bb.Menu(
      'mcui_outliner_tools',
      (context: HostObject) => {
        const original = this.previousMenu?.structure;
        const add = this.bb.BarItems.add_element;
        return [
          'mcui_show_native',
          '_',
          {
            id: 'mcui_native_elements',
            name: add.name,
            icon: add.icon,
            condition: add.condition,
            children: () => {
              const source = add.side_menu.structure;
              const entries = typeof source === 'function' ? source(context) : source;
              // Action.menu_node is unique. Do not render the same action twice in one menu tree.
              const ui = [
                'mcui_add_frame',
                'mcui_add_layer',
                'mcui_wrap_layout',
                'mcui_import_image',
                'mcui_show_native',
              ];
              return entries.filter(
                (entry: HostObject) => !ui.includes(typeof entry === 'string' ? entry : entry.id),
              );
            },
          },
          'add_group',
          'outliner_toggle',
          '_',
          ...(typeof original === 'function' ? original(context) : (original ?? [])),
        ];
      },
      { class: 'mcui-outliner-menu' },
    );
    // Instance override only: all other toolbars retain the original native menu.
    toolbar.menu = this.menu;
  }
  private restoreMenu() {
    if (!this.menu) return;
    if (this.bb.open_menu === this.menu) this.menu.hide();
    const toolbar = this.bb.Toolbars.outliner;
    if (toolbar.menu === this.menu) {
      if (this.hadOwnMenu) toolbar.menu = this.previousMenu;
      else delete toolbar.menu;
    }
    this.menu.delete();
    this.menu = undefined;
    this.previousMenu = undefined;
  }
  dispose() {
    this.life.dispose();
    this.bb.Toolbars.outliner.node.classList.remove('mcui-outliner-2d');
    this.restoreMenu();
  }
}
