import { test, expect, type Page } from './host-test';
import { readFile, mkdir } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  page.on('pageerror', (e) => {
    throw e;
  });
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
    const a = window.Blockbench.mcuiStudio.getStudio(),
      root = a.state.doc.roots[0],
      frame = a.add('frame', root),
      image = a.add('image', root),
      peer = a.add('image', root);
    a.execute('Mixed fixture', (d: any) => {
      for (const [id, width, x, rotation] of [
        [frame, 80, 10, 0],
        [image, 40, 70, 30],
        [peer, 60, 120, 0],
      ]) {
        const n = d.nodes[id];
        n.layout.width = { kind: 'fixed', value: width };
        n.layout.height = { kind: 'fixed', value: 32 };
        n.layout.offset = { x, y: 20 };
        n.rotation = rotation;
      }
    });
    a.select([frame, image]);
    return { root, frame, image, peer };
  });
}
const snap = (page: Page) =>
  page.evaluate(() => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    return { doc: a.state.doc, history: window.Undo.history.length };
  });
const tab = (page: Page, id: string) => page.locator(`.panel_handle[panel_id=${id}]`).click();
async function enter(page: Page, label: string, value: string) {
  const f = page.getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
}
test('元素页逐轴共同值、原生刷新、空混合无操作和一次批量 Undo', async ({ page }) => {
  const ids = await start(page);
  await tab(page, 'element');
  const width = page.getByLabel('UI 宽度', { exact: true }),
    height = page.getByLabel('UI 高度', { exact: true }),
    x = page.getByLabel('UI X 偏移', { exact: true }),
    y = page.getByLabel('UI Y 偏移', { exact: true }),
    rotation = page.getByLabel('UI 旋转', { exact: true });
  await expect(width).toHaveValue('');
  await expect(width).toHaveAttribute('placeholder', '混合');
  await expect(height).toHaveValue('32px');
  await expect(x).toHaveValue('');
  await expect(y).toHaveValue('20px');
  await expect(rotation).toHaveValue('');
  await mkdir('.cache/mixed-properties', { recursive: true });
  await page.screenshot({ path: '.cache/mixed-properties/element.png' });
  await page.evaluate(() => (window as any).updateSelection());
  await expect(width).toHaveValue('');
  await expect(rotation).toHaveValue('');
  const before = await snap(page);
  await width.focus();
  await width.press('Enter');
  await y.focus();
  expect((await snap(page)).history).toBe(before.history);
  await enter(page, 'UI 宽度', '96px');
  let after = await snap(page);
  for (const id of [ids.frame, ids.image]) {
    expect(after.doc.nodes[id].rect.width).toBe(96);
    expect(after.doc.nodes[id].layout.height).toEqual(before.doc.nodes[id].layout.height);
  }
  expect(after.history).toBe(before.history + 1);
  await page.evaluate(() => window.Undo.undo());
  await expect(width).toHaveValue('');
  await enter(page, 'UI 旋转', '45');
  after = await snap(page);
  expect([after.doc.nodes[ids.frame].rotation, after.doc.nodes[ids.image].rotation]).toEqual([
    45, 45,
  ]);
  await enter(page, 'UI X 偏移', '25% + 2px');
  after = await snap(page);
  for (const id of [ids.frame, ids.image]) {
    expect(after.doc.nodes[id].layout.offsetPercent.x).toBe(0.25);
    expect(after.doc.nodes[id].layout.offset.y).toBe(20);
  }
  await page.evaluate(({ frame, image }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.select([image, frame]);
  }, ids);
  await expect(rotation).toHaveValue('45');
  await expect(x).toHaveValue('25% + 2px');
});
test('Frame/Image 混选只展示共同属性，布局页批量值与失效草稿不会污染新选区', async ({ page }) => {
  const ids = await start(page);
  await tab(page, 'mcui_layout');
  await expect(page.locator('[data-section=frame]')).toBeHidden();
  await expect(page.locator('#panel_mcui_content')).toBeHidden();
  await expect(page.getByLabel('布局宽度', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('布局高度', { exact: true })).toHaveValue('32px');
  const before = await snap(page);
  await enter(page, '布局高度', '40px');
  let after = await snap(page);
  for (const id of [ids.frame, ids.image]) {
    expect(after.doc.nodes[id].rect.height).toBe(40);
    expect(after.doc.nodes[id].layout.width).toEqual(before.doc.nodes[id].layout.width);
  }
  expect(after.history).toBe(before.history + 1);
  await page.getByLabel('布局宽度', { exact: true }).fill('999');
  await page.evaluate(({ peer }) => window.Blockbench.mcuiStudio.getStudio().select([peer]), ids);
  await page.getByLabel('布局宽度', { exact: true }).press('Enter');
  expect((await snap(page)).doc.nodes[ids.peer].rect.width).toBe(60);
  await page.evaluate(
    ({ frame, image }) => window.Blockbench.mcuiStudio.getStudio().select([frame, image]),
    ids,
  );
  await mkdir('.cache/mixed-properties', { recursive: true });
  await page.screenshot({ path: '.cache/mixed-properties/frame-image.png' });
});
test('自由与Stack父级混选禁用位置和角色，切到可定位选区后恢复', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ root, frame, image, peer }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.execute('Mixed positioning', (d: any) => {
      d.nodes[root].children = d.nodes[root].children.filter((id: string) => id !== image);
      d.nodes[frame].children.push(image);
      d.nodes[image].parent = frame;
      d.nodes[frame].frame.direction = 'row';
      d.nodes[frame].frame.engineType = 'stack_panel';
    });
    a.select([image, peer]);
  }, ids);
  await tab(page, 'element');
  await expect(page.getByLabel('UI X 偏移', { exact: true })).toBeDisabled();
  await tab(page, 'mcui_layout');
  await expect(page.getByLabel('布局 X 偏移', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('定位方式', { exact: true })).toBeHidden();
  await expect(page.locator('[data-disclosure=contribution]')).toBeHidden();
  await page.evaluate(
    ({ image, peer }) => window.Blockbench.mcuiStudio.getStudio().select([image, peer]),
    ids,
  );
  await expect(page.getByLabel('布局 X 偏移', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('父级包裹统计', { exact: true })).toBeHidden();
  await page.evaluate(({ peer }) => window.Blockbench.mcuiStudio.getStudio().select([peer]), ids);
  await expect(page.getByLabel('布局 X 偏移', { exact: true })).toBeEnabled();
});
test('混合填充不伪装为首项颜色，适用性交集与确认同一白色可批量提交', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ image, peer }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(
      image,
      (n: any) =>
        (n.appearance = {
          fill: 'solid',
          color: '#ff0000ff',
          endColor: '#ffffffff',
          angle: 0,
          strokeWidth: 2,
          strokeColor: '#ffffff',
        }),
    );
    a.select([image, peer]);
  }, ids);
  await tab(page, 'mcui_content');
  const swatch = page.locator('.mcui-inspector-color[aria-label^="填充颜色"]');
  await expect(page.getByLabel('填充类型', { exact: true })).toHaveValue('');
  await expect(swatch).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel('填充类型', { exact: true }).selectOption('solid');
  await expect(swatch).toHaveAttribute('aria-disabled', 'false');
  await expect(swatch).toHaveClass(/mcui-color-mixed/);
  const before = await snap(page);
  await swatch.locator('.sp-replacer').click();
  await page.locator('.sp-container:visible .sp-cancel').click();
  expect((await snap(page)).history).toBe(before.history);
  await swatch.locator('.sp-replacer').click();
  await page.locator('.sp-container:visible .sp-choose').click();
  const after = await snap(page);
  expect(after.history).toBe(before.history + 1);
  expect([
    after.doc.nodes[ids.image].appearance.color,
    after.doc.nodes[ids.peer].appearance.color,
  ]).toEqual(['#ffffffff', '#ffffffff']);
  await page.evaluate(() => window.Undo.undo());
  await expect(swatch).toHaveClass(/mcui-color-mixed/);
  await mkdir('.cache/mixed-properties', { recursive: true });
  await page.screenshot({ path: '.cache/mixed-properties/colors.png' });
});
test('九宫格逐边混合值及批量校验失败原子回滚，未改边分别保留', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ image, peer }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.execute('Nine mixture', (d: any) => {
      for (const [id, insets] of [
        [image, [2, 3, 4, 5]],
        [peer, [4, 3, 2, 5]],
      ]) {
        const n = d.nodes[id];
        n.content = { kind: 'nine-slice', source: n.content.source, insets, mode: 'stretch' };
        delete n.rasterSize;
      }
    });
    a.select([image, peer]);
  }, ids);
  await tab(page, 'mcui_content');
  await page.locator('[data-disclosure=nineInsets] summary').click();
  const top = page.getByLabel('九宫格上边距', { exact: true });
  await expect(top).toHaveValue('');
  await expect(page.getByLabel('九宫格右边距', { exact: true })).toHaveValue('3');
  await enter(page, '九宫格上边距', '6');
  let state = await snap(page);
  expect(state.doc.nodes[ids.image].content.insets).toEqual([6, 3, 4, 5]);
  expect(state.doc.nodes[ids.peer].content.insets).toEqual([6, 3, 2, 5]);
  const before = await snap(page);
  await enter(page, '九宫格上边距', '29');
  await expect(top).toHaveAttribute('aria-invalid', 'true');
  state = await snap(page);
  expect(state.doc).toEqual(before.doc);
  expect(state.history).toBe(before.history);
  await top.press('Escape');
  await expect(top).toHaveValue('6');
});

