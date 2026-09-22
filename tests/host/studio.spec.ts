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
  await expect(page.locator('[toolbar_item=mcui_interaction]')).toBeAttached();
  await expect(page.locator('#panel_mcui_studio')).toHaveCount(0);
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
  await expect(page.locator('#panel_element')).toBeVisible();
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
  await page.locator('[toolbar_item=mcui_view] .bb-select').click();
  await page
    .locator('.contextMenu li')
    .filter({ hasText: /^3D 透视$/ })
    .click();
  expect(await page.evaluate(() => window.Preview.selected.isOrtho)).toBe(false);
  await page.locator('[toolbar_item=mcui_view] .bb-select').click();
  await page
    .locator('.contextMenu li')
    .filter({ hasText: /^2D 顶视图$/ })
    .click();
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
  await expect(page.locator('[toolbar_item=mcui_source_apply]')).toBeVisible();
  await page.waitForFunction(
    () => window.Project?.format?.id === 'image' && window.Texture.all[0]?.layers?.length > 0,
  );
  await page.evaluate(() => {
    const t = window.Texture.all[0];
    t.layers[0].ctx.fillStyle = '#3333ff';
    t.layers[0].ctx.fillRect(0, 0, t.width, t.height);
    t.updateChangesAfterEdit();
  });
  await page.locator('[toolbar_item=mcui_source_apply]').click();
  await expect(page.locator('[toolbar_item=mcui_source_apply]')).not.toBeVisible();
  await page.waitForFunction(
    () =>
      window.Project?.format?.id === 'free' &&
      (window as any).ModelProject.all.length === 1 &&
      window.Texture.all[0]?.ctx,
  );
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
    window.Plugins.registered.mcui_studio.runOnLoad();
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

for (const method of ['button', 'double-click'] as const) {
  test(`开始页新建入口：${method} 只创建一个通用模型，卸载清理入口`, async ({ page }) => {
    await start(page);
    const entry = page.locator('.format_entry[format="mcui_studio"]');
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('MC UI');
    if (method === 'button') {
      await entry.click();
      await page.getByRole('button', { name: /创建 MC UI 项目/ }).click();
    } else {
      await entry.dblclick();
    }
    await page.waitForFunction(() => !!window.Blockbench.mcuiStudio.getStudio());
    expect(
      await page.evaluate(() => {
        const app = window.Blockbench.mcuiStudio.getStudio();
        return {
          projects: (window as any).ModelProject.all.length,
          format: window.Codecs.project.compile({ raw: true }).meta.model_format,
          width: app.state.doc.nodes[app.state.doc.roots[0]].rect.width,
          height: app.state.doc.nodes[app.state.doc.roots[0]].rect.height,
          ortho: window.Preview.selected.isOrtho,
        };
      }),
    ).toEqual({ projects: 1, format: 'free', width: 320, height: 180, ortho: true });
    await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
    await expect(entry).toHaveCount(0);
    expect(await page.evaluate(() => !!(window as any).ModelLoader.loaders.mcui_studio)).toBe(
      false,
    );
    expect(await page.evaluate(() => window.Project?.format?.id)).toBe('free');
  });
}

test('原生大纲选中后自动打开元素标签；表达式草稿原子提交', async ({ page }) => {
  await start(page);
  const id = await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    window.BarItems.mcui_add_layer.trigger();
    const app = window.Blockbench.mcuiStudio.getStudio();
    return app.state.selection[0];
  });
  const input = page.locator('#panel_element input[id="cube__mcui_size_w"]');
  await expect(input).toBeVisible();
  await expect(page.locator('#panel_mcui_studio')).toHaveCount(0);
  await page.evaluate(() => {
    const panels = (window as any).Interface.Panels;
    panels.transform.selectTab(panels.transform);
    window.Blockbench.mcuiStudio.getStudio().select([]);
  });
  await page.locator(`[id="${id}"] > .outliner_object`).click();
  await expect(input).toBeVisible();
  const before = await page.evaluate(() => window.Undo.history.length);
  await input.fill('100% -');
  expect(await page.evaluate(() => window.Cube.all[0].size(0))).toBe(32);
  await input.press('Enter');
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
  await input.fill('100% - 16px');
  await input.press('Enter');
  expect(await page.evaluate(() => window.Cube.all[0].size(0))).toBe(304);
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before + 1);
  await page.evaluate(() => window.Undo.undo());
  await expect(input).toHaveValue('32px');
  await page.screenshot({ path: '.cache/mcui-native-properties.png' });
});

