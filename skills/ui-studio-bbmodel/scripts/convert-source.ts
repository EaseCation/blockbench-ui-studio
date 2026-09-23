import { hostRuntime } from '../../../src/adapters/blockbench/runtime';
const bb = hostRuntime();
type Entry = {
  id: string;
  name: string;
  kind: 'frame' | 'image';
  rect: { x: number; y: number; width: number; height: number };
  depth: number;
  visible: boolean;
  locked: boolean;
  children: Entry[];
  content?: any;
  rasterSize?: any;
  source?: string;
};

/** Explicit visual conversion, never a schema migration hidden inside build/validate. */
export async function convertSource(model: any, options: any = {}) {
  const allowed = [
    'view',
    'offset',
    'name',
    'flattenGroups',
    'imageDensity',
    'spriteDensity',
    'fonts',
    'fontMap',
  ];
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Expected conversion options object');
  for (const key of Object.keys(options))
    if (!allowed.includes(key)) throw new Error(`Unknown conversion option ${key}`);
  if (
    options.flattenGroups !== undefined &&
    (!Array.isArray(options.flattenGroups) ||
      !options.flattenGroups.every((id: unknown) => typeof id === 'string'))
  )
    throw new Error('flattenGroups must be UUID strings');
  for (const key of ['imageDensity', 'spriteDensity'])
    if (options[key] !== undefined && ![1, 2, 4].includes(options[key]))
      throw new Error('Raster density must be 1/2/4');
  if (model.unhandled_root_fields?.mcui_studio)
    throw new Error('Already a UI project: use extract/build');
  if (model.meta?.model_format !== 'free') throw new Error('Conversion requires Generic Model');
  if (!['top', 'top-reversed'].includes(options.view))
    throw new Error('Choose source view: top or top-reversed');
  const reverse = options.view === 'top-reversed';
  const offset = options.offset ?? [0, 0];
  if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite))
    throw new Error('Invalid conversion offset');
  if (bb.Project) bb.Project.saved = true;
  bb.newProject(bb.Formats.free);
  bb.Codecs.project.parse(model);
  await Promise.all(
    bb.Texture.all
      .filter((t: any) => t.source?.startsWith('data:'))
      .map((t: any) => t.img.decode()),
  );
  const legacy = bb.Project.elements
    .filter((e: any) => e.type === 'bb_text')
    .map((e: any) => ({
      uuid: e.uuid,
      parent: e.parent,
      index: (e.parent === 'root' ? bb.Outliner.root : e.parent.children).indexOf(e),
    }));
  if (legacy.length) {
    if (!bb.Blockbench.bbText?.convertLegacy) throw new Error('Legacy text requires --text-plugin');
    const fonts =
      bb.Project.unhandled_root_fields?.bb_text?.fonts ?? bb.Project.bb_text_fonts ?? [];
    const missing = bb.Project.elements.filter(
      (e: any) =>
        e.type === 'bb_text' &&
        e.font_id !== 'font_default_minecraft' &&
        !fonts.some((f: any) => f.id === e.font_id),
    );
    if (missing.length)
      throw new Error(
        'Missing embedded fonts: ' + [...new Set(missing.map((e: any) => e.font_id))].join(', '),
      );
    await bb.Blockbench.bbText.convertLegacy();
  }
  const originalIds = new Map<string, string>();
  for (const old of legacy) {
    const e = (old.parent === 'root' ? bb.Outliner.root : old.parent.children)[old.index];
    originalIds.set(e.uuid, old.uuid);
  }
  bb.Canvas.updateAll();
  bb.Project.model_3d.updateMatrixWorld(true);
  const flatten = new Set<string>(options.flattenGroups ?? []);
  const assets: Record<string, any> = {},
    notes: any[] = [];
  const renderer = new bb.THREE.WebGLRenderer({
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0, 0);
  renderer.setPixelRatio(1);
  const scene = new bb.THREE.Scene();
  const camera = new bb.THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
  camera.up.set(0, 0, reverse ? 1 : -1);
  const projectPoint = (x: number, z: number) => ({
    x: (reverse ? -x : x) + offset[0],
    y: (reverse ? -z : z) + offset[1],
  });
  const worldBox = (elements: any[]) => {
    const box = new bb.THREE.Box3();
    for (const e of elements) {
      e.mesh.geometry.computeBoundingBox();
      box.union(e.mesh.geometry.boundingBox.clone().applyMatrix4(e.mesh.matrixWorld));
    }
    return box;
  };
  const rectangle = (box: any) => {
    const p = projectPoint(reverse ? box.max.x : box.min.x, reverse ? box.max.z : box.min.z);
    return { x: p.x, y: p.y, width: box.max.x - box.min.x, height: box.max.z - box.min.z };
  };
  const collect = (e: any): any[] => {
    if (e instanceof bb.Group) return e.children.flatMap(collect);
    if (e instanceof bb.Cube) return [e];
    throw new Error(`Unsupported element ${e.name}: ${e.type}`);
  };
  const raster = (elements: any[], box: any, density: number, root: any) => {
    const r = rectangle(box),
      w = Math.max(1, Math.ceil(r.width * density)),
      h = Math.max(1, Math.ceil(r.height * density));
    if (w * h > 16_777_216) throw new Error('Conversion sprite exceeds pixel budget');
    renderer.setSize(w, h, false);
    while (scene.children.length) scene.remove(scene.children[0]);
    for (const e of elements) {
      const m = new bb.THREE.Mesh(e.mesh.geometry, e.mesh.material);
      m.matrix.copy(e.mesh.matrixWorld);
      m.matrixAutoUpdate = false;
      // The resulting logical node carries its own visibility; bake hidden leaves too
      // so showing them later does not reveal an irreversibly empty texture.
      m.visible = true;
      if (root instanceof bb.Group) {
        m.visible = e.visibility !== false;
        let parent = e.parent;
        while (parent && parent !== 'root' && parent !== root) {
          m.visible &&= parent.visibility !== false;
          parent = parent.parent;
        }
      }
      scene.add(m);
    }
    const x = (box.min.x + box.max.x) / 2,
      z = (box.min.z + box.max.z) / 2;
    camera.position.set(x, box.max.y + 1000, z);
    camera.lookAt(x, box.min.y - 1, z);
    camera.left = -r.width / 2;
    camera.right = r.width / 2;
    camera.top = r.height / 2;
    camera.bottom = -r.height / 2;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return { png: renderer.domElement.toDataURL(), size: { width: w, height: h } };
  };
  const visit = (e: any): Entry => {
    const id = originalIds.get(e.uuid) ?? e.uuid;
    if (e instanceof bb.Group && !flatten.has(e.uuid)) {
      const children = e.children.map(visit);
      children.sort((a: Entry, b: Entry) => a.depth - b.depth);
      const x = Math.min(...children.map((c: Entry) => c.rect.x)),
        y = Math.min(...children.map((c: Entry) => c.rect.y));
      return {
        id,
        name: e.name,
        kind: 'frame',
        rect: children.length
          ? {
              x,
              y,
              width: Math.max(...children.map((c: Entry) => c.rect.x + c.rect.width)) - x,
              height: Math.max(...children.map((c: Entry) => c.rect.y + c.rect.height)) - y,
            }
          : { x: 0, y: 0, width: 1, height: 1 },
        depth: children.length ? Math.min(...children.map((c: Entry) => c.depth)) : 0,
        visible: e.visibility !== false,
        locked: !!e.locked,
        children,
      };
    }
    if (!(e instanceof bb.Cube) && !(e instanceof bb.Group))
      throw new Error(`Unsupported element ${e.name}: ${e.type}`);
    const elements = collect(e);
    if (!elements.length) throw new Error('Empty raster group');
    const box = worldBox(elements),
      rect = rectangle(box);
    const item: Entry = {
      id,
      name: e.name,
      kind: 'image',
      rect,
      depth: e instanceof bb.Group ? box.max.y : (box.min.y + box.max.y) / 2,
      visible: e.visibility !== false,
      locked: !!e.locked,
      children: [],
    };
    if (e.bb_text) {
      const right = new bb.THREE.Vector3(1, 0, 0).transformDirection(e.mesh.matrixWorld);
      const down = new bb.THREE.Vector3(
        0,
        e.bb_text.plane === 'south' ? -1 : 0,
        e.bb_text.plane === 'up' ? 1 : 0,
      ).transformDirection(e.mesh.matrixWorld);
      const sign = reverse ? -1 : 1;
      if (
        right.distanceTo(new bb.THREE.Vector3(sign, 0, 0)) > 0.001 ||
        down.distanceTo(new bb.THREE.Vector3(0, 0, sign)) > 0.001
      )
        throw new Error(
          `Text ${e.name} is not upright in the selected view; explicitly flatten its group or choose another view`,
        );
      // Text is rebaked by the actual provider, not flattened to an anonymous PNG.
      const { fingerprint, suspended, reference, ...data } = e.bb_text;
      item.content = {
        kind: 'text',
        ...data,
        plane: 'up',
        resize: 'reflow',
        sizing: 'fixed',
        box_width: Math.max(1, Math.ceil(rect.width)),
        box_height: Math.max(1, Math.ceil(rect.height)),
      };
      notes.push({ kind: 'text', source: id, name: e.name, text: data.text, font: data.font_id });
      return item;
    }
    if (e instanceof bb.Cube && box.max.y - box.min.y > 0.01)
      throw new Error(
        `Non-planar element ${e.name} (${id}); explicitly include its group in flattenGroups`,
      );
    const density =
      e instanceof bb.Group ? (options.spriteDensity ?? 2) : (options.imageDensity ?? 1);
    if (![1, 2, 4].includes(density)) throw new Error('Raster density must be 1/2/4');
    const result = raster(elements, box, density, e),
      asset = `source:${id}`;
    assets[asset] = { png: result.png };
    item.content = { kind: 'image', source: asset, mode: 'stretch' };
    item.rasterSize = result.size;
    if (e instanceof bb.Group)
      notes.push({ kind: 'baked-3d', source: id, name: e.name, cubes: elements.length });
    return item;
  };
  try {
    for (const id of flatten)
      if (!bb.Project.groups.some((g: any) => g.uuid === id))
        throw new Error(`Unknown flattenGroups UUID ${id}`);
    const entries: Entry[] = bb.Outliner.root.map(visit);
    const leaves: { leaf: Entry; path: Entry[] }[] = [];
    const flattenTree = (e: Entry, path: Entry[]) => {
      if (e.kind === 'frame') e.children.forEach((c) => flattenTree(c, [...path, e]));
      else leaves.push({ leaf: e, path });
    };
    entries.forEach((e) => flattenTree(e, []));
    if (!leaves.length) throw new Error('Source has no renderable UI elements');
    leaves.sort((a, b) => a.leaf.depth - b.leaf.depth);
    const root: Entry = {
      id: 'converted-root',
      name: options.name ?? model.name,
      kind: 'frame',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      depth: 0,
      visible: true,
      locked: false,
      children: [],
    };
    const counts = new Map<string, number>();
    for (const { leaf, path } of leaves) {
      let parent = root;
      for (const original of path) {
        let last = parent.children.at(-1);
        if (last?.kind !== 'frame' || last.source !== original.id) {
          const count = (counts.get(original.id) ?? 0) + 1;
          counts.set(original.id, count);
          last = {
            ...original,
            id: count === 1 ? original.id : `${original.id}:run:${count}`,
            name: count === 1 ? original.name : `${original.name} · 图层段 ${count}`,
            children: [],
            source: original.id,
          };
          parent.children.push(last);
        }
        parent = last;
      }
      parent.children.push(leaf);
    }
    const measure = (e: Entry) => {
      if (e.kind !== 'frame') return;
      e.children.forEach(measure);
      const x = Math.min(...e.children.map((c) => c.rect.x)),
        y = Math.min(...e.children.map((c) => c.rect.y));
      e.rect = {
        x,
        y,
        width: Math.max(...e.children.map((c) => c.rect.x + c.rect.width)) - x,
        height: Math.max(...e.children.map((c) => c.rect.y + c.rect.height)) - y,
      };
    };
    measure(root);
    notes.push({
      kind: 'stacking',
      strategy: 'global-depth-contiguous-group-runs',
      splitGroups: [...counts].filter(([, n]) => n > 1),
    });
    const serial = (e: Entry, parent?: Entry): any => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      x: Math.round(e.rect.x - (parent?.rect.x ?? 0)),
      y: Math.round(e.rect.y - (parent?.rect.y ?? 0)),
      width: Math.max(
        1,
        e.content?.kind === 'text' ? Math.ceil(e.rect.width - 1e-6) : Math.round(e.rect.width),
      ),
      height: Math.max(
        1,
        e.content?.kind === 'text' ? Math.ceil(e.rect.height - 1e-6) : Math.round(e.rect.height),
      ),
      visible: e.visible,
      locked: e.locked,
      ...(e.content ? { content: e.content } : {}),
      ...(e.rasterSize ? { rasterSize: e.rasterSize } : {}),
      children: e.children.map((c) => serial(c, e)),
    });
    return {
      design: {
        version: 1,
        name: options.name ?? model.name,
        fonts: bb.Project.unhandled_root_fields?.bb_text?.fonts ?? [],
        assets,
        nodes: [serial(root)],
      },
      report: {
        view: options.view,
        offset,
        originalElements: model.elements.length,
        fontMap: options.fontMap ?? {},
        omittedEmptyGroups: bb.Project.groups
          .filter((g: any) => !g.children.length)
          .map((g: any) => ({ id: g.uuid, name: g.name })),
        legacyText: legacy.length,
        notes,
        rounding:
          'UI geometry rounds to integer units; text is rebaked with embedded replacement fonts.',
      },
    };
  } finally {
    renderer.dispose();
  }
}
