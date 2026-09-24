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
  return page.evaluate(() => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      root = a.state.doc.roots[0],
      frame = a.add('frame', root),
      image = a.add('image', frame);
    a.update(frame, (n: any) => {
      n.layout.offset = { x: 60, y: 40 };
      n.layout.width = { kind: 'fixed', value: 120 };
      n.layout.height = { kind: 'fixed', value: 80 };
    });
    a.update(image, (n: any) => {
      n.layout.offset = { x: 12, y: 15 };
      n.layout.width = { kind: 'fixed', value: 60 };
      n.layout.height = { kind: 'fixed', value: 24 };
      n.appearance = {
        fill: 'solid',
        color: '#dd7733ff',
        endColor: '#dd7733ff',
        angle: 0,
        strokeWidth: 0,
        strokeColor: '#ffffffff',
      };
    });
    a.select([image]);
    return { root, frame, image };
  });
}
async function point(page: Page, p: { x: number; y: number }) {
  return page.evaluate((p) => {
    const v = window.Preview.selected,
      r = v.canvas.getBoundingClientRect(),
      q = new (window as any).THREE.Vector3(p.x, 0, p.y).project(v.camera);
    return { x: r.x + ((q.x + 1) * r.width) / 2, y: r.y + ((1 - q.y) * r.height) / 2 };
  }, p);
}
async function geometry(page: Page, id: string) {
  return page.evaluate((id) => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      n = a.state.doc.nodes[id],
      r = a.state.scene.nodes[id],
      b = a.state.doc.bindings[id],
      c = (window as any).OutlinerNode.uuids[b.surfaceId],
      g = (window as any).OutlinerNode.uuids[b.containerId];
    const mid = new (window as any).THREE.Vector3().applyMatrix4(c.mesh.matrixWorld);
    return {
      node: n,
      resolved: r,
      center: { x: mid.x, y: mid.z },
      origin: g.origin,
      cubeOrigin: c.origin,
      rotation: g.rotation,
      png: window.Texture.all.find((t: any) => t.uuid === b.textureId).getDataURL(),
      undo: window.Undo.history.length,
      selected: a.state.selection,
      error: a.state.error,
    };
  }, id);
}

test('二维嵌套旋转与标准Group一致，中心枢轴、命中与旋转父级中的移动正确', async ({ page }) => {
  const ids = await start(page),
    before = await geometry(page, ids.image);
  await page.evaluate(({ frame, image }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(frame, (n: any) => (n.rotation = 90));
    a.update(image, (n: any) => (n.rotation = 30));
  }, ids);
  const after = await geometry(page, ids.image);
  const expected = after.resolved.corners.reduce(
    (a: any, p: any) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }),
    { x: 0, y: 0 },
  );
  expect(after.center.x).toBeCloseTo(expected.x, 5);
  expect(after.center.y).toBeCloseTo(expected.y, 5);
  expect(after.origin[0]).toBe(after.node.rect.x + after.node.rect.width / 2);
  expect(after.origin[2]).toBe(after.node.rect.y + after.node.rect.height / 2);
  expect(after.cubeOrigin).toEqual(after.origin);
  expect(after.png).toBe(before.png);
  expect(after.rotation).toEqual([0, 30, 0]);
  await page.evaluate(() => window.Blockbench.mcuiStudio.getStudio().select([]));
  const c = await point(page, expected);
  await page.mouse.click(c.x, c.y);
  expect((await geometry(page, ids.image)).selected).toEqual([ids.image]);
  await page.evaluate(() =>
    window.Blockbench.mcuiStudio.getViewport().setAutomaticPlacement(false),
  );
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 32, c.y + 21, { steps: 5 });
  await page.mouse.up();
  const moved = await geometry(page, ids.image);
  expect(moved.error).toBeNull();
  expect(moved.png).toBe(before.png);
  expect(moved.center.x).toBeGreaterThan(after.center.x + 8);
  expect(moved.center.y).toBeGreaterThan(after.center.y + 5);
  await page.evaluate(() => window.Undo.undo());
  const restored = await geometry(page, ids.image);
  expect(restored.center.x).toBeCloseTo(after.center.x, 5);
});

