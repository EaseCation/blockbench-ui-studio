import { it, expect } from 'vitest';
import { createDocument, createNode, fixed } from '../../src/domain/types';
import { groupNodes, ungroupNodes } from '../../src/domain/grouping';
import { layout } from '../../src/domain/layout';
import { clone, validateDocument } from '../../src/domain/document';
function fixture() {
  const d = createDocument('d');
  d.assets.source = { id: 'source', width: 1, height: 1, png: '', revision: 1 };
  for (const [id, kind, x, y, w, h, parent] of [
    ['root', 'frame', 10, 10, 320, 200, null],
    ['f', 'frame', 20, 20, 140, 90, 'root'],
    ['a', 'image', 10, 10, 20, 20, 'f'],
    ['b', 'image', 70, 10, 30, 20, 'f'],
    ['image', 'image', 190, 20, 30, 30, 'root'],
    ['nested', 'image', 35, 0, 20, 20, 'image'],
  ] as const) {
    const n = createNode(id, id, kind, { x, y, width: w, height: h });
    n.parent = parent;
    if (kind === 'image')
      n.content = { kind: 'paint', source: 'source', mode: 'extend', origin: { x: 0, y: 0 } };
    d.nodes[id] = n;
    (parent ? d.nodes[parent]!.children : d.roots).push(id);
  }
  resolve(d);
  return d;
}
function resolve(d: ReturnType<typeof createDocument>) {
  const s = layout(d);
  for (const id of s.order) d.nodes[id]!.rect = { ...s.nodes[id]!.rect };
  return s;
}
it('不同父级的选区放入公共祖先的Frame，内部顺序和世界边界不变', () => {
  const d = fixture(),
    before = clone(d);
  groupNodes(d, ['nested', 'b', 'a'], 'group');
  validateDocument(d);
  expect(d.nodes.group!.parent).toBe('root');
  expect(d.nodes.group!.children).toEqual(['a', 'b', 'nested']);
  resolve(d);
  for (const id of ['a', 'b', 'nested']) expect(d.nodes[id]!.rect).toEqual(before.nodes[id]!.rect);
});
it('百分比与锚点重算像素项；单个Image可编组再解除', () => {
  const d = fixture();
  d.nodes.a!.layout.offsetPercent = { x: 0.25, y: 0.1 };
  d.nodes.a!.layout.width = { kind: 'expression', percent: 0.5, pixels: -10 };
  d.nodes.a!.layout.anchorTo = [0.5, 0.5];
  resolve(d);
  const before = clone(d.nodes.a!.rect);
  groupNodes(d, ['a'], 'group');
  resolve(d);
  expect(d.nodes.a!.rect).toEqual(before);
  expect(d.nodes.a!.layout.offsetPercent).toEqual({ x: 0.25, y: 0.1 });
  expect(d.nodes.a!.layout.width).toMatchObject({ kind: 'expression', percent: 0.5 });
  ungroupNodes(d, ['group']);
  resolve(d);
  expect(d.nodes.a!.rect).toEqual(before);
});
it('全部解组去除Frame但保留每个Image及其内容顺序，叶子解组无损', () => {
  const d = fixture(),
    before = clone(d);
  const ids = ungroupNodes(d, ['root'], true);
  expect(ids).toEqual(['a', 'b', 'image', 'nested']);
  expect(d.roots).toEqual(ids);
  expect(Object.values(d.nodes).every((n) => n.kind === 'image' && !n.children.length)).toBe(true);
  resolve(d);
  for (const id of ids) expect(d.nodes[id]!.rect).toEqual(before.nodes[id]!.rect);
  const flat = clone(d);
  ungroupNodes(d, ['a', 'b'], true);
  expect(d).toEqual(flat);
});
it('解开Image保留背景本身；解除隐藏父级仍保持原有隐藏状态', () => {
  const d = fixture();
  d.nodes.image!.visible = false;
  ungroupNodes(d, ['image']);
  expect(d.nodes.image!.children).toEqual([]);
  expect(d.nodes.nested!.parent).toBe('root');
  expect(d.nodes.nested!.visible).toBe(false);
  expect(d.nodes.image!.visible).toBe(false);
});
it('Stack连续流式子项可编组，拒绝会悄悄改变剩余布局的拆分', () => {
  const d = fixture();
  d.nodes.f!.frame!.direction = 'row';
  d.nodes.f!.frame!.engineType = 'stack_panel';
  d.nodes.f!.frame!.gap = 8;
  d.nodes.f!.layout.width = fixed(140);
  resolve(d);
  const before = clone(d);
  groupNodes(d, ['a', 'b'], 'group');
  resolve(d);
  expect(d.nodes.a!.rect).toEqual(before.nodes.a!.rect);
  expect(d.nodes.b!.rect).toEqual(before.nodes.b!.rect);
  const grouped = clone(d);
  expect(() => ungroupNodes(d, ['group'])).toThrow(/自由布局/);
  expect(d).toEqual(grouped);
});
it('锁定或暂停的选择不能通过编组绕过保护', () => {
  const d = fixture();
  d.nodes.a!.locked = true;
  expect(() => groupNodes(d, ['a'], 'x')).toThrow(/解锁/);
  d.nodes.a!.locked = false;
  d.nodes.a!.suspended = 'UV changed';
  expect(() => ungroupNodes(d, ['root'], true)).toThrow(/暂停/);
});
