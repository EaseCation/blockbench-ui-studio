import { test, expect, type Page } from './host-test';
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
    const app = window.Blockbench.mcuiStudio.getStudio();
    return app.add('image', app.state.doc.roots[0]);
  });
}
for (const panel of ['element', 'mcui_layout']) {
  test(`${panel} 上下键即时修改单轴、百分比像素偏移与 Undo`, async ({ page }) => {
    const id = await start(page);
    await page.locator(`.panel_handle[panel_id=${panel}]`).click();
    const scope = page.locator('#panel_' + panel);
    const width = scope.getByLabel(panel === 'element' ? 'UI 宽度' : '布局宽度', { exact: true });
    const x = scope.getByLabel(panel === 'element' ? 'UI X 偏移' : '布局 X 偏移', { exact: true });
    const before = await page.evaluate(() => ({
      undo: window.Undo.history.length,
      tool: (window as any).Toolbox.selected.id,
    }));
    await width.focus();
    await page.keyboard.press('ArrowUp');
    await expect(width).toHaveValue('33px');
    expect(
      await page.evaluate(
        (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[id].rect.width,
        id,
      ),
    ).toBe(33);
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(before.undo + 1);
    await width.blur();
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(before.undo + 1);
    await page.evaluate(() => window.Undo.undo());
    await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
    await expect(width).toHaveValue('32px');
    await width.fill('100% - 16px');
    await width.press('Enter');
    await expect(width).toHaveValue('100% - 16px');
    await width.press('ArrowUp');
    await expect(width).toHaveValue('100% - 15px');
    await width.press('ArrowDown');
    await expect(width).toHaveValue('100% - 16px');
    await x.fill('50% - 8px');
    await x.press('Enter');
    await x.press('ArrowDown');
    await expect(x).toHaveValue('50% - 9px');
    expect(
      await page.evaluate((id) => {
        const n = window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[id];
        return [n.layout.offsetPercent.x, n.layout.offset.x, n.layout.offset.y, n.rect.height];
      }, id),
    ).toEqual([0.5, -9, 8, 32]);
    expect(await page.evaluate(() => (window as any).Toolbox.selected.id)).toBe(before.tool);
  });
  test(`${panel} 无效草稿不修改，最小宽度停止，Fill 保持规则`, async ({ page }) => {
    await start(page);
    await page.locator(`.panel_handle[panel_id=${panel}]`).click();
    const width = page
      .locator('#panel_' + panel)
      .getByLabel(panel === 'element' ? 'UI 宽度' : '布局宽度', { exact: true });
    const before = await page.evaluate(() => window.Undo.history.length);
    await width.fill('100% -');
    await width.press('ArrowUp');
    await expect(width).toHaveValue('100% -');
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
    await width.press('Escape');
    await width.fill('1px');
    await width.press('Enter');
    const min = await page.evaluate(() => window.Undo.history.length);
    await width.press('ArrowDown');
    await expect(width).toHaveValue('1px');
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(min);
    await width.fill('fill');
    await width.press('Enter');
    const fill = await page.evaluate(() => window.Undo.history.length);
    await width.press('ArrowDown');
    await expect(width).toHaveValue('fill');
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(fill);
  });
}
test('多选微调仅改当前轴，布局页混合值不擅自归一化', async ({ page }) => {
  const a = await start(page);
  await page.evaluate((a) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    const b = app.add('image', app.state.doc.roots[0]);
    app.update(b, (n: any) => {
      n.layout.height = { kind: 'fixed', value: 48 };
    });
    app.select([a, b]);
  }, a);
  await page.locator('#panel_element').getByLabel('UI 宽度', { exact: true }).press('ArrowUp');
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.selection.map((id: string) => [
        app.state.doc.nodes[id].rect.width,
        app.state.doc.nodes[id].rect.height,
      ]);
    }),
  ).toEqual([
    [33, 32],
    [33, 48],
  ]);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  const height = page.getByLabel('布局高度', { exact: true });
  await expect(height).toHaveValue('');
  const before = await page.evaluate(() => window.Undo.history.length);
  await height.press('ArrowUp');
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
});

test('尺寸限制、间距、内边距和内容数值统一使用方向键', async ({ page }) => {
  await start(page);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  await page.locator('details[data-disclosure=limits] summary').click();
  const min = page.getByLabel('最小宽度', { exact: true });
  await min.press('ArrowUp');
  await expect(min).toHaveValue('2');
  const max = page.getByLabel('最大宽度', { exact: true });
  await max.fill('80');
  await max.press('Enter');
  await max.press('ArrowDown');
  await expect(max).toHaveValue('79');
  await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.select([app.state.doc.roots[0]]);
  });
  await page.locator('#panel_mcui_layout button[data-flow=row]').click();
  const gap = page.getByLabel('间距数值', { exact: true });
  await gap.press('ArrowUp');
  await expect(gap).toHaveValue('9');
  const pad = page.getByLabel('水平内边距', { exact: true });
  await pad.press('ArrowUp');
  await expect(pad).toHaveValue('1');
  await pad.press('ArrowDown');
  await pad.press('ArrowDown');
  await expect(pad).toHaveValue('0');
  await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.select([app.state.doc.nodes[app.state.doc.roots[0]].children[0]]);
  });
  await page.locator('.panel_handle[panel_id=mcui_content]').click();
  await page.getByRole('button', { name: '添加描边', exact: true }).click();
  const stroke = page.getByLabel('描边粗细', { exact: true });
  await stroke.press('ArrowUp');
  await expect(stroke).toHaveValue('2');
  await page.getByRole('button', { name: '设为九宫格', exact: true }).click();
  await page.locator('details[data-disclosure=nineInsets] summary').click();
  const border = page.getByLabel('九宫格上边距', { exact: true });
  const initial = Number(await border.inputValue());
  await border.press('ArrowUp');
  await expect(border).toHaveValue(String(initial + 1));
});

