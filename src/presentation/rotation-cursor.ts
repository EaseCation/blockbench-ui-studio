/*! Rotation cursor artwork: Penpot, MPL-2.0.
 * Original source (unmodified SVG):
 * https://github.com/penpot/penpot/blob/cbb9e5d971cf1394b1e85cb63b06e8b68e61d36e/frontend/resources/images/cursors/rotate.svg
 * Source and license: https://github.com/EaseCation/blockbench-ui-studio/tree/main/src/presentation/assets
 * See THIRD_PARTY_NOTICES.md and licenses/penpot-MPL-2.0.txt.
 */
import artwork from './assets/rotate.svg';

const cornerAngles = { nw: 90, ne: 180, se: 270, sw: 0 };
// Keep the original 16px artwork, with enough padding for rotation at any angle.
const source = artwork.replace('<svg ', '<svg width="16" height="16" ');
const cursors = new Map<number, string>();

export function rotationCursor(corner: keyof typeof cornerAngles, selectionAngle: number) {
  // Quantize only the cursor, not model rotation; cap cache at 360 small SVG strings.
  const angle = ((Math.round(selectionAngle + cornerAngles[corner]) % 360) + 360) % 360;
  let cursor = cursors.get(angle);
  if (!cursor) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-4 -4 24 24"><g transform="rotate(${angle} 8 8)">${source}</g></svg>`;
    cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
    cursors.set(angle, cursor);
  }
  return cursor;
}