test('角点外侧旋转、Shift吸附、取消和面板角度，贴图不烘焙且一次Undo', async ({ page }) => {
  const ids = await start(page),
    before = await geometry(page, ids.image);
  const handle = page.locator('[data-mcui-rotate="ne"]');
  await expect(handle).toBeVisible();
  const initialCursor = await handle.evaluate((element) => getComputedStyle(element).cursor);
  const cursors = await page.locator('[data-mcui-rotate]').evaluateAll(async (elements) => {
    return Promise.all(
      elements.map(async (element) => {
        const cursor = getComputedStyle(element).cursor;
        const url = cursor.match(/url\("([^"]+)"\)/)![1]!;
        const image = new Image();
        image.src = url;
        await image.decode();
        return { cursor, width: image.naturalWidth, height: image.naturalHeight };
      }),
    );
  });
  expect(new Set(cursors.map((c) => c.cursor)).size).toBe(4);
  for (const cursor of cursors) {
    expect(cursor.width).toBe(24);
    expect(cursor.height).toBe(24);
    expect(cursor.cursor).toContain('12 12, crosshair');
  }
  const hb = (await handle.boundingBox())!,
    c = await point(page, before.center),
    p = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(c.x - (p.y - c.y), c.y + (p.x - c.x), { steps: 8 });
  const rotating = await geometry(page, ids.image);
  expect(Math.abs(rotating.node.rotation % 15)).toBeLessThan(0.001);
  expect(Math.abs(rotating.node.rotation)).toBeGreaterThan(30);
  expect(rotating.png).toBe(before.png);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const committed = await geometry(page, ids.image);
  expect(committed.undo).toBe(before.undo + 1);
  expect(committed.center.x).toBeCloseTo(before.center.x, 5);
  expect(committed.center.y).toBeCloseTo(before.center.y, 5);
  await page.evaluate(() => window.Undo.undo());
  expect((await geometry(page, ids.image)).node.rotation ?? 0).toBe(0);
  await page.locator('.panel_handle[panel_id=mcui_layout]').click();
  const input = page.getByRole('spinbutton', { name: '旋转角度', exact: true });
  await input.fill('45');
  await input.press('Enter');
  expect((await geometry(page, ids.image)).node.rotation).toBe(45);
  expect(await handle.evaluate((element) => getComputedStyle(element).cursor)).not.toBe(
    initialCursor,
  );
  await page.screenshot({ path: '.cache/mcui-rotation.png' });
  const r = (await handle.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 50, r.y + 60, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await geometry(page, ids.image)).node.rotation).toBe(45);
});

test('Ctrl滚轮大增量限制倍率，细小增量连续、指针锚点不漂移', async ({ page }) => {
  await start(page);
  await page.keyboard.down('Control');
  const result = await page.evaluate(() => {
    const p = window.Preview.selected,
      rect = p.canvas.getBoundingClientRect(),
      x = Math.round(rect.x + rect.width * 0.65),
      y = Math.round(rect.y + rect.height * 0.4);
    const world = () =>
      new (window as any).THREE.Vector3(
        ((x - rect.x) / rect.width) * 2 - 1,
        1 - ((y - rect.y) / rect.height) * 2,
        0,
      )
        .unproject(p.camera)
        .toArray();
    const start = p.camera.zoom,
      before = world();
    p.node.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        ctrlKey: true,
        deltaY: 100,
      }),
    );
    const notch = p.camera.zoom,
      after = world();
    p.node.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        ctrlKey: true,
        deltaY: -100,
      }),
    );
    const reverse = p.camera.zoom;
    p.node.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        ctrlKey: true,
        deltaY: 0.25,
      }),
    );
    return { start, notch, reverse, fine: p.camera.zoom, before, after };
  });
  await page.keyboard.up('Control');
  expect(result.notch / result.start).toBeGreaterThan(0.88);
  expect(result.notch / result.start).toBeLessThan(0.95);
  expect(result.reverse).toBeCloseTo(result.start, 8);
  expect(result.fine).toBeLessThan(result.reverse);
  expect(result.fine / result.reverse).toBeGreaterThan(0.999);
  expect(result.before[0]).toBeCloseTo(result.after[0], 7);
  expect(result.before[2]).toBeCloseTo(result.after[2], 7);
});

