import { NativeHost } from '../../../src/adapters/blockbench/native-host';
import { hostRuntime } from '../../../src/adapters/blockbench/runtime';
import { Studio } from '../../../src/application/studio';
import { imagePort } from '../../../src/platform/browser/images';
import { clone, validateDocument } from '../../../src/domain/document';
import { layout } from '../../../src/domain/layout';
import { blank, renderPixels, decorate } from '../../../src/domain/raster';
import { bounds } from '../../../src/domain/geometry';
import { parseSize, parseOffset, formatSize, formatOffset } from '../../../src/domain/expression';
import {
  createDocument,
  createNode,
  defaultAppearance,
  type UiDocument,
  type Pixels,
} from '../../../src/domain/types';

const bb = hostRuntime();
const fail = (message: string): never => {
  throw new Error(message);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const safeId = (id: unknown): id is string =>
  typeof id === 'string' && !!id && !['__proto__', 'constructor', 'prototype'].includes(id);
function keys(value: any, allowed: string[], context: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${context}: expected object`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${context}: unknown field ${key}`);
}
function number(value: unknown, label: string, min = -Infinity, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    (integer && !Number.isSafeInteger(value))
  )
    fail(`${label}: invalid number`);
  return value as number;
}
function choice(value: any, options: string[], label: string) {
  if (!options.includes(value)) fail(`${label}: expected ${options.join('/')}`);
  return value;
}
function vector(value: any, count: number, label: string, min = -Infinity, integer = false) {
  if (!Array.isArray(value) || value.length !== count) fail(`${label}: expected ${count} values`);
  return value.map((v: any) => number(v, label, min, integer));
}
function anchor(value: any) {
  const a = vector(value, 2, 'anchor', 0);
  if (a.some((v: number) => v > 1)) fail('anchor must be between 0 and 1');
  return a;
}
function color(value: unknown): number[] {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(value))
    fail('color must be #RRGGBB or #RRGGBBAA');
  const s = value as string;
  return [0, 1, 2, 3].map((i) =>
    i === 3 && s.length === 7 ? 255 : parseInt(s.slice(1 + i * 2, 3 + i * 2), 16),
  );
}
function paintAsset(spec: any): Pixels {
  keys(spec, ['width', 'height', 'color', 'rows', 'palette'], 'asset');
  const result = blank(spec.width, spec.height);
  if (spec.rows) {
    if (!Array.isArray(spec.rows) || spec.rows.length !== result.height)
      fail('asset rows: wrong height');
    for (let y = 0; y < result.height; y++) {
      const row = Array.from(spec.rows[y]);
      if (row.length !== result.width) fail('asset rows: wrong width');
      row.forEach((symbol: any, x: number) =>
        result.data.set(
          color(spec.palette?.[symbol] ?? fail(`missing palette symbol ${symbol}`)),
          (y * result.width + x) * 4,
        ),
      );
    }
  } else if (spec.color) {
    const rgba = color(spec.color);
    for (let i = 0; i < result.data.length; i += 4) result.data.set(rgba, i);
  }
  return result;
}
async function load(model?: any) {
  bb.newProject(bb.Formats.free);
  if (model) bb.Codecs.project.parse(model);
  if (model)
    await Promise.all(
      bb.Texture.all
        .filter((t: any) => t.source?.startsWith('data:'))
        .map((t: any) => t.img.decode()),
    );
  const host = new NativeHost(bb, bb.Project);
  const doc = model ? host.read() : null;
  if (model && !doc) fail('The input is not a UI Studio project');
  if (doc) {
    await host.prepareSources();
    const check = new Studio(host, imagePort, doc);
    await check.initialize();
    if (check.state.error) fail(check.state.error);
    const issues = Object.values(check.state.doc.nodes).filter((n) => n.suspended);
    if (
      issues.length ||
      !same(doc.roots, check.state.doc.roots) ||
      Object.keys(doc.nodes).length !== Object.keys(check.state.doc.nodes).length
    )
      fail('Native/model divergence: ' + issues.map((n) => `${n.name}: ${n.suspended}`).join('; '));
    check.dispose();
  }
  return { host, doc };
}
function designFromDoc(doc: UiDocument, name: string) {
  const visit = (id: string): any => {
    const n = doc.nodes[id]!;
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      visible: n.visible,
      locked: n.locked,
      opacity: n.opacity,
      x: formatOffset(n.layout.offsetPercent?.x ?? 0, n.layout.offset.x),
      y: formatOffset(n.layout.offsetPercent?.y ?? 0, n.layout.offset.y),
      width: formatSize(n.layout.width),
      height: formatSize(n.layout.height),
      positioning: n.layout.positioning,
      anchorFrom: n.layout.anchorFrom,
      anchorTo: n.layout.anchorTo,
      minWidth: n.layout.minWidth,
      minHeight: n.layout.minHeight,
      maxWidth: n.layout.maxWidth,
      maxHeight: n.layout.maxHeight,
      ...(n.frame
        ? {
            direction: n.frame.direction,
            gap: n.frame.gap,
            padding: n.frame.padding,
            justify: n.frame.justify,
            align: n.frame.align,
          }
        : {}),
      ...(n.content
        ? {
            content:
              n.content.kind === 'generated'
                ? { kind: 'generated', preserve: true }
                : clone(n.content),
          }
        : {}),
      appearance: n.appearance,
      rasterSize: n.rasterSize,
      children: n.children.map(visit),
    };
  };
  return {
    version: 1,
    name,
    assets: Object.fromEntries(Object.values(doc.assets).map((a) => [a.id, { png: a.png }])),
    nodes: doc.roots.map(visit),
  };
}

