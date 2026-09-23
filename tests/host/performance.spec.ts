import { test, expect } from './host-test';
import { readFile } from 'node:fs/promises';
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
test('复杂文档的普通位置编辑不因原生属性快照而停顿，Undo/Redo 保持位置', async ({ page }) => {
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
  });
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    await window.Blockbench.mcuiStudio.newProject();
    const app = window.Blockbench.mcuiStudio.getStudio(),
      root = app.state.doc.roots[0],
      first = app.add('image', root);
    app.execute('Complex fixture', (doc: any) => {
      for (let i = 0; i < 280; i++) {
        const node = JSON.parse(JSON.stringify(doc.nodes[i < 175 ? first : root]));
        node.id = 'load-' + i;
        node.parent = root;
        node.children = [];
        node.name = node.id;
        node.layout.offset = { x: (i % 20) * 32, y: Math.floor(i / 20) * 32 };
        doc.nodes[node.id] = node;
        doc.nodes[root].children.push(node.id);
      }
    });
    const initial = app.state.doc.nodes[first].rect.x,
      times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      app.update(first, (n: any) => {
        n.layout.offset.x += 1;
      });
      times.push(performance.now() - start);
    }
    const moved = app.state.doc.nodes[first].rect.x;
    window.Undo.undo();
    await new Promise((r) => setTimeout(r, 100));
    const undone = app.state.doc.nodes[first].rect.x;
    window.Undo.redo();
    await new Promise((r) => setTimeout(r, 100));
    return {
      times,
      initial,
      moved,
      undone,
      redone: app.state.doc.nodes[first].rect.x,
      nodes: Object.keys(app.state.doc.nodes).length,
      error: app.state.error,
    };
  });
  expect(result.nodes).toBe(282);
  expect(result.error).toBeNull();
  expect(result.moved).toBe(result.initial + 3);
  expect(result.undone).toBe(result.initial + 2);
  expect(result.redone).toBe(result.moved);
  // Coarse stall guard; detailed before/after profiles are recorded separately on the same machine.
  expect(result.times.sort((a, b) => a - b)[1]).toBeLessThan(750);
});

test('选区走轻量查询；投影缓存随相机、节点和标签变化失效', async ({ page }) => {
  await page.route(/https:\/\/(cdn.jsdelivr.net|blckbn.ch).*plugins.*json/, (r) =>
    r.fulfill({ json: {} }),
  );
  await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
  await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
  await page.evaluate(() => {
    window.Plugins.registered.mcui_studio = new window.Blockbench.Plugin('mcui_studio');
  });
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    const w = window as any;
    await w.Blockbench.mcuiStudio.newProject();
    const app = w.Blockbench.mcuiStudio.getStudio(),
      host = w.Blockbench.mcuiStudio.getHost(),
      vp = w.Blockbench.mcuiStudio.getViewport();
    const root = app.state.doc.roots[0],
      a = app.add('image', root),
      child = app.add('image', a),
      b = app.add('image', root);
    app.update(b, (n: any) => (n.layout.offset.x = 100));
    const full = host.scene.bind(host);
    let scans = 0;
    host.scene = (...args: any[]) => {
      scans++;
      return full(...args);
    };
    app.select([a]);
    const selected = [...app.state.selection],
      actual = host.selection(app.state.doc),
      snap = full(app.state.doc).selection;
    const selectionScans = scans;
    const preview = w.Preview.selected;
    vp.pickNodes(preview);
    let rectReads = 0;
    const read = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      rectReads++;
      return read.call(this);
    };
    const before = vp.pickNodes(preview).find((n: any) => n.id === a).rect;
    for (let i = 0; i < 20; i++) vp.draw();
    Element.prototype.getBoundingClientRect = read;
    preview.camOrtho.zoom *= 2;
    preview.camOrtho.updateProjectionMatrix();
    const zoomed = vp.pickNodes(preview).find((n: any) => n.id === a).rect;
    app.update(a, (n: any) => (n.layout.offset.x += 10));
    const moved = vp.pickNodes(preview).find((n: any) => n.id === a).rect;
    app.update(root, (n: any) => (n.name = 'Renamed frame'));
    vp.draw();
    const renamed = !!document.querySelector('[data-mcui-label]')?.textContent?.includes('Renamed');
    app.select([child]);
    const nested = host.selection(app.state.doc);
    return {
      selected,
      actual,
      snap,
      a,
      child,
      nested,
      selectionScans,
      rectReads,
      before,
      zoomed,
      moved,
      renamed,
      error: app.state.error,
    };
  });
  expect(result.selected).toEqual([result.a]);
  expect(result.actual).toEqual(result.snap);
  expect(result.selectionScans).toBe(0);
  expect(result.nested).toEqual([result.child]);
  expect(result.rectReads).toBeLessThan(300);
  expect(result.zoomed.width).toBeCloseTo(result.before.width * 2, 1);
  expect(result.moved.x).not.toBe(result.zoomed.x);
  expect(result.renamed).toBe(true);
  expect(result.error).toBeNull();
});
