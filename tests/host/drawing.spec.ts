import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  page.on('pageerror', (e) => console.log('HOST ERROR:', e.message));
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
  });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => !!window.Blockbench.mcuiStudio);
  await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
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
const selectedTool = (page: Page) => page.evaluate(() => (window as any).Toolbox.selected.id);

test('A/R 拖绘 Frame 与 Image：精确尺寸、内部创建、无中间模型和一次撤销', async ({ page }) => {
  await start(page);
  await expect(page.locator('[toolbar_item=mcui_draw_frame]')).toBeVisible();
  await expect(page.locator('[toolbar_item=mcui_draw_image]')).toBeVisible();
  await page.keyboard.press('a');
  expect(await selectedTool(page)).toBe('mcui_draw_frame');
  const before = await page.evaluate(() => ({
    doc: JSON.stringify(window.Blockbench.mcuiStudio.getStudio().state.doc),
    undo: window.Undo.history.length,
    textures: window.Texture.all.length,
  }));
  const a = await point(page, 20, 25),
    b = await point(page, 100, 80);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await expect(page.locator('[data-mcui-draft]')).toHaveCount(1);
  await expect(page.locator('[data-mcui-draft-size]')).toContainText('80 × 55px');
  expect(
    await page.evaluate(() => JSON.stringify(window.Blockbench.mcuiStudio.getStudio().state.doc)),
  ).toBe(before.doc);
  expect(await page.evaluate(() => !!window.Undo.current_save)).toBe(false);
  await page.screenshot({ path: '.cache/mcui-draw-frame.png' });
  await page.mouse.up();
  const frame = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return { ...app.state.doc.nodes[app.state.selection[0]], undo: window.Undo.history.length };
  });
  expect(frame.kind).toBe('frame');
  expect(frame.rect).toEqual({ x: 20, y: 25, width: 80, height: 55 });
  expect(frame.undo).toBe(before.undo + 1);
  expect(await selectedTool(page)).toBe('mcui_select');
  await page.keyboard.press('r');
  expect(await selectedTool(page)).toBe('mcui_draw_image');
  const c = await point(page, 30, 35),
    d = await point(page, 70, 60);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 6 });
  await page.mouse.up();
  const image = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      n = app.state.doc.nodes[app.state.selection[0]],
      t = window.Texture.all[0];
    return {
      ...n,
      pixels: [t.width, t.height],
      blank: Array.from(t.ctx.getImageData(0, 0, t.width, t.height).data).every((v) => v === 0),
    };
  });
  expect(image.parent).toBe(frame.id);
  expect(image.rect).toEqual({ x: 30, y: 35, width: 40, height: 25 });
  expect(image.pixels).toEqual([40, 25]);
  expect(image.blank).toBe(true);
  await page.evaluate(() => window.Undo.undo());
  await expect.poll(() => page.evaluate(() => window.Cube.all.length)).toBe(0);
  await page.evaluate(() => window.Undo.redo());
  await expect.poll(() => page.evaluate(() => window.Cube.all.length)).toBe(1);
});

test('反向 Shift/Alt 创建、自动放入关闭与起点父级锁定', async ({ page }) => {
  await start(page);
  const id = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0],
      id = app.add('image', root);
    app.update(id, (n: any) => {
      n.layout.offset = { x: 30, y: 30 };
      n.layout.width = { kind: 'fixed', value: 50 };
      n.layout.height = { kind: 'fixed', value: 50 };
    });
    return id;
  });
  await page.keyboard.press('r');
  const a = await point(page, 55, 55),
    b = await point(page, 115, 90);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  expect(
    await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app.state.doc.nodes[app.state.selection[0]].parent;
    }),
  ).toBe(id);
  await page.evaluate(() =>
    window.Blockbench.mcuiStudio.getViewport().setAutomaticPlacement(false),
  );
  await page.keyboard.press('a');
  const c = await point(page, 170, 100),
    d = await point(page, 145, 90);
  await page.keyboard.down('Shift');
  await page.keyboard.down('Alt');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.up('Shift');
  const n = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return app.state.doc.nodes[app.state.selection[0]];
  });
  expect(n.parent).toBeNull();
  expect(n.rect).toEqual({ x: 145, y: 75, width: 50, height: 50 });
});

