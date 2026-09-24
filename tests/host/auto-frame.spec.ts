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
}
async function fixture(page: Page) {
  await start(page);
  return page.evaluate(() => {
    const api = window.Blockbench.mcuiStudio,
      a = api.getStudio(),
      root = a.state.doc.roots[0],
      frame = a.add('frame', root),
      one = a.add('image', frame),
      two = a.add('image', frame);
    a.execute('Auto fixture', (d: any) => {
      d.nodes[one].layout.offset = { x: 0, y: 0 };
      d.nodes[two].layout.offset = { x: 64, y: 32 };
      d.nodes[one].appearance = {
        fill: 'solid',
        color: '#577fddff',
        endColor: '#577fddff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffffff',
      };
      d.nodes[two].appearance = {
        fill: 'solid',
        color: '#dc7957ff',
        endColor: '#dc7957ff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffffff',
      };
    });
    api.getViewport().setSmartSnapping(false);
    api.getViewport().setAutomaticPlacement(false);
    api.getViewport().fit();
    return { root, frame, one, two };
  });
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio(),
      d = a.state.doc;
    return {
      doc: JSON.parse(JSON.stringify(d)),
      undo: w.Undo.history.length,
      selection: a.state.selection,
      error: a.state.error,
      textures: w.Texture.all.map((t: any) => [t.uuid, t.getDataURL()]),
      cubes: w.Cube.all.map((c: any) => ({
        uuid: c.uuid,
        from: c.from,
        to: c.to,
        parent: c.parent.uuid,
        uv: c.faces.up.uv,
        texture: c.faces.up.texture,
      })),
    };
  });
}
async function point(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const p = window.Preview.selected,
        r = p.canvas.getBoundingClientRect(),
        v = new (window as any).THREE.Vector3(x, 0, y).project(p.camera);
      return { x: r.left + ((v.x + 1) * r.width) / 2, y: r.top + ((1 - v.y) * r.height) / 2 };
    },
    { x, y },
  );
}
async function history(page: Page, redo = false) {
  await page.evaluate((redo) => (redo ? window.Undo.redo() : window.Undo.undo()), redo);
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
}

test('默认Auto、固定画板、逐轴按钮与混选能力；界面截图', async ({ page }) => {
  const ids = await fixture(page),
    before = await snapshot(page);
  expect(before.doc.nodes[ids.root].layout.width.kind).toBe('fixed');
  expect(before.doc.nodes[ids.frame].layout.width.kind).toBe('auto');
  expect(before.doc.nodes[ids.frame].rect.width).toBe(96);
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().select([id]), ids.frame);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  const button = page.getByRole('button', { name: '宽度自动尺寸', exact: true });
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await button.click();
  expect((await snapshot(page)).doc.nodes[ids.frame].layout.width).toEqual({
    kind: 'fixed',
    value: 96,
  });
  await button.click();
  await expect(page.getByLabel('布局宽度', { exact: true })).toHaveValue('auto');
  await page.screenshot({ path: '.cache/mcui-frame-auto.png' });
  await page.locator('[data-size-editor=visual]').click();
  await expect(page.getByLabel('宽度参照', { exact: true })).toHaveValue('auto');
  await page.evaluate(({ frame, root }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    const sibling = a.add('image', root);
    a.select([frame, sibling]);
  }, ids);
  await expect(
    page.getByLabel('宽度参照', { exact: true }).locator('option[value=auto]'),
  ).toBeDisabled();
  await page.locator('[data-size-editor=expression]').click();
  await expect(button).toBeHidden();
  const raw = page.getByLabel('布局宽度', { exact: true });
  await raw.fill('auto');
  await raw.press('Enter');
  await expect(raw).toHaveAttribute('aria-invalid', 'true');
  expect((await snapshot(page)).doc.nodes[ids.one].layout.width.kind).toBe('fixed');
});

test('真实鼠标移动子项：边界跟随、兄弟/纹理不变、单次Undo和Redo', async ({ page }) => {
  const ids = await fixture(page);
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().select([id]), ids.one);
  const before = await snapshot(page),
    r = before.doc.nodes[ids.one].rect;
  const from = await point(page, r.x + 16, r.y + 16),
    to = await point(page, r.x - 16, r.y - 4);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  const after = await snapshot(page);
  expect(after.error).toBeNull();
  expect(after.doc.nodes[ids.one].rect.x).toBeCloseTo(r.x - 32, 0);
  expect(after.doc.nodes[ids.two].rect).toEqual(before.doc.nodes[ids.two].rect);
  expect(after.doc.nodes[ids.frame].rect.width).toBeCloseTo(128, 0);
  expect(after.doc.nodes[ids.frame].layout.width.kind).toBe('auto');
  expect(after.textures).toEqual(before.textures);
  expect(after.undo).toBe(before.undo + 1);
  await history(page);
  const undo = await snapshot(page);
  expect(undo.doc.nodes).toEqual(before.doc.nodes);
  expect(undo.cubes).toEqual(before.cubes);
  await history(page, true);
  const redo = await snapshot(page);
  expect(redo.doc.nodes).toEqual(after.doc.nodes);
  expect(redo.cubes).toEqual(after.cubes);
});

