import type { ImagePort } from '../../application/ports';
import type { Pixels } from '../../domain/types';
import { blank } from '../../domain/raster';
export const imagePort: ImagePort = {
  id: () => crypto.randomUUID(),
  async decode(png) {
    const blob = await (await fetch(png)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      blank(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    } finally {
      bitmap.close();
    }
  },
  encode(pixels) {
    const canvas = document.createElement('canvas');
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(pixels.width, pixels.height);
    data.data.set(pixels.data);
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  },
};
export async function blobPixels(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const pixels = await imagePort.decode(url);
    return {
      pixels,
      name: blob instanceof File ? blob.name : '粘贴的图片',
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function blobImage(
  blob: Blob,
): Promise<{ png: string; width: number; height: number; name: string }> {
  const { pixels, name } = await blobPixels(blob);
  return { png: imagePort.encode(pixels), width: pixels.width, height: pixels.height, name };
}
