import { describe, it, expect } from 'vitest';
import { resizeRect, distances, mapRect, intersects } from '../../src/domain/geometry';
describe('二维交互几何', () => {
  const r = { x: 10, y: 20, width: 32, height: 16 };
  it('东边缩放不移动左边', () =>
    expect(resizeRect(r, 'e', { x: 8, y: 3 })).toEqual({ ...r, width: 40 }));
  it('西北缩放保持右下边界', () =>
    expect(resizeRect(r, 'nw', { x: -4, y: -2 })).toEqual({ x: 6, y: 18, width: 36, height: 18 }));
  it('Shift 保持比例', () => {
    const out = resizeRect(r, 'se', { x: 16, y: 0 }, true);
    expect(out.width / out.height).toBe(2);
  });
  it('Option 保持中心与整数边界', () => {
    const out = resizeRect(r, 'e', { x: 3, y: 0 }, false, true);
    expect(out.x + out.width / 2).toBe(26);
    expect(out.width).toBe(38);
  });
  it('缩放不翻转且遵循九宫格下限', () =>
    expect(resizeRect(r, 'se', { x: -100, y: -100 }, false, false, 9, 9)).toEqual({
      ...r,
      width: 9,
      height: 9,
    }));
  it('多选矩形映射保持相对布局', () =>
    expect(
      mapRect(
        { x: 20, y: 20, width: 10, height: 10 },
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 200, height: 200 },
      ),
    ).toEqual({ x: 40, y: 40, width: 20, height: 20 }));
  it('包含关系测量四边内间距', () =>
    expect(
      distances(
        { x: 0, y: 0, width: 100, height: 80 },
        { x: 10, y: 20, width: 30, height: 40 },
      ).map((m) => m.value),
    ).toEqual([10, 60, 20, 20]));
  it('两个元素水平间距是 UI 像素', () =>
    expect(
      distances({ x: 0, y: 0, width: 10, height: 10 }, { x: 14, y: 0, width: 10, height: 10 })[0]!
        .value,
    ).toBe(4));
  it('框选包含边界相交', () =>
    expect(intersects(r, { x: 42, y: 20, width: 3, height: 3 })).toBe(true));
});
