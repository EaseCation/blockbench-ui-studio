import { StudioClipboard } from './clipboard';
import { installGrouping } from './grouping';
import { contentMetadata } from './content-carrier';
import { contentApi } from './content-api';
import { Studio } from '../../application/studio';
import { OutlinerToolbar } from './outliner-toolbar';
import { WorkspaceLayout } from './workspace-layout';
import { installShortcuts } from './shortcuts';
import { clone } from '../../domain/document';
import { createNode, fixed } from '../../domain/types';
import { imagePort } from '../../platform/browser/images';
import { OutlinerView } from './outliner-view';
import { PropertyBridge } from './properties';
import { showContentPreview } from './preview-dialog';
import { NativeHost, METADATA_KEY } from './native-host';
import { ViewportController, type ViewMemory } from './viewport';
import { capabilities, Disposables, type HostObject, type HostRuntime } from './runtime';

export function install(bb: HostRuntime) {
  const missing = capabilities(bb);
  if (missing.length) {
    bb.Blockbench.showMessageBox({
      title: 'UI Studio',
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
  life.add(installGrouping(bb, () => get()?.app ?? null));
  const outlinerView = new OutlinerView(bb);
  life.add(() => outlinerView.dispose());
  const properties = new PropertyBridge(bb, () => get()?.app ?? null);
  life.add(() => properties.dispose());
  const workspaceLayout = new WorkspaceLayout(bb, () => (get()?.app === current ? current : null));
  life.add(() => workspaceLayout.dispose());
  let interactionSelect: HostObject,
    viewSelect: HostObject,
    autoPlaceSelect: HostObject,
    snapToggle: HostObject;
  const preferences = () => {
    try {
      return JSON.parse(localStorage.getItem('mcui_preferences') ?? '{}');
    } catch {
      return {};
    }
  };
  const savePreferences = (patch: HostObject) =>
    localStorage.setItem('mcui_preferences', JSON.stringify({ ...preferences(), ...patch }));
  async function activate() {
    const generation = ++token,
      project = bb.Project;
    if (current === get()?.app && current) return;
    viewport?.dispose();
    viewport = null;
    current = null;
    outlinerView.update(null);
    if (!project?.unhandled_root_fields?.[METADATA_KEY]) return;
    try {
      let entry = apps.get(project.uuid);
      if (!entry) {
        const host = new NativeHost(bb, project),
          doc = host.read();
        if (!doc) return;
        const app = new Studio(host, imagePort, doc);
        host.onSourceSession = sourceSession;
        host.onBeforeViewUpdate = (doc) => {
          properties.hydrate(doc);
          outlinerView.update(doc);
        };
        entry = { app, host };
        apps.set(project.uuid, entry);
        life.add(
          app.subscribe(() => {
            if (host.active()) {
              properties.refresh(false);
              outlinerView.update(app.state.doc);
              bb.Blockbench.dispatchEvent('mcui_content_changed');
            }
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
      outlinerView.update(current.state.doc);
      if (!viewMemory.has(project.uuid)) viewMemory.set(project.uuid, { views: {} });
      viewport = new ViewportController(bb, current, viewMemory.get(project.uuid)!);
      const saved = preferences();
      viewport.automaticPlacement = saved.autoPlace !== false;
      autoPlaceSelect?.set(viewport.automaticPlacement ? 'on' : 'off');
      viewport.smartSnapping = saved.smartSnap !== false;
      snapToggle?.set(viewport.smartSnapping);
      viewport.setInteraction(saved.interaction === 'native' ? 'native' : 'figma');
      viewport.setView(current.state.view);
      interactionSelect?.set(current.state.interaction);
      viewSelect?.set(current.state.view);
      properties.refresh();
      bb.updateInterface();
      workspaceLayout.update();
    } catch (e) {
      bb.Blockbench.showQuickMessage(`MCUI: ${e instanceof Error ? e.message : String(e)}`, 6000);
    }
  }
  async function newProject() {
    if (!bb.newProject(bb.Formats.free)) return;
    const project = bb.Project;
    project.name = 'UI 设计';
    const host = new NativeHost(bb, project),
      app = Studio.fresh(host, imagePort);
    host.onSourceSession = sourceSession;
    host.onBeforeViewUpdate = (doc) => {
      properties.hydrate(doc);
      outlinerView.update(doc);
    };
    host.write(app.state.doc);
    apps.set(project.uuid, { app, host });
    life.add(
      app.subscribe(() => {
        if (host.active()) {
          properties.refresh(false);
          outlinerView.update(app.state.doc);
          bb.Blockbench.dispatchEvent('mcui_content_changed');
        }
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
      name: 'UI 设计',
      icon: 'dashboard_customize',
      category: 'general',
      plugin: 'mcui_studio',
      description: '二维 UI 设计工作台，支持图层编辑、像素绘制、图片适配、九宫格和自动布局。',
      format_page: { button_text: '创建 UI 项目' },
      onStart: () => {
        void startProject();
      },
    }),
  );
  const clipboard = new StudioClipboard(
    bb,
    () => current,
    () => !focused() && !viewport?.hasInputGesture(),
  );
  life.add(() => clipboard.dispose());
  const command = (
    id: string,
    name: string,
    icon: string,
    click: () => void,
    condition = () => !!current,
  ) => new bb.Action(id, { name, icon, condition, click });
  const selectedLayer = () =>
    !!current && properties.targets().length === 1 && properties.targets()[0]?.kind === 'image';
  const parent = () => {
    const n = properties.targets()[0];
    return n?.id ?? null;
  };
  const withLayer = (fn: (app: Studio, id: string) => void) => {
    const n = properties.targets()[0];
    if (current && n) fn(current, n.id);
  };
  const actions = [
    command(
      'mcui_wrap_layout',
      'UI：将所选项组成自动布局',
      'view_quilt',
      () => {
        if (current?.wrapAutoLayout()) {
          properties.refresh();
          properties.showLayout();
        }
      },
      () => !!current && bb.Modes.edit && properties.targets().length > 0,
    ),
    command('mcui_add_layer', '新增 Image', 'add_photo_alternate', () =>
      current?.add('image', parent()),
    ),
    command('mcui_add_frame', '新增 UI Frame', 'dashboard_customize', () =>
      current?.add('frame', parent()),
    ),
    command('mcui_add_sibling', '新增同级 Image', 'add_photo_alternate', () =>
      current?.add('image', properties.targets()[0]?.parent ?? null),
    ),
    command('mcui_show_native', '查看／隐藏原生结构', 'account_tree', () => {
      outlinerView.raw = !outlinerView.raw;
      outlinerView.update(current?.state.doc ?? null);
    }),
    command('mcui_paste_child', '粘贴图片为子图层', 'content_paste', () => {
      void clipboard.paste(true);
    }),
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
      () => selectedLayer() && properties.targets()[0]?.content?.kind !== 'generated',
    ),
    command(
      'mcui_content_preview',
      'UI：内容预览与参数',
      'crop',
      () =>
        withLayer((app, id) => {
          const generation = token;
          void showContentPreview(bb, app, id, () => token === generation && current === app)
            .then((dispose) => {
              if (!dispose) return;
              if (token !== generation) dispose();
              else life.add(dispose);
            })
            .catch((error) => app.report(error));
        }),
      () => selectedLayer() && properties.targets()[0]?.content?.kind !== 'generated',
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
      void clipboard.paste(true);
    }),
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
      name: '新建 UI 项目',
      icon: 'dashboard_customize',
      click: () => {
        void newProject();
      },
    }),
    new bb.Action('mcui_import_image', {
      name: 'UI：导入图片',
      icon: 'image',
      condition: () => !!current,
      click: () => clipboard.importImages(),
    }),
    new bb.Action('mcui_paste_cached', {
      name: '粘贴内部 UI 图层',
      icon: 'content_paste',
      condition: () => !!current && clipboard.hasNodes(),
      click: () => {
        void clipboard.pasteCachedNodes();
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
      savePreferences({ interaction: item.value });
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
  autoPlaceSelect = new bb.BarSelect('mcui_auto_place', {
    name: '自动放入',
    icon: 'drive_file_move',
    value: preferences().autoPlace === false ? 'off' : 'on',
    options: { on: '自动放入：开', off: '自动放入：关' },
    condition: () => !!current,
    onChange: (item: HostObject) => {
      if (viewport) viewport.setAutomaticPlacement(item.value === 'on');
      savePreferences({ autoPlace: item.value === 'on' });
    },
  });
  snapToggle = new bb.Toggle('mcui_smart_snap', {
    name: '智能吸附',
    description: '中心和边缘对齐；拖动中按 Ctrl 临时关闭',
    icon: 'fa-magnet',
    default: preferences().smartSnap !== false,
    condition: () => !!current,
    onChange: (value: boolean) => {
      viewport?.setSmartSnapping(value);
      savePreferences({ smartSnap: value });
    },
  });
  for (const widget of [interactionSelect, viewSelect, autoPlaceSelect, snapToggle]) {
    bb.Toolbars.main_tools.add(widget);
    life.add(() => {
      bb.Toolbars.main_tools.remove(widget);
      widget.delete();
    });
  }
  const byId = (id: string) => actions.find((a) => a.id === id)!;
  for (const id of [
    'mcui_add_layer',
    'mcui_add_frame',
    'mcui_wrap_layout',
    'mcui_import_image',
    'mcui_show_native',
  ]) {
    const action = byId(id);
    bb.Toolbars.outliner.add(action);
    bb.BarItems.add_element.side_menu.addAction(action);
    life.add(() => {
      bb.Toolbars.outliner.remove(action);
      bb.BarItems.add_element.side_menu.removeAction(action);
    });
  }
  const outlinerToolbar = new OutlinerToolbar(bb, () => current);
  life.add(() => outlinerToolbar.dispose());
  for (const id of ['mcui_source_apply', 'mcui_source_cancel']) {
    const action = byId(id);
    bb.Toolbars.brush.add(action);
    life.add(() => bb.Toolbars.brush.remove(action));
  }
  for (const ctor of [bb.Cube, bb.Group])
    for (const id of [
      'mcui_wrap_layout',
      'mcui_add_layer',
      'mcui_add_sibling',
      'mcui_paste_child',
      'mcui_add_frame',
      'mcui_show_native',
      'mcui_edit_source',
      'mcui_nine_slice',
      'mcui_content_preview',
      'mcui_flatten',
      'mcui_restore_source',
      'mcui_adopt',
      'mcui_regenerate',
    ]) {
      const action = byId(id);
      ctor.prototype.menu.addAction(action);
      life.add(() => ctor.prototype.menu.removeAction(action));
    }
  life.add(
    installShortcuts(
      bb,
      () => current,
      () => viewport,
      () => properties.showLayout(),
      clipboard,
    ),
  );
  const commandActive = () =>
    !!current &&
    !viewport?.hasInputGesture() &&
    !focused() &&
    !bb.open_interface &&
    bb.Modes.edit &&
    ['preview', 'outliner', 'element', 'transform', 'mcui_layout', 'mcui_content'].includes(
      bb.Prop.active_panel,
    );
  life.add(
    bb.SharedActions.add('copy', {
      subject: 'mcui',
      priority: 100,
      condition: () => commandActive() && !!current!.state.selection.length,
      run: () => clipboard.copyNodes(),
    }),
  );
  life.add(
    bb.SharedActions.add('paste', {
      subject: 'mcui',
      priority: 100,
      condition: commandActive,
      run: () => {
        void clipboard.paste();
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
      void clipboard.paste(false, e);
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
      void clipboard.pasteFiles(files, true);
    }) as EventListener,
    true,
  );
  life.add(
    bb.Blockbench.on('select_project', () => {
      clipboard.cancelPending();
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
      clipboard.cancelPending();
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
      entry.app.reflectSelection(entry.host.selection(entry.app.state.doc));
      clipboard.selectionChanged();
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
  life.add(
    bb.Blockbench.on('select_mode', () => {
      const entry = get();
      if (entry) entry.host.restorePaintSelection(entry.app.state.doc);
      properties.refresh();
    }),
  );
  life.add(
    bb.Codecs.project.on('compile', ({ model }: HostObject) => properties.stripSerialized(model)),
  );
  life.add(
    bb.Blockbench.on('create_undo_save', ({ save }: HostObject) => {
      const entry = get();
      if (entry) {
        save.mcui_studio = entry.host.metadata();
        save.mcui_contents = contentMetadata(bb.Project);
      }
    }),
  );
  life.add(
    bb.Blockbench.on('load_undo_save', ({ save }: HostObject) => {
      const entry = get();
      if (entry && 'mcui_studio' in save) entry.host.restoreMetadata(save.mcui_studio);
      if (entry && save.mcui_contents)
        for (const [key, data] of Object.entries(save.mcui_contents)) {
          if (data) bb.Project.unhandled_root_fields[key] = clone(data);
          else delete bb.Project.unhandled_root_fields[key];
        }
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
        entry.app.reflectSelection(entry.host.selection(entry.app.state.doc));
        properties.refresh();
      }
    }),
  );
  const contents = contentApi(bb, () => current);
  life.add(() => contents.dispose());
  // Small diagnostic surface for contract tests and local integrations; removed on unload.
  bb.Blockbench.mcuiStudio = {
    version: '0.8.6',
    contents: contents.api,
    newProject,
    getStudio: () => current,
    getHost: () => get()?.host,
    getViewport: () => viewport,
  };
  life.add(() => delete bb.Blockbench.mcuiStudio);
  bb.Blockbench.dispatchEvent('mcui_content_api_ready', { version: 1 });
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
