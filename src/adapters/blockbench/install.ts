import { Studio } from '../../application/studio';
import { clone, descendants, topSelection } from '../../domain/document';
import { createNode, fixed } from '../../domain/types';
import type { UiDocument } from '../../domain/types';
import { imagePort, blobImage } from '../../platform/browser/images';
import { mountWorkbench } from '../../presentation/workbench';
import { NativeHost, METADATA_KEY } from './native-host';
import { ViewportController, type ViewMemory } from './viewport';
import { capabilities, Disposables, type HostObject, type HostRuntime } from './runtime';

export function install(bb: HostRuntime) {
  const missing = capabilities(bb);
  if (missing.length) {
    bb.Blockbench.showMessageBox({
      title: 'MC UI Studio',
      message: `当前版本缺少接口：${missing.join(', ')}。原生项目仍可使用。`,
    });
    return () => {};
  }
  const life = new Disposables(),
    apps = new Map<string, { app: Studio; host: NativeHost }>();
  const viewMemory = new Map<string, ViewMemory>();
  let viewport: ViewportController | null = null,
    unmount: (() => void) | null = null,
    current: Studio | null = null,
    token = 0;
  let internalClipboard: UiDocument | null = null,
    lastPaste = 0;
  let sourceBar: HTMLElement | null = null;
  const panel = new bb.Panel('mcui_studio', {
    name: 'MC UI Studio',
    icon: 'dashboard_customize',
    growable: true,
    resizable: true,
    min_height: 200,
    default_position: { slot: 'right_bar', height: 540 },
    condition: () => !!bb.Project?.unhandled_root_fields?.[METADATA_KEY],
  });
  life.add(panel);
  function focused() {
    const e = document.activeElement;
    return e instanceof HTMLElement && !!e.closest('input,textarea,select,[contenteditable=true]');
  }
  function sourceSession(apply: () => Promise<void>, cancel: () => void) {
    sourceBar?.remove();
    sourceBar = document.createElement('div');
    sourceBar.className = 'mcui-source-session';
    Object.assign(sourceBar.style, {
      position: 'fixed',
      top: '80px',
      right: '24px',
      zIndex: '100',
      padding: '8px',
      background: '#252d3f',
      border: '1px solid #57a6ff',
      borderRadius: '6px',
    });
    const title = document.createElement('span');
    title.textContent = '源图编辑 ';
    sourceBar.append(title);
    const done = document.createElement('button');
    done.textContent = '应用到 UI';
    const abort = document.createElement('button');
    abort.textContent = '取消';
    done.onclick = async () => {
      done.disabled = true;
      try {
        await apply();
        sourceBar?.remove();
        sourceBar = null;
      } catch (e) {
        bb.Blockbench.showQuickMessage(String(e));
        done.disabled = false;
      }
    };
    abort.onclick = () => {
      cancel();
      sourceBar?.remove();
      sourceBar = null;
    };
    sourceBar.append(done, abort);
    document.body.append(sourceBar);
  }
  const get = () => (bb.Project ? apps.get(bb.Project.uuid) : undefined);
  async function activate() {
    const generation = ++token,
      project = bb.Project;
    if (current === get()?.app && current) return;
    viewport?.dispose();
    viewport = null;
    unmount?.();
    unmount = null;
    current = null;
    if (!project?.unhandled_root_fields?.[METADATA_KEY]) return;
    try {
      let entry = apps.get(project.uuid);
      if (!entry) {
        const host = new NativeHost(bb, project),
          doc = host.read();
        if (!doc) return;
        const app = new Studio(host, imagePort, doc);
        host.onSourceSession = sourceSession;
        entry = { app, host };
        apps.set(project.uuid, entry);
        await host.prepareSources();
        await Promise.all(
          project.textures.map((t: HostObject) => t.img?.decode?.().catch(() => {})),
        );
        await app.initialize();
      }
      if (generation !== token || bb.Project !== project) return;
      current = entry.app;
      if (!viewMemory.has(project.uuid)) viewMemory.set(project.uuid, { views: {} });
      viewport = new ViewportController(bb, current, viewMemory.get(project.uuid)!);
      const saved = JSON.parse(localStorage.getItem('mcui_preferences') ?? '{}');
      viewport.setInteraction(saved.interaction === 'native' ? 'native' : 'figma');
      viewport.setView(current.state.view);
      const app = current;
      unmount = mountWorkbench(panel.node, app, {
        changeView: (v) => viewport?.setView(v),
        changeInteraction: (v) => {
          viewport?.setInteraction(v);
          localStorage.setItem('mcui_preferences', JSON.stringify({ interaction: v }));
        },
        importImage: () => importImages(),
        pasteNew: () => {
          void paste(true);
        },
      });
      bb.updateInterface();
    } catch (e) {
      bb.Blockbench.showQuickMessage(`MCUI: ${e instanceof Error ? e.message : String(e)}`, 6000);
    }
  }
  async function newProject() {
    if (!bb.newProject(bb.Formats.free)) return;
    const project = bb.Project;
    project.name = 'MC UI';
    const host = new NativeHost(bb, project),
      app = Studio.fresh(host, imagePort);
    host.onSourceSession = sourceSession;
    host.write(app.state.doc);
    apps.set(project.uuid, { app, host });
    const id = imagePort.id();
    app.execute('创建 UI 画板', (doc) => {
      const n = createNode(id, '画板', 'frame', { x: 0, y: 0, width: 320, height: 180 });
      doc.nodes[id] = n;
      doc.roots.push(id);
    });
    await activate();
    app.select([id]);
  }
  function copy() {
    if (!current) return;
    const doc = clone(current.state.doc),
      roots = topSelection(doc, current.state.selection),
      keep = new Set(roots.flatMap((id) => descendants(doc, id)));
    doc.roots = roots;
    for (const id of Object.keys(doc.nodes)) if (!keep.has(id)) delete doc.nodes[id];
    for (const id of roots) doc.nodes[id]!.parent = null;
    doc.bindings = {};
    internalClipboard = doc;
    navigator.clipboard?.writeText(`MCUI:${JSON.stringify(doc)}`).catch(() => {});
  }
  function pasteNodes(source: UiDocument, app: Studio) {
    const newIds = new Map(Object.keys(source.nodes).map((id) => [id, imagePort.id()]));
    const selected =
      app.state.selection.length === 1 ? app.state.doc.nodes[app.state.selection[0]!] : undefined;
    const parent = selected?.kind !== 'layer' ? (selected?.id ?? null) : selected.parent;
    // Decode before an atomic command so textures are never published partially.
    const addedAssets = Object.values(source.assets);
    return Promise.all(addedAssets.map((a) => imagePort.decode(a.png))).then(async () => {
      // Sources are imported through the application's cache, not through host globals.
      await app.importDocument(source, newIds, parent);
    });
  }
  async function paste(forceNew = false, event?: ClipboardEvent) {
    const app = current;
    if (!app) return;
    const now = Date.now();
    if (now - lastPaste < 200) return;
    lastPaste = now;
    try {
      if (event?.clipboardData) {
        const files = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/'));
        if (files.length) {
          for (let i = 0; i < files.length; i++)
            await app.paste(await blobImage(files[i]!), forceNew || files.length > 1);
          return;
        }
        const text = event.clipboardData.getData('text/plain');
        if (text.startsWith('MCUI:')) {
          await pasteNodes(JSON.parse(text.slice(5)), app);
          return;
        }
      }
      const items = await navigator.clipboard.read();
      let text = '';
      const images: Blob[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) images.push(await item.getType(type));
        else if (item.types.includes('text/plain'))
          text = await (await item.getType('text/plain')).text();
      }
      if (images.length) {
        for (const image of images)
          await app.paste(await blobImage(image), forceNew || images.length > 1);
      } else if (text.startsWith('MCUI:')) await pasteNodes(JSON.parse(text.slice(5)), app);
      else app.report('剪贴板不包含图片或 UI 图层，可使用“导入图片”。');
    } catch (e) {
      app.report(`无法读取剪贴板，请导入图片，或使用“粘贴内部 UI 图层”：${String(e)}`);
    }
  }
  function importImages() {
    const app = current;
    if (!app) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.multiple = true;
    input.onchange = async () => {
      try {
        const files = [...(input.files ?? [])];
        for (const file of files) await app.paste(await blobImage(file), files.length > 1);
      } catch (e) {
        app.report(e);
      }
    };
    input.click();
  }
  const actions = [
    new bb.Action('mcui_new_project', {
      name: '新建 MC UI 项目',
      icon: 'dashboard_customize',
      click: () => {
        void newProject();
      },
    }),
    new bb.Action('mcui_import_image', {
      name: 'UI：导入图片',
      icon: 'image',
      condition: () => !!current,
      click: importImages,
    }),
    new bb.Action('mcui_paste_cached', {
      name: '粘贴内部 UI 图层',
      icon: 'content_paste',
      condition: () => !!current && !!internalClipboard,
      click: () => {
        if (current && internalClipboard) void pasteNodes(internalClipboard, current);
      },
    }),
    new bb.Action('mcui_toggle_paint_resize', {
      name: 'UI：切换扩展画布／缩放内容',
      icon: 'aspect_ratio',
      condition: () => !!current && bb.Modes.edit && !focused(),
      keybind: new bb.Keybind({ key: 'k' }),
      click: () =>
        current?.execute('切换贴图缩放策略', (doc) => {
          for (const id of current!.state.selection) {
            const n = doc.nodes[id];
            if (n?.content?.kind === 'paint')
              n.content.mode = n.content.mode === 'extend' ? 'scale' : 'extend';
          }
        }),
    }),
  ];
  for (const action of actions) {
    bb.MenuBar.addAction(action, 'tools');
    life.add(() => {
      bb.MenuBar.removeAction(`tools.${action.id}`);
      action.delete();
    });
  }
  const commandActive = () =>
    !!current &&
    !focused() &&
    bb.Modes.edit &&
    ['preview', 'mcui_studio', 'outliner'].includes(bb.Prop.active_panel);
  life.add(
    bb.SharedActions.add('copy', {
      subject: 'mcui',
      priority: 100,
      condition: () => commandActive() && !!current!.state.selection.length,
      run: copy,
    }),
  );
  life.add(
    bb.SharedActions.add('paste', {
      subject: 'mcui',
      priority: 100,
      condition: commandActive,
      run: () => {
        void paste();
      },
    }),
  );
  life.add(
    bb.SharedActions.add('duplicate', {
      subject: 'mcui',
      priority: 100,
      condition: commandActive,
      run: () => current?.duplicate(),
    }),
  );
  life.add(
    bb.SharedActions.add('delete', {
      subject: 'mcui',
      priority: 100,
      condition: commandActive,
      run: () => current?.deleteSelection(),
    }),
  );
  life.listen(
    document,
    'paste',
    ((e: ClipboardEvent) => {
      if (!commandActive()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void paste(false, e);
    }) as EventListener,
    true,
  );
  life.listen(
    document,
    'dragover',
    ((e: DragEvent) => {
      if (current && e.target instanceof HTMLElement && e.target.closest('.preview'))
        e.preventDefault();
    }) as EventListener,
    true,
  );
  life.listen(
    document,
    'drop',
    ((e: DragEvent) => {
      if (!current || !(e.target instanceof HTMLElement) || !e.target.closest('.preview')) return;
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const app = current;
      void (async () => {
        try {
          for (const file of files) await app.paste(await blobImage(file), true);
        } catch (error) {
          app.report(error);
        }
      })();
    }) as EventListener,
    true,
  );
  life.add(
    bb.Blockbench.on('select_project', () => {
      void activate();
    }),
  );
  life.add(
    bb.Codecs.project.on('parsed', () => {
      void activate();
    }),
  );
  life.add(
    bb.Blockbench.on('close_project', ({ project }: HostObject) => {
      const entry = apps.get(project.uuid);
      entry?.app.dispose();
      apps.delete(project.uuid);
      if (current === entry?.app) {
        viewport?.dispose();
        viewport = null;
        unmount?.();
        unmount = null;
        current = null;
      }
    }),
  );
  life.add(
    bb.Blockbench.on('update_selection', () => {
      const entry = get();
      if (!entry || entry.app.applying) return;
      const selected = new Set(
        [...bb.Outliner.selected, ...bb.Group.multi_selected].map((e: HostObject) => e.uuid),
      );
      entry.app.reflectSelection(
        Object.entries(entry.app.state.doc.bindings)
          .filter(([, b]) => selected.has(b.elementId))
          .map(([id]) => id),
      );
    }),
  );
  life.add(
    bb.Blockbench.on('create_undo_save', ({ save }: HostObject) => {
      const entry = get();
      if (entry) save.mcui_studio = entry.host.metadata();
    }),
  );
  life.add(
    bb.Blockbench.on('load_undo_save', ({ save }: HostObject) => {
      const entry = get();
      if (entry && 'mcui_studio' in save) entry.host.restoreMetadata(save.mcui_studio);
    }),
  );
  for (const event of ['undo', 'redo'])
    life.add(
      bb.Blockbench.on(event, () => {
        const entry = get();
        if (entry && !entry.app.applying) void entry.app.reloadFromHistory();
      }),
    );
  life.add(
    bb.Blockbench.on('init_edit', (event: HostObject) => {
      const entry = get();
      if (entry && !entry.app.applying) entry.host.expandNativeUndo(event);
    }),
  );
  life.add(
    bb.Blockbench.on('finish_edit', (event: HostObject) => {
      const entry = get();
      if (entry && !entry.app.applying) {
        entry.app.reconcile();
        Object.assign(event.aspects, {
          elements: [...bb.Project.elements],
          groups: [...bb.Project.groups],
          textures: [...bb.Project.textures],
          bitmap: true,
          outliner: true,
        });
      }
    }),
  );
  // Small diagnostic surface for contract tests and local integrations; removed on unload.
  bb.Blockbench.mcuiStudio = {
    version: '0.1.0',
    newProject,
    getStudio: () => current,
    getHost: () => get()?.host,
    getViewport: () => viewport,
  };
  life.add(() => delete bb.Blockbench.mcuiStudio);
  void activate();
  return () => {
    ++token;
    viewport?.dispose();
    unmount?.();
    sourceBar?.remove();
    for (const { app } of apps.values()) app.dispose();
    apps.clear();
    life.dispose();
  };
}
