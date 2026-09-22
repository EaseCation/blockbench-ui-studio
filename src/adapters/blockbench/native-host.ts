import type { HostPort, NativeSnapshot, NativeSceneSnapshot } from '../../application/ports';
import { clone, validateDocument, topSelection } from '../../domain/document';
import type { Id, Pixels, ResolvedScene, UiDocument } from '../../domain/types';
import type { HostObject, HostRuntime } from './runtime';
import { hashString } from './runtime';
import { imagePort } from '../../platform/browser/images';
import { renderPixels } from '../../domain/raster';
import { SOURCE_MARKER } from './native-fields';
export const METADATA_KEY = 'mcui_studio';
interface Carrier {
  schemaVersion: 1;
  document: UiDocument;
  nativeSources: Record<string, unknown>;
}
export class NativeHost implements HostPort {
  private sources: Record<string, unknown> = {};
  private sourceLayers = new Map<string, { state: HostObject; pixels: Pixels | null }[]>();
  private pendingSource: { id: Id; snapshot: unknown } | null = null;
  onBeforeViewUpdate: ((doc: UiDocument) => void) | null = null;
  onSourceSession: ((close: () => Promise<void>, cancel: () => void) => void) | null = null;
  constructor(
    readonly bb: HostRuntime,
    readonly project: HostObject,
  ) {}
  active() {
    return this.bb.Project === this.project;
  }
  read(): UiDocument | null {
    const data = this.project.unhandled_root_fields?.[METADATA_KEY] as Carrier | undefined;
    if (!data) return null;
    if (data.schemaVersion !== 1) throw new Error('插件数据版本较新，保留原生内容并暂停增强编辑');
    this.sources = clone(data.nativeSources ?? {});
    return clone(validateDocument(data.document));
  }
  async prepareSources() {
    for (const [id, value] of Object.entries(this.sources)) {
      if (this.sourceLayers.has(id)) continue;
      const data = value as HostObject,
        origin = data.mcui_source_origin ?? [0, 0];
      const layers = [];
      for (const layer of data.layers ?? [])
        layers.push({
          state: {
            ...layer,
            offset: [(layer.offset?.[0] ?? 0) + origin[0], (layer.offset?.[1] ?? 0) + origin[1]],
          },
          pixels:
            layer.type === 'pixel_layer' && layer.data_url
              ? await imagePort.decode(layer.data_url)
              : null,
        });
      this.sourceLayers.set(id, layers);
    }
  }
  write(doc: UiDocument) {
    if (this.pendingSource) {
      const source = doc.nodes[this.pendingSource.id]?.content?.source;
      if (source) this.sources[source] = this.pendingSource.snapshot;
    }
    this.project.unhandled_root_fields ??= {};
    const retainedSources = Object.fromEntries(
      Object.entries(this.sources).filter(([id]) => !!doc.assets[id]),
    );
    this.project.unhandled_root_fields[METADATA_KEY] = {
      schemaVersion: 1,
      document: clone(doc),
      nativeSources: clone(retainedSources),
    } satisfies Carrier;
  }
  metadata() {
    return clone(this.project.unhandled_root_fields?.[METADATA_KEY] ?? null);
  }
  restoreMetadata(value: unknown) {
    this.project.unhandled_root_fields ??= {};
    if (value) this.project.unhandled_root_fields[METADATA_KEY] = clone(value);
    else delete this.project.unhandled_root_fields[METADATA_KEY];
  }
  message(text: string) {
    this.bb.Blockbench.showQuickMessage(text, 4500);
  }
  private all() {
    return {
      elements: [...this.project.elements],
      groups: [...this.project.groups],
      textures: [...this.project.textures],
      outliner: true,
      bitmap: true,
      selection: true,
    };
  }
  begin(_label: string) {
    if (!this.active()) throw new Error('项目已切换');
    this.bb.Undo.initEdit(this.all());
  }
  commit(label: string) {
    this.bb.Undo.finishEdit(label, this.all());
  }
  cancel() {
    this.bb.Undo.cancelEdit(true);
  }
  expandNativeUndo(event: HostObject) {
    const save = this.bb.Undo.current_save;
    if (!save) return;
    save.addElements(this.project.elements);
    save.groups ??= this.project.groups.map((g: HostObject) => g.getChildlessCopy(true));
    save.outliner ??= this.bb.Outliner.toJSON();
    save.textures ??= {};
    for (const texture of this.project.textures)
      if (!save.textures[texture.uuid]) save.textures[texture.uuid] = texture.getUndoCopy(true);
    // Selection must be requested before Undo.initEdit creates its selection snapshot.
    // Adding it here would reuse an unrelated previous selection snapshot in the host.
    const { selection: _selection, ...aspects } = this.all();
    Object.assign(event.aspects, aspects);
  }
  private element(id: string) {
    return (
      this.project.elements.find((e: HostObject) => e.uuid === id) ??
      this.project.groups.find((e: HostObject) => e.uuid === id)
    );
  }
  private texture(id: string) {
    return this.project.textures.find((t: HostObject) => t.uuid === id);
  }
  private pixelFingerprint(texture: HostObject): string {
    return texture ? hashString(texture.getDataURL()) : '';
  }
  scene(doc: UiDocument): NativeSceneSnapshot {
    const scene: NativeSceneSnapshot = { nodes: {}, roots: [], selection: [] };
    const ids = new Map(Object.entries(doc.bindings).map(([id, b]) => [b.elementId, id]));
    const accepted = (e: HostObject) => e instanceof this.bb.Cube || e instanceof this.bb.Group;
    const walk = (items: HostObject[], parentId?: string): string[] => {
      const order: string[] = [];
      for (const e of items.filter(accepted)) {
        const id = ids.get(e.uuid) ?? e.uuid,
          n = doc.nodes[id] ?? doc.nodes[e[SOURCE_MARKER]],
          binding = doc.bindings[id] ?? doc.bindings[e[SOURCE_MARKER]];
        const isCube = e instanceof this.bb.Cube;
        const t = isCube ? e.faces.up.getTexture() : undefined;
        const oldOrigin = binding?.groupOrigin ?? e.origin ?? [0, 0, 0];
        const rect = isCube
          ? { x: e.from[0], y: e.from[2], width: e.to[0] - e.from[0], height: e.to[2] - e.from[2] }
          : {
              x: (n?.rect.x ?? 0) + (e.origin[0] - oldOrigin[0]),
              y: (n?.rect.y ?? 0) + (e.origin[2] - oldOrigin[2]),
              width: n?.rect.width ?? 1,
              height: n?.rect.height ?? 1,
            };
        let ancestor = e,
          unsupported: string | undefined;
        while (ancestor && ancestor !== 'root') {
          if (ancestor.rotation?.some((v: number) => Math.abs(v) > 1e-6))
            unsupported = '检测到三维旋转，二维规则已暂停';
          ancestor = ancestor.parent;
        }
        if (isCube && doc.bindings[id] && Math.abs(e.to[1] - e.from[1] - 0.1) > 1e-5)
          unsupported = 'Cube 厚度已改变，二维规则已暂停';
        if (isCube && (rect.width <= 0 || rect.height <= 0))
          unsupported = 'Cube 尺寸不适合二维布局';
        const pixelFingerprint = this.pixelFingerprint(t);
        const fingerprint = hashString(
          JSON.stringify([
            rect,
            e.name,
            e.visibility !== false,
            e.locked === true,
            isCube ? e.to[1] : 0,
            t?.uuid,
            pixelFingerprint,
            isCube ? e.faces.up.uv : null,
            e.rotation,
            e.parent?.uuid ?? null,
          ]),
        );
        scene.nodes[id] = {
          id,
          elementId: e.uuid,
          kind: isCube ? 'layer' : 'group',
          sourceId: e[SOURCE_MARKER] || undefined,
          rect,
          depth: isCube ? e.to[1] : 0,
          name: e.name,
          visible: e.visibility !== false,
          locked: e.locked === true,
          fingerprint,
          pixelFingerprint,
          textureId: t?.uuid,
          unsupported,
          parentId,
          siblingIndex: order.length,
          children: [],
        };
        order.push(id);
        if (isCube ? e.selected : this.project.selected_groups?.includes(e))
          scene.selection.push(id);
        if (!isCube) scene.nodes[id]!.children = walk(e.children, id);
      }
      return order;
    };
    scene.roots = walk(this.project.outliner);
    return scene;
  }
  snapshots(doc: UiDocument): Record<Id, NativeSnapshot> {
    const nodes = this.scene(doc).nodes;
    return Object.fromEntries(Object.entries(nodes).filter(([id]) => !!doc.bindings[id]));
  }
  unmanaged(doc: UiDocument): NativeSnapshot[] {
    return Object.values(this.scene(doc).nodes).filter((n) => !doc.bindings[n.id]);
  }
  pixels(textureId: string): Pixels | null {
    const t = this.texture(textureId);
    if (!t) return null;
    return {
      width: t.canvas.width,
      height: t.canvas.height,
      data: t.ctx.getImageData(0, 0, t.canvas.width, t.canvas.height).data,
    };
  }
  retainPaintLayers(source: Id, textureId: string, origin = { x: 0, y: 0 }) {
    const t = this.texture(textureId);
    if (!t?.layers_enabled) return;
    const state = t.getSaveCopy(true);
    state.mcui_source_origin = [origin.x, origin.y];
    this.sources[source] = state;
    this.sourceLayers.set(
      source,
      t.layers.map((layer: HostObject) => ({
        state: {
          ...layer.getUndoCopy(true),
          offset: [(layer.offset?.[0] ?? 0) + origin.x, (layer.offset?.[1] ?? 0) + origin.y],
        },
        pixels:
          layer.type === 'pixel_layer'
            ? {
                width: layer.width,
                height: layer.height,
                data: layer.ctx.getImageData(0, 0, layer.width, layer.height).data,
              }
            : null,
      })),
    );
  }
  private applyPaintLayers(doc: UiDocument, id: Id, texture: HostObject): boolean {
    const content = doc.nodes[id]?.content;
    if (content?.kind !== 'paint') return false;
    if (!this.sourceLayers.has(content.source) && texture.layers_enabled)
      this.retainPaintLayers(content.source, texture.uuid, content.origin);
    const layers = this.sourceLayers.get(content.source);
    if (!layers?.length) return false;
    const source = doc.assets[content.source]!,
      rect = doc.nodes[id]!.rect;
    const sx = content.mode === 'scale' ? rect.width / source.width : 1,
      sy = content.mode === 'scale' ? rect.height / source.height : 1;
    const old = texture.layers ?? [],
      selected = Math.max(0, old.indexOf(texture.selected_layer));
    const uuidMap = new Map<string, string>();
    const copies = layers.map(({ state, pixels }, i) => {
      const uuid = old[i]?.uuid ?? this.bb.guid();
      if (state.uuid) uuidMap.set(state.uuid, uuid);
      const data = { ...state };
      delete data.data_url;
      delete data.image_data;
      delete data.texture;
      delete data.uuid;
      data.offset = [
        Math.round((state.offset?.[0] ?? 0) * sx) -
          (content.mode === 'extend' ? content.origin.x : 0),
        Math.round((state.offset?.[1] ?? 0) * sy) -
          (content.mode === 'extend' ? content.origin.y : 0),
      ];
      data.scale = [1, 1];
      if (pixels) {
        const output = renderPixels(
          pixels,
          {
            kind: 'image',
            source: 'native-layer',
            mode: 'stretch',
            anchor: [0, 0],
            scale: 1,
            offset: { x: 0, y: 0 },
            onlyDownscale: false,
          },
          Math.max(1, Math.round(pixels.width * (state.scale?.[0] ?? 1) * sx)),
          Math.max(1, Math.round(pixels.height * (state.scale?.[1] ?? 1) * sy)),
        );
        const image = texture.ctx.createImageData(output.width, output.height);
        image.data.set(output.data);
        data.image_data = image;
        data.width = output.width;
        data.height = output.height;
        if (old[i]?.type === 'pixel_layer') {
          old[i].extend(data);
          return old[i];
        }
        return new this.bb.TextureLayer(data, texture, uuid);
      }
      if (old[i]?.type === 'layer_group') {
        old[i].extend(data);
        return old[i];
      }
      return new this.bb.TextureLayerGroup(data, texture, uuid);
    });
    for (const layer of copies)
      if (uuidMap.has(layer.parent_uuid)) layer.parent_uuid = uuidMap.get(layer.parent_uuid);
    texture.layers.splice(0, texture.layers.length, ...copies);
    texture.layers_enabled = true;
    texture.selected_layer = copies[selected] ?? copies[0];
    return true;
  }
  apply(
    doc: UiDocument,
    scene: ResolvedScene,
    bitmaps: Record<Id, Pixels>,
    previous: UiDocument | null,
  ) {
    if (!this.active()) throw new Error('项目已切换');
    const changedElements: HostObject[] = [];
    const changedGroups: HostObject[] = [];
    if (previous)
      for (const [id, binding] of Object.entries(previous.bindings)) {
        if (doc.nodes[id]) continue;
        const e = this.element(binding.elementId);
        if (e) e.remove();
        if (
          binding.textureId &&
          !Object.values(doc.bindings).some((b) => b.textureId === binding.textureId)
        ) {
          const t = this.texture(binding.textureId);
          if (t) t.remove(true);
        }
      }
    for (const id of scene.order) {
      const n = doc.nodes[id]!,
        resolved = scene.nodes[id]!;
      let binding = doc.bindings[id],
        element = binding ? this.element(binding.elementId) : undefined;
      const created = !element;
      const parent = n.parent ? this.element(doc.bindings[n.parent]?.elementId ?? '') : 'root';
      if (!element) {
        element =
          n.kind === 'layer'
            ? new this.bb.Cube({ name: n.name, box_uv: false, autouv: 0, shade: false }, id)
            : new this.bb.Group({ name: n.name, origin: [0, 0, 0] }, id);
        element.addTo(parent ?? 'root').init();
        binding = doc.bindings[id] = { elementId: element.uuid };
      }
      if (!binding) continue;
      if (n.suspended) continue;
      const old = previous?.nodes[id];
      const siblings = n.parent ? doc.nodes[n.parent]!.children : doc.roots;
      const oldSiblings = n.parent ? previous?.nodes[n.parent]?.children : previous?.roots;
      const reordered = JSON.stringify(siblings) !== JSON.stringify(oldSiblings);
      const changed =
        created ||
        !!bitmaps[id] ||
        !old ||
        JSON.stringify(old.rect) !== JSON.stringify(n.rect) ||
        old.name !== n.name ||
        old.visible !== n.visible ||
        old.locked !== n.locked ||
        old.parent !== n.parent ||
        reordered ||
        (n.kind === 'layer' && Math.abs(element.to[1] - resolved.depth) > 1e-6);
      if (!changed) continue;
      element.name = n.name;
      element.visibility = n.visible;
      element.locked = n.locked;
      if (created || old?.parent !== n.parent || reordered) element.addTo(parent ?? 'root');
      element[SOURCE_MARKER] = id;
      if (n.kind !== 'layer') {
        binding.groupOrigin = [...element.origin] as [number, number, number];
        changedGroups.push(element);
        continue;
      }
      changedElements.push(element);
      const r = resolved.rect,
        depth = resolved.depth;
      element.extend({
        from: [r.x, depth - 0.1, r.y],
        to: [r.x + r.width, depth, r.y + r.height],
        rotation: [0, 0, 0],
        box_uv: false,
        autouv: 0,
        shade: false,
      });
      let texture = binding.textureId ? this.texture(binding.textureId) : undefined;
      if (!texture) {
        texture = new this.bb.Texture({ name: `${n.name}.png`, internal: true });
        texture.add(false);
        binding.textureId = texture.uuid;
      }
      const pixels = bitmaps[id];
      if (pixels) {
        // Rebuild editable native layers from retained originals. Do not leave layer.scale != 1:
        // upstream brushes operate in canvas pixel coordinates, not transformed layer coordinates.
        if (!this.applyPaintLayers(doc, id, texture)) {
          texture.layers_enabled = false;
          texture.layers = [];
          texture.selected_layer = null;
          texture.canvas.width = pixels.width;
          texture.canvas.height = pixels.height;
          const data = texture.ctx.createImageData(pixels.width, pixels.height);
          data.data.set(pixels.data);
          texture.ctx.putImageData(data, 0, 0);
        }
        texture.width = pixels.width;
        texture.height = pixels.height;
        texture.uv_width = pixels.width;
        texture.uv_height = pixels.height;
        texture.internal = true;
        texture.path = '';
        texture.relative_path = '';
        texture.keep_size = true;
        texture.updateChangesAfterEdit();
      }
      for (const face of Object.keys(element.faces))
        element.faces[face].texture = face === 'up' ? texture.uuid : null;
      element.faces.up.uv = [0, 0, texture.uv_width, texture.uv_height];
    }
    this.onBeforeViewUpdate?.(doc);
    this.bb.Canvas.updateView({
      elements: changedElements,
      groups: changedGroups,
      element_aspects: { transform: true, geometry: true, faces: true, uv: true, visibility: true },
      group_aspects: { transform: true, visibility: true },
      selection: true,
    });
    this.bb.updateSelection();
    for (const [id, snap] of Object.entries(this.snapshots(doc)))
      if (doc.bindings[id]) doc.bindings[id]!.fingerprint = snap.fingerprint;
  }
  select(doc: UiDocument, ids: Id[]) {
    if (!this.active()) return;
    const selected = topSelection(doc, this.scene(doc).selection);
    if (JSON.stringify([...selected].sort()) === JSON.stringify([...ids].sort())) return;
    this.bb.Undo.initSelection();
    this.bb.unselectAllElements();
    for (const id of ids) {
      const e = this.element(doc.bindings[id]?.elementId ?? '');
      if (e instanceof this.bb.Group) e.multiSelect?.();
      else e?.markAsSelected();
      e?.showInOutliner?.();
    }
    this.bb.updateSelection();
    this.bb.Undo.finishSelection('Select UI elements');
  }
  beginPaint(doc: UiDocument, id: Id, onSource: (png: string) => Promise<void>) {
    const node = doc.nodes[id],
      binding = doc.bindings[id];
    if (!node?.content || !binding?.textureId) return;
    const texture = this.texture(binding.textureId);
    if (!texture) return;
    if (node.content.kind === 'paint') {
      this.select(doc, [id]);
      texture.select();
      this.bb.Modes.options.paint.select();
      this.bb.BarItems.brush_tool.select();
      return;
    }
    const source = doc.assets[node.content.source];
    if (!source) return;
    const parent = this.project,
      saved = this.sources[source.id];
    // Do not use sync_to_project: source edits are an explicit, atomic parent transaction.
    this.bb.Codecs.image.load(saved ? clone(saved) : source.png);
    const editor = this.bb.Project;
    editor.name = `${node.name} · 源图（应用后更新）`;
    let finished = false;
    const cancel = () => {
      if (finished) return;
      finished = true;
      editor.saved = true;
      editor.close();
      parent.select();
    };
    const apply = async () => {
      if (finished) return;
      const edited = editor.textures[0];
      if (!edited) return;
      const png = edited.getDataURL();
      this.pendingSource = { id, snapshot: edited.getSaveCopy(true) };
      parent.select();
      try {
        await onSource(png);
        finished = true;
        editor.saved = true;
        await editor.close();
        parent.select();
      } catch (error) {
        editor.select();
        throw error;
      } finally {
        this.pendingSource = null;
      }
    };
    this.onSourceSession?.(apply, cancel);
  }
}
