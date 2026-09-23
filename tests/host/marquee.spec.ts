import { test, expect, type Page } from './host-test';
import { readFile, mkdir } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
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
    const w = window as any;
    w.settings.undo_selections.set(true);
    const a = w.Blockbench.mcuiStudio.getStudio(),
      root = a.state.doc.roots[0],
      card = a.add('frame', root),
      row = a.add('frame', card),
      one = a.add('image', row),
      two = a.add('image', row),
      other = a.add('image', root),
      image = a.add('image', root),
      child = a.add('image', image),
      empty = a.add('frame', root),
      locked = a.add('image', row),
      hidden = a.add('image', row);
    a.execute('Nested marquee fixture', (d: any) => {
      const box = (id: string, x: number, y: number, width: number, height: number) => {
        const n = d.nodes[id];
        n.layout.offset = { x, y };
        n.layout.width = { kind: 'fixed', value: width };
        n.layout.height = { kind: 'fixed', value: height };
      };
      box(root, 0, 0, 400, 300);
      box(card, 30, 30, 170, 120);
      box(row, 20, 25, 120, 45);
      box(one, 5, 5, 20, 20);
      box(two, 50, 5, 20, 20);
      box(other, 40, 200, 20, 20);
      box(image, 240, 40, 120, 100);
      box(child, 30, 20, 25, 25);
      box(empty, 260, 190, 30, 25);
      box(locked, 35, 5, 10, 20);
      box(hidden, 85, 5, 10, 20);
      d.nodes[locked].locked = true;
      d.nodes[hidden].visible = false;
      for (const id of [one, two, other, image, child, locked, hidden])
        d.nodes[id].appearance = {
          fill: 'solid',
          color: id === image ? '#35465aff' : '#68b4ffff',
          endColor: '#35465aff',
          angle: 0,
          strokeColor: '#ffffffff',
          strokeWidth: 0,
        };
    });
    a.select([]);
    w.Blockbench.mcuiStudio.getViewport().fit();
    w.Blockbench.mcuiStudio.getViewport().automaticPlacement = false;
    return { root, card, row, one, two, other, image, child, empty, locked, hidden };
  });
}
async function point(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const w = window as any,
        p = w.Preview.selected,
        r = p.canvas.getBoundingClientRect(),
        v = new w.THREE.Vector3(x, 0, y).project(p.camera);
      return { x: r.left + ((v.x + 1) * r.width) / 2, y: r.top + ((1 - v.y) * r.height) / 2 };
    },
    { x, y },
  );
}
async function begin(page: Page, from = [20, 20], to = [135, 95]) {
  const a = await point(page, from[0]!, from[1]!),
    b = await point(page, to[0]!, to[1]!);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await expect(page.locator('#selection_box')).toBeAttached();
}
const selection = (page: Page) =>
  page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.selection);
const state = (page: Page) =>
  page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio();
    return {
      doc: JSON.stringify(a.state.doc),
      history: w.Undo.history.length,
      camera: w.Preview.selected.camera.position.toArray(),
      zoom: w.Preview.selected.camera.zoom,
    };
  });

test('普通框选实时提升共同外层，反向框选一致；选择Undo和重做不改模型', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().select([id]), ids.other);
  const before = await state(page);
  await begin(page);
  expect(await selection(page)).toEqual([ids.card]);
  await page.mouse.up();
  expect(await selection(page)).toEqual([ids.card]);
  const after = await state(page);
  expect(after.doc).toBe(before.doc);
  expect(after.history).toBe(before.history + 1);
  await page.evaluate(() => window.Undo.undo());
  expect(await selection(page)).toEqual([ids.other]);
  await page.evaluate(() => window.Undo.redo());
  expect(await selection(page)).toEqual([ids.card]);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().select([]));
  await begin(page, [190, 140], [20, 20]);
  expect(await selection(page)).toEqual([ids.card]);
  await page.mouse.up();
  await mkdir('.cache/marquee', { recursive: true });
  await page.screenshot({ path: '.cache/marquee/normal.png' });
});

test('Command深层框选含内部Image、跨Frame但不选父层，不移动相机或修改贴图', async ({ page }) => {
  const ids = await start(page),
    before = await state(page);
  await page.keyboard.down('Meta');
  await begin(page);
  expect((await selection(page)).sort()).toEqual([ids.one, ids.two].sort());
  await page.mouse.up();
  await page.keyboard.up('Meta');
  expect((await selection(page)).sort()).toEqual([ids.one, ids.two].sort());
  const after = await state(page);
  expect(after.doc).toBe(before.doc);
  after.camera.forEach((value: number, index: number) =>
    expect(value).toBeCloseTo(before.camera[index], 6),
  );
  expect(after.zoom).toBe(before.zoom);
  await page.keyboard.down('Meta');
  await begin(page, [-10, -10], [380, 240]);
  await page.mouse.up();
  await page.keyboard.up('Meta');
  expect((await selection(page)).sort()).toEqual(
    [ids.one, ids.two, ids.other, ids.child, ids.empty].sort(),
  );
  await page.screenshot({ path: '.cache/marquee/deep.png' });
});

