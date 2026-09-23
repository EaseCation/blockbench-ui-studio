#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, link, stat, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const help = `UI Studio file authoring (run from any directory)
  node skills/ui-studio-bbmodel/scripts/ui-file.mjs build design.json --out file.bbmodel [--base existing.bbmodel] [--preview preview.png] [--force]
  node skills/ui-studio-bbmodel/scripts/ui-file.mjs inspect file.bbmodel
  node skills/ui-studio-bbmodel/scripts/ui-file.mjs extract file.bbmodel --out design.json [--force]
  node skills/ui-studio-bbmodel/scripts/ui-file.mjs validate file.bbmodel [--preview preview.png] [--force]
Host: MCUI_HOST_DIR or repository .cache/blockbench; Chrome: MCUI_CHROME_PATH or installed Google Chrome.
Outputs default to no-overwrite. --force creates a timestamped backup of existing outputs.
No running Blockbench session, user browser profile or network service is used.`;
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log(help);
  process.exit(0);
}
const [command, filename, ...flags] = args;
if (
  !['build', 'inspect', 'extract', 'validate'].includes(command) ||
  !filename ||
  filename.startsWith('--')
)
  throw new Error(help);
const options = {};
for (let i = 0; i < flags.length; i++) {
  const flag = flags[i];
  if (flag === '--force') {
    options.force = true;
    continue;
  }
  if (
    !['--out', '--base', '--preview'].includes(flag) ||
    !flags[i + 1] ||
    flags[i + 1].startsWith('--')
  )
    throw new Error('Unknown or incomplete argument: ' + flag);
  options[flag.slice(2)] = resolve(flags[++i]);
}
if (['build', 'extract'].includes(command) && !options.out) throw new Error('--out is required');
if (options.base && command !== 'build') throw new Error('--base is only valid for build');
if (options.out && !['build', 'extract'].includes(command))
  throw new Error('--out is only valid for build/extract');
if (options.preview && !['build', 'validate'].includes(command))
  throw new Error('--preview is only valid for build/validate');
if (options.out && extname(options.out) !== (command === 'build' ? '.bbmodel' : '.json'))
  throw new Error('Output extension must be .bbmodel for build or .json for extract');
if (options.preview && extname(options.preview) !== '.png')
  throw new Error('Preview output must be .png');
const inputPath = resolve(filename);
if (options.out && options.out === options.preview)
  throw new Error('Model/design and preview must have different paths');
if (options.preview && [inputPath, options.base].includes(options.preview))
  throw new Error('Preview cannot overwrite a model/design input');
for (const output of [options.out, options.preview].filter(Boolean)) {
  if ([inputPath, options.base].includes(output) && !options.force)
    throw new Error('Use a new output path, or --force to back up and overwrite');
  try {
    await stat(output);
    if (!options.force) throw new Error(`Output exists: ${output}; choose a new path or --force`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
async function json(path) {
  const info = await stat(path);
  if (info.size > 128 * 1024 * 1024) throw new Error('JSON file exceeds 128 MiB');
  return JSON.parse(await readFile(path, 'utf8'));
}
function docFrom(model) {
  const carrier = model.unhandled_root_fields?.mcui_studio;
  if (
    model.meta?.model_format !== 'free' ||
    carrier?.schemaVersion !== 1 ||
    carrier.document?.schemaVersion !== 1
  )
    throw new Error('Expected Generic Model with UI Studio schemaVersion 1');
  return carrier.document;
}
async function output(path, content) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await stat(path);
    if (!options.force) throw new Error('Output appeared while running: ' + path);
    await copyFile(path, path + '.bak-' + Date.now());
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const temp = path + '.tmp-' + randomUUID();
  try {
    await writeFile(temp, content, { flag: 'wx' });
    if (options.force) await rename(temp, path);
    else await link(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
function checkPNG(url) {
  if (typeof url !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url))
    throw new Error('Expected embedded PNG data URL');
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  if (
    bytes.length < 24 ||
    bytes.length > 32 * 1024 * 1024 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  )
    throw new Error('Invalid or oversized PNG');
  const w = bytes.readUInt32BE(16),
    h = bytes.readUInt32BE(20);
  if (!w || !h || w * h > 16_777_216) throw new Error('PNG exceeds pixel limit');
}
const raw = await json(inputPath);
if (command === 'inspect') {
  const d = docFrom(raw);
  console.log(
    JSON.stringify(
      {
        name: raw.name,
        documentId: d.id,
        schemaVersion: d.schemaVersion,
        roots: d.roots,
        nodes: Object.values(d.nodes).map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          parent: n.parent,
          children: n.children,
          rect: n.rect,
          layout: n.layout,
          frame: n.frame,
          content: n.content ? { ...n.content, source: n.content.source } : undefined,
          rasterSize: n.rasterSize,
          appearance: n.appearance,
          suspended: n.suspended,
        })),
        assets: Object.values(d.assets).map((a) => ({
          id: a.id,
          width: a.width,
          height: a.height,
          revision: a.revision,
        })),
        bindings: d.bindings,
        nativeSources: Object.keys(raw.unhandled_root_fields.mcui_studio.nativeSources ?? {}),
        note: 'Read-only metadata summary, not a validation. Run validate to compare native carriers.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const base = command === 'build' ? (options.base ? await json(options.base) : undefined) : raw;
if (base) {
  const doc = docFrom(base);
  for (const asset of Object.values(doc.assets)) checkPNG(asset.png);
  for (const texture of base.textures ?? []) checkPNG(texture.source);
}
const design = command === 'build' ? raw : undefined;
if (design) {
  for (const [id, asset] of Object.entries(design.assets ?? {})) {
    if (asset.file) {
      if (Object.keys(asset).some((k) => k !== 'file'))
        throw new Error(`asset ${id}: file cannot be combined with other fields`);
      const path = resolve(dirname(inputPath), asset.file);
      const data = await readFile(path);
      if (
        data.length > 32 * 1024 * 1024 ||
        data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      )
        throw new Error('Expected PNG <= 32MiB: ' + path);
      const width = data.readUInt32BE(16),
        height = data.readUInt32BE(20);
      if (!width || !height || width * height > 16_777_216)
        throw new Error('PNG exceeds pixel limit');
      design.assets[id] = { png: 'data:image/png;base64,' + data.toString('base64') };
    }
  }
  for (const asset of Object.values(design.assets ?? {})) if (asset.png) checkPNG(asset.png);
}
const hostDir = resolve(process.env.MCUI_HOST_DIR ?? resolve(repository, '.cache/blockbench'));
try {
  await stat(resolve(hostDir, 'index.html'));
  await stat(resolve(hostDir, 'dist/bundle.js'));
} catch {
  throw new Error(
    `Missing built Blockbench Web host at ${hostDir}. Set MCUI_HOST_DIR; see skill references/setup.md. No download was attempted.`,
  );
}
const bundle = await build({
  entryPoints: [resolve(dirname(fileURLToPath(import.meta.url)), 'host-bridge.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'UiFileAuthoring',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'silent',
});
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(hostDir, '.' + (name === '/' ? '/index.html' : name));
    const rel = relative(hostDir, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('outside host');
    const bytes = await readFile(path);
    res.writeHead(200, {
      'Content-Type':
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
          '.woff': 'font/woff',
        }[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const address = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MCUI_CHROME_PATH
      ? { executablePath: process.env.MCUI_CHROME_PATH }
      : { channel: 'chrome' }),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(address + '/') || url.startsWith('data:') || url.startsWith('blob:')
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  await page.goto(address);
  await page.waitForFunction(() => window.Blockbench?.setup_successful, {}, { timeout: 30000 });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate((request) => window.UiFileAuthoring.run(request), {
    command,
    base,
    design,
    preview: !!options.preview,
  });
  // Reopen serialized output in a clean host before publishing it.
  if (result.model) {
    const verification = await context.newPage();
    await verification.goto(address);
    await verification.waitForFunction(
      () => window.Blockbench?.setup_successful,
      {},
      { timeout: 30000 },
    );
    await verification.addScriptTag({ content: bundle.outputFiles[0].text });
    await verification.evaluate(
      (model) => window.UiFileAuthoring.run({ command: 'validate', base: model }),
      result.model,
    );
  }
  if (options.preview) {
    if (!result.preview) throw new Error('No visible bounds to preview');
    await output(options.preview, Buffer.from(result.preview.png.split(',')[1], 'base64'));
  }
  if (options.out)
    await output(options.out, JSON.stringify(result.model ?? result.design, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        ok: true,
        command,
        output: options.out,
        preview: options.preview,
        bounds: result.preview?.bounds,
        ...(result.summary ?? { nodes: result.nodes, images: result.images }),
      },
      null,
      2,
    ),
  );
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
