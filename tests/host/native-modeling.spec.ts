import { test, expect, type Page } from './host-test';
import { readFile } from 'node:fs/promises';

const uiBundle = await readFile('dist/mcui_studio.js', 'utf8');
const textBundle = await readFile(
  process.env.MCUI_TEXT_PLUGIN ?? '../blockbench-bbmodel-text/dist/bbmodel-text-component.js',
  'utf8',
).catch(() => null);
async function start(page: Page, plugins: string[], format = 'free') {
  test.skip(
    plugins.includes('bbmodel-text-component') && !textBundle,
    'Build the optional companion text plugin',
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.Blockbench?.setup_successful);
  for (const id of plugins) {
    await page.evaluate((id) => {
      window.Plugins.registered[id] = new window.Blockbench.Plugin(id);
    }, id);
    await page.addScriptTag({ content: id === 'mcui_studio' ? uiBundle : textBundle! });
  }
  await page.evaluate(async (format) => {
    const w = window as any;
    w.settings.create_rename.value = false;
    w.setupProject(w.Formats[format]);
    const root = new w.Group({ name: 'body' }).init();
    const child = new w.Group({ name: 'arm' }).addTo(root).init();
    new w.Cube({ name: 'body_cube', from: [0, 0, 0], to: [8, 10, 4] }).addTo(root).init();
    new w.Cube({ name: 'arm_cube', from: [8, 0, 0], to: [12, 8, 4] }).addTo(child).init();
    new w.Cube({ name: 'finger', from: [9, 8, 1], to: [11, 10, 3] }).addTo(child).init();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#397dbc';
    ctx.fillRect(0, 0, 16, 16);
    const texture = new w.Texture({ name: 'ordinary.png', internal: true })
      .fromDataURL(canvas.toDataURL())
      .add(false);
    await texture.img.decode();
    for (const cube of w.Cube.all) {
      cube.box_uv = false;
      for (const face of Object.values(cube.faces) as any[]) face.texture = texture.uuid;
    }
    w.Canvas.updateAll();
  }, format);
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    const tree = (nodes: any[]): any[] =>
      nodes.map((n) => ({
        id: n.uuid,
        name: n.name,
        parent: n.parent?.uuid ?? 'root',
        ...(n.children ? { children: tree(n.children) } : {}),
      }));
    return {
      tree: tree(w.Outliner.root),
      groups: w.Group.all
        .map((g: any) => ({ id: g.uuid, origin: g.origin, rotation: g.rotation }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
      textures: w.Texture.all
        .map((t: any) => ({ id: t.uuid, png: t.getDataURL(), width: t.width, height: t.height }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
      elements: w.Project.elements
        .map((c: any) => ({
          id: c.uuid,
          name: c.name,
          parent: c.parent?.uuid ?? 'root',
          from: c.from,
          to: c.to,
          origin: c.origin,
          // JSON roundtrips canonicalize native -0 angles to 0.
          rotation: c.rotation?.map((v: number) => (v === 0 ? 0 : v)),
          vertices: c.vertices,
          text: c.bb_text ?? null,
          faces: Object.fromEntries(
            Object.entries(c.faces ?? {}).map(([k, f]: [string, any]) => [
              k,
              { uv: f.uv, texture: f.texture, rotation: f.rotation },
            ]),
          ),
        }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
    };
  });
}
for (const plugins of [
  [],
  ['mcui_studio'],
  ['bbmodel-text-component'],
  ['mcui_studio', 'bbmodel-text-component'],
]) {
  test(`普通模型只移动一个Cube，撤销/重做保持全部组与兄弟元素：${plugins.join('+') || '原版'}`, async ({
    page,
  }) => {
    await start(page, plugins);
    const before = await snapshot(page);
    await page.evaluate(() => {
      const w = window as any,
        cube = w.Cube.all.find((c: any) => c.name === 'arm_cube');
      w.Undo.initEdit({ elements: [cube] });
      cube.moveVector([1, 0, 0]);
      w.Undo.finishEdit('Move one cube');
    });
    const after = await snapshot(page);
    await page.evaluate(() => window.Undo.undo());
    expect(await snapshot(page)).toEqual(before);
    await page.evaluate(() => window.Undo.redo());
    expect(await snapshot(page)).toEqual(after);
  });
}

async function historyRoundtrip(page: Page, action: () => Promise<unknown>) {
  const before = await snapshot(page);
  const history = await page.evaluate(() => window.Undo.history.length);
  await action();
  const after = await snapshot(page);
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(history + 1);
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.Undo.undo());
    expect(await snapshot(page)).toEqual(before);
    await page.evaluate(() => window.Undo.redo());
    expect(await snapshot(page)).toEqual(after);
  }
}
for (const format of ['free', 'bedrock', 'java_block']) {
  test(`普通 ${format} 完整建模链：新增、编解组、复制、换父级、变换、UV、绘画、删除和历史`, async ({
    page,
    context,
  }) => {
    await start(page, ['mcui_studio', 'bbmodel-text-component'], format);
    const original = await snapshot(page);
    // Visit a UI document and return: native commands must not retain the UI owner.
    await page.evaluate(async () => {
      const w = window as any,
        ordinary = w.Project;
      await w.Blockbench.mcuiStudio.newProject();
      w.Blockbench.mcuiStudio.getStudio().add('image');
      ordinary.select();
    });
    expect(await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio())).toBeNull();
    expect(await snapshot(page)).toEqual(original);
    for (const operation of [
      'create',
      'group',
      'ungroup',
      'duplicate',
      'reparent',
      'rotate',
      'resize',
      'uv',
      'paint',
      'rename',
      'delete',
    ]) {
      await test.step(operation, async () =>
        historyRoundtrip(page, () =>
          page.evaluate((op) => {
            const w = window as any;
            const cube = w.Cube.all.find((c: any) => c.name === 'arm_cube');
            const group = w.Group.all.find((g: any) => g.name === 'arm');
            w.unselectAllElements();
            w.Prop.active_panel = 'outliner';
            if (op === 'create') {
              group.select();
              w.BarItems.add_cube.trigger();
            }
            if (op === 'group') {
              cube.markAsSelected();
              w.Cube.all.find((c: any) => c.name === 'finger').markAsSelected();
              w.updateSelection();
              w.BarItems.group_elements.trigger();
              w.__nativeGroup = w.Group.first_selected.uuid;
            }
            if (op === 'ungroup') {
              w.OutlinerNode.uuids[w.__nativeGroup].select();
              w.BarItems.resolve_group.trigger();
            }
            if (op === 'duplicate') {
              group.select();
              w.SharedActions.run('duplicate');
              w.__nativeCopy = w.Group.first_selected.uuid;
            }
            if (op === 'reparent') {
              w.Undo.initEdit({ outliner: true });
              w.Cube.all
                .find((c: any) => c.name === 'finger')
                .addTo(w.Group.all.find((g: any) => g.name === 'body'));
              w.Undo.finishEdit('Reparent native cube');
            }
            if (['rotate', 'resize', 'uv'].includes(op)) {
              w.Undo.initEdit({ elements: [cube] });
              if (op === 'rotate') cube.rotation[1] = 22.5;
              if (op === 'resize') cube.to[0] += 2;
              if (op === 'uv') cube.faces.north.uv[0] += 1;
              cube.preview_controller.updateAll(cube);
              w.Undo.finishEdit(op);
            }
            if (op === 'paint') {
              const t = w.Texture.all[0];
              w.Undo.initEdit({ textures: [t], bitmap: true });
              t.ctx.fillStyle = '#ff7700';
              t.ctx.fillRect(1, 1, 2, 2);
              t.updateChangesAfterEdit();
              w.Undo.finishEdit('Native paint');
            }
            if (op === 'rename') {
              w.Undo.initEdit({ groups: [group] });
              group.name = 'renamed_arm';
              w.Undo.finishEdit('Rename group');
            }
            if (op === 'delete') {
              w.OutlinerNode.uuids[w.__nativeCopy].select();
              w.SharedActions.run('delete');
            }
          }, operation),
        ),
      );
    }
    // Walk the complete history, not only the last edit.
    const final = await snapshot(page);
    const count = await page.evaluate(() => window.Undo.history.length);
    for (let i = 0; i < count; i++) await page.evaluate(() => window.Undo.undo());
    expect(await snapshot(page)).toEqual(original);
    for (let i = 0; i < count; i++) await page.evaluate(() => window.Undo.redo());
    expect(await snapshot(page)).toEqual(final);
    const model = await page.evaluate(() =>
      window.Codecs.project.compile({ raw: true, bitmaps: true }),
    );
    expect(model.unhandled_root_fields?.mcui_studio).toBeUndefined();
    expect(model.unhandled_root_fields?.bb_text).toBeUndefined();
    const bare = await context.newPage();
    await start(bare, [], format);
    await bare.evaluate(async (model) => {
      window.setupProject(window.Formats[model.meta.model_format]);
      window.Codecs.project.parse(model);
      await Promise.all(window.Texture.all.map((t: any) => t.img.decode()));
    }, model);
    const reopened = await snapshot(bare);
    await test.info().attach('native-roundtrip', {
      body: JSON.stringify({ final, reopened }),
      contentType: 'application/json',
    });
    expect(reopened).toEqual(final);
    await bare.close();
    await page.evaluate(() => {
      window.Plugins.registered.mcui_studio.unload();
      window.Plugins.registered['bbmodel-text-component'].unload();
    });
    await historyRoundtrip(page, () =>
      page.evaluate(() => {
        const w = window as any,
          c = w.Cube.all[0];
        w.Undo.initEdit({ elements: [c] });
        c.moveVector([0, 1, 0]);
        w.Undo.finishEdit('After unload');
      }),
    );
  });
}
test('普通 Mesh 顶点编辑及取消保留组结构和 Cube，逆序加载双插件', async ({ page }) => {
  await start(page, ['bbmodel-text-component', 'mcui_studio']);
  await page.evaluate(() => {
    const w = window as any,
      mesh = new w.Mesh({ name: 'quad' }).addTo(w.Group.all[1]).init();
    const vertices = mesh.addVertices([0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]);
    mesh.addFaces(new w.MeshFace(mesh, { vertices }));
    mesh.preview_controller.updateAll(mesh);
  });
  const before = await snapshot(page);
  await page.evaluate(() => {
    const w = window as any,
      c = w.Cube.all[0];
    w.Undo.initEdit({ elements: [c] });
    c.moveVector([5, 0, 0]);
    w.Undo.cancelEdit(true);
  });
  expect(await snapshot(page)).toEqual(before);
  expect(await page.evaluate(() => window.Undo.history.length)).toBe(0);
  await historyRoundtrip(page, () =>
    page.evaluate(() => {
      const w = window as any,
        mesh = w.Mesh.all[0];
      w.Undo.initEdit({ elements: [mesh] });
      Object.values(mesh.vertices).forEach((v: any) => (v[2] += 3));
      mesh.preview_controller.updateAll(mesh);
      w.Undo.finishEdit('Move mesh vertices');
    }),
  );
});
