import { it, expect } from 'vitest';
import { createDocument, createNode, fixed, type UiDocument } from '../../src/domain/types';
import { layout } from '../../src/domain/layout';
import { applyResolvedLayout } from '../../src/domain/auto-frame';
import { clone } from '../../src/domain/document';
import { corners, around, center, pointBounds } from '../../src/domain/transform';
import { setDirection } from '../../src/domain/layout-authoring';
import { parseSize, formatSize, stepExpression } from '../../src/domain/expression';
import { reparentNodes } from '../../src/domain/tree-editing';

function fixture() {
  const d = createDocument('d');
  for (const [id, kind, x, y, w, h, parent] of [
    ['root', 'frame', 10, 20, 400, 300, null],
    ['group', 'frame', 20, 30, 160, 90, 'root'],
    ['a', 'image', 10, 20, 30, 20, 'group'],
    ['b', 'image', 90, 40, 20, 10, 'group'],
  ] as const) {
    const n = createNode(id, id, kind, { x, y, width: w, height: h });
    n.parent = parent;
    d.nodes[id] = n;
    (parent ? d.nodes[parent]!.children : d.roots).push(id);
  }
  resolve(d);
  return d;
}
function resolve(d: UiDocument) {
  const s = layout(d);
  applyResolvedLayout(d, s);
  return s;
}
function enable(d: UiDocument, id = 'group') {
  d.nodes[id]!.layout.width = { kind: 'auto' };
  d.nodes[id]!.layout.height = { kind: 'auto' };
}
function stable(d: UiDocument) {
  const before = clone(d);
  for (let i = 0; i < 5; i++) resolve(d);
  for (const n of Object.values(d.nodes)) {
    const old = before.nodes[n.id]!;
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(n.rect[key], `${n.id}.${key}`).toBeCloseTo(old.rect[key], 7);
    expect(n.layout.offset.x).toBeCloseTo(old.layout.offset.x, 7);
    expect(n.layout.offset.y).toBeCloseTo(old.layout.offset.y, 7);
  }
}
it('Auto解析与步进；Image不可使用', () => {
  expect(formatSize(parseSize('auto'))).toBe('auto');
  expect(() => stepExpression('auto', 1, 'size')).toThrow(/布局计算/);
  const d = fixture();
  enable(d, 'a');
  expect(() => layout(d)).toThrow(/仅适用于 Frame/);
});
it('切换自动收紧四边；子项不跳位，布局纯函数且持久化后稳定', () => {
  const d = fixture(),
    before = clone(d);
  enable(d);
  const input = clone(d),
    scene = layout(d);
  expect(d).toEqual(input);
  applyResolvedLayout(d, scene);
  expect(d.nodes.group!.rect).toEqual({ x: 40, y: 70, width: 100, height: 30 });
  for (const id of ['a', 'b']) expect(d.nodes[id]!.rect).toEqual(before.nodes[id]!.rect);
  stable(d);
});
it('子项向左上移动只扩大边界，不移动兄弟；删除/隐藏后收缩', () => {
  const d = fixture();
  enable(d);
  resolve(d);
  const before = clone(d);
  d.nodes.a!.layout.offset.x -= 50;
  d.nodes.a!.layout.offset.y -= 60;
  resolve(d);
  expect(d.nodes.b!.rect).toEqual(before.nodes.b!.rect);
  expect(d.nodes.a!.rect.x).toBe(before.nodes.a!.rect.x - 50);
  expect(d.nodes.group!.rect).toEqual({ x: -10, y: 10, width: 150, height: 90 });
  stable(d);
  d.nodes.a!.visible = false;
  resolve(d);
  expect(d.nodes.group!.rect).toEqual(d.nodes.b!.rect);
  expect(d.nodes.b!.rect).toEqual(before.nodes.b!.rect);
  stable(d);
});
it('绝对子项计入自由边界，隐藏子项不计入；空容器保持可用尺寸', () => {
  const d = fixture();
  enable(d);
  d.nodes.b!.layout.positioning = 'absolute';
  resolve(d);
  expect(d.nodes.group!.rect.width).toBe(100);
  d.nodes.a!.visible = false;
  d.nodes.b!.visible = false;
  const r = { ...d.nodes.group!.rect };
  resolve(d);
  expect(d.nodes.group!.rect).toEqual(r);
  stable(d);
});
it('百分比坐标与锚点保留系数，通过像素偏移归一化保持世界位置', () => {
  const d = fixture(),
    a = d.nodes.a!;
  a.layout.offsetPercent = { x: 0.25, y: 0.1 };
  a.layout.anchorFrom = [0.5, 0.5];
  a.layout.anchorTo = [0.5, 0.5];
  resolve(d);
  const before = clone(d);
  enable(d);
  resolve(d);
  expect(a.rect).toEqual(before.nodes.a!.rect);
  expect(a.layout.offsetPercent).toEqual({ x: 0.25, y: 0.1 });
  stable(d);
});
it('旋转子项完整包围，旋转父Frame重定中心不改变子项的世界四角', () => {
  const d = fixture();
  d.nodes.group!.rotation = 27;
  d.nodes.a!.rotation = 33;
  const before = resolve(d);
  enable(d);
  const after = resolve(d);
  for (const id of ['a', 'b'])
    for (let i = 0; i < 4; i++) {
      expect(after.nodes[id]!.corners![i]!.x).toBeCloseTo(before.nodes[id]!.corners![i]!.x, 7);
      expect(after.nodes[id]!.corners![i]!.y).toBeCloseTo(before.nodes[id]!.corners![i]!.y, 7);
    }
  const a = d.nodes.a!,
    b = d.nodes.b!;
  const box = pointBounds([
    ...corners(a.rect, around(center(a.rect), a.rotation!)),
    ...corners(b.rect),
  ]);
  expect(d.nodes.group!.rect.width).toBeCloseTo(box.width, 7);
  stable(d);
});
it('多层Auto及单轴Auto保持子项位置，旋转与内边距不导致漂移', () => {
  const d = fixture();
  d.nodes.root!.rotation = -17;
  d.nodes.group!.rotation = 37;
  d.nodes.group!.frame!.padding = [3, 5, 7, 9];
  const before = resolve(d);
  enable(d);
  enable(d, 'root');
  d.nodes.group!.layout.height = fixed(90);
  const after = resolve(d);
  for (const id of ['a', 'b'])
    for (let i = 0; i < 4; i++) {
      expect(after.nodes[id]!.corners![i]!.x).toBeCloseTo(before.nodes[id]!.corners![i]!.x, 7);
      expect(after.nodes[id]!.corners![i]!.y).toBeCloseTo(before.nodes[id]!.corners![i]!.y, 7);
    }
  expect(d.nodes.group!.rect.height).toBe(90);
  stable(d);
});
it('Stack Auto包含间距内边距，不包含绝对子项，切回自由模式保留可见位置', () => {
  const d = fixture(),
    g = d.nodes.group!;
  enable(d);
  setDirection(d, g, 'row');
  g.frame!.gap = 8;
  g.frame!.padding = [2, 4, 6, 8];
  g.frame!.justify = 'space-between';
  resolve(d);
  expect(g.rect.width).toBe(70);
  expect(g.rect.height).toBe(28);
  const before = clone(d);
  setDirection(d, g, 'free');
  resolve(d);
  expect(g.layout.width.kind).toBe('auto');
  expect(d.nodes.a!.rect).toEqual(before.nodes.a!.rect);
  expect(d.nodes.b!.rect).toEqual(before.nodes.b!.rect);
  stable(d);
});
it('Auto容器作为Stack子项时服从流式位置，不被内容偏移推离槽位', () => {
  const d = fixture();
  enable(d);
  enable(d, 'root');
  setDirection(d, d.nodes.root!, 'row');
  const s = resolve(d);
  expect(s.nodes.group!.rect.x).toBe(s.nodes.root!.rect.x);
  stable(d);
});
it('暂停子项保护整个自动边界；恢复后才能收紧', () => {
  const d = fixture();
  enable(d);
  d.nodes.a!.suspended = 'native edit';
  const before = clone(d);
  resolve(d);
  expect(d.nodes.group!.rect).toEqual(before.nodes.group!.rect);
  delete d.nodes.a!.suspended;
  resolve(d);
  expect(d.nodes.group!.rect.width).toBe(100);
});
it('父级百分比/Fill循环明确拒绝，固定另一轴允许百分比依赖', () => {
  const d = fixture();
  enable(d);
  for (const rule of [parseSize('100% - 4px'), parseSize('fill'), parseSize('default')]) {
    d.nodes.a!.layout.width = rule;
    expect(() => layout(d)).toThrow(/循环/);
  }
  d.nodes.group!.layout.width = fixed(160);
  d.nodes.a!.layout.width = parseSize('50%');
  resolve(d);
  expect(d.nodes.a!.rect.width).toBe(80);
  stable(d);
});
it('移动与换父级保留Auto模式；新父级的已有兄弟不跳位', () => {
  const d = fixture();
  enable(d);
  resolve(d);
  reparentNodes(d, ['group'], null);
  resolve(d);
  expect(d.nodes.group!.layout.width.kind).toBe('auto');
  stable(d);
});

it('旋转子项形成小数边界后锁定当前尺寸，不改变边界或像素位置', () => {
  const d = fixture();
  enable(d);
  d.nodes.a!.rotation = 37;
  resolve(d);
  const before = clone(d),
    g = d.nodes.group!;
  g.layout.width = fixed(g.rect.width);
  g.layout.height = fixed(g.rect.height);
  resolve(d);
  for (const id of ['group', 'a', 'b']) expect(d.nodes[id]!.rect).toEqual(before.nodes[id]!.rect);
  stable(d);
});

it('独立轴测量允许Auto宽→百分比高→子高；只有真实尺寸依赖才报循环', () => {
  const d = fixture(),
    g = d.nodes.group!,
    a = d.nodes.a!;
  g.layout.width = { kind: 'auto' };
  g.layout.height = parseSize('100%x');
  a.layout.height = parseSize('100%');
  resolve(d);
  expect(g.rect.width).toBe(100);
  expect(g.rect.height).toBe(100);
  expect(a.rect.height).toBe(100);
  stable(d);
  a.rotation = 30;
  expect(() => layout(d)).toThrow(/循环/);
});
