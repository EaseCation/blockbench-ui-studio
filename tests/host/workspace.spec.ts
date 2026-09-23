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
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
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
