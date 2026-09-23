import { UiGrid } from './ui-grid';
import { pickNode, pickDrop, type PickNode, type DropTarget } from '../../application/targets';
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
      onUnselect: () => {
        this.machine?.cancel();
        this.pointerId = null;
        this.hover = null;
        this.dropTarget = null;
      },
      modes: ['edit'],
      condition: () => !!bb.Project?.unhandled_root_fields?.mcui_studio,
    });
    this.disposables.add(this.tool);
    this.machine = new InteractionMachine(studio, { pan: (dx, dy) => this.pan(dx, dy) });
    this.disposables.add(studio.subscribe(() => this.draw()));
    this.disposables.add(
      bb.Blockbench.on('unselect_project', () => {
        this.machine.cancel();
        this.pointerId = null;
        this.hover = null;
        this.dropTarget = null;
      }),
    );
    this.disposables.add(
      bb.Blockbench.on('select_mode', () => {
        if (!bb.Modes.edit) {
          this.machine.cancel();
          this.pointerId = null;
          this.hover = null;
          this.dropTarget = null;
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
      this.machine.cancel();
      this.pointerId = null;
      this.hover = null;
      this.dropTarget = null;
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
    this.machine.cancel();
    this.hover = null;
    this.dropTarget = null;
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
  fit() {
    const p = this.bb.Preview.selected;
    const rect = bounds(
      Object.values(this.studio.state.scene.nodes)
        .filter((n) => n.visible)
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
    this.machine.cancel();
    this.dropTarget = null;
    this.automaticPlacement = value;
    this.draw();
  }
  setInteraction(value: 'figma' | 'native') {
    this.machine.cancel();
    this.hover = null;
    this.dropTarget = null;
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
    else if (this.bb.Toolbox.selected === this.tool) this.bb.BarItems.move_tool.select();
  }
  private navigationActive() {
    return (
      this.studio.state.interaction === 'figma' &&
      this.studio.state.view === '2d' &&
      this.bb.Preview.selected?.isOrtho
    );
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
          this.bb.Preview.selected = p;
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
          if (!this.navigationActive()) return;
          if (this.pointerId === null) {
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
        this.draw();
      });
      cleanup.listen(
        p.node,
        'pointercancel',
        () => {
          this.machine.cancel();
          this.pointerId = null;
          this.draw();
        },
        { capture: true },
      );
      cleanup.listen(p.node, 'lostpointercapture', () => {
        if (this.pointerId !== null) {
          this.machine.cancel();
          this.pointerId = null;
          this.draw();
        }
      });
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
    if (
      typing(e.target) ||
      !this.navigationActive() ||
      !['preview', 'outliner', 'element', 'transform'].includes(this.bb.Prop.active_panel)
    )
      return;
    if (e.code === 'Space') {
      this.space = down;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (e.key === 'Alt' && this.active()) {
      this.alt = down;
      e.stopImmediatePropagation();
      this.draw();
    }
    if (!down) return;
    if (e.key === 'Escape') {
      const p = this.bb.Preview.selected;
      if (p.selection.sr_move_f) {
        this.bb.Undo.cancelSelection(true);
        p.stopSelRect(e);
      }
      this.machine.cancel();
      this.pointerId = null;
      this.hover = null;
      this.dropTarget = null;
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
      const nodes = this.pickNodes(p),
        drop = this.machine.phase === 'move' ? this.dropTarget : null;
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
      const model = {
        hover: hovered?.rect ?? null,
        labels: this.active()
          ? nodes
              .filter((n) => !!n.label && this.studio.state.scene.nodes[n.id]?.visible)
              .map((n) => ({
                id: n.id,
                name: this.labelText(this.studio.state.doc.nodes[n.id]!.name, n.label!.width),
                rect: n.label!,
              }))
          : [],
        drop:
          drop && this.active()
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
    this.machine.cancel();
    for (const { root, cleanup } of this.previews.values()) {
      cleanup.dispose();
      clearOverlay(root);
      root.remove();
    }
    this.previews.clear();
    if (this.bb.Project?.uuid === this.projectId) {
      if (this.bb.Toolbox.selected === this.tool) this.originalTool?.select();
      this.restore(this.originalCamera);
    }
    this.disposables.dispose();
    this.grid.restore();
  }
}
