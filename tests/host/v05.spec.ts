import { test, expect, type Page } from './host-test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
async function start(page: Page, plugin = true) {
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  if (plugin) {
    await page.evaluate(() => {
      window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
    });
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => !!window.Blockbench.mcuiStudio);
    await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
  }
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
async function scene(page: Page) {
  return page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const a = app.add('image', root),
      b = app.add('image', root);
    app.update(a, (n: any) => {
      n.name = '父 Image';
      n.layout.offset = { x: 130, y: 35 };
      n.layout.width = { kind: 'fixed', value: 100 };
      n.layout.height = { kind: 'fixed', value: 100 };
      n.appearance = {
        fill: 'solid',
        color: '#27527fff',
        endColor: '#27527fff',
        angle: 0,
        strokeWidth: 1,
        strokeColor: '#8fc1ffff',
      };
    });
    app.update(b, (n: any) => {
      n.name = '子 Image';
      n.layout.offset = { x: 30, y: 55 };
      n.appearance = {
        fill: 'solid',
        color: '#ffaa66ff',
        endColor: '#ffaa66ff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffff',
      };
    });
    app.select([b]);
    return {
      a,
      b,
      root,
      aGroup: app.state.doc.bindings[a].containerId,
      bGroup: app.state.doc.bindings[b].containerId,
    };
  });
}

test('v0.5 Image 嵌套、大纲过滤、创建默认内部与无插件保存', async ({ page, context }) => {
  await start(page);
  const ids = await scene(page);
  const data = await page.evaluate(({ a }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.select([a]);
    window.BarItems.mcui_add_layer.trigger();
    const child = app.state.selection[0];
    return {
      child,
      parent: app.state.doc.nodes[child].parent,
      count: window.Cube.all.length,
      groups: (window as any).Group.all.length,
      model: JSON.parse(
        JSON.stringify(window.Codecs.project.compile({ raw: true, bitmaps: true })),
      ),
    };
  }, ids);
  expect(data.parent).toBe(ids.a);
  expect(data.count).toBe(3);
  expect(data.groups).toBe(4);
  await expect(page.locator('#cubes_list .outliner_node')).toHaveCount(4);
  await page.evaluate(() => window.BarItems.mcui_show_native.trigger());
  await expect(page.locator('#cubes_list .outliner_node')).toHaveCount(7);
  const bare = await context.newPage();
  await start(bare, false);
  expect(
    await bare.evaluate((model) => {
      window.setupProject(window.Formats.free);
      window.Codecs.project.parse(model);
      return [window.Cube.all.length, (window as any).Group.all.length];
    }, data.model),
  ).toEqual([3, 4]);
  await bare.close();
});

test('v0.5 大纲真实鼠标 Image 拖入 Image，原子 Undo/Redo', async ({ page }) => {
  await start(page);
  const ids = await scene(page);
  const before = await page.evaluate(() => ({
    undo: window.Undo.history.length,
    rect: [...window.Cube.all[1].from],
  }));
  const a = await page.locator(`[id="${ids.aGroup}"] > .outliner_object`).boundingBox(),
    b = await page.locator(`[id="${ids.bGroup}"] > .outliner_object`).boundingBox();
  await page.mouse.move(b!.x + 80, b!.y + 16);
  await page.mouse.down();
  await page.mouse.move(b!.x + 90, b!.y + 16, { steps: 2 });
  await page.mouse.move(a!.x + 80, a!.y + 16, { steps: 10 });
  await page.mouse.up();
  const state = () =>
    page.evaluate(({ b }) => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return {
        parent: app.state.doc.nodes[b].parent,
        rect: app.state.doc.nodes[b].rect,
        error: app.state.error,
        undo: window.Undo.history.length,
      };
    }, ids);
  expect((await state()).parent).toBe(ids.a);
  expect((await state()).rect.x).toBe(before.rect[0]);
  expect((await state()).undo).toBe(before.undo + 1);
  expect((await state()).error).toBeNull();
  await page.evaluate(() => window.Undo.undo());
  await expect.poll(async () => (await state()).parent).toBe(ids.root);
  await page.evaluate(() => window.Undo.redo());
  await expect.poll(async () => (await state()).parent).toBe(ids.a);
});

