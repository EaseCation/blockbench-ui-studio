import type { Studio } from '../../application/studio';
import { InteractionMachine } from '../../application/interaction';
import { bounds, contains, distances } from '../../domain/geometry';
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
  private previews = new Map<
    HostObject,
    { root: HTMLElement; cleanup: Disposables; last: string }
  >();
  private space = false;
  private hover: Id | null = null;
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
    this.originalCamera = this.capture();
    this.originalTool = bb.Toolbox.selected;
    this.projectId = bb.Project.uuid;
    this.currentView =
      this.originalCamera.ortho && this.originalCamera.angle === 'top' ? '2d' : '3d';
    this.tool = new bb.Tool('mcui_select', {
      name: 'UI 选择',
      icon: 'ads_click',
      transformerMode: 'hidden',
      selectElements: true,
      modes: ['edit'],
      condition: () => !!bb.Project?.unhandled_root_fields?.mcui_studio,
    });
    this.disposables.add(this.tool);
    this.machine = new InteractionMachine(studio, { pan: (dx, dy) => this.pan(dx, dy) });
    this.disposables.add(studio.subscribe(() => this.draw()));
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
  setInteraction(value: 'figma' | 'native') {
    this.machine.cancel();
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
    return this.navigationActive() && this.bb.Modes.edit && !this.studio.state.busy;
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
      x: ((v.x + 1) * r.width) / 2 + r.left - nr.left,
      y: ((1 - v.y) * r.height) / 2 + r.top - nr.top,
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
  private hit(point: Point): Id | null {
    const { doc, scene } = this.studio.state;
    for (const id of [...scene.order].reverse()) {
      const n = scene.nodes[id]!;
      if (doc.nodes[id]!.kind === 'layer' && n.visible && !n.locked && contains(n.rect, point))
        return id;
    }
    return null;
  }
  private input(e: PointerEvent, preview: HostObject) {
    const world = this.world(e.clientX, e.clientY, preview);
    return {
      screen: { x: e.clientX, y: e.clientY },
      world,
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      space: this.space,
      hit: this.hit(world),
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
            (this.active() || e.button === 1 || this.space) &&
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
          this.machine.up();
          this.pointerId = null;
          if (p.node.hasPointerCapture(e.pointerId)) p.node.releasePointerCapture(e.pointerId);
          this.draw();
        }) as EventListener,
        { capture: true },
      );
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
          const id = this.hit(this.world(e.clientX, e.clientY, p));
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
      !['preview', 'mcui_studio', 'outliner'].includes(this.bb.Prop.active_panel)
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
      this.machine.cancel();
      this.pointerId = null;
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
    for (const [p, entry] of this.previews) {
      if (!this.active() || !p.isOrtho || p.angle !== 'top') {
        if (entry.last) {
          clearOverlay(entry.root);
          entry.last = '';
        }
        continue;
      }
      const selection = this.studio.getSelectionBounds();
      const ms =
        selection && this.alt && this.hover && !this.studio.state.selection.includes(this.hover)
          ? distances(selection, this.studio.state.scene.nodes[this.hover]!.rect)
          : [];
      const model = {
        width: p.width,
        height: p.height,
        selection: selection ? this.screenRect(selection, p) : null,
        marquee: this.machine.marquee ? this.screenRect(this.machine.marquee, p) : null,
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
  }
}
