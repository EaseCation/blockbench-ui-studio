import type { Studio } from '../../application/studio';
import { addAutoLayout, removeAutoLayout } from '../../application/layout-commands';
import type { ViewportController } from './viewport';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

export function installShortcuts(
  bb: HostRuntime,
  current: () => Studio | null,
  viewport: () => ViewportController | null,
  showLayout: () => void,
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
  const definitions = [
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
    actions.push(action);
    life.add(action);
    bb.MenuBar.addAction(action, 'tools');
    life.add(() => bb.MenuBar.removeAction('tools.' + d.id));
    if (d.id.includes('auto_layout') || d.id.includes('group') || d.id === 'mcui_frame_selection')
      for (const ctor of [bb.Group, bb.Cube]) {
        ctor.prototype.menu.addAction(action);
        life.add(() => ctor.prototype.menu.removeAction(action));
      }
  }
  life.add(
    bb.Blockbench.on('press_key', (data: HostObject) => {
      if (!context() || data.input_in_focus || data.event.isComposing) return;
      for (const action of actions)
        if (action.keybind?.isTriggered(data.event)) {
          // Even unavailable shortcuts must not fall through to an unrelated native action.
          data.capture();
          if (!data.event.repeat) action.trigger(data.event);
          return;
        }
    }),
  );
  return () => life.dispose();
}
