import type { UiDocument, UiNode } from '../domain/types';

/** Undefined means a mixed selection, never a value to write back. */
export function common<T>(values: T[]): T | undefined {
  return values.length && values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]))
    ? values[0]
    : undefined;
}

export function anchorLabel(value: number[] | undefined): string {
  if (!value) return '混合';
  const [x, y] = value;
  return `${['上', '中', '下'][Number(y) * 2] ?? y}${['左', '中', '右'][Number(x) * 2] ?? x}`;
}

export function resizeStrategy(n: UiNode): string {
  if (n.content?.kind === 'nine-slice') return 'nine';
  if (n.rasterSize) return 'preserve';
  return n.content?.kind === 'paint' ? n.content.mode : 'image';
}

export function inspect(doc: UiDocument, nodes: UiNode[]) {
  const every = (test: (n: UiNode) => boolean) => nodes.length > 0 && nodes.every(test);
  const parents = nodes.map((n) => (n.parent ? doc.nodes[n.parent] : undefined));
  const stack = (n: UiNode | undefined) => n?.kind === 'frame' && n.frame?.direction !== 'free';
  const minMax = nodes.map((n) => {
    const l = n.layout;
    return (
      [
        l.minWidth !== 1 ? `W ≥ ${l.minWidth}` : '',
        l.minHeight !== 1 ? `H ≥ ${l.minHeight}` : '',
        l.maxWidth !== undefined ? `W ≤ ${l.maxWidth}` : '',
        l.maxHeight !== undefined ? `H ≤ ${l.maxHeight}` : '',
      ]
        .filter(Boolean)
        .join(' · ') || '未设置'
    );
  });
  const a = common(nodes.map((n) => n.layout.anchorFrom));
  const b = common(nodes.map((n) => n.layout.anchorTo));
  const strategy = common(nodes.map(resizeStrategy));
  const resolutions = nodes.map((n) => {
    const size = n.rasterSize ?? n.rect;
    const stretched = size.width * n.rect.height !== size.height * n.rect.width;
    return `显示 ${n.rect.width}×${n.rect.height} · 贴图 ${size.width}×${size.height}${stretched ? ' · 比例不同，会拉伸' : ''}`;
  });
  return {
    key:
      doc.id +
      ':' +
      nodes
        .map((n) => n.id)
        .sort()
        .join('|'),
    count: nodes.length,
    frames: every((n) => n.kind === 'frame'),
    images: every((n) => n.kind === 'image'),
    contentKind: common(nodes.map((n) => n.content?.kind)),
    hasParent: every((n) => !!n.parent),
    parentStack: parents.length > 0 && parents.every(stack),
    parentFrame: parents.some((n) => n?.kind === 'frame'),
    flowControlled: every(
      (n) => n.layout.positioning === 'flow' && stack(n.parent ? doc.nodes[n.parent] : undefined),
    ),
    anyFlowControlled: nodes.some(
      (n) => n.layout.positioning === 'flow' && stack(n.parent ? doc.nodes[n.parent] : undefined),
    ),
    constraints: common(minMax) ?? '混合 · 已设置',
    anchors: `父${anchorLabel(a)} → 自身${anchorLabel(b)}`,
    preset: a && b && JSON.stringify(a) === JSON.stringify(b) ? a.join(',') : undefined,
    strategy,
    resolution: common(resolutions) ?? '显示／贴图尺寸混合',
    suspended: nodes
      .filter((n) => n.suspended)
      .map((n) => `${n.name}：${n.suspended}`)
      .join('；'),
  };
}
export type InspectorModel = ReturnType<typeof inspect>;

/** Compound controls change only their explicit axes; presentation toggles never reach this. */
export function editCompound(n: UiNode, key: string, value: unknown): boolean {
  if (key === 'anchorPreset') {
    const anchor = String(value).split(',').map(Number) as [number, number];
    n.layout.anchorFrom = [...anchor];
    n.layout.anchorTo = [...anchor];
  } else if (key === 'gapMode' && n.frame) {
    n.frame.justify = value === 'auto' ? 'space-between' : 'start';
  } else if (key.startsWith('padding_') && n.frame) {
    const indices =
      key === 'padding_horizontal' ? [1, 3] : key === 'padding_vertical' ? [0, 2] : [0, 1, 2, 3];
    const v = Number(value);
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('内边距必须是非负整数');
    for (const index of indices) n.frame.padding[index] = v;
  } else if (key === 'resizeStrategy' && n.content && n.content.kind !== 'nine-slice') {
    if (value === 'preserve') n.rasterSize ??= { width: n.rect.width, height: n.rect.height };
    else {
      delete n.rasterSize;
      if (n.content.kind === 'paint' && (value === 'extend' || value === 'scale'))
        n.content.mode = value;
    }
  } else return false;
  return true;
}