test('同类Frame按图形字段比较并批量修改内边距，混合排列不显示无效间距', async ({ page }) => {
  const ids = await start(page);
  const other = await page.evaluate(({ root, frame }) => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      other = a.add('frame', root);
    a.execute('Frame field mixture', (d: any) => {
      d.nodes[frame].frame.direction = 'row';
      d.nodes[frame].frame.engineType = 'stack_panel';
      d.nodes[frame].frame.padding = [2, 4, 6, 8];
      d.nodes[other].frame.direction = 'column';
      d.nodes[other].frame.engineType = 'stack_panel';
      d.nodes[other].frame.padding = [4, 4, 6, 8];
    });
    a.select([frame, other]);
    return other;
  }, ids);
  await tab(page, 'mcui_layout');
  await expect(page.getByRole('button', { name: '子项对齐：上左', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('[data-flow][aria-pressed=true]')).toHaveCount(0);
  await page.getByRole('button', { name: '四边', exact: true }).click();
  await expect(page.getByLabel('上内边距', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('右内边距', { exact: true })).toHaveValue('4');
  const before = await snap(page);
  await enter(page, '上内边距', '10');
  const after = await snap(page);
  expect(after.history).toBe(before.history + 1);
  for (const id of [ids.frame, other])
    expect(after.doc.nodes[id].frame.padding).toEqual([10, 4, 6, 8]);
  await page.evaluate(
    (id) =>
      window.Blockbench.mcuiStudio.getStudio().update(id, (n: any) => {
        n.frame.direction = 'free';
        n.frame.engineType = 'panel';
      }),
    other,
  );
  await expect(page.getByLabel('间距数值', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '子项对齐：上左', exact: true })).toBeHidden();
});
test('图片适配混选使用能力交集，布尔混合值和等价尺寸/颜色正确比较', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(({ image, peer }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.execute('Image mixture', (d: any) => {
      for (const [id, mode, onlyDownscale, color] of [
        [image, 'fit', false, '#FFFFFF'],
        [peer, 'stretch', true, '#ffffffff'],
      ]) {
        const n = d.nodes[id];
        n.content = {
          kind: 'image',
          source: n.content.source,
          mode,
          anchor: [0.5, 0.5],
          offset: { x: 0, y: 0 },
          scale: 1,
          onlyDownscale,
        };
        n.appearance = {
          fill: 'solid',
          color,
          endColor: '#ffffffff',
          angle: 0,
          strokeWidth: 0,
          strokeColor: '#ffffffff',
        };
        n.layout.width = {
          kind: 'expression',
          percent: 0.25,
          pixels: 0,
          ...(id === peer ? { unit: '%' } : {}),
        };
      }
    });
    a.select([image, peer]);
  }, ids);
  await tab(page, 'mcui_layout');
  await expect(page.getByLabel('布局宽度', { exact: true })).toHaveValue('25%');
  await tab(page, 'element');
  await expect(page.getByLabel('UI 宽度', { exact: true })).toHaveValue('25%');
  await tab(page, 'mcui_content');
  await expect(page.getByLabel('图片适配', { exact: true })).toHaveValue('');
  await expect(page.locator('[data-disclosure=imageOptions]')).toBeHidden();
  await expect(page.locator('.mcui-inspector-color[aria-label^="填充颜色"]')).not.toHaveClass(
    /mcui-color-mixed/,
  );
  await page.getByLabel('图片适配', { exact: true }).selectOption('fit');
  await page.locator('[data-disclosure=imageOptions] summary').click();
  const checkbox = page.locator('[data-disclosure=imageOptions] input[type=checkbox]');
  expect(await checkbox.evaluate((e: HTMLInputElement) => e.indeterminate)).toBe(true);
  const before = await snap(page);
  await checkbox.click();
  const after = await snap(page);
  expect(after.history).toBe(before.history + 1);
  for (const id of [ids.image, ids.peer])
    expect(after.doc.nodes[id].content.onlyDownscale).toBe(true);
});

test('元素页旋转数值微调和拖动复用一次批量事务', async ({ page }) => {
  const ids = await start(page);
  await tab(page, 'element');
  await enter(page, 'UI 旋转', '0');
  const rotation = page.getByLabel('UI 旋转', { exact: true });
  await rotation.press('ArrowUp');
  let state = await snap(page);
  for (const id of [ids.frame, ids.image]) expect(state.doc.nodes[id].rotation).toBe(1);
  const before = state;
  const label = page.locator('#panel_element [form_type=mcui_scalar] label.name_space_left');
  const box = (await label.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  state = await snap(page);
  expect(state.history).toBe(before.history + 1);
  for (const id of [ids.frame, ids.image]) expect(state.doc.nodes[id].rotation).toBe(11);
  await page.evaluate(() => window.Undo.undo());
  await expect(rotation).toHaveValue('1');
});
