import { test, expect } from '@playwright/test';
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
