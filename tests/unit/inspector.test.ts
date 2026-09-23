import { expect, it } from 'vitest';
import { common, editCompound, inspect, resizeStrategy } from '../../src/application/inspector';
import { createDocument, createNode } from '../../src/domain/types';

it('混合值保留零和 false，双轴 padding 不覆盖另外两边', () => {
  expect(common([0, 0])).toBe(0);
  expect(common([false, false])).toBe(false);
  expect(common([1, 2])).toBeUndefined();
  const node = createNode('f', 'frame', 'frame', { x: 0, y: 0, width: 100, height: 80 });
  node.frame!.padding = [1, 2, 3, 4];
  editCompound(node, 'padding_horizontal', 9);
  expect(node.frame!.padding).toEqual([1, 9, 3, 9]);
  expect(() => editCompound(node, 'padding_vertical', -1)).toThrow();
});

it('读取摘要不改写自定义锚点、非对称 padding 或约束', () => {
  const doc = createDocument('doc');
  const node = createNode('f', 'frame', 'frame', { x: 0, y: 0, width: 100, height: 80 });
  doc.nodes.f = node;
  doc.roots = ['f'];
  node.layout.anchorFrom = [0.5, 0.5];
  node.layout.maxWidth = 200;
  const before = JSON.stringify(doc),
    model = inspect(doc, [node]);
  expect(model.preset).toBeUndefined();
  expect(model.anchors).toBe('父中中 → 自身上左');
  expect(model.constraints).toBe('W ≤ 200');
  expect(JSON.stringify(doc)).toBe(before);
});

it('定位预设保留百分比偏移；尺寸策略保留九宫格约束', () => {
  const node = createNode('i', 'image', 'image', { x: 0, y: 0, width: 32, height: 16 });
  node.layout.offsetPercent = { x: 0.5, y: 0 };
  editCompound(node, 'anchorPreset', '0.5,0.5');
  expect(node.layout.anchorFrom).toEqual([0.5, 0.5]);
  expect(node.layout.anchorTo).toEqual([0.5, 0.5]);
  expect(node.layout.offsetPercent?.x).toBe(0.5);
  node.content = { kind: 'paint', source: 'a', origin: { x: 0, y: 0 }, mode: 'extend' };
  editCompound(node, 'resizeStrategy', 'preserve');
  expect(node.rasterSize).toEqual({ width: 32, height: 16 });
  editCompound(node, 'resizeStrategy', 'scale');
  expect(resizeStrategy(node)).toBe('scale');
  expect(node.rasterSize).toBeUndefined();
  node.content = { kind: 'nine-slice', source: 'a', insets: [2, 2, 2, 2], mode: 'tile' };
  expect(editCompound(node, 'resizeStrategy', 'preserve')).toBe(false);
  expect(resizeStrategy(node)).toBe('nine');
});
