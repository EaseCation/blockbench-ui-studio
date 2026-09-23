import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test.setTimeout(120000);
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
const toolbar = (page: Page) => page.locator('.toolbar[toolbar_id=outliner]');
async function start(page: Page) {
  page.on('pageerror', (error) => {
    throw error;
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
  await expect(toolbar(page)).toHaveClass(/mcui-outliner-2d/);
}

test('2D 大纲以 Frame/Image 开头，原生命令和结构查看复用三个点菜单', async ({ page }) => {
  await start(page);
  const bar = toolbar(page);
  for (const id of ['add_element', 'add_group', 'outliner_toggle', 'mcui_show_native'])
    await expect(bar.locator(`[toolbar_item=${id}]`)).toBeHidden();
  for (const id of ['search_outliner', 'cube_counter'])
    await expect(bar.locator(`[toolbar_item=${id}]`)).toBeVisible();
  const positions = await bar.locator('.content > [toolbar_item]').evaluateAll((nodes) =>
    nodes
      .filter((n) => (n as HTMLElement).offsetParent)
      .sort(
        (a, b) =>
          a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
          a.getBoundingClientRect().left - b.getBoundingClientRect().left,
      )
      .map((n) => n.getAttribute('toolbar_item')),
  );
  expect(positions.slice(0, 2)).toEqual(['mcui_add_frame', 'mcui_add_layer']);
  await bar.locator('[toolbar_item=mcui_add_frame]').click();
  await bar.locator('[toolbar_item=mcui_add_layer]').click();
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio(),
        node = app.state.doc.nodes[app.state.selection[0]];
      return [node.kind, app.state.doc.nodes[node.parent].kind];
    }),
  ).toEqual(['image', 'frame']);
  const rawCube = await page.evaluate(() => window.Cube.all[0].uuid);
  await expect(page.locator(`li.outliner_node[id="${rawCube}"]`)).toBeHidden();
  const before = await page.evaluate(() => window.Undo.history.length);
  await bar.locator(':scope > .toolbar_menu').click();
  await expect(page.locator('.mcui-outliner-menu')).toBeVisible();
  await expect(
    page.locator('.mcui-outliner-menu').locator('li[menu_item=add_group]'),
  ).toBeVisible();
  await page.locator('.mcui-outliner-menu').locator('li[menu_item=mcui_show_native]').click();
  await expect(page.locator(`li.outliner_node[id="${rawCube}"]`)).toBeVisible();
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
  await bar.locator(':scope > .toolbar_menu').click();
  await page.locator('.mcui-outliner-menu').locator('li[menu_item=mcui_show_native]').click();
  await expect(page.locator(`li.outliner_node[id="${rawCube}"]`)).toBeHidden();
  await bar.locator(':scope > .toolbar_menu').click();
  await page.locator('.mcui-outliner-menu').locator('li[menu_item=add_group]').click();
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before + 1);
  await bar.locator(':scope > .toolbar_menu').click();
  await page.screenshot({ path: '.cache/mcui-outliner-menu.png' });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '.cache/mcui-outliner-2d.png' });
});

test('3D、绘画、普通项目和卸载恢复原生工具栏，不保存临时顺序', async ({ page }) => {
  await start(page);
  const state = () =>
    page.evaluate(() => ({
      storage: JSON.parse(localStorage.getItem('toolbars') ?? '{}').outliner,
      children: (window as any).Toolbars.outliner.children.map((c: any) =>
        typeof c === 'string' ? c : c.id,
      ),
    }));
  const before = await state();
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setView('3d'));
  await expect(toolbar(page)).not.toHaveClass(/mcui-outliner-2d/);
  await expect(toolbar(page).locator('[toolbar_item=add_group]')).toBeVisible();
  expect(await state()).toEqual(before);
  expect(
    await page.evaluate(
      () => (window as any).Toolbars.outliner.menu === (window as any).Toolbars.main_tools.menu,
    ),
  ).toBe(true);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setView('2d'));
  await expect(toolbar(page)).toHaveClass(/mcui-outliner-2d/);
  await page.evaluate(() => window.Modes.options.paint.select());
  await expect(toolbar(page)).not.toHaveClass(/mcui-outliner-2d/);
  await page.evaluate(() => window.Modes.options.edit.select());
  await expect(toolbar(page)).toHaveClass(/mcui-outliner-2d/);
  const uiProject = await page.evaluate(() => window.Project.uuid);
  await page.evaluate(() => window.setupProject(window.Formats.free));
  await expect(toolbar(page)).not.toHaveClass(/mcui-outliner-2d/);
  await expect(toolbar(page).locator('[toolbar_item=add_element]')).toBeVisible();
  await page.evaluate(
    (id) => (window as any).ModelProject.all.find((p: any) => p.uuid === id).select(),
    uiProject,
  );
  await expect(toolbar(page)).toHaveClass(/mcui-outliner-2d/);
  expect(await state()).toEqual(before);
  await toolbar(page).locator(':scope > .toolbar_menu').click();
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  await expect(page.locator('.mcui-outliner-menu')).toHaveCount(0);
  await expect(toolbar(page).locator('[toolbar_item=add_group]')).toBeVisible();
  await expect(toolbar(page)).not.toHaveClass(/mcui-outliner-2d/);
  expect(await page.evaluate(() => Object.hasOwn((window as any).Toolbars.outliner, 'menu'))).toBe(
    false,
  );
});
