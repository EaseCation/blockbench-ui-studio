import { describe, it, expect } from 'vitest';
import { createDocument, createNode, defaultFrame, fixed } from '../../src/domain/types';
import { setDirection, setPositioning, sizeModeError } from '../../src/domain/layout-authoring';
import { layout } from '../../src/domain/layout';
import { parseSize, parseOffset } from '../../src/domain/expression';
function fixture() {
  const d = createDocument('d'),
    p = createNode('p', '父', 'frame', { x: 0, y: 0, width: 101, height: 50 });
  d.nodes.p = p;
  d.roots = ['p'];
  p.frame = { ...defaultFrame(), engineType: 'stack_panel', direction: 'row', gap: 0 };
  for (const id of ['a', 'b']) {
    const n = createNode(id, id, 'image', { x: 0, y: 0, width: 20, height: 10 });
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

describe('布局编辑保持显示位置', () => {
  it('退出自动布局冻结 Fill 子项和 Hug 容器，保留解析后的边界', () => {
    const doc = fixture(),
      parent = doc.nodes.p!;
    doc.nodes.a!.layout.width = { kind: 'fill' };
    parent.frame!.padding = [4, 5, 6, 7];
    const before = layout(doc);
    for (const [id, n] of Object.entries(doc.nodes)) n.rect = { ...before.nodes[id]!.rect };
    setDirection(doc, parent, 'free');
    const after = layout(doc);
    expect(after.nodes.a!.rect).toEqual(before.nodes.a!.rect);
    expect(after.nodes.b!.rect).toEqual(before.nodes.b!.rect);
  });
  it('脱离自动排列转绝对定位时保持位置和尺寸', () => {
    const doc = fixture(),
      parent = doc.nodes.p!,
      child = doc.nodes.b!;
    child.layout.width = { kind: 'fill' };
    parent.frame!.justify = 'end';
    parent.frame!.align = 'end';
    const before = layout(doc);
    for (const [id, n] of Object.entries(doc.nodes)) n.rect = { ...before.nodes[id]!.rect };
    setPositioning(doc, child, 'absolute');
    expect(layout(doc).nodes.b!.rect).toEqual(before.nodes.b!.rect);
  });
  it('尺寸候选预检阻止根百分比和循环而不改文档', () => {
    const doc = fixture();
    doc.nodes.p!.layout.width = { kind: 'hug' };
    const before = JSON.stringify(doc);
    expect(sizeModeError(doc, ['p'], 'width', 'expression')).toContain('没有父级');
    expect(sizeModeError(doc, ['a'], 'width', 'fill')).toContain('循环');
    expect(sizeModeError(doc, ['a'], 'width', 'fixed')).toBeNull();
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('可测量内容', () => {
  function textFixture() {
    const d = fixture();
    const text = d.nodes.a!;
    d.nodes.p!.frame!.direction = 'column';
    d.nodes.p!.layout.height = { kind: 'hug' };
    text.content = {
      kind: 'generated',
      provider: 'text',
      source: 's',
      logicalSize: { width: 40, height: 10 },
    };
    text.layout.width = { kind: 'expression', percent: 1, pixels: -1 };
    text.layout.height = { kind: 'hug' };
    return d;
  }
  const measure = (_n: unknown, width = 200) => ({ width, height: Math.ceil(200 / width) * 10 });
  it('宽度约束先参与测量，包裹高度影响 Stack 后续子项和父高度', () => {
    const d = textFixture();
    let s = layout(d, measure);
    expect(s.nodes.a!.rect.height).toBe(20);
    expect(s.nodes.b!.rect.y).toBe(20);
    d.nodes.p!.layout.width = fixed(51);
    s = layout(d, measure);
    expect(s.nodes.a!.rect.height).toBe(40);
    expect(s.nodes.b!.rect.y).toBe(40);
    expect(s.nodes.p!.rect.height).toBe(50);
  });
  it('缺少提供者时使用已保存的逻辑尺寸，而非高清贴图尺寸', () => {
    const d = textFixture();
    d.assets.s = { id: 's', width: 160, height: 40, png: '', revision: 1 };
    expect(layout(d).nodes.a!.rect.height).toBe(10);
  });
  it('文字测量不能绕过父子 Hug / 百分比循环检查', () => {
    const d = textFixture();
    d.nodes.p!.layout.width = { kind: 'hug' };
    expect(() => layout(d, measure)).toThrow(/循环/);
  });
});

describe('大规模 Fill 分配', () => {
  it('一次分配整组约束并保留共享边界，下一次布局重新计算', () => {
    const d = createDocument('large'),
      p = createNode('p', 'stack', 'frame', { x: 0, y: 0, width: 19500, height: 40 });
    d.nodes.p = p;
    d.roots = ['p'];
    p.frame = { ...defaultFrame(), engineType: 'stack_panel', direction: 'row', gap: 0 };
    for (let i = 0; i < 1500; i++) {
      const n = createNode('n' + i, 'item', 'image', { x: 0, y: 0, width: 10, height: 10 });
      n.parent = p.id;
      n.layout.width = { kind: 'fill' };
      if (i % 10 === 0) n.layout.maxWidth = 5;
      d.nodes[n.id] = n;
      p.children.push(n.id);
    }
    const start = performance.now(),
      scene = layout(d);
    expect(performance.now() - start).toBeLessThan(250);
    for (let i = 0; i < 1500; i++) {
      const r = scene.nodes['n' + i]!.rect;
      if (i % 10 === 0) expect(r.width).toBe(5);
      if (i > 0) {
        const before = scene.nodes['n' + (i - 1)]!.rect;
        expect(r.x).toBe(before.x + before.width);
      }
    }
    const last = scene.nodes.n1499!.rect;
    expect(last.x + last.width).toBe(19500);
    p.layout.width = fixed(21000);
    const resized = layout(d).nodes.n1499!.rect;
    expect(resized.x + resized.width).toBe(21000);
    expect(() => {
      p.layout.width = { kind: 'hug' };
      layout(d);
    }).toThrow(/循环/);
  });
});
