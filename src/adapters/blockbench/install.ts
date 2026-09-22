import { Studio } from '../../application/studio';
import { clone, descendants, topSelection } from '../../domain/document';
import { createNode, fixed } from '../../domain/types';
import type { UiDocument } from '../../domain/types';
import { imagePort, blobImage } from '../../platform/browser/images';
import { PropertyBridge } from './properties';
import { showContentPreview } from './preview-dialog';
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
    current: Studio | null = null,
    token = 0;
  let internalClipboard: UiDocument | null = null,
    lastPaste = 0;
  let sourceEdit: {
    projectId: string;
    apply: () => Promise<void>;
    cancel: () => void;
    busy: boolean;
  } | null = null;
  function focused() {
    const e = document.activeElement;
    return e instanceof HTMLElement && !!e.closest('input,textarea,select,[contenteditable=true]');
  }
  function sourceSession(apply: () => Promise<void>, cancel: () => void) {
    sourceEdit = { projectId: bb.Project.uuid, apply, cancel, busy: false };
    bb.updateInterface();
    bb.BARS.updateConditions();
  }
  const get = () => (bb.Project ? apps.get(bb.Project.uuid) : undefined);
  const properties = new PropertyBridge(bb, () => get()?.app ?? null);
  life.add(() => properties.dispose());
  let interactionSelect: HostObject, viewSelect: HostObject;
  async function activate() {
    const generation = ++token,
      project = bb.Project;
    if (current === get()?.app && current) return;
    viewport?.dispose();
    viewport = null;
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
        host.onBeforeViewUpdate = (doc) => properties.hydrate(doc);
        entry = { app, host };
        apps.set(project.uuid, entry);
        life.add(
          app.subscribe(() => {
            if (host.active()) properties.refresh(false);
          }),
        );
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
      interactionSelect?.set(current.state.interaction);
      viewSelect?.set(current.state.view);
      properties.refresh();
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
    host.onBeforeViewUpdate = (doc) => properties.hydrate(doc);
    host.write(app.state.doc);
    apps.set(project.uuid, { app, host });
    life.add(
      app.subscribe(() => {
        if (host.active()) properties.refresh(false);
      }),
    );
    const id = imagePort.id();
    app.execute('创建 UI 画板', (doc) => {
      const n = createNode(id, '画板', 'frame', { x: 0, y: 0, width: 320, height: 180 });
      doc.nodes[id] = n;
      doc.roots.push(id);
    });
    await activate();
    app.select([id]);
  }
  // The start screen invokes both onStart() and new() on ModelLoader entries.
  // Coalesce those calls without changing the host's loader implementation.
  let creatingProject: Promise<void> | null = null;
  function startProject() {
    if (!creatingProject) {
      creatingProject = newProject()
        .catch((error) => bb.Blockbench.showQuickMessage(`MCUI: ${String(error)}`, 6000))
        .finally(() => {
          creatingProject = null;
        });
    }
    return creatingProject;
  }
  life.add(
    new bb.ModelLoader('mcui_studio', {
      name: 'MC UI',
      icon: 'dashboard_customize',
      category: 'general',
      plugin: 'mcui_studio',
      description: 'Minecraft 像素 UI 工作台：创建 320×180 画板，启用二维顶视图与图层编辑。',
      format_page: { button_text: '创建 MC UI 项目' },
      onStart: () => {
        void startProject();
      },
    }),
  );
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
  const command = (
    id: string,
    name: string,
    icon: string,
    click: () => void,
    condition = () => !!current,
  ) => new bb.Action(id, { name, icon, condition, click });
  const selectedLayer = () =>
    !!current && properties.targets().length === 1 && properties.targets()[0]?.kind === 'layer';
  const parent = () => {
    const n = properties.targets()[0];
    return n?.kind === 'layer' ? n.parent : (n?.id ?? null);
  };
  const withLayer = (fn: (app: Studio, id: string) => void) => {
    const n = properties.targets()[0];
    if (current && n) fn(current, n.id);
  };
  const actions = [
    command('mcui_add_layer', '新增 UI 绘画图层', 'add_photo_alternate', () =>
      current?.add('layer', parent()),
    ),
    command('mcui_add_frame', '新增 UI Frame', 'dashboard_customize', () =>
      current?.add('frame', parent()),
    ),
    command('mcui_add_group', '新增 UI 组', 'create_new_folder', () =>
      current?.add('group', parent()),
    ),
    command(
      'mcui_edit_source',
      'UI：绘制／编辑源图',
      'brush',
      () => withLayer((app, id) => app.paint(id)),
      selectedLayer,
    ),
    command(
      'mcui_nine_slice',
      'UI：设为九宫格',
      'grid_on',
      () => withLayer((app, id) => app.makeNine(id)),
      selectedLayer,
    ),
    command(
      'mcui_content_preview',
      'UI：内容预览与参数',
      'crop',
      () =>
        withLayer((app, id) => {
          void showContentPreview(bb, app, id);
        }),
      selectedLayer,
    ),
    command(
      'mcui_flatten',
      'UI：一键栅格化为绘画图层',
      'image',
      () => withLayer((app, id) => app.flatten(id)),
      selectedLayer,
    ),
    command(
      'mcui_restore_source',
      'UI：恢复原始来源',
      'restore',
      () => withLayer((app, id) => app.restoreSource(id)),
      () => selectedLayer() && !!properties.targets()[0]?.originalContent,
    ),
    command(
      'mcui_adopt',
      'UI：采用当前结果',
      'check',
      () => withLayer((app, id) => app.adopt(id)),
      () => !!current && properties.targets().length === 1 && !!properties.targets()[0]?.suspended,
    ),
    command(
      'mcui_regenerate',
      'UI：按规则重新生成',
      'refresh',
      () => withLayer((app, id) => app.regenerate(id)),
      () => !!current && properties.targets().length === 1 && !!properties.targets()[0]?.suspended,
    ),
    command('mcui_paste_new', 'UI：粘贴为新图层', 'content_paste', () => {
      void paste(true);
    }),
    command(
      'mcui_layer_up',
      'UI：上移一层',
      'arrow_upward',
      () => withLayer((app, id) => app.reorder(id, 1)),
      () => !!current && properties.targets().length === 1,
    ),
    command(
      'mcui_layer_down',
      'UI：下移一层',
      'arrow_downward',
      () => withLayer((app, id) => app.reorder(id, -1)),
      () => !!current && properties.targets().length === 1,
    ),
    command(
      'mcui_source_apply',
      '应用源图到 UI',
      'check',
      () => {
        const session = sourceEdit;
        if (!session || session.busy) return;
        session.busy = true;
        bb.BARS.updateConditions();
        void session
          .apply()
          .then(() => {
            if (sourceEdit === session) sourceEdit = null;
          })
          .catch((e) => bb.Blockbench.showQuickMessage(String(e), 4500))
          .finally(() => {
            session.busy = false;
            bb.updateInterface();
            bb.BARS.updateConditions();
          });
      },
      () => !!sourceEdit && sourceEdit.projectId === bb.Project?.uuid && !sourceEdit.busy,
    ),
    command(
      'mcui_source_cancel',
      '取消源图编辑',
      'close',
      () => {
        sourceEdit?.cancel();
        sourceEdit = null;
        bb.updateInterface();
      },
      () => !!sourceEdit && sourceEdit.projectId === bb.Project?.uuid && !sourceEdit.busy,
    ),
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
      name: 'UI：切换扩展画布／保留分辨率缩放',
      icon: 'aspect_ratio',
      condition: () => !!current && bb.Modes.edit && !focused(),
      keybind: new bb.Keybind({ key: 'k' }),
      click: () =>
        current?.execute('切换贴图缩放策略', (doc) => {
          for (const id of current!.state.selection) {
            const n = doc.nodes[id];
            if (n?.content?.kind === 'paint') {
              if (n.rasterSize) {
                delete n.rasterSize;
                n.content.mode = 'extend';
              } else n.rasterSize = { width: n.rect.width, height: n.rect.height };
            }
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
  interactionSelect = new bb.BarSelect('mcui_interaction', {
    name: 'UI 交互风格',
    icon: 'mouse',
    value: 'figma',
    options: { figma: 'Figma 风格', native: '原生交互' },
    condition: () => !!current,
    onChange: (item: HostObject) => {
      viewport?.setInteraction(item.value);
      localStorage.setItem('mcui_preferences', JSON.stringify({ interaction: item.value }));
    },
  });
  viewSelect = new bb.BarSelect('mcui_view', {
    name: 'UI 视图',
    icon: 'view_in_ar',
    value: '2d',
    options: { '2d': '2D 顶视图', '3d': '3D 透视' },
    condition: () => !!current,
    onChange: (item: HostObject) => viewport?.setView(item.value),
  });
  for (const widget of [interactionSelect, viewSelect]) {
    bb.Toolbars.main_tools.add(widget);
    life.add(() => {
      bb.Toolbars.main_tools.remove(widget);
      widget.delete();
    });
  }
  const byId = (id: string) => actions.find((a) => a.id === id)!;
  for (const id of ['mcui_add_layer', 'mcui_add_frame', 'mcui_import_image']) {
    const action = byId(id);
    bb.Toolbars.outliner.add(action);
    bb.BarItems.add_element.side_menu.addAction(action);
    life.add(() => {
      bb.Toolbars.outliner.remove(action);
      bb.BarItems.add_element.side_menu.removeAction(action);
    });
  }
  for (const id of ['mcui_source_apply', 'mcui_source_cancel']) {
    const action = byId(id);
    bb.Toolbars.brush.add(action);
    life.add(() => bb.Toolbars.brush.remove(action));
  }
  for (const ctor of [bb.Cube, bb.Group])
    for (const id of [
      'mcui_edit_source',
      'mcui_nine_slice',
      'mcui_content_preview',
      'mcui_flatten',
      'mcui_restore_source',
      'mcui_adopt',
      'mcui_regenerate',
      'mcui_layer_up',
      'mcui_layer_down',
    ]) {
      const action = byId(id);
      ctor.prototype.menu.addAction(action);
      life.add(() => ctor.prototype.menu.removeAction(action));
    }
  const commandActive = () =>
    !!current &&
    !focused() &&
    bb.Modes.edit &&
    ['preview', 'outliner', 'element', 'transform'].includes(bb.Prop.active_panel);
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
      entry.host.syncSelectedTexture(entry.app.state.doc, entry.app.state.selection);
      properties.refresh();
    }),
  );
  life.add(
    bb.Blockbench.on('loaded_plugin', () => {
      const timer = setTimeout(() => properties.refresh(), 70);
      life.add(() => clearTimeout(timer));
    }),
  );
  life.add(bb.Blockbench.on('select_mode', () => properties.refresh()));
  life.add(
    bb.Codecs.project.on('compile', ({ model }: HostObject) => properties.stripSerialized(model)),
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
  life.add(
    bb.Blockbench.on('finished_edit', () => {
      const entry = get();
      if (entry && !entry.app.applying) {
        entry.app.reflectSelection(entry.host.scene(entry.app.state.doc).selection);
        properties.refresh();
      }
    }),
  );
  // Small diagnostic surface for contract tests and local integrations; removed on unload.
  bb.Blockbench.mcuiStudio = {
    version: '0.3.0',
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
    sourceEdit = null;
    for (const { app } of apps.values()) app.dispose();
    apps.clear();
    life.dispose();
  };
}
