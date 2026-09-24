import { center, rotateVector, normalizeAngle } from '../domain/transform';
import type { DropIntent } from './targets';
import type { Id, Handle, Point, Rect } from '../domain/types';
import { resizeRect } from '../domain/geometry';
import type { Studio } from './studio';
export interface InputPoint {
  screen: Point;
  world: Point;
  button: number;
  shift: boolean;
  alt: boolean;
  space: boolean;
  hit: Id | null;
  handle?: Handle;
  rotate?: boolean;
  control?: boolean;
  inside?: boolean;
  drop?: DropIntent | null;
}
export interface NavigationPort {
  pan(dx: number, dy: number): void;
  snapMove?(rect: Rect, delta: Point, input: InputPoint): Point;
  clearSnap?(): void;
}
export class InteractionMachine {
  phase: 'idle' | 'pending' | 'move' | 'resize' | 'rotate' | 'pan' = 'idle';
  private start: InputPoint | null = null;
  private last: Point = { x: 0, y: 0 };
  private original: Rect | null = null;
  private originalBounds: Rect | null = null;
  private rotation = 0;
  private angle = 0;
  private accumulated = 0;
  private appliedAngle = 0;
  private snapBase = 0;
  private lastInput: InputPoint | null = null;
  get rotationBox() {
    return this.phase === 'rotate' && this.original
      ? { rect: this.original, rotation: this.rotation + this.appliedAngle }
      : null;
  }
  get rotationValue() {
    return this.phase === 'rotate' ? normalizeAngle(this.snapBase + this.appliedAngle) : null;
  }
  modifiers(shift: boolean, alt: boolean, control = false) {
    if (
      this.lastInput &&
      (this.phase === 'rotate' || this.phase === 'resize' || this.phase === 'move')
    )
      this.move({ ...this.lastInput, shift, alt, control });
  }
  private delta = { x: 0, y: 0 };
  private drop: DropIntent | null = null;
  constructor(
    readonly studio: Studio,
    readonly navigation: NavigationPort,
  ) {}
  down(p: InputPoint) {
    this.start = p;
    this.lastInput = p;
    this.snapBase =
      this.studio.state.selection.length === 1
        ? (this.studio.state.doc.nodes[this.studio.state.selection[0]!]!.rotation ?? 0)
        : 0;
    this.last = p.screen;
    this.original = this.studio.getSelectionBox()?.rect ?? null;
    this.originalBounds = this.studio.getSelectionBounds();
    this.rotation = this.studio.getSelectionBox()?.rotation ?? 0;
    if (p.button === 1 || p.space) {
      this.phase = 'pan';
      return;
    }
    if (p.button !== 0) {
      this.phase = 'idle';
      return;
    }
    if (p.rotate && this.original) {
      if (!this.studio.rotationGestureAllowed()) {
        this.phase = 'idle';
        return;
      }
      const c = center(this.original);
      this.angle = (Math.atan2(p.world.y - c.y, p.world.x - c.x) * 180) / Math.PI;
      this.accumulated = 0;
      this.appliedAngle = 0;
      this.phase = 'pending';
      return;
    }
    if (p.handle) {
      this.phase = 'pending';
      return;
    }
    if (p.hit) {
      if (p.shift) {
        const set = new Set(this.studio.state.selection);
        set.has(p.hit) ? set.delete(p.hit) : set.add(p.hit);
        this.studio.select([...set]);
      } else if (!this.studio.state.selection.includes(p.hit)) this.studio.select([p.hit]);
      this.original = this.studio.getSelectionBox()?.rect ?? null;
      this.originalBounds = this.studio.getSelectionBounds();
      this.rotation = this.studio.getSelectionBox()?.rotation ?? 0;
      this.phase = 'pending';
    } else {
      this.phase = 'idle';
    }
  }
  move(p: InputPoint) {
    if (!this.start || this.phase === 'idle') return;
    this.lastInput = p;
    if (this.phase === 'pan') {
      this.navigation.pan(p.screen.x - this.last.x, p.screen.y - this.last.y);
      this.last = p.screen;
      return;
    }
    if (this.phase === 'pending') {
      if (Math.hypot(p.screen.x - this.start.screen.x, p.screen.y - this.start.screen.y) < 3)
        return;
      this.phase = this.start.rotate ? 'rotate' : this.start.handle ? 'resize' : 'move';
      this.studio.beginGesture(
        this.phase === 'rotate'
          ? '旋转 UI 图层'
          : this.phase === 'resize'
            ? '调整 UI 尺寸'
            : '移动 UI 图层',
        this.phase === 'move',
      );
    }
    const delta = { x: p.world.x - this.start.world.x, y: p.world.y - this.start.world.y };
    if (this.phase === 'rotate' && this.original) {
      const c = center(this.original),
        angle = (Math.atan2(p.world.y - c.y, p.world.x - c.x) * 180) / Math.PI;
      this.accumulated -= normalizeAngle(angle - this.angle);
      this.angle = angle;
      const target = p.shift
        ? Math.round((this.snapBase + this.accumulated) / 15) * 15 - this.snapBase
        : this.accumulated;
      this.appliedAngle = target;
      this.studio.rotateSelection(target, c);
    } else if (this.phase === 'move') {
      this.delta =
        this.originalBounds && this.navigation.snapMove
          ? this.navigation.snapMove(this.originalBounds, delta, p)
          : delta;
      this.drop = p.drop ?? null;
      this.studio.previewMove(this.delta.x, this.delta.y, !!this.navigation.snapMove);
    } else if (this.phase === 'resize' && this.original && this.start.handle) {
      let minWidth = 1,
        minHeight = 1;
      if (this.studio.state.selection.length === 1) {
        const n = this.studio.state.doc.nodes[this.studio.state.selection[0]!]!;
        minWidth = n.layout.minWidth;
        minHeight = n.layout.minHeight;
        if (n.content?.kind === 'nine-slice') {
          minWidth = Math.max(minWidth, n.content.insets[1] + n.content.insets[3] + 1);
          minHeight = Math.max(minHeight, n.content.insets[0] + n.content.insets[2] + 1);
        }
      }
      const target = resizeRect(
        this.original,
        this.start.handle,
        rotateVector(delta, -this.rotation),
        p.shift,
        p.alt,
        minWidth,
        minHeight,
      );
      const oldCenter = center(this.original),
        newCenter = center(target);
      const offset = rotateVector(
        { x: newCenter.x - oldCenter.x, y: newCenter.y - oldCenter.y },
        this.rotation,
      );
      target.x = oldCenter.x + offset.x - target.width / 2;
      target.y = oldCenter.y + offset.y - target.height / 2;
      this.studio.transformSelection(this.original, target, p.shift);
    }
  }

  up() {
    if (this.phase === 'move')
      this.studio.finishMove(this.delta.x, this.delta.y, this.drop, !!this.navigation.snapMove);
    else if (this.phase === 'resize' || this.phase === 'rotate') this.studio.endGesture(true);
    this.reset();
  }
  cancel() {
    if (this.phase === 'move' || this.phase === 'resize' || this.phase === 'rotate')
      this.studio.endGesture(false);
    this.reset();
  }
  private reset() {
    this.phase = 'idle';
    this.navigation.clearSnap?.();
    this.start = null;
    this.lastInput = null;
    this.original = null;
    this.delta = { x: 0, y: 0 };
    this.drop = null;
  }
}
