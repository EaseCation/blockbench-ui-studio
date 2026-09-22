import type { Handle, Rect } from '../domain/types';
import type { Measurement } from '../domain/geometry';
export interface OverlayModel {
  width: number;
  height: number;
  selection: Rect | null;
  marquee: Rect | null;
  measurements: Measurement[];
  grid?: { x: number; y: number; spacing: number; opacity: number } | null;
}
const NS = 'http://www.w3.org/2000/svg';
const positions: Record<Handle, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};
function element(tag: string, attrs: Record<string, string | number>) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
export function drawOverlay(root: HTMLElement, model: OverlayModel) {
  let svg = root.querySelector('svg');
  if (!svg) {
    svg = element('svg', {
      width: '100%',
      height: '100%',
      style: 'position:absolute;inset:0;overflow:hidden;pointer-events:none',
    }) as SVGSVGElement;
    root.append(svg);
  }
  const set = (e: Element, attrs: Record<string, string | number>) => {
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  };
  let grid = svg.querySelector('[data-mcui-grid]');
  if (!grid) {
    grid = element('path', {
      'data-mcui-grid': '',
      fill: 'none',
      stroke: '#ffffff',
      'stroke-width': 1,
    });
    svg.prepend(grid);
  }
  const g = model.grid;
  const paths: string[] = [];
  if (g && g.spacing >= 8) {
    for (let x = ((g.x % g.spacing) + g.spacing) % g.spacing; x < model.width; x += g.spacing)
      paths.push(`M${x} 0V${model.height}`);
    for (let y = ((g.y % g.spacing) + g.spacing) % g.spacing; y < model.height; y += g.spacing)
      paths.push(`M0 ${y}H${model.width}`);
  }
  set(grid, { d: paths.join(' '), opacity: g?.opacity ?? 0 });
  const r = model.selection;
  if (r) {
    let border = svg.querySelector('[data-mcui-selection]');
    if (!border) {
      border = element('rect', {
        'data-mcui-selection': '',
        fill: 'none',
        stroke: '#57a6ff',
        'stroke-width': 1,
      });
      svg.append(border);
    }
    set(border, { x: r.x, y: r.y, width: r.width, height: r.height });
    for (const [key, [x, y]] of Object.entries(positions)) {
      let handle = svg.querySelector(`[data-mcui-handle="${key}"]`);
      if (!handle) {
        const cursor = ['n', 's'].includes(key)
          ? 'ns'
          : ['e', 'w'].includes(key)
            ? 'ew'
            : ['nw', 'se'].includes(key)
              ? 'nwse'
              : 'nesw';
        handle = element('rect', {
          'data-mcui-handle': key,
          width: 8,
          height: 8,
          fill: 'white',
          stroke: '#3585e5',
          style: `pointer-events:all;cursor:${cursor}-resize`,
        });
        svg.append(handle);
      }
      set(handle, { x: r.x + r.width * x - 4, y: r.y + r.height * y - 4 });
    }
  } else
    for (const e of svg.querySelectorAll('[data-mcui-selection],[data-mcui-handle]')) e.remove();
  let measurements = svg.querySelector('[data-mcui-measurements]');
  if (!measurements) {
    measurements = element('g', { 'data-mcui-measurements': '' });
    svg.append(measurements);
  }
  measurements.replaceChildren();
  for (const m of model.measurements) {
    measurements.append(
      element('line', { x1: m.from.x, y1: m.from.y, x2: m.to.x, y2: m.to.y, stroke: '#fa5d72' }),
    );
    const label = element('text', {
      x: (m.from.x + m.to.x) / 2 + 4,
      y: (m.from.y + m.to.y) / 2 - 5,
      fill: '#fa5d72',
      stroke: '#141414',
      'stroke-width': 3,
      'paint-order': 'stroke',
      'font-size': 12,
    });
    label.textContent = `${m.value}px`;
    measurements.append(label);
  }
}
export function clearOverlay(root: HTMLElement) {
  root.replaceChildren();
}