test('v0.5 视口 hover 与点击一致，根 Frame 名称和空白框选', async ({ page }) => {
  await start(page);
  const ids = await scene(page);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().select([]));
  const p = await point(page, 175, 75);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('[data-mcui-hover]')).toHaveCount(1);
  await page.mouse.click(p.x, p.y);
  expect(
    await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.selection),
  ).toEqual([ids.a]);
  await page.locator(`[data-mcui-label="${ids.root}"]`).click();
  expect(
    await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.selection),
  ).toEqual([ids.root]);
  const blank = await point(page, 260, 150);
  await page.mouse.move(blank.x, blank.y);
  await expect(page.locator('[data-mcui-hover]')).toHaveCount(0);
  await page.mouse.click(blank.x, blank.y);
  expect(
    await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.selection),
  ).toEqual([]);
  await page.mouse.move(p.x, p.y);
  await page.screenshot({ path: '.cache/mcui-v05-hover.png' });
});

test('v0.5 视口放入预览不写数据，松手单次提交与开关关闭', async ({ page }) => {
  await start(page);
  const ids = await scene(page),
    from = await point(page, 46, 71),
    to = await point(page, 175, 80);
  const before = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return {
      doc: JSON.stringify(app.state.doc),
      undo: window.Undo.history.length,
      images: window.Texture.all.map((t: any) => t.getDataURL()),
    };
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await expect(page.locator('[data-mcui-drop]')).toHaveCount(1);
  expect(
    await page.evaluate(() => JSON.stringify(window.Blockbench.mcuiStudio.getStudio().state.doc)),
  ).toBe(before.doc);
  expect(await page.evaluate(() => window.Texture.all.map((t: any) => t.getDataURL()))).toEqual(
    before.images,
  );
  await page.screenshot({ path: '.cache/mcui-v05-drop.png' });
  await page.mouse.up();
  expect(
    await page.evaluate(
      ({ b }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[b].parent,
      ids,
    ),
  ).toBe(ids.a);
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(before.undo + 1);
  await page.evaluate(() => window.Undo.undo());
  await page.waitForFunction(
    ({ b, root }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[b].parent === root,
    ids,
  );
  await page.locator('[toolbar_item=mcui_auto_place] .bb-select').click();
  await page
    .locator('.contextMenu li')
    .filter({ hasText: /^自动放入：关$/ })
    .click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator('[data-mcui-drop]')).toHaveCount(0);
  await page.mouse.up();
  expect(
    await page.evaluate(
      ({ b }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[b].parent,
      ids,
    ),
  ).toBe(ids.root);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('mcui_preferences')!).autoPlace),
  ).toBe(false);
});

test('v0.5 原生新增 Cube 与 Group 包装，并且绘画只选择自身载体', async ({ page }) => {
  await start(page);
  const result = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    app.select([root]);
    window.BarItems.add_cube.trigger();
    const image = Object.values(app.state.doc.nodes).find((n: any) => n.kind === 'image') as any;
    if (!image) return { error: app.state.error };
    app.select([image.id]);
    window.BarItems.add_group.trigger();
    const child = app.state.doc.nodes[image.id].children[0];
    app.paint(image.id);
    return {
      error: app.state.error,
      image: image.kind,
      child: app.state.doc.nodes[child]?.kind,
      childOffset: app.state.doc.nodes[child]?.layout.offset,
      selected: (window as any).Outliner.selected.map((n: any) => n.uuid),
      surface: app.state.doc.bindings[image.id].surfaceId,
    };
  });
  expect(result.error).toBeNull();
  expect(result.image).toBe('image');
  expect(result.child).toBe('frame');
  expect(result.childOffset).toEqual({ x: 8, y: 8 });
  expect(result.selected).toEqual([result.surface]);
});

