import { test, expect, type Page } from './host-test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
  await page.waitForFunction(() => window.Blockbench?.setup_successful);
  await page.evaluate(
    () => (window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio')),
  );
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
  return page.evaluate(() => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      root = a.state.doc.roots[0],
      image = a.add('image', root),
      peer = a.add('image', root);
    a.update(image, (n: any) => {
      n.layout.offset = { x: 20, y: 35 };
      n.layout.width = { kind: 'fixed', value: 31 };
      n.layout.height = { kind: 'fixed', value: 21 };
      n.appearance = {
        fill: 'solid',
        color: '#ff9955ff',
        endColor: '#ff9955ff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffffff',
      };
    });
    a.update(peer, (n: any) => {
      n.layout.offset = { x: 225, y: 135 };
    });
    a.select([image]);
    window.Blockbench.mcuiStudio.getViewport().setAutomaticPlacement(false);
    return { root, image, peer };
  });
}
const point = (page: Page, x: number, y: number) =>
  page.evaluate(
    ({ x, y }) => {
      const p = window.Preview.selected,
        r = p.canvas.getBoundingClientRect(),
        v = new (window as any).THREE.Vector3(x, 0, y).project(p.camera);
      return { x: r.x + ((v.x + 1) * r.width) / 2, y: r.y + ((1 - v.y) * r.height) / 2 };
    },
    { x, y },
  );
const snap = (page: Page, id: string) =>
  page.evaluate((id) => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      b = a.state.doc.bindings[id],
      cube = (window as any).OutlinerNode.uuids[b.surfaceId],
      c = new (window as any).THREE.Vector3().applyMatrix4(cube.mesh.matrixWorld);
    return {
      doc: JSON.stringify(a.state.doc),
      rect: a.state.doc.nodes[id].rect,
      preview: a.movePreview,
      world: { x: c.x, y: c.z },
      undo: window.Undo.history.length,
      textures: window.Texture.all.length,
      error: a.state.error,
    };
  }, id);
async function drag(page: Page) {
  const from = await point(page, 35.5, 45.5),
    to = await point(page, 162, 92);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

test('移动居中吸附显示紫色1px细线，半像素中心、临时绕过、单次Undo', async ({ page }) => {
  const ids = await start(page),
    before = await snap(page, ids.image);
  await drag(page);
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(2);
  await expect(page.locator('[data-mcui-snap]').first()).toHaveAttribute('stroke', '#a259ff');
  await expect(page.locator('[data-mcui-snap]').first()).toHaveAttribute('stroke-width', '1');
  let moving = await snap(page, ids.image);
  expect(moving.world.x).toBeCloseTo(160, 5);
  expect(moving.world.y).toBeCloseTo(90, 5);
  expect(moving.doc).toBe(before.doc);
  expect(moving.undo).toBe(before.undo);
  expect(moving.textures).toBe(before.textures);
  await page.keyboard.down('Control');
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(0);
  expect((await snap(page, ids.image)).world.x).toBeGreaterThan(161);
  await page.keyboard.up('Control');
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(2);
  await page.screenshot({ path: '.cache/mcui-smart-snap.png' });
  await page.mouse.up();
  const after = await snap(page, ids.image);
  expect(after.rect.x).toBe(144.5);
  expect(after.rect.y).toBe(79.5);
  expect(after.undo).toBe(before.undo + 1);
  expect(after.error).toBeNull();
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(0);
  await page.evaluate(() => window.Undo.undo());
  await expect.poll(async () => (await snap(page, ids.image)).doc).toBe(before.doc);
});

test('A/R普通拖绘吸附活动边，Shift约束不被吸附打破', async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setAutomaticPlacement(true));
  await page.keyboard.press('r');
  const from = await point(page, 25, 25),
    to = await point(page, 161, 91);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(2);
  await page.keyboard.down('Shift');
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(0);
  await page.keyboard.up('Shift');
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(2);
  await page.mouse.up();
  const rect = await page.evaluate(() => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    return a.state.doc.nodes[a.state.selection[0]].rect;
  });
  expect(rect).toEqual({ x: 25, y: 25, width: 135, height: 65 });
});

