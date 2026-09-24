import { describe, it, expect } from 'vitest';
import { pickNode, pickDrop, type PickNode } from '../../src/application/targets';
import { createDocument, createNode, defaultFrame } from '../../src/domain/types';
import { reparentNodes } from '../../src/domain/tree-editing';
const node = (
  id: string,
  kind: 'image' | 'frame',
  x: number,
  rank: number,
  level = 0,
): PickNode => ({
  id,
  kind,
  rect: { x, y: 0, width: 100, height: 100 },
  rank,
  level,
  disabled: false,
});
describe('逻辑命中与放入目标', () => {
  it('Frame 名称/边框可点击，内部空白不阻挡框选，Image 不依赖像素透明度', () => {
    const f = node('f', 'frame', 0, 0);
    f.label = { x: 0, y: -22, width: 60, height: 20 };
    expect(pickNode([f], { x: 50, y: 50 })).toBeNull();
    expect(pickNode([f], { x: 4, y: 50 })).toBe('f');
    expect(pickNode([f], { x: 30, y: -10 })).toBe('f');
    const a = node('a', 'image', 20, 1),
      b = node('b', 'image', 20, 2);
    expect(pickNode([a, b], { x: 50, y: 50 })).toBe('b');
    b.disabled = true;
    expect(pickNode([a, b], { x: 50, y: 50 })).toBe('a');
  });
  it('放入命中排除选区及后代，开关关闭仍允许原 Stack 内插入', () => {
    const d = createDocument('d');
    for (const id of ['p', 'a', 'b'])
      d.nodes[id] = createNode(id, id, id === 'p' ? 'frame' : 'image', {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
    d.roots = ['p'];
    d.nodes.p!.children = ['a', 'b'];
    d.nodes.a!.parent = d.nodes.b!.parent = 'p';
    d.nodes.p!.frame = { ...defaultFrame(), engineType: 'stack_panel', direction: 'row' };
    const nodes = [
      node('p', 'frame', 0, 0),
      { ...node('a', 'image', 0, 1, 1), rect: { x: 0, y: 0, width: 30, height: 30 } },
      { ...node('b', 'image', 60, 2, 1), rect: { x: 60, y: 0, width: 30, height: 30 } },
    ];
    expect(pickDrop(d, nodes, ['a'], { x: 70, y: 15 }, true)?.parentId).toBe('b');
    expect(pickDrop(d, nodes, ['a'], { x: 60, y: 15 }, true)?.parentId).toBe('p');
    expect(pickDrop(d, nodes, ['a'], { x: 70, y: 15 }, false)?.parentId).toBe('p');
    expect(pickDrop(d, nodes, ['p'], { x: 70, y: 15 }, true)).toBeNull();
  });
  it('换父级保留世界尺寸和百分比，根级移出消除无效参照', () => {
    const d = createDocument('d'),
      p = createNode('p', 'p', 'frame', { x: 100, y: 0, width: 200, height: 100 }),
      a = createNode('a', 'a', 'image', { x: 20, y: 8, width: 40, height: 30 });
    d.nodes = { p, a };
    d.roots = ['p', 'a'];
    a.layout.width = { kind: 'expression', percent: 0.5, pixels: 0 };
    reparentNodes(d, ['a'], 'p');
    expect(a.layout.width).toEqual({ kind: 'expression', percent: 0.5, pixels: -60 });
    expect(a.layout.offset.x).toBe(-80);
    reparentNodes(d, ['a'], null);
    expect(a.layout.width).toEqual({ kind: 'fixed', value: 40 });
    expect(a.layout.offset.x).toBe(20);
  });
});

it('已选容器优先承接内部起拖，未选内部仍框选，标签及禁用状态保留优先级', () => {
  const frame = node('f', 'frame', 0, 0),
    child = node('child', 'image', 20, 3, 1);
  const p = { x: 50, y: 50 };
  expect(pickNode([frame, child], p, ['f'])).toBe('f');
  expect(pickNode([frame], p, ['f'])).toBe('f');
  expect(pickNode([frame], p)).toBeNull();
  expect(pickNode([frame, child], p)).toBe('child');
  expect(pickNode([frame, child], p, ['child'])).toBe('child');
  frame.disabled = true;
  expect(pickNode([frame, child], p, ['f'])).toBe('child');
  frame.disabled = false;
  const label = node('label', 'frame', 200, 4);
  label.label = { x: 40, y: 40, width: 50, height: 20 };
  expect(pickNode([frame, child, label], p, ['f'])).toBe('label');
});
it('多选间隙和旋转 Frame 外接矩形不成为选区拖动区域', () => {
  const a = node('a', 'frame', 0, 0),
    b = node('b', 'frame', 200, 1);
  expect(pickNode([a, b], { x: 150, y: 50 }, ['a', 'b'])).toBeNull();
  a.polygon = [
    { x: 50, y: 0 },
    { x: 100, y: 50 },
    { x: 50, y: 100 },
    { x: 0, y: 50 },
  ];
  const child = node('child', 'image', 0, 2, 1);
  expect(pickNode([a, child], { x: 50, y: 50 }, ['a'])).toBe('a');
  expect(pickNode([a, child], { x: 15, y: 15 }, ['a'])).toBe('child');
});