test('原生大纲排序、换父级和撤销同步规则与 Y', async ({ page }) => {
  await start(page);
  const result = await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('layer', root),
      b = app.add('layer', root),
      frame = app.add('frame');
    const lookup = (id: string) =>
      (window as any).OutlinerNode.uuids[app.state.doc.bindings[id].elementId];
    app.select([b]);
    (window as any).moveOutlinerSelectionTo(lookup(b), lookup(a), -1, { event: { altKey: false } });
    const order = [...app.state.doc.nodes[root].children],
      y = [lookup(b).to[1], lookup(a).to[1]],
      x = lookup(b).from[0];
    const history = window.Undo.history.length;
    (window as any).moveOutlinerSelectionTo(lookup(b), lookup(frame), 0, {
      event: { altKey: false },
    });
    return {
      a,
      b,
      root,
      frame,
      order,
      y,
      x,
      afterX: lookup(b).from[0],
      parent: app.state.doc.nodes[b].parent,
      suspended: !!app.state.doc.nodes[b].suspended,
      steps: window.Undo.history.length - history,
      error: app.state.error,
    };
  });
  expect(result.order).toEqual([result.b, result.a]);
  expect(result.y[0]).toBeLessThan(result.y[1]);
  expect(result.parent).toBe(result.frame);
  expect(result.afterX).toBe(result.x);
  expect(result.suspended).toBe(false);
  expect(result.steps).toBe(1);
  expect(result.error).toBeNull();
  await page.evaluate(() => window.Undo.undo());
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[id].parent,
        result.b,
      ),
    )
    .toBe(result.root);
});

test('原生 Option 复制保留九宫格规则并生成独立贴图', async ({ page }) => {
  await start(page);
  const result = await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0],
      id = app.add('layer', root);
    app.makeNine(id);
    app.select([id]);
    const cube = window.Cube.all[0];
    (window as any).moveOutlinerSelectionTo(cube, cube.parent, 0, { event: { altKey: true } });
    const nodes = Object.values(app.state.doc.nodes).filter(
      (n: any) => n.kind === 'layer',
    ) as any[];
    return {
      count: nodes.length,
      kinds: nodes.map((n) => n.content.kind),
      sources: nodes.map((n) => n.content.source),
      textures: nodes.map((n) => app.state.doc.bindings[n.id].textureId),
      paused: nodes.some((n) => n.suspended),
      error: app.state.error,
    };
  });
  expect(result.count).toBe(2);
  expect(result.kinds).toEqual(['nine-slice', 'nine-slice']);
  expect(result.sources[0]).toBe(result.sources[1]);
  expect(result.textures[0]).not.toBe(result.textures[1]);
  expect(result.paused).toBe(false);
  expect(result.error).toBeNull();
});

test('原生多选属性批量提交，循环布局回滚且不污染普通项目', async ({ page }) => {
  await start(page);
  const ids = await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('layer', root),
      b = app.add('layer', root);
    app.select([a, b]);
    return { root, a, b };
  });
  const width = page.locator('#panel_element input[id="cube__mcui_size_w"]');
  await expect(width).toBeVisible();
  await width.fill('64px');
  await width.press('Enter');
  expect(await page.evaluate(() => window.Cube.all.map((c: any) => c.size(0)))).toEqual([64, 64]);
  await page.evaluate(({ root, a }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.update(a, (n: any) => {
      n.layout.width = { kind: 'fill' };
    });
    app.select([root]);
  }, ids);
  const frameWidth = page.locator('#panel_element input[id="group__mcui_size_w"]');
  await expect(frameWidth).toBeVisible();
  const before = await page.evaluate(() => window.Undo.history.length);
  await frameWidth.fill('hug');
  await frameWidth.press('Enter');
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
  expect(
    await page.evaluate(
      (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[id].layout.width.kind,
      ids.root,
    ),
  ).toBe('fixed');
  await frameWidth.press('Escape');
  const model = await page.evaluate(() =>
    window.Codecs.project.compile({ raw: true, bitmaps: true }),
  );
  expect(model.elements.some((e: any) => Object.keys(e).some((k) => k.startsWith('mcui_')))).toBe(
    false,
  );
  await page.evaluate(() => {
    window.setupProject(window.Formats.free);
    new window.Cube({ name: 'Ordinary' }).init().select();
  });
  await expect(page.locator('#panel_element .form_bar_cube__mcui_size')).not.toBeVisible();
});

