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
  if (n.content?.kind === 'generated')
    return n.content.data?.resize === 'scale' ? 'text-scale' : 'text-reflow';
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
        l.minWidth !== 0 ? `W ≥ ${l.minWidth}` : '',
        l.minHeight !== 0 ? `H ≥ ${l.minHeight}` : '',
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
    const size =
      n.content?.kind === 'generated'
        ? (doc.assets[n.content.source] ?? n.rect)
        : (n.rasterSize ?? n.rect);
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
  } else if (
    key === 'resizeStrategy' &&
    n.content &&
    n.content.kind !== 'nine-slice' &&
    n.content.kind !== 'generated'
  ) {
    if (value === 'preserve') n.rasterSize ??= { width: n.rect.width, height: n.rect.height };
    else {
      delete n.rasterSize;
      if (n.content.kind === 'paint' && (value === 'extend' || value === 'scale'))
        n.content.mode = value;
    }
  } else return false;
  return true;
}

/** Shared selection contract for every property presentation and write entry point. */
export interface InspectorProperty {
  read(node: UiNode): unknown;
  applies?(node: UiNode, doc: UiDocument): boolean;
  disabled?(node: UiNode, doc: UiDocument): string | undefined;
  readonly?: boolean;
  dimensions?: number;
}
export function inspectProperty(doc: UiDocument, nodes: UiNode[], field: InspectorProperty) {
  const available = nodes.length > 0 && nodes.every((n) => !field.applies || field.applies(n, doc));
  const values = available ? nodes.map((n) => field.read(n)) : [];
  const mixed = values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]));
  const reason = !available
    ? '此属性不适用于整个选区'
    : nodes.map((n) => n.suspended || field.disabled?.(n, doc)).find(Boolean);
  return {
    available,
    editable: available && !field.readonly && !reason,
    reason,
    mixed,
    value: available && !mixed ? values[0] : undefined,
    axes: Array.from({ length: field.dimensions ?? 0 }, (_, i) =>
      common(values.map((value) => (Array.isArray(value) ? value[i] : undefined))),
    ),
  };
}
export function flowControlled(doc: UiDocument, node: UiNode) {
  const parent = node.parent ? doc.nodes[node.parent] : undefined;
  return (
    node.layout.positioning === 'flow' &&
    parent?.kind === 'frame' &&
    parent.frame?.direction !== 'free'
  );
}