test('旋转后的角点缩放固定对角，原生大纲换父级保持可见位置和方向', async ({ page }) => {
  const ids = await start(page);
  const target = await page.evaluate(({ root, image, frame }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(frame, (n: any) => (n.rotation = 20));
    a.update(image, (n: any) => (n.rotation = 30));
    const target = a.add('frame', root);
    a.update(target, (n: any) => {
      n.layout.offset = { x: 220, y: 40 };
      n.layout.width = { kind: 'fixed', value: 70 };
      n.layout.height = { kind: 'fixed', value: 110 };
      n.rotation = -15;
    });
    a.select([image]);
    return target;
  }, ids);
  const before = await geometry(page, ids.image),
    nw = before.resolved.corners[0],
    se = before.resolved.corners[2];
  const corner = await point(page, se);
  const centerPoint = await point(page, before.center);
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(
    corner.x + (corner.x - centerPoint.x) * 0.5,
    corner.y + (corner.y - centerPoint.y) * 0.5,
    { steps: 8 },
  );
  await page.mouse.up();
  const resized = await geometry(page, ids.image);
  expect(resized.node.rect.width).toBeGreaterThan(before.node.rect.width);
  expect(resized.resolved.corners[0].x).toBeCloseTo(nw.x, 4);
  expect(resized.resolved.corners[0].y).toBeCloseTo(nw.y, 4);
  const rows = await page.evaluate(
    ({ image, target }) => {
      const a = window.Blockbench.mcuiStudio.getStudio();
      return {
        image: a.state.doc.bindings[image].containerId,
        target: a.state.doc.bindings[target].containerId,
      };
    },
    { image: ids.image, target },
  );
  const from = (await page.locator(`[id="${rows.image}"] > .outliner_object`).boundingBox())!,
    to = (await page.locator(`[id="${rows.target}"] > .outliner_object`).boundingBox())!;
  await page.mouse.move(from.x + 80, from.y + 14);
  await page.mouse.down();
  await page.mouse.move(from.x + 95, from.y + 14, { steps: 2 });
  await page.mouse.move(to.x + 80, to.y + 14, { steps: 10 });
  await page.mouse.up();
  const moved = await geometry(page, ids.image);
  expect(moved.node.parent).toBe(target);
  expect(moved.error).toBeNull();
  expect(moved.node.suspended).toBeUndefined();
  expect(moved.center.x).toBeCloseTo(resized.center.x, 4);
  expect(moved.center.y).toBeCloseTo(resized.center.y, 4);
  expect(moved.resolved.transform.angle).toBeCloseTo(resized.resolved.transform.angle, 4);
});

test('标准旋转载体无插件打开仍一致，保存后恢复规则，原生Y旋转回读', async ({ page, context }) => {
  const ids = await start(page);
  await page.evaluate(({ frame, image }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.update(frame, (n: any) => (n.rotation = 35));
    a.update(image, (n: any) => (n.rotation = -12));
  }, ids);
  const original = await geometry(page, ids.image);
  const model = await page.evaluate(() =>
    window.Codecs.project.compile({ raw: true, bitmaps: true }),
  );
  const bare = await context.newPage();
  await bare.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
  await bare.waitForFunction(() => window.Blockbench?.setup_successful);
  const result = await bare.evaluate((m) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(m);
    const c = window.Cube.all[0],
      v = new (window as any).THREE.Vector3().applyMatrix4(c.mesh.matrixWorld);
    return {
      center: { x: v.x, y: v.z },
      model: window.Codecs.project.compile({ raw: true, bitmaps: true }),
    };
  }, model);
  expect(result.center.x).toBeCloseTo(original.center.x, 5);
  expect(result.center.y).toBeCloseTo(original.center.y, 5);
  await bare.close();
  await page.evaluate((m) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(m);
  }, result.model);
  await page.waitForFunction((id) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    return a?.state.doc.nodes[id]?.rotation === -12 && !a.state.busy;
  }, ids.image);
  const reopened = await geometry(page, ids.image);
  expect(reopened.node.suspended).toBeUndefined();
  expect(reopened.png).toBe(original.png);
  await page.evaluate(({ image }) => {
    const a = window.Blockbench.mcuiStudio.getStudio(),
      g = (window as any).OutlinerNode.uuids[a.state.doc.bindings[image].containerId];
    window.Undo.initEdit({ groups: [g] });
    g.rotation[1] = 70;
    (window as any).Canvas.updateView({ groups: [g] });
    window.Undo.finishEdit('Native rotation');
  }, ids);
  expect((await geometry(page, ids.image)).node.rotation).toBe(70);
  expect((await geometry(page, ids.image)).node.suspended).toBeUndefined();
});