test('原生框选复用宿主框，过滤锁定对象且保留框选历史', async ({ page }) => {
  await start(page);
  const points = await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('layer', root),
      b = app.add('layer', root);
    app.update(b, (n: any) => {
      n.layout.offset.x = 60;
      n.locked = true;
    });
    app.select([]);
    const p = window.Preview.selected,
      r = p.canvas.getBoundingClientRect();
    const project = (x: number, z: number) => {
      const v = new (window as any).THREE.Vector3(x, 0, z).project(p.camera);
      return { x: r.left + ((v.x + 1) * r.width) / 2, y: r.top + ((1 - v.y) * r.height) / 2 };
    };
    return { from: project(0, 0), to: project(105, 48), a, b };
  });
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 5 });
  await expect(page.locator('#selection_box')).toBeAttached();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.selection))
    .toEqual([points.a]);
});

test('紧凑原生标签：两行坐标尺寸、字段说明和百分比位置', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    window.BarItems.mcui_add_layer.trigger();
  });
  const pos = page.locator('#panel_element input[aria-label="UI X 偏移"]:visible'),
    width = page.locator('#panel_element input[aria-label="UI 宽度"]:visible');
  await expect(pos).toBeVisible();
  await expect(width).toBeVisible();
  expect(
    await page.locator('#panel_element .form_bar_cube__mcui_size').getAttribute('title'),
  ).toContain('100% - 16px');
  const y = page.locator('#panel_element input[aria-label="UI Y 偏移"]:visible'),
    height = page.locator('#panel_element input[aria-label="UI 高度"]:visible');
  expect(Math.abs((await pos.boundingBox())!.y - (await y.boundingBox())!.y)).toBeLessThan(1);
  expect(Math.abs((await width.boundingBox())!.y - (await height.boundingBox())!.y)).toBeLessThan(
    1,
  );
  await pos.fill('50% - 8px');
  await pos.press('Enter');
  expect(await page.evaluate(() => window.Cube.all[0].from[0])).toBe(152);
  await page.locator('.panel_handle[panel_id="mcui_layout"]').click();
  await expect(page.locator('#panel_mcui_layout')).toBeVisible();
  await page.locator('.panel_handle[panel_id="mcui_content"]').click();
  await expect(page.locator('#panel_mcui_content')).toBeVisible();
  await page.evaluate(() => {
    const panels = (window as any).Interface.Panels;
    panels.transform.selectTab(panels.element);
  });
  await page.screenshot({ path: '.cache/mcui-native-compact.png' });
});

test('原生双轴批量修改只更新编辑的轴', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('layer', root),
      b = app.add('layer', root);
    app.update(b, (n: any) => {
      n.layout.height = { kind: 'fixed', value: 48 };
    });
    app.select([a, b]);
  });
  const width = page.locator('#panel_element input[aria-label="UI 宽度"]:visible');
  await expect(width).toBeVisible();
  await width.fill('64px');
  await width.press('Enter');
  expect(
    await page.evaluate(() => window.Cube.all.map((c: any) => [c.size(0), c.size(2)])),
  ).toEqual([
    [64, 32],
    [64, 48],
  ]);
});

