import { test, expect, type Page } from './host-test';
import { readFile, mkdir } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.Blockbench?.setup_successful);
  await page.evaluate(
    () => (window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio')),
  );
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
  return page.evaluate(() => {
    const w = window as any,
      app = w.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('image', root),
      b = app.add('image', root),
      c = app.add('image', root),
      d = app.add('image', root);
    app.select([b]);
    w.Prop.active_panel = 'preview';
    return { root, a, b, c, d };
  });
}
const snap = (page: Page) =>
  page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio();
    return {
      doc: a.state.doc,
      selection: a.state.selection,
      history: w.Undo.history.length,
      surfaces: Object.fromEntries(
        Object.entries(a.state.doc.bindings)
          .filter(([, b]: any) => b.surfaceId)
          .map(([id, b]: any) => [
            id,
            {
              y: w.OutlinerNode.uuids[b.surfaceId].from[1],
              png: w.Texture.all.find((t: any) => t.uuid === b.textureId).getDataURL(),
            },
          ]),
      ),
    };
  });
test('方括号和Figma组合键控制显示层级、单次历史与边界，保持像素和几何', async ({ page }) => {
  const ids = await start(page),
    before = await snap(page);
  await page.keyboard.press(']');
  let s = await snap(page);
  expect(s.doc.nodes[ids.root].children).toEqual([ids.a, ids.c, ids.b, ids.d]);
  expect(s.history).toBe(before.history + 1);
  expect(s.surfaces[ids.b].y).toBeGreaterThan(s.surfaces[ids.c].y);
  await page.keyboard.press('ControlOrMeta+[');
  expect((await snap(page)).doc.nodes[ids.root].children).toEqual([ids.a, ids.b, ids.c, ids.d]);
  await page.keyboard.press('ControlOrMeta+Alt+]');
  s = await snap(page);
  expect(s.doc.nodes[ids.root].children).toEqual([ids.a, ids.c, ids.d, ids.b]);
  const top = s.history;
  await page.keyboard.press(']');
  await page.keyboard.press('ControlOrMeta+Alt+]');
  expect((await snap(page)).history).toBe(top);
  await page.keyboard.press('Shift+[');
  s = await snap(page);
  expect(s.doc.nodes[ids.root].children).toEqual([ids.b, ids.a, ids.c, ids.d]);
  for (const id of [ids.a, ids.b, ids.c, ids.d]) {
    expect(s.doc.nodes[id].rect).toEqual(before.doc.nodes[id].rect);
    expect(s.surfaces[id].png).toBe(before.surfaces[id].png);
  }
  await page.evaluate(() => window.Undo.undo());
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
  expect((await snap(page)).doc.nodes[ids.root].children).toEqual([ids.a, ids.c, ids.d, ids.b]);
  await page.evaluate(() => window.Undo.redo());
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
  expect((await snap(page)).doc.nodes[ids.root].children).toEqual([ids.b, ids.a, ids.c, ids.d]);
});
test('右键菜单四项排序支持非连续多选，跨父级不换父级，Stack按新顺序排列', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ b, d }) => window.Blockbench.mcuiStudio.getStudio().select([b, d]), ids);
  const uuid = await page.evaluate(
    (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.bindings[id].containerId,
    ids.b,
  );
  await page.locator(`[id="${uuid}"] > .outliner_object`).click({ button: 'right' });
  for (const action of ['mcui_layer_up', 'mcui_layer_down', 'mcui_layer_front', 'mcui_layer_back'])
    await expect(page.locator(`.contextMenu:visible [menu_item=${action}]`)).toBeVisible();
  await mkdir('.cache/clipboard-order', { recursive: true });
  await page.screenshot({ path: '.cache/clipboard-order/context-menu.png' });
  await page.locator('.contextMenu:visible [menu_item=mcui_layer_back]').click();
  let s = await snap(page);
  expect(s.doc.nodes[ids.root].children).toEqual([ids.b, ids.d, ids.a, ids.c]);
  expect(s.selection.sort()).toEqual([ids.b, ids.d].sort());
  const nested = await page.evaluate(({ root, c }) => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      f = a.add('frame', root),
      one = a.add('image', f),
      two = a.add('image', f);
    a.select([c, one]);
    (window as any).Prop.active_panel = 'preview';
    return { f, one, two };
  }, ids);
  const before = await snap(page);
  await page.keyboard.press('Shift+]');
  s = await snap(page);
  expect(s.history).toBe(before.history + 1);
  expect(s.doc.nodes[ids.root].children.at(-1)).toBe(ids.c);
  expect(s.doc.nodes[nested.f].children).toEqual([nested.two, nested.one]);
  expect(s.doc.nodes[ids.c].parent).toBe(ids.root);
  expect(s.doc.nodes[nested.one].parent).toBe(nested.f);
  await page.evaluate(({ f, two }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(f, (n: any) => {
      n.frame.engineType = 'stack_panel';
      n.frame.direction = 'row';
      n.frame.gap = 8;
    });
    a.select([two]);
  }, nested);
  const flow = await snap(page);
  await page.keyboard.press(']');
  s = await snap(page);
  expect(s.doc.nodes[nested.two].rect.x).toBeGreaterThan(flow.doc.nodes[nested.two].rect.x);
  expect(s.doc.nodes[nested.f].children).toEqual([nested.one, nested.two]);
});
test('输入、锁定、原生模式不排序，快捷键可重绑定且卸载清理', async ({ page }) => {
  const ids = await start(page);
  await page.locator('.panel_handle[panel_id=element]').click();
  const input = page.getByLabel('UI 宽度', { exact: true });
  const before = await snap(page);
  await input.fill('');
  await input.press('[');
  expect((await snap(page)).history).toBe(before.history);
  expect((await snap(page)).doc.nodes[ids.root].children).toEqual(
    before.doc.nodes[ids.root].children,
  );
  await input.press('Escape');
  await input.blur();
  await page.evaluate(() => {
    (window as any).Prop.active_panel = 'preview';
    window.BarItems.mcui_layer_up.keybind.set({ key: 81 });
  });
  await page.keyboard.press('q');
  expect((await snap(page)).doc.nodes[ids.root].children).toEqual([ids.a, ids.c, ids.b, ids.d]);
  await page.evaluate(
    ({ b }) => window.Blockbench.mcuiStudio.getStudio().update(b, (n: any) => (n.locked = true)),
    ids,
  );
  const locked = await snap(page);
  await page.keyboard.press(']');
  expect((await snap(page)).history).toBe(locked.history);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  expect(await page.evaluate(() => window.BarItems.mcui_layer_up.condition())).toBe(false);
  await page.evaluate(() => window.Plugins.registered.mcui_studio.unload());
  expect(
    await page.evaluate(
      () => !!window.BarItems.mcui_layer_up || !!window.BarItems.mcui_layer_front,
    ),
  ).toBe(false);
});
