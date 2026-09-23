import { BindingIndex } from './binding-index';
import {
  contentProviders,
  type ContentData,
  type ContentProvider,
} from '../../application/content';
import type { Studio } from '../../application/studio';
import { clone } from '../../domain/document';
import type { HostObject, HostRuntime } from './runtime';
/** Public v1 contract. Never exposes Studio, NativeHost, or native objects. */
export function contentApi(bb: HostRuntime, current: () => Studio | null) {
  const updates = new Map<string, number>();
  const bindings = new BindingIndex();
  let draft: { app: Studio; id: string; data: ContentData } | null = null;
  const cancel = () => {
    if (draft) draft.app.endGesture(false);
    draft = null;
  };
  const inspect = (id?: string) => {
    const app = current();
    id ??= app?.state.selection.length === 1 ? app.state.selection[0] : undefined;
    const n = id && app?.state.doc.nodes[id];
    if (!app || !n || n.content?.kind !== 'generated') return null;
    return {
      id,
      provider: n.content.provider,
      data: clone(n.content.data ?? {}),
      rect: { ...n.rect },
      suspended: n.suspended,
      projectId: app.state.doc.id,
    };
  };
  const api = {
    version: 1,
    active: () => !!current(),
    inspect,
    register(provider: ContentProvider) {
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(provider.id) || contentProviders.has(provider.id))
        throw new Error('Invalid or duplicate content provider');
      contentProviders.set(provider.id, provider);
      void current()
        ?.prepareContents()
        .catch((error) => current()?.report(error));
      return () => {
        cancel();
        if (contentProviders.get(provider.id) === provider) contentProviders.delete(provider.id);
      };
    },
    async create(provider: string, data: ContentData, name?: string) {
      const app = current(),
        p = contentProviders.get(provider);
      if (!app || !p) throw new Error('UI content provider unavailable');
      await p.prepare(data);
      if (current() !== app) throw new Error('项目已切换');
      return app.createContent(provider, data, name);
    },
    owner(uuid: string) {
      const app = current();
      if (!app) return null;
      const id = bindings.get(app.state.doc).get(uuid);
      return id ? inspect(id) : null;
    },
    async update(id: string, data: ContentData) {
      const app = current(),
        item = inspect(id);
      if (!app || !item || item.suspended) throw new Error('文字已暂停或不可编辑');
      const p = contentProviders.get(item.provider);
      if (!p) throw new Error('文字插件未安装');
      const ticket = (updates.get(id) ?? 0) + 1;
      updates.set(id, ticket);
      await p.prepare(data);
      if (updates.get(id) !== ticket) return false;
      if (current() !== app || JSON.stringify(inspect(id)) !== JSON.stringify(item))
        throw new Error('文字在加载字体时已变化');
      return app.execute('编辑文字', (doc) => app.editContentNode(doc.nodes[id]!, data));
    },
    begin(id: string) {
      cancel();
      const app = current(),
        item = inspect(id);
      if (!app || !item || item.suspended) throw new Error('文字已暂停或不可编辑');
      app.beginGesture('编辑文字');
      draft = { app, id, data: item.data };
    },
    preview(id: string, data: ContentData) {
      if (!draft || draft.id !== id || current() !== draft.app) {
        cancel();
        return false;
      }
      return draft.app.previewGesture((doc) => draft!.app.editContentNode(doc.nodes[id]!, data));
    },
    finish(commit: boolean) {
      const d = draft;
      draft = null;
      if (d) d.app.endGesture(commit && current() === d.app);
    },
    rasterize(id: string) {
      current()?.flatten(id);
    },
    regenerate(id: string) {
      current()?.regenerate(id);
    },
  };
  const onSwitch = () => cancel();
  bb.Blockbench.on('save_editor_state', onSwitch);
  bb.Blockbench.on('close_project', onSwitch);
  bb.Blockbench.on('select_mode', onSwitch);
  return {
    api,
    dispose() {
      cancel();
      contentProviders.clear();
      bb.Blockbench.removeListener('save_editor_state', onSwitch);
      bb.Blockbench.removeListener('close_project', onSwitch);
      bb.Blockbench.removeListener('select_mode', onSwitch);
    },
  };
}
