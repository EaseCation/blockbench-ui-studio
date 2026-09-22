import type { Studio } from '../../application/studio';
import type { Id, RenderRecipe } from '../../domain/types';
import { clone } from '../../domain/document';
import { renderPixels } from '../../domain/raster';
import { imagePort } from '../../platform/browser/images';
import type { HostRuntime } from './runtime';

export async function showContentPreview(bb: HostRuntime, app: Studio, id: Id) {
  const node = app.state.doc.nodes[id];
  if (!node?.content) return;
  const source = app.state.doc.assets[node.content.source]!;
  const pixels = await imagePort.decode(source.png),
    recipe = clone(node.content);
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 240;
  canvas.style.cssText = 'width:100%;height:240px;image-rendering:pixelated;background:#222';
  const form: Record<string, unknown> =
    recipe.kind === 'nine-slice'
      ? {
          insets: {
            label: '上 / 右 / 下 / 左',
            type: 'vector',
            dimensions: 4,
            value: recipe.insets,
            min: 0,
            step: 1,
            force_step: true,
          },
          mode: {
            label: '九宫格模式',
            type: 'select',
            value: recipe.mode,
            options: { stretch: '拉伸', tile: '平铺' },
          },
        }
      : recipe.kind === 'image'
        ? {
            mode: {
              label: '图片适配',
              type: 'select',
              value: recipe.mode,
              options: {
                stretch: '拉伸',
                fit: '完整显示',
                fill: '铺满',
                crop: '手动裁切',
                original: '原始像素',
              },
            },
            scale: { label: '倍率', type: 'number', value: recipe.scale, min: 0.01 },
            offset: {
              label: '偏移',
              type: 'vector',
              dimensions: 2,
              value: [recipe.offset.x, recipe.offset.y],
            },
          }
        : {};
  const candidate = (values: any): RenderRecipe =>
    recipe.kind === 'nine-slice'
      ? { ...recipe, insets: values.insets, mode: values.mode }
      : recipe.kind === 'image'
        ? {
            ...recipe,
            mode: values.mode,
            scale: values.scale,
            offset: { x: values.offset[0], y: values.offset[1] },
          }
        : recipe;
  const paint = (values: any) => {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 480, 240);
    ctx.imageSmoothingEnabled = false;
    try {
      const result = renderPixels(pixels, candidate(values), node.rect.width, node.rect.height);
      const tile = document.createElement('canvas');
      tile.width = result.width;
      tile.height = result.height;
      const t = tile.getContext('2d')!,
        data = t.createImageData(result.width, result.height);
      data.data.set(result.data);
      t.putImageData(data, 0, 0);
      const scale = Math.min(440 / result.width, 190 / result.height);
      ctx.drawImage(
        tile,
        (480 - result.width * scale) / 2,
        15,
        result.width * scale,
        result.height * scale,
      );
      ctx.fillStyle = '#ddd';
      ctx.font = '13px sans-serif';
      ctx.fillText(`${result.width} × ${result.height}px · 确认后应用`, 12, 228);
    } catch (error) {
      ctx.fillStyle = '#ff9898';
      ctx.font = '13px sans-serif';
      ctx.fillText(String(error), 12, 120);
    }
  };
  const dialog = new bb.Dialog({
    id: 'mcui_content_preview',
    title: 'UI 内容预览',
    width: 520,
    form,
    lines: [canvas],
    onFormChange: paint,
    onConfirm(values: any) {
      return app.execute('修改 UI 内容参数', (doc) => {
        doc.nodes[id]!.content = candidate(values);
      });
    },
  });
  dialog.show();
  paint(dialog.getFormResult());
}