test('原生 Frame 复制继承布局尺寸和子图层规则', async ({ page }) => {
  await start(page);
  const result = await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const frame = app.add('frame', root),
      child = app.add('layer', frame);
    app.makeNine(child);
    app.update(frame, (n: any) => {
      n.frame.direction = 'row';
      n.frame.padding = [4, 4, 4, 4];
    });
    app.update(child, (n: any) => {
      n.layout.width = { kind: 'fill' };
    });
    app.select([frame]);
    const node = (window as any).OutlinerNode.uuids[app.state.doc.bindings[frame].elementId];
    (window as any).moveOutlinerSelectionTo(node, node.parent, 0, { event: { altKey: true } });
    const frames = app.state.doc.nodes[root].children.map((id: string) => app.state.doc.nodes[id]);
    return {
      frames: frames.map((n: any) => ({
        kind: n.kind,
        width: n.rect.width,
        direction: n.frame.direction,
        childKind: app.state.doc.nodes[n.children[0]].content.kind,
      })),
      textures: window.Texture.all.length,
      error: app.state.error,
    };
  });
  expect(result.frames).toEqual([
    { kind: 'frame', width: 160, direction: 'row', childKind: 'nine-slice' },
    { kind: 'frame', width: 160, direction: 'row', childKind: 'nine-slice' },
  ]);
  expect(result.textures).toBe(2);
  expect(result.error).toBeNull();
});

test('内容预览使用原生对话框，取消不修改参数', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio();
    const id = app.add('layer', app.state.doc.roots[0]);
    app.makeNine(id);
    window.BarItems.mcui_content_preview.trigger();
  });
  await expect(page.locator('#mcui_content_preview canvas')).toBeVisible();
  const before = await page.evaluate(() => window.Undo.history.length);
  await page.evaluate(() => (window as any).Dialog.open.cancel());
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
});

test('选择图层自动同步顶面 UV 与贴图，不需进入绘画', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
  });
  const result = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('layer', root),
      b = app.add('layer', root);
    app.update(a, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 48 };
    });
    app.select([a]);
    const uv = (window as any).UVEditor;
    return {
      selected: window.Texture.selected.uuid,
      expected: app.state.doc.bindings[a].textureId,
      uv: uv.vue.texture?.uuid,
      size: [uv.vue.texture?.uv_width, uv.vue.texture?.uv_height],
      faces: uv.getSelectedFaces(
        window.Cube.all.find((c: any) => c.uuid === app.state.doc.bindings[a].elementId),
      ),
      mode: window.Modes.selected.id,
      count: window.Texture.all.length,
    };
  });
  expect(result.selected).toBe(result.expected);
  expect(result.uv).toBe(result.expected);
  expect(result.size).toEqual([48, 32]);
  expect(result.faces).toEqual(['up']);
  expect(result.mode).toBe('edit');
  expect(result.count).toBe(2);
});

test('高清图片缩小只改变几何，UV和纹理不变且支持撤销', async ({ page, context }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
  });
  const result = await page.evaluate(async () => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f00';
    ctx.fillRect(0, 0, 128, 64);
    await app.paste({ png: canvas.toDataURL(), width: 128, height: 64, name: '高清图' });
    const id = app.state.selection[0],
      cube = window.Cube.all[0],
      texture = window.Texture.all[0];
    const before = {
      png: texture.getDataURL(),
      uv: [...cube.faces.up.uv],
      size: [texture.width, texture.height, texture.uv_width, texture.uv_height],
    };
    app.update(id, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 32 };
      n.layout.height = { kind: 'fixed', value: 16 };
    });
    const after = {
      png: texture.getDataURL(),
      uv: [...cube.faces.up.uv],
      size: [texture.width, texture.height, texture.uv_width, texture.uv_height],
    };
    const geometry = [cube.size(0), cube.size(2)];
    const model = JSON.parse(
      JSON.stringify(window.Codecs.project.compile({ raw: true, bitmaps: true })),
    );
    window.Undo.undo();
    return { model, before, after, geometry, undone: [cube.size(0), cube.size(2)] };
  });
  expect(result.after).toEqual(result.before);
  expect(result.after.size).toEqual([128, 64, 128, 64]);
  expect(result.geometry).toEqual([32, 16]);
  expect(result.undone).toEqual([128, 64]);
  const bare = await context.newPage();
  await start(bare, false);
  const loaded = await bare.evaluate(async (model) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(model);
    await Promise.all(window.Texture.all.map((t: any) => t.img.decode()));
    return {
      uv: window.Cube.all[0].faces.up.uv,
      size: [window.Texture.all[0].width, window.Texture.all[0].height],
      geometry: [window.Cube.all[0].size(0), window.Cube.all[0].size(2)],
    };
  }, result.model);
  expect(loaded).toEqual({ uv: result.before.uv, size: [128, 64], geometry: [32, 16] });
  await bare.close();
});

