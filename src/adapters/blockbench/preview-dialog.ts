import type { Studio } from '../../application/studio';
import type { Id, RenderRecipe } from '../../domain/types';
import { clone } from '../../domain/document';
import { decorate, renderPixels } from '../../domain/raster';
import { imagePort } from '../../platform/browser/images';
import type { HostRuntime } from './runtime';
import { bindScrub, scrubLabel } from './input-scrub';
import { inputStep, stepNumber } from './input-step';

export async function showContentPreview(
  bb: HostRuntime,
  app: Studio,
  id: Id,
  active = () => true,
) {
  const project = bb.Project,
    initial = app.state.doc;
  const valid = () => active() && bb.Project === project;
  const cleanups: (() => void)[] = [];
  const cleanup = () => {
    for (const dispose of cleanups.splice(0)) dispose();
  };
  const node = app.state.doc.nodes[id];
  if (!node?.content) return;
  const source = app.state.doc.assets[node.content.source]!;
  const pixels = await imagePort.decode(source.png),
    recipe = clone(node.content);
  if (!valid()) return;
  const snapshot = JSON.stringify(node);
  const master = document.createElement('canvas');
  master.width = pixels.width;
  master.height = pixels.height;
  const masterCtx = master.getContext('2d')!;
  const masterImage = masterCtx.createImageData(pixels.width, pixels.height);
  masterImage.data.set(pixels.data);
  masterCtx.putImageData(masterImage, 0, 0);
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 240;
  canvas.style.cssText =
    'width:100%;height:240px;image-rendering:pixelated;background:var(--color-back)';
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
            scale: {
              label: '倍率',
              type: 'number',
              value: recipe.scale,
              min: 0.01,
              condition: (v: any) => v.mode === 'crop',
            },
            offset: {
              label: '偏移',
              type: 'vector',
              dimensions: 2,
              value: [recipe.offset.x, recipe.offset.y],
              condition: (v: any) => v.mode === 'crop',
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
      const size = node.rasterSize ?? node.rect;
      const result = decorate(
        renderPixels(pixels, candidate(values), size.width, size.height),
        node.appearance,
        node.opacity,
      );
      const tile = document.createElement('canvas');
      tile.width = result.width;
      tile.height = result.height;
      const t = tile.getContext('2d')!,
        data = t.createImageData(result.width, result.height);
      data.data.set(result.data);
      t.putImageData(data, 0, 0);
      const nine = recipe.kind === 'nine-slice';
      const scale = Math.min((nine ? 265 : 440) / node.rect.width, 175 / node.rect.height);
      const textColor =
        getComputedStyle(document.body).getPropertyValue('--color-text').trim() || '#ddd';
      const accent =
        getComputedStyle(document.body).getPropertyValue('--color-accent').trim() || '#4897ff';
      if (nine) {
        const zoom = Math.min(140 / pixels.width, 165 / pixels.height);
        const x = 12 + (140 - pixels.width * zoom) / 2,
          y = 28;
        ctx.drawImage(master, x, y, pixels.width * zoom, pixels.height * zoom);
        const [top, right, bottom, left] = values.insets;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        for (const xx of [left, pixels.width - right]) {
          ctx.moveTo(x + xx * zoom, y);
          ctx.lineTo(x + xx * zoom, y + pixels.height * zoom);
        }
        for (const yy of [top, pixels.height - bottom]) {
          ctx.moveTo(x, y + yy * zoom);
          ctx.lineTo(x + pixels.width * zoom, y + yy * zoom);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = textColor;
        ctx.font = '13px sans-serif';
        ctx.fillText(`源图 ${pixels.width}×${pixels.height}`, 12, 16);
        ctx.fillText('生成结果', 180, 16);
      }
      ctx.drawImage(
        tile,
        nine ? 175 + (285 - node.rect.width * scale) / 2 : (480 - node.rect.width * scale) / 2,
        28,
        node.rect.width * scale,
        node.rect.height * scale,
      );
      ctx.fillStyle = textColor;
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
    onClose: cleanup,
    onConfirm(values: any) {
      if (
        !valid() ||
        app.state.doc.id !== initial.id ||
        JSON.stringify(app.state.doc.nodes[id]) !== snapshot
      ) {
        bb.Blockbench.showQuickMessage('项目或目标内容已改变，请重新打开预览', 4000);
        return false;
      }
      return app.execute('修改 UI 内容参数', (doc) => {
        doc.nodes[id]!.content = candidate(values);
      });
    },
  });
  dialog.show();
  for (const key of ['insets', 'scale', 'offset']) {
    const field = dialog.form.form_data[key];
    if (!field) continue;
    for (const input of field.bar.querySelectorAll('input') as NodeListOf<HTMLInputElement>) {
      const step = (value: string, delta: number) =>
        stepNumber(value, delta, key === 'insets' ? 0 : key === 'scale' ? 0.01 : undefined);
      const apply = (value: string) => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const arrow = (e: KeyboardEvent) => {
        const delta = inputStep(e);
        if (delta === null) return;
        try {
          apply(step(input.value, delta));
        } catch (error) {
          bb.Blockbench.showQuickMessage(String(error), 4000);
        }
      };
      input.addEventListener('keydown', arrow);
      cleanups.push(() => input.removeEventListener('keydown', arrow));
      cleanups.push(
        bindScrub(input, {
          key: () => project.uuid,
          enabled: () => valid() && bb.Dialog.open === dialog,
          step,
          refresh: () => {},
          report: (error) => bb.Blockbench.showQuickMessage(String(error), 4000),
          begin: () => {
            const original = input.value;
            return {
              preview: (value) => {
                apply(value);
                return true;
              },
              finish: (commit) => {
                if (!commit) apply(original);
              },
            };
          },
        }),
      );
      if (key === 'scale') {
        const label = field.bar.querySelector('label');
        if (label) scrubLabel(input, label);
      }
    }
  }
  paint(dialog.getFormResult());
  return () => {
    cleanup();
    if (bb.Dialog.open === dialog) dialog.cancel();
    dialog.delete();
  };
}
