import { test, expect, type Page } from './host-test';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
const textPath = resolve(
  process.env.MCUI_TEXT_PLUGIN ?? '../blockbench-bbmodel-text/dist/bbmodel-text-component.js',
);
const hasText = await access(textPath).then(
  () => true,
  () => false,
);
async function start(page: Page, text = false, plugin = true) {
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  if (plugin) {
    await page.evaluate(() => {
      window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
    });
    await page.addScriptTag({ content: bundle });
  }
  if (text) {
    await page.evaluate(() => {
      window.Plugins.registered['bbmodel-text-component'] = new window.Blockbench.Plugin(
        'bbmodel-text-component',
      );
    });
    await page.addScriptTag({ content: await readFile(textPath, 'utf8') });
  }
  if (plugin) await page.evaluate(() => window.Blockbench.mcuiStudio.newProject());
  await page.evaluate(() => {
    (window as any).settings.create_rename.value = false;
  });
}
async function fixture(page: Page, text = false) {
  return page.evaluate(async (text) => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio(),
      root = a.state.doc.roots[0];
    const frame = a.add('frame', root),
      nested = a.add('frame', frame),
      paint = a.add('image', frame),
      parent = a.add('image', root),
      child = a.add('image', parent);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#29ba88';
    ctx.fillRect(0, 0, 64, 32);
    ctx.fillStyle = '#203050';
    ctx.fillRect(4, 4, 56, 24);
    await a.paste(
      { png: canvas.toDataURL(), width: 64, height: 32, name: '高清素材' },
      true,
      frame,
    );
    const image = a.state.selection[0];
    canvas.width = 8;
    canvas.height = 8;
    ctx.fillStyle = '#f5bf32';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#25465a';
    ctx.fillRect(2, 2, 4, 4);
    await a.paste({ png: canvas.toDataURL(), width: 8, height: 8, name: '九宫格' }, true, frame);
    const nine = a.state.selection[0];
    a.makeNine(nine);
    let label = null;
    if (text) {
      a.select([nested]);
      label = await w.Blockbench.bbText.create();
    }
    a.execute('Controlled grouping fixture', (d: any) => {
      const box = (id: string, x: number, y: number, width: number, height: number) => {
        const n = d.nodes[id];
        n.layout.offset = { x, y };
        n.layout.width = { kind: 'fixed', value: width };
        n.layout.height = { kind: 'fixed', value: height };
      };
      box(frame, 20, 20, 160, 110);
      box(nested, 10, 60, 110, 30);
      box(paint, 10, 10, 30, 20);
      box(image, 70, 10, 30, 20);
      box(nine, 100, 90, 30, 20);
      box(parent, 210, 25, 24, 24);
      box(child, 36, 0, 24, 24);
      if (label) box(label, 2, 2, 80, 20);
      d.nodes[image].layout.offsetPercent = { x: 0.25, y: 0 };
      d.nodes[image].layout.offset.x = 30;
      d.nodes[parent].appearance = {
        fill: 'solid',
        color: '#ef567aff',
        endColor: '#ef567aff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffffff',
      };
      d.nodes[child].appearance = {
        fill: 'solid',
        color: '#5692efff',
        endColor: '#5692efff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffffff',
      };
    });
    const texture = w.Texture.all.find(
      (t: any) => t.uuid === a.state.doc.bindings[paint].textureId,
    );
    texture.activateLayers(false);
    w.Undo.initEdit({ layers: [texture.layers[0]], bitmap: true });
    texture.layers[0].ctx.fillStyle = '#f04829';
    texture.layers[0].ctx.fillRect(0, 0, 30, 20);
    texture.updateChangesAfterEdit();
    w.Undo.finishEdit('Paint fixture');
    a.select([]);
    w.Blockbench.mcuiStudio.getViewport().automaticPlacement = false;
    // This regression checks exact pointer deltas; smart alignment is covered in snapping.spec.ts.
    w.Blockbench.mcuiStudio.getViewport().setSmartSnapping(false);
    w.Blockbench.mcuiStudio.getViewport().fit();
    await Promise.all(w.Texture.all.map((t: any) => t.img.decode()));
    return { root, frame, nested, paint, parent, child, image, nine, label };
  }, text);
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as any,
      a = w.Blockbench.mcuiStudio.getStudio(),
      d = a.state.doc;
    const images = Object.values(d.nodes)
      .filter((n: any) => n.kind === 'image')
      .map((n: any) => {
        const b = d.bindings[n.id],
          c = w.OutlinerNode.uuids[b.surfaceId],
          t = w.Texture.all.find((t: any) => t.uuid === b.textureId);
        return {
          id: n.id,
          rect: n.rect,
          parent: n.parent,
          container: b.containerId,
          surface: b.surfaceId,
          texture: b.textureId,
          containerParent: w.OutlinerNode.uuids[b.containerId]?.parent?.uuid,
          surfaceParent: c?.parent?.uuid,
          png: t?.getDataURL(),
          uv: c?.faces.up.uv,
          layers: t?.layers_enabled,
          text: c?.bb_text?.text,
          kind: n.content.kind,
          width: t?.width,
          height: t?.height,
        };
      });
    return {
      images,
      frames: Object.values(d.nodes).filter((n: any) => n.kind === 'frame').length,
      nodes: d.nodes,
      roots: d.roots,
      selection: a.state.selection,
      error: a.state.error,
      suspended: Object.values(d.nodes)
        .filter((n: any) => n.suspended)
        .map((n: any) => n.suspended),
      history: w.Undo.history.length,
    };
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
async function marquee(page: Page, from: number[], to: number[]) {
  const a = await point(page, from[0]!, from[1]!),
    b = await point(page, to[0]!, to[1]!);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}