test('Stack 绘制预览最终位置，Space 移动框，导航不触发创建', async ({ page }) => {
  await start(page);
  const stack = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      id = app.add('frame', app.state.doc.roots[0]);
    app.update(id, (n: any) => {
      n.layout.offset = { x: 20, y: 20 };
      n.layout.width = { kind: 'fixed', value: 150 };
      n.layout.height = { kind: 'fixed', value: 100 };
      n.frame.engineType = 'stack_panel';
      n.frame.direction = 'row';
      n.frame.padding = [8, 8, 8, 8];
    });
    return id;
  });
  await page.keyboard.press('r');
  const a = await point(page, 60, 50),
    b = await point(page, 90, 70),
    c = await point(page, 95, 77);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.keyboard.down('Space');
  await page.mouse.move(c.x, c.y, { steps: 4 });
  await page.keyboard.up('Space');
  await expect(page.locator('[data-mcui-draft-size]')).toContainText('30 × 20px');
  await expect(page.locator('[data-mcui-placement]')).toHaveCount(1);
  await expect(page.locator('[data-mcui-insertion]')).toHaveCount(1);
  const zoom = await page.evaluate(() => window.Preview.selected.camera.zoom);
  await page.mouse.wheel(0, 40);
  expect(await page.evaluate(() => window.Preview.selected.camera.zoom)).toBe(zoom);
  await page.screenshot({ path: '.cache/mcui-draw-image.png' });
  await page.mouse.up();
  const n = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return app.state.doc.nodes[app.state.selection[0]];
  });
  expect(n.parent).toBe(stack);
  expect(n.rect).toEqual({ x: 28, y: 28, width: 30, height: 20 });
  await page.keyboard.press('a');
  const before = await page.evaluate(() => ({
    history: window.Undo.history.length,
    nodes: Object.keys(window.Blockbench.mcuiStudio.getStudio().state.doc.nodes).length,
  }));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  expect(await selectedTool(page)).toBe('mcui_draw_frame');
  expect(
    await page.evaluate(() => ({
      history: window.Undo.history.length,
      nodes: Object.keys(window.Blockbench.mcuiStudio.getStudio().state.doc.nodes).length,
    })),
  ).toEqual(before);
});

test('快捷键不覆盖文本、对话框、绘画、原生交互和透视；支持重绑定与卸载', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    (window as any).__rotations = 0;
    window.BarItems.rotate_tool.on('select', () => {
      (window as any).__rotations++;
    });
  });
  await page.keyboard.press('r');
  expect(await selectedTool(page)).toBe('mcui_draw_image');
  expect(await page.evaluate(() => (window as any).__rotations)).toBe(0);
  await page.keyboard.press('Escape');
  expect(await selectedTool(page)).toBe('mcui_select');
  const input = page.locator('#panel_element input[aria-label="UI 宽度"]:visible');
  await input.focus();
  await input.press('a');
  expect(await selectedTool(page)).toBe('mcui_select');
  await input.press('Escape');
  await input.blur();
  await page.evaluate(() => {
    new (window as any).Dialog('mcui_key_probe', {
      title: '快捷键隔离',
      lines: ['测试'],
      buttons: ['关闭'],
    }).show();
  });
  await page.keyboard.press('a');
  expect(await selectedTool(page)).toBe('mcui_select');
  await page.evaluate(() => (window as any).Dialog.open.hide());
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await page.keyboard.press('a');
  expect(await selectedTool(page)).not.toBe('mcui_draw_frame');
  await page.keyboard.press('r');
  expect(await selectedTool(page)).toBe('rotate_tool');
  await page.evaluate(() => {
    const v = window.Blockbench.mcuiStudio.getViewport();
    v.setInteraction('figma');
    v.setView('3d');
  });
  await page.keyboard.press('a');
  expect(await selectedTool(page)).not.toBe('mcui_draw_frame');
  await page.evaluate(() => {
    window.Modes.options.paint.select();
  });
  await page.keyboard.press('a');
  expect(await page.evaluate(() => window.Modes.paint)).toBe(true);
  expect(await selectedTool(page)).not.toBe('mcui_draw_frame');
  await page.evaluate(() => {
    window.Modes.options.edit.select();
    window.Blockbench.mcuiStudio.getViewport().setView('2d');
    window.BarItems.mcui_draw_frame.keybind.set({ key: 70 });
  });
  await page.keyboard.press('f');
  expect(await selectedTool(page)).toBe('mcui_draw_frame');
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  await expect(page.locator('[toolbar_item=mcui_draw_frame]')).toHaveCount(0);
  expect(await selectedTool(page)).not.toMatch(/^mcui_/);
  await page.keyboard.press('r');
  expect(await selectedTool(page)).toBe('rotate_tool');
});