for (const panel of ['element', 'mcui_layout']) {
  test(`${panel} Option 拖动与标签拖动实时预览、单次撤销和取消`, async ({ page }) => {
    const id = await start(page);
    await page.locator(`.panel_handle[panel_id=${panel}]`).click();
    const width = page
      .locator('#panel_' + panel)
      .getByLabel(panel === 'element' ? 'UI 宽度' : '布局宽度', { exact: true });
    await width.fill('100% - 16px');
    await width.press('Enter');
    const before = await page.evaluate(() => window.Undo.history.length);
    const b = (await width.boundingBox())!;
    await page.keyboard.down('Alt');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 12, b.y + b.height / 2, { steps: 4 });
    await expect(width).toHaveValue('100% - 4px');
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(before + 1);
    await page.evaluate(() => window.Undo.undo());
    await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
    await expect(width).toHaveValue('100% - 16px');
    const label = width.locator('..').locator('span').first();
    const l = (await label.boundingBox())!;
    await page.mouse.move(l.x + l.width / 2, l.y + l.height / 2);
    await page.mouse.down();
    await page.mouse.move(l.x + l.width / 2 + 10, l.y + l.height / 2);
    await expect(width).toHaveValue('100% - 6px');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(width).toHaveValue('100% - 16px');
    expect(
      await page.evaluate(
        (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[id].layout.width,
        id,
      ),
    ).toEqual({ kind: 'expression', percent: 1, pixels: -16 });
  });
}

test('拖动数值的速度档位、失焦恢复、数字控件与普通文本选择', async ({ page }) => {
  await start(page);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  const width = page.getByLabel('布局宽度', { exact: true }),
    b = (await width.boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.keyboard.down('Alt');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 50);
  await page.mouse.move(x + 10, y - 50);
  await expect(width).toHaveValue('52px');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(width).toHaveValue('32px');
  await width.focus();
  await width.press('ControlOrMeta+a');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y);
  await page.mouse.up();
  await expect(width).toHaveValue('32px');
  await page.locator('.panel_handle[panel_id=mcui_content]').click();
  await page.getByRole('button', { name: '添加描边', exact: true }).click();
  const stroke = page.getByLabel('描边粗细', { exact: true }),
    s = (await stroke.boundingBox())!;
  await page.keyboard.down('Alt');
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 2, s.y + s.height / 2);
  await page.mouse.move(s.x + s.width / 2 + 3, s.y + s.height / 2);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(stroke).toHaveValue('4');
});

test('切换项目取消数值拖拽，恢复像素和文档且不污染其它项目', async ({ page }) => {
  const id = await start(page);
  const project = await page.evaluate(() => window.Project.uuid);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  const input = page.getByLabel('布局宽度', { exact: true }),
    box = (await input.boundingBox())!;
  const before = await page.evaluate(() => ({
    history: window.Undo.history.length,
    png: window.Texture.all[0].getDataURL(),
  }));
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
  await expect(input).toHaveValue('52px');
  await page.evaluate(() => window.setupProject(window.Formats.free));
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(await page.evaluate(() => window.Cube.all.length)).toBe(0);
  await page.evaluate(
    (project) => (window as any).ModelProject.all.find((p: any) => p.uuid === project).select(),
    project,
  );
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio()?.state.busy);
  expect(
    await page.evaluate(
      (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[id].rect.width,
      id,
    ),
  ).toBe(32);
  expect(
    await page.evaluate(() => ({
      history: window.Undo.history.length,
      png: window.Texture.all[0].getDataURL(),
    })),
  ).toEqual(before);
});

test('九宫格预览窗口的方向键与 Option 拖动仅更新草稿，确认一次应用', async ({ page }) => {
  const id = await start(page);
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().makeNine(id), id);
  await page.evaluate(() => window.BarItems.mcui_content_preview.trigger());
  const input = page.locator('#mcui_content_preview .form_bar_insets input').first();
  await expect(input).toBeVisible();
  const initial = Number(await input.inputValue()),
    before = await page.evaluate(() => window.Undo.history.length);
  await input.press('ArrowUp');
  await expect(input).toHaveValue(String(initial + 1));
  const box = (await input.boundingBox())!;
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(input).toHaveValue(String(initial + 4));
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before);
  await page.evaluate(() => (window as any).Dialog.open.confirm());
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before + 1);
  expect(
    await page.evaluate(
      (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[id].content.insets[0],
      id,
    ),
  ).toBe(initial + 4);
});