test('开关偏好合并保存，关闭不吸附；取消、模式和卸载清理提示', async ({ page }) => {
  const ids = await start(page),
    before = await snap(page, ids.image);
  await drag(page);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await snap(page, ids.image)).doc).toBe(before.doc);
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(0);
  await page.locator('[toolbar_item=mcui_smart_snap]').click();
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('mcui_preferences')!));
  expect(prefs.smartSnap).toBe(false);
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('mcui_preferences')!);
    localStorage.setItem('mcui_preferences', JSON.stringify({ ...p, inspector: { test: true } }));
  });
  await drag(page);
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(0);
  expect((await snap(page, ids.image)).world.x).toBeGreaterThan(161);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.locator('[toolbar_item=mcui_smart_snap]').click();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('mcui_preferences')!).inspector.test),
  ).toBe(true);
  await drag(page);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setView('3d'));
  await page.mouse.up();
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(0);
  expect((await snap(page, ids.image)).doc).toBe(before.doc);
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  expect(await page.evaluate(() => !!window.BarItems.mcui_smart_snap)).toBe(false);
});

test('旋转多选按可见整体边界吸附，保持相对位置和角度', async ({ page }) => {
  const ids = await start(page);
  const info = await page.evaluate(({ image, peer }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(image, (n: any) => (n.rotation = 25));
    a.update(peer, (n: any) => (n.rotation = -15));
    a.select([image, peer]);
    const r = a.getSelectionBounds(),
      c = a.getSelectionBox();
    return {
      bounds: r,
      relative: {
        x: a.state.doc.nodes[peer].rect.x - a.state.doc.nodes[image].rect.x,
        y: a.state.doc.nodes[peer].rect.y - a.state.doc.nodes[image].rect.y,
      },
    };
  }, ids);
  const a = await point(page, 35.5, 45.5),
    r = info.bounds,
    dx = 160 - (r.x + r.width / 2) + 0.5,
    dy = 90 - (r.y + r.height / 2) + 0.5,
    b = await point(page, 35.5 + dx, 45.5 + dy);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await expect(page.locator('[data-mcui-snap]')).toHaveCount(2);
  await page.mouse.up();
  const result = await page.evaluate(({ image, peer }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    return {
      bounds: a.getSelectionBounds(),
      x: a.state.doc.nodes[peer].rect.x - a.state.doc.nodes[image].rect.x,
      y: a.state.doc.nodes[peer].rect.y - a.state.doc.nodes[image].rect.y,
      rotations: [a.state.doc.nodes[image].rotation, a.state.doc.nodes[peer].rotation],
    };
  }, ids);
  expect(result.bounds.x + result.bounds.width / 2).toBeCloseTo(160, 5);
  expect(result.bounds.y + result.bounds.height / 2).toBeCloseTo(90, 5);
  expect(result.x).toBeCloseTo(info.relative.x, 5);
  expect(result.y).toBeCloseTo(info.relative.y, 5);
  expect(result.rotations).toEqual([25, -15]);
});

test('居中锚点的半像素吸附保存重开后位置不漂移', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ image }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(image, (n: any) => {
      n.layout.anchorFrom = [0.5, 0.5];
      n.layout.anchorTo = [0.5, 0.5];
      n.layout.offset = { x: 10, y: 10 };
    });
  }, ids);
  const initial = await snap(page, ids.image),
    from = await point(page, initial.world.x, initial.world.y),
    to = await point(page, 161, 91);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  expect((await snap(page, ids.image)).rect.x).toBe(144.5);
  expect((await snap(page, ids.image)).rect.y).toBe(79.5);
  const model = await page.evaluate(() =>
    window.Codecs.project.compile({ raw: true, bitmaps: true }),
  );
  await page.evaluate((m) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(m);
  }, model);
  await page.waitForFunction((id) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    return a?.state.doc.nodes[id]?.layout.subpixel === true && !a.state.busy;
  }, ids.image);
  const reopened = await snap(page, ids.image);
  expect(reopened.rect.x).toBe(144.5);
  expect(reopened.world.x).toBeCloseTo(160, 5);
  expect(reopened.world.y).toBeCloseTo(90, 5);
  expect(reopened.error).toBeNull();
});
