import {
  copyStyle,
  parseStyle,
  STYLE_PREFIX,
  type StyleClipboard,
} from '../../application/clipboard';
import { contentProviders } from '../../application/content';
import type { Studio } from '../../application/studio';
import { clone, descendants, topSelection } from '../../domain/document';
import type { UiDocument } from '../../domain/types';
import { blobPixels, imagePort } from '../../platform/browser/images';
import type { HostRuntime } from './runtime';

/** One clipboard owner for native paste events, shortcuts and menu commands. */
export class StudioClipboard {
  private nodes: UiDocument | null = null;
  private properties: StyleClipboard | null = null;
  private write: Promise<void> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private selectionKey = '';
  constructor(
    private bb: HostRuntime,
    private current: () => Studio | null,
    private ready: () => boolean = () => true,
  ) {}
  cancelPending() {
    ++this.generation;
  }
  selectionChanged() {
    const next = JSON.stringify([this.bb.Project?.uuid, this.current()?.state.selection]);
    if (next !== this.selectionKey) {
      this.selectionKey = next;
      this.cancelPending();
    }
  }
  private capture() {
    this.selectionChanged();
    const app = this.current();
    return app && !this.disposed
      ? {
          app,
          doc: app.state.doc,
          selection: [...app.state.selection],
          project: this.bb.Project,
          generation: ++this.generation,
        }
      : null;
  }
  private valid(c: NonNullable<ReturnType<StudioClipboard['capture']>>) {
    return (
      !this.disposed &&
      this.ready() &&
      c.generation === this.generation &&
      this.current() === c.app &&
      this.bb.Project === c.project &&
      this.bb.Modes.edit &&
      !this.bb.Dialog.open &&
      !this.bb.open_interface &&
      c.app.state.doc === c.doc &&
      JSON.stringify(c.selection) === JSON.stringify(c.app.state.selection)
    );
  }
  private error(c: ReturnType<StudioClipboard['capture']>, error: unknown) {
    if (c && !this.disposed && c.generation === this.generation && this.current() === c.app)
      c.app.report(error);
  }
  private publish(text: string, fallback: string) {
    this.write = this.write
      .then(() => {
        if (!this.disposed) return navigator.clipboard.writeText(text);
      })
      .catch(() => {
        if (!this.disposed) this.bb.Blockbench.showQuickMessage(fallback, 3500);
      });
  }
  copyNodes() {
    const app = this.current();
    if (!app) return;
    ++this.generation;
    const doc = clone(app.state.doc),
      roots = topSelection(doc, app.state.selection),
      keep = new Set(roots.flatMap((id) => descendants(doc, id)));
    doc.roots = roots;
    for (const id of Object.keys(doc.nodes)) if (!keep.has(id)) delete doc.nodes[id];
    for (const id of roots) doc.nodes[id]!.parent = null;
    doc.bindings = {};
    doc.contentResources = Object.fromEntries(
      [...contentProviders].map(([id, p]) => [id, p.resources?.()]),
    );
    this.nodes = doc;
    this.publish('MCUI:' + JSON.stringify(doc), '图层已复制到插件内部，可使用“粘贴内部 UI 图层”');
  }
  hasNodes() {
    return !!this.nodes;
  }
  private async insertNodes(
    source: UiDocument,
    c: NonNullable<ReturnType<StudioClipboard['capture']>>,
  ) {
    const ids = new Map(Object.keys(source.nodes).map((id) => [id, imagePort.id()]));
    await Promise.all(Object.values(source.assets).map((a) => imagePort.decode(a.png)));
    if (this.valid(c))
      await c.app.importDocument(source, ids, c.selection.length === 1 ? c.selection[0]! : null);
  }
  async pasteCachedNodes() {
    const c = this.capture();
    if (!c || !this.nodes) return;
    try {
      await this.insertNodes(this.nodes, c);
    } catch (e) {
      this.error(c, e);
    }
  }
  canCopyProperties() {
    const app = this.current(),
      ids = app?.state.selection ?? [];
    return (
      ids.length === 1 &&
      app?.state.doc.nodes[ids[0]!]?.kind === 'image' &&
      !app.state.doc.nodes[ids[0]!]!.suspended
    );
  }
  canPasteProperties() {
    const app = this.current();
    const nodes =
      app?.state.selection
        .map((id) => app.state.doc.nodes[id]!)
        .filter((n) => n?.kind === 'image') ?? [];
    return (
      !!nodes.length && nodes.every((n) => !n.suspended && !app!.state.scene.nodes[n.id]?.locked)
    );
  }
  copyProperties() {
    const app = this.current();
    if (!app || !this.canCopyProperties()) return;
    try {
      ++this.generation;
      this.properties = copyStyle(app.state.doc, app.state.selection[0]!);
      this.publish(
        STYLE_PREFIX + JSON.stringify(this.properties),
        '属性已复制到当前窗口；系统剪贴板写入不可用',
      );
      this.bb.Blockbench.showQuickMessage('已复制属性：填充、描边和透明度', 1500);
    } catch (e) {
      app.report(e);
    }
  }
  private async applyProperties(
    packet: StyleClipboard,
    c: NonNullable<ReturnType<StudioClipboard['capture']>>,
  ) {
    const pixels = packet.fill ? await imagePort.decode(packet.fill.png) : undefined;
    if (pixels && (pixels.width !== packet.fill!.width || pixels.height !== packet.fill!.height))
      throw new Error('剪贴板填充尺寸与图片不一致');
    if (this.valid(c) && c.app.pasteProperties(packet, pixels, c.selection)) {
      const skipped = c.selection.some((id) => c.app.state.doc.nodes[id]?.kind === 'frame');
      const text =
        !!packet.fill &&
        c.selection.some((id) => c.app.state.doc.nodes[id]?.content?.kind === 'generated');
      this.bb.Blockbench.showQuickMessage(
        skipped
          ? '已粘贴 Image 属性；Frame 不承载外观，保持不变'
          : text
            ? '已粘贴外观属性；文字内容及排版保持不变'
            : '已粘贴属性',
        1800,
      );
    }
  }
  async pasteProperties() {
    const c = this.capture();
    if (!c) return;
    try {
      await this.write;
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        if (!this.properties) throw new Error('无法读取属性剪贴板，请先在此窗口复制属性');
        await this.applyProperties(this.properties, c);
        return;
      }
      const packet = parseStyle(text);
      if (!packet) throw new Error('剪贴板中没有 UI 样式属性，请先使用“复制属性”');
      await this.applyProperties(packet, c);
    } catch (e) {
      this.error(c, e);
    }
  }
  async paste(forceNew = false, event?: ClipboardEvent) {
    const c = this.capture();
    if (!c) return;
    try {
      const blobs: Blob[] = [];
      let text = '';
      if (event?.clipboardData) {
        const data = event.clipboardData;
        for (const item of Array.from(data.items))
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) blobs.push(file);
          }
        if (!blobs.length)
          blobs.push(...Array.from(data.files).filter((f) => f.type.startsWith('image/')));
        text = data.getData('text/plain');
      } else {
        await this.write;
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.includes('image/png')
            ? 'image/png'
            : item.types.find((t) => t.startsWith('image/'));
          if (type) blobs.push(await item.getType(type));
          else if (item.types.includes('text/plain'))
            text = await (await item.getType('text/plain')).text();
        }
      }
      if (blobs.length) {
        const images = await Promise.all(blobs.map(blobPixels));
        if (this.valid(c)) c.app.pasteImages(images, { forceNew, selection: c.selection });
      } else if (text.startsWith('MCUI:')) await this.insertNodes(JSON.parse(text.slice(5)), c);
      else if (!forceNew && text.startsWith(STYLE_PREFIX)) {
        const packet = parseStyle(text)!;
        await this.applyProperties(packet, c);
      } else throw new Error('剪贴板不包含图片或 UI 图层，可使用“导入图片”');
    } catch (e) {
      this.error(c, e);
    }
  }
  async pasteFiles(files: Blob[], forceNew = false) {
    const c = this.capture();
    if (!c) return;
    try {
      const images = await Promise.all(files.map(blobPixels));
      if (this.valid(c)) c.app.pasteImages(images, { forceNew, selection: c.selection });
    } catch (e) {
      this.error(c, e);
    }
  }
  importImages() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.multiple = true;
    const app = this.current();
    input.onchange = () => {
      if (app === this.current()) void this.pasteFiles(Array.from(input.files ?? []));
    };
    input.click();
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
    this.nodes = null;
    this.properties = null;
  }
}
