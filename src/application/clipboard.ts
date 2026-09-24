import { clone } from '../domain/document';
import {
  fixed,
  type Appearance,
  type Pixels,
  type RenderRecipe,
  type UiDocument,
  type UiNode,
} from '../domain/types';

export interface PreparedImage {
  name: string;
  pixels: Pixels;
}
export interface ImagePasteOptions {
  forceNew?: boolean;
  destination?: string | null;
  selection?: string[];
}
export interface StyleClipboard {
  type: 'mcui-style';
  version: 1;
  opacity: number;
  appearance?: Appearance;
  fill?: {
    recipe: Exclude<RenderRecipe, { kind: 'generated' }>;
    png: string;
    width: number;
    height: number;
    preserveResolution: boolean;
  };
}
export const STYLE_PREFIX = 'MCUI_STYLE:';
export function copyStyle(doc: UiDocument, id: string): StyleClipboard {
  const n = doc.nodes[id];
  if (n?.kind !== 'image' || n.suspended) throw new Error('请选择一个可编辑 Image 复制属性');
  const result: StyleClipboard = { type: 'mcui-style', version: 1, opacity: n.opacity };
  if (n.appearance) result.appearance = clone(n.appearance);
  // Generated content (including text) is content, not an image fill. Keep its recipe private.
  if (n.content && n.content.kind !== 'generated') {
    const source = doc.assets[n.content.source]!;
    result.fill = {
      recipe: clone(n.content),
      png: source.png,
      width: source.width,
      height: source.height,
      preserveResolution: !!n.rasterSize,
    };
    result.fill.recipe.source = 'clipboard';
  }
  return result;
}
export function parseStyle(text: string): StyleClipboard | null {
  if (!text.startsWith(STYLE_PREFIX)) return null;
  const value = JSON.parse(text.slice(STYLE_PREFIX.length));
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const pair = (a: unknown) => Array.isArray(a) && a.length === 2 && a.every(finite);
  const xy = (p: any) => !!p && finite(p.x) && finite(p.y);
  const color = (c: unknown) => typeof c === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c);
  if (
    value?.type !== 'mcui-style' ||
    value.version !== 1 ||
    !finite(value.opacity) ||
    value.opacity < 0 ||
    value.opacity > 1
  )
    throw new Error('剪贴板样式数据无效');
  const a = value.appearance;
  if (
    a &&
    (!['none', 'solid', 'linear'].includes(a.fill) ||
      !color(a.color) ||
      !color(a.endColor) ||
      !color(a.strokeColor) ||
      !finite(a.angle) ||
      !finite(a.strokeWidth) ||
      a.strokeWidth < 0)
  )
    throw new Error('剪贴板外观无效');
  if (value.fill) {
    const f = value.fill,
      r = f.recipe;
    if (
      typeof f.png !== 'string' ||
      !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(f.png) ||
      !Number.isSafeInteger(f.width) ||
      !Number.isSafeInteger(f.height) ||
      f.width < 1 ||
      f.height < 1 ||
      f.width * f.height > 16777216 ||
      typeof f.preserveResolution !== 'boolean'
    )
      throw new Error('剪贴板图片填充无效');
    const valid =
      r &&
      (r.kind === 'image'
        ? ['fit', 'fill', 'stretch', 'crop', 'original'].includes(r.mode) &&
          pair(r.anchor) &&
          xy(r.offset) &&
          finite(r.scale) &&
          r.scale > 0 &&
          typeof r.onlyDownscale === 'boolean'
        : r.kind === 'paint'
          ? ['extend', 'scale'].includes(r.mode) && xy(r.origin)
          : r.kind === 'nine-slice' &&
            ['stretch', 'tile'].includes(r.mode) &&
            Array.isArray(r.insets) &&
            r.insets.length === 4 &&
            r.insets.every((v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0));
    if (!valid) throw new Error('剪贴板填充模式无效');
  }
  // Copy only declared fields; geometry, identity and hierarchy cannot enter this protocol.
  return clone({
    type: 'mcui-style',
    version: 1,
    opacity: value.opacity,
    ...(a ? { appearance: a } : {}),
    ...(value.fill ? { fill: value.fill } : {}),
  });
}
export function clearContentArchive(n: UiNode) {
  delete n.originalContent;
  delete n.originalAppearance;
  delete n.originalOpacity;
  delete n.originalRasterSize;
}
export function keepContentBounds(n: UiNode) {
  // Image Hug derives its size from source pixels. Freeze only intrinsic axes when
  // replacing that source so style paste does not resize/reposition the target.
  for (const axis of ['width', 'height'] as const)
    if (n.layout[axis].kind === 'hug') n.layout[axis] = fixed(n.rect[axis]);
}
export function fillRasterSize(n: UiNode, width: number, height: number) {
  const density =
    n.rect.width > 0 && n.rect.height > 0
      ? Math.max(1, width / n.rect.width, height / n.rect.height)
      : 1;
  return n.rect.width > 0 && n.rect.height > 0
    ? { width: Math.round(n.rect.width * density), height: Math.round(n.rect.height * density) }
    : { width, height };
}
