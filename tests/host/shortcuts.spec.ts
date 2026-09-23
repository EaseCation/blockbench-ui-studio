import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
  return page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('image', root),
      b = app.add('image', root);
    app.update(b, (n: any) => {
      n.layout.offset.x = 56;
    });
    app.select([a, b]);
    (window as any).Prop.active_panel = 'preview';
    return { a, b, root };
  });
}
const snap = (page: Page) =>
  page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return {
      doc: app.state.doc,
      selection: app.state.selection,
      undo: window.Undo.history.length,
      tool: (window as any).Toolbox.selected.id,
    };
  });
test('Shift+A 包裹选区，重复不套娃，Alt+Shift+A 保留边界和单次撤销', async ({ page }) => {
  const ids = await start(page),
    before = await snap(page);
  await page.keyboard.press('Shift+a');
  const wrapped = await snap(page),
    frame = wrapped.doc.nodes[wrapped.selection[0]];
  expect(frame.children).toEqual([ids.a, ids.b]);
  expect(frame.frame.direction).toBe('row');
  expect(frame.frame.gap).toBe(16);
  expect(wrapped.undo).toBe(before.undo + 1);
  await page.keyboard.press('Shift+a');
  expect((await snap(page)).undo).toBe(wrapped.undo);
  await page.keyboard.press('Alt+Shift+a');
  const removed = await snap(page);
  expect(removed.doc.nodes[frame.id].frame.direction).toBe('free');
  for (const id of [frame.id, ids.a, ids.b])
    expect(removed.doc.nodes[id].rect).toEqual(wrapped.doc.nodes[id].rect);
  expect(removed.undo).toBe(wrapped.undo + 1);
  await page.evaluate(() => window.Undo.undo());
  expect((await snap(page)).doc.nodes[frame.id].frame.direction).toBe('row');
  await expect(page.locator('#panel_mcui_layout')).toBeVisible();
});
test('单 Frame 原地启用，空 Frame 默认间距，锁定选区保护及重绑定', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ root }) => window.Blockbench.mcuiStudio.getStudio().select([root]), ids);
  const before = await snap(page);
  await page.keyboard.press('Shift+a');
  let after = await snap(page);
  expect(Object.keys(after.doc.nodes)).toHaveLength(Object.keys(before.doc.nodes).length);
  expect(after.doc.nodes[ids.root].frame.direction).toBe('row');
  await page.evaluate(() => window.BarItems.mcui_auto_layout.keybind.set({ key: 81, shift: true }));
  const empty = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return app.add('frame', null);
  });
  await page.keyboard.press('Shift+q');
  after = await snap(page);
  expect(after.doc.nodes[empty].frame).toMatchObject({ direction: 'row', gap: 8 });
  await page.evaluate(({ a }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.update(a, (n: any) => {
      n.locked = true;
    });
    app.select([a]);
  }, ids);
  const locked = await snap(page);
  await page.keyboard.press('Shift+q');
  expect((await snap(page)).undo).toBe(locked.undo);
});
test('Shift+1/2 只移动相机，不写贴图或 Undo，空选区不误切视角', async ({ page }) => {
  await start(page);
  const before = await snap(page);
  await page.keyboard.press('Shift+1');
  const all = await page.evaluate(() => window.Preview.selected.camera.zoom);
  await page.keyboard.press('Shift+2');
  const selected = await page.evaluate(() => window.Preview.selected.camera.zoom);
  expect(selected).toBeGreaterThan(all);
  const after = await snap(page);
  expect(after.doc).toEqual(before.doc);
  expect(after.undo).toBe(before.undo);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().select([]));
  await page.keyboard.press('Shift+2');
  expect(await page.evaluate(() => window.Preview.selected.angle)).toBe('top');
});
test('输入、对话框、原生和透视不接管，按住快捷键不重复创建，卸载清理', async ({ page }) => {
  await start(page);
  const input = page.locator('#panel_element input[aria-label="UI 宽度"]');
  await input.focus();
  const before = await snap(page);
  await page.keyboard.press('Shift+a');
  expect((await snap(page)).undo).toBe(before.undo);
  await input.press('Escape');
  await input.blur();
  await page.evaluate(() =>
    new (window as any).Dialog({ id: 'shortcut_guard', title: 'test', lines: ['test'] }).show(),
  );
  await page.keyboard.press('Shift+a');
  expect((await snap(page)).undo).toBe(before.undo);
  await page.evaluate(() => (window as any).Dialog.open.cancel());
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await page.keyboard.press('Shift+a');
  expect((await snap(page)).undo).toBe(before.undo);
  await page.evaluate(() => {
    const v = window.Blockbench.mcuiStudio.getViewport();
    v.setInteraction('figma');
    v.setView('3d');
  });
  await page.keyboard.press('Shift+a');
  expect((await snap(page)).undo).toBe(before.undo);
  await page.evaluate(() => {
    window.Blockbench.mcuiStudio.getViewport().setView('2d');
    (window as any).Prop.active_panel = 'preview';
  });
  await page.keyboard.down('Shift');
  await page.keyboard.down('a');
  await page.keyboard.down('a');
  await page.keyboard.up('a');
  await page.keyboard.up('Shift');
  expect((await snap(page)).undo).toBe(before.undo + 1);
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  expect(await page.evaluate(() => !!window.BarItems.mcui_auto_layout)).toBe(false);
});
test('点击 UI 布局后 Command/Ctrl+D 仍复制逻辑图层，包含独立内容', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ a }) => window.Blockbench.mcuiStudio.getStudio().select([a]), ids);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  await page.locator('#panel_mcui_layout h3').first().click();
  const before = await snap(page);
  await page.keyboard.press('ControlOrMeta+d');
  const after = await snap(page);
  expect(after.undo).toBe(before.undo + 1);
  expect(after.doc.nodes[ids.root].children).toHaveLength(3);
  expect(after.doc.bindings[after.selection[0]].textureId).not.toBe(
    after.doc.bindings[ids.a].textureId,
  );
});

test('颜色弹层和未完成的绘制手势不执行自动布局或视图快捷键', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ a }) => window.Blockbench.mcuiStudio.getStudio().select([a]), ids);
  await page.locator('.panel_handle[panel_id=mcui_content]').click();
  await page.getByRole('button', { name: '添加填充', exact: true }).click();
  await page.locator('.mcui-inspector-color[aria-label^="填充颜色"] .sp-replacer').click();
  const before = await snap(page),
    zoom = await page.evaluate(() => window.Preview.selected.camera.zoom);
  await page.keyboard.press('Shift+a');
  await page.keyboard.press('Shift+1');
  expect((await snap(page)).undo).toBe(before.undo);
  expect(await page.evaluate(() => window.Preview.selected.camera.zoom)).toBe(zoom);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    (window as any).Prop.active_panel = 'preview';
    window.BarItems.mcui_draw_image.select();
  });
  const point = await page.evaluate(() => {
    const r = window.Preview.selected.canvas.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y + 20);
  const drafting = await snap(page);
  await page.keyboard.press('Shift+a');
  await page.keyboard.press('Shift+2');
  expect((await snap(page)).undo).toBe(drafting.undo);
  expect(await page.evaluate(() => window.Preview.selected.camera.zoom)).toBe(zoom);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await snap(page)).doc).toEqual(drafting.doc);
});
