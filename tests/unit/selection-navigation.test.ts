import { it, expect } from 'vitest';
import { navigateSelection } from '../../src/application/selection-navigation';
import { createDocument, createNode } from '../../src/domain/types';
import { layout } from '../../src/domain/layout';
function setup() {
  const doc = createDocument('navigation');
  for (const [id, parent, kind] of [
    ['root', null, 'frame'],
    ['frame', 'root', 'frame'],
    ['a', 'frame', 'image'],
    ['image', 'root', 'image'],
    ['b', 'image', 'image'],
    ['leaf', 'root', 'image'],
    ['other', null, 'frame'],
    ['c', 'other', 'image'],
  ] as const) {
    const node = createNode(id, id, kind, { x: 0, y: 0, width: 100, height: 100 });
    node.parent = parent;
    doc.nodes[id] = node;
    (parent ? doc.nodes[parent]!.children : doc.roots).push(id);
  }
  const run = (ids: string[], direction: 'children' | 'parent') =>
    navigateSelection(doc, layout(doc), ids, direction);
  return { doc, run };
}
it('Enter 每次展开一级，Image 逻辑子项可导航，叶子保留且没有载体 Cube', () => {
  const { run } = setup();
  expect(run(['root'], 'children')).toEqual(['frame', 'image', 'leaf']);
  expect(run(['frame', 'image', 'leaf'], 'children')).toEqual(['a', 'b', 'leaf']);
  expect(run(['a', 'b', 'leaf'], 'children')).toEqual(['a', 'b', 'leaf']);
  expect(run([], 'children')).toEqual([]);
});
it('Shift+Enter 多父级去重且消除祖先/后代混选，根级保持', () => {
  const { run } = setup();
  expect(run(['b', 'a', 'a', 'c'], 'parent')).toEqual(['frame', 'image', 'other']);
  expect(run(['frame', 'b'], 'parent')).toEqual(['root']);
  expect(run(['root', 'other'], 'parent')).toEqual(['root', 'other']);
  expect(run(['root', 'a'], 'children')).toEqual(['frame', 'image', 'leaf']);
  expect(run(['missing'], 'parent')).toEqual([]);
});
it('隐藏、锁定、暂停节点及其后代不能通过层级导航进入', () => {
  const { doc, run } = setup();
  doc.nodes.frame!.visible = false;
  doc.nodes.image!.locked = true;
  expect(run(['root'], 'children')).toEqual(['leaf']);
  expect(run(['a', 'b'], 'parent')).toEqual([]);
  doc.nodes.leaf!.suspended = 'external edit';
  expect(run(['root'], 'children')).toEqual(['root']);
  doc.nodes.other!.suspended = 'external edit';
  expect(run(['c'], 'parent')).toEqual([]);
});
