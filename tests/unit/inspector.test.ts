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

it('属性选区状态区分混合与不可用，逐轴保留共同值，0/空白不被首项替换', async () => {
  const { inspectProperty } = await import('../../src/application/inspector');
  const doc = createDocument('mixed'),
    a = createNode('a', 'a', 'frame', { x: 0, y: 0, width: 80, height: 32 }),
    b = createNode('b', 'b', 'image', { x: 0, y: 0, width: 40, height: 32 });
  const field = { read: (n: typeof a) => [n.rect.width, n.rect.height], dimensions: 2 };
  const mixed = inspectProperty(doc, [a, b], field);
  expect(mixed).toMatchObject({
    available: true,
    editable: true,
    mixed: true,
    value: undefined,
    axes: [undefined, 32],
  });
  expect(inspectProperty(doc, [a, b], { read: () => 0 }).value).toBe(0);
  expect(inspectProperty(doc, [a, b], { read: () => '' })).toMatchObject({
    mixed: false,
    value: '',
  });
  expect(
    inspectProperty(doc, [a, b], { ...field, applies: (n) => n.kind === 'frame' }),
  ).toMatchObject({ available: false, editable: false, mixed: false });
  b.suspended = 'external edit';
  expect(inspectProperty(doc, [a, b], field)).toMatchObject({
    available: true,
    editable: false,
    reason: 'external edit',
  });
});
it('共享字段策略拒绝 Frame/Image 部分写入，并识别 Stack/自由父级混选', async () => {
  const { fieldState, writeField } = await import('../../src/adapters/blockbench/property-fields');
  const doc = createDocument('mixed'),
    frame = createNode('f', 'f', 'frame', { x: 0, y: 0, width: 100, height: 80 }),
    image = createNode('i', 'i', 'image', { x: 0, y: 0, width: 32, height: 32 }),
    parent = createNode('p', 'p', 'frame', { x: 0, y: 0, width: 100, height: 80 });
  doc.nodes = { f: frame, i: image, p: parent };
  doc.roots = ['p'];
  frame.parent = parent.id;
  image.parent = frame.id;
  parent.frame!.direction = 'row';
  parent.frame!.engineType = 'stack_panel';
  expect(fieldState(doc, [frame, image], 'padding').available).toBe(false);
  const old = JSON.stringify(doc);
  expect(() => writeField(doc, ['f', 'i'], 'padding_horizontal', 8)).toThrow();
  expect(JSON.stringify(doc)).toBe(old);
  expect(fieldState(doc, [frame, image], 'offset').editable).toBe(false);
  expect(fieldState(doc, [frame, image], 'positioning').available).toBe(false);
  frame.layout.positioning = 'absolute';
  expect(fieldState(doc, [frame, image], 'offset').editable).toBe(true);
  writeField(doc, ['f', 'i'], 'size', Object.assign(['96px', ''], { changedAxis: 0 }));
  expect(frame.layout.width).toEqual({ kind: 'fixed', value: 96 });
  expect(image.layout.width).toEqual({ kind: 'fixed', value: 96 });
  expect(frame.layout.height).toEqual({ kind: 'fixed', value: 80 });
  expect(image.layout.height).toEqual({ kind: 'fixed', value: 32 });
});

it('Image 父容器不消费 flow/Hug 子项统计，角色控件不暴露无效设置', async () => {
  const { fieldState } = await import('../../src/adapters/blockbench/property-fields');
  const doc = createDocument('roles'),
    parent = createNode('p', 'p', 'image', { x: 0, y: 0, width: 100, height: 100 }),
    child = createNode('c', 'c', 'frame', { x: 0, y: 0, width: 40, height: 40 });
  child.parent = 'p';
  parent.children = ['c'];
  doc.nodes = { p: parent, c: child };
  doc.roots = ['p'];
  expect(fieldState(doc, [child], 'positioning').available).toBe(false);
  expect(fieldState(doc, [child], 'offset').editable).toBe(true);
  expect(fieldState(doc, [child], 'anchorFrom').editable).toBe(true);
});
