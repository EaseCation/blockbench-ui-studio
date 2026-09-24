/** Bounded, symmetric response to mouse wheel notches, including fractional input. */
export function wheelZoom(zoom: number, deltaY: number, deltaMode: number, height: number) {
  if (!Number.isFinite(deltaY)) return zoom;
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1);
  const exponent = -0.12 * Math.tanh(pixels / 60);
  return Math.max(0.02, Math.min(1000, zoom * Math.exp(exponent)));
}

/** Preserve the original Mac pinch sensitivity; Chromium reports pinch in pixel units. */
export function pinchZoom(zoom: number, deltaY: number) {
  if (!Number.isFinite(deltaY)) return zoom;
  return Math.max(0.02, Math.min(1000, zoom * Math.exp(-deltaY * 0.01)));
}
