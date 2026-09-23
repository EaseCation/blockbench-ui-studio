import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto('http://127.0.0.1:4178');
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
      n.layout.width = { kind: 'fixed', value: 48 };
      n.layout.height = { kind: 'fixed', value: 64 };
    });
    app.select([a]);
    return { a, b, root };
  });
}
const tab = (page: Page, kind: string) =>
  page.locator(`.panel_handle[panel_id="mcui_${kind}"]`).click();
const history = (page: Page) => page.evaluate(() => window.Undo.history.length);

test('标签偏好、多选混合尺寸与单轴提交，折叠不写历史', async ({ page }) => {
  const ids = await start(page);
  await tab(page, 'layout');
  await page.evaluate(({ a, b }) => window.Blockbench.mcuiStudio.getStudio().select([a, b]), ids);
  await expect(page.locator('#panel_mcui_layout')).toBeVisible();
  const width = page.getByLabel('布局宽度', { exact: true }),
    height = page.getByLabel('布局高度', { exact: true });
  await expect(width).toHaveValue('');
  await expect(height).toHaveAttribute('placeholder', '混合');
  const before = await history(page);
  await page.locator('details[data-disclosure=limits] summary').click();
  expect(await history(page)).toBe(before);
  await width.fill('100% - 16px');
  await width.press('Enter');
  expect(await history(page)).toBe(before + 1);
  expect(
    await page.evaluate(({ a, b }) => {
      const d = window.Blockbench.mcuiStudio.getStudio().state.doc;
      return [d.nodes[a].rect, d.nodes[b].rect].map((r) => [r.width, r.height]);
    }, ids),
  ).toEqual([
    [304, 32],
    [304, 64],
  ]);
  await page.evaluate(() => window.Undo.undo());
  await expect(width).toHaveValue('');
  await width.fill('999');
  await page.evaluate(({ root }) => window.Blockbench.mcuiStudio.getStudio().select([root]), ids);
  await width.press('Enter');
  expect(
    await page.evaluate(
      ({ root }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[root].rect.width,
      ids,
    ),
  ).toBe(320);
});

test('内容页选择 Frame 临时回退，返回 Image 恢复内容偏好', async ({ page }) => {
  const ids = await start(page);
  await tab(page, 'content');
  await page.evaluate(({ root }) => window.Blockbench.mcuiStudio.getStudio().select([root]), ids);
  await expect(page.locator('#panel_mcui_layout')).toBeVisible();
  await page.evaluate(({ b }) => window.Blockbench.mcuiStudio.getStudio().select([b]), ids);
  await expect(page.locator('#panel_mcui_content')).toBeVisible();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('mcui_preferences')!).inspector.tab),
  ).toBe('mcui_content');
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('mcui_preferences')!);
    p.autoPlace = false;
    localStorage.setItem('mcui_preferences', JSON.stringify(p));
  });
  await tab(page, 'layout');
  await page.locator('details[data-disclosure=limits] summary').click();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('mcui_preferences')!).autoPlace),
  ).toBe(false);
});

test('自由 Frame 内边距可见，独立四边与定位预设保持未修改字段', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ root, a }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.update(root, (n: any) => {
      n.frame.padding = [2, 4, 6, 8];
    });
    app.select([root]);
  }, ids);
  await tab(page, 'layout');
  await expect(page.getByLabel('水平内边距', { exact: true })).toHaveAttribute(
    'placeholder',
    '混合',
  );
  const before = await history(page);
  await page.getByLabel('水平内边距', { exact: true }).fill('10');
  await page.getByLabel('水平内边距', { exact: true }).press('Enter');
  expect(
    await page.evaluate(
      ({ root }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[root].frame.padding,
      ids,
    ),
  ).toEqual([2, 10, 6, 10]);
  await page.getByRole('button', { name: '四边', exact: true }).click();
  expect(await history(page)).toBe(before + 1);
  await page.evaluate(({ a }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.update(a, (n: any) => {
      n.layout.offsetPercent = { x: 0.25, y: 0 };
    });
    app.select([a]);
  }, ids);
  await page.getByRole('button', { name: '定位预设：中中', exact: true }).click();
  expect(
    await page.evaluate(({ a }) => {
      const n = window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[a];
      return [n.layout.anchorFrom, n.layout.anchorTo, n.layout.offsetPercent];
    }, ids),
  ).toEqual([[0.5, 0.5], [0.5, 0.5], { x: 0.25, y: 0 }]);
});

