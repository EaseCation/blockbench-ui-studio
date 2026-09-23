import { it, expect } from 'vitest';
import { selectMarquee, marqueeScope } from '../../src/application/marquee';
import { createDocument, createNode, type Rect } from '../../src/domain/types';
import type { PickNode } from '../../src/application/targets';
function fixture() {
  const d = createDocument('d'),
    nodes: PickNode[] = [];
  for (const [id, kind, parent, x, y, w, h] of [
    ['board', 'frame', null, 0, 0, 400, 300],
    ['card', 'frame', 'board', 30, 30, 170, 120],
    ['row', 'frame', 'card', 50, 55, 120, 45],
    ['a', 'image', 'row', 55, 60, 20, 20],
    ['b', 'image', 'row', 100, 60, 20, 20],
    ['c', 'image', 'card', 55, 115, 20, 20],
    ['image', 'image', 'board', 240, 40, 120, 100],
    ['child', 'image', 'image', 270, 60, 25, 25],
    ['empty', 'frame', 'board', 260, 190, 30, 25],
    ['other', 'frame', null, 450, 0, 200, 250],
    ['otherChild', 'image', 'other', 475, 40, 20, 20],
  ] as const) {
    const n = createNode(id, id, kind, { x, y, width: w, height: h });
    n.parent = parent;
    d.nodes[id] = n;
    (parent ? d.nodes[parent]!.children : d.roots).push(id);
    nodes.push({
      id,
      kind,
      rect: n.rect,
      rank: nodes.length,
      level: parent ? nodes.find((n) => n.id === parent)!.level + 1 : 0,
      disabled: false,
    });
  }
  const pick = (r: Rect, scope: string | null = 'board', deep = false, previous: string[] = []) =>
    selectMarquee(d, nodes, r, scope, deep, previous);
  return { d, nodes, pick };
}
it('普通框选将局部子项提升为作用域外层Frame，不要求框住整个Frame', () => {
  const { pick } = fixture();
  expect(pick({ x: 20, y: 20, width: 115, height: 70 })).toEqual(['card']);
});
it('在Frame内部空白起手允许选择内部，跨出时提升到共同外层', () => {
  const { d, nodes, pick } = fixture();
  expect(marqueeScope(d, nodes, { x: 40, y: 40 })).toBe('card');
  expect(pick({ x: 40, y: 40, width: 95, height: 60 }, 'card')).toEqual(['row']);
  expect(pick({ x: 20, y: 20, width: 115, height: 90 }, 'card')).toEqual(['card']);
});
it('画布起手混合多个画板时只取根级，不混入另一画板子项', () => {
  const { pick } = fixture();
  expect(pick({ x: -10, y: -10, width: 510, height: 150 }, null)).toEqual(['board', 'other']);
});
it('深层框选返回内部Image且排除命中的父层', () => {
  const { pick } = fixture();
  expect(pick({ x: 20, y: 20, width: 180, height: 130 }, 'board', true)).toEqual(['a', 'b', 'c']);
  expect(pick({ x: 225, y: 25, width: 140, height: 120 }, 'board', true)).toEqual(['child']);
});
it('父Image只命中其自身绘画区域时仍可选择，空Frame可框选', () => {
  const { pick } = fixture();
  expect(pick({ x: 230, y: 90, width: 120, height: 40 }, 'board', true)).toEqual(['image']);
  expect(pick({ x: 250, y: 180, width: 50, height: 50 }, 'board', true)).toEqual(['empty']);
});
it('Shift普通归并父层，Shift深层替换旧祖先并保留不相关选择', () => {
  const { pick } = fixture();
  const rect = { x: 45, y: 50, width: 40, height: 40 };
  expect(pick(rect, 'board', false, ['b', 'other'])).toEqual(['board', 'other']);
  expect(pick(rect, 'board', true, ['card', 'other'])).toEqual(['a', 'other']);
});
it('隐藏、锁定、暂停及受影响后代不命中也不提升', () => {
  const { pick, nodes } = fixture();
  nodes.find((n) => n.id === 'card')!.disabled = true;
  expect(pick({ x: 20, y: 20, width: 180, height: 130 }, 'board', true)).toEqual([]);
  expect(pick({ x: 20, y: 20, width: 180, height: 130 })).toEqual([]);
});
it('完全包围作用域时提升到上一层，深层仍不返回父子重复项', () => {
  const { pick } = fixture();
  const rect = { x: -10, y: -10, width: 420, height: 320 };
  expect(pick(rect)).toEqual(['board']);
  expect(pick(rect, 'board', true)).toEqual(['a', 'b', 'c', 'child', 'empty']);
});
