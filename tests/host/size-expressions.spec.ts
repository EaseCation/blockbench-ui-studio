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
  const ids = await page.evaluate(() => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      root = a.state.doc.roots[0],
      image = a.add('image', root),
      peer = a.add('image', root);
    a.update(root, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 200 };
      n.layout.height = { kind: 'fixed', value: 100 };
    });
    a.update(image, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 40 };
      n.layout.height = { kind: 'fixed', value: 20 };
      n.appearance = {
        fill: 'solid',
        color: '#3a6a85ff',
        endColor: '#3a6a85ff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffffff',
      };
    });
    a.update(peer, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 80 };
      n.layout.height = { kind: 'fixed', value: 30 };
    });
    a.select([image]);
    return { root, image, peer };
  });
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  return ids;
}
const state = (page: Page, id: string) =>
  page.evaluate((id) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    return {
      node: a.state.doc.nodes[id],
      undo: window.Undo.history.length,
      doc: JSON.stringify(a.state.doc),
    };
  }, id);
async function width(page: Page, value: string) {
  const input = page.getByLabel('布局宽度', { exact: true });
  await input.fill(value);
  await input.press('Enter');
}

test('完整表达式与组合编辑互相转换，模式不写模型，支持多项参照', async ({ page }) => {
  const ids = await start(page);
  await width(page, '100%sm + 8px');
  expect((await state(page, ids.image)).node.rect.width).toBe(88);
  const before = await state(page, ids.image);
  await page.locator('[data-size-editor=visual]').click();
  expect((await state(page, ids.image)).doc).toBe(before.doc);
  expect((await state(page, ids.image)).undo).toBe(before.undo);
  await expect(page.getByLabel('宽度参照', { exact: true })).toHaveValue('%sm');
  await expect(page.getByLabel('宽度第1项比例', { exact: true })).toHaveValue('100');
  const px = page.getByLabel('宽度像素偏移', { exact: true });
  await px.fill('12');
  await px.press('Enter');
  expect((await state(page, ids.image)).node.rect.width).toBe(92);
  await page
    .locator('.mcui-size-axis')
    .first()
    .getByRole('button', { name: '+ 参照项', exact: true })
    .click();
  const percent = page.getByLabel('宽度第2项比例', { exact: true });
  await percent.fill('10');
  await percent.press('Enter');
  expect((await state(page, ids.image)).node.rect.width).toBe(112);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().fit(true));
  await page.screenshot({ path: '.cache/mcui-size-builder.png' });
  await page.locator('[data-size-editor=expression]').click();
  await expect(page.getByLabel('布局宽度', { exact: true })).toHaveValue('100%sm + 10% + 12px');
  await width(page, '50% + 25%y - 8px');
  expect((await state(page, ids.image)).node.rect.width).toBe(97);
  const h = page.getByLabel('布局高度', { exact: true });
  await h.fill('40px');
  await h.press('Enter');
  expect((await state(page, ids.image)).node.rect.width).toBe(102);
  await page.evaluate(
    ({ root }) =>
      window.Blockbench.mcuiStudio
        .getStudio()
        .update(root, (n: any) => (n.layout.width = { kind: 'fixed', value: 400 })),
    ids,
  );
  expect((await state(page, ids.image)).node.rect.width).toBe(202);
});

test('语法实时红框，循环依赖保留输入草稿且不修改模型，Escape恢复', async ({ page }) => {
  const ids = await start(page),
    input = page.getByLabel('布局宽度', { exact: true }),
    before = await state(page, ids.image);
  await input.fill('100%cc');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await page.mouse.move(800, 300);
  await page.screenshot({ path: '.cache/mcui-size-invalid.png' });
  expect((await state(page, ids.image)).doc).toBe(before.doc);
  await input.press('Enter');
  expect((await state(page, ids.image)).undo).toBe(before.undo);
  await input.press('Escape');
  await expect(input).toHaveValue('40px');
  await width(page, '100%x');
  await expect(input).toHaveValue('100%x');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect((await state(page, ids.image)).doc).toBe(before.doc);
  await page.locator('[data-size-editor=visual]').click();
  await expect(input).toBeVisible();
  await width(page, '100%y + 8px');
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  expect((await state(page, ids.image)).node.rect.width).toBe(28);
  await page.locator('.panel_handle[panel_id=element]').click();
  const native = page.getByLabel('UI 宽度', { exact: true });
  await native.fill('100%bad');
  await expect(native).toHaveAttribute('aria-invalid', 'true');
  await native.press('Escape');
});

test('多选组合输入只修改指定项；像素参照下混合值可批量修改', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(
    ({ image, peer }) => window.Blockbench.mcuiStudio.getStudio().select([image, peer]),
    ids,
  );
  await page.locator('[data-size-editor=visual]').click();
  await expect(page.getByLabel('宽度参照', { exact: true })).toHaveValue('px');
  const px = page.getByLabel('宽度像素', { exact: true });
  await expect(px).toHaveValue('');
  await px.fill('64');
  await px.press('Enter');
  expect((await state(page, ids.image)).node.rect.width).toBe(64);
  expect((await state(page, ids.peer)).node.rect.width).toBe(64);
  expect((await state(page, ids.image)).node.rect.height).toBe(20);
  expect((await state(page, ids.peer)).node.rect.height).toBe(30);
  await page.evaluate(({ image, peer }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(
      image,
      (n: any) => (n.layout.width = { kind: 'expression', percent: 0.5, pixels: 10 }),
    );
    a.update(
      peer,
      (n: any) => (n.layout.width = { kind: 'expression', percent: 0.25, pixels: 10 }),
    );
  }, ids);
  await expect(page.getByLabel('宽度像素偏移', { exact: true })).toHaveValue('10');
  const percentage = page.getByLabel('宽度第1项比例', { exact: true });
  await expect(percentage).toHaveValue('');
  await percentage.fill('75');
  await percentage.press('Enter');
  expect((await state(page, ids.image)).node.layout.width).toEqual({
    kind: 'expression',
    percent: 0.75,
    pixels: 10,
  });
  expect((await state(page, ids.peer)).node.layout.width).toEqual({
    kind: 'expression',
    percent: 0.75,
    pixels: 10,
  });
});

