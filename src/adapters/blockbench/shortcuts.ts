import type { LayerOrder } from '../../domain/layer-order';
import type { StudioClipboard } from './clipboard';
import { navigateSelection } from '../../application/selection-navigation';
import type { Studio } from '../../application/studio';
import { addAutoLayout, removeAutoLayout } from '../../application/layout-commands';
import type { ViewportController } from './viewport';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

export function installShortcuts(
  bb: HostRuntime,
  current: () => Studio | null,
  viewport: () => ViewportController | null,
  showLayout: () => void,
  clipboard: StudioClipboard,
) {
  const life = new Disposables();
  const focused = () =>
    document.activeElement instanceof HTMLElement &&
    !!document.activeElement.closest('input,textarea,select,[contenteditable=true]');
  const context = (allowMenu = false) =>
    !!current() &&
    !!viewport()?.shortcutsAvailable(allowMenu) &&
    !focused() &&
    !bb.open_interface &&
    (allowMenu || !bb.open_menu) &&
    (['preview', 'outliner', 'element', 'transform', 'mcui_layout', 'mcui_content'].includes(
      bb.Prop.active_panel,
    ) ||
      String(bb.Prop.active_panel).startsWith('mcui_'));
  const navigate = (direction: 'children' | 'parent') => {
    const app = current()!;
    const next = navigateSelection(app.state.doc, app.state.scene, app.state.selection, direction);
    if (JSON.stringify(next) !== JSON.stringify(app.state.selection)) app.select(next);
  };
  const mac = bb.Blockbench.platform === 'darwin' || navigator.userAgent.includes('Mac OS');
  const layerOrders: Array<{
    id: string;
    name: string;
    icon: string;
    order: LayerOrder;
    key: number;
    edge?: boolean;
  }> = [
    {
      id: 'mcui_layer_up',
      name: 'UI：前移一层',
      icon: 'flip_to_front',
      order: 'forward',
      key: 221,
    },
    {
      id: 'mcui_layer_down',
      name: 'UI：后移一层',
      icon: 'flip_to_back',
      order: 'backward',
      key: 219,
    },
    {
      id: 'mcui_layer_front',
      name: 'UI：置于顶层',
      icon: 'vertical_align_top',
      order: 'front',
      key: 221,
      edge: true,
    },
    {
      id: 'mcui_layer_back',
      name: 'UI：置于底层',
      icon: 'vertical_align_bottom',
      order: 'back',
      key: 219,
      edge: true,
    },
  ];
  const definitions = [
    ...layerOrders.map((d) => ({
      id: d.id,
      name: d.name,
      icon: d.icon,
      key: { key: d.key, ctrl: true, ...(d.edge ? (mac ? { alt: true } : { shift: true }) : {}) },
      run: () => {
        current()?.reorderSelection(d.order);
      },
      available: () =>
        !!current()?.state.selection.length &&
        current()!.state.selection.every(
          (id) =>
            !current()!.state.doc.nodes[id]?.suspended && !current()!.state.scene.nodes[id]?.locked,
        ),
    })),
    {
      id: 'mcui_copy_properties',
      name: 'UI：复制属性',
      icon: 'format_paint',
      key: { key: 'c', ctrl: true, alt: true },
      run: () => clipboard.copyProperties(),
      available: () => clipboard.canCopyProperties(),
    },
    {
      id: 'mcui_paste_properties',
      name: 'UI：粘贴属性',
      icon: 'content_paste',
      key: { key: 'v', ctrl: true, alt: true },
      run: () => {
        void clipboard.pasteProperties();
      },
      available: () => clipboard.canPasteProperties(),
    },
    {
      id: 'mcui_select_children',
      name: 'UI：选择下一级',
      icon: 'subdirectory_arrow_right',
      key: { key: 13 },
      run: () => navigate('children'),
      available: () => !!current()?.state.selection.length,
    },
    {
      id: 'mcui_select_parent',
      name: 'UI：选择上一级',
      icon: 'arrow_upward',
      key: { key: 13, shift: true },
      run: () => navigate('parent'),
      available: () => !!current()?.state.selection.length,
    },
    {
      id: 'mcui_group_selection',
      name: 'UI：将选区组成 Frame',
      icon: 'create_new_folder',
      key: { key: 'g', ctrl: true },
      run: () => current()?.groupSelection(),
      available: () => !!current()?.state.selection.length,
    },
    {
      id: 'mcui_frame_selection',
      name: 'UI：从选区创建 Frame',
      icon: 'crop_free',
      key: { key: 'g', ctrl: true, alt: true },
      run: () => current()?.groupSelection(),
      available: () => !!current()?.state.selection.length,
    },
    {
      id: 'mcui_ungroup',
      name: 'UI：解除编组',
      icon: 'ungroup',
      key: { key: 'g', ctrl: true, shift: true },
      run: () => current()?.ungroupSelection(),
      available: () => !!current()?.state.selection.length,
    },
    {
      id: 'mcui_ungroup_all',
      name: 'UI：解除全部编组',
      icon: 'account_tree',
      key: undefined,
      run: () => current()?.ungroupSelection(true),
      available: () => !!current()?.state.selection.length,
    },
    {
      id: 'mcui_auto_layout',
      name: 'UI：添加自动布局',
      icon: 'view_quilt',
      key: { key: 'a', shift: true },
      run: () => {
        if (addAutoLayout(current()!)) showLayout();
      },
      available: () => !!current()?.state.selection.length,
    },
    {
      id: 'mcui_remove_auto_layout',
      name: 'UI：移除自动布局',
      icon: 'dashboard',
      key: { key: 'a', shift: true, alt: true },
      run: () => {
        if (removeAutoLayout(current()!)) showLayout();
      },
      available: () =>
        current()?.state.selection.some((id) => {
          const n = current()!.state.doc.nodes[id];
          return n?.kind === 'frame' && n.frame?.direction !== 'free';
        }),
    },
    {
      id: 'mcui_fit_all',
      name: 'UI：查看全部',
      icon: 'zoom_out_map',
      key: { key: '1', shift: true },
      run: () => viewport()?.fit(),
      available: () => true,
    },
    {
      id: 'mcui_fit_selection',
      name: 'UI：聚焦选区',
      icon: 'center_focus_strong',
      key: { key: '2', shift: true },
      run: () => viewport()?.fit(true),
      available: () => !!current()?.state.selection.length,
    },
  ];
  const actions: HostObject[] = [];
  for (const d of definitions) {
    const action = new bb.Action(d.id, {
      name: d.name,
      icon: d.icon,
      category: 'edit',
      keybind: d.key ? new bb.Keybind(d.key) : undefined,
      condition: () => context(true) && d.available(),
      click: d.run,
    });
    const order = layerOrders.find((layer) => layer.id === d.id);
    if (order)
      action.addSubKeybind(
        'plain',
        order.edge ? 'Shift+[ / ]' : '[ / ]',
        new bb.Keybind({ key: order.key, shift: !!order.edge }),
        () => action.trigger(),
      );
    actions.push(action);
    life.add(action);
    bb.MenuBar.addAction(action, 'tools');
    life.add(() => bb.MenuBar.removeAction('tools.' + d.id));
    if (
      d.id.startsWith('mcui_layer_') ||
      d.id.includes('properties') ||
      d.id.includes('auto_layout') ||
      d.id.includes('group') ||
      d.id === 'mcui_frame_selection'
    )
      for (const ctor of [bb.Group, bb.Cube]) {
        ctor.prototype.menu.addAction(action);
        life.add(() => ctor.prototype.menu.removeAction(action));
      }
  }
  life.add(
    bb.Blockbench.on('press_key', (data: HostObject) => {
      if (!context() || data.input_in_focus || data.event.isComposing) return;
      for (const action of actions)
        if (
          action.keybind?.isTriggered(data.event) ||
          Object.values(action.sub_keybinds ?? {}).some((sub: any) =>
            sub.keybind?.isTriggered(data.event),
          )
        ) {
          // Even unavailable shortcuts must not fall through to an unrelated native action.
          data.capture();
          if (!data.event.repeat) action.trigger(data.event);
          return;
        }
    }),
  );
  return () => life.dispose();
}