for (const cancel of ['Escape', 'blur', 'pointercancel', 'mode', 'project'] as const)
  test(`v0.5 拖动取消 ${cancel} 恢复初始数据与显示`, async ({ page }) => {
    await start(page);
    const ids = await scene(page),
      from = await point(page, 46, 71),
      to = await point(page, 175, 80);
    const before = await page.evaluate(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return {
        doc: JSON.stringify(app.state.doc),
        undo: window.Undo.history.length,
        project: window.Project.uuid,
      };
    });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    expect(await page.evaluate(() => !!window.Undo.current_save)).toBe(false);
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else
      await page.evaluate((cancel) => {
        if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
        if (cancel === 'pointercancel')
          window.Preview.selected.node.dispatchEvent(
            new PointerEvent('pointercancel', { bubbles: true }),
          );
        if (cancel === 'mode') window.Modes.options.paint.select();
        if (cancel === 'project') window.setupProject(window.Formats.free);
      }, cancel);
    await page.mouse.up();
    if (cancel === 'project')
      await page.evaluate(
        (id) => (window as any).ModelProject.all.find((p: any) => p.uuid === id).select(),
        before.project,
      );
    if (cancel === 'mode') await page.evaluate(() => window.Modes.options.edit.select());
    await page.waitForFunction(() => !!window.Blockbench.mcuiStudio.getStudio());
    expect(
      await page.evaluate(() => JSON.stringify(window.Blockbench.mcuiStudio.getStudio().state.doc)),
    ).toBe(before.doc);
    expect(await page.evaluate(() => window.Undo.history.length)).toBe(before.undo);
    expect(
      await page.evaluate(
        ({ b }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[b].parent,
        ids,
      ),
    ).toBe(ids.root);
  });

test('v0.5 多选拖入 Stack 显示插入线并保持次序，一次撤销', async ({ page }) => {
  await start(page);
  const ids = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0];
    const stack = app.add('frame', root),
      a = app.add('image', stack),
      b = app.add('image', stack),
      c = app.add('image', root),
      d = app.add('image', root);
    app.execute('准备 Stack', (doc: any) => {
      const s = doc.nodes[stack];
      s.name = 'Stack';
      s.layout.offset = { x: 140, y: 30 };
      s.layout.width = { kind: 'fixed', value: 130 };
      s.layout.height = { kind: 'fixed', value: 90 };
      s.frame.engineType = 'stack_panel';
      s.frame.direction = 'row';
      s.frame.gap = 10;
      s.frame.padding = [8, 8, 8, 8];
      for (const id of [a, b, c, d]) {
        doc.nodes[id].layout.width = { kind: 'fixed', value: 20 };
        doc.nodes[id].layout.height = { kind: 'fixed', value: 20 };
      }
      doc.nodes[c].layout.offset = { x: 30, y: 30 };
      doc.nodes[d].layout.offset = { x: 30, y: 70 };
    });
    app.select([c, d]);
    return { stack, a, b, c, d, root, undo: window.Undo.history.length };
  });
  const from = await point(page, 40, 40),
    to = await point(page, 173, 48);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator('[data-mcui-insertion]')).toHaveCount(1);
  await page.screenshot({ path: '.cache/mcui-v05-stack.png' });
  await page.mouse.up();
  expect(
    await page.evaluate(
      ({ stack }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[stack].children,
      ids,
    ),
  ).toEqual([ids.a, ids.c, ids.d, ids.b]);
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(ids.undo + 1);
  await page.evaluate(() => window.Undo.undo());
  await expect
    .poll(() =>
      page.evaluate(
        ({ stack }) => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes[stack].children,
        ids,
      ),
    )
    .toEqual([ids.a, ids.b]);
});

test('v0.5 嵌套 Image 原生复制/删除/撤销、载体保护与绘画返回', async ({ page }) => {
  await start(page);
  const ids = await scene(page);
  const result = await page.evaluate(({ a, b }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.reparent(b, a);
    app.select([a]);
    const group = (window as any).OutlinerNode.uuids[app.state.doc.bindings[a].containerId];
    (window as any).moveOutlinerSelectionTo(group, group.parent, 0, { event: { altKey: true } });
    const roots = app.state.doc.nodes[app.state.doc.roots[0]].children;
    const clone = roots.find((id: string) => id !== a),
      child = app.state.doc.nodes[clone]?.children[0];
    const unique = Object.values(app.state.doc.bindings)
      .filter((v: any) => v.textureId)
      .map((v: any) => v.textureId);
    app.select([clone]);
    app.deleteSelection();
    window.Undo.undo();
    return { clone, child, unique, count: window.Cube.all.length, error: app.state.error };
  }, ids);
  expect(result.error).toBeNull();
  expect(result.clone).toBeTruthy();
  expect(result.child).toBeTruthy();
  expect(new Set(result.unique).size).toBe(4);
  expect(result.count).toBe(4);
  await page.waitForFunction(({ clone, child }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return app.state.doc.nodes[clone]?.children.includes(child);
  }, result);
  await page.evaluate(({ a }) => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.paint(a);
  }, ids);
  await page.evaluate(() => window.Modes.options.edit.select());
  expect(
    await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().state.selection),
  ).toEqual([ids.a]);
  const protectedResult = await page.evaluate(({ b }) => {
    const app = window.Blockbench.mcuiStudio.getStudio(),
      surface = window.Cube.all.find((c: any) => c.uuid === app.state.doc.bindings[b].surfaceId);
    window.Undo.initEdit({ elements: [surface], uv_only: true });
    surface.faces.up.uv[2] = 8;
    window.Undo.finishEdit('Independent UV edit');
    app.update(b, (n: any) => {
      n.layout.width = { kind: 'fixed', value: 60 };
    });
    return { paused: app.state.doc.nodes[b].suspended, uv: surface.faces.up.uv[2] };
  }, ids);
  expect(protectedResult.paused).toContain('UV');
  expect(protectedResult.uv).toBe(8);
});

