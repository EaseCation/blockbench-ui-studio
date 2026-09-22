/** All untyped upstream objects are quarantined here and in this adapter directory.
 * Contract target: Blockbench 5.2.1 / e2ede080. No host types cross application ports.
 */
export type HostObject = any;
export interface HostRuntime {
  Blockbench: HostObject;
  Project: HostObject;
  ModelProject: HostObject;
  ModelLoader: HostObject;
  Cube: HostObject;
  Group: HostObject;
  Texture: HostObject;
  TextureLayer: HostObject;
  TextureLayerGroup: HostObject;
  Outliner: HostObject;
  OutlinerNode: HostObject;
  Canvas: HostObject;
  Undo: HostObject;
  Preview: HostObject;
  THREE: HostObject;
  Modes: HostObject;
  Codecs: HostObject;
  Formats: HostObject;
  Panel: HostObject;
  Action: HostObject;
  Tool: HostObject;
  Keybind: HostObject;
  MenuBar: HostObject;
  Toolbox: HostObject;
  BarItems: HostObject;
  SharedActions: HostObject;
  PointerTarget: HostObject;
  DefaultCameraPresets: HostObject;
  Plugins: HostObject;
  Prop: HostObject;
  newProject: HostObject;
  updateSelection: HostObject;
  updateInterface: HostObject;
  unselectAllElements: HostObject;
  guid: HostObject;
  Property: HostObject;
  FormElement: HostObject;
  InputForm: HostObject;
  Interface: HostObject;
  Toolbars: HostObject;
  BarSelect: HostObject;
  Dialog: HostObject;
  BARS: HostObject;
}
export const hostRuntime = (): HostRuntime => window as unknown as HostRuntime;
export function capabilities(bb: HostRuntime): string[] {
  const missing: string[] = [];
  for (const name of [
    'Cube',
    'Group',
    'Texture',
    'Preview',
    'Codecs',
    'Panel',
    'Tool',
    'SharedActions',
    'ModelLoader',
    'Property',
    'FormElement',
    'Toolbars',
  ] as const)
    if (!bb[name]) missing.push(name);
  // Undo is a project-dependent getter and is intentionally undefined on the welcome screen.
  if (!('Undo' in bb)) missing.push('Undo');
  if (!bb.ModelProject?.properties?.unhandled_root_fields) missing.push('native metadata carrier');
  if (!bb.Blockbench?.on) missing.push('lifecycle events');
  return missing;
}
export class Disposables {
  private disposers: (() => void)[] = [];
  add(dispose: (() => void) | { delete(): void }) {
    this.disposers.push(typeof dispose === 'function' ? dispose : () => dispose.delete());
    return dispose;
  }
  listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ) {
    target.addEventListener(type, listener, options);
    this.add(() => target.removeEventListener(type, listener, options));
  }
  dispose() {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (e) {
        console.error('[MCUI cleanup]', e);
      }
    }
  }
}
export function hashString(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
