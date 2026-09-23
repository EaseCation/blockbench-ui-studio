import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const options = {};
const flags = process.argv.slice(2);
if (flags.includes('--help')) {
  console.log(
    'node scripts/benchmark-host.mjs --model design.bbmodel [--ui dist/mcui_studio.js] [--text ../blockbench-bbmodel-text/dist/bbmodel-text-component.js] [--url http://127.0.0.1:4178] [--out .cache/benchmark.json]',
  );
  process.exit(0);
}
for (let i = 0; i < flags.length; i += 2) {
  if (!['--model', '--ui', '--text', '--url', '--out'].includes(flags[i]) || !flags[i + 1])
    throw new Error('Unknown or incomplete argument: ' + flags[i]);
  options[flags[i].slice(2)] = flags[i + 1];
}
if (!options.model)
  throw new Error(
    '--model is required; use a UI Studio model with Image and editable text layers.',
  );
const endpoint = new URL(options.url ?? 'http://127.0.0.1:4178');
const address = endpoint.origin;
if (
  endpoint.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
)
  throw new Error('Use an isolated loopback test host');
const output = resolve(options.out ?? `.cache/benchmark-${Date.now()}.json`);
if (
  await access(output).then(
    () => true,
    () => false,
  )
)
  throw new Error('Output exists: ' + output);
await mkdir(dirname(output), { recursive: true });
const model = JSON.parse(await readFile(resolve(options.model), 'utf8'));
if (model.unhandled_root_fields?.mcui_studio?.schemaVersion !== 1)
  throw new Error('Expected UI Studio model');
