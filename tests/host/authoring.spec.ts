import { test, expect, type Page } from './host-test';
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname } from 'node:path';
const exec = promisify(execFile);
const cli = resolve('skills/ui-studio-bbmodel/scripts/ui-file.mjs');
const example = resolve('skills/ui-studio-bbmodel/assets/example.design.json');
const bundle = await readFile('dist/mcui_studio.js', 'utf8');
let scratch: string, original: string, model: any;
test.setTimeout(120000);
async function run(...args: string[]) {
  const result = await exec(process.execPath, [cli, ...args], {
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
async function open(page: Page, data: any, plugin = true) {
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
  }
  await page.evaluate((data) => {
    window.setupProject(window.Formats.free);
    window.Codecs.project.parse(data);
  }, data);
  if (plugin)
    await page.waitForFunction(() => {
      const app = window.Blockbench.mcuiStudio.getStudio();
      return app && !app.state.busy;
    });
}
test.beforeAll(async () => {
  scratch = await mkdtemp(resolve('.cache/authoring-test-'));
  original = join(scratch, 'original.bbmodel');
  await run('build', example, '--out', original, '--preview', join(scratch, 'preview.png'));
  model = JSON.parse(await readFile(original, 'utf8'));
});

test('技能示例可在有/无插件的宿主中打开，规则与标准载体一致', async ({ page, context }) => {
  await open(page, model);
  const state = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    return {
      errors: Object.values(app.state.doc.nodes)
        .map((n: any) => n.suspended)
        .filter(Boolean),
      count: window.Cube.all.length,
      groups: (window as any).Group.all.length,
      zero: window.Cube.all.every((c: any) => c.from[1] === c.to[1]),
      texture: window.Texture.all.find((t: any) => t.uuid === app.state.doc.bindings.gem.textureId)
        .width,
      width: app.state.doc.nodes.gem.rect.width,
      gap: app.state.doc.nodes.items.frame.justify,
    };
  });
  expect(state).toEqual({
    errors: [],
    count: 6,
    groups: 8,
    zero: true,
    texture: 8,
    width: 24,
    gap: 'space-between',
  });
  await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    app.update('screen', (n: any) => {
      n.layout.width = { kind: 'fixed', value: 300 };
    });
  });
  expect(
    await page.evaluate(
      () => window.Blockbench.mcuiStudio.getStudio().state.doc.nodes.background.rect.width,
    ),
  ).toBe(300);
  const bare = await context.newPage();
  await open(bare, model, false);
  expect(await bare.evaluate(() => [window.Cube.all.length, window.Texture.all.length])).toEqual([
    6, 6,
  ]);
  await bare.close();
});

test('提取后按 base 修改保留 UUID 与原生绘画层，重开不暂停', async ({ page }) => {
  await open(page, model);
  const painted = await page.evaluate(() => {
    const app = window.Blockbench.mcuiStudio.getStudio();
    const id = app.add('image', 'screen');
    const texture = window.Texture.all.find(
      (t: any) => t.uuid === app.state.doc.bindings[id].textureId,
    );
    texture.activateLayers(false);
    window.Undo.initEdit({ layers: [texture.layers[0]], bitmap: true });
    texture.layers[0].ctx.fillStyle = '#ef9922';
    texture.layers[0].ctx.fillRect(1, 1, 3, 3);
    texture.updateChangesAfterEdit();
    window.Undo.finishEdit('Paint example');
    window.Project.unhandled_root_fields.authoring_note = { keep: true };
    return { model: window.Codecs.project.compile({ raw: true, bitmaps: true }), id };
  });
  const base = join(scratch, 'painted.bbmodel'),
    spec = join(scratch, 'edit.json'),
    output = join(scratch, 'edited.bbmodel');
  await writeFile(base, JSON.stringify(painted.model));
  await run('extract', base, '--out', spec);
  const design = JSON.parse(await readFile(spec, 'utf8'));
  design.nodes[0].width = 280;
  await writeFile(spec, JSON.stringify(design));
  await run('build', spec, '--base', base, '--out', output);
  const changed = JSON.parse(await readFile(output, 'utf8'));
  const before = painted.model.unhandled_root_fields.mcui_studio,
    after = changed.unhandled_root_fields.mcui_studio;
  expect(after.document.bindings[painted.id].containerId).toBe(
    before.document.bindings[painted.id].containerId,
  );
  expect(after.nativeSources).toEqual(before.nativeSources);
  expect(changed.unhandled_root_fields.authoring_note).toEqual({ keep: true });
  await open(page, changed);
  expect(
    await page.evaluate((id) => {
      const app = window.Blockbench.mcuiStudio.getStudio(),
        t = window.Texture.all.find((t: any) => t.uuid === app.state.doc.bindings[id].textureId);
      return {
        suspended: Object.values(app.state.doc.nodes).some((n: any) => n.suspended),
        layered: t.layers_enabled,
        pixel: Array.from(t.ctx.getImageData(2, 2, 1, 1).data),
      };
    }, painted.id),
  ).toEqual({ suspended: false, layered: true, pixel: [239, 153, 34, 255] });
});

