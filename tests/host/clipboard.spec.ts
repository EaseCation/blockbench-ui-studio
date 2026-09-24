import { test, expect, type Page } from './host-test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
const textBundle = await readFile(
  '../blockbench-bbmodel-text/dist/bbmodel-text-component.js',
  'utf8',
).catch(() => null);
async function start(page: Page) {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.Blockbench?.setup_successful);
  await page.evaluate(() => {
    const w = window as any;
    // Only in-page data: never overwrite the user's operating-system clipboard.
    w.testClipboard = { text: '', png: '', writes: 0, readBlocked: false };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          w.testClipboard.text = text;
          w.testClipboard.png = '';
          w.testClipboard.writes++;
        },
        readText: async () => w.testClipboard.text,
        read: async () => {
          const c = { ...w.testClipboard };
          if (c.readBlocked) await new Promise<void>((resolve) => (w.resumeClipboard = resolve));
          return c.png
            ? [{ types: ['image/png'], getType: async () => (await fetch(c.png)).blob() }]
            : [
                {
                  types: ['text/plain'],
                  getType: async () => new Blob([c.text], { type: 'text/plain' }),
                },
              ];
        },
      },
    });
    w.Plugins.registered.mcui_studio = new w.Blockbench.Plugin('mcui_studio');
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
  return page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio(),
      root = a.state.doc.roots[0],
      image = a.add('image', root),
      child = a.add('image', image),
      one = a.add('image', root),
      two = a.add('image', root),
      frame = a.add('frame', null);
    a.execute('Clipboard fixture', (d: any) => {
      const n = d.nodes[image];
      n.name = 'Image with children';
      n.layout.width = { kind: 'fixed', value: 64 };
      n.layout.height = { kind: 'fixed', value: 32 };
      n.opacity = 0.6;
      n.appearance = {
        fill: 'solid',
        color: '#112233ff',
        endColor: '#ffffffff',
        angle: 0,
        strokeWidth: 2,
        strokeColor: '#ffbb00ff',
      };
      d.nodes[one].layout.offset = { x: 100, y: 60 };
      d.nodes[one].layout.width = { kind: 'fixed', value: 24 };
      d.nodes[one].layout.height = { kind: 'fixed', value: 40 };
      d.nodes[two].layout.offset = { x: 180, y: 90 };
      d.nodes[two].layout.width = { kind: 'expression', percent: 0.25, pixels: -8 };
    });
    a.select([image]);
    w.Prop.active_panel = 'preview';
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 4;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#37cc71';
    ctx.fillRect(0, 0, 8, 4);
    w.testClipboard.png = c.toDataURL();
    return { root, image, child, one, two, frame };
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
      cubes: w.Cube.all.length,
      groups: w.Group.all.length,
      png: Object.fromEntries(
        Object.entries(a.state.doc.bindings)
          .filter(([, b]: any) => b.textureId)
          .map(([id, b]: any) => [
            id,
            w.Texture.all.find((t: any) => t.uuid === b.textureId).getDataURL(),
          ]),
      ),
    };
  });
