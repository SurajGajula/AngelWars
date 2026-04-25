/**
 * Removes contiguous near-white regions reachable from the image border (typical sprite sheet backgrounds).
 * Interior colors (not connected to the edge) are preserved.
 */

const DEFAULT_THRESHOLD = 248;
const DEFAULT_MAX_MEGAPIXELS = 24;
const MAX_DIMENSION = 4096;

/**
 * @param {Blob | File} input
 * @param {{ threshold?: number, maxMegapixels?: number }} [opts]
 * @returns {Promise<Blob>}
 */
export async function stripLightEdgeBackgroundPng(input, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxMp = opts.maxMegapixels ?? DEFAULT_MAX_MEGAPIXELS;

  const bmp = await createImageBitmap(input);
  const w = bmp.width;
  const h = bmp.height;
  if (!w || !h) {
    bmp.close();
    throw new Error("Invalid image dimensions.");
  }
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
    bmp.close();
    throw new Error(`Image exceeds ${MAX_DIMENSION}px per side.`);
  }
  const pixels = w * h;
  if (pixels > maxMp * 1_000_000) {
    bmp.close();
    throw new Error(`Image exceeds ${maxMp} megapixels.`);
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    throw new Error("Could not get canvas context.");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;

  /** @param {number} i byte index (multiple of 4) */
  const isBgLike = (i) => {
    const a = d[i + 3];
    if (a < 12) return true;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    return r >= threshold && g >= threshold && b >= threshold;
  };

  const visited = new Uint8Array(pixels);
  const q = new Int32Array(pixels);
  let qh = 0;
  let qt = 0;

  const enqueue = (p) => {
    if (visited[p]) return;
    const i = p * 4;
    if (!isBgLike(i)) return;
    visited[p] = 1;
    q[qt++] = p;
  };

  for (let x = 0; x < w; x++) {
    enqueue(x);
    enqueue((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    enqueue(y * w);
    enqueue(y * w + (w - 1));
  }

  while (qh < qt) {
    const p = q[qh++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) enqueue(p - 1);
    if (x + 1 < w) enqueue(p + 1);
    if (y > 0) enqueue(p - w);
    if (y + 1 < h) enqueue(p + w);
  }

  for (let p = 0; p < pixels; p++) {
    if (visited[p]) d[p * 4 + 3] = 0;
  }

  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("PNG export failed."));
          return;
        }
        resolve(blob);
      },
      "image/png",
      1
    );
  });
}
