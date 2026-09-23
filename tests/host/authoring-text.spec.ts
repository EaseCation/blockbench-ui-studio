import { test, expect } from './host-test';
import { readFile, writeFile, mkdtemp, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
const exec = promisify(execFile);
const cli = resolve('skills/ui-studio-bbmodel/scripts/ui-file.mjs');
const textPlugin = resolve(
  process.env.MCUI_TEXT_PLUGIN ?? '../blockbench-bbmodel-text/dist/bbmodel-text-component.js',
);
const available = await access(textPlugin).then(
  () => true,
  () => false,
);
let scratch: string, base: string, model: any;
async function run(...args: string[]) {
  const result = await exec(process.execPath, [cli, ...args], {
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
test.describe('AI 文件文字与原生 UI 转换（实际文字 provider）', () => {
  test.skip(!available, 'Set MCUI_TEXT_PLUGIN to the built text plugin to run integration tests');
  test.setTimeout(120000);
  test.beforeAll(async () => {
    scratch = await mkdtemp(resolve('.cache/authoring-text-'));
    base = join(scratch, 'text.bbmodel');
    const design = {
      version: 1,
      nodes: [
        {
          id: 'label',
          kind: 'image',
          width: 'hug',
          height: 'hug',
          content: { kind: 'text', text: 'LV.7', font_size: 1.1, color: '#ffffff' },
        },
      ],
    };
    const path = join(scratch, 'design.json');
    await writeFile(path, JSON.stringify(design));
    await run('build', path, '--text-plugin', textPlugin, '--out', base);
    model = JSON.parse(await readFile(base, 'utf8'));
  });
  test('创建、提取、改字和重新烘焙，权威参数在 Cube 与恢复副本', async () => {
    const cube = model.elements[0];
    expect(cube.type).toBe('cube');
    expect(cube.bb_text.text).toBe('LV.7');
    expect(
      model.unhandled_root_fields.mcui_studio.document.nodes.label.content.data,
    ).toBeUndefined();
    expect(model.unhandled_root_fields.bb_text.entries[cube.uuid].text).toBe('LV.7');
    const recipe = join(scratch, 'edit.json'),
      output = join(scratch, 'edited.bbmodel');
    await run('extract', base, '--text-plugin', textPlugin, '--out', recipe);
    const spec = JSON.parse(await readFile(recipe, 'utf8'));
    expect(spec.nodes[0].content.kind).toBe('text');
    spec.nodes[0].content.text = 'LV.100';
    await writeFile(recipe, JSON.stringify(spec));
    await run('build', recipe, '--base', base, '--text-plugin', textPlugin, '--out', output);
    const updated = JSON.parse(await readFile(output, 'utf8'));
    expect(updated.elements[0].uuid).toBe(cube.uuid);
    expect(updated.elements[0].bb_text.text).toBe('LV.100');
    expect(updated.textures[0].source).not.toBe(model.textures[0].source);
    expect(
      updated.unhandled_root_fields.mcui_studio.document.nodes.label.rect.width,
    ).toBeGreaterThan(model.unhandled_root_fields.mcui_studio.document.nodes.label.rect.width);
    spec.nodes[0].content.font_id = 'missing_font';
    await writeFile(recipe, JSON.stringify(spec));
    await expect(
      run('build', recipe, '--text-plugin', textPlugin, '--out', join(scratch, 'missing.bbmodel')),
    ).rejects.toThrow(/Missing text font/);
  });
  test('原生反向顶视图、交错深度文件夹与 legacy 文字转换；非平面必须显式烘焙', async ({ page }) => {
    await page.route(/https:\/\/.*/, (r) => r.abort());
    await page.goto(`http://127.0.0.1:${process.env.MCUI_HOST_PORT ?? '4178'}`);
    await page.waitForFunction(() => !!window.Blockbench?.setup_successful);
    const source: any = await page.evaluate(() => {
      const w = window as any;
      w.setupProject(w.Formats.free);
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(1, 0, 1, 1);
      const t = new w.Texture({
        name: 'two colors',
        width: 2,
        height: 1,
        uv_width: 2,
        uv_height: 1,
      })
        .fromDataURL(canvas.toDataURL())
        .add(false);
      const a = new w.Group({ name: 'A' }).init(),
        b = new w.Group({ name: 'B' }).init(),
        sprite = new w.Group({ name: 'Sprite' }).init();
      const add = (name: string, y: number, g: any, thickness = 0) => {
        const c = new w.Cube({
          name,
          from: [0, y, 0],
          to: [16, y + thickness, 8],
          box_uv: false,
          autouv: 0,
        })
          .addTo(g)
          .init();
        for (const [k, f] of Object.entries(c.faces) as any) {
          f.texture = k === 'up' ? t.uuid : null;
          f.uv = [2, 1, 0, 0];
        }
        return c;
      };
      add('back', 0, a);
      add('front', 2, a).visibility = false;
      add('middle', 1, b);
      add('solid', 3, sprite, 2);
      return { model: w.Codecs.project.compile({ raw: true, bitmaps: true }), sprite: sprite.uuid };
    });
    // No private user assets: this is a synthetic old text element using the plugin's bundled font.
    const id = '11111111-2222-4333-8444-555555555555';
    source.model.elements.push({
      uuid: id,
      type: 'bb_text',
      name: 'Legacy label',
      origin: [-20, 5, 0],
      rotation: [-90, -180, 0],
      text: 'LV.7',
      font_id: 'font_default_minecraft',
      font_size: 1.1,
      line_height: 1.2,
      letter_spacing: 0,
      align: 'left',
      color: '#ffffff',
      opacity: 1,
      layout_mode: 'auto_width',
      box_width: 64,
      visibility: true,
    });
    source.model.outliner.push(id);
    source.model.bb_text_fonts = model.unhandled_root_fields.bb_text.fonts;
    const input = join(scratch, 'legacy.bbmodel'),
      opts = join(scratch, 'conversion.json'),
      out = join(scratch, 'converted.bbmodel'),
      report = join(scratch, 'report.json');
    await writeFile(input, JSON.stringify(source.model));
    await writeFile(opts, JSON.stringify({ view: 'top-reversed' }));
    await expect(
      run('convert', input, '--options', opts, '--text-plugin', textPlugin, '--out', out),
    ).rejects.toThrow(/Non-planar/);
    await writeFile(opts, JSON.stringify({ view: 'top-reversed', flattenGroups: [source.sprite] }));
    await run(
      'convert',
      input,
      '--options',
      opts,
      '--text-plugin',
      textPlugin,
      '--out',
      out,
      '--report',
      report,
      '--preview',
      join(scratch, 'crop.png'),
      '--preview-scale',
      '3',
      '--preview-region',
      '-16,-8,16,8',
    );
    const converted = JSON.parse(await readFile(out, 'utf8')),
      r = JSON.parse(await readFile(report, 'utf8'));
    expect(converted.elements).toHaveLength(5);
    expect(converted.elements.every((e: any) => e.type === 'cube' && e.from[1] === e.to[1])).toBe(
      true,
    );
    expect(r.notes.find((n: any) => n.kind === 'stacking').splitGroups).toHaveLength(1);
    const d = converted.unhandled_root_fields.mcui_studio.document;
    const visit = (ids: string[]): any[] =>
      ids.flatMap((id) => [d.nodes[id], ...visit(d.nodes[id].children)]);
    expect(
      visit(d.roots)
        .filter((n) => n.kind === 'image')
        .map((n) => n.name),
    ).toEqual(['back', 'middle', 'front', 'Sprite', 'Legacy label']);
    expect(converted.elements.find((e: any) => e.bb_text)?.bb_text.text).toBe('LV.7');
    expect(d.nodes[id].rect.width).toBeGreaterThanOrEqual(
      model.unhandled_root_fields.mcui_studio.document.nodes.label.rect.width,
    );
    const png = await readFile(join(scratch, 'crop.png'));
    expect(png.readUInt32BE(16)).toBe(48);
    expect(png.readUInt32BE(20)).toBe(24);
    const hidden = Object.values(d.nodes).find((n: any) => n.name === 'front') as any;
    expect(hidden.visible).toBe(false);
    const asset =
      d.assets[
        d.nodes[Object.keys(d.nodes).find((k) => d.nodes[k].name === 'back')!].content.source
      ];
    const samples = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = png;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return [
        Array.from(ctx.getImageData(1, 1, 1, 1).data),
        Array.from(ctx.getImageData(img.width - 2, 1, 1, 1).data),
      ];
    }, asset.png);
    expect(samples[0]![0]!).toBeGreaterThan(samples[0]![2]!);
    expect(samples[1]![2]!).toBeGreaterThan(samples[1]![0]!);
    const hiddenAlpha = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = png;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(1, 1, 1, 1).data[3];
    }, d.assets[hidden.content.source].png);
    expect(hiddenAlpha).toBe(255);
    source.model.elements.find((e: any) => e.uuid === id).rotation = [0, 0, 0];
    await writeFile(input, JSON.stringify(source.model));
    await expect(
      run(
        'convert',
        input,
        '--options',
        opts,
        '--text-plugin',
        textPlugin,
        '--out',
        join(scratch, 'rotated.bbmodel'),
      ),
    ).rejects.toThrow(/not upright/);
    await writeFile(opts, JSON.stringify({ view: 'top-reversed', typo: true }));
    await expect(
      run(
        'convert',
        input,
        '--options',
        opts,
        '--text-plugin',
        textPlugin,
        '--out',
        join(scratch, 'unknown.bbmodel'),
      ),
    ).rejects.toThrow(/Unknown conversion option/);
  });
});
