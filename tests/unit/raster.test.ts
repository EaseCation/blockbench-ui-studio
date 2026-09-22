import { describe, it, expect } from 'vitest';
import { blank, renderPixels, mergePaint } from '../../src/domain/raster';
import type { ImageRecipe, Pixels } from '../../src/domain/types';
const rgb = (p: Pixels, x: number, y: number) =>
  Array.from(p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
function source(w = 3, h = 3) {
  const p = blank(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) p.data.set([x * 50, y * 50, 100, 255], (y * w + x) * 4);
  return p;
}
const recipe = (mode: ImageRecipe['mode']): ImageRecipe => ({
  kind: 'image',
  source: 'a',
  mode,
  anchor: [0.5, 0.5],
  scale: 1,
  offset: { x: 0, y: 0 },
  onlyDownscale: false,
});
describe('像素内容生成', () => {
  it('九宫格保持四角，中心覆盖目标', () => {
    const s = source(),
      p = renderPixels(
        s,
        { kind: 'nine-slice', source: 'a', insets: [1, 1, 1, 1], mode: 'stretch' },
        8,
        6,
      );
    expect(rgb(p, 0, 0)).toEqual(rgb(s, 0, 0));
    expect(rgb(p, 7, 5)).toEqual(rgb(s, 2, 2));
    expect(rgb(p, 6, 4)).toEqual(rgb(s, 1, 1));
  });
  it('平铺末端不足一块裁切', () => {
    const s = source(5, 3),
      p = renderPixels(
        s,
        { kind: 'nine-slice', source: 'a', insets: [1, 1, 1, 1], mode: 'tile' },
        7,
        3,
      );
    expect([1, 2, 3, 4, 5].map((x) => rgb(p, x, 1)[0])).toEqual([50, 100, 150, 50, 100]);
  });
  it('拒绝没有中心的边距', () =>
    expect(() =>
      renderPixels(
        source(),
        { kind: 'nine-slice', source: 'a', insets: [2, 2, 2, 2], mode: 'stretch' },
        10,
        10,
      ),
    ).toThrow());
  it('Fit 留白，Fill 保持比例并覆盖', () => {
    const s = source(4, 2),
      fit = renderPixels(s, recipe('fit'), 4, 4),
      fill = renderPixels(s, recipe('fill'), 4, 4);
    expect(rgb(fit, 0, 0)[3]).toBe(0);
    expect(rgb(fit, 0, 1)[3]).toBe(255);
    expect(rgb(fill, 0, 0)[3]).toBe(255);
    expect(rgb(fill, 0, 0)[0]).toBe(50);
  });
  it('Crop 偏移不会破坏原图', () => {
    const s = source(),
      copy = s.data.slice(),
      r = recipe('crop');
    r.offset.x = 2;
    const out = renderPixels(s, r, 3, 3);
    expect(rgb(out, 0, 0)[3]).toBe(0);
    expect(s.data).toEqual(copy);
  });
  it('扩展画布不放大像素', () => {
    const p = renderPixels(
      source(),
      { kind: 'paint', source: 'a', mode: 'extend', origin: { x: 0, y: 0 } },
      8,
      8,
    );
    expect(rgb(p, 1, 1)).toEqual([50, 50, 100, 255]);
    expect(rgb(p, 5, 5)[3]).toBe(0);
  });
  it('缩小再扩大仍从源画布生成', () => {
    const s = source(8, 8),
      r = { kind: 'paint', source: 'a', mode: 'extend', origin: { x: 0, y: 0 } } as const;
    renderPixels(s, r, 2, 2);
    expect(renderPixels(s, r, 8, 8).data).toEqual(s.data);
  });
  it('绘制局部区域保留裁掉的源像素', () => {
    const s = source(8, 8),
      v = blank(2, 2);
    const merged = mergePaint(s, v, { x: 2, y: 2 });
    expect(rgb(merged.pixels, 0, 0)).toEqual(rgb(s, 0, 0));
    expect(rgb(merged.pixels, 2, 2)[3]).toBe(0);
  });
  it('扩展到负方向时同步源原点', () => {
    const out = mergePaint(source(), source(5, 5), { x: -2, y: -2 });
    expect(out.pixels.width).toBe(5);
    expect(out.origin).toEqual({ x: 0, y: 0 });
  });
  it('透明度保持 RGB 与 alpha 独立', () => {
    const out = renderPixels(source(), recipe('stretch'), 3, 3, 0.5);
    expect(rgb(out, 1, 1)).toEqual([50, 50, 100, 128]);
  });
});