async function undo(page: Page, redo = false) {
  await page.evaluate((redo) => {
    redo ? window.Undo.redo() : window.Undo.undo();
  }, redo);
  await page.waitForFunction(() => !window.Blockbench.mcuiStudio.getStudio().state.busy);
  await page.evaluate(async () => {
    await Promise.all(window.Texture.all.map((t: any) => t.img.decode()));
  });
}
function intact(before: any, after: any) {
  expect(after.error).toBeNull();
  expect(after.suspended).toEqual([]);
  expect(after.images.map((i: any) => i.id).sort()).toEqual(
    before.images.map((i: any) => i.id).sort(),
  );
  for (const old of before.images) {
    const n = after.images.find((i: any) => i.id === old.id);
    for (const field of [
      'container',
      'surface',
      'texture',
      'png',
      'uv',
      'layers',
      'text',
      'kind',
      'width',
      'height',
    ])
      expect(n[field], `${old.id}.${field}`).toEqual(old[field]);
    expect(n.surfaceParent).toBe(n.container);
  }
}

for (const withText of [false, true])
  test(`真实框选→全部解组→原生编组→拖动→解除/撤销，保留资源 (${withText ? '双插件' : 'UI'})`, async ({
    page,
    context,
  }) => {
    test.skip(withText && !hasText, 'Build the companion text plugin');
    await start(page, withText);
    const ids = await fixture(page, withText);
    const before = await snapshot(page);
    await mkdir('.cache/regroup', { recursive: true });
    await writeFile(
      `.cache/regroup/input-${withText ? 'text' : 'ui'}.bbmodel`,
      JSON.stringify(
        await page.evaluate(() => window.Codecs.project.compile({ raw: true, bitmaps: true })),
      ),
    );
    await page.screenshot({ path: `.cache/regroup/input-${withText ? 'text' : 'ui'}.png` });
    await marquee(page, [-8, -8], [328, 188]);
    expect((await snapshot(page)).selection).toEqual([ids.root]);
    await page.evaluate(() => {
      (window as any).BarItems.mcui_ungroup_all.trigger();
    });
    const flat = await snapshot(page);
    intact(before, flat);
    expect(flat.frames).toBe(0);
    for (const old of before.images) expect(flat.nodes[old.id].rect).toEqual(old.rect);
    await marquee(page, [25, 25], [130, 60]);
    expect((await snapshot(page)).selection.sort()).toEqual([ids.paint, ids.image].sort());
    const pre = await snapshot(page);
    await page.evaluate(() => {
      (window as any).BarItems.add_group.trigger();
    });
    const grouped = await snapshot(page);
    const group = grouped.selection[0];
    expect(grouped.selection).toHaveLength(1);
    expect(grouped.nodes[group].kind).toBe('frame');
    expect(grouped.nodes[group].children).toEqual([ids.paint, ids.image]);
    expect(grouped.history).toBe(pre.history + 1);
    intact(flat, grouped);
    expect(grouped.nodes[ids.image].layout.offsetPercent).toBeUndefined();
    const from = await point(page, 55, 50),
      to = await point(page, 72, 59);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    const moved = await snapshot(page);
    intact(grouped, moved);
    for (const id of [ids.paint, ids.image]) {
      expect(moved.nodes[id].rect.x).toBe(grouped.nodes[id].rect.x + 17);
      expect(moved.nodes[id].rect.y).toBe(grouped.nodes[id].rect.y + 9);
    }
    expect(moved.history).toBe(grouped.history + 1);
    await page.keyboard.press('ControlOrMeta+Shift+g');
    const dissolved = await snapshot(page);
    intact(moved, dissolved);
    expect(dissolved.frames).toBe(0);
    expect(dissolved.history).toBe(moved.history + 1);
    await undo(page);
    const reverted = await snapshot(page);
    intact(moved, reverted);
    expect(reverted.selection).toEqual([group]);
    expect(reverted.nodes[group].children).toEqual([ids.paint, ids.image]);
    await undo(page, true);
    intact(dissolved, await snapshot(page));
    await page.keyboard.press('ControlOrMeta+g');
    const regrouped = await snapshot(page);
    expect(regrouped.frames).toBe(1);
    intact(dissolved, regrouped);
    const model = await page.evaluate(() =>
      window.Codecs.project.compile({ raw: true, bitmaps: true }),
    );
    await mkdir('.cache/regroup', { recursive: true });
    await writeFile(
      `.cache/regroup/fixture-${withText ? 'text' : 'ui'}.bbmodel`,
      JSON.stringify(model),
    );
    await page.screenshot({ path: `.cache/regroup/fixture-${withText ? 'text' : 'ui'}.png` });
    const bare = await context.newPage();
    await start(bare, false, false);
    const raw = await bare.evaluate((model) => {
      window.setupProject(window.Formats.free);
      window.Codecs.project.parse(model);
      return {
        cubes: window.Cube.all.length,
        textures: window.Texture.all.length,
        missing: window.Cube.all.filter((c: any) => !c.faces.up.getTexture()).length,
      };
    }, model);
    expect(raw).toEqual({
      cubes: before.images.length,
      textures: before.images.length,
      missing: 0,
    });
    await bare.close();
    const reopened = await context.newPage();
    await start(reopened, withText);
    await reopened.evaluate((m) => {
      window.Project.saved = true;
      (window as any).newProject(window.Formats.free);
      window.Codecs.project.parse(m);
    }, model);
    await reopened.waitForFunction(
      () =>
        !!window.Blockbench.mcuiStudio.getStudio() &&
        !window.Blockbench.mcuiStudio.getStudio().state.busy,
    );
    intact(regrouped, await snapshot(reopened));
    await reopened.close();
  });

