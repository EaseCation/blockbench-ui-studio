import { BindingIndex } from './binding-index';
import { contentProviders } from '../../application/content';
import { hydrateContents, persistContents } from './content-carrier';
import type { HostPort, NativeSnapshot, NativeSceneSnapshot } from '../../application/ports';
import { clone, validateDocument, topSelection } from '../../domain/document';
import type { Id, Pixels, ResolvedScene, UiDocument } from '../../domain/types';
import type { HostObject, HostRuntime } from './runtime';
import { hashString } from './runtime';
import { imagePort } from '../../platform/browser/images';
import { hasAppearance, renderPixels } from '../../domain/raster';
import { ROLE_MARKER, SOURCE_MARKER } from './native-fields';
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
    const doc = clone(validateDocument(data.document));
    hydrateContents(doc, this.project);
    return doc;
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
      document: persistContents(doc, this.project),
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
    const undo = this.project.undo;
    if (this.active()) undo.cancelEdit(true);
    else {
      // Blockbench clears Project before unselect_mode/project. Restore through its own
      // deferred-open hook, never through the next project's global Undo getter.
      const save = undo.current_save;
      if (save)
        this.project.whenNextOpen(() => {
          if (undo.current_save === save) undo.cancelEdit(true);
        });
    }
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
    if (this.active()) return this.bb.OutlinerNode.uuids[id];
    return (
      this.project.elements.find((e: HostObject) => e.uuid === id) ??
      this.project.groups.find((e: HostObject) => e.uuid === id)
    );
  }
  private texture(id: string) {
    return this.project.textures.find((t: HostObject) => t.uuid === id);
  }
  private pixelHashes = new WeakMap<HostObject, { source: string; hash: string }>();
  private pixelFingerprint(texture: HostObject): string {
    if (!texture) return '';
    const source = texture.getDataURL();
    const old = this.pixelHashes.get(texture);
    if (old && old.source === source) return old.hash;
    const hash = hashString(source);
    this.pixelHashes.set(texture, { source, hash });
    return hash;
  }
  owner(doc: UiDocument, uuid: string): Id | null {
    return (
      Object.entries(doc.bindings).find(
        ([, b]) => b.containerId === uuid || b.surfaceId === uuid,
      )?.[0] ?? null
    );
  }
  private previewPositions = new Map<HostObject, HostObject>();
  previewMove(doc: UiDocument, ids: Id[], dx: number, dy: number) {
    this.clearPreview();
    for (const id of topSelection(doc, ids)) {
      const mesh = this.element(doc.bindings[id]?.containerId ?? '')?.mesh;
      if (!mesh) continue;
      this.previewPositions.set(mesh, mesh.position.clone());
      mesh.position.x += dx;
      mesh.position.z += dy;
      mesh.updateMatrixWorld(true);
    }
  }
  clearPreview() {
    for (const [mesh, position] of this.previewPositions) {
      mesh.position.copy(position);
      mesh.updateMatrixWorld(true);
    }
    this.previewPositions.clear();
  }
  private bindingsIndex = new BindingIndex();
  /** Selection changes need roles and ancestry, not a complete texture/fingerprint snapshot. */
  selection(doc: UiDocument): Id[] {
    const lookup = this.bindingsIndex.get(doc);
    const selected = [...this.project.selected_elements, ...(this.project.selected_groups ?? [])];
    const nativeSelected = new Set(selected.map((e: HostObject) => e.uuid));
    const candidates = new Set<Id>(
      selected
        .map((e: HostObject) => lookup.get(e.uuid))
        .filter((id: Id | undefined): id is Id => !!id && !!doc.nodes[id]),
    );
    const explicit = new Set<Id>();
    for (const id of candidates) {
      let parent = this.element(doc.bindings[id]!.containerId)?.parent;
      let inherited = false;
      while (parent && parent !== 'root') {
        if (nativeSelected.has(parent.uuid) || candidates.has(lookup.get(parent.uuid) ?? '')) {
          inherited = true;
          break;
        }
        parent = parent.parent;
      }
      if (!inherited) explicit.add(id);
    }
    const result: Id[] = [];
    const walk = (items: HostObject[]) => {
      for (const e of items) {
        const id = lookup.get(e.uuid);
        if (id && explicit.has(id) && doc.bindings[id]?.containerId === e.uuid) result.push(id);
        if (e instanceof this.bb.Group) walk(e.children);
      }
    };
    if (explicit.size) walk(this.project.outliner);
    return result;
  }
  scene(doc: UiDocument): NativeSceneSnapshot {
    const scene: NativeSceneSnapshot = { nodes: {}, roots: [], selection: [] };
    const ids = new Map(Object.entries(doc.bindings).map(([id, b]) => [b.containerId, id]));
    const ownedSurfaces = new Set(
      Object.values(doc.bindings)
        .filter((b) => b.surfaceId !== b.containerId)
        .map((b) => b.surfaceId)
        .filter(Boolean),
    );
    const selected: Id[] = [];
    const accepted = (e: HostObject) => e instanceof this.bb.Cube || e instanceof this.bb.Group;
    const groupRect = (e: HostObject, parentRect?: { x: number; y: number }) => {
      const cubes: HostObject[] = [];
      e.forEachChild((c: HostObject) => {
        if (c instanceof this.bb.Cube) cubes.push(c);
      });
      if (!cubes.length)
        return { x: (parentRect?.x ?? 0) + 8, y: (parentRect?.y ?? 0) + 8, width: 160, height: 90 };
      const x = Math.min(...cubes.map((c) => c.from[0])),
        y = Math.min(...cubes.map((c) => c.from[2]));
      return {
        x,
        y,
        width: Math.max(1, Math.max(...cubes.map((c) => c.to[0])) - x),
        height: Math.max(1, Math.max(...cubes.map((c) => c.to[2])) - y),
      };
    };
    const walk = (items: HostObject[], parentId?: string, parentSurface?: string): string[] => {
      const order: string[] = [];
      for (const e of items.filter(accepted)) {
        if (ownedSurfaces.has(e.uuid) || e.uuid === parentSurface) continue;
        const id = ids.get(e.uuid) ?? e.uuid;
        const original = doc.nodes[e[SOURCE_MARKER]];
        const n = doc.nodes[id] ?? original;
        const binding = doc.bindings[id];
        const isCube = e instanceof this.bb.Cube;
        const surface = isCube
          ? e
          : binding?.surfaceId
            ? this.element(binding.surfaceId)
            : original?.kind === 'image'
              ? e.children.find(
                  (c: HostObject) =>
                    c instanceof this.bb.Cube &&
                    c[ROLE_MARKER] === 'content' &&
                    c[SOURCE_MARKER] === original.id,
                )
              : undefined;
        const image = isCube || n?.kind === 'image';
        const t = surface?.faces.up.getTexture();
        const baseline = binding ?? doc.bindings[original?.id ?? ''];
        const oldOrigin = baseline?.groupOrigin ?? e.origin ?? [0, 0, 0];
        const rect = surface
          ? {
              x: surface.from[0],
              y: surface.from[2],
              width: surface.to[0] - surface.from[0],
              height: surface.to[2] - surface.from[2],
            }
          : n
            ? {
                ...n.rect,
                x: n.rect.x + (e.origin[0] - oldOrigin[0]),
                y: n.rect.y + (e.origin[2] - oldOrigin[2]),
              }
            : groupRect(e, parentId ? scene.nodes[parentId]?.rect : undefined);
        let ancestor = e,
          unsupported: string | undefined;
        while (ancestor && ancestor !== 'root') {
          if (ancestor.rotation?.some((v: number) => Math.abs(v) > 1e-6))
            unsupported = '检测到三维旋转，二维规则已暂停';
          ancestor = ancestor.parent;
        }
        if (image && !isCube && (!surface || surface.parent !== e))
          unsupported = 'Image 内容载体缺失或已移出，请采用当前结果或重新生成';
        if (
          surface &&
          binding &&
          (Math.abs(surface.to[1] - surface.from[1]) > 1e-5 ||
            surface.rotation?.some((v: number) => Math.abs(v) > 1e-6))
        )
          unsupported = '内容载体的三维几何已改变，二维规则已暂停';
        if (image && (rect.width <= 0 || rect.height <= 0)) unsupported = '内容尺寸不适合二维布局';
        if (
          surface &&
          binding &&
          !isCube &&
          (JSON.stringify(surface.faces.up.uv) !==
            JSON.stringify([0, 0, t?.uv_width, t?.uv_height]) ||
            (binding.textureId && binding.textureId !== t?.uuid) ||
            surface.visibility !== e.visibility ||
            surface.locked !== e.locked)
        )
          unsupported = '内容载体的 UV、贴图或显示状态已独立修改，规则已暂停';
        const pixelFingerprint = this.pixelFingerprint(t);
        const fingerprint = hashString(
          JSON.stringify([
            rect,
            e.name,
            e.visibility !== false,
            e.locked === true,
            surface?.to[1] ?? 0,
            t?.uuid,
            pixelFingerprint,
            surface?.faces.up.uv,
            e.rotation,
            e.parent?.uuid ?? null,
            surface?.parent?.uuid ?? null,
            surface?.visibility,
          ]),
        );
        scene.nodes[id] = {
          id,
          containerId: e.uuid,
          surfaceId: surface?.uuid,
          generatedPixels:
            !n && surface
              ? ([...contentProviders]
                  .filter(([key]) => surface[key] && !surface[key].inactive)
                  .map(([, p]) => p.fallback?.(surface.uuid))
                  .find((p) => !!p) ?? undefined)
              : undefined,
          generated: [...contentProviders.keys()]
            .filter((key) => surface?.[key] && !surface[key].inactive)
            .map((provider) => ({ provider, data: clone(surface[provider]) }))[0],
          kind: image ? 'image' : 'frame',
          sourceId: e[SOURCE_MARKER] || undefined,
          rect,
          depth: surface?.to[1] ?? 0,
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
        if (isCube ? e.selected : this.project.selected_groups?.includes(e)) selected.push(id);
        if (surface?.selected) selected.push(id);
        if (!isCube) scene.nodes[id]!.children = walk(e.children, id, surface?.uuid);
      }
      return order;
    };
    scene.roots = walk(this.project.outliner);
    // Group selection marks descendants selected; keep only explicit ancestors logically.
    const selectedSet = new Set(selected);
    scene.selection = [...selectedSet].filter((id) => {
      let parent = scene.nodes[id]?.parentId;
      while (parent) {
        if (selectedSet.has(parent)) return false;
        parent = scene.nodes[parent]?.parentId;
      }
      return true;
    });
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
    if (hasAppearance(doc.nodes[id]?.appearance)) return false;
    const layers = this.sourceLayers.get(content.source);
    if (!layers?.length) return false;
    const source = doc.assets[content.source]!,
      rect = doc.nodes[id]!.rasterSize ?? doc.nodes[id]!.rect;
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
        const e = this.element(binding.containerId);
        if (e) e.remove();
        if (
          binding.textureId &&
          !Object.values(doc.bindings).some((b) => b.textureId === binding.textureId)
        ) {
          const t = this.texture(binding.textureId);
          if (t) t.remove(true);
        }
      }
    this.clearPreview();
    for (const id of scene.order) {
      const n = doc.nodes[id]!,
        resolved = scene.nodes[id]!;
      let binding = doc.bindings[id];
      if (n.suspended && binding) continue;
      let container = binding ? this.element(binding.containerId) : undefined;
      const raw = container instanceof this.bb.Cube ? container : undefined;
      const parent = n.parent ? this.element(doc.bindings[n.parent]?.containerId ?? '') : 'root';
      const created = !(container instanceof this.bb.Group);
      if (created) {
        container = new this.bb.Group({ name: n.name, origin: [0, 0, 0] });
        if (raw) container.sortInBefore(raw).init();
        else container.addTo(parent ?? 'root').init();
        binding = doc.bindings[id] = {
          ...binding,
          containerId: container.uuid,
          surfaceId: binding?.surfaceId ?? raw?.uuid,
        };
      }
      if (!binding) continue;
      const old = previous?.nodes[id];
      const siblings = n.parent ? doc.nodes[n.parent]!.children : doc.roots;
      const oldSiblings = old?.parent ? previous?.nodes[old.parent]?.children : previous?.roots;
      const reordered = JSON.stringify(siblings) !== JSON.stringify(oldSiblings);
      container.name = n.name;
      container.visibility = n.visible;
      container.locked = n.locked;
      if (created || old?.parent !== n.parent || reordered) container.addTo(parent ?? 'root');
      container[SOURCE_MARKER] = id;
      container[ROLE_MARKER] = 'container';
      binding.groupOrigin = [...container.origin] as [number, number, number];
      changedGroups.push(container);
      if (n.kind === 'frame') continue;
      let element = binding.surfaceId ? this.element(binding.surfaceId) : undefined;
      const newSurface = !element;
      if (!element)
        element = new this.bb.Cube({
          name: n.name + ' · 内容',
          box_uv: false,
          autouv: 0,
          shade: false,
        })
          .addTo(container, 0)
          .init();
      binding.surfaceId = element.uuid;
      if (element.parent !== container || container.children.indexOf(element) !== 0)
        element.addTo(container, 0);
      element.name = n.name + ' · 内容';
      element.visibility = n.visible;
      element.locked = n.locked;
      element[SOURCE_MARKER] = id;
      element[ROLE_MARKER] = 'content';
      if (raw?.selected) container.multiSelect();
      const changed =
        created ||
        newSurface ||
        !!bitmaps[id] ||
        !old ||
        JSON.stringify(old.rect) !== JSON.stringify(n.rect) ||
        old.visible !== n.visible ||
        old.locked !== n.locked ||
        old.name !== n.name ||
        Math.abs(element.to[1] - resolved.depth) > 1e-6;
      if (!changed) continue;
      changedElements.push(element);
      const r = resolved.rect,
        depth = resolved.depth;
      element.extend({
        from: [r.x, depth, r.y],
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
      texture.name = `${n.name}.png`;
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
  private syncingTexture = false;
  private textureSelectionKey = '';
  syncSelectedTexture(doc: UiDocument, ids: Id[]) {
    if (!this.active() || this.syncingTexture) return;
    const id = ids.find((id) => doc.nodes[id]?.kind === 'image');
    const binding = id ? doc.bindings[id] : undefined;
    const key = binding ? `${binding.containerId}:${binding.textureId}` : '';
    if (key === this.textureSelectionKey) return;
    this.textureSelectionKey = key;
    if (!binding?.textureId) return;
    const texture = this.texture(binding.textureId),
      element = this.element(binding.surfaceId ?? '');
    if (!texture || !element) return;
    this.syncingTexture = true;
    try {
      const uv = this.bb.UVEditor;
      const selected = this.project.selected_elements;
      const index = selected.indexOf(element);
      if (index > 0) {
        selected.splice(index, 1);
        selected.unshift(element);
      }
      const faces = uv.getSelectedFaces(element, true);
      faces.splice(0, faces.length, 'up');
      texture.select();
      uv.loadData();
      uv.vue.updateTexture();
    } finally {
      this.syncingTexture = false;
    }
  }
  select(doc: UiDocument, ids: Id[]) {
    if (!this.active()) return;
    const selected = topSelection(doc, this.selection(doc));
    if (JSON.stringify([...selected].sort()) === JSON.stringify([...ids].sort())) {
      this.syncSelectedTexture(doc, ids);
      return;
    }
    this.bb.Undo.initSelection();
    this.bb.unselectAllElements();
    for (const id of ids) {
      const e = this.element(doc.bindings[id]?.containerId ?? '');
      if (e instanceof this.bb.Group) e.multiSelect?.();
      else e?.markAsSelected();
      e?.showInOutliner?.();
    }
    this.bb.updateSelection();
    this.bb.Undo.finishSelection('Select UI elements');
    this.syncSelectedTexture(doc, ids);
  }
  private paintOwner: Id | null = null;
  restorePaintSelection(doc: UiDocument) {
    if (!this.paintOwner || !this.bb.Modes.edit) return;
    const id = this.paintOwner;
    this.paintOwner = null;
    if (doc.nodes[id]) {
      this.bb.unselectAllElements();
      this.select(doc, [id]);
    }
  }
  beginPaint(doc: UiDocument, id: Id, onSource: (png: string) => Promise<void>) {
    const node = doc.nodes[id],
      binding = doc.bindings[id];
    if (!node?.content || !binding?.textureId) return;
    const texture = this.texture(binding.textureId);
    if (!texture) return;
    if (node.content.kind === 'paint') {
      this.paintOwner = id;
      this.bb.unselectAllElements();
      this.element(binding.surfaceId ?? '')?.markAsSelected();
      this.bb.updateSelection();
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