test('原生内容表单设置渐变描边并一键栅格化，Undo恢复规则', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    window.BarItems.mcui_add_layer.trigger();
  });
  await page.locator('.panel_handle[panel_id="mcui_content"]').click();
  await page.evaluate(() => {
    const form = (window as any).Interface.Panels.mcui_content.form;
    form.setValues({
      mcui_style_fill: 'linear',
      mcui_style_color: '#ff0000ff',
      mcui_style_endColor: '#0000ffff',
      mcui_style_angle: 0,
      mcui_style_stroke: 2,
      mcui_style_strokeColor: '#00ff00ff',
    });
    form.dispatchEvent('input', {
      result: form.getResult(),
      changed_keys: [
        'mcui_style_fill',
        'mcui_style_color',
        'mcui_style_endColor',
        'mcui_style_angle',
        'mcui_style_stroke',
        'mcui_style_strokeColor',
      ],
    });
  });
  const before = await page.evaluate(() => window.Texture.all[0].getDataURL());
  await page.getByRole('button', { name: '一键栅格化', exact: true }).click();
  const after = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return {
      appearance: app.state.doc.nodes[app.state.selection[0]].appearance ?? null,
      png: window.Texture.all[0].getDataURL(),
      pixel: Array.from(window.Texture.all[0].ctx.getImageData(0, 0, 1, 1).data),
    };
  });
  expect(after.appearance).toBeNull();
  expect(after.png).toBe(before);
  expect(after.pixel).toEqual([0, 255, 0, 255]);
  await page.evaluate(() => window.Undo.undo());
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = window.Blockbench.mcuiStudio.getStudio();
        return app.state.doc.nodes[app.state.selection[0]].appearance?.fill;
      }),
    )
    .toBe('linear');
  await page.screenshot({ path: '.cache/mcui-style.png' });
});

test('顶视图隐藏原生辅助并淡入全局像素网格，透视与卸载恢复', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    window.BarItems.mcui_add_layer.trigger();
  });
  const result = await page.evaluate(() => {
    const api = window.Blockbench.mcuiStudio,
      viewport = api.getViewport(),
      p = window.Preview.selected;
    viewport.setView('2d');
    p.camera.zoom = (12 * (p.camera.right - p.camera.left)) / p.width;
    p.camera.updateProjectionMatrix();
    p.controls.update();
    viewport.draw();
    const grid = (window as any).three_grid;
    const lines = grid.children.filter((o: any) => o.isLine || o.isLineSegments);
    return {
      hidden: lines.every((o: any) => !p.camera.layers.test(o.layers)),
      count: lines.length,
    };
  });
  expect(result.count).toBeGreaterThan(0);
  expect(result.hidden).toBe(true);
  await expect(page.locator('[data-mcui-grid]').first()).not.toHaveAttribute('d', '');
  await page.screenshot({ path: '.cache/mcui-pixel-grid.png' });
  const restored = await page.evaluate(() => {
    window.Blockbench.mcuiStudio.getViewport().setView('3d');
    const grid = (window as any).three_grid;
    return grid.children
      .filter((o: any) => o.name.startsWith('axis_line'))
      .every((o: any) => o.layers.mask === 1);
  });
  expect(restored).toBe(true);
  await expect(page.locator('[data-mcui-grid]')).toHaveCount(0);
  const cleanup = await page.evaluate(() => {
    window.Blockbench.mcuiStudio.getViewport().setView('2d');
    window.Plugins.registered.mcui_studio.onunload();
    return {
      masks: (window as any).three_grid.children
        .filter((o: any) => o.name.startsWith('axis_line'))
        .map((o: any) => o.layers.mask),
      gizmo: window.Preview.selected.orbit_gizmo.node.style.display,
    };
  });
  expect(cleanup.masks.every((mask: number) => mask === 1)).toBe(true);
  expect(cleanup.gizmo).not.toBe('none');
});