test('新增原生Group为Auto；编组百分比子项保持显示尺寸并避免循环；复制与保存重开', async ({
  page,
}) => {
  const ids = await fixture(page);
  const group = await page.evaluate(({ root, one, two }) => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio();
    a.update(one, (n: any) => (n.layout.width = { kind: 'fixed', value: 40 }));
    a.select([one, two]);
    w.BarItems.add_group.trigger();
    return a.state.selection[0];
  }, ids);
  let s = await snapshot(page);
  expect(s.error).toBeNull();
  expect(s.doc.nodes[group].layout.width.kind).toBe('auto');
  expect(s.doc.nodes[group].children).toEqual([ids.one, ids.two]);
  expect(s.doc.nodes[ids.one].layout.width).toEqual({ kind: 'fixed', value: 40 });
  await page.evaluate((id) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.select([id]);
    a.duplicate();
  }, group);
  s = await snapshot(page);
  const copy = s.selection[0];
  expect(s.doc.nodes[copy].layout.width.kind).toBe('auto');
  expect(s.doc.nodes[copy].children).toHaveLength(2);
  const model = await page.evaluate(() =>
    window.Codecs.project.compile({ raw: true, bitmaps: true }),
  );
  await page.evaluate((m) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(m);
  }, model);
  await page.waitForFunction(
    () =>
      !!window.Blockbench.mcuiStudio.getStudio() &&
      !window.Blockbench.mcuiStudio.getStudio().state.busy,
  );
  const reopened = await snapshot(page);
  expect(reopened.doc.nodes).toEqual(s.doc.nodes);
  expect(Object.values(reopened.doc.nodes).filter((n: any) => n.suspended)).toHaveLength(0);
  await page.evaluate(() => (window as any).Plugins.registered.mcui_studio.onunload());
  expect(await page.evaluate(() => (window as any).Cube.all.length)).toBe(s.cubes.length);
});

test('旋转Auto边界、编辑原生尺寸、循环拒绝保持原文档', async ({ page }) => {
  const ids = await fixture(page);
  await page.evaluate(({ frame, one }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(frame, (n: any) => (n.rotation = 30));
    a.update(one, (n: any) => (n.rotation = 45));
    a.select([frame]);
  }, ids);
  await page.locator('.panel_handle[panel_id=element]').click();
  const width = page.getByLabel('UI 宽度', { exact: true });
  await expect(width).toHaveValue('auto');
  await width.fill('180px');
  await width.press('Enter');
  const fixed = await snapshot(page);
  expect(fixed.doc.nodes[ids.frame].layout.width.kind).toBe('fixed');
  await width.fill('auto');
  await width.press('Enter');
  const before = await snapshot(page);
  const result = await page.evaluate(
    (id) =>
      window.Blockbench.mcuiStudio
        .getStudio()
        .update(id, (n: any) => (n.layout.width = { kind: 'expression', percent: 1, pixels: 0 })),
    ids.one,
  );
  const invalid = await snapshot(page);
  expect(invalid.error).toMatch(/循环/);
  expect(invalid.doc.nodes).toEqual(before.doc.nodes);
  expect(invalid.undo).toBe(before.undo);
});

test('自动按钮拒绝百分比尺寸循环，保留模型与历史并展示可理解错误', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ids = await fixture(page);
  await page.evaluate(({ frame, one }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(frame, (n: any) => (n.layout.width = { kind: 'fixed', value: 200 }));
    a.update(one, (n: any) => (n.layout.width = { kind: 'expression', percent: 0.5, pixels: 0 }));
    a.select([frame]);
  }, ids);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  const before = await snapshot(page);
  await page.getByRole('button', { name: '宽度自动尺寸', exact: true }).click();
  const after = await snapshot(page);
  expect(after.error).toMatch(/循环/);
  expect(after.doc.nodes).toEqual(before.doc.nodes);
  expect(after.undo).toBe(before.undo);
  await expect(page.getByRole('button', { name: '宽度自动尺寸', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(errors).toEqual([]);
});
