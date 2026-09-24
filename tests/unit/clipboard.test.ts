import { it, expect } from 'vitest';
import { parseStyle, STYLE_PREFIX } from '../../src/application/clipboard';
it('属性剪贴板协议只接受外观与本地PNG填充，拒绝其它数据和外部来源', () => {
  const packet = { type: 'mcui-style', version: 1, opacity: 0 };
  expect(
    parseStyle(
      STYLE_PREFIX + JSON.stringify({ ...packet, name: 'unexpected', layout: { width: 999 } }),
    ),
  ).toEqual(packet);
  expect(parseStyle('MCUI:{}')).toBeNull();
  expect(() => parseStyle(STYLE_PREFIX + JSON.stringify({ ...packet, opacity: 2 }))).toThrow();
  const fill = {
    png: 'https://example.com/image.png',
    width: 10,
    height: 10,
    preserveResolution: true,
    recipe: { kind: 'paint', mode: 'extend', origin: { x: 0, y: 0 } },
  };
  expect(() => parseStyle(STYLE_PREFIX + JSON.stringify({ ...packet, fill }))).toThrow();
  expect(() =>
    parseStyle(
      STYLE_PREFIX +
        JSON.stringify({
          ...packet,
          fill: { ...fill, png: 'data:image/png;base64,AA==', recipe: { kind: 'generated' } },
        }),
    ),
  ).toThrow();
});
