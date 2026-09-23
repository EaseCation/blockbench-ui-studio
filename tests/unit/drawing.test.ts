import { describe, it, expect } from 'vitest';
import {
  DrawingMachine,
  drawingRect,
  previewDrawing,
  insertDrawing,
  type DrawingPoint,
} from '../../src/application/drawing';
import { createDocument, createNode, defaultFrame } from '../../src/domain/types';
const point = (x: number, y: number, mod: Partial<DrawingPoint> = {}): DrawingPoint => ({
  world: { x, y },
  screen: { x: x * 2, y: y * 2 },
  shift: false,
  alt: false,
  space: false,
  ...mod,
});
describe('拖拽创建手势', () => {
  it('反向、Shift 正方形与 Alt 中心绘制落在整数像素', () => {
    expect(drawingRect({ x: 20, y: 20 }, { x: 8.2, y: 14.4 }, false, false)).toEqual({
      x: 8,
      y: 14,
      width: 12,
      height: 6,
    });
    expect(drawingRect({ x: 20, y: 20 }, { x: 8, y: 14 }, true, false)).toEqual({
      x: 8,
      y: 8,
      width: 12,
      height: 12,
    });
    expect(drawingRect({ x: 20, y: 20 }, { x: 8, y: 14 }, true, true)).toEqual({
      x: 8,
      y: 8,
      width: 24,
      height: 24,
    });
  });
  it('点击不创建；Space 移动绘制框并锁定起点容器', () => {
    const m = new DrawingMachine();
    m.begin('image', point(10, 10), { parentId: 'p' });
    expect(m.finish()).toBeNull();
    m.begin('frame', point(10, 10), { parentId: 'p' });
    m.update(point(30, 40));
    m.update(point(35, 42, { space: true }));
    expect(m.request!.rect).toEqual({ x: 15, y: 12, width: 20, height: 30 });
    expect(m.finish()!.target).toEqual({ parentId: 'p' });
    expect(m.request).toBeNull();
  });
  it('Stack 预览匹配最终排列，不改变原文档或分配源图', () => {
    const doc = createDocument('d'),
      p = createNode('p', 'Stack', 'frame', { x: 50, y: 30, width: 100, height: 80 });
    p.frame = {
      ...defaultFrame(),
      engineType: 'stack_panel',
      direction: 'row',
      padding: [4, 6, 4, 6],
    };
    doc.nodes.p = p;
    doc.roots = ['p'];
    const before = JSON.stringify(doc),
      request = {
        kind: 'image' as const,
        rect: { x: 80, y: 40, width: 20, height: 15 },
        target: { parentId: 'p', index: 0 },
      };
    expect(previewDrawing(doc, request)).toEqual({ x: 56, y: 34, width: 20, height: 15 });
    expect(JSON.stringify(doc)).toBe(before);
    p.locked = true;
    expect(() => previewDrawing(doc, request)).toThrow('不可编辑');
  });
  it('过大 Image 和失效目标在产生节点前拒绝', () => {
    const doc = createDocument('d');
    expect(() =>
      insertDrawing(doc, 'x', {
        kind: 'image',
        rect: { x: 0, y: 0, width: 8192, height: 8192 },
        target: null,
      }),
    ).toThrow('1600');
    expect(() =>
      insertDrawing(doc, 'x', {
        kind: 'frame',
        rect: { x: 0, y: 0, width: 10, height: 10 },
        target: { parentId: 'missing' },
      }),
    ).toThrow('不存在');
    expect(doc.roots).toEqual([]);
    expect(doc.nodes).toEqual({});
  });
});
