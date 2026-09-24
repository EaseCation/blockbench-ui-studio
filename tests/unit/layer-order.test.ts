import { it, expect } from 'vitest';
import { reorderSelection } from '../../src/domain/layer-order';
import { createDocument, createNode } from '../../src/domain/types';
function fixture() {
  const d = createDocument('order');
  d.roots = ['a', 'b', 'c', 'd', 'e'];
  for (const id of d.roots)
    d.nodes[id] = createNode(id, id, 'frame', { x: 0, y: 0, width: 32, height: 32 });
  return d;
}
it('前后一步与首尾排序保留非连续多选和其余节点的相对顺序', () => {
  for (const [mode, expected] of [
    ['forward', ['a', 'c', 'b', 'e', 'd']],
    ['backward', ['b', 'a', 'd', 'c', 'e']],
    ['front', ['a', 'c', 'e', 'b', 'd']],
    ['back', ['b', 'd', 'a', 'c', 'e']],
  ] as const) {
    const d = fixture();
    expect(reorderSelection(d, ['b', 'd'], mode)).toBe(true);
    expect(d.roots).toEqual(expected);
  }
  const d = fixture();
  reorderSelection(d, ['b', 'c'], 'forward');
  expect(d.roots).toEqual(['a', 'd', 'b', 'c', 'e']);
});
it('跨父级独立排序，选中祖先时不重复移动后代，边界无操作', () => {
  const d = fixture();
  d.roots = ['a', 'd'];
  d.nodes.a!.children = ['b', 'c'];
  d.nodes.b!.parent = d.nodes.c!.parent = 'a';
  d.nodes.d!.children = ['e'];
  d.nodes.e!.parent = 'd';
  expect(reorderSelection(d, ['b', 'e'], 'front')).toBe(true);
  expect(d.nodes.a!.children).toEqual(['c', 'b']);
  expect(d.nodes.d!.children).toEqual(['e']);
  expect(reorderSelection(d, ['a', 'c'], 'front')).toBe(true);
  expect(d.roots).toEqual(['d', 'a']);
  expect(d.nodes.a!.children).toEqual(['c', 'b']);
  expect(reorderSelection(d, ['a'], 'forward')).toBe(false);
  expect(reorderSelection(d, ['a'], 'front')).toBe(false);
  expect(reorderSelection(d, [], 'back')).toBe(false);
});