test('拒绝差异现场、尺寸循环及覆盖，generated 内容保留而不伪造编辑', async () => {
  const tampered = structuredClone(model);
  tampered.elements[0].to[1] += 1;
  const invalid = join(scratch, 'invalid.bbmodel');
  await writeFile(invalid, JSON.stringify(tampered));
  await expect(run('validate', invalid)).rejects.toThrow(/divergence/);
  await expect(run('build', example, '--out', original)).rejects.toThrow(/Output exists/);
  const design = JSON.parse(await readFile(example, 'utf8'));
  design.nodes[0].width = 'hug';
  const cycle = join(scratch, 'cycle.json');
  await writeFile(cycle, JSON.stringify(design));
  await expect(run('build', cycle, '--out', join(scratch, 'bad.bbmodel'))).rejects.toThrow(/循环/);
  const generated = structuredClone(model),
    doc = generated.unhandled_root_fields.mcui_studio.document;
  doc.nodes.gem.content = {
    kind: 'generated',
    source: 'gem',
    provider: 'mcui_text_example',
    logicalSize: { width: 24, height: 24 },
  };
  const surface = doc.bindings.gem.surfaceId;
  generated.elements.find((e: any) => e.uuid === surface).mcui_text_example = {
    text: 'saved text',
    sizing: 'fixed',
  };
  generated.unhandled_root_fields.mcui_text_example = {
    version: 1,
    entries: { [surface]: { text: 'saved text', sizing: 'fixed' } },
  };
  const textBase = join(scratch, 'text.bbmodel'),
    textSpec = join(scratch, 'text.json'),
    result = join(scratch, 'text-copy.bbmodel');
  await writeFile(textBase, JSON.stringify(generated));
  await run('extract', textBase, '--out', textSpec);
  await run('build', textSpec, '--base', textBase, '--out', result);
  const copy = JSON.parse(await readFile(result, 'utf8'));
  expect(copy.unhandled_root_fields.mcui_text_example).toEqual(
    generated.unhandled_root_fields.mcui_text_example,
  );
  expect(copy.elements.find((e: any) => e.uuid === surface).mcui_text_example).toEqual(
    generated.elements.find((e: any) => e.uuid === surface).mcui_text_example,
  );
  const edit = JSON.parse(await readFile(textSpec, 'utf8'));
  edit.nodes[0].x = 10;
  await writeFile(textSpec, JSON.stringify(edit));
  await expect(
    run('build', textSpec, '--base', textBase, '--out', join(scratch, 'changed-text.bbmodel')),
  ).rejects.toThrow(/generated\/text/);
});

test('本地 PNG 相对设计路径读取，任意工作目录可调用，force 备份输出', async () => {
  const spec = JSON.parse(await readFile(example, 'utf8'));
  const png = model.unhandled_root_fields.mcui_studio.document.assets.gem.png;
  await writeFile(join(scratch, 'gem.png'), Buffer.from(png.split(',')[1], 'base64'));
  spec.assets.gem = { file: 'gem.png' };
  const recipe = join(scratch, 'local-assets.json'),
    output = join(scratch, 'local.bbmodel');
  await writeFile(recipe, JSON.stringify(spec));
  const first = await exec(process.execPath, [cli, 'build', recipe, '--out', output], {
    cwd: dirname(scratch),
    timeout: 90000,
  });
  expect(JSON.parse(first.stdout).ok).toBe(true);
  const original = await readFile(output, 'utf8');
  const validated = await run('validate', output, '--preview', join(scratch, 'local.png'));
  expect(validated.nodes).toBe(8);
  await run('build', recipe, '--base', output, '--out', output, '--force');
  const backup = (await readdir(scratch)).find((name) => name.startsWith('local.bbmodel.bak-'))!;
  expect(await readFile(join(scratch, backup), 'utf8')).toBe(original);
  expect((await run('inspect', output)).roots).toEqual(['screen']);
});
