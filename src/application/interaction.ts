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
  drop?: DropIntent | null;
}
export interface NavigationPort {
  pan(dx: number, dy: number): void;
}
export class InteractionMachine {
  phase: 'idle' | 'pending' | 'move' | 'resize' | 'pan' = 'idle';
  private start: InputPoint | null = null;
  private last: Point = { x: 0, y: 0 };
  private original: Rect | null = null;
  private delta = { x: 0, y: 0 };
  private drop: DropIntent | null = null;
  constructor(
    readonly studio: Studio,
    readonly navigation: NavigationPort,
  ) {}
  down(p: InputPoint) {
    this.start = p;
    this.last = p.screen;
    this.original = this.studio.getSelectionBounds();
    if (p.button === 1 || p.space) {
      this.phase = 'pan';
      return;
    }
    if (p.button !== 0) {
      this.phase = 'idle';
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
      this.original = this.studio.getSelectionBounds();
      this.phase = 'pending';
    } else {
      this.phase = 'idle';
    }
  }
  move(p: InputPoint) {
    if (!this.start || this.phase === 'idle') return;
    if (this.phase === 'pan') {
      this.navigation.pan(p.screen.x - this.last.x, p.screen.y - this.last.y);
      this.last = p.screen;
      return;
    }
    if (this.phase === 'pending') {
      if (Math.hypot(p.screen.x - this.start.screen.x, p.screen.y - this.start.screen.y) < 3)
        return;
      this.phase = this.start.handle ? 'resize' : 'move';
      this.studio.beginGesture(
        this.phase === 'resize' ? '调整 UI 尺寸' : '移动 UI 图层',
        this.phase === 'move',
      );
    }
    const delta = { x: p.world.x - this.start.world.x, y: p.world.y - this.start.world.y };
    if (this.phase === 'move') {
      this.delta = delta;
      this.drop = p.drop ?? null;
      this.studio.previewMove(delta.x, delta.y);
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
        delta,
        p.shift,
        p.alt,
        minWidth,
        minHeight,
      );
      this.studio.transformSelection(this.original, target, p.shift);
    }
  }

  up() {
    if (this.phase === 'move') this.studio.finishMove(this.delta.x, this.delta.y, this.drop);
    else if (this.phase === 'resize') this.studio.endGesture(true);
    this.reset();
  }
  cancel() {
    if (this.phase === 'move' || this.phase === 'resize') this.studio.endGesture(false);
    this.reset();
  }
  private reset() {
    this.phase = 'idle';
    this.start = null;
    this.original = null;
    this.delta = { x: 0, y: 0 };
    this.drop = null;
  }
}
