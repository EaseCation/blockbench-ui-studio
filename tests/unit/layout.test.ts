import { describe, it, expect } from 'vitest';
import { createDocument, createNode, defaultFrame, fixed } from '../../src/domain/types';
import { layout } from '../../src/domain/layout';
import { parseSize, parseOffset } from '../../src/domain/expression';
function fixture() {
  const d = createDocument('d'),
    p = createNode('p', '父', 'frame', { x: 0, y: 0, width: 101, height: 50 });
  d.nodes.p = p;
  d.roots = ['p'];
  p.frame = { ...defaultFrame(), direction: 'row', gap: 0 };
  for (const id of ['a', 'b']) {
    const n = createNode(id, id, 'layer', { x: 0, y: 0, width: 20, height: 10 });
    n.parent = 'p';
    d.nodes[id] = n;
    p.children.push(id);
  }
  return d;
}
describe('布局解析与依赖', () => {
  it('支持百分比加减绝对像素，拒绝代码和未支持单位', () => {
    expect(parseSize('75% + 12px')).toEqual({ kind: 'expression', percent: 0.75, pixels: 12 });
    expect(() => parseSize('100%cm')).toThrow();
    expect(() => parseSize('alert(1)')).toThrow();
  });
  it('父级尺寸改变，百分比子级自动变化', () => {
    const d = fixture();
    d.nodes.a!.layout.width = parseSize('100% - 16px');
    expect(layout(d).nodes.a!.rect.width).toBe(85);
    d.nodes.p!.layout.width = fixed(201);
    expect(layout(d).nodes.a!.rect.width).toBe(185);
  });
  it('Fill 按共享边界分配 101px，不产生空隙', () => {
    const d = fixture();
    for (const id of ['a', 'b']) d.nodes[id]!.layout.width = { kind: 'fill' };
    const s = layout(d);
    expect(s.nodes.a!.rect.width + s.nodes.b!.rect.width).toBe(101);
    expect(s.nodes.b!.rect.x).toBe(s.nodes.a!.rect.width);
  });
  it('Fill 扣除内边距和 gap', () => {
    const d = fixture();
    d.nodes.p!.frame!.padding = [0, 5, 0, 5];
    d.nodes.p!.frame!.gap = 3;
    for (const id of ['a', 'b']) d.nodes[id]!.layout.width = { kind: 'fill' };
    const s = layout(d);
    expect(s.nodes.a!.rect.x).toBe(5);
    expect(s.nodes.b!.rect.x + s.nodes.b!.rect.width).toBe(96);
  });
  it('Fill 重新分配超过 max 的剩余空间', () => {
    const d = fixture();
    for (const id of ['a', 'b']) d.nodes[id]!.layout.width = { kind: 'fill' };
    d.nodes.a!.layout.maxWidth = 20;
    const s = layout(d);
    expect(s.nodes.a!.rect.width).toBe(20);
    expect(s.nodes.b!.rect.width).toBe(81);
  });
  it('Hug 计算内容、间距与 padding', () => {
    const d = fixture();
    d.nodes.p!.layout.width = { kind: 'hug' };
    d.nodes.p!.frame!.gap = 3;
    d.nodes.p!.frame!.padding = [0, 5, 0, 5];
    expect(layout(d).nodes.p!.rect.width).toBe(53);
  });
  it('Hug/百分比循环明确报错', () => {
    const d = fixture();
    d.nodes.p!.layout.width = { kind: 'hug' };
    d.nodes.a!.layout.width = parseSize('100%');
    expect(() => layout(d)).toThrow(/循环/);
  });
  it('Hug 不计入隐藏和绝对定位子级', () => {
    const d = fixture();
    d.nodes.p!.layout.width = { kind: 'hug' };
    d.nodes.a!.layout.positioning = 'absolute';
    expect(layout(d).nodes.p!.rect.width).toBe(20);
  });
  it('锚点与 offset 结合', () => {
    const d = fixture();
    d.nodes.a!.layout.positioning = 'absolute';
    d.nodes.a!.layout.anchorFrom = [1, 1];
    d.nodes.a!.layout.anchorTo = [1, 1];
    d.nodes.a!.layout.offset = { x: -5, y: -5 };
    expect(layout(d).nodes.a!.rect).toEqual({ x: 76, y: 35, width: 20, height: 10 });
  });
  it('暂停规则保留原生矩形', () => {
    const d = fixture();
    d.nodes.a!.rect = { x: 17, y: 33, width: 44, height: 11 };
    d.nodes.a!.suspended = 'edited';
    expect(layout(d).nodes.a!.rect).toEqual(d.nodes.a!.rect);
  });
});

describe('百分比坐标', () => {
  it('解析负像素、百分比和加减像素', () => {
    expect(parseOffset('-8px')).toEqual({ percent: 0, pixels: -8 });
    expect(parseOffset('50% - 8px')).toEqual({ percent: 0.5, pixels: -8 });
    expect(() => parseOffset('fill')).toThrow();
  });
  it('位置随父级尺寸变化', () => {
    const d = fixture();
    d.nodes.p!.frame!.direction = 'free';
    d.nodes.p!.layout.width = fixed(320);
    d.nodes.a!.layout.offsetPercent = { x: 0.5, y: 0 };
    d.nodes.a!.layout.offset.x = -8;
    expect(layout(d).nodes.a!.rect.x).toBe(152);
    d.nodes.p!.layout.width = fixed(640);
    expect(layout(d).nodes.a!.rect.x).toBe(312);
  });
  it('根节点拒绝没有参照的百分比', () => {
    const d = fixture();
    d.nodes.p!.layout.offsetPercent = { x: 0.5, y: 0 };
    expect(() => layout(d)).toThrow(/参照父级/);
  });
  it('Hug 与百分比位置循环被拒绝', () => {
    const d = fixture();
    d.nodes.p!.frame!.direction = 'free';
    d.nodes.p!.layout.width = { kind: 'hug' };
    d.nodes.a!.layout.offsetPercent = { x: 0.5, y: 0 };
    expect(() => layout(d)).toThrow(/循环/);
  });
});
