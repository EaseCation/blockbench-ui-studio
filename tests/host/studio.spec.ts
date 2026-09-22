import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
declare global {
  interface Window {
    Blockbench: any;
    Plugins: any;
    BBPlugin: any;
    Project: any;
    Codecs: any;
    Formats: any;
    Cube: any;
    Texture: any;
    Undo: any;
    setupProject: any;
    Modes: any;
    BarItems: any;
    Preview: any;
  }
}
async function start(page: Page, plugin = true) {
  page.on('pageerror', (e) => console.log('HOST ERROR:', e.message));
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto('http://127.0.0.1:4178');
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  if (plugin) {
    await page.evaluate(() => {
      window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
    });
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => !!window.Blockbench.mcuiStudio);
  }
}
test('原生对象、纹理尺寸、Undo 与无插件往返保存', async ({ page, context }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
  });
  await expect(page.getByText('Figma 风格', { exact: true })).toBeAttached();
  const initial = await page.evaluate(async () => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    const root = app.state.doc.roots[0];
    const id = app.add('layer', root);
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f05030';
    ctx.fillRect(0, 0, 16, 16);
    ctx.clearRect(4, 4, 8, 8);
    app.select([id]);
    await app.paste({ png: canvas.toDataURL(), width: 16, height: 16, name: 'panel' });
    app.makeNine(id);
    app.update(id, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 80 };
      n.layout.height = { kind: 'fixed', value: 40 };
    });
    const b = app.state.doc.bindings[id],
      cube = window.Cube.all.find((c: any) => c.uuid === b.elementId),
      tex = window.Texture.all.find((t: any) => t.uuid === b.textureId);
    return {
      id,
      count: window.Cube.all.length,
      width: cube.to[0] - cube.from[0],
      height: cube.to[2] - cube.from[2],
      texWidth: tex.width,
      texHeight: tex.height,
      meta: window.Project.unhandled_root_fields.mcui_studio,
      model: window.Codecs.project.compile({ raw: true, bitmaps: true }),
    };
  });
  expect(initial).toMatchObject({ count: 1, width: 80, height: 40, texWidth: 80, texHeight: 40 });
  await page.getByRole('button', { name: /属性/ }).click();
  await page.getByLabel('九宫格模式', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('九宫格模式', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.cache/mcui-studio.png' });
  await page.evaluate(() => window.Undo.undo());
  await expect
    .poll(() => page.evaluate(() => window.Cube.all[0].to[0] - window.Cube.all[0].from[0]))
    .toBe(32);
  await page.evaluate(() => window.Undo.redo());
  await expect
    .poll(() => page.evaluate(() => window.Cube.all[0].to[0] - window.Cube.all[0].from[0]))
    .toBe(80);
  const bare = await context.newPage();
  await start(bare, false);
  const roundtrip = await bare.evaluate((model) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(model);
    return window.Codecs.project.compile({ raw: true, bitmaps: true });
  }, initial.model);
  expect(roundtrip.unhandled_root_fields.mcui_studio).toEqual(initial.meta);
  expect(roundtrip.elements).toHaveLength(1);
  await bare.close();
});
test('二维交互、视图切换和完整卸载', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.add('layer', app.state.doc.roots[0]);
  });
  await expect(page.locator('[data-mcui-handle]')).toHaveCount(8);
  const handle = page.locator('[data-mcui-handle="se"]').first();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const before = await page.evaluate(() => ({
    w: window.Cube.all[0].to[0] - window.Cube.all[0].from[0],
    undo: window.Undo.history.length,
  }));
  await page.mouse.move(box!.x + 4, box!.y + 4);
  await page.mouse.down();
  await page.mouse.move(box!.x + 44, box!.y + 24, { steps: 4 });
  await page.mouse.up();
  expect(
    await page.evaluate(() => window.Cube.all[0].to[0] - window.Cube.all[0].from[0]),
  ).toBeGreaterThan(before.w);
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before.undo + 1);
  await page.getByLabel('视图', { exact: true }).selectOption('3d');
  expect(await page.evaluate(() => window.Preview.selected.isOrtho)).toBe(false);
  await page.getByLabel('视图', { exact: true }).selectOption('2d');
  expect(await page.evaluate(() => window.Preview.selected.isOrtho)).toBe(true);
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  await expect(page.locator('.mcui-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => window.Cube.all.length)).toBe(1);
});
test('原生绘画层、非破坏裁切与原生尺寸工具', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
  });
  const result = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      id = app.add('layer', app.state.doc.roots[0]);
    const texture = window.Texture.all[0];
    texture.activateLayers(false);
    window.Undo.initEdit({ layers: [texture.layers[0]], bitmap: true });
    texture.layers[0].ctx.fillStyle = '#ff0000';
    texture.layers[0].ctx.fillRect(0, 0, 32, 32);
    texture.updateChangesAfterEdit();
    window.Undo.finishEdit('Paint texture');
    app.update(id, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 8 };
    });
    app.update(id, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 64 };
    });
    const pixel = Array.from(texture.ctx.getImageData(25, 5, 1, 1).data);
    const cube = window.Cube.all[0];
    window.Undo.initEdit({ elements: [cube] });
    cube.to[0] += 8;
    window.Undo.finishEdit('Native resize');
    return {
      layers: texture.layers.length,
      enabled: texture.layers_enabled,
      pixel,
      width: texture.width,
      nodeWidth: app.state.doc.nodes[id].rect.width,
      error: app.state.error,
    };
  });
  expect(result).toMatchObject({
    layers: 1,
    enabled: true,
    pixel: [255, 0, 0, 255],
    width: 72,
    nodeWidth: 72,
    error: null,
  });
});
test('父布局驱动两个九宫格，单次撤销恢复全部', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
  });
  const result = await page.evaluate(async () => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#9dd25f';
    ctx.fillRect(0, 0, 16, 16);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = app.add('layer', root);
      app.select([id]);
      await app.paste({ png: canvas.toDataURL(), width: 16, height: 16, name: 'button' });
      app.makeNine(id);
      ids.push(id);
    }
    app.execute('布局', (d: any) => {
      const p = d.nodes[root];
      p.layout.width = { kind: 'fixed', value: 100 };
      p.frame.direction = 'row';
      p.frame.padding = [4, 4, 4, 4];
      p.frame.gap = 8;
      for (const id of ids) {
        d.nodes[id].layout.width = { kind: 'fill' };
        d.nodes[id].layout.height = { kind: 'fixed', value: 24 };
      }
    });
    const before = window.Texture.all.map((t: any) => t.width),
      count = window.Undo.history.length;
    app.update(root, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 201 };
    });
    return {
      before,
      after: window.Texture.all.map((t: any) => t.width),
      undoCount: window.Undo.history.length - count,
      error: app.state.error,
    };
  });
  expect(result).toEqual({ before: [42, 42], after: [93, 92], undoCount: 1, error: null });
  await page.evaluate(() => window.Undo.undo());
  await expect
    .poll(() => page.evaluate(() => window.Texture.all.map((t: any) => t.width)))
    .toEqual([42, 42]);
});
test('源图使用原生绘画会话，应用后更新且可撤销', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio();
    const id = app.add('layer', app.state.doc.roots[0]);
    app.makeNine(id);
    app.paint(id);
  });
  await expect(page.locator('.mcui-source-session')).toBeVisible();
  await page.waitForFunction(
    () => window.Project?.format?.id === 'image' && window.Texture.all[0]?.layers?.length > 0,
  );
  await page.evaluate(() => {
    const t = window.Texture.all[0];
    t.layers[0].ctx.fillStyle = '#3333ff';
    t.layers[0].ctx.fillRect(0, 0, t.width, t.height);
    t.updateChangesAfterEdit();
  });
  await page.getByRole('button', { name: '应用到 UI', exact: true }).click();
  await expect(page.locator('.mcui-source-session')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.Project.format.id)).toBe('free');
  expect(
    await page.evaluate(() => Array.from(window.Texture.all[0].ctx.getImageData(0, 0, 1, 1).data)),
  ).toEqual([51, 51, 255, 255]);
  await page.evaluate(() => window.Undo.undo());
  await expect
    .poll(() => page.evaluate(() => window.Texture.all[0].ctx.getImageData(0, 0, 1, 1).data[3]))
    .toBe(0);
});
test('无插件修改不被覆盖，重新启用后采用当前结果', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.add('layer', app.state.doc.roots[0]);
  });
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio.onunload();
    window.Cube.all[0].from[0] += 10;
    window.Cube.all[0].to[0] += 10;
    window.Plugins.registered.mcui_studio.onload();
  });
  await page.waitForFunction(
    () =>
      window.Blockbench.mcuiStudio?.getStudio() &&
      !window.Blockbench.mcuiStudio.getStudio().state.busy,
  );
  const node = (await page.evaluate(() =>
    Object.values(window.Blockbench.mcuiStudio.getStudio().state.doc.nodes).find(
      (n: any) => n.kind === 'layer',
    ),
  )) as any;
  expect(node.suspended).toMatch(/修改/);
  expect(node.rect.x).toBe(18);
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().adopt(id), node.id);
  expect(await page.evaluate(() => window.Cube.all[0].from[0])).toBe(18);
});