test('拖动中按下/松开Command立即切换结果，Shift深选移除旧祖先并保留其它项', async ({ page }) => {
  const ids = await start(page);
  await begin(page);
  expect(await selection(page)).toEqual([ids.card]);
  await page.keyboard.down('Meta');
  expect((await selection(page)).sort()).toEqual([ids.one, ids.two].sort());
  await page.keyboard.up('Meta');
  expect(await selection(page)).toEqual([ids.card]);
  await page.mouse.up();
  await page.evaluate(
    (ids) => window.Blockbench.mcuiStudio.getStudio().select(ids),
    [ids.card, ids.other],
  );
  await page.keyboard.down('Shift');
  await page.keyboard.down('Meta');
  await begin(page, [45, 48], [82, 92]);
  expect((await selection(page)).sort()).toEqual([ids.one, ids.other].sort());
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await page.keyboard.up('Shift');
});

test('容器内部起手使用内部范围，按Command可从填充Image上开始框选', async ({ page }) => {
  const ids = await start(page);
  await begin(page, [40, 42], [135, 100]);
  expect(await selection(page)).toEqual([ids.row]);
  await page.mouse.up();
  await page.keyboard.down('Meta');
  await begin(page, [250, 50], [315, 100]);
  expect(await selection(page)).toEqual([ids.child]);
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await page.keyboard.down('Meta');
  const p = await point(page, 60, 65);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Meta');
  expect(await selection(page)).toEqual([ids.one]);
});

for (const cancel of [
  'Escape',
  'blur',
  'pointercancel',
  'mode',
  'tool',
  'project',
  'dialog',
] as const)
  test(`框选取消 ${cancel} 清理宿主手势与选区历史`, async ({ page }) => {
    const ids = await start(page);
    await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().select([id]), ids.other);
    const before = await state(page);
    const project = await page.evaluate(() => window.Project.uuid);
    await page.keyboard.down('Meta');
    await begin(page);
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else
      await page.evaluate((cancel) => {
        const w = window as any;
        if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
        if (cancel === 'pointercancel')
          w.Preview.selected.node.dispatchEvent(
            new PointerEvent('pointercancel', { bubbles: true }),
          );
        if (cancel === 'mode') w.Modes.options.paint.select();
        if (cancel === 'tool') w.BarItems.move_tool.select();
        if (cancel === 'dialog')
          new w.Dialog({ id: 'marquee_cancel_dialog', title: 'test', lines: ['test'] }).show();
        if (cancel === 'project') {
          w.Project.saved = true;
          w.setupProject(w.Formats.free);
        }
      }, cancel);
    await page.mouse.up();
    await page.keyboard.up('Meta');
    await expect(page.locator('#selection_box')).toHaveCount(0);
    if (cancel === 'project')
      await page.evaluate(
        (id) => (window as any).ModelProject.all.find((p: any) => p.uuid === id).select(),
        project,
      );
    expect(await selection(page)).toEqual([ids.other]);
    const after = await state(page);
    expect(after.doc).toBe(before.doc);
    expect(after.history).toBe(before.history);
    expect(
      await page.evaluate(() => (window as any).Preview.selected.selection.sr_move_f),
    ).toBeUndefined();
  });

test('Windows Ctrl修饰键事件深层框选，原生交互和透视不启用UI框选规则', async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/145.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.route('https://web.blockbench.net/content/news.json*', (r) => r.fulfill({ json: {} }));
  const ids = await start(page);
  // macOS converts native Ctrl+click into a context menu even with a Windows UA.
  // Exercise Windows modifier events without claiming a physical Windows mouse test.
  const from = await point(page, 20, 20),
    to = await point(page, 135, 95);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.evaluate((to) => {
    const w = window as any,
      v = w.Blockbench.mcuiStudio.getViewport(),
      id = v.nativeMarquee.pointer;
    for (const type of ['pointermove', 'pointerup'])
      document.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: type === 'pointermove' ? 1 : 0,
          clientX: to.x,
          clientY: to.y,
          ctrlKey: true,
        }),
      );
  }, to);
  await page.mouse.up();
  expect((await selection(page)).sort()).toEqual([ids.one, ids.two].sort());
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  expect(await page.evaluate(() => (window as any).Toolbox.selected.id)).not.toBe('mcui_select');
  await page.evaluate(() => {
    const v = window.Blockbench.mcuiStudio.getViewport();
    v.setInteraction('figma');
    v.setView('3d');
  });
  expect(await page.evaluate(() => (window as any).Toolbox.selected.id)).not.toBe('mcui_select');
  await context.close();
});
