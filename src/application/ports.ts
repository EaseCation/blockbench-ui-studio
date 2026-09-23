import type { Id, Pixels, Rect, ResolvedScene, SourceAsset, UiDocument } from '../domain/types';
export interface NativeSnapshot {
  id: Id;
  rect: Rect;
  depth: number;
  name: string;
  visible: boolean;
  locked: boolean;
  fingerprint: string;
  pixelFingerprint: string;
  textureId?: string;
  unsupported?: string;
  parentId?: string;
  containerId?: string;
  kind?: 'image' | 'frame';
  surfaceId?: string;
  sourceId?: string;
  children?: Id[];
  generatedPixels?: Pixels;
  generated?: { provider: string; data: Record<string, unknown> };
  siblingIndex?: number;
}
export interface NativeSceneSnapshot {
  nodes: Record<Id, NativeSnapshot>;
  roots: Id[];
  selection: Id[];
}
export interface ImagePort {
  decode(png: string): Promise<Pixels>;
  encode(pixels: Pixels): string;
  id(): string;
}
export interface ProjectPort {
  read(): UiDocument | null;
  write(doc: UiDocument): void;
  snapshots(doc: UiDocument): Record<Id, NativeSnapshot>;
  unmanaged(doc: UiDocument): NativeSnapshot[];
  scene(doc: UiDocument): NativeSceneSnapshot;
  selection(doc: UiDocument): Id[];
}
export interface ScenePort {
  apply(
    doc: UiDocument,
    scene: ResolvedScene,
    bitmaps: Record<Id, Pixels>,
    previous: UiDocument | null,
  ): void;
  select(doc: UiDocument, ids: Id[]): void;
  previewMove(doc: UiDocument, ids: Id[], dx: number, dy: number): void;
  clearPreview(): void;
}
export interface TexturePort {
  pixels(textureId: string): Pixels | null;
  retainPaintLayers(source: Id, textureId: string, origin?: { x: number; y: number }): void;
  beginPaint(doc: UiDocument, id: Id, onSource: (png: string) => Promise<void>): void;
}
export interface HistoryPort {
  begin(label: string): void;
  commit(label: string): void;
  cancel(): void;
}
export interface HostPort extends ProjectPort, ScenePort, TexturePort, HistoryPort {
  message(text: string): void;
}
export interface ImportedImage {
  png: string;
  width: number;
  height: number;
  name: string;
}
export interface UiState {
  doc: UiDocument;
  scene: ResolvedScene;
  selection: Id[];
  interaction: 'figma' | 'native';
  view: '2d' | '3d';
  busy: boolean;
  error: string | null;
}
export interface CachedAsset {
  asset: SourceAsset;
  pixels: Pixels;
}