test('绕过菜单直接解开原生所有Group也不删除存活的内容Cube和贴图', async ({ page }) => {
  test.skip(!hasText, 'Build the companion text plugin');
  await start(page, true);
  await fixture(page, true);
  const before = await snapshot(page);
  await page.evaluate(() => {
    const w = window as any;
    w.Undo.initEdit({
      elements: [...w.Cube.all],
      groups: [...w.Group.all],
      textures: [...w.Texture.all],
      bitmap: true,
      outliner: true,
      selection: true,
    });
    for (const g of [...w.Group.all].reverse()) if (w.Group.all.includes(g)) g.resolve(false);
    w.Undo.finishEdit('Direct native dissolve');
  });
  const after = await snapshot(page);
  expect(after.images).toHaveLength(before.images.length);
  expect(after.frames).toBe(0);
  expect(after.suspended).toEqual([]);
  expect(after.error).toBeNull();
  for (const old of before.images) {
    const n = after.images.find((n: any) => n.id === old.id)!;
    expect(n.surface).toBe(old.surface);
    expect(n.texture).toBe(old.texture);
    expect(n.png).toBe(old.png);
    expect(n.text).toBe(old.text);
  }
  await undo(page);
  intact(before, await snapshot(page));
});

test('叶子Image解除编组是无操作；普通项目和卸载恢复原生命令', async ({ page }) => {
  await start(page);
  const ids = await fixture(page);
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().select([id]), ids.image);
  const before = await snapshot(page);
  await page.evaluate(() => {
    (window as any).BarItems.resolve_group.trigger();
  });
  const after = await snapshot(page);
  intact(before, after);
  expect(after.history).toBe(before.history);
  await page.evaluate(() => {
    window.Project.saved = true;
    window.setupProject(window.Formats.free);
    (window as any).BarItems.add_group.trigger();
  });
  expect(await page.evaluate(() => (window as any).Group.all.length)).toBe(1);
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio.unload();
    (window as any).BarItems.add_group.trigger();
  });
  expect(await page.evaluate(() => (window as any).Group.all.length)).toBe(2);
});

test('工具菜单可执行全部解组，单层与Frame快捷键仍可发现', async ({ page }) => {
  await start(page);
  const ids = await fixture(page);
  await page.evaluate((id) => window.Blockbench.mcuiStudio.getStudio().select([id]), ids.root);
  const before = await snapshot(page);
  await page
    .locator('.menu_bar_point')
    .filter({ hasText: /^(Tools|工具)$/ })
    .click();
  await page.locator('.contextMenu:visible [menu_item=mcui_ungroup_all]').click();
  const flat = await snapshot(page);
  expect(flat.frames).toBe(0);
  intact(before, flat);
  await page.evaluate(
    (ids) => window.Blockbench.mcuiStudio.getStudio().select(ids),
    [ids.paint, ids.image],
  );
  await page.keyboard.press('ControlOrMeta+Alt+g');
  const frame = await snapshot(page);
  expect(frame.frames).toBe(1);
  expect(frame.selection).toHaveLength(1);
  intact(flat, frame);
});