const ui = await readFile(resolve(options.ui ?? 'dist/mcui_studio.js'), 'utf8');
const text = await readFile(
  resolve(options.text ?? '../blockbench-bbmodel-text/dist/bbmodel-text-component.js'),
  'utf8',
);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const result = {};
try {
  for (const scale of [1, 4]) {
    const c = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await c.route('**/*', (r) =>
      r
        .request()
        .url()
        .startsWith(address + '/') || /^(data|blob):/.test(r.request().url())
        ? r.continue()
        : r.abort(),
    );
    const p = await c.newPage();
    await p.goto(address);
    await p.waitForFunction(() => window.Blockbench?.setup_successful);
    for (const [id, b] of [
      ['mcui_studio', ui],
      ['bbmodel-text-component', text],
    ]) {
      await p.evaluate(
        (id) => (window.Plugins.registered[id] = new window.Blockbench.Plugin(id)),
        id,
      );
      await p.addScriptTag({ content: b });
    }
    await p.evaluate((m) => {
      window.setupProject(window.Formats.free);
      window.Codecs.project.parse(m);
    }, model);
    await p.waitForFunction(
      () =>
        window.Blockbench.mcuiStudio.getStudio() &&
        !window.Blockbench.mcuiStudio.getStudio().state.busy,
    );
    await p.evaluate((scale) => {
      const a = window.Blockbench.mcuiStudio.getStudio();
      if (scale > 1)
        a.execute('Scale fixture', (d) => {
          const originals = Object.values(d.nodes),
            roots = [...d.roots];
          for (let k = 1; k < scale; k++) {
            const ids = new Map(originals.map((n) => [n.id, crypto.randomUUID()]));
            for (const n of originals) {
              const c = JSON.parse(JSON.stringify(n));
              c.id = ids.get(n.id);
              c.parent = n.parent ? ids.get(n.parent) : null;
              c.children = n.children.map((id) => ids.get(id));
              if (!n.parent) c.layout.offset.x += k * 850;
              d.nodes[c.id] = c;
            }
            d.roots.push(...roots.map((id) => ids.get(id)));
          }
        });
      if (a.state.error) throw new Error(a.state.error);
    }, scale);
    const cdp = await c.newCDPSession(p);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    result[scale] = await p.evaluate(async () => {
      const a = window.Blockbench.mcuiStudio.getStudio(),
        h = window.Blockbench.mcuiStudio.getHost(),
        v = window.Blockbench.mcuiStudio.getViewport(),
        api = window.Blockbench.mcuiStudio.contents;
      const image = Object.values(a.state.doc.nodes).find(
          (n) => n.content && n.content.kind !== 'generated',
        )?.id,
        texts = Object.values(a.state.doc.nodes)
          .filter((n) => n.content?.kind === 'generated')
          .map((n) => n.id);
      if (!image || !texts.length)
        throw new Error('Benchmark needs both ordinary Image and editable text layers');
      let current = {};
      const metrics = {};
      const wrap = (o, k, name = k) => {
        const f = o[k];
        if (typeof f !== 'function') return;
        o[k] = function (...args) {
          const t = performance.now();
          try {
            return f.apply(this, args);
          } finally {
            const m = (current[name] ??= { calls: 0, ms: 0 });
            m.calls++;
            m.ms += performance.now() - t;
          }
        };
      };
      for (const k of ['calculate', 'publish', 'captureNative', 'emit', 'resolveLayout'])
        wrap(a, k, 'app.' + k);
      for (const k of [
        'begin',
        'commit',
        'apply',
        'write',
        'scene',
        'element',
        'texture',
        'snapshots',
      ])
        wrap(h, k, 'host.' + k);
      for (const k of ['draw', 'pickNodes', 'screen']) wrap(v, k, 'viewport.' + k);
      wrap(CanvasRenderingContext2D.prototype, 'measureText', 'canvas.measureText');
      wrap(Element.prototype, 'getBoundingClientRect', 'dom.rect');
      wrap(window.Canvas, 'updateView', 'native.view');
      wrap(window.Canvas, 'updateAllBones', 'native.bones');
      wrap(window.Storage.prototype, 'getItem', 'storage.get');
      const wait = () => new Promise((r) => setTimeout(r, 40));
      const run = async (name, fn, n = 4) => {
        const rows = [];
        for (let i = 0; i < n; i++) {
          current = {};
          const t = performance.now();
          await fn(i);
          rows.push({ ms: performance.now() - t, stages: structuredClone(current) });
          current = {};
          await wait();
        }
        metrics[name] = rows;
      };
      await run('select', (i) => a.select([texts[i % texts.length]]));
      await run('move', () => a.update(image, (n) => n.layout.offset.x++));
      await run('text_edit', (i) =>
        api.update(texts[0], { ...api.inspect(texts[0]).data, text: '性能测试 ' + i }),
      );
      await run(
        'undo',
        async () => {
          window.Undo.undo();
          while (a.state.busy) await wait();
        },
        2,
      );
      await run(
        'redo',
        async () => {
          window.Undo.redo();
          while (a.state.busy) await wait();
        },
        2,
      );
      a.select([image]);
      a.beginGesture('Preview', true);
      await run(
        'drag_preview',
        (i) => {
          a.previewMove(i + 1, i);
          v.draw();
        },
        12,
      );
      a.endGesture(false);
      await run('idle_overlay', () => v.draw(), 12);
      a.execute('Hug text fixture', (d) => {
        for (const id of texts) {
          const n = d.nodes[id];
          n.layout.height = { kind: 'hug' };
          n.layout.width = { kind: 'fixed', value: 96 };
          n.content.data.text = '自动布局与中文文字测量 Performance benchmark '.repeat(5);
        }
      });
      await run('hug_move', () => a.update(image, (n) => n.layout.offset.x++));
      const font = window.Project.unhandled_root_fields.bb_text.fonts.find(
        (f) => f.id === 'font_default_minecraft',
      );
      const fonts = Array.from({ length: 32 }, (_, i) => ({
        ...font,
        id: 'library-' + i,
        name: 'Library ' + i,
        hash: 'library-' + i,
      }));
      const library = JSON.stringify(fonts);
      window.localStorage.setItem('bbmodel_text_component.fonts', library);
      await run('library_move', () => a.update(image, (n) => n.layout.offset.x++));
      const before = window.Undo.history.length;
      a.select([image]);
      a.beginGesture('Resize preview');
      await run(
        'resize_preview',
        (i) =>
          a.previewGesture((d) => {
            d.nodes[image].layout.width = { kind: 'fixed', value: 40 + i };
          }),
        6,
      );
      a.endGesture(false);
      return {
        nodes: Object.keys(a.state.doc.nodes).length,
        libraryBytes: library.length,
        metrics,
        error: a.state.error,
        suspended: Object.values(a.state.doc.nodes).filter((n) => n.suspended).length,
        historyRestored: window.Undo.history.length === before,
      };
    });
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(
      output.replace(/\.json$/, '') + `-${scale}.cpuprofile`,
      JSON.stringify(profile),
    );
    console.log(
      'Completed fixture',
      scale,
      Object.fromEntries(
        Object.entries(result[scale].metrics).map(([name, rows]) => [
          name,
          rows.map((r) => Math.round(r.ms)),
        ]),
      ),
    );
    await writeFile(output + '.partial', JSON.stringify(result, null, 2));
    await cdp.detach();
    await p.evaluate(() => {
      if (window.Project) window.Project.saved = true;
    });
    await p.close();
    await c.close();
  }
  await writeFile(output, JSON.stringify(result, null, 2));
  for (const [k, v] of Object.entries(result))
    console.log(
      k,
      Object.fromEntries(
        Object.entries(v.metrics).map(([n, rows]) => [n, rows.map((r) => Math.round(r.ms))]),
      ),
    );
} finally {
  await browser.close();
}
