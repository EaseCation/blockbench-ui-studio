import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const forbidden = new Set([
  'Blockbench',
  'Cube',
  'Texture',
  'Group',
  'Project',
  'Preview',
  'Painter',
  'Undo',
  'THREE',
  'Vue',
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'ImageData',
]);
let errors = [];
async function visit(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await visit(file);
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const isCore = /^src\/(domain|application)\//.test(file);
    function walk(node) {
      if (isCore && ts.isIdentifier(node) && forbidden.has(node.text))
        errors.push(`${file}: forbidden core identifier ${node.text}`);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (isCore && /adapters|presentation|platform|preact|blockbench|three|electron/.test(spec))
          errors.push(`${file}: forbidden dependency ${spec}`);
        if (file.startsWith('src/domain/') && /application/.test(spec))
          errors.push(`${file}: domain depends on application`);
        if (file.startsWith('src/presentation/') && /adapters|blockbench|three|electron/.test(spec))
          errors.push(`${file}: UI depends on host`);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
}
await visit('src');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Dependency boundaries OK');
