import type { Pixels } from '../domain/types';
export type ContentData = Record<string, unknown>;
export interface ContentProvider {
  id: string;
  title: string;
  icon: string;
  prepare(data: ContentData): Promise<void>;
  ready(data: ContentData): boolean;
  key(data: ContentData): string;
  measure(data: ContentData, width?: number): { width: number; height: number };
  render(data: ContentData, size: { width: number; height: number }): Pixels;
  edit(id: string): void;
  fallback?(surfaceId: string): Pixels | null;
  seal?(surfaceId: string, data: ContentData): ContentData;
  resources?(): unknown;
  importResources?(resources: unknown): void;
}
/** Pure-data extension boundary. Registry lifetime belongs to the host adapter. */
export const contentProviders = new Map<string, ContentProvider>();
