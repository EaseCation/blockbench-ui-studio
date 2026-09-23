export type Id = string;
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export type Axis = 'width' | 'height';
export type SizeRule =
  | { kind: 'fixed'; value: number }
  | { kind: 'expression'; percent: number; pixels: number }
  | { kind: 'fill' }
  | { kind: 'hug' };
export type Anchor = [number, number];
export interface LayoutSpec {
  width: SizeRule;
  height: SizeRule;
  positioning: 'flow' | 'absolute';
  anchorFrom: Anchor;
  anchorTo: Anchor;
  offset: Point;
  offsetPercent?: Point;
  minWidth: number;
  minHeight: number;
  maxWidth?: number;
  maxHeight?: number;
}
export interface FrameSpec {
  engineType: 'panel' | 'stack_panel';
  direction: 'free' | 'row' | 'column';
  gap: number;
  padding: [number, number, number, number]; // top, right, bottom, left
  justify: 'start' | 'center' | 'end' | 'space-between';
  align: 'start' | 'center' | 'end';
}
export type ImageMode = 'stretch' | 'fit' | 'fill' | 'crop' | 'original';
export interface ImageRecipe {
  kind: 'image';
  source: Id;
  mode: ImageMode;
  anchor: Anchor;
  scale: number;
  offset: Point;
  onlyDownscale: boolean;
}
export interface NineSliceRecipe {
  kind: 'nine-slice';
  source: Id;
  insets: [number, number, number, number]; // top, right, bottom, left
  mode: 'stretch' | 'tile';
}
export interface PaintRecipe {
  kind: 'paint';
  source: Id;
  mode: 'extend' | 'scale';
  origin: Point;
}
export type RenderRecipe = ImageRecipe | NineSliceRecipe | PaintRecipe;
export interface Appearance {
  fill: 'none' | 'solid' | 'linear';
  color: string;
  endColor: string;
  angle: number;
  strokeColor: string;
  strokeWidth: number;
}
export const defaultAppearance = (): Appearance => ({
  fill: 'none',
  color: '#ffffffff',
  endColor: '#000000ff',
  angle: 90,
  strokeColor: '#000000ff',
  strokeWidth: 0,
});
export interface UiNode {
  id: Id;
  name: string;
  kind: 'image' | 'frame';
  parent: Id | null;
  children: Id[];
  rect: Rect;
  visible: boolean;
  locked: boolean;
  opacity: number;
  layout: LayoutSpec;
  frame?: FrameSpec;
  content?: RenderRecipe;
  originalContent?: RenderRecipe;
  appearance?: Appearance;
  originalAppearance?: Appearance;
  originalOpacity?: number;
  originalRasterSize?: { width: number; height: number };
  rasterSize?: { width: number; height: number };
  suspended?: string;
}
export interface SourceAsset {
  id: Id;
  width: number;
  height: number;
  png: string;
  revision: number;
}
export interface NativeBinding {
  containerId: string;
  surfaceId?: string;
  textureId?: string;
  fingerprint?: string;
  groupOrigin?: [number, number, number];
}
export interface UiDocument {
  schemaVersion: 1;
  id: Id;
  roots: Id[];
  nodes: Record<Id, UiNode>;
  assets: Record<Id, SourceAsset>;
  bindings: Record<Id, NativeBinding>;
}
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export interface ResolvedNode {
  id: Id;
  rect: Rect;
  visible: boolean;
  locked: boolean;
  depth: number;
}
export interface ResolvedScene {
  nodes: Record<Id, ResolvedNode>;
  order: Id[];
}
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const fixed = (value: number): SizeRule => ({ kind: 'fixed', value });
export function defaultLayout(rect: Rect): LayoutSpec {
  return {
    width: fixed(rect.width),
    height: fixed(rect.height),
    positioning: 'flow',
    anchorFrom: [0, 0],
    anchorTo: [0, 0],
    offset: { x: rect.x, y: rect.y },
    minWidth: 1,
    minHeight: 1,
  };
}
export function defaultFrame(): FrameSpec {
  return {
    engineType: 'panel',
    direction: 'free',
    gap: 8,
    padding: [0, 0, 0, 0],
    justify: 'start',
    align: 'start',
  };
}
export function createDocument(id: Id): UiDocument {
  return { schemaVersion: 1, id, roots: [], nodes: {}, assets: {}, bindings: {} };
}
export function createNode(id: Id, name: string, kind: UiNode['kind'], rect: Rect): UiNode {
  return {
    id,
    name,
    kind,
    parent: null,
    children: [],
    rect,
    visible: true,
    locked: false,
    opacity: 1,
    layout: defaultLayout(rect),
    ...(kind !== 'image' ? { frame: defaultFrame() } : {}),
  };
}
