import { UiGrid } from './ui-grid';
import {
  pickNode,
  pickDrop,
  pickDrawingParent,
  type PickNode,
  type DropTarget,
} from '../../application/targets';
import {
  DrawingMachine,
  previewDrawing,
  type DrawKind,
  type DrawingPoint,
} from '../../application/drawing';
import type { Studio } from '../../application/studio';
import { InteractionMachine } from '../../application/interaction';
import { bounds, distances } from '../../domain/geometry';
import type { Handle, Id, Point, Rect } from '../../domain/types';
import { clearOverlay, drawOverlay } from '../../presentation/overlay';
import { Disposables, type HostObject, type HostRuntime } from './runtime';

function typing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input,textarea,select,[contenteditable=true]')
  );
}
interface CameraState {
  ortho: boolean;
  position: number[];
  target: number[];
  zoom: number;
  angle: unknown;
}
export interface ViewMemory {
  views: Partial<Record<'2d' | '3d', CameraState>>;
}
export class ViewportController {
  private disposables = new Disposables();
  private grid: UiGrid;
  private previews = new Map<
    HostObject,
    { root: HTMLElement; cleanup: Disposables; last: string }
  >();
  private space = false;
  private hover: Id | null = null;
  private dropTarget: DropTarget | null = null;
  automaticPlacement = true;
  private labelContext = document.createElement('canvas').getContext('2d');
  private alt = false;
  private pointerId: number | null = null;
  private machine: InteractionMachine;
  private drawing = new DrawingMachine();
  private drawingTools: Partial<Record<DrawKind, HostObject>> = {};
  private drawingPreview: HostObject | null = null;
  private drawingTarget: DropTarget | null = null;
  private drawingPlacement: Rect | null = null;
  private drawingError: string | null = null;
  private currentView: '2d' | '3d';
  private projectId: string;
  private originalCamera: CameraState;
  private tool: HostObject;
  private originalTool: HostObject;
  constructor(
    readonly bb: HostRuntime,
    readonly studio: Studio,
    private memory: ViewMemory = { views: {} },
  ) {
    this.grid = new UiGrid(bb);
    this.originalCamera = this.capture();
    this.originalTool = bb.Toolbox.selected;
    this.projectId = bb.Project.uuid;
    this.currentView =
      this.originalCamera.ortho && this.originalCamera.angle === 'top' ? '2d' : '3d';
    this.tool = new bb.Tool('mcui_select', {
      name: 'UI 选择',
      icon: 'ads_click',
      transformerMode: 'hidden',
      toolbar: 'main_tools',
      selectElements: false,
      onCanvasClick: (data: HostObject) => this.canvasClick(data),
      onCanvasMouseMove: (data: HostObject) => {
        if (!this.active()) return;
        if (data?.event) this.hover = this.hit(data.event, bb.Preview.selected);
        if (data?.event) this.alt = data.event.altKey;
        this.draw();
      },
      onUnselect: () => this.cancelInput(),
      modes: ['edit'],
      condition: () => !!bb.Project?.unhandled_root_fields?.mcui_studio,
    });
    this.disposables.add(this.tool);
    bb.Toolbars.tools.add(this.tool);
    for (const [kind, key, icon] of [
      ['frame', 'a', 'crop_free'],
      ['image', 'r', 'image'],
    ] as const) {
      const tool = new bb.Tool('mcui_draw_' + kind, {
        name: kind === 'frame' ? '绘制 Frame' : '绘制 Image',
        category: 'tools',
        icon,
        cursor: 'crosshair',
        description: '拖拽创建 · Shift 正方形 · Option/Alt 中心绘制 · Space 移动绘制框',
        transformerMode: 'hidden',
        toolbar: 'main_tools',
        selectElements: false,
        // An empty modes list prevents the host's unmatched-key fallback from switching modes.
        modes: [],
        condition: () => this.drawingContext() && !bb.Dialog.open && !bb.open_menu,
        keybind: new bb.Keybind({ key }),
        onUnselect: () => this.cancelInput(),
        onSelect: () => {
          this.hover = null;
          this.dropTarget = null;
          this.draw();
        },
      });
      this.drawingTools[kind] = tool;
      bb.Toolbars.tools.add(tool);
      this.disposables.add(tool);
    }
    this.disposables.add(
      bb.Blockbench.on('press_key', (data: HostObject) => {
        const e = data.event as KeyboardEvent;
        if (
          !this.drawingContext() ||
          data.input_in_focus ||
          typing(e.target) ||
          typing(document.activeElement) ||
          e.isComposing ||
          bb.Dialog.open ||
          bb.open_menu
        )
          return;
        for (const tool of Object.values(this.drawingTools))
          if (tool.keybind.isTriggered(e)) {
            data.capture();
            if (!e.repeat) tool.select();
            return;
          }
      }),
    );
    this.machine = new InteractionMachine(studio, { pan: (dx, dy) => this.pan(dx, dy) });
    this.disposables.add(
      studio.subscribe(() => {
        if (this.drawing.request) this.updateDrawing();
        this.draw();
      }),
    );
    this.disposables.add(
      bb.Blockbench.on('unselect_project', () => {
        this.cancelInput();
      }),
    );
    this.disposables.add(
      bb.Blockbench.on('select_mode', () => {
        if (!bb.Modes.edit) {
          this.cancelInput();
        }
      }),
    );
    this.disposables.add(
      bb.Blockbench.on('finish_selection_change', () => {
        if (!this.active()) return;
        for (const object of [...bb.Outliner.selected]) {
          const id = this.nodeId(object.uuid),
            n = id ? studio.state.scene.nodes[id] : undefined;
          if (!n || n.locked || !n.visible) object.unselect();
        }
        bb.updateSelection();
      }),
    );
    this.disposables.add(
      bb.Blockbench.on('render_frame', () => {
        this.attach();
        this.draw();
      }),
    );
    this.disposables.listen(
      document,
      'keydown',
      ((event: KeyboardEvent) => this.key(event, true)) as EventListener,
      true,
    );
    this.disposables.listen(
      document,
      'keyup',
      ((event: KeyboardEvent) => this.key(event, false)) as EventListener,
      true,
    );
    this.disposables.listen(window, 'blur', () => {
      this.space = false;
      this.alt = false;
      this.cancelInput();
      this.draw();
    });
    this.attach();
  }
  private capture(): CameraState {
    const p = this.bb.Preview.selected;
    return {
      ortho: p.isOrtho,
      position: p.camera.position.toArray(),
      target: p.controls.target.toArray(),
      zoom: p.camera.zoom,
      angle: p.angle,
    };
  }
  private restore(state: CameraState) {
    const p = this.bb.Preview.selected;
    p.setProjectionMode(state.ortho);
    p.camera.position.fromArray(state.position);
    p.controls.target.fromArray(state.target);
    if (state.ortho) {
      p.camera.zoom = state.zoom;
      p.camera.updateProjectionMatrix();
    }
    p.setLockedAngle(state.angle);
    p.controls.update();
  }
  setView(view: '2d' | '3d') {
    this.cancelInput();
    this.memory.views[this.currentView] = this.capture();
    const p = this.bb.Preview.selected,
      saved = this.memory.views[view];
    if (saved) this.restore(saved);
    else
      p.loadAnglePreset(
        this.bb.DefaultCameraPresets.find(
          (preset: HostObject) => preset.id === (view === '2d' ? 'top' : 'initial'),
        ),
      );
    if (view === '2d') {
      const max = Math.max(0, ...Object.values(this.studio.state.scene.nodes).map((n) => n.depth));
      if (p.camera.position.y < max + 100) p.camera.position.y = max + 512;
      p.controls.update();
      if (!saved) this.fit();
    }
    this.currentView = view;
    this.studio.setView(view);
    this.syncTool();
    this.draw();
  }
  shortcutsAvailable() {
    return (
      this.drawingContext() &&
      this.pointerId === null &&
      !this.drawing.request &&
      !this.bb.Preview.selected?.selection?.sr_move_f
    );
  }
  fit(selectionOnly = false) {
    const p = this.bb.Preview.selected;
    const rect = bounds(
      Object.values(this.studio.state.scene.nodes)
        .filter((n) => n.visible && (!selectionOnly || this.studio.state.selection.includes(n.id)))
        .map((n) => n.rect),
    );
    if (!rect || !p.isOrtho) return;
    p.camera.zoom = Math.min(
      (p.camera.right - p.camera.left) / (rect.width + 32),
      (p.camera.top - p.camera.bottom) / (rect.height + 32),
    );
    p.camera.position.x = p.controls.target.x = rect.x + rect.width / 2;
    p.camera.position.z = p.controls.target.z = rect.y + rect.height / 2;
    p.camera.updateProjectionMatrix();
    p.controls.update();
  }
  setAutomaticPlacement(value: boolean) {
    this.cancelInput();
    this.automaticPlacement = value;
    this.draw();
  }
  setInteraction(value: 'figma' | 'native') {
    this.cancelInput();
    this.studio.setInteraction(value);
    this.syncTool();
    this.draw();
  }
  private syncTool() {
    if (
      this.studio.state.interaction === 'figma' &&
      this.studio.state.view === '2d' &&
      this.bb.Modes.edit
    )
      this.tool.select();
    else if (this.bb.Toolbox.selected === this.tool || this.drawingKind())
      this.bb.BarItems.move_tool.select();
  }
  private navigationActive() {
    return (
      this.studio.state.interaction === 'figma' &&
      this.studio.state.view === '2d' &&
      this.bb.Preview.selected?.isOrtho
    );
  }
  private drawingContext() {
    return (
      this.bb.Project?.uuid === this.projectId &&
      this.navigationActive() &&
      this.bb.Preview.selected?.angle === 'top' &&
      this.bb.Modes.edit &&
      !this.studio.state.busy &&
      !this.bb.Dialog.open &&
      !this.bb.open_interface &&
      !this.bb.open_menu
    );
  }
  private drawingKind(): DrawKind | null {
    return (
      (Object.keys(this.drawingTools) as DrawKind[]).find(
        (kind) => this.drawingTools[kind] === this.bb.Toolbox.selected,
      ) ?? null
    );
  }
  private drawingActive() {
    return this.drawingContext() && !!this.drawingKind();
  }
  private cancelInput() {
    this.machine?.cancel();
    this.drawing.cancel();
    this.drawingPreview = null;
    this.drawingTarget = null;
    this.drawingPlacement = null;
    this.drawingError = null;
    const pointer = this.pointerId;
    this.pointerId = null;
    this.hover = null;
    this.dropTarget = null;
    if (pointer !== null)
      for (const p of this.previews.keys())
        if (p.node.hasPointerCapture(pointer)) p.node.releasePointerCapture(pointer);
  }
  private drawingPoint(e: PointerEvent, p: HostObject): DrawingPoint {
    return {
      world: this.world(e.clientX, e.clientY, p),
      screen: { x: e.clientX, y: e.clientY },
      shift: e.shiftKey,
      alt: e.altKey,
      space: this.space,
    };
  }
  private updateDrawing() {
    const request = this.drawing.request;
    if (!request) return;
    try {
      this.drawingPlacement = previewDrawing(this.studio.state.doc, request);
      this.drawingError = null;
    } catch (error) {
      this.drawingPlacement = null;
      this.drawingError = error instanceof Error ? error.message : String(error);
    }
  }
  private active() {
    return (
      this.navigationActive() &&
      this.bb.Modes.edit &&
      this.bb.Toolbox.selected === this.tool &&
      !this.studio.state.busy
    );
  }
  private world(clientX: number, clientY: number, preview = this.bb.Preview.selected): Point {
    const r = preview.canvas.getBoundingClientRect();
    const v = new this.bb.THREE.Vector3(
      ((clientX - r.left) / r.width) * 2 - 1,
      (-(clientY - r.top) / r.height) * 2 + 1,
      0,
    ).unproject(preview.camera);
    return { x: v.x, y: v.z };
  }
  private screen(point: Point, preview: HostObject): Point {
    const v = new this.bb.THREE.Vector3(point.x, 0, point.y).project(preview.camera);
    const r = preview.canvas.getBoundingClientRect(),
      nr = preview.node.getBoundingClientRect();
    return {
      x: Math.round((((v.x + 1) * r.width) / 2 + r.left - nr.left) * 100) / 100,
      y: Math.round((((1 - v.y) * r.height) / 2 + r.top - nr.top) * 100) / 100,
    };
  }
  private screenRect(r: Rect, p: HostObject): Rect {
    const a = this.screen({ x: r.x, y: r.y }, p),
      b = this.screen({ x: r.x + r.width, y: r.y + r.height }, p);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }
  private nodeId(uuid: string): Id | null {
    const id = Object.entries(this.studio.state.doc.bindings).find(
      ([, b]) => b.containerId === uuid || b.surfaceId === uuid,
    )?.[0];
    const n = id ? this.studio.state.scene.nodes[id] : undefined;
    return n?.visible && !n.locked ? id! : null;
  }
  private labelText(name: string, width: number) {
    if (!this.labelContext) return name;
    let text = name;
    while (
      text.length > 1 &&
      this.labelContext.measureText(text + (text === name ? '' : '…')).width > width - 12
    )
      text = Array.from(text).slice(0, -1).join('');
    return text === name ? text : text + '…';
  }
  private local(event: MouseEvent, preview: HostObject): Point {
    const rect = preview.node.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private pickNodes(preview: HostObject): PickNode[] {
    const { doc, scene, selection } = this.studio.state;
    if (this.labelContext) this.labelContext.font = '12px sans-serif';
    return scene.order.map((id) => {
      const n = doc.nodes[id]!,
        resolved = scene.nodes[id]!,
        rect = this.screenRect(resolved.rect, preview);
      let level = 0,
        parent = n.parent;
      while (parent) {
        level++;
        parent = doc.nodes[parent]?.parent ?? null;
      }
      const label =
        n.kind === 'frame' &&
        (!n.parent ||
          selection.includes(id) ||
          this.hover === id ||
          this.dropTarget?.parentId === id)
          ? {
              x: rect.x + 2,
              y: rect.y - 22,
              width: Math.min(
                230,
                Math.max(
                  40,
                  (this.labelContext?.measureText(n.name).width ?? n.name.length * 12) + 12,
                ),
              ),
              height: 20,
            }
          : undefined;
      return {
        id,
        kind: n.kind,
        rect,
        label,
        rank: resolved.depth,
        level,
        disabled: !resolved.visible || resolved.locked || !!n.suspended,
      };
    });
  }
  private hit(event: MouseEvent, preview: HostObject): Id | null {
    return pickNode(this.pickNodes(preview), this.local(event, preview));
  }
  private canvasClick(data: HostObject) {
    if (!this.active()) return;
    const e = data.event as PointerEvent,
      p = this.bb.Preview.selected;
    if (e.button !== 0 || this.space || e.ctrlKey || e.metaKey) return;
    if (this.hit(e, p)) {
      this.pointerId = e.pointerId;
      p.node.setPointerCapture(e.pointerId);
      this.machine.down(this.input(e, p));
    } else {
      if (!e.shiftKey) this.studio.select([]);
      // Only the registered UI tool is toggled; the native marquee owns its DOM and history.
      this.tool.selectElements = true;
      try {
        p.startSelRect(e);
      } finally {
        this.tool.selectElements = false;
      }
    }
  }
  private input(e: PointerEvent, preview: HostObject) {
    const world = this.world(e.clientX, e.clientY, preview);
    const local = this.local(e, preview),
      rect = preview.canvas.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    this.dropTarget =
      inside && this.machine.phase !== 'resize'
        ? pickDrop(
            this.studio.state.doc,
            this.pickNodes(preview),
            this.studio.state.selection,
            local,
            this.automaticPlacement,
          )
        : null;
    return {
      drop: this.dropTarget,
      screen: { x: e.clientX, y: e.clientY },
      world,
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      space: this.space,
      hit: this.hit(e, preview),
      handle: (e.target as HTMLElement).getAttribute?.('data-mcui-handle') as Handle | undefined,
    };
  }
  private pan(dx: number, dy: number) {
    const p = this.bb.Preview.selected,
      r = p.canvas.getBoundingClientRect(),
      a = this.world(r.left, r.top, p),
      b = this.world(r.left + dx, r.top + dy, p);
    p.camera.position.x += a.x - b.x;
    p.camera.position.z += a.y - b.y;
    p.controls.target.x += a.x - b.x;
    p.controls.target.z += a.y - b.y;
    p.controls.update();
  }
  private attach() {
    for (const p of this.bb.Preview.all) {
      if (this.previews.has(p) || p.offscreen || !p.node?.isConnected) continue;
      const root = document.createElement('div');
      root.className = 'mcui-overlay';
      Object.assign(root.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '5',
      });
      p.node.append(root);
      const cleanup = new Disposables();
      this.previews.set(p, { root, cleanup, last: '' });
      const stop = (e: Event) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      cleanup.listen(
        p.node,
        'pointerdown',
        ((e: PointerEvent) => {
          if (e.isPrimary === false || this.pointerId !== null) return;
          this.bb.Preview.selected = p;
          const surface = e.target === p.canvas || root.contains(e.target as Node);
          if (
            this.drawingActive() &&
            e.button === 0 &&
            !e.ctrlKey &&
            !e.metaKey &&
            !this.space &&
            surface
          ) {
            stop(e);
            (document.activeElement as HTMLElement)?.blur?.();
            p.controls.stopMovement?.();
            this.pointerId = e.pointerId;
            p.node.setPointerCapture(e.pointerId);
            this.drawingPreview = p;
            this.drawingTarget = pickDrawingParent(
              this.studio.state.doc,
              this.pickNodes(p),
              this.local(e, p),
              this.automaticPlacement,
            );
            this.drawing.begin(this.drawingKind()!, this.drawingPoint(e, p), this.drawingTarget);
            this.updateDrawing();
            this.draw();
            return;
          }
          if (
            !this.navigationActive() ||
            (!this.active() && e.button !== 1 && !this.space) ||
            e.button === 2
          )
            return;
          const handle = (e.target as HTMLElement).getAttribute?.('data-mcui-handle');
          if (!handle && e.button === 0 && !this.space && !this.hit(e, p)) return;
          stop(e);
          (document.activeElement as HTMLElement)?.blur?.();
          p.controls.stopMovement?.();
          this.pointerId = e.pointerId;
          (p.node as HTMLElement).setPointerCapture(e.pointerId);
          this.machine.down(this.input(e, p));
          this.draw();
        }) as EventListener,
        { capture: true },
      );
      cleanup.listen(
        p.node,
        'mousedown',
        ((e: MouseEvent) => {
          if (
            this.navigationActive() &&
            (this.pointerId !== null || e.button === 1 || this.space) &&
            e.button !== 2
          )
            stop(e);
        }) as EventListener,
        { capture: true },
      );
      cleanup.listen(
        p.node,
        'pointermove',
        ((e: PointerEvent) => {
          if (
            !this.navigationActive() ||
            (this.pointerId !== null && this.pointerId !== e.pointerId)
          )
            return;
          if (this.drawing.request) {
            stop(e);
            this.drawing.update(this.drawingPoint(e, this.drawingPreview ?? p));
            this.updateDrawing();
            this.draw();
            return;
          }
          if (this.pointerId === null) {
            if (this.drawingActive()) {
              this.drawingTarget = pickDrawingParent(
                this.studio.state.doc,
                this.pickNodes(p),
                this.local(e, p),
                this.automaticPlacement,
              );
              this.draw();
              return;
            }
            if (this.active()) {
              this.hover = this.hit(e, p);
              this.alt = e.altKey;
              this.draw();
            }
            return;
          }
          const point = this.input(e, p);
          this.alt = e.altKey;
          this.hover = point.hit;
          if (this.pointerId !== null) {
            stop(e);
            this.machine.move(point);
          }
          this.draw();
        }) as EventListener,
        { capture: true },
      );
      cleanup.listen(
        p.node,
        'pointerup',
        ((e: PointerEvent) => {
          if (this.pointerId !== e.pointerId) return;
          stop(e);
          if (this.drawing.request) {
            if (!this.drawingActive()) {
              this.cancelInput();
              this.draw();
              return;
            }
            const view = this.drawingPreview ?? p,
              rect = view.canvas.getBoundingClientRect();
            const inside =
              e.clientX >= rect.left &&
              e.clientX <= rect.right &&
              e.clientY >= rect.top &&
              e.clientY <= rect.bottom;
            this.drawing.update(this.drawingPoint(e, view));
            this.updateDrawing();
            const request = this.drawing.finish(),
              error = this.drawingError;
            this.cancelInput();
            if (inside && request) {
              if (error) this.bb.Blockbench.showQuickMessage(error, 4500);
              else if (this.studio.createDrawn(request)) this.tool.select();
            }
            this.draw();
            return;
          }
          this.machine.move(this.input(e, p));
          this.machine.up();
          this.dropTarget = null;
          this.pointerId = null;
          if (p.node.hasPointerCapture(e.pointerId)) p.node.releasePointerCapture(e.pointerId);
          this.draw();
        }) as EventListener,
        { capture: true },
      );
      cleanup.listen(p.node, 'pointerleave', () => {
        this.hover = null;
        this.dropTarget = null;
        if (!this.drawing.request) this.drawingTarget = null;
        this.draw();
      });
      cleanup.listen(
        p.node,
        'pointercancel',
        () => {
          this.cancelInput();
          this.draw();
        },
        { capture: true },
      );
      cleanup.listen(p.node, 'lostpointercapture', () => {
        if (this.pointerId !== null) {
          this.cancelInput();
          this.draw();
        }
      });
      cleanup.listen(
        p.node,
        'contextmenu',
        ((e: MouseEvent) => {
          if (!this.drawingActive()) return;
          stop(e);
          this.cancelInput();
          this.tool.select();
          this.draw();
        }) as EventListener,
        true,
      );
      cleanup.listen(
        p.node,
        'dblclick',
        ((e: MouseEvent) => {
          if (!this.active()) return;
          stop(e);
          const id = this.hit(e, p);
          if (id) {
            this.studio.select([id]);
            this.studio.paint(id);
          }
          this.draw();
        }) as EventListener,
        { capture: true },
      );
      cleanup.listen(
        p.node,
        'wheel',
        ((e: WheelEvent) => {
          if (!this.navigationActive()) return;
          this.bb.Preview.selected = p;
          stop(e);
          if (this.drawing.request) return;
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? p.height : 1;
          if (e.ctrlKey) {
            const before = this.world(e.clientX, e.clientY, p);
            p.camera.zoom = Math.max(
              0.02,
              Math.min(1000, p.camera.zoom * Math.exp(-e.deltaY * unit * 0.01)),
            );
            p.camera.updateProjectionMatrix();
            const after = this.world(e.clientX, e.clientY, p);
            p.camera.position.x += before.x - after.x;
            p.camera.position.z += before.y - after.y;
            p.controls.target.x += before.x - after.x;
            p.controls.target.z += before.y - after.y;
            p.controls.update();
          } else this.pan(-e.deltaX * unit, -e.deltaY * unit);
          this.draw();
        }) as EventListener,
        { capture: true, passive: false },
      );
    }
  }
  private key(e: KeyboardEvent, down: boolean) {
    // Release temporary modifiers even if a dialog/input gained focus after keydown.
    if (!down && e.code === 'Space') this.space = false;
    if (!down && e.key === 'Alt') this.alt = false;
    if (
      typing(e.target) ||
      this.bb.Dialog.open ||
      this.bb.open_interface ||
      this.bb.open_menu ||
      !this.navigationActive() ||
      (!this.drawingActive() &&
        !['preview', 'outliner', 'element', 'transform'].includes(this.bb.Prop.active_panel))
    )
      return;
    if (e.code === 'Space') {
      this.space = down;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (this.drawingActive() && ['Shift', 'Alt', ' '].includes(e.key)) {
      this.drawing.modifiers(e.shiftKey, e.altKey, this.space);
      this.updateDrawing();
      this.draw();
    }
    if (e.key === 'Alt' && this.active()) {
      this.alt = down;
      e.stopImmediatePropagation();
      this.draw();
    }
    if (!down) return;
    if (
      this.drawingActive() &&
      (e.key === 'Escape' || (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey))
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const drawing = !!this.drawing.request;
      this.cancelInput();
      if (!drawing || e.key.toLowerCase() === 'v') this.tool.select();
      this.draw();
      return;
    }
    if (
      this.drawing.request &&
      (['Delete', 'Backspace'].includes(e.key) ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'))
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancelInput();
      this.draw();
      return;
    }
    if (e.key === 'Escape') {
      const p = this.bb.Preview.selected;
      if (p.selection.sr_move_f) {
        this.bb.Undo.cancelSelection(true);
        p.stopSelRect(e);
      }
      this.cancelInput();
      this.draw();
    }
    if (!this.active() || e.metaKey || e.ctrlKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.studio.deleteSelection();
    }
    if (e.key.toLowerCase() === 'v') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.tool.select();
    }
  }
  draw() {
    if (this.bb.Project?.uuid !== this.projectId) return;
    if (this.drawing.request && !this.drawingContext()) this.cancelInput();
    this.memory.views[this.currentView] = this.capture();
    this.grid.update(this.studio.state.view === '2d');
    for (const [p, entry] of this.previews) {
      if (this.studio.state.view !== '2d' || !p.isOrtho || p.angle !== 'top') {
        if (entry.last) {
          clearOverlay(entry.root);
          entry.last = '';
        }
        continue;
      }
      const originalSelection = this.active() ? this.studio.getSelectionBounds() : null;
      const delta = this.studio.movePreview;
      const selection =
        originalSelection && delta
          ? {
              ...originalSelection,
              x: originalSelection.x + delta.x,
              y: originalSelection.y + delta.y,
            }
          : originalSelection;
      const drawing = this.drawingActive();
      const nodes = this.pickNodes(p),
        drop =
          drawing && this.machine.phase !== 'pan'
            ? this.drawingTarget
            : this.machine.phase === 'move'
              ? this.dropTarget
              : null;
      const hovered =
        this.active() &&
        this.machine.phase === 'idle' &&
        this.hover &&
        !this.studio.state.selection.includes(this.hover)
          ? nodes.find((n) => n.id === this.hover)
          : undefined;
      const ms =
        selection && this.alt && this.hover && !this.studio.state.selection.includes(this.hover)
          ? distances(selection, this.studio.state.scene.nodes[this.hover]!.rect)
          : [];
      const origin = this.screen({ x: 0, y: 0 }, p),
        unit = this.screen({ x: 1, y: 1 }, p);
      const spacing = Math.abs(unit.x - origin.x);
      const request = drawing && this.drawingPreview === p ? this.drawing.request : null;
      const model = {
        creation: request
          ? {
              rect: this.screenRect(request.rect, p),
              placement: this.drawingPlacement ? this.screenRect(this.drawingPlacement, p) : null,
              label: `${request.kind === 'frame' ? 'Frame' : 'Image'} · ${request.rect.width} × ${request.rect.height}px`,
              error: this.drawingError,
            }
          : null,
        hover: hovered?.rect ?? null,
        labels:
          this.active() || drawing
            ? nodes
                .filter((n) => !!n.label && this.studio.state.scene.nodes[n.id]?.visible)
                .map((n) => ({
                  id: n.id,
                  name: this.labelText(this.studio.state.doc.nodes[n.id]!.name, n.label!.width),
                  rect: n.label!,
                }))
            : [],
        drop:
          drop &&
          nodes.some((n) => n.id === drop.parentId) &&
          this.studio.state.doc.nodes[drop.parentId] &&
          (this.active() || drawing)
            ? {
                rect: nodes.find((n) => n.id === drop.parentId)!.rect,
                name: this.studio.state.doc.nodes[drop.parentId]!.name,
                line: drop.line,
              }
            : null,
        grid:
          spacing >= 8
            ? { x: origin.x, y: origin.y, spacing, opacity: Math.min(0.16, (spacing - 8) / 100) }
            : null,
        width: p.width,
        height: p.height,
        selection: selection ? this.screenRect(selection, p) : null,
        marquee: null,
        measurements: ms.map((m) => ({
          ...m,
          from: this.screen(m.from, p),
          to: this.screen(m.to, p),
        })),
      };
      const key = JSON.stringify(model);
      if (entry.last !== key) {
        drawOverlay(entry.root, model);
        entry.last = key;
      }
    }
  }
  dispose() {
    this.cancelInput();
    for (const { root, cleanup } of this.previews.values()) {
      cleanup.dispose();
      clearOverlay(root);
      root.remove();
    }
    this.previews.clear();
    if (this.bb.Toolbox.selected === this.tool || this.drawingKind()) {
      const original = this.originalTool;
      const registered = original && this.bb.BarItems[original.id] === original;
      const fallback = this.bb.Modes.paint
        ? this.bb.BarItems.brush_tool
        : this.bb.BarItems.move_tool;
      (registered && this.bb.BARS.condition(original.condition) ? original : fallback)?.select();
    }
    if (this.bb.Project?.uuid === this.projectId) this.restore(this.originalCamera);
    this.disposables.dispose();
    this.grid.restore();
  }
}
