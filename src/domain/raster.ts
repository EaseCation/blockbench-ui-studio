import type { Pixels, RenderRecipe } from './types';
export const blank = (width: number, height: number): Pixels => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 16_777_216
  )
    throw new Error('画布尺寸无效或超过 1600 万像素限制');
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
};
function blit(
  src: Pixels,
  dst: Pixels,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  for (let y = Math.max(0, Math.floor(dy)); y < Math.min(dst.height, Math.ceil(dy + dh)); y++) {
    for (let x = Math.max(0, Math.floor(dx)); x < Math.min(dst.width, Math.ceil(dx + dw)); x++) {
      if (x + 0.5 < dx || x + 0.5 >= dx + dw || y + 0.5 < dy || y + 0.5 >= dy + dh) continue;
      const px = Math.min(src.width - 1, Math.max(0, Math.floor(sx + ((x + 0.5 - dx) * sw) / dw)));
      const py = Math.min(src.height - 1, Math.max(0, Math.floor(sy + ((y + 0.5 - dy) * sh) / dh)));
      const si = (py * src.width + px) * 4,
        di = (y * dst.width + x) * 4;
      dst.data.set(src.data.subarray(si, si + 4), di);
    }
  }
}
export function renderPixels(
  src: Pixels,
  recipe: RenderRecipe,
  width: number,
  height: number,
  opacity = 1,
): Pixels {
  const dst = blank(width, height);
  if (recipe.kind === 'nine-slice') {
    const [t, r, b, l] = recipe.insets;
    if (
      [t, r, b, l].some((v) => !Number.isSafeInteger(v) || v < 0) ||
      l + r >= src.width ||
      t + b >= src.height
    )
      throw new Error('九宫格边距无效：源图必须保留至少 1px 的中心');
    if (width < l + r + 1 || height < t + b + 1)
      throw new Error('目标尺寸不能小于九宫格边距和中心像素');
    const xs = [0, l, src.width - r, src.width],
      ys = [0, t, src.height - b, src.height];
    const xd = [0, l, width - r, width],
      yd = [0, t, height - b, height];
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) {
        const sx = xs[col]!,
          sy = ys[row]!,
          sw = xs[col + 1]! - sx,
          sh = ys[row + 1]! - sy;
        const dx = xd[col]!,
          dy = yd[row]!,
          dw = xd[col + 1]! - dx,
          dh = yd[row + 1]! - dy;
        if (!sw || !sh || !dw || !dh) continue;
        if (recipe.mode === 'stretch' || (row !== 1 && col !== 1))
          blit(src, dst, sx, sy, sw, sh, dx, dy, dw, dh);
        else {
          const tileW = col === 1 ? sw : dw,
            tileH = row === 1 ? sh : dh;
          for (let y = 0; y < dh; y += tileH)
            for (let x = 0; x < dw; x += tileW) {
              const w = Math.min(tileW, dw - x),
                h = Math.min(tileH, dh - y);
              blit(src, dst, sx, sy, col === 1 ? w : sw, row === 1 ? h : sh, dx + x, dy + y, w, h);
            }
        }
      }
  } else if (recipe.kind === 'paint') {
    if (recipe.mode === 'scale') blit(src, dst, 0, 0, src.width, src.height, 0, 0, width, height);
    else
      blit(
        src,
        dst,
        0,
        0,
        src.width,
        src.height,
        -recipe.origin.x,
        -recipe.origin.y,
        src.width,
        src.height,
      );
  } else {
    if (recipe.mode === 'stretch') blit(src, dst, 0, 0, src.width, src.height, 0, 0, width, height);
    else {
      let scale =
        recipe.mode === 'original'
          ? 1
          : recipe.mode === 'crop'
            ? recipe.scale
            : recipe.mode === 'fit'
              ? Math.min(width / src.width, height / src.height)
              : Math.max(width / src.width, height / src.height);
      if (recipe.onlyDownscale) scale = Math.min(1, scale);
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('图片缩放必须大于零');
      const w = src.width * scale,
        h = src.height * scale;
      const dx = (width - w) * recipe.anchor[0] + (recipe.mode === 'crop' ? recipe.offset.x : 0);
      const dy = (height - h) * recipe.anchor[1] + (recipe.mode === 'crop' ? recipe.offset.y : 0);
      blit(src, dst, 0, 0, src.width, src.height, dx, dy, w, h);
    }
  }
  if (opacity !== 1)
    for (let i = 3; i < dst.data.length; i += 4)
      dst.data[i] = Math.round(dst.data[i]! * Math.max(0, Math.min(1, opacity)));
  return dst;
}
/** Preserve cropped pixels outside the visible painted region; scale becomes a new editable master. */
export function mergePaint(
  source: Pixels,
  visible: Pixels,
  origin: { x: number; y: number },
): { pixels: Pixels; origin: { x: number; y: number } } {
  const x = Math.min(0, origin.x),
    y = Math.min(0, origin.y);
  const out = blank(
    Math.max(source.width, origin.x + visible.width) - x,
    Math.max(source.height, origin.y + visible.height) - y,
  );
  blit(source, out, 0, 0, source.width, source.height, -x, -y, source.width, source.height);
  blit(
    visible,
    out,
    0,
    0,
    visible.width,
    visible.height,
    origin.x - x,
    origin.y - y,
    visible.width,
    visible.height,
  );
  return { pixels: out, origin: { x: origin.x - x, y: origin.y - y } };
}
