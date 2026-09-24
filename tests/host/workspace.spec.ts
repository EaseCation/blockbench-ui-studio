import { test, expect, type Page } from './host-test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page) {
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
}

test('原生交互创建和切换选区时，侧栏顺序与宿主配置一致', async ({ page }) => {
  await start(page);
  const states = await page.evaluate(async () => {
    const bb = window as any,
      app = bb.Blockbench.mcuiStudio.getStudio();
    bb.Blockbench.mcuiStudio.getViewport().setInteraction('native');
    const states: any[] = [];
    const record = async (step: string) => {
      await new Promise(requestAnimationFrame);
      const bar = document.querySelector('#right_bar')!;
      states.push({
        step,
        actual: [...bar.children]
          .filter((e) => e.classList.contains('panel_container') && !e.classList.contains('hidden'))
          .map((e) => e.getAttribute('panel_id')),
        expected: bb.Interface.getRightPanels().map((p: any) => p.id),
      });
    };
    await record('Frame');
    const root = app.state.doc.roots[0];
    const image = app.add('image', root);
    await record('创建 Image');
    app.select([root]);
    await record('选 Frame');
    app.select([image]);
    await record('选 Image');
    app.select([]);
    await record('空选区');
    app.select([root]);
    await record('返回 Frame');
    return states;
  });
  for (const state of states) expect(state.actual, state.step).toEqual(state.expected);
});

test('Figma 左侧大纲、右侧属性，创建和切换不重排或反复折叠', async ({ page }) => {
  await start(page);
  await expect(page.locator('#left_bar > [panel_id=outliner]')).toBeVisible();
  await expect(page.locator('#right_bar > [panel_id=transform]')).toBeVisible();
  await expect(page.locator('#left_bar > [panel_id=uv]')).toHaveClass(/folded/);
  await expect(page.locator('#left_bar > [panel_id=textures]')).toHaveClass(/folded/);
  const state = await page.evaluate(async () => {
    const bb = window as any,
      app = bb.Blockbench.mcuiStudio.getStudio(),
      panels = bb.Interface.Panels;
    const root = app.state.doc.roots[0],
      orders: string[][] = [];
    let moves = 0;
    const listener = panels.outliner.on('moved_to', () => moves++);
    panels.uv.fold(false);
    for (let i = 0; i < 4; i++) {
      const image = app.add('image', root);
      for (const ids of [[root], [image], [], [image]]) {
        app.select(ids);
        await new Promise(requestAnimationFrame);
        orders.push(
          [...document.querySelector('#left_bar')!.children]
            .filter((e) => !e.classList.contains('hidden'))
            .map((e) => e.getAttribute('panel_id')!),
        );
      }
    }
    listener.delete();
    return {
      orders,
      moves,
      folded: panels.uv.folded,
      contentTab: panels.mcui_content.getContainerPanel().id,
    };
  });
  expect(state.moves).toBe(0);
  expect(state.folded).toBe(false);
  expect(state.orders.every((order) => order[0] === 'outliner')).toBe(true);
  expect(state.contentTab).toBe('transform');
  await page.evaluate(() => (window as any).Interface.Panels.uv.fold(true));
  await page.screenshot({ path: '.cache/mcui-figma-workspace.png' });
});