test('旋转Frame内的文字继续可编辑，原生复制/撤销保留独立纹理和角度', async ({ page }) => {
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
  const textId = await page.evaluate(async ({ frame }) => {
    const a = window.Blockbench.mcuiStudio.getStudio();
    a.select([frame]);
    const id = await (window as any).Blockbench.bbText.create();
    a.update(frame, (n: any) => (n.rotation = 35));
    return id;
  }, ids);
  await page.evaluate(async (id) => {
    const api = window.Blockbench.mcuiStudio.contents,
      data = api.inspect(id).data;
    await api.update(id, { ...data, text: 'Rotated text' });
  }, textId);
  expect((await geometry(page, textId)).node.suspended).toBeUndefined();
  await page.evaluate(({ frame }) => {
    window.Blockbench.mcuiStudio.getStudio().select([frame]);
    window.BarItems.duplicate.trigger();
  }, ids);
  const copied = await page.evaluate(
    ({ frame, textId }) => {
      const a = window.Blockbench.mcuiStudio.getStudio(),
        selected = a.state.selection[0],
        n = a.state.doc.nodes[selected];
      const text = Object.values(a.state.doc.nodes).find(
        (x: any) => x.parent === selected && x.content?.kind === 'generated',
      ) as any;
      return {
        selected,
        rotation: n.rotation,
        ownTexture:
          a.state.doc.bindings[text.id].textureId !== a.state.doc.bindings[textId].textureId,
        suspended: Object.values(a.state.doc.nodes).filter((n: any) => n.suspended).length,
        text: window.Blockbench.mcuiStudio.contents.inspect(text.id).data.text,
      };
    },
    { frame: ids.frame, textId },
  );
  expect(copied.selected).not.toBe(ids.frame);
  expect(copied.rotation).toBe(35);
  expect(copied.ownTexture).toBe(true);
  expect(copied.suspended).toBe(0);
  expect(copied.text).toBe('Rotated text');
  await page.evaluate(() => window.Undo.undo());
  expect((await geometry(page, textId)).node.suspended).toBeUndefined();
});

test('Mac 捏合与物理 Ctrl 滚轮分流，输入框松键和失焦恢复捏合曲线', async ({ page }) => {
  const ids = await start(page);
  await page.evaluate(() => {
    window.Blockbench.platform = 'darwin';
  });
  const before = await geometry(page, ids.image);
  const zoom = (deltaMode = 0) =>
    page.evaluate((deltaMode) => {
      const p = window.Preview.selected,
        r = p.canvas.getBoundingClientRect();
      const x = Math.round(r.x + r.width * 0.65),
        y = Math.round(r.y + r.height * 0.4);
      const world = () =>
        new (window as any).THREE.Vector3(
          ((x - r.x) / r.width) * 2 - 1,
          1 - ((y - r.y) / r.height) * 2,
          0,
        )
          .unproject(p.camera)
          .toArray();
      const old = p.camera.zoom,
        anchor = world();
      p.node.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          ctrlKey: true,
          deltaY: 5,
          deltaMode,
        }),
      );
      return { ratio: p.camera.zoom / old, anchor, after: world() };
    }, deltaMode);
  const pinch = await zoom();
  expect(pinch.ratio).toBeCloseTo(Math.exp(-0.05), 10);
  expect(pinch.anchor[0]).toBeCloseTo(pinch.after[0], 7);
  expect(pinch.anchor[2]).toBeCloseTo(pinch.after[2], 7);
  await page.keyboard.down('Control');
  expect((await zoom()).ratio).toBeCloseTo(Math.exp(-0.12 * Math.tanh(5 / 60)), 10);
  await page.evaluate(() => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    input.remove();
  });
  expect((await zoom()).ratio).toBeCloseTo(Math.exp(-0.05), 10);
  await page.keyboard.up('Control');
  await page.keyboard.down('Control');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect((await zoom()).ratio).toBeCloseTo(Math.exp(-0.05), 10);
  await page.keyboard.up('Control');
  // Line-mode input is a wheel even without an observed physical modifier key.
  expect((await zoom(1)).ratio).toBeCloseTo(Math.exp(-0.12 * Math.tanh(80 / 60)), 10);
  const after = await geometry(page, ids.image);
  expect(after.node).toEqual(before.node);
  expect(after.png).toEqual(before.png);
  expect(after.undo).toBe(before.undo);
});
