import { it, expect } from 'vitest';
import { parseSize, formatSize, stepExpression, resizeRule } from '../../src/domain/expression';
import { createDocument, createNode, fixed } from '../../src/domain/types';
import { layout } from '../../src/domain/layout';
function fixture() {
  const d = createDocument('d'),
    p = createNode('p', 'parent', 'frame', { x: 0, y: 0, width: 200, height: 100 });
  d.nodes.p = p;
  d.roots = ['p'];
  for (const [id, w, h] of [
    ['a', 40, 20],
    ['b', 60, 30],
    ['c', 80, 40],
  ] as const) {
    const n = createNode(id, id, 'image', { x: 0, y: 0, width: w, height: h });
    n.parent = 'p';
    d.nodes[id] = n;
    p.children.push(id);
  }
  return d;
}
it('解析全部Wiki尺寸单位、多项加减、空白与小数，往返保留公式', () => {
  for (const unit of ['%', '%c', '%cm', '%sm', '%x', '%y']) {
    const text = `75${unit} - 12px`;
    expect(formatSize(parseSize(text))).toBe(text);
    expect(formatSize(resizeRule(parseSize(text), 4, 88))).toBe(`75${unit} - 8px`);
    expect(stepExpression(text, 1, 'size')).toBe(`75${unit} - 11px`);
  }
  expect(formatSize(parseSize(' 50% + 25%y - 8px '))).toBe('50% + 25%y - 8px');
  expect(formatSize(parseSize('10px + 20px'))).toBe('30px');
  expect(formatSize(parseSize('.5%cm + 0.25px'))).toBe('0.5%cm + 0.25px');
  for (const text of ['default', 'fill', 'hug', '0px', '0.00000001px', '1000000000000000000000px'])
    expect(() => parseSize(formatSize(parseSize(text)))).not.toThrow();
  for (const text of [
    '',
    '100%cc',
    'calc(100% - 8px)',
    '100% / 2',
    '50% +',
    'NaN',
    'Infinity',
    'alert(1)',
    '1..2px',
    '$width',
  ])
    expect(() => parseSize(text)).toThrow();
});
it('父级、自身跨轴、default及组合参照按依赖计算', () => {
  const d = fixture();
  d.nodes.a!.layout.width = parseSize('50% + 50%y - 8px');
  expect(layout(d).nodes.a!.rect.width).toBe(102);
  d.nodes.a!.layout.height = parseSize('default');
  expect(layout(d).nodes.a!.rect.height).toBe(100);
  expect(layout(d).nodes.a!.rect.width).toBe(142);
  d.nodes.a!.layout.width = fixed(50);
  d.nodes.a!.layout.height = parseSize('150%x');
  expect(layout(d).nodes.a!.rect.height).toBe(75);
});
it('%c合计直接子项（不含位置、间距），%cm只取最大可见子项，Image同样可用', () => {
  const d = fixture();
  d.nodes.c!.visible = false;
  d.nodes.b!.layout.positioning = 'absolute';
  d.nodes.b!.layout.offset.x = 150;
  d.nodes.p!.layout.width = parseSize('100%c + 8px');
  expect(layout(d).nodes.p!.rect.width).toBe(188);
  d.nodes.p!.layout.width = parseSize('100%cm + 8px');
  expect(layout(d).nodes.p!.rect.width).toBe(68);
  d.nodes.p!.kind = 'image';
  delete d.nodes.p!.frame;
  expect(layout(d).nodes.p!.rect.width).toBe(68);
});
it('%sm为其他同级的最大尺寸，按同级变化自动更新且排除自身', () => {
  const d = fixture();
  d.nodes.a!.layout.width = parseSize('100%sm + 10px');
  expect(layout(d).nodes.a!.rect.width).toBe(90);
  d.nodes.c!.layout.width = fixed(120);
  expect(layout(d).nodes.a!.rect.width).toBe(130);
  d.nodes.c!.visible = false;
  expect(layout(d).nodes.a!.rect.width).toBe(130);
});
it('空子项为0；约束和九宫格下限仍生效；自引用/父子/同级循环明确拒绝', () => {
  const d = fixture();
  d.nodes.a!.layout.width = parseSize('100%cm');
  expect(layout(d).nodes.a!.rect.width).toBe(0);
  d.nodes.a!.layout.minWidth = 5;
  expect(layout(d).nodes.a!.rect.width).toBe(5);
  d.nodes.a!.layout.width = parseSize('100%x');
  expect(() => layout(d)).toThrow(/循环/);
  d.nodes.a!.layout.width = parseSize('0%x + 20px');
  expect(layout(d).nodes.a!.rect.width).toBe(20);
  d.nodes.a!.layout.width = parseSize('100%sm');
  d.nodes.b!.layout.width = parseSize('100%sm');
  expect(() => layout(d)).toThrow(/循环/);
  d.nodes.a!.layout.width = parseSize('100%');
  d.nodes.b!.layout.width = fixed(20);
  d.nodes.p!.layout.width = parseSize('100%cm');
  expect(() => layout(d)).toThrow(/循环/);
});

it('%sm换父级保留显示尺寸和参照比例，像素修正使用约束前的值', async () => {
  const { reparentNodes } = await import('../../src/domain/tree-editing');
  const d = fixture();
  const parent = createNode('other', 'other', 'frame', { x: 250, y: 0, width: 300, height: 100 }),
    peer = createNode('otherPeer', 'otherPeer', 'image', { x: 260, y: 0, width: 120, height: 20 });
  peer.parent = parent.id;
  parent.children = [peer.id];
  d.nodes[parent.id] = parent;
  d.nodes[peer.id] = peer;
  d.roots.push(parent.id);
  d.nodes.a!.layout.width = parseSize('100%sm + 8px');
  d.nodes.a!.layout.maxWidth = 100;
  const before = layout(d);
  for (const id of before.order) d.nodes[id]!.rect = { ...before.nodes[id]!.rect };
  reparentNodes(d, ['a'], 'other');
  const after = layout(d);
  expect(after.nodes.a!.rect.width).toBe(88);
  expect(formatSize(d.nodes.a!.layout.width)).toBe('100%sm - 32px');
});