test('颜色取消不改像素，确认单次 Undo；样式仅在添加后展开', async ({ page }) => {
  await start(page);
  await tab(page, 'content');
  await expect(page.getByLabel('描边粗细', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '添加填充', exact: true }).click();
  const before = await history(page);
  const swatch = page.locator('.mcui-inspector-color[aria-label^="填充颜色"] .sp-replacer');
  await swatch.click();
  const tool = await page.evaluate(() => (window as any).Toolbox.selected.id);
  await page.keyboard.press('a');
  await page.keyboard.press('r');
  expect(await page.evaluate(() => (window as any).Toolbox.selected.id)).toBe(tool);
  await page.locator('.sp-container:visible .sp-input').fill('#ff0000');
  await page.locator('.sp-container:visible .sp-cancel').click();
  expect(await history(page)).toBe(before);
  await swatch.click();
  await page.locator('.sp-container:visible .sp-input').fill('#ff0000');
  await page.locator('.sp-container:visible .sp-choose').click();
  expect(await history(page)).toBe(before + 1);
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.doc.nodes[app.state.selection[0]].appearance.color;
    }),
  ).toBe('#ff0000ff');
  await page.evaluate(() => window.Undo.undo());
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.doc.nodes[app.state.selection[0]].appearance.color;
    }),
  ).toBe('#ffffffff');
  await page.getByRole('button', { name: '移除填充', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加填充', exact: true })).toBeVisible();
});

test('图片适配、高清分辨率、Crop 和九宫格预览使用同一文档事务', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(async ({ a }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.select([a]);
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    c.getContext('2d')!.fillRect(0, 0, 128, 128);
    await app.paste({ png: c.toDataURL(), width: 128, height: 128, name: 'HD' });
  }, ids);
  await tab(page, 'content');
  await expect(page.getByText('显示 32×32 · 贴图 128×128', { exact: true })).toBeVisible();
  await page.getByLabel('图片适配', { exact: true }).selectOption('crop');
  await expect(page.getByLabel('图片倍率', { exact: true })).toBeVisible();
  await page.getByLabel('图片适配', { exact: true }).selectOption('stretch');
  await expect(page.getByLabel('图片倍率', { exact: true })).toBeHidden();
  await expect(page.locator('details[data-disclosure=imageOptions]')).toBeHidden();
  await page.getByRole('button', { name: '设为九宫格', exact: true }).click();
  await expect(page.getByLabel('尺寸变化策略', { exact: true })).toBeDisabled();
  const before = await history(page);
  await page.getByRole('button', { name: '编辑切片', exact: true }).click();
  await expect(page.locator('#mcui_content_preview canvas')).toBeVisible();
  await page.evaluate(() => {
    const d = (window as any).Dialog.open;
    d.setFormValues({ insets: [3, 4, 5, 6] });
  });
  expect(await history(page)).toBe(before);
  await page.screenshot({ path: '.cache/mcui-v07-nine.png' });
  await page.evaluate(() => (window as any).Dialog.open.confirm());
  expect(await history(page)).toBe(before + 1);
  expect(
    await page.evaluate(
      ({ a }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[a].content.insets,
      ids,
    ),
  ).toEqual([3, 4, 5, 6]);
});

