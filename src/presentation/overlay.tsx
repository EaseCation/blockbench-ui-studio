import { render } from 'preact';
import type { Handle, Point, Rect } from '../domain/types';
import type { Measurement } from '../domain/geometry';
export interface OverlayModel {
  width: number;
  height: number;
  selection: Rect | null;
  marquee: Rect | null;
  measurements: Measurement[];
}
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
export function drawOverlay(root: HTMLElement, model: OverlayModel) {
  const { selection: r } = model;
  render(
    <svg
      width="100%"
      height="100%"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {r && (
        <>
          <rect
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            fill="none"
            stroke="#57a6ff"
            strokeWidth={1}
          />
          {Object.entries(positions).map(([key, [x, y]]) => (
            <rect
              data-mcui-handle={key}
              x={r.x + r.width * x - 4}
              y={r.y + r.height * y - 4}
              width={8}
              height={8}
              fill="white"
              stroke="#3585e5"
              style={{
                pointerEvents: 'all',
                cursor: `${key === 'n' || key === 's' ? 'ns' : key === 'e' || key === 'w' ? 'ew' : key === 'nw' || key === 'se' ? 'nwse' : 'nesw'}-resize`,
              }}
            />
          ))}
        </>
      )}
      {model.marquee && (
        <rect
          {...{
            x: model.marquee.x,
            y: model.marquee.y,
            width: model.marquee.width,
            height: model.marquee.height,
          }}
          fill="#57a6ff22"
          stroke="#57a6ff"
        />
      )}
      {model.measurements.map((m, i) => (
        <g key={i}>
          <line x1={m.from.x} y1={m.from.y} x2={m.to.x} y2={m.to.y} stroke="#fa5d72" />
          <text
            x={(m.from.x + m.to.x) / 2 + 4}
            y={(m.from.y + m.to.y) / 2 - 5}
            fill="#fa5d72"
            stroke="#141414"
            strokeWidth={3}
            paint-order="stroke"
            font-size="12"
          >
            {m.value}px
          </text>
        </g>
      ))}
    </svg>,
    root,
  );
}
export function clearOverlay(root: HTMLElement) {
  render(null, root);
}
