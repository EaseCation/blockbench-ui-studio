import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const plugin = new URL('dist/mcui_studio.js', root);
const bundle = await readFile(plugin);
if (!bundle.length || !/\.Plugin\.register\(\s*['"]mcui_studio['"]/.test(bundle.toString())) {
  throw new Error('Expected a built mcui_studio plugin; run npm run build first');
}
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const site = new URL('site/', root);
await mkdir(site, { recursive: true });
await copyFile(plugin, new URL('mcui_studio.js', site));
await copyFile(plugin, new URL('latest.js', site));
await copyFile(new URL('dist/mcui_studio.js.map', root), new URL('mcui_studio.js.map', site));
await copyFile(new URL('LICENSE', root), new URL('LICENSE', site));
await copyFile(new URL('THIRD_PARTY_NOTICES.md', root), new URL('THIRD_PARTY_NOTICES.md', site));
await mkdir(new URL('licenses/', site), { recursive: true });
await copyFile(
  new URL('licenses/penpot-MPL-2.0.txt', root),
  new URL('licenses/penpot-MPL-2.0.txt', site),
);
await copyFile(new URL('src/presentation/assets/rotate.svg', root), new URL('rotate.svg', site));
await writeFile(new URL('.nojekyll', site), '');
await writeFile(
  new URL('version.json', site),
  JSON.stringify(
    {
      version,
      commit: process.env.GITHUB_SHA ?? null,
      file: 'mcui_studio.js',
      sha256: createHash('sha256').update(bundle).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  new URL('index.html', site),
  `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UI Studio for Blockbench</title>
  <style>
    body { max-width: 760px; margin: 48px auto; padding: 0 20px; font: 16px/1.6 system-ui, sans-serif; color: #20242a; }
    pre { padding: 16px; overflow: auto; background: #f3f5f7; border-radius: 8px; }
    a { color: #0969da; }
  </style>
</head>
<body>
  <h1>UI Studio for Blockbench</h1>
  <p>为二维界面与像素美术设计提供嵌套图层、自动布局、九宫格和 Figma 风格交互。</p>
  <p>当前版本：${version} · 适用于 Blockbench 5.2.1+</p>
  <p>在 Blockbench 插件管理器中选择“从 URL 加载插件”，粘贴以下地址：</p>
  <pre>https://easecation.github.io/blockbench-ui-studio/mcui_studio.js</pre>
  <ul>
    <li><a href="./mcui_studio.js">下载 mcui_studio.js</a></li>
    <li><a href="./latest.js">latest.js 下载别名</a></li>
    <li><a href="./version.json">版本与 SHA-256</a></li>
    <li><a href="https://github.com/EaseCation/blockbench-ui-studio">源代码与使用说明</a></li>
  </ul>
  <p>可编辑文字可配合 <a href="https://easecation.github.io/blockbench-bbmodel-text/">BBModel Text Component</a> 使用。</p>
  <p><a href="./LICENSE">MIT License</a> · <a href="./THIRD_PARTY_NOTICES.md">Third-party notices</a> · <a href="./rotate.svg">Rotation cursor source</a></p>
</body>
</html>
`,
);
console.log(`Prepared UI Studio ${version} in site/`);