test('双击原生画笔与触摸板缩放事件不会改变模型尺寸', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.add('layer', app.state.doc.roots[0]);
  });
  const point = () =>
    page.evaluate(() => {
      const p = window.Preview.selected,
        c = window.Cube.all[0],
        r = p.canvas.getBoundingClientRect();
      const v = new (window as any).THREE.Vector3(
        (c.from[0] + c.to[0]) / 2,
        c.to[1],
        (c.from[2] + c.to[2]) / 2,
      ).project(p.camera);
      return { x: r.left + ((v.x + 1) * r.width) / 2, y: r.top + ((1 - v.y) * r.height) / 2 };
    });
  let p = await point();
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForFunction(() => window.Modes.paint === true);
  p = await point();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 5, p.y, { steps: 3 });
  await page.mouse.up();
  const painted = await page.evaluate(() => {
    const t = window.Texture.all[0];
    const data = t.ctx.getImageData(0, 0, t.width, t.height).data as Uint8ClampedArray;
    return Array.from(data)
      .filter((_v, i) => i % 4 === 3)
      .some((v) => v > 0);
  });
  expect(painted).toBe(true);
  const navigation = await page.evaluate(() => {
    const p = window.Preview.selected,
      c = window.Cube.all[0],
      r = p.canvas.getBoundingClientRect();
    const before = {
      zoom: p.camera.zoom,
      width: c.to[0] - c.from[0],
      undo: window.Undo.history.length,
    };
    p.canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -20,
        ctrlKey: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
    return {
      before,
      after: { zoom: p.camera.zoom, width: c.to[0] - c.from[0], undo: window.Undo.history.length },
    };
  });
  expect(navigation.after.zoom).toBeGreaterThan(navigation.before.zoom);
  expect(navigation.after.width).toBe(navigation.before.width);
  expect(navigation.after.undo).toBe(navigation.before.undo);
});