test('%cm/%c子项、零尺寸隐藏载体、父尺寸变化和保存重开', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ root }) => window.Blockbench.mcuiStudio.getStudio().select([root]), ids);
  await width(page, '100%cm + 8px');
  expect((await state(page, ids.root)).node.rect.width).toBe(88);
  await page.evaluate(
    ({ peer }) =>
      window.Blockbench.mcuiStudio.getStudio().update(peer, (n: any) => (n.visible = false)),
    ids,
  );
  expect((await state(page, ids.root)).node.rect.width).toBe(48);
  await width(page, '100%c + 8px');
  expect((await state(page, ids.root)).node.rect.width).toBe(128);
  await page.evaluate(({ image }) => window.Blockbench.mcuiStudio.getStudio().select([image]), ids);
  await width(page, '0px');
  expect((await state(page, ids.image)).node.rect.width).toBe(0);
  expect(
    await page.evaluate((id) => {
      const a = window.Blockbench.mcuiStudio.getStudio();
      return (window as any).OutlinerNode.uuids[a.state.doc.bindings[id].surfaceId].visibility;
    }, ids.image),
  ).toBe(false);
  const model = await page.evaluate(() =>
    window.Codecs.project.compile({ raw: true, bitmaps: true }),
  );
  await page.evaluate((m) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(m);
  }, model);
  await page.waitForFunction((id) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    return a?.state.doc.nodes[id]?.rect.width === 0 && !a.state.busy;
  }, ids.image);
  const after = await state(page, ids.image);
  expect(after.node.suspended).toBeUndefined();
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().select([id]), ids.image);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  await width(page, '32px');
  expect((await state(page, ids.image)).node.rect.width).toBe(32);
  expect(
    await page.evaluate((id) => {
      const a = window.Blockbench.mcuiStudio.getStudio();
      return (window as any).OutlinerNode.uuids[a.state.doc.bindings[id].surfaceId].visibility;
    }, ids.image),
  ).toBe(true);
});

test('Wiki标题背景模式：%sm跟随文字，%cm随背景自动变化，改字一次撤销', async ({ page }) => {
  const text = await readFile(
    process.env.MCUI_TEXT_PLUGIN ?? '../blockbench-bbmodel-text/dist/bbmodel-text-component.js',
    'utf8',
  ).catch(() => null);
  test.skip(!text, '未构建文字插件');
  const ids = await start(page);
  await page.evaluate(
    () =>
      (window.Plugins.registered['bbmodel-text-component'] = new window.Blockbench.Plugin(
        'bbmodel-text-component',
      )),
  );
  await page.addScriptTag({ content: text! });
  const result = await page.evaluate(async ({ root }) => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      frame = a.add('frame', root),
      bg = a.add('image', frame);
    a.select([frame]);
    const label = await (window as any).Blockbench.bbText.create();
    a.execute('Wiki sizing fixture', (d: any) => {
      d.nodes[frame].layout.height = { kind: 'expression', unit: '%cm', percent: 1, pixels: 0 };
      d.nodes[bg].layout.width = { kind: 'expression', unit: '%sm', percent: 1, pixels: 30 };
      d.nodes[bg].layout.height = { kind: 'expression', unit: '%sm', percent: 1, pixels: 6 };
      d.nodes[label].layout.offset = { x: 0, y: 6 };
    });
    const read = () => {
      const d = a.state.doc;
      return {
        frame: d.nodes[frame].rect,
        bg: d.nodes[bg].rect,
        label: d.nodes[label].rect,
        suspended: Object.values(d.nodes).filter((n: any) => n.suspended).length,
        error: a.state.error,
      };
    };
    const before = read(),
      history = window.Undo.history.length,
      api = window.Blockbench.mcuiStudio.contents;
    await api.update(label, { ...api.inspect(label).data, text: 'A much longer title' });
    const after = read(),
      undo = window.Undo.history.length - history;
    window.Undo.undo();
    while (a.state.busy) await new Promise((r) => setTimeout(r, 20));
    return { before, after, restored: read(), undo };
  }, ids);
  for (const r of [result.before, result.after]) {
    expect(r.bg.width).toBe(r.label.width + 30);
    expect(r.bg.height).toBe(r.label.height + 6);
    expect(r.frame.height).toBe(r.bg.height);
    expect(r.error).toBeNull();
    expect(r.suspended).toBe(0);
  }
  expect(result.after.bg.width).toBeGreaterThan(result.before.bg.width);
  expect(result.undo).toBe(1);
  expect(result.restored.bg).toEqual(result.before.bg);
});