async function choose(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    window.Blockbench.mcuiStudio.getStudio().select(ids);
    (window as any).Prop.active_panel = 'preview';
  }, ids);
}
async function contextItem(page: Page, id: string, action: string) {
  const uuid = await page.evaluate(
    (id) => window.Blockbench.mcuiStudio.getStudio().state.doc.bindings[id].containerId,
    id,
  );
  await page.locator(`[id="${uuid}"] > .outliner_object`).click({ button: 'right' });
  await page.locator(`.contextMenu:visible [menu_item=${action}]`).click();
}
test('Cmd+V 将外部图片填入选中Image，尺寸、外观及子层保留，Undo/Redo 一次恢复', async ({
  page,
}) => {
  const ids = await start(page),
    before = await snap(page);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await snap(page)).doc.nodes[ids.image].content.kind).toBe('image');
  const after = await snap(page);
  expect(after.cubes).toBe(before.cubes);
  expect(after.groups).toBe(before.groups);
  expect(after.history).toBe(before.history + 1);
  const a = after.doc.nodes[ids.image],
    b = before.doc.nodes[ids.image];
  for (const key of ['name', 'parent', 'children', 'layout', 'rect', 'opacity', 'appearance'])
    expect(a[key]).toEqual(b[key]);
  expect(after.png[ids.child]).toBe(before.png[ids.child]);
  expect(after.png[ids.image]).not.toBe(before.png[ids.image]);
  expect(a.content.mode).toBe('fit');
  expect(after.doc.assets[a.content.source]).toMatchObject({ width: 8, height: 4 });
  await page.evaluate(() => window.Undo.undo());
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
  expect((await snap(page)).doc).toEqual(before.doc);
  await page.evaluate(() => window.Undo.redo());
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
  expect((await snap(page)).doc).toEqual(after.doc);
});
test('右键显式粘贴为子图层保留新建行为，Frame粘贴创建内部Image', async ({ page }) => {
  const ids = await start(page);
  const before = await snap(page);
  await contextItem(page, ids.image, 'mcui_paste_child');
  await expect.poll(async () => (await snap(page)).cubes).toBe(before.cubes + 1);
  const after = await snap(page);
  expect(after.doc.nodes[ids.image].content).toEqual(before.doc.nodes[ids.image].content);
  expect(after.doc.nodes[after.selection[0]].parent).toBe(ids.image);
  await choose(page, [ids.frame]);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await snap(page)).cubes).toBe(before.cubes + 2);
  const final = await snap(page);
  expect(final.doc.nodes[final.selection[0]].parent).toBe(ids.frame);
});
test('原生paste事件优先使用图片数据，晚返回读取及选区切换不会重复或误填', async ({ page }) => {
  const ids = await start(page),
    before = await snap(page);
  await page.evaluate(() => {
    const w = window as any;
    w.testClipboard.readBlocked = true;
    w.SharedActions.run('paste');
  });
  await page.waitForFunction(() => !!(window as any).resumeClipboard);
  await page.evaluate(async () => {
    const w = window as any,
      blob = await (await fetch(w.testClipboard.png)).blob(),
      data = new DataTransfer();
    data.items.add(new File([blob], 'external.png', { type: 'image/png' }));
    document.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(async () => (await snap(page)).history).toBe(before.history + 1);
  await page.evaluate(() => {
    (window as any).resumeClipboard();
    (window as any).testClipboard.readBlocked = false;
  });
  const applied = await snap(page);
  expect(applied.cubes).toBe(before.cubes);
  await page.evaluate(() => {
    const w = window as any;
    w.resumeClipboard = null;
    w.testClipboard.readBlocked = true;
    w.SharedActions.run('paste');
  });
  await page.waitForFunction(() => !!(window as any).resumeClipboard);
  await choose(page, [ids.one]);
  await choose(page, [ids.image]);
  await page.evaluate(() => {
    (window as any).resumeClipboard();
    (window as any).testClipboard.readBlocked = false;
  });
  // A later successful command drains the asynchronous read without writing stale targets.
  await page.keyboard.press('ControlOrMeta+Alt+c');
  await expect
    .poll(() => page.evaluate(() => (window as any).testClipboard.text.startsWith('MCUI_STYLE:')))
    .toBe(true);
  expect((await snap(page)).doc).toEqual(applied.doc);
  expect((await snap(page)).history).toBe(before.history + 1);
});
test('Cmd+Option+C/V 批量复制图片填充与外观，保留几何、结构并独立保存资源', async ({ page }) => {
  const ids = await start(page);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await snap(page)).doc.nodes[ids.image].content.kind).toBe('image');
  await page.keyboard.press('ControlOrMeta+Alt+c');
  await expect
    .poll(() => page.evaluate(() => (window as any).testClipboard.text.startsWith('MCUI_STYLE:')))
    .toBe(true);
  const source = (await snap(page)).doc.nodes[ids.image];
  await page.evaluate(
    (id) => window.Blockbench.mcuiStudio.getStudio().update(id, (n: any) => (n.opacity = 0.2)),
    ids.image,
  );
  await choose(page, [ids.one, ids.two, ids.frame]);
  const before = await snap(page);
  await page.keyboard.press('ControlOrMeta+Alt+v');
  await expect.poll(async () => (await snap(page)).history).toBe(before.history + 1);
  const after = await snap(page);
  for (const id of [ids.one, ids.two]) {
    const n = after.doc.nodes[id];
    for (const key of ['name', 'parent', 'children', 'layout', 'rect', 'rotation'])
      expect(n[key]).toEqual(before.doc.nodes[id][key]);
    expect(n.appearance).toEqual(source.appearance);
    expect(n.opacity).toBe(0.6);
    expect(n.content.kind).toBe('image');
    expect(after.doc.assets[n.content.source].png).toBe(
      after.doc.assets[source.content.source].png,
    );
  }
  expect(after.doc.nodes[ids.frame]).toEqual(before.doc.nodes[ids.frame]);
  expect(after.doc.nodes[ids.child]).toEqual(before.doc.nodes[ids.child]);
  expect(after.doc.nodes[ids.one].content.source).not.toBe(after.doc.nodes[ids.two].content.source);
  expect(after.doc.bindings[ids.one].textureId).not.toBe(after.doc.bindings[ids.two].textureId);
  await page.evaluate(() => window.Undo.undo());
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
  expect((await snap(page)).doc).toEqual(before.doc);
});
test('右键属性操作与跨项目粘贴使用相同快照，无效剪贴板不回退到陈旧样式', async ({ page }) => {
  const ids = await start(page);
  await contextItem(page, ids.image, 'mcui_copy_properties');
  await expect
    .poll(() => page.evaluate(() => (window as any).testClipboard.text.startsWith('MCUI_STYLE:')))
    .toBe(true);
  const target = await page.evaluate(async () => {
    const a = window.Blockbench.mcuiStudio;
    await a.newProject();
    return a.getStudio().add('image');
  });
  const before = await snap(page);
  await contextItem(page, target, 'mcui_paste_properties');
  await expect.poll(async () => (await snap(page)).history).toBe(before.history + 1);
  expect((await snap(page)).doc.nodes[target].opacity).toBe(0.6);
  await page.evaluate(() => {
    (window as any).testClipboard.text = 'unrelated external text';
  });
  const stable = await snap(page);
  await page.keyboard.press('ControlOrMeta+Alt+v');
  await expect
    .poll(() => page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.error))
    .toContain('没有 UI 样式属性');
  expect((await snap(page)).doc).toEqual(stable.doc);
  const writes = await page.evaluate(() => (window as any).testClipboard.writes);
  await page.locator('.panel_handle[panel_id=element]').click();
  const input = page.getByLabel('UI 宽度', { exact: true });
  await input.focus();
  await page.keyboard.press('ControlOrMeta+Alt+c');
  expect(await page.evaluate(() => (window as any).testClipboard.writes)).toBe(writes);
});
test('图片样式粘贴到文字Image仅应用外观，不改文字内容或尺寸', async ({ page }) => {
  test.skip(!textBundle, 'Build the optional text plugin');
  const ids = await start(page);
  await page.evaluate(
    () =>
      (window.Plugins.registered['bbmodel-text-component'] = new window.Blockbench.Plugin(
        'bbmodel-text-component',
      )),
  );
  await page.addScriptTag({ content: textBundle! });
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await snap(page)).doc.nodes[ids.image].content.kind).toBe('image');
  await page.keyboard.press('ControlOrMeta+Alt+c');
  await expect
    .poll(() => page.evaluate(() => (window as any).testClipboard.text.startsWith('MCUI_STYLE:')))
    .toBe(true);
  const text = await page.evaluate(async () => {
    const w = window as any;
    return w.Blockbench.bbText.create();
  });
  await choose(page, [text]);
  const before = await snap(page);
  await page.keyboard.press('ControlOrMeta+Alt+v');
  await expect.poll(async () => (await snap(page)).history).toBe(before.history + 1);
  const after = (await snap(page)).doc.nodes[text];
  expect(after.content.kind).toBe('generated');
  expect(after.content.data.text).toBe(before.doc.nodes[text].content.data.text);
  expect(after.rect).toEqual(before.doc.nodes[text].rect);
  expect(after.layout).toEqual(before.doc.nodes[text].layout);
  expect(after.opacity).toBe(0.6);
});