test('直接绘制有外观的成品会保护像素，显式栅格化后可继续绘画', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
  });
  const result = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      id = app.add('layer');
    app.update(id, (n: any) => {
      n.appearance = {
        fill: 'solid',
        color: '#ff000080',
        endColor: '#000000ff',
        angle: 0,
        strokeColor: '#00ff00ff',
        strokeWidth: 0,
      };
    });
    const tex = window.Texture.all[0];
    window.Undo.initEdit({ textures: [tex], bitmap: true });
    tex.ctx.clearRect(0, 0, 1, 1);
    tex.ctx.fillStyle = '#0000ff';
    tex.ctx.fillRect(0, 0, 1, 1);
    tex.updateChangesAfterEdit();
    window.Undo.finishEdit('Paint styled texture');
    const suspended = app.state.doc.nodes[id].suspended;
    const painted = Array.from(tex.ctx.getImageData(0, 0, 1, 1).data);
    app.flatten(id);
    return {
      suspended,
      painted,
      flattened: Array.from(tex.ctx.getImageData(0, 0, 1, 1).data),
      appearance: app.state.doc.nodes[id].appearance ?? null,
      active: !app.state.doc.nodes[id].suspended,
    };
  });
  expect(result.suspended).toContain('手工修改');
  expect(result.painted).toEqual([0, 0, 255, 255]);
  expect(result.flattened).toEqual(result.painted);
  expect(result.appearance).toBeNull();
  expect(result.active).toBe(true);
});

test('图形化自动布局：方向、九点对齐、两端分布及边距联动', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('layer', root),
      b = app.add('layer', root);
    app.execute('准备布局预览', (doc: any) => {
      doc.nodes[root].layout.width = { kind: 'fixed', value: 180 };
      doc.nodes[root].layout.height = { kind: 'fixed', value: 110 };
      for (const [id, color] of [
        [a, '#ed9065ff'],
        [b, '#64badcff'],
      ])
        doc.nodes[id].appearance = {
          fill: 'solid',
          color,
          endColor: color,
          angle: 0,
          strokeColor: '#ffffff',
          strokeWidth: 1,
        };
    });
    window.Blockbench.mcuiStudio.getViewport().fit();
    app.select([root]);
  });
  await page.locator('.panel_handle[panel_id="mcui_layout"]').click();
  await page.locator('#panel_mcui_layout .form_bar_mcui_direction li[key="row"]').click();
  await page.getByRole('button', { name: '子项对齐：上右', exact: true }).click();
  const frame = () =>
    page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.doc.nodes[app.state.selection[0]].frame;
    });
  expect(await frame()).toMatchObject({ direction: 'row', justify: 'end', align: 'start' });
  await page.locator('#panel_mcui_layout .form_bar_mcui_direction li[key="column"]').click();
  await page.getByRole('button', { name: '子项对齐：上右', exact: true }).click();
  expect(await frame()).toMatchObject({ direction: 'column', justify: 'start', align: 'end' });
  await page.getByRole('button', { name: '两端分布', exact: true }).click();
  expect(await frame()).toMatchObject({ justify: 'space-between', align: 'end' });
  const top = page.getByRole('spinbutton', { name: '上内边距' });
  await top.fill('6');
  await top.press('Enter');
  expect((await frame()).padding).toEqual([6, 6, 6, 6]);
  await page.getByRole('button', { name: '联动四边内边距' }).click();
  const left = page.getByRole('spinbutton', { name: '左内边距' });
  await left.fill('12');
  await left.press('Enter');
  expect((await frame()).padding).toEqual([6, 6, 6, 12]);
  await page.evaluate(() => window.Undo.undo());
  expect((await frame()).padding).toEqual([6, 6, 6, 6]);
  await page.screenshot({ path: '.cache/mcui-visual-layout.png' });
});