test('绘画层缩放后仍按实际像素绘画，复制保持独立可编辑层', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
  });
  const result = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      id = app.add('layer', app.state.doc.roots[0]);
    const t = window.Texture.all[0];
    t.activateLayers(false);
    window.Undo.initEdit({ layers: [t.layers[0]], bitmap: true });
    t.layers[0].ctx.fillStyle = '#ccaa55';
    t.layers[0].ctx.fillRect(0, 0, 32, 32);
    t.updateChangesAfterEdit();
    window.Undo.finishEdit('Paint texture');
    app.update(id, (n: any) => {
      n.content.mode = 'scale';
      n.layout.width = { kind: 'fixed', value: 64 };
    });
    const layerWidth = t.layers[0].width,
      scale = [...t.layers[0].scale];
    app.select([id]);
    app.duplicate();
    const other = window.Texture.all.find((x: any) => x !== t);
    return {
      layerWidth,
      scale,
      duplicateLayers: other.layers.length,
      shared: other.layers[0] === t.layers[0],
      count: Object.keys(app.state.doc.assets).length,
      error: app.state.error,
    };
  });
  expect(result).toEqual({
    layerWidth: 64,
    scale: [1, 1],
    duplicateLayers: 1,
    shared: false,
    count: 1,
    error: null,
  });
});