test('根 Frame 名称只呈现显式选区，拖动标签跟手且取消恢复，退出还原原生高亮', async ({ page }) => {
  await start(page);
  const ids = await scene(page);
  const label = page.locator(`[data-mcui-label="${ids.root}"]`);
  await label.click();
  const snapshot = () =>
    page.evaluate(() => {
      const a = window.Blockbench.mcuiStudio.getStudio();
      return {
        selection: a.state.selection,
        doc: JSON.stringify(a.state.doc),
        undo: window.Undo.history.length,
        outlines: window.Cube.all.filter((c: any) => c.mesh.outline.visible).length,
      };
    });
  const before = await snapshot();
  expect(before.selection).toEqual([ids.root]);
  expect(before.outlines).toBe(0);
  await expect(page.locator('#cubes_list .outliner_object.selected')).toHaveCount(1);
  const box = (await label.boundingBox())!;
  const border = (await page.locator('[data-mcui-selection]').boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 68, box.y + box.height / 2 + 35, { steps: 5 });
  const moving = (await label.boundingBox())!;
  const movedBorder = (await page.locator('[data-mcui-selection]').boundingBox())!;
  expect(moving.x - box.x).toBeGreaterThan(55);
  expect(moving.y - box.y).toBeGreaterThan(30);
  // Geometry snaps to UI pixels. The label must track the actual preview, not unsnapped input.
  expect(moving.x - box.x).toBeCloseTo(movedBorder.x - border.x, 1);
  expect(moving.y - box.y).toBeCloseTo(movedBorder.y - border.y, 1);
  expect((await snapshot()).doc).toBe(before.doc);
  expect((await snapshot()).undo).toBe(before.undo);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await label.boundingBox())!.x).toBeCloseTo(box.x, 1);
  expect((await snapshot()).doc).toBe(before.doc);
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 52, box.y + box.height / 2 + 22, { steps: 4 });
  const draft = (await label.boundingBox())!;
  await page.mouse.up();
  expect((await label.boundingBox())!.x).toBeCloseTo(draft.x, 1);
  expect((await snapshot()).undo).toBe(before.undo + 1);
  await page.evaluate(() => window.Undo.undo());
  await expect.poll(async () => (await label.boundingBox())!.x).toBeCloseTo(box.x, 1);
  expect((await snapshot()).doc).toBe(before.doc);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('native'));
  await expect.poll(async () => (await snapshot()).outlines).toBe(2);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getViewport().setInteraction('figma'));
  await expect.poll(async () => (await snapshot()).outlines).toBe(0);
  await page.keyboard.press('Enter');
  expect((await snapshot()).selection).toEqual([ids.a, ids.b]);
  await expect(page.locator('[data-mcui-selected-layer]')).toHaveCount(2);
  await expect(page.locator('#cubes_list .outliner_object.selected')).toHaveCount(2);
  await page.keyboard.press('Shift+Enter');
  await page.screenshot({ path: '.cache/mcui-frame-selection.png' });
  await page.evaluate(() => window.Plugins.registered.mcui_studio.onunload());
  expect(
    await page.evaluate(() => window.Cube.all.filter((c: any) => c.mesh.outline.visible).length),
  ).toBe(2);
});
