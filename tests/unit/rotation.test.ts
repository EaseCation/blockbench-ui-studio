import { it, expect } from 'vitest';
import { pinchZoom, wheelZoom } from '../../src/application/zoom';
import { createDocument, createNode, type UiDocument } from '../../src/domain/types';
import { center, normalizeAngle, worldPose } from '../../src/domain/transform';
import { layout } from '../../src/domain/layout';
import { reparentNodes } from '../../src/domain/tree-editing';
import { groupNodes, ungroupNodes } from '../../src/domain/grouping';
import { pickNode, pickDrop, type PickNode } from '../../src/application/targets';
function scene() {
  const d = createDocument('rotation');
  const p = createNode('parent', 'parent', 'frame', { x: 40, y: 30, width: 100, height: 80 });
  p.rotation = 35;
  const c = createNode('child', 'child', 'image', { x: 52, y: 44, width: 30, height: 20 });
  c.rotation = -15;
  c.parent = p.id;
  c.layout.offset = { x: 12, y: 14 };
  p.children.push(c.id);
  const target = createNode('target', 'target', 'frame', {
    x: 210,
    y: 30,
    width: 120,
    height: 100,
  });
  target.rotation = -20;
  d.nodes = { parent: p, child: c, target };
  d.roots = ['parent', 'target'];
  return d;
}
function resolve(d: UiDocument) {
  const s = layout(d);
  for (const id of s.order) d.nodes[id]!.rect = { ...s.nodes[id]!.rect };
  return s;
}
function pose(d: UiDocument, id = 'child') {
  resolve(d);
  return worldPose(d, id);
}
function equalPose(a: ReturnType<typeof worldPose>, b: ReturnType<typeof worldPose>) {
  expect(a.rect.x).toBeCloseTo(b.rect.x, 6);
  expect(a.rect.y).toBeCloseTo(b.rect.y, 6);
  expect(normalizeAngle(a.rotation)).toBeCloseTo(normalizeAngle(b.rotation), 6);
  expect(a.rect.width).toBe(b.rect.width);
  expect(a.rect.height).toBe(b.rect.height);
}
it('滚轮响应对称、大小增量连续且有上限，处理行/页单位和边界', () => {
  for (const delta of [0.001, 0.25, 1, 20, 100, 10000]) {
    const z = wheelZoom(1, delta, 0, 600);
    expect(z).toBeLessThan(1);
    expect(z).toBeGreaterThanOrEqual(Math.exp(-0.12));
    expect(wheelZoom(z, -delta, 0, 600)).toBeCloseTo(1, 10);
  }
  expect(wheelZoom(1, 1, 1, 600)).toBe(wheelZoom(1, 16, 0, 600));
  expect(wheelZoom(1, 1, 2, 600)).toBe(wheelZoom(1, 600, 0, 600));
  expect(wheelZoom(0.02, 999, 0, 600)).toBe(0.02);
  expect(wheelZoom(1000, -999, 0, 600)).toBe(1000);
  expect(wheelZoom(1, NaN, 0, 600)).toBe(1);
});
it('归一角度与以中心为轴的父子旋转保持布局尺寸', () => {
  expect(normalizeAngle(195)).toBe(-165);
  expect(normalizeAngle(-195)).toBe(165);
  expect(() => normalizeAngle(Infinity)).toThrow();
  const d = scene(),
    s = resolve(d);
  expect(s.nodes.child!.transform!.angle).toBe(20);
  expect(s.nodes.child!.rect).toEqual({ x: 52, y: 44, width: 30, height: 20 });
  const world = worldPose(d, 'child');
  expect(center(world.rect).x).not.toBe(67);
});
it('旋转父级之间换父级保持可见中心、角度和尺寸', () => {
  const d = scene(),
    before = pose(d);
  reparentNodes(d, ['child'], 'target');
  equalPose(pose(d), before);
  reparentNodes(d, ['child'], null);
  equalPose(pose(d), before);
});
it('编组和递归解组保留旋转后代的视觉位置', () => {
  const d = scene(),
    before = pose(d);
  groupNodes(d, ['child'], 'group');
  equalPose(pose(d), before);
  ungroupNodes(d, ['parent'], true);
  equalPose(pose(d), before);
  expect(d.nodes.child!.parent).toBeNull();
});
it('斜边命中使用四边形而非包围盒，Stack插入线跟随旋转', () => {
  const d = scene(),
    s = resolve(d);
  d.nodes.parent!.frame!.engineType = 'stack_panel';
  d.nodes.parent!.frame!.direction = 'row';
  const nodes: PickNode[] = s.order.map((id, i) => ({
    id,
    kind: d.nodes[id]!.kind,
    rect: s.nodes[id]!.bounds!,
    polygon: s.nodes[id]!.corners,
    rank: i,
    level: d.nodes[id]!.parent ? 1 : 0,
    disabled: false,
  }));
  const c = nodes.find((n) => n.id === 'child')!,
    middle = center(worldPose(d, 'child').rect);
  expect(pickNode([c], middle)).toBe('child');
  expect(pickNode([c], { x: c.rect.x + 0.01, y: c.rect.y + 0.01 })).toBeNull();
  const parent = nodes[0]!,
    edge = parent.polygon![0]!;
  expect(pickNode([parent], edge)).toBe('parent');
  const drop = pickDrop(d, nodes, [], center(worldPose(d, 'parent').rect), true);
  expect(drop?.parentId).toBe('parent');
  expect(drop!.line!.from.x).not.toBeCloseTo(drop!.line!.to.x, 2);
  expect(drop!.line!.from.y).not.toBeCloseTo(drop!.line!.to.y, 2);
});

it('Mac 捏合保留原指数倍率、可逆响应和缩放边界', () => {
  for (const delta of [0.25, 5, 20, 100]) {
    const zoom = pinchZoom(2, delta);
    expect(zoom).toBeCloseTo(2 * Math.exp(-delta * 0.01), 12);
    expect(pinchZoom(zoom, -delta)).toBeCloseTo(2, 12);
    expect(zoom).toBeLessThan(wheelZoom(2, delta, 0, 600));
  }
  expect(pinchZoom(1, 10000)).toBe(0.02);
  expect(pinchZoom(1, -10000)).toBe(1000);
  expect(pinchZoom(1, NaN)).toBe(1);
});