test('多选边距只改一边；尺寸快捷规则、锚点和约束折叠', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('frame', root),
      b = app.add('frame', root);
    app.update(a, (n: any) => {
      n.frame.direction = 'row';
      n.frame.padding = [1, 2, 3, 4];
    });
    app.update(b, (n: any) => {
      n.frame.direction = 'row';
      n.frame.padding = [5, 6, 7, 8];
    });
    app.select([a, b]);
  });
  await page.locator('.panel_handle[panel_id="mcui_layout"]').click();
  const left = page.getByRole('spinbutton', { name: '左内边距' });
  await left.fill('10');
  await left.press('Enter');
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.selection.map((id: string) => app.state.doc.nodes[id].frame.padding);
    }),
  ).toEqual([
    [1, 2, 3, 10],
    [5, 6, 7, 10],
  ]);
  await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.select([app.state.selection[0]]);
  });
  await page.locator('.panel_handle[panel_id="mcui_layout"]').click();
  await page.locator('#panel_mcui_layout .form_bar_mcui_sizing_width li[key="fill"]').click();
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.doc.nodes[app.state.selection[0]].layout.width.kind;
    }),
  ).toBe('fill');
  await page.getByRole('button', { name: '父锚点：中中', exact: true }).click();
  await page.getByRole('button', { name: '自身锚点：中中', exact: true }).click();
  await expect(page.locator('#panel_mcui_layout .form_bar_mcui_maxWidth')).toBeHidden();
  await page.locator('#panel_mcui_layout .form_bar_mcui_advanced_layout input').check();
  await expect(page.locator('#panel_mcui_layout .form_bar_mcui_maxWidth')).toBeVisible();
});

test('一键组成自动布局并打开布局标签，撤销恢复层级，卸载注销图形控件', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('layer', root),
      b = app.add('layer', root);
    app.update(b, (n: any) => {
      n.layout.offset.x = 48;
    });
    app.select([a, b]);
    window.BarItems.mcui_wrap_layout.trigger();
  });
  await expect(page.locator('#panel_mcui_layout')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio(),
        n = app.state.doc.nodes[app.state.selection[0]];
      return [n.name, n.frame.direction, n.frame.gap, n.children.length];
    }),
  ).toEqual(['自动布局', 'row', 8, 2]);
  await page.evaluate(() => window.Undo.undo());
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.doc.nodes[app.state.doc.roots[0]].children.length;
    }),
  ).toBe(2);
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  expect(await page.evaluate(() => !!(window as any).FormElement.types.mcui_alignment)).toBe(false);
  await expect(page.locator('.mcui-matrix')).toHaveCount(0);
});

test('尺寸策略预检、键盘方向操作和切回自由布局保持位置', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    app.add('layer', root);
    app.add('layer', root);
    app.select([root]);
  });
  await page.locator('.panel_handle[panel_id="mcui_layout"]').click();
  await expect(
    page.locator('#panel_mcui_layout .form_bar_mcui_sizing_width li[key="expression"]'),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#panel_mcui_layout .form_bar_mcui_direction li[key="row"]').click();
  const middle = page.getByRole('button', { name: '子项对齐：中中', exact: true });
  await middle.focus();
  await middle.press('ArrowRight');
  const before = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return {
      rects: window.Cube.all.map((c: any) => [...c.from, ...c.to]),
      frame: app.state.doc.nodes[app.state.selection[0]].frame,
      error: app.state.error,
    };
  });
  expect(before.frame).toMatchObject({ justify: 'end', align: 'center' });
  expect(before.error).toBeNull();
  await page.locator('#panel_mcui_layout .form_bar_mcui_direction li[key="free"]').click();
  expect(await page.evaluate(() => window.Cube.all.map((c: any) => [...c.from, ...c.to]))).toEqual(
    before.rects,
  );
  await expect(page.getByRole('button', { name: '子项对齐：中中', exact: true })).toBeHidden();
});
