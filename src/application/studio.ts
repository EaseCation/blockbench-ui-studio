import {
  clone,
  descendants,
  removeNode,
  siblings,
  topSelection,
  validateDocument,
} from '../domain/document';
import { layout } from '../domain/layout';
import { blank, mergePaint, renderPixels } from '../domain/raster';
import { bounds, mapRect } from '../domain/geometry';
import { resizeRule } from '../domain/expression';
import { createDocument, createNode, defaultFrame, fixed } from '../domain/types';
import type { Id, Pixels, Rect, RenderRecipe, UiDocument, UiNode } from '../domain/types';
import type { HostPort, ImagePort, ImportedImage, NativeSnapshot, UiState } from './ports';

export class Studio {
  state: UiState;
  applying = false;
  private listeners = new Set<() => void>();
  private pixelsCache = new Map<string, Pixels>();
  private renderKeys = new Map<Id, string>();
  private native = new Map<Id, NativeSnapshot>();
  private gesture: UiDocument | null = null;
  private gestureLabel = '';
  private disposed = false;
  constructor(
    readonly host: HostPort,
    readonly images: ImagePort,
    doc: UiDocument,
  ) {
    validateDocument(doc);
    this.state = {
      doc,
      scene: layout(doc),
      selection: [],
      interaction: 'figma',
      view: '2d',
      busy: false,
      error: null,
    };
  }
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  private emit() {
    for (const cb of this.listeners) cb();
  }
  report(error: unknown) {
    this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
    this.host.message(this.state.error!);
    this.emit();
  }
  async initialize(reconcile = true) {
    this.state.busy = true;
    this.emit();
    try {
      await Promise.all(
        Object.values(this.state.doc.assets).map(async (a) => {
          this.pixelsCache.set(this.assetKey(a.id, a.revision), await this.images.decode(a.png));
        }),
      );
      if (this.disposed) return;
      if (reconcile) this.reconcile(true);
      this.captureNative();
    } catch (e) {
      this.report(e);
    } finally {
      this.state.busy = false;
      this.emit();
    }
  }
  dispose() {
    this.disposed = true;
    if (this.gesture) this.endGesture(false);
    this.listeners.clear();
  }
  private assetKey(id: Id, revision: number) {
    return `${id}:${revision}`;
  }
  private source(doc: UiDocument, id: Id): Pixels {
    const a = doc.assets[id];
    if (!a) throw new Error('缺少源图');
    const pixels = this.pixelsCache.get(this.assetKey(id, a.revision));
    if (!pixels) throw new Error('源图尚未加载');
    return pixels;
  }
  private putSource(doc: UiDocument, pixels: Pixels, id = this.images.id()): Id {
    const revision = (doc.assets[id]?.revision ?? 0) + 1;
    doc.assets[id] = {
      id,
      width: pixels.width,
      height: pixels.height,
      png: this.images.encode(pixels),
      revision,
    };
    this.pixelsCache.set(this.assetKey(id, revision), pixels);
    return id;
  }
  private calculate(doc: UiDocument) {
    const referenced = new Set(
      Object.values(doc.nodes).flatMap((n) =>
        [n.content?.source, n.originalContent?.source].filter((id): id is string => !!id),
      ),
    );
    for (const id of Object.keys(doc.assets)) if (!referenced.has(id)) delete doc.assets[id];
    validateDocument(doc);
    const scene = layout(doc),
      bitmaps: Record<Id, Pixels> = {},
      keys = new Map<Id, string>();
    for (const id of scene.order) {
      const n = doc.nodes[id]!,
        r = scene.nodes[id]!.rect;
      n.rect = { ...r };
      if (!n.content || n.suspended) continue;
      const asset = doc.assets[n.content.source]!;
      const key = JSON.stringify([n.content, asset.revision, r.width, r.height, n.opacity]);
      keys.set(id, key);
      if (this.renderKeys.get(id) !== key)
        bitmaps[id] = renderPixels(
          this.source(doc, asset.id),
          n.content,
          r.width,
          r.height,
          n.opacity,
        );
    }
    return { scene, bitmaps, keys };
  }
  private publish(
    doc: UiDocument,
    calculated: ReturnType<Studio['calculate']>,
    previous: UiDocument | null,
  ) {
    this.applying = true;
    try {
      this.host.apply(doc, calculated.scene, calculated.bitmaps, previous);
      this.host.write(doc);
      this.renderKeys = calculated.keys;
      const usedKeys = new Set(
        Object.values(doc.assets).map((a) => this.assetKey(a.id, a.revision)),
      );
      for (const key of this.pixelsCache.keys())
        if (!usedKeys.has(key)) this.pixelsCache.delete(key);
      this.state = {
        ...this.state,
        doc,
        scene: calculated.scene,
        error: null,
        selection: this.state.selection.filter((id) => !!doc.nodes[id]),
      };
      this.captureNative();
    } finally {
      this.applying = false;
    }
    this.emit();
  }
  execute(label: string, change: (doc: UiDocument) => void) {
    if (this.state.busy) return false;
    if (this.gesture) this.endGesture(true);
    const previous = this.state.doc,
      doc = clone(previous);
    try {
      change(doc);
      const calculated = this.calculate(doc);
      this.applying = true;
      let started = false;
      try {
        this.host.begin(label);
        started = true;
        this.publish(doc, calculated, previous);
        this.applying = true;
        this.host.commit(label);
      } catch (e) {
        if (started) this.host.cancel();
        this.state.doc = previous;
        this.state.scene = layout(previous);
        this.renderKeys.clear();
        throw e;
      } finally {
        this.applying = false;
      }
      return true;
    } catch (e) {
      this.report(e);
      return false;
    }
  }
  beginGesture(label: string) {
    if (this.state.busy || this.gesture) return;
    this.gesture = clone(this.state.doc);
    this.gestureLabel = label;
    this.applying = true;
    try {
      this.host.begin(label);
    } finally {
      this.applying = false;
    }
  }
  previewGesture(change: (doc: UiDocument) => void) {
    if (!this.gesture) return;
    try {
      const doc = clone(this.gesture);
      change(doc);
      this.publish(doc, this.calculate(doc), this.state.doc);
    } catch (e) {
      this.report(e);
    }
  }
  endGesture(commit = true) {
    if (!this.gesture) return;
    const original = this.gesture;
    this.gesture = null;
    this.applying = true;
    try {
      if (commit) this.host.commit(this.gestureLabel);
      else {
        this.host.cancel();
        this.state = { ...this.state, doc: original, scene: layout(original) };
        this.renderKeys.clear();
      }
    } finally {
      this.applying = false;
      this.captureNative();
      this.emit();
    }
  }
  async reloadFromHistory() {
    const doc = this.host.read();
    if (!doc) return;
    this.renderKeys.clear();
    this.state = { ...this.state, doc: clone(doc), scene: layout(doc) };
    await this.initialize(false);
  }
  private captureNative() {
    this.native = new Map(Object.entries(this.host.snapshots(this.state.doc)));
  }
  select(ids: Id[], add = false) {
    this.state = {
      ...this.state,
      selection: topSelection(
        this.state.doc,
        add ? [...new Set([...this.state.selection, ...ids])] : ids,
      ),
    };
    this.host.select(this.state.doc, this.state.selection);
    this.emit();
  }
  reflectSelection(ids: Id[]) {
    if (JSON.stringify(ids) !== JSON.stringify(this.state.selection)) {
      this.state = { ...this.state, selection: ids };
      this.emit();
    }
  }
  setInteraction(value: UiState['interaction']) {
    this.endGesture(true);
    this.state = { ...this.state, interaction: value };
    this.emit();
  }
  setView(value: UiState['view']) {
    this.endGesture(true);
    this.state = { ...this.state, view: value };
    this.emit();
  }
  add(kind: 'layer' | 'frame' | 'group', parent: Id | null = null) {
    const id = this.images.id();
    this.execute('新增 UI 图层', (doc) => {
      const p = parent ? doc.nodes[parent] : undefined;
      const rect = {
        x: (p?.rect.x ?? 0) + 8,
        y: (p?.rect.y ?? 0) + 8,
        width: kind === 'layer' ? 32 : 160,
        height: kind === 'layer' ? 32 : 90,
      };
      const n = createNode(
        id,
        kind === 'layer' ? '绘画图层' : kind === 'frame' ? 'Frame' : '文件夹',
        kind,
        rect,
      );
      n.parent = parent;
      if (p) {
        n.layout.offset = { x: 8, y: 8 };
        p.children.push(id);
      } else doc.roots.push(id);
      if (kind === 'layer') {
        n.content = {
          kind: 'paint',
          source: this.putSource(doc, blank(32, 32)),
          mode: 'extend',
          origin: { x: 0, y: 0 },
        };
      }
      doc.nodes[id] = n;
    });
    this.select([id]);
    return id;
  }
  update(id: Id, change: (node: UiNode) => void, label = '修改 UI 属性') {
    this.execute(label, (doc) => {
      const n = doc.nodes[id];
      if (n) change(n);
    });
  }
  deleteSelection() {
    const ids = topSelection(this.state.doc, this.state.selection);
    this.execute('删除 UI 图层', (doc) => {
      for (const id of ids) removeNode(doc, id);
    });
    this.select([]);
  }
  duplicate() {
    const selected = topSelection(this.state.doc, this.state.selection),
      copies: Id[] = [];
    this.execute('复制 UI 图层', (doc) => {
      for (const root of selected) {
        const ids = descendants(doc, root),
          map = new Map(ids.map((id) => [id, this.images.id()]));
        for (const old of ids) {
          const n = clone(doc.nodes[old]!);
          n.id = map.get(old)!;
          n.parent = map.get(n.parent ?? '') ?? n.parent;
          n.children = n.children.map((id) => map.get(id)!);
          doc.nodes[n.id] = n;
        }
        const copy = doc.nodes[map.get(root)!]!;
        copy.name += ' 副本';
        copy.layout.offset.x += 8;
        copy.layout.offset.y += 8;
        const list = siblings(doc, doc.nodes[root]!);
        list.splice(list.indexOf(root) + 1, 0, copy.id);
        copies.push(copy.id);
      }
    });
    this.select(copies);
  }
  reorder(id: Id, direction: number) {
    this.execute('调整图层顺序', (doc) => {
      const n = doc.nodes[id];
      if (!n) return;
      const list = siblings(doc, n),
        i = list.indexOf(id),
        j = Math.max(0, Math.min(list.length - 1, i + direction));
      list.splice(i, 1);
      list.splice(j, 0, id);
    });
  }
  reparent(id: Id, parent: Id | null) {
    this.execute('调整图层父级', (doc) => {
      const n = doc.nodes[id];
      if (!n) return;
      if (parent && descendants(doc, id).includes(parent)) throw new Error('不能移动到自己的子层');
      if (parent && doc.nodes[parent]?.kind === 'layer') throw new Error('图片图层不能包含子层');
      const old = siblings(doc, n);
      old.splice(old.indexOf(id), 1);
      n.parent = parent;
      (parent ? doc.nodes[parent]!.children : doc.roots).push(id);
      const p = parent ? doc.nodes[parent]!.rect : { x: 0, y: 0 };
      n.layout.offset = { x: n.rect.x - p.x, y: n.rect.y - p.y };
    });
  }
  changeRects(doc: UiDocument, targets: Record<Id, Rect>) {
    for (const id of topSelection(doc, Object.keys(targets))) {
      const n = doc.nodes[id]!,
        r = targets[id]!,
        old = n.rect;
      if (n.suspended) continue;
      if (
        n.content?.kind === 'paint' &&
        n.content.mode === 'extend' &&
        (old.width !== r.width || old.height !== r.height)
      ) {
        n.content.origin.x += Math.round(r.x - old.x);
        n.content.origin.y += Math.round(r.y - old.y);
      }
      if (r.width !== old.width)
        n.layout.width = resizeRule(n.layout.width, r.width - old.width, r.width);
      if (r.height !== old.height)
        n.layout.height = resizeRule(n.layout.height, r.height - old.height, r.height);
      const p = n.parent ? doc.nodes[n.parent]!.rect : { x: 0, y: 0, width: 0, height: 0 };
      n.layout.offset = {
        x: r.x - p.x - p.width * n.layout.anchorFrom[0] + r.width * n.layout.anchorTo[0],
        y: r.y - p.y - p.height * n.layout.anchorFrom[1] + r.height * n.layout.anchorTo[1],
      };
      n.rect = { ...r };
    }
  }
  transformSelection(original: Rect, target: Rect) {
    const ids = this.state.selection;
    this.previewGesture((doc) => {
      const rects: Record<Id, Rect> = {};
      for (const id of ids) {
        const n = doc.nodes[id];
        if (n) rects[id] = mapRect(n.rect, original, target);
      }
      this.changeRects(doc, rects);
    });
  }
  moveSelection(dx: number, dy: number) {
    const ids = this.state.selection;
    this.previewGesture((doc) => {
      const rects: Record<Id, Rect> = {};
      for (const id of ids) {
        const n = doc.nodes[id];
        if (!n) continue;
        const p = n.parent ? doc.nodes[n.parent] : undefined;
        if (p?.frame?.direction !== 'free' && p?.frame && n.layout.positioning === 'flow') {
          const list = p.children,
            axis = p.frame.direction === 'row' ? 'x' : 'y',
            center =
              n.rect[axis] +
              (axis === 'x' ? n.rect.width : n.rect.height) / 2 +
              (axis === 'x' ? dx : dy);
          list.splice(list.indexOf(id), 1);
          const index = list.findIndex((other) => {
            const c = doc.nodes[other]!;
            return c.rect[axis] + (axis === 'x' ? c.rect.width : c.rect.height) / 2 > center;
          });
          list.splice(index < 0 ? list.length : index, 0, id);
        } else
          rects[id] = { ...n.rect, x: n.rect.x + Math.round(dx), y: n.rect.y + Math.round(dy) };
      }
      this.changeRects(doc, rects);
    });
  }
  async paste(image: ImportedImage, forceNew = false) {
    const pixels = await this.images.decode(image.png);
    if (this.disposed) return;
    const selected =
      this.state.selection.length === 1
        ? this.state.doc.nodes[this.state.selection[0]!]
        : undefined;
    const existing = !forceNew && selected?.kind === 'layer' ? selected.id : null;
    const id = existing ?? this.images.id();
    this.execute('粘贴图片', (doc) => {
      let n = doc.nodes[id];
      if (!n) {
        n = createNode(id, image.name, 'layer', {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });
        const parent =
          selected && selected.kind !== 'layer' ? selected.id : (selected?.parent ?? null);
        n.parent = parent;
        (parent ? doc.nodes[parent]!.children : doc.roots).push(id);
        doc.nodes[id] = n;
      }
      n.content = {
        kind: 'image',
        source: this.putSource(doc, pixels),
        mode: existing ? 'fit' : 'original',
        anchor: [0.5, 0.5],
        scale: 1,
        offset: { x: 0, y: 0 },
        onlyDownscale: false,
      };
      delete n.suspended;
    });
    this.select([id]);
  }
  async importDocument(source: UiDocument, ids: Map<Id, Id>, parent: Id | null) {
    validateDocument(source);
    for (const a of Object.values(source.assets))
      this.pixelsCache.set(this.assetKey(a.id, a.revision), await this.images.decode(a.png));
    if (this.disposed) return;
    this.execute('粘贴 UI 图层', (doc) => {
      for (const a of Object.values(source.assets)) doc.assets[a.id] = clone(a);
      for (const old of Object.values(source.nodes)) {
        const n = clone(old);
        n.id = ids.get(old.id)!;
        n.parent = old.parent ? ids.get(old.parent)! : parent;
        n.children = old.children.map((id) => ids.get(id)!);
        if (!old.parent) {
          n.layout.offset.x += 8;
          n.layout.offset.y += 8;
          (parent ? doc.nodes[parent]!.children : doc.roots).push(n.id);
        }
        doc.nodes[n.id] = n;
      }
    });
    this.select(source.roots.map((id) => ids.get(id)!));
  }
  makeNine(id: Id) {
    this.update(
      id,
      (n) => {
        if (!n.content) return;
        const a = this.state.doc.assets[n.content.source]!;
        const border = Math.max(0, Math.floor(Math.min(a.width, a.height) / 4));
        n.content = {
          kind: 'nine-slice',
          source: n.content.source,
          insets: [border, border, border, border],
          mode: 'stretch',
        };
      },
      '创建九宫格',
    );
  }
  flatten(id: Id) {
    this.execute('转为绘画图层', (doc) => {
      const n = doc.nodes[id];
      if (!n?.content) return;
      const texture = doc.bindings[id]?.textureId,
        pixels = texture ? this.host.pixels(texture) : null;
      if (!pixels) throw new Error('找不到当前贴图');
      if (n.content.kind !== 'paint') n.originalContent = clone(n.content);
      n.content = {
        kind: 'paint',
        source: this.putSource(doc, pixels),
        mode: 'extend',
        origin: { x: 0, y: 0 },
      };
      delete n.suspended;
    });
  }
  restoreSource(id: Id) {
    this.update(
      id,
      (n) => {
        if (n.originalContent) {
          n.content = clone(n.originalContent);
          delete n.originalContent;
          delete n.suspended;
        }
      },
      '恢复原始来源',
    );
  }
  regenerate(id: Id) {
    this.renderKeys.delete(id);
    this.update(
      id,
      (n) => {
        delete n.suspended;
      },
      '按规则重新生成',
    );
  }
  adopt(id: Id) {
    this.execute('采用原生结果', (doc) => {
      const n = doc.nodes[id];
      if (!n) return;
      delete n.suspended;
      n.layout.width = fixed(n.rect.width);
      n.layout.height = fixed(n.rect.height);
      n.layout.positioning = 'absolute';
      this.changeRects(doc, { [id]: { ...n.rect } });
      const texture = doc.bindings[id]?.textureId,
        pixels = texture ? this.host.pixels(texture) : null;
      if (pixels) {
        if (n.content && n.content.kind !== 'paint') n.originalContent = clone(n.content);
        n.content = {
          kind: 'paint',
          source: this.putSource(doc, pixels),
          mode: 'extend',
          origin: { x: 0, y: 0 },
        };
      }
    });
  }
  paint(id: Id) {
    const n = this.state.doc.nodes[id];
    if (!n?.content) return;
    this.host.beginPaint(this.state.doc, id, async (png) => {
      const pixels = await this.images.decode(png);
      if (this.disposed) throw new Error('父项目已关闭，源图仍保留在编辑标签中');
      const applied = this.execute('应用源图绘制', (doc) => {
        const current = doc.nodes[id];
        if (!current?.content) throw new Error('原图层已不存在');
        current.content.source = this.putSource(doc, pixels);
        delete current.suspended;
      });
      if (!applied) throw new Error(this.state.error ?? '源图尚未应用');
    });
  }
  /** Absorb native edits before its post-edit snapshot; on reopen preserve divergent native results. */
  reconcile(onOpen = false) {
    if (this.applying || this.gesture) return;
    const previous = this.state.doc,
      doc = clone(previous),
      snapshots = this.host.snapshots(doc);
    let changed = false;
    for (const snap of this.host.unmanaged(doc)) {
      const n = createNode(snap.id, snap.name, 'layer', snap.rect);
      n.visible = snap.visible;
      n.locked = snap.locked;
      const parent =
        Object.entries(doc.bindings).find(([, b]) => b.elementId === snap.parentId)?.[0] ?? null;
      n.parent = parent;
      n.suspended = '原生新增图层：保留全部原生内容，可采用为 UI 绘画图层';
      const p = parent ? doc.nodes[parent]!.rect : { x: 0, y: 0 };
      n.layout.offset = { x: n.rect.x - p.x, y: n.rect.y - p.y };
      const pixels = snap.textureId ? this.host.pixels(snap.textureId) : null;
      if (pixels)
        n.content = {
          kind: 'paint',
          source: this.putSource(doc, pixels),
          mode: 'extend',
          origin: { x: 0, y: 0 },
        };
      doc.nodes[n.id] = n;
      (parent ? doc.nodes[parent]!.children : doc.roots).push(n.id);
      doc.bindings[n.id] = { elementId: snap.id, textureId: snap.textureId };
      snapshots[n.id] = snap;
      changed = true;
    }
    for (const id of Object.keys(doc.bindings)) {
      const n = doc.nodes[id],
        snap = snapshots[id],
        before = this.native.get(id);
      if (!n) continue;
      if (!snap) {
        removeNode(doc, id);
        changed = true;
        continue;
      }
      const expected = onOpen ? doc.bindings[id]?.fingerprint : before?.fingerprint;
      if (!expected || expected === snap.fingerprint) continue;
      changed = true;
      n.name = snap.name;
      n.visible = snap.visible;
      n.locked = snap.locked;
      if (snap.unsupported) {
        n.suspended = snap.unsupported;
        n.rect = snap.rect;
        continue;
      }
      const painted = before && before.pixelFingerprint !== snap.pixelFingerprint;
      if (onOpen) {
        n.rect = snap.rect;
        n.suspended = '检测到未安装插件时的修改，保留当前结果；可采用结果或重新生成';
        continue;
      }
      if (painted && n.content && snap.textureId) {
        const pixels = this.host.pixels(snap.textureId);
        if (pixels) {
          if (n.content.kind === 'paint') {
            const merged =
              n.content.mode === 'extend'
                ? mergePaint(this.source(doc, n.content.source), pixels, n.content.origin)
                : { pixels, origin: { x: 0, y: 0 } };
            const source = this.putSource(doc, merged.pixels);
            this.host.retainPaintLayers(source, snap.textureId, merged.origin);
            n.content = { ...n.content, source, origin: merged.origin };
          } else n.suspended = '成品贴图已被手工修改，自动生成已暂停';
        }
      }
      const parent = n.parent ? doc.nodes[n.parent] : undefined;
      const moved = n.rect.x !== snap.rect.x || n.rect.y !== snap.rect.y;
      if (
        moved &&
        n.layout.positioning === 'flow' &&
        parent?.frame &&
        parent.frame.direction !== 'free'
      ) {
        n.rect = snap.rect;
        n.suspended = '自动布局中的元素被原生工具移动，已保留位置并暂停规则';
      } else if (!n.suspended && JSON.stringify(n.rect) !== JSON.stringify(snap.rect)) {
        this.changeRects(doc, { [id]: snap.rect });
      }
      if (before && snap.depth !== before.depth) {
        const list = siblings(doc, n);
        list.sort(
          (a, b) =>
            (snapshots[a]?.depth ?? doc.nodes[a]!.rect.y) -
            (snapshots[b]?.depth ?? doc.nodes[b]!.rect.y),
        );
      }
    }
    if (!changed) return;
    try {
      if (onOpen) {
        this.state = { ...this.state, doc, scene: layout(doc) };
        this.host.write(doc);
        this.emit();
      } else this.publish(doc, this.calculate(doc), previous);
    } catch (e) {
      this.report(e);
    }
  }
  getSelectionBounds() {
    return bounds(
      this.state.selection
        .map((id) => this.state.scene.nodes[id]?.rect)
        .filter((r): r is Rect => !!r),
    );
  }
  static fresh(host: HostPort, images: ImagePort): Studio {
    return new Studio(host, images, createDocument(images.id()));
  }
}