for (const action of [
  'escape',
  'right',
  'tool',
  'blur',
  'mode',
  'project',
  'outside',
  'click',
  'pointercancel',
  'dialog',
] as const)
  test(`绘制取消 ${action} 不留下对象或 Undo`, async ({ page }) => {
    await start(page);
    const before = await page.evaluate(() => ({
      doc: JSON.stringify(window.Blockbench.mcuiStudio.getStudio().state.doc),
      undo: window.Undo.history.length,
      project: window.Project.uuid,
    }));
    await page.keyboard.press('r');
    const a = await point(page, 40, 40),
      b = await point(page, 90, 70);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    if (action !== 'click') await page.mouse.move(b.x, b.y, { steps: 5 });
    if (action === 'escape') await page.keyboard.press('Escape');
    if (action === 'right')
      await page.evaluate(() =>
        window.Preview.selected.canvas.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        ),
      );
    if (action === 'tool') await page.keyboard.press('a');
    if (action === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    if (action === 'mode') await page.evaluate(() => window.Modes.options.paint.select());
    if (action === 'project') await page.evaluate(() => window.setupProject(window.Formats.free));
    if (action === 'pointercancel')
      await page.evaluate(() =>
        window.Preview.selected.node.dispatchEvent(
          new PointerEvent('pointercancel', { bubbles: true }),
        ),
      );
    if (action === 'dialog')
      await page.evaluate(() =>
        new (window as any).Dialog('drawing_modal', {
          title: '对话框',
          lines: ['暂停绘制'],
        }).show(),
      );
    if (action === 'outside') await page.mouse.move(15, 200, { steps: 5 });
    await page.mouse.up();
    if (action === 'dialog') await page.evaluate(() => (window as any).Dialog.open.hide());
    if (action === 'project')
      await page.evaluate(
        (id) => (window as any).ModelProject.all.find((p: any) => p.uuid === id).select(),
        before.project,
      );
    if (action === 'mode') await page.evaluate(() => window.Modes.options.edit.select());
    await page.waitForFunction(() => !!window.Blockbench.mcuiStudio.getStudio());
    expect(
      await page.evaluate(() => JSON.stringify(window.Blockbench.mcuiStudio.getStudio().state.doc)),
    ).toBe(before.doc);
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(before.undo);
  });

test('绘制中的目标失效会安全取消；删除键不误删原选区', async ({ page }) => {
  await start(page);
  const root = await page.evaluate(
    () => window.Blockbench.mcuiStudio.getStudio().state.doc.roots[0],
  );
  await page.keyboard.press('r');
  const a = await point(page, 30, 40),
    b = await point(page, 80, 70);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.keyboard.press('Backspace');
  await page.mouse.up();
  expect(
    await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.doc.roots),
  ).toEqual([root]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.deleteSelection();
  });
  await expect(page.locator('[data-mcui-draft-size]')).toContainText('不存在');
  await page.mouse.up();
  expect(await page.evaluate(() => window.Cube.all.length)).toBe(0);
  expect(
    await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.doc.roots.length),
  ).toBe(0);
});

test('弹窗期间松开 Space 不残留平移状态', async ({ page }) => {
  await start(page);
  await page.keyboard.press('a');
  await page.keyboard.down('Space');
  await page.evaluate(() =>
    new (window as any).Dialog('space_release', { title: 'Space', lines: ['临时对话框'] }).show(),
  );
  await page.keyboard.up('Space');
  await page.evaluate(() => (window as any).Dialog.open.hide());
  const a = await point(page, 30, 30),
    b = await point(page, 60, 50);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  const n = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return app.state.doc.nodes[app.state.selection[0]];
  });
  expect(n.rect).toEqual({ x: 30, y: 30, width: 30, height: 20 });
});