test('切换原生、绘画、普通项目和卸载恢复布局；Figma 的透视切换保留大纲', async ({ page }) => {
  await start(page);
  const snap = () =>
    page.evaluate(() => {
      const bb = window as any;
      return ['outliner', 'uv', 'textures', 'transform'].map((id) => {
        const p = bb.Interface.Panels[id];
        return { id, slot: p.slot, folded: p.folded, index: p.position_data.sidebar_index };
      });
    });
  const figma = await snap();
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setView('3d'));
  await expect(page.locator('#left_bar > [panel_id=outliner]')).toBeVisible();
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await expect(page.locator('#right_bar > [panel_id=outliner]')).toBeVisible();
  const native = await snap();
  expect(native.find((p) => p.id === 'uv')?.folded).toBe(false);
  expect(native.find((p) => p.id === 'textures')?.folded).toBe(false);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('figma'));
  await expect(page.locator('#left_bar > [panel_id=outliner]')).toBeVisible();
  await page.evaluate(() => window.Modes.options.paint.select());
  await expect(page.locator('#left_bar > [panel_id=uv]')).not.toHaveClass(/folded/);
  await page.evaluate(() => window.Modes.options.edit.select());
  await expect(page.locator('#left_bar > [panel_id=outliner]')).toBeVisible();
  const uiProject = await page.evaluate(() => window.Project.uuid);
  await page.evaluate(() => window.setupProject(window.Formats.free));
  await expect(page.locator('#right_bar > [panel_id=outliner]')).toBeVisible();
  expect(await snap()).toEqual(native);
  await page.evaluate(
    (id) => (window as any).ModelProject.all.find((p: any) => p.uuid === id).select(),
    uiProject,
  );
  await expect(page.locator('#left_bar > [panel_id=outliner]')).toBeVisible();
  expect(await snap()).toEqual(figma);
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  await expect(page.locator('#right_bar > [panel_id=outliner]')).toBeVisible();
  expect(await snap()).toEqual(native);
});

test('保留已有原生布局和手动折叠状态，仅临时改变 Figma 工作区', async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await expect(page.locator('#right_bar > [panel_id=outliner]')).toBeVisible();
  const before = await page.evaluate(() => {
    const bb = window as any,
      p = bb.Interface.Panels;
    p.outliner.customizePosition({ sidebar_index: -5 });
    p.textures.fold(true);
    bb.Prop.show_left_bar = false;
    bb.updateInterfacePanels();
    return {
      outliner: { ...p.outliner.position_data },
      textures: { ...p.textures.position_data },
      show: bb.Prop.show_left_bar,
    };
  });
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('figma'));
  await expect(page.locator('#left_bar > [panel_id=outliner]')).toBeVisible();
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await expect(page.locator('#right_bar > [panel_id=outliner]')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const bb = window as any,
        p = bb.Interface.Panels;
      return {
        outliner: { ...p.outliner.position_data },
        textures: { ...p.textures.position_data },
        show: bb.Prop.show_left_bar,
      };
    }),
  ).toEqual(before);
});

test('属性标签撑满右栏、随窗口调整且长表单内部滚动', async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.BarItems.mcui_add_layer.trigger());
  const bounds = () =>
    page.evaluate(() => {
      const bar = document.querySelector('#right_bar')!.getBoundingClientRect();
      const host = document
        .querySelector('#right_bar > .mcui-fill-inspector')!
        .getBoundingClientRect();
      return { available: bar.height, height: host.height, bottom: bar.bottom - host.bottom };
    });
  const heights: number[] = [];
  for (const id of ['element', 'mcui_layout', 'mcui_content']) {
    await page.locator(`.panel_handle[panel_id=${id}]`).click();
    const box = await bounds();
    expect(box.height).toBeGreaterThan(box.available - 3);
    expect(Math.abs(box.bottom)).toBeLessThan(3);
    heights.push(box.height);
  }
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
  await page.setViewportSize({ width: 1280, height: 650 });
  await page.getByRole('button', { name: '添加填充', exact: true }).click();
  await page.getByLabel('填充类型', { exact: true }).selectOption('linear');
  await page.getByRole('button', { name: '添加描边', exact: true }).click();
  const content = page.locator('#panel_mcui_content');
  expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page
    .getByRole('button', { name: '合成为可绘制像素', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: '合成为可绘制像素', exact: true }),
  ).toBeInViewport();
  expect((await bounds()).height).toBeLessThan(heights[0]!);
  await page.screenshot({ path: '.cache/mcui-inspector-full-height.png' });
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await expect(page.locator('.mcui-fill-inspector')).toHaveCount(0);
  await expect(page.locator('#right_bar > [panel_id=outliner]')).toBeVisible();
});

