import { build, context } from 'esbuild';
const options = {
  entryPoints: ['src/plugin.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/mcui_studio.js',
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else await build(options);
