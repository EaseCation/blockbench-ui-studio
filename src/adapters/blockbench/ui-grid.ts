import type { HostObject, HostRuntime } from './runtime';

/** Move only native grid helpers to unused camera layers; never change user settings. */
export class UiGrid {
  private objects = new Map<HostObject, number>();
  private cameras = new Map<HostObject, number>();
  private bits = new Map<number, number>();
  private gizmos = new Map<HTMLElement, string>();
  constructor(private bb: HostRuntime) {
    let used = 0;
    bb.scene.traverse((object: HostObject) => {
      used |= object.layers.mask;
    });
    for (let bit = 0, spare = 30; bit < 4; bit++) {
      while (spare > 3 && used & (1 << spare)) spare--;
      if (spare <= 3) throw new Error('没有可用于 UI 网格的相机图层');
      this.bits.set(bit, spare--);
    }
  }
  update(enabled: boolean) {
    if (!enabled) {
      this.restore();
      return;
    }
    const remap = (object: HostObject) => {
      if (!this.objects.has(object)) this.objects.set(object, object.layers.mask);
      const original = this.objects.get(object)!;
      let mask = original & ~15;
      for (const [from, to] of this.bits) if (original & (1 << from)) mask |= 1 << to;
      object.layers.mask = mask;
    };
    this.bb.three_grid.traverse(remap);
    this.bb.Canvas.pivot_marker?.traverse(remap);
    for (const preview of this.bb.Preview.all) {
      const camera = preview.camera;
      if (!this.cameras.has(camera)) this.cameras.set(camera, camera.layers.mask);
      // Host may update low camera bits when a user changes the locked angle.
      let mask = camera.layers.mask;
      for (const to of this.bits.values()) mask &= ~(1 << to);
      const top = preview.isOrtho && preview.angle === 'top';
      const gizmo = preview.orbit_gizmo?.node as HTMLElement | undefined;
      if (gizmo) {
        if (!this.gizmos.has(gizmo)) this.gizmos.set(gizmo, gizmo.style.display);
        gizmo.style.display = top ? 'none' : this.gizmos.get(gizmo)!;
      }
      if (!top) for (const [from, to] of this.bits) if (mask & (1 << from)) mask |= 1 << to;
      camera.layers.mask = mask;
    }
  }
  restore() {
    for (const [object, mask] of this.objects) object.layers.mask = mask;
    for (const camera of this.cameras.keys())
      for (const to of this.bits.values()) camera.layers.mask &= ~(1 << to);
    for (const [node, display] of this.gizmos) node.style.display = display;
    this.gizmos.clear();
    this.objects.clear();
    this.cameras.clear();
  }
}