test('属性输入隔离绘制快捷键，Escape 取消草稿不删图层', async ({ page }) => {
  await start(page);
  await tab(page, 'layout');
  const width = page.getByLabel('布局宽度', { exact: true }),
    before = await history(page);
  const tool = await page.evaluate(() => (window as any).Toolbox.selected.id);
  await width.fill('');
  await width.press('a');
  await width.press('r');
  await width.press('Delete');
  await width.press('Escape');
  expect(await history(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).Toolbox.selected.id)).toBe(tool);
  await expect(width).toHaveValue('32px');
});

test('280/320/400 像素侧栏不横向溢出，保存截图并完整卸载', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ root }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.update(root, (n: any) => {
      n.frame.direction = 'row';
      n.frame.engineType = 'stack_panel';
    });
    app.select([root]);
  }, ids);
  await tab(page, 'layout');
  for (const width of [280, 320, 400]) {
    await page.evaluate((w) => {
      const bb = window as any;
      bb.Interface.getModeData().right_bar_width = w;
      bb.Interface.data.right_bar_width = w;
      bb.resizeWindow();
    }, width);
    const bounds = await page
      .locator('#panel_mcui_layout .mcui-inspector')
      .evaluate((root) => ({ width: root.clientWidth, scroll: root.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    const edges = await page.locator('#panel_mcui_layout').evaluate((p) => {
      const r = p.getBoundingClientRect();
      return [...p.querySelectorAll('input,select,button')]
        .filter((e) => (e as HTMLElement).offsetParent)
        .map((e) => ({
          right: e.getBoundingClientRect().right,
          end: r.right,
          width: e.getBoundingClientRect().width,
        }));
    });
    for (const e of edges) {
      expect(e.right).toBeLessThanOrEqual(e.end + 1);
      expect(e.width).toBeGreaterThan(20);
    }
    await page.screenshot({ path: `.cache/mcui-v07-layout-${width}.png` });
  }
  await page.screenshot({ path: '.cache/mcui-v07-layout.png' });
  await page.evaluate(({ a }) => window.Blockbench.mcuiStudio.getStudio().select([a]), ids);
  await tab(page, 'content');
  await page.getByRole('button', { name: '添加填充', exact: true }).click();
  await page.getByLabel('填充类型', { exact: true }).selectOption('linear');
  await page.getByRole('button', { name: '添加描边', exact: true }).click();
  await page.screenshot({ path: '.cache/mcui-v07-content.png' });
  await page.locator('.mcui-inspector-color[aria-label^="填充颜色"] .sp-replacer').click();
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  await expect(page.locator('.sp-container:visible')).toHaveCount(0);
  await expect(page.locator('.mcui-inspector')).toHaveCount(0);
});

test.describe('高 DPI 属性面板', () => {
  test.use({ deviceScaleFactor: 2 });
  test('长百分比可编辑，样式控件在 280px 下保持可点击', async ({ page }) => {
    await start(page);
    await tab(page, 'layout');
    await page.evaluate(() => {
      const bb = window as any;
      bb.Interface.getModeData().right_bar_width = 280;
      bb.resizeWindow();
    });
    const width = page.getByLabel('布局宽度', { exact: true });
    await width.fill('100% - 16px');
    await width.press('Enter');
    await expect(width).toHaveValue('100% - 16px');
    expect((await width.boundingBox())!.width).toBeGreaterThan(150);
    await tab(page, 'content');
    await page.getByRole('button', { name: '添加填充', exact: true }).click();
    await page.getByLabel('填充类型', { exact: true }).selectOption('linear');
    await page.getByRole('button', { name: '添加描边', exact: true }).click();
    await page.getByLabel('描边粗细', { exact: true }).fill('2');
    await page.getByLabel('描边粗细', { exact: true }).press('Enter');
    const bounds = await page.locator('#panel_mcui_content').evaluate((panel) => {
      const right = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll('input,select,button')]
        .filter((e) => (e as HTMLElement).offsetParent)
        .every(
          (e) =>
            e.getBoundingClientRect().right <= right + 1 && e.getBoundingClientRect().width > 20,
        );
    });
    expect(bounds).toBe(true);
    await page.screenshot({ path: '.cache/mcui-v07-content-hidpi.png' });
  });
});
