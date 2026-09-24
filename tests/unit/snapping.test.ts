import { it, expect } from 'vitest';
import { SnapSession, snapReferences } from '../../src/application/snapping';
import { createDocument, createNode } from '../../src/domain/types';
import { layout } from '../../src/domain/layout';
it('中心及边缘吸附输出准确的参考细线，原始矩形保持不变', () => {
  const s = new SnapSession([
    { id: 'parent', parent: true, rect: { x: 0, y: 0, width: 100, height: 100 } },
  ]);
  const rect = { x: 43, y: 41, width: 20, height: 20 },
    before = { ...rect },
    d = s.align(rect, 4);
  expect(d).toEqual({ x: -3, y: -1 });
  expect(rect).toEqual(before);
  expect(s.guides({ ...rect, x: rect.x + d.x, y: rect.y + d.y })).toEqual([
    { axis: 'x', from: { x: 50, y: 0 }, to: { x: 50, y: 100 } },
    { axis: 'y', from: { x: 0, y: 50 }, to: { x: 100, y: 50 } },
  ]);
  const edge = new SnapSession([
    { id: 'peer', parent: false, rect: { x: 120, y: 40, width: 40, height: 30 } },
  ]);
  expect(edge.align({ x: 98, y: 10, width: 20, height: 20 }, 4, { y: [] })).toEqual({ x: 2, y: 0 });
});
it('迟滞防止附近目标跳动，越出释放范围后不继续拉扯，clear可立即绕过', () => {
  const s = new SnapSession([
    { id: 'p', parent: true, rect: { x: 0, y: 0, width: 100, height: 100 } },
  ]);
  const r = { x: 34, y: 20, width: 30, height: 20 };
  expect(s.align(r, 4, { y: [] }).x).toBe(1);
  expect(s.align({ ...r, x: 40 }, 4, { y: [] }).x).toBe(-5);
  expect(s.align({ ...r, x: 42 }, 4, { y: [] }).x).toBe(0);
  expect(s.guides({ ...r, x: 42 })).toEqual([]);
  s.align(r, 4);
  s.clear();
  expect(s.guides(r)).toEqual([]);
});
it('阈值随屏幕比例换算，绘制只吸附活动边并可限制整数坐标', () => {
  const refs = [{ id: 'p', parent: true, rect: { x: 0, y: 0, width: 101, height: 80 } }];
  const r = { x: 10, y: 12, width: 38, height: 20 };
  expect(new SnapSession(refs).align(r, 6 / 2, { x: [1], y: [] }).x).toBe(2.5);
  expect(new SnapSession(refs).align(r, 6 / 4, { x: [1], y: [] }).x).toBe(0);
  expect(
    new SnapSession(refs).align(r, 6 / 2, {
      x: [1],
      y: [],
      accept: (_, d) => Number.isInteger(r.x + r.width + d),
    }).x,
  ).toBe(0);
});
it('仅使用父级和同级，排除选区/后代/隐藏/暂停，锁定可用作参照', () => {
  const doc = createDocument('d');
  for (const [id, parent, kind] of [
    ['root', null, 'frame'],
    ['moving', 'root', 'image'],
    ['child', 'moving', 'image'],
    ['peer', 'root', 'image'],
    ['hidden', 'root', 'image'],
    ['paused', 'root', 'image'],
    ['outside', null, 'frame'],
  ] as const) {
    const n = createNode(id, id, kind, { x: 0, y: 0, width: 100, height: 80 });
    n.parent = parent;
    doc.nodes[id] = n;
    (parent ? doc.nodes[parent]!.children : doc.roots).push(id);
  }
  doc.nodes.hidden!.visible = false;
  doc.nodes.paused!.suspended = 'changed';
  doc.nodes.peer!.locked = true;
  expect(snapReferences(doc, layout(doc), ['moving']).map((r) => r.id)).toEqual(['root', 'peer']);
  expect(snapReferences(doc, layout(doc), ['root']).map((r) => r.id)).toEqual(['outside']);
  doc.nodes.outside!.rotation = 30;
  const scene = layout(doc);
  expect(snapReferences(doc, scene, [], null).find((r) => r.id === 'outside')!.rect).toEqual(
    scene.nodes.outside!.bounds,
  );
});

it('半像素定位的Stack仍量化共享Fill边界，不出现间隙或重叠', () => {
  const doc = createDocument('d'),
    p = createNode('p', 'p', 'frame', { x: 0.5, y: 0, width: 101, height: 40 });
  p.frame!.direction = 'row';
  p.frame!.engineType = 'stack_panel';
  p.frame!.gap = 0;
  doc.nodes.p = p;
  doc.roots = ['p'];
  for (const id of ['a', 'b']) {
    const n = createNode(id, id, 'image', { x: 0, y: 0, width: 1, height: 40 });
    n.parent = 'p';
    n.layout.width = { kind: 'fill' };
    doc.nodes[id] = n;
    p.children.push(id);
  }
  const s = layout(doc);
  expect(s.nodes.a!.rect.x).toBe(0.5);
  expect(s.nodes.b!.rect.x).toBe(s.nodes.a!.rect.x + s.nodes.a!.rect.width);
  expect(s.nodes.b!.rect.x + s.nodes.b!.rect.width).toBe(101.5);
});
