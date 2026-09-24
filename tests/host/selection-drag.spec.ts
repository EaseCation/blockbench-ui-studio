import { test, expect, type Page } from './host-test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.Blockbench?.setup_successful);
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
  return page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio();
    const root = a.state.doc.roots[0],
      card = a.add('frame', root),
      one = a.add('image', card),
      two = a.add('image', card),
      other = a.add('image', root);
    a.execute('Drag selection fixture', (d: any) => {
      for (const [id, x, y, width, height] of [
        [card, 30, 30, 150, 110],
        [one, 20, 20, 40, 30],
        [two, 85, 20, 30, 30],
        [other, 230, 60, 30, 30],
      ]) {
        const n = d.nodes[id];
        n.layout.offset = { x, y };
        n.layout.width = { kind: 'fixed', value: width };
        n.layout.height = { kind: 'fixed', value: height };
      }
    });
    const v = w.Blockbench.mcuiStudio.getViewport();
    v.setAutomaticPlacement(false);
    v.setSmartSnapping(false);
    v.fit();
    return { root, card, one, two, other };
  });
}
async function point(page: Page, id: string) {
  return page.evaluate((id) => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio(),
      p = w.Preview.selected,
      r = p.canvas.getBoundingClientRect();
    const points = a.state.scene.nodes[id].corners;
    const center = points.reduce((p: any, c: any) => ({ x: p.x + c.x / 4, y: p.y + c.y / 4 }), {
      x: 0,
      y: 0,
    });
    const v = new w.THREE.Vector3(center.x, 0, center.y).project(p.camera);
    return { x: r.left + ((v.x + 1) * r.width) / 2, y: r.top + ((1 - v.y) * r.height) / 2 };
  }, id);
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio();
    return {
      doc: a.state.doc,
      selection: a.state.selection,
      history: w.Undo.history.length,
      png: w.Texture.all.map((t: any) => t.getDataURL()),
      centers: Object.fromEntries(
        a.state.scene.order.map((id: string) => {
          const c = a.state.scene.nodes[id].corners;
          return [
            id,
            c.reduce((p: any, q: any) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4 }), { x: 0, y: 0 }),
          ];
        }),
      ),
    };
  });
}
async function selectOutliner(page: Page, id: string) {
  const uuid = await page.evaluate(
    (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.bindings[id].containerId,
    id,
  );
  await page.locator(`[id="${uuid}"] > .outliner_object`).click();
  expect((await snapshot(page)).selection).toEqual([id]);
}
for (const scenario of ['root', 'nested', 'rotated'] as const) {
  test(`已选Frame从子Image内部拖动，父子整体跟随且只有一次Undo：${scenario}`, async ({ page }) => {
    const ids = await start(page),
      frame = scenario === 'root' ? ids.root : ids.card;
    if (scenario === 'rotated')
      await page.evaluate(
        (id) => window.Blockbench.mcuiStudio.getStudio().update(id, (n: any) => (n.rotation = 30)),
        frame,
      );
    await selectOutliner(page, frame);
    const before = await snapshot(page),
      p = await point(page, ids.one);
    await page.mouse.move(p.x, p.y);
    await expect(page.locator('[data-mcui-hover]')).toHaveCount(0);
    await page.mouse.down();
    expect((await snapshot(page)).selection).toEqual([frame]);
    await page.mouse.move(p.x + 36, p.y + 24, { steps: 5 });
    const preview = await snapshot(page);
    expect(preview.selection).toEqual([frame]);
    expect(preview.doc).toEqual(before.doc);
    await page.mouse.up();
    const after = await snapshot(page);
    expect(after.selection).toEqual([frame]);
    expect(after.history).toBe(before.history + 1);
    expect(after.png).toEqual(before.png);
    const dx = after.centers[frame].x - before.centers[frame].x,
      dy = after.centers[frame].y - before.centers[frame].y;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(3);
    for (const id of [ids.one, ids.two]) {
      expect(after.centers[id].x - before.centers[id].x).toBeCloseTo(dx, 5);
      expect(after.centers[id].y - before.centers[id].y).toBeCloseTo(dy, 5);
      expect(after.doc.nodes[id].layout).toEqual(before.doc.nodes[id].layout);
    }
    await page.evaluate(() => window.Undo.undo());
    await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
    expect((await snapshot(page)).centers).toEqual(before.centers);
    await page.evaluate(() => window.Undo.redo());
    await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
    expect((await snapshot(page)).centers).toEqual(after.centers);
  });
}
test('已选Frame空白内部也可拖动，Escape取消不改变选区、文档及历史', async ({ page }) => {
  const ids = await start(page);
  await selectOutliner(page, ids.card);
  const before = await snapshot(page),
    p = await point(page, ids.card);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 35, p.y + 25, { steps: 5 });
  await expect(page.locator('#selection_box')).toHaveCount(0);
  expect((await snapshot(page)).selection).toEqual([ids.card]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const after = await snapshot(page);
  expect(after.doc).toEqual(before.doc);
  expect(after.selection).toEqual(before.selection);
  expect(after.history).toBe(before.history);
});
test('多选保持整体拖动，Shift追加、Cmd深选与双击绘画仍可进入子Image', async ({ page }) => {
  const ids = await start(page);
  await selectOutliner(page, ids.card);
  const other = await point(page, ids.other);
  await page.keyboard.down('Shift');
  await page.mouse.click(other.x, other.y);
  await page.keyboard.up('Shift');
  expect((await snapshot(page)).selection.sort()).toEqual([ids.card, ids.other].sort());
  const before = await snapshot(page),
    p = await point(page, ids.one);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y + 20, { steps: 5 });
  await page.mouse.up();
  const after = await snapshot(page);
  expect(after.selection.sort()).toEqual(before.selection.sort());
  expect(after.centers[ids.other].x - before.centers[ids.other].x).toBeCloseTo(
    after.centers[ids.card].x - before.centers[ids.card].x,
    5,
  );
  const child = await point(page, ids.one);
  await page.keyboard.down('Meta');
  await page.mouse.click(child.x, child.y);
  await page.keyboard.up('Meta');
  expect((await snapshot(page)).selection).toEqual([ids.one]);
  await selectOutliner(page, ids.card);
  await page.mouse.dblclick(child.x, child.y);
  await page.waitForFunction(() => window.Modes.paint === true);
  const painted = await page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio();
    return {
      selected: w.Cube.selected.map((c: any) => c.uuid),
      texture: w.Texture.selected.uuid,
      bindings: a.state.doc.bindings,
    };
  });
  expect(painted.selected).toEqual([painted.bindings[ids.one].surfaceId]);
  expect(painted.texture).toBe(painted.bindings[ids.one].textureId);
});