test('系统属性读取被拒绝时使用同窗口复制快照，普通模型与卸载不接管', async ({ page }) => {
  const ids = await start(page);
  await page.keyboard.press('ControlOrMeta+Alt+c');
  await expect
    .poll(() => page.evaluate(() => (window as any).testClipboard.text.startsWith('MCUI_STYLE:')))
    .toBe(true);
  await page.evaluate(() => {
    (navigator.clipboard as any).readText = async () => {
      throw new Error('denied');
    };
  });
  await choose(page, [ids.one]);
  const before = await snap(page);
  await page.keyboard.press('ControlOrMeta+Alt+v');
  await expect.poll(async () => (await snap(page)).history).toBe(before.history + 1);
  expect((await snap(page)).doc.nodes[ids.one].opacity).toBe(0.6);
  const native = await page.evaluate(() => {
    const w = window as any;
    w.setupProject(w.Formats.free);
    const cube = new w.Cube({ name: 'ordinary' }).init();
    cube.select();
    w.Prop.active_panel = 'outliner';
    const canCopy = w.BarItems.mcui_copy_properties.condition(),
      canPaste = w.BarItems.mcui_paste_properties.condition();
    w.BarItems.copy.trigger();
    return {
      canCopy,
      canPaste,
      copied: w.Clipbench.elements?.[0]?.name,
      ui: w.Project.unhandled_root_fields.mcui_studio,
    };
  });
  expect(native).toEqual({ canCopy: false, canPaste: false, copied: 'ordinary', ui: undefined });
  await page.evaluate(() => window.Plugins.registered.mcui_studio.unload());
  expect(
    await page.evaluate(
      () => !!window.BarItems.mcui_copy_properties || !!window.BarItems.mcui_paste_properties,
    ),
  ).toBe(false);
});

test('删除当前Image及撤销期间菜单能力查询保持有效', async ({ page }) => {
  const ids = await start(page),
    before = await snap(page);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await snap(page)).cubes).toBe(before.cubes - 2);
  expect(await page.evaluate(() => window.BarItems.mcui_paste_properties.condition())).toBe(false);
  await page.evaluate(() => window.Undo.undo());
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
  expect((await snap(page)).doc.nodes[ids.image].children).toEqual([ids.child]);
  expect((await snap(page)).cubes).toBe(before.cubes);
});