test('分离停靠的 UI 布局优先获得高度，元素区压缩并支持重新合并', async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await expect(page.locator('.mcui-fill-inspector')).toHaveCount(0);
  await page.evaluate(() => {
    const bb = window as any,
      p = bb.Interface.Panels;
    p.mcui_layout.moveTo('right_bar');
    p.mcui_layout.customizePosition({ fixed_height: true, height: 180 });
    p.transform.customizePosition({ fixed_height: true, height: 750 });
    p.transform.container.style.setProperty('--main-panel-height', '700px');
    bb.updateInterfacePanels();
    bb.Blockbench.mcuiStudio.getViewport().setInteraction('figma');
  });
  await expect(page.locator('#right_bar > [panel_id=mcui_layout]')).toHaveClass(
    /mcui-fill-inspector/,
  );
  await expect(page.locator('#right_bar > [panel_id=transform]')).toHaveClass(
    /mcui-compact-inspector/,
  );
  const sizes = () =>
    page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        available: box('#right_bar').height,
        top: box('#right_bar > [panel_id=transform]').height,
        bottom: box('#right_bar > [panel_id=mcui_layout]').height,
      };
    });
  await expect
    .poll(async () => {
      const s = await sizes();
      return s.bottom / s.available;
    })
    .toBeGreaterThan(0.65);
  expect((await sizes()).top).toBeLessThan(220);
  await page.screenshot({ path: '.cache/mcui-detached-inspector-height.png' });
  await page.evaluate(() => window.BarItems.mcui_add_layer.trigger());
  await expect
    .poll(async () => {
      const s = await sizes();
      return s.bottom / s.available;
    })
    .toBeGreaterThan(0.65);
  // Choosing UI Content in the upper group makes both UI groups share available height.
  await page.locator('.panel_handle[panel_id=mcui_content]').click();
  await expect(page.locator('#right_bar > [panel_id=transform]')).toHaveClass(
    /mcui-fill-inspector/,
  );
  await page.evaluate(() => {
    const p = (window as any).Interface.Panels;
    p.transform.attachPanel(p.mcui_layout, -1);
    p.transform.selectTab(p.mcui_layout);
  });
  await expect(page.locator('.mcui-compact-inspector')).toHaveCount(0);
  await expect(page.locator('.mcui-fill-inspector')).toHaveCount(1);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await expect(page.locator('.mcui-fill-inspector,.mcui-compact-inspector')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).Interface.Panels.transform.position_data.height),
  ).toBe(750);
});

test('布局和内容都独立停靠时平分剩余高度，浮动面板不被撑高规则接管', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const bb = window as any,
      p = bb.Interface.Panels;
    bb.BarItems.mcui_add_layer.trigger();
    p.mcui_layout.moveTo('right_bar');
    p.mcui_content.moveTo('right_bar');
    p.transform.selectTab(p.element);
    bb.updateInterfacePanels();
  });
  await expect(page.locator('.mcui-fill-inspector')).toHaveCount(2);
  const heights = await page.evaluate(() =>
    ['mcui_layout', 'mcui_content'].map(
      (id) =>
        document.querySelector(`#right_bar > [panel_id=${id}]`)!.getBoundingClientRect().height,
    ),
  );
  expect(Math.abs(heights[0]! - heights[1]!)).toBeLessThan(3);
  expect(Math.min(...heights)).toBeGreaterThan(280);
  await page.evaluate(() => (window as any).Interface.Panels.mcui_content.moveTo('float'));
  await expect(page.locator('[panel_id=mcui_content].mcui-fill-inspector')).toHaveCount(0);
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  await expect(page.locator('.mcui-fill-inspector,.mcui-compact-inspector')).toHaveCount(0);
});