async function compileDesign(design: any, base: UiDocument | null): Promise<UiDocument> {
  keys(design, ['version', 'name', 'assets', 'nodes'], 'design');
  if (design.version !== 1 || !Array.isArray(design.nodes))
    fail('design version must be 1 with nodes array');
  const doc = createDocument(base?.id ?? crypto.randomUUID());
  let totalPixels = 0;
  for (const [id, spec] of Object.entries(design.assets ?? {}) as [string, any][]) {
    if (!safeId(id)) fail('invalid asset id');
    let pixels: Pixels;
    if (spec.png) {
      keys(spec, ['png'], 'asset');
      if (!/^data:image\/png;base64,/.test(spec.png))
        fail('only embedded PNG sources are supported');
      pixels = await imagePort.decode(spec.png);
    } else pixels = paintAsset(spec);
    blank(pixels.width, pixels.height);
    totalPixels += pixels.width * pixels.height;
    if (totalPixels > 32_000_000) fail('source pixel budget exceeded');
    const old = base?.assets[id],
      png = old && old.png === spec.png ? spec.png : imagePort.encode(pixels);
    doc.assets[id] = {
      id,
      width: pixels.width,
      height: pixels.height,
      png,
      revision: old ? (old.png === png ? old.revision : old.revision + 1) : 1,
    };
  }
  const visit = (spec: any, parent: string | null): string => {
    keys(
      spec,
      [
        'id',
        'name',
        'kind',
        'x',
        'y',
        'width',
        'height',
        'visible',
        'locked',
        'opacity',
        'positioning',
        'anchorFrom',
        'anchorTo',
        'minWidth',
        'minHeight',
        'maxWidth',
        'maxHeight',
        'direction',
        'gap',
        'padding',
        'justify',
        'align',
        'content',
        'appearance',
        'rasterSize',
        'children',
      ],
      'node',
    );
    const id = spec.id;
    if (!safeId(id) || doc.nodes[id]) fail('invalid/duplicate logical id');
    if (Object.keys(doc.nodes).length >= 2000) fail('node count exceeds 2000');
    choice(spec.kind, ['image', 'frame'], 'node.kind');
    const old = base?.nodes[id];
    if (old && old.kind !== spec.kind) fail('Changing node kind requires a new logical id');
    const n = createNode(id, spec.name ?? id, spec.kind, { x: 0, y: 0, width: 32, height: 32 });
    if (typeof n.name !== 'string') fail('node name must be text');
    doc.nodes[id] = n;
    n.parent = parent;
    for (const axis of ['width', 'height'] as const) {
      const rule = parseSize(String(spec[axis] ?? 32));
      if (!parent && (rule.kind === 'fill' || rule.kind === 'expression'))
        fail(`${id}: root has no relative size reference`);
      if (rule.kind === 'fixed' && rule.value < 1) fail('fixed size must be >= 1');
      n.layout[axis] = rule;
    }
    for (const axis of ['x', 'y'] as const) {
      const v = parseOffset(String(spec[axis] ?? 0));
      n.layout.offset[axis] = v.pixels;
      (n.layout.offsetPercent ??= { x: 0, y: 0 })[axis] = v.percent;
    }
    if (!old?.layout.offsetPercent && !n.layout.offsetPercent?.x && !n.layout.offsetPercent?.y)
      delete n.layout.offsetPercent;
    n.layout.positioning = choice(spec.positioning ?? 'flow', ['flow', 'absolute'], 'positioning');
    n.layout.anchorFrom = anchor(spec.anchorFrom ?? [0, 0]) as [number, number];
    n.layout.anchorTo = anchor(spec.anchorTo ?? [0, 0]) as [number, number];
    for (const k of ['minWidth', 'minHeight', 'maxWidth', 'maxHeight'] as const)
      if (spec[k] !== undefined) n.layout[k] = number(spec[k], k, 1);
    for (const k of ['visible', 'locked'] as const)
      if (spec[k] !== undefined) {
        if (typeof spec[k] !== 'boolean') fail(k + ' must be boolean');
        n[k] = spec[k];
      }
    n.opacity = number(spec.opacity ?? 1, 'opacity', 0);
    if (n.opacity > 1) fail('opacity must be <= 1');
    if (n.kind === 'frame') {
      if (spec.content || spec.appearance || spec.rasterSize)
        fail('Frame cannot own content, fill, stroke or rasterSize');
      const f = n.frame!;
      f.direction = choice(spec.direction ?? 'free', ['free', 'row', 'column'], 'direction');
      f.engineType = f.direction === 'free' ? 'panel' : 'stack_panel';
      f.gap = number(spec.gap ?? 8, 'gap', 0, true);
      f.padding = vector(spec.padding ?? [0, 0, 0, 0], 4, 'padding', 0, true) as [
        number,
        number,
        number,
        number,
      ];
      f.justify = choice(
        spec.justify ?? 'start',
        ['start', 'center', 'end', 'space-between'],
        'justify',
      );
      f.align = choice(spec.align ?? 'start', ['start', 'center', 'end'], 'align');
    } else {
      if (['direction', 'gap', 'padding', 'justify', 'align'].some((k) => spec[k] !== undefined))
        fail('Image children use free positioning; put a Stack Frame inside it');
      const c = spec.content ?? { kind: 'paint' };
      choice(c.kind, ['paint', 'image', 'nine-slice', 'generated'], 'content.kind');
      if (c.kind === 'generated') {
        keys(c, ['kind', 'preserve'], 'generated content');
        if (!c.preserve || old?.content?.kind !== 'generated')
          fail('Generated/text content can only be preserved from a base file');
        n.content = clone(old!.content!);
      } else {
        let source = c.source;
        if (!source && c.kind === 'paint') {
          source = `blank:${id}`;
          if (!doc.assets[source])
            doc.assets[source] = {
              id: source,
              width: 1,
              height: 1,
              png: imagePort.encode(blank(1, 1)),
              revision: 1,
            };
        }
        if (!doc.assets[source]) fail(`${id}: missing asset ${source}`);
        if (c.kind === 'paint') {
          keys(c, ['kind', 'source', 'mode', 'origin'], 'paint');
          const v = c.origin ?? { x: 0, y: 0 };
          keys(v, ['x', 'y'], 'paint.origin');
          n.content = {
            kind: 'paint',
            source,
            mode: choice(c.mode ?? 'extend', ['extend', 'scale'], 'paint.mode'),
            origin: { x: number(v.x, 'origin.x'), y: number(v.y, 'origin.y') },
          };
        }
        if (c.kind === 'image') {
          keys(
            c,
            ['kind', 'source', 'mode', 'anchor', 'scale', 'offset', 'onlyDownscale'],
            'image',
          );
          const v = c.offset ?? { x: 0, y: 0 };
          keys(v, ['x', 'y'], 'image.offset');
          if (c.onlyDownscale !== undefined && typeof c.onlyDownscale !== 'boolean')
            fail('onlyDownscale must be boolean');
          n.content = {
            kind: 'image',
            source,
            mode: choice(
              c.mode ?? 'fit',
              ['fit', 'fill', 'stretch', 'crop', 'original'],
              'image.mode',
            ),
            anchor: anchor(c.anchor ?? [0.5, 0.5]) as [number, number],
            scale: number(c.scale ?? 1, 'scale', 0.0001),
            offset: { x: number(v.x, 'offset.x'), y: number(v.y, 'offset.y') },
            onlyDownscale: c.onlyDownscale ?? false,
          };
        }
        if (c.kind === 'nine-slice') {
          keys(c, ['kind', 'source', 'insets', 'mode'], 'nine-slice');
          n.content = {
            kind: 'nine-slice',
            source,
            insets: vector(c.insets, 4, 'insets', 0, true) as [number, number, number, number],
            mode: choice(c.mode ?? 'stretch', ['stretch', 'tile'], 'nine.mode'),
          };
        }
      }
      if (spec.appearance) {
        keys(
          spec.appearance,
          ['fill', 'color', 'endColor', 'angle', 'strokeColor', 'strokeWidth'],
          'appearance',
        );
        n.appearance = { ...defaultAppearance(), ...spec.appearance };
        choice(n.appearance!.fill, ['none', 'solid', 'linear'], 'fill');
      }
      if (spec.rasterSize) {
        if (c.kind === 'nine-slice') fail('nine-slice always follows target dimensions');
        keys(spec.rasterSize, ['width', 'height'], 'rasterSize');
        n.rasterSize = {
          width: number(spec.rasterSize.width, 'raster width', 1, true),
          height: number(spec.rasterSize.height, 'raster height', 1, true),
        };
      }
    }
    if (old) {
      doc.bindings[id] = clone(base!.bindings[id]!);
      for (const k of [
        'originalContent',
        'originalAppearance',
        'originalOpacity',
        'originalRasterSize',
      ] as const)
        if (old[k] !== undefined) (n as any)[k] = clone(old[k]);
      if (n.content?.kind === 'generated') {
        if (!same(spec.rasterSize, old.rasterSize))
          fail(`${id}: generated/text rasterSize must be preserved`);
        n.rasterSize = old.rasterSize;
      }
    }
    if (spec.children !== undefined && !Array.isArray(spec.children))
      fail('children must be an array');
    n.children = (spec.children ?? []).map((c: any) => visit(c, id));
    return id;
  };
  doc.roots = design.nodes.map((n: any) => visit(n, null));
  // Preserve sources referenced by archived content even when omitted from the authoring recipe.
  for (const n of Object.values(doc.nodes))
    for (const c of [n.content, n.originalContent])
      if (c && !doc.assets[c.source] && base?.assets[c.source])
        doc.assets[c.source] = clone(base.assets[c.source]!);
  validateDocument(doc);
  return doc;
}

