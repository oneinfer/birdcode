const MAX_IMAGE_UPLOAD_BYTES = 2 * 1024 * 1024;
const MIN_QUALITY = 0.55;
const QUALITY_STEP = 0.08;
const SCALE_STEP = 0.85;
const MIN_DIMENSION = 480;

export async function prepareAttachmentsForUpload(files: File[]): Promise<File[]> {
  if (files.length === 0) return files;
  return Promise.all(files.map((file) => compressImageForUpload(file)));
}

async function compressImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= MAX_IMAGE_UPLOAD_BYTES) return file;

  const bitmap = await createImageBitmap(file);
  try {
    let width = bitmap.width;
    let height = bitmap.height;

    while (width >= MIN_DIMENSION && height >= MIN_DIMENSION) {
      for (let quality = 0.86; quality >= MIN_QUALITY; quality -= QUALITY_STEP) {
        const blob = await renderImage(bitmap, width, height, quality);
        if (blob.size <= MAX_IMAGE_UPLOAD_BYTES) {
          return new File([blob], compressedName(file.name), {
            type: blob.type,
            lastModified: file.lastModified,
          });
        }
      }

      width = Math.floor(width * SCALE_STEP);
      height = Math.floor(height * SCALE_STEP);
    }
  } finally {
    bitmap.close();
  }

  return file;
}

async function renderImage(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image compression is unavailable in this browser');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Image compression failed')),
      'image/jpeg',
      quality,
    );
  });
}

function compressedName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim() || 'image';
  return `${base}.jpg`;
}
