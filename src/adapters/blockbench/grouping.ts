import type { Studio } from '../../application/studio';
import { Disposables, type HostRuntime } from './runtime';

/** Registered Action hooks cover native menus/toolbars as well as keyboard commands. */
export function installGrouping(bb: HostRuntime, current: () => Studio | null) {
  const life = new Disposables();
  for (const id of ['add_group', 'group_elements', 'resolve_group']) {
    const action = bb.BarItems[id];
    if (!action?.on) continue;
    life.add(
      action.on('use', () => {
        const app = current();
        if (!app || !bb.Modes.edit) return;
        if (app.state.busy) return false;
        app.reflectSelection(app.host.selection(app.state.doc));
        if (id === 'resolve_group') app.ungroupSelection();
        else if (id === 'add_group' && app.state.selection.length === 1)
          app.add('frame', app.state.selection[0]);
        else if (app.state.selection.length) app.groupSelection();
        else app.add('frame');
        return false;
      }),
    );
  }
  return () => life.dispose();
}