async function preview(doc: UiDocument) {
  const scene = layout(doc);
  const rect = bounds(
    Object.values(scene.nodes)
      .filter((n) => n.visible)
      .map((n) => n.rect),
  );
  if (!rect) return null;
  if (rect.width * rect.height > 16_777_216) fail('preview exceeds 16 million pixels');
  const canvas = document.createElement('canvas');
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (const id of scene.order) {
    const n = doc.nodes[id]!,
      r = scene.nodes[id]!;
    if (!n.content || !r.visible) continue;
    const t = bb.Project.textures.find((t: any) => t.uuid === doc.bindings[id]?.textureId);
    if (t)
      ctx.drawImage(t.canvas, r.rect.x - rect.x, r.rect.y - rect.y, r.rect.width, r.rect.height);
  }
  return { png: canvas.toDataURL(), bounds: rect };
}

export async function run(request: any) {
  const { host, doc: base } = await load(request.base);
  if (request.command === 'extract') return { design: designFromDoc(base!, bb.Project.name) };
  if (request.command === 'validate')
    return {
      nodes: Object.keys(base!.nodes).length,
      images: Object.values(base!.nodes).filter((n) => n.kind === 'image').length,
      preview: request.preview ? await preview(base!) : undefined,
    };
  const doc = await compileDesign(request.design, base);
  const scene = layout(doc),
    bitmaps: Record<string, Pixels> = {};
  let total = 0;
  const oldScene = base ? layout(base) : null;
  for (const id of scene.order) {
    const n = doc.nodes[id]!;
    n.rect = { ...scene.nodes[id]!.rect };
    if (!n.content) continue;
    if (n.content.kind === 'generated') {
      const old = base?.nodes[id];
      if (
        !old ||
        !same(n.rect, old.rect) ||
        !same(n.layout, old.layout) ||
        !same(n.appearance, old.appearance) ||
        n.name !== old.name ||
        n.visible !== old.visible ||
        n.locked !== old.locked ||
        !same(n.children, old.children) ||
        n.opacity !== old.opacity ||
        n.parent !== old.parent ||
        scene.nodes[id]!.depth !== oldScene?.nodes[id]?.depth ||
        !same(doc.assets[n.content.source], base!.assets[n.content.source])
      )
        fail(`${id}: edit changes generated/text content; use its provider plugin first`);
      continue;
    }
    const source = await imagePort
        .decode(doc.assets[n.content.source]!.png)
        .catch((error) => fail(`${id}: source decode failed (${String(error)})`)),
      size = n.rasterSize ?? n.rect;
    total += size.width * size.height;
    if (total > 32_000_000) fail('rendered pixel budget exceeded');
    bitmaps[id] = decorate(
      renderPixels(source, n.content, size.width, size.height),
      n.appearance,
      n.opacity,
    );
  }
  if (request.design.name !== undefined) {
    if (typeof request.design.name !== 'string') fail('name must be text');
    bb.Project.name = request.design.name;
  }
  // A replaced source invalidates native painting-layer backups for that source only.
  if (base) {
    const carrier = bb.Project.unhandled_root_fields.mcui_studio;
    for (const [id, asset] of Object.entries(doc.assets))
      if (base.assets[id] && !same(asset, base.assets[id])) delete carrier.nativeSources?.[id];
  }
  const renderer = new NativeHost(bb, bb.Project);
  if (base) {
    renderer.read();
    await renderer.prepareSources();
  }
  renderer.apply(doc, scene, bitmaps, base);
  renderer.write(doc);
  const model = bb.Codecs.project.compile({ raw: true, bitmaps: true, editor_state: false });
  // Keep provider-defined properties not registered in this isolated host, and unrelated file fields.
  if (request.base) {
    const providers = new Set(
      Object.values(doc.nodes).flatMap((n) =>
        [n.content, n.originalContent]
          .filter((c) => c?.kind === 'generated')
          .map((c) => (c as { provider: string }).provider),
      ),
    );
    for (const kind of ['elements', 'groups', 'textures'])
      for (const item of model[kind] ?? []) {
        const old = request.base[kind]?.find((v: any) => v.uuid === item.uuid);
        if (old)
          for (const [k, v] of Object.entries(old))
            if (!(k in item) && (!k.startsWith('mcui_') || providers.has(k))) item[k] = v;
      }
    for (const [k, v] of Object.entries(request.base))
      if (!(k in model) && k !== 'editor_state') model[k] = v;
  }
  return {
    model,
    preview: await preview(doc),
    summary: { nodes: scene.order.length, images: Object.keys(bitmaps).length, documentId: doc.id },
  };
}
