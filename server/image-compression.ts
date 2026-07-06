import { extname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

export const MAX_IMAGE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const RESIZE_WIDTHS = [1920, 1600, 1280, 1024, 800, 640];
const JPEG_QUALITIES = [80, 65, 50, 35, 20];

function isCompressibleImage(mimeType: string): boolean {
  return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml' && mimeType !== 'image/gif';
}

async function compressBuffer(input: Buffer, maxBytes: number): Promise<Buffer | null> {
  for (const width of RESIZE_WIDTHS) {
    for (const quality of JPEG_QUALITIES) {
      const buffer = await sharp(input)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (buffer.length <= maxBytes) return buffer;
    }
  }
  return null;
}

/**
 * Shrinks an over-limit image in place (rewrites file.path and updates the multer
 * File's size/mimetype/name). Returns false if it still can't fit under maxBytes.
 */
async function compressImageFileIfNeeded(file: Express.Multer.File, maxBytes: number): Promise<boolean> {
  if (file.size <= maxBytes || !isCompressibleImage(file.mimetype)) return file.size <= maxBytes;

  const original = await readFile(file.path);
  const compressed = await compressBuffer(original, maxBytes);
  if (!compressed) return false;

  await writeFile(file.path, compressed);
  file.size = compressed.length;
  file.mimetype = 'image/jpeg';
  if (!/\.jpe?g$/i.test(file.originalname)) {
    file.originalname = file.originalname.replace(new RegExp(`${extname(file.originalname)}$`), '.jpg');
  }
  return true;
}

/** Compresses any oversized images in place; returns the names of files that still exceed maxBytes. */
export async function compressOversizedImages(
  files: Express.Multer.File[],
  maxBytes: number,
): Promise<string[]> {
  const failures: string[] = [];
  for (const file of files) {
    const ok = await compressImageFileIfNeeded(file, maxBytes);
    if (!ok) failures.push(file.originalname || file.filename);
  }
  return failures;
}
