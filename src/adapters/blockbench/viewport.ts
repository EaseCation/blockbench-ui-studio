import { SnapSession, snapReferences, type SnapGuide } from '../../application/snapping';
import type { InputPoint } from '../../application/interaction';
import type { UiDocument } from '../../domain/types';
import { corners, center, around, pointBounds } from '../../domain/transform';
import { pinchZoom, wheelZoom } from '../../application/zoom';
import { marqueeScope, selectMarquee } from '../../application/marquee';
import { BindingIndex } from './binding-index';
import { SelectionView } from './selection-view';
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
  drawingRect,
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
  private selectionView: SelectionView;
  private previews = new Map<
    HostObject,
    { root: HTMLElement; cleanup: Disposables; last: string }
  >();
  private space = false;
  private control = false;
  private hover: Id | null = null;
  private dropTarget: DropTarget | null = null;
  automaticPlacement = true;
  smartSnapping = true;
  private snapGuides: SnapGuide[] = [];
  private snapCache: { doc: UiDocument; key: string; session: SnapSession } | null = null;
  private labelContext = document.createElement('canvas').getContext('2d');
  private alt = false;
  private pointerId: number | null = null;
  private nativeMarquee: {
    preview: HostObject;
    docId: Id;
    old: Id[];
    scope: Id | null;
    deep: boolean;
    extend: boolean;
    cleanup: () => void;
    click: Id | null;
    undo: HostObject;
    project: HostObject;
    pointer: number;
  } | null = null;
  private machine: InteractionMachine;
  private drawing = new DrawingMachine((rect, origin, point) =>
    this.snapDrawing(rect, origin, point),
  );
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
    this.selectionView = new SelectionView(bb, studio);
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
    this.machine = new InteractionMachine(studio, {
      pan: (dx, dy) => this.pan(dx, dy),
      snapMove: (rect, delta, input) => this.snapMove(rect, delta, input),
      clearSnap: () => this.clearSnapping(),
    });
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
      this.control = false;
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
  hasInputGesture() {
    return (
      this.pointerId !== null ||
      !!this.drawing.request ||
      !!this.nativeMarquee ||
      !!this.bb.Preview.selected?.selection?.sr_move_f
    );
  }
  shortcutsAvailable(allowMenu = false) {
    return this.drawingContext(allowMenu) && !this.hasInputGesture();
  }
  fit(selectionOnly = false) {
    const p = this.bb.Preview.selected;
    const rect = bounds(
      Object.values(this.studio.state.scene.nodes)
        .filter((n) => n.visible && (!selectionOnly || this.studio.state.selection.includes(n.id)))
        .map((n) => n.bounds ?? n.rect),
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
  setSmartSnapping(value: boolean) {
    this.cancelInput();
    this.smartSnapping = value;
    this.draw();
  }
  private clearSnapping() {
    this.snapGuides = [];
    this.snapCache = null;
  }
  private snapSession(ids: Id[], parent?: Id | null) {
    const { doc, scene } = this.studio.state,
      key = JSON.stringify([ids, parent]);
    if (!this.snapCache || this.snapCache.doc !== doc || this.snapCache.key !== key)
      this.snapCache = {
        doc,
        key,
        session: new SnapSession(snapReferences(doc, scene, ids, parent)),
      };
    return this.snapCache.session;
  }
  private snapDistance() {
    const p = this.projector(this.bb.Preview.selected),
      a = p.project({ x: 0, y: 0 }),
      b = p.project({ x: 1, y: 0 });
    return 6 / Math.max(0.001, Math.hypot(b.x - a.x, b.y - a.y));
  }
  private snapMove(rect: Rect, delta: Point, input: InputPoint): Point {
    const raw = { x: Math.round(delta.x), y: Math.round(delta.y) },
      doc = this.studio.state.doc,
      ids = this.studio.state.selection;
    const target = input.drop?.parentId;
    const flow = ids.some((id) => {
      const n = doc.nodes[id]!;
      return (
        n.parent &&
        doc.nodes[n.parent]?.frame?.engineType === 'stack_panel' &&
        n.layout.positioning === 'flow' &&
        (!target || target === n.parent)
      );
    });
    if (
      !this.smartSnapping ||
      input.control ||
      input.inside === false ||
      flow ||
      (target && doc.nodes[target]?.frame?.engineType === 'stack_panel') ||
      this.bb.Preview.selected.angle !== 'top'
    ) {
      this.clearSnapping();
      return raw;
    }
    const session = this.snapSession(ids, target),
      threshold = this.snapDistance();
    const moved = { ...rect, x: rect.x + raw.x, y: rect.y + raw.y },
      correction = session.align(moved, threshold);
    this.snapGuides = session.guides(
      { ...moved, x: moved.x + correction.x, y: moved.y + correction.y },
      threshold * 0.7,
    );
    return { x: raw.x + correction.x, y: raw.y + correction.y };
  }
  private snapDrawing(rect: Rect, origin: Point, point: DrawingPoint): Rect {
    const parent = this.drawing.request?.target?.parentId ?? null;
    if (
      !this.smartSnapping ||
      point.control ||
      point.shift ||
      point.alt ||
      point.space ||
      point.inside === false ||
      (parent && this.studio.state.doc.nodes[parent]?.frame?.engineType === 'stack_panel')
    ) {
      this.clearSnapping();
      return rect;
    }
    const x = point.world.x < origin.x ? 0 : 1,
      y = point.world.y < origin.y ? 0 : 1;
    const session = this.snapSession([], parent),
      threshold = this.snapDistance();
    const correction = session.align(rect, threshold, {
      x: [x],
      y: [y],
      accept: (axis, d) => {
        const side = axis === 'x' ? x : y,
          end = rect[axis] + (axis === 'x' ? rect.width : rect.height) * side + d,
          start = Math.round(origin[axis]);
        return Math.abs(end - Math.round(end)) < 1e-6 && (side ? end - start : start - end) >= 1;
      },
    });
    const result = drawingRect(
      origin,
      { x: point.world.x + correction.x, y: point.world.y + correction.y },
      false,
      false,
    );
    this.snapGuides = session.guides(result, threshold * 0.7);
    return result;
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
  private drawingContext(allowMenu = false) {
    return (
      this.bb.Project?.uuid === this.projectId &&
      this.navigationActive() &&
      this.bb.Preview.selected?.angle === 'top' &&
      this.bb.Modes.edit &&
      !this.studio.state.busy &&
      !this.bb.Dialog.open &&
      !this.bb.open_interface &&
      (allowMenu || !this.bb.open_menu)
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
    this.clearSnapping();
    this.cancelNativeMarquee();
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
    const r = p.canvas.getBoundingClientRect();
    return {
      control: e.ctrlKey,
      inside:
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom,
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
  private projector(preview: HostObject) {
    const r = preview.canvas.getBoundingClientRect(),
      nr = preview.node.getBoundingClientRect();
    const vector = new this.bb.THREE.Vector3();
    return {
      key: [
        r.width,
        r.height,
        r.left - nr.left,
        r.top - nr.top,
        ...preview.camera.projectionMatrix.elements,
        ...preview.camera.matrixWorldInverse.elements,
      ].join(','),
      project: (point: Point): Point => {
        vector.set(point.x, 0, point.y).project(preview.camera);
        return {
          x: Math.round((((vector.x + 1) * r.width) / 2 + r.left - nr.left) * 100) / 100,
          y: Math.round((((1 - vector.y) * r.height) / 2 + r.top - nr.top) * 100) / 100,
        };
      },
    };
  }
  private screen(point: Point, preview: HostObject): Point {
    return this.projector(preview).project(point);
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
  private bindings = new BindingIndex();
  private nodeId(uuid: string): Id | null {
    const id = this.bindings.get(this.studio.state.doc).get(uuid);
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
  private picks = new WeakMap<
    HostObject,
    { doc: unknown; scene: unknown; key: string; nodes: PickNode[] }
  >();
  private pickNodes(preview: HostObject): PickNode[] {
    const { doc, scene, selection } = this.studio.state;
    const projection = this.projector(preview);
    const key = JSON.stringify([projection.key, selection, this.hover, this.dropTarget?.parentId]);
    const cached = this.picks.get(preview);
    if (cached?.doc === doc && cached.scene === scene && cached.key === key) return cached.nodes;
    if (this.labelContext) this.labelContext.font = '12px sans-serif';
    const nodes = scene.order.map((id) => {
      const n = doc.nodes[id]!,
        resolved = scene.nodes[id]!,
        polygon = (resolved.corners ?? corners(resolved.rect)).map((point) =>
          projection.project(point),
        ),
        rect = pointBounds(polygon);
      let level = 0,
        parent = n.parent;
      while (parent) {
        level++;
        parent = doc.nodes[parent]?.parent ?? null;
      }
      const labelBox =
        n.kind === 'frame' && !n.parent && rect.width > 0 && rect.height > 0
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
      let labelAngle = 0,
        labelPolygon: Point[] | undefined;
      if (labelBox) {
        const origin = polygon[0]!,
          top = polygon[1]!,
          left = polygon[3]!;
        const w = Math.hypot(top.x - origin.x, top.y - origin.y),
          h = Math.hypot(left.x - origin.x, left.y - origin.y);
        const ux = (top.x - origin.x) / w,
          uy = (top.y - origin.y) / w,
          vx = (left.x - origin.x) / h,
          vy = (left.y - origin.y) / h;
        labelBox.x = origin.x + 2 * ux - 22 * vx;
        labelBox.y = origin.y + 2 * uy - 22 * vy;
        labelAngle = (Math.atan2(uy, ux) * 180) / Math.PI;
        labelPolygon = corners(labelBox, around(labelBox, -labelAngle));
      }
      return {
        id,
        kind: n.kind,
        rect,
        polygon,
        label: labelPolygon ? pointBounds(labelPolygon) : undefined,
        labelBox,
        labelAngle,
        labelPolygon,
        rank: resolved.depth,
        level,
        disabled: !resolved.visible || resolved.locked || !!n.suspended,
      };
    });
    this.picks.set(preview, { doc, scene, key, nodes });
    return nodes;
  }
  private hit(event: MouseEvent, preview: HostObject, preferSelection = true): Id | null {
    return pickNode(
      this.pickNodes(preview),
      this.local(event, preview),
      preferSelection && !event.shiftKey && !this.deepModifier(event)
        ? this.studio.state.selection
        : [],
    );
  }
  private deepModifier(e: MouseEvent | KeyboardEvent) {
    return this.bb.Blockbench.platform === 'darwin' || navigator.userAgent.includes('Mac OS')
      ? e.metaKey
      : e.ctrlKey;
  }
  private canvasClick(data: HostObject) {
    if (!this.active()) return;
    const e = data.event as PointerEvent,
      p = this.bb.Preview.selected;
    if (e.button !== 0 || this.space || this.nativeMarquee) return;
    if (this.hit(e, p) && !this.deepModifier(e)) {
      this.pointerId = e.pointerId;
      p.node.setPointerCapture(e.pointerId);
      this.machine.down(this.input(e, p));
    } else this.startNativeMarquee(e, p);
  }
  private startNativeMarquee(e: PointerEvent, p: HostObject) {
    if (this.nativeMarquee || this.bb.Dialog.open || this.bb.open_interface || this.bb.open_menu)
      return;
    const scope = marqueeScope(this.studio.state.doc, this.pickNodes(p), this.local(e, p));
    const move = (event: PointerEvent) => {
      if (event.pointerId !== e.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      p.moveSelRect(event);
      this.updateNativeMarquee(event);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== e.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      p.moveSelRect(event);
      this.finishNativeMarquee(event);
      if (p.selection.sr_move_f) p.stopSelRect(event);
    };
    this.nativeMarquee = {
      preview: p,
      pointer: e.pointerId,
      undo: this.bb.Project.undo,
      project: this.bb.Project,
      docId: this.studio.state.doc.id,
      old: [...this.studio.state.selection],
      scope,
      deep: this.deepModifier(e),
      extend: e.shiftKey,
      click: this.hit(e, p),
      cleanup: () => {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', up, true);
        if (p.node.hasPointerCapture(e.pointerId)) p.node.releasePointerCapture(e.pointerId);
      },
    };
    // Own a fresh selection baseline; native edit transactions may leave an old one.
    if (!this.bb.Undo.current_save) this.bb.Undo.cancelSelection(false);
    // Keep the host's rectangle, activation threshold and selection Undo.
    this.tool.selectElements = true;
    try {
      const canvas = p.canvas.getBoundingClientRect();
      p.startSelRect({
        clientX: e.clientX,
        clientY: e.clientY,
        offsetX: e.clientX - canvas.left,
        offsetY: e.clientY - canvas.top,
        pointerType: e.pointerType,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      });
    } finally {
      this.tool.selectElements = false;
    }
    // Cmd/Ctrl navigation can suppress compatibility mouse events. Feed PointerEvents
    // into the registered native gesture helpers, without replacing host methods.
    for (const type of ['mousemove', 'touchmove'])
      document.removeEventListener(type, p.selection.sr_move_f);
    for (const type of ['mouseup', 'touchend'])
      document.removeEventListener(type, p.selection.sr_stop_f);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    p.node.setPointerCapture(e.pointerId);
  }
  private updateNativeMarquee(e?: MouseEvent | KeyboardEvent) {
    const gesture = this.nativeMarquee;
    if (!gesture) return;
    if (e) {
      gesture.deep = this.deepModifier(e);
      gesture.extend = e.shiftKey;
    }
    if (
      !this.active() ||
      gesture.docId !== this.studio.state.doc.id ||
      this.bb.Dialog.open ||
      this.bb.open_interface ||
      this.bb.open_menu
    ) {
      this.cancelNativeMarquee();
      return;
    }
    if (!gesture.preview.selection.activated) return;
    const box = gesture.preview.selection.box.getBoundingClientRect(),
      node = gesture.preview.node.getBoundingClientRect();
    const selected = selectMarquee(
      this.studio.state.doc,
      this.pickNodes(gesture.preview),
      { x: box.left - node.left, y: box.top - node.top, width: box.width, height: box.height },
      gesture.scope,
      gesture.deep,
      gesture.extend ? gesture.old : [],
    );
    this.studio.reflectSelection(selected);
    this.studio.host.select(this.studio.state.doc, selected, false);
  }
  private finishNativeMarquee(e?: MouseEvent) {
    const gesture = this.nativeMarquee;
    if (!gesture) return;
    this.updateNativeMarquee(e);
    if (this.nativeMarquee !== gesture) return;
    if (!gesture.preview.selection.activated) {
      const selected = gesture.extend ? [...gesture.old] : [];
      if (gesture.deep && gesture.click) {
        const i = selected.indexOf(gesture.click);
        if (i >= 0 && gesture.extend) selected.splice(i, 1);
        else selected.push(gesture.click);
      }
      this.studio.reflectSelection(selected);
      this.studio.host.select(this.studio.state.doc, this.studio.state.selection, false);
    }
    this.nativeMarquee = null;
    gesture.cleanup();
    // The native stop helper captures this same selection in selection_post.
  }
  private cancelNativeMarquee() {
    const gesture = this.nativeMarquee;
    if (!gesture) return;
    this.nativeMarquee = null;
    gesture.cleanup();
    // Stop the native document gesture without capturing an intermediate selection.
    gesture.undo.cancelSelection(false);
    const native = gesture.preview.selection;
    for (const type of ['mousemove', 'touchmove'])
      document.removeEventListener(type, native.sr_move_f);
    for (const type of ['mouseup', 'touchend'])
      document.removeEventListener(type, native.sr_stop_f);
    delete native.sr_move_f;
    delete native.sr_stop_f;
    native.box.remove();
    native.activated = false;
    if (this.studio.state.doc.id === gesture.docId) {
      this.studio.reflectSelection(gesture.old);
      const restore = () => {
        if (this.studio.state.doc.id === gesture.docId)
          this.studio.host.select(this.studio.state.doc, gesture.old, false);
      };
      if (this.bb.Project === gesture.project) restore();
      else gesture.project.whenNextOpen(restore);
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
      inside && this.machine.phase !== 'resize' && this.machine.phase !== 'rotate'
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
      control: e.ctrlKey,
      inside,
      screen: { x: e.clientX, y: e.clientY },
      world,
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      space: this.space,
      hit: this.hit(e, preview),
      rotate: (e.target as HTMLElement).hasAttribute?.('data-mcui-rotate'),
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
          const handle =
            (e.target as HTMLElement).getAttribute?.('data-mcui-handle') ||
            (e.target as HTMLElement).hasAttribute?.('data-mcui-rotate');
          if (
            !handle &&
            this.active() &&
            surface &&
            e.button === 0 &&
            !this.space &&
            this.deepModifier(e)
          ) {
            stop(e);
            (document.activeElement as HTMLElement)?.blur?.();
            p.controls.stopMovement?.();
            this.startNativeMarquee(e, p);
            return;
          }
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
            (this.pointerId !== null || !!this.nativeMarquee || e.button === 1 || this.space) &&
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
          if (this.nativeMarquee) return;
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
              this.hover = (e.target as Element).closest?.('[data-mcui-rotate],[data-mcui-handle]')
                ? null
                : this.hit(e, p, !e.altKey);
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
        this.clearSnapping();
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
        if (this.nativeMarquee) {
          this.cancelNativeMarquee();
          this.draw();
        }
        if (this.pointerId !== null) {
          this.cancelInput();
          this.draw();
        }
      });
      cleanup.listen(
        p.node,
        'contextmenu',
        ((e: MouseEvent) => {
          if (this.nativeMarquee) {
            stop(e);
            this.cancelNativeMarquee();
            this.draw();
            return;
          }
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
          const id = this.hit(e, p, false);
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
          if (this.drawing.request || this.nativeMarquee || this.pointerId !== null) return;
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? p.height : 1;
          if (e.ctrlKey) {
            const before = this.world(e.clientX, e.clientY, p);
            // Chromium pinch adds ctrlKey without a physical Control keydown.
            // Delta magnitude alone cannot distinguish high-resolution wheels from pinch.
            const mac =
              this.bb.Blockbench.platform === 'darwin' || navigator.userAgent.includes('Mac OS');
            const pinch = mac && e.deltaMode === 0 && !this.control;
            p.camera.zoom = pinch
              ? pinchZoom(p.camera.zoom, e.deltaY)
              : wheelZoom(p.camera.zoom, e.deltaY, e.deltaMode, p.height);
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
    // Track real modifiers even while an input or another panel owns keyboard focus.
    this.control = e.key === 'Control' ? down : e.ctrlKey;
    // Release temporary modifiers even if a dialog/input gained focus after keydown.
    if (!down && e.code === 'Space') this.space = false;
    if (!down && e.key === 'Alt') this.alt = false;
    if (
      typing(e.target) ||
      this.bb.Dialog.open ||
      this.bb.open_interface ||
      this.bb.open_menu ||
      !this.navigationActive() ||
      (this.pointerId === null &&
        !this.drawingActive() &&
        !['preview', 'outliner', 'element', 'transform'].includes(this.bb.Prop.active_panel))
    )
      return;
    if (this.nativeMarquee) {
      if (
        e.key === 'Escape' ||
        (down &&
          (['Delete', 'Backspace'].includes(e.key) ||
            ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z')))
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.cancelNativeMarquee();
        this.draw();
        return;
      }
      if (['Meta', 'Control', 'Shift'].includes(e.key)) this.updateNativeMarquee(e);
    }
    if (e.code === 'Space') {
      this.space = down;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (this.drawingActive() && ['Shift', 'Alt', ' ', 'Control'].includes(e.key)) {
      this.drawing.modifiers(e.shiftKey, e.altKey, this.space, e.ctrlKey);
      this.updateDrawing();
      this.draw();
    }
    if (this.active() && ['Shift', 'Alt', 'Control'].includes(e.key) && this.pointerId !== null) {
      this.machine.modifiers(e.shiftKey, e.altKey, e.ctrlKey);
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
      if (this.pointerId !== null) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
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
    if (
      this.nativeMarquee &&
      (!this.active() || this.bb.Dialog.open || this.bb.open_interface || this.bb.open_menu)
    )
      this.cancelNativeMarquee();
    if (this.drawing.request && !this.drawingContext()) this.cancelInput();
    this.memory.views[this.currentView] = this.capture();
    this.grid.update(this.studio.state.view === '2d');
    this.selectionView.update(this.active() && this.bb.Preview.selected?.angle === 'top');
    for (const [p, entry] of this.previews) {
      if (this.studio.state.view !== '2d' || !p.isOrtho || p.angle !== 'top') {
        if (entry.last) {
          clearOverlay(entry.root);
          entry.last = '';
        }
        continue;
      }
      const projection = this.projector(p),
        project = projection.project;
      const projectRect = (rect: Rect) => pointBounds(corners(rect).map(project));
      const selectionBox = this.active()
        ? (this.machine.rotationBox ?? this.studio.getSelectionBox())
        : null;
      const originalSelection =
        selectionBox && selectionBox.rect.width > 0 && selectionBox.rect.height > 0
          ? selectionBox.rect
          : null;
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
      const origin = project({ x: 0, y: 0 }),
        unit = project({ x: 1, y: 1 });
      const spacing = Math.abs(unit.x - origin.x);
      const request = drawing && this.drawingPreview === p ? this.drawing.request : null;
      const shifted = (id: Id, rect: Rect): Rect => {
        if (!delta || !this.studio.state.selection.includes(id)) return rect;
        const before = project({ x: 0, y: 0 }),
          after = project(delta);
        return { ...rect, x: rect.x + after.x - before.x, y: rect.y + after.y - before.y };
      };
      const visualCorners = selection
        ? corners(selection, around(center(selection), selectionBox?.rotation ?? 0)).map((point) =>
            project(point),
          )
        : [];
      const c = selection ? project(center(selection)) : { x: 0, y: 0 };
      const w = visualCorners.length
        ? Math.hypot(
            visualCorners[1]!.x - visualCorners[0]!.x,
            visualCorners[1]!.y - visualCorners[0]!.y,
          )
        : 0;
      const h = visualCorners.length
        ? Math.hypot(
            visualCorners[3]!.x - visualCorners[0]!.x,
            visualCorners[3]!.y - visualCorners[0]!.y,
          )
        : 0;
      const model = {
        creation: request
          ? {
              rect: projectRect(request.rect),
              placement: this.drawingPlacement ? projectRect(this.drawingPlacement) : null,
              label: `${request.kind === 'frame' ? 'Frame' : 'Image'} · ${request.rect.width} × ${request.rect.height}px`,
              error: this.drawingError,
            }
          : null,
        snapGuides:
          this.active() || drawing
            ? this.snapGuides.map((g) => ({ ...g, from: project(g.from), to: project(g.to) }))
            : [],
        hover: hovered?.rect ?? null,
        hoverPolygon: hovered?.polygon,
        labels:
          this.active() || drawing
            ? nodes
                .filter((n) => !!n.label && this.studio.state.scene.nodes[n.id]?.visible)
                .map((n) => ({
                  id: n.id,
                  name: this.labelText(
                    this.studio.state.doc.nodes[n.id]!.name,
                    (n.labelBox ?? n.label)!.width,
                  ),
                  rect: shifted(n.id, n.labelBox ?? n.label!),
                  angle: n.labelAngle,
                }))
            : [],
        drop:
          drop &&
          nodes.some((n) => n.id === drop.parentId) &&
          this.studio.state.doc.nodes[drop.parentId] &&
          (this.active() || drawing)
            ? {
                rect: nodes.find((n) => n.id === drop.parentId)!.rect,
                polygon: nodes.find((n) => n.id === drop.parentId)!.polygon,
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
        selectedPolygons:
          this.active() && this.studio.state.selection.length > 1
            ? nodes
                .filter((n) => this.studio.state.selection.includes(n.id))
                .map((n) =>
                  (n.polygon ?? corners(n.rect)).map((point) =>
                    shifted(n.id, { ...point, width: 0, height: 0 }),
                  ),
                )
            : [],
        selection: selection ? { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h } : null,
        selectionAngle: visualCorners.length
          ? (Math.atan2(
              visualCorners[1]!.y - visualCorners[0]!.y,
              visualCorners[1]!.x - visualCorners[0]!.x,
            ) *
              180) /
            Math.PI
          : 0,
        rotationEnabled: this.studio.rotationGestureAllowed(),
        rotationActive: this.machine.phase === 'rotate',
        rotationValue: this.machine.rotationValue ?? 0,
        marquee: null,
        measurements: ms.map((m) => ({
          ...m,
          from: project(m.from),
          to: project(m.to),
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
    this.selectionView.dispose();
  }
}
