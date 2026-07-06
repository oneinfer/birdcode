import { mkdirSync } from 'node:fs';
import { copyFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import type { ChatAttachment } from '../shared/types.js';
import { resolveBeesWorkspaceDir } from './paths.js';
import { compressOversizedImages, MAX_IMAGE_ATTACHMENT_BYTES } from './image-compression.js';
import { toErrorMessage } from './errors.js';

const ATTACHMENT_TMP_DIR = join(tmpdir(), 'bees-chat-attachments');
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 10;

mkdirSync(ATTACHMENT_TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: ATTACHMENT_TMP_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${safeFileName(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: MAX_ATTACHMENT_BYTES,
    files: MAX_ATTACHMENT_COUNT,
  },
}).array('attachments', MAX_ATTACHMENT_COUNT);

export function attachmentUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (error) => {
    if (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to upload attachments' });
      return;
    }
    const files = uploadedAttachments(req);
    compressOversizedImages(files, MAX_IMAGE_ATTACHMENT_BYTES)
      .then((stillTooLarge) => {
        if (stillTooLarge.length > 0) {
          return cleanupUploadedAttachments(files).then(() => {
            res.status(413).json({
              error: `Image attachments must be 2 MB or smaller: ${stillTooLarge.join(', ')}`,
              code: 'IMAGE_ATTACHMENT_TOO_LARGE',
            });
          });
        }
        next();
      })
      .catch((compressionError) => {
        cleanupUploadedAttachments(files).finally(() => {
          res.status(500).json({ error: toErrorMessage(compressionError, 'Failed to process attachments') });
        });
      });
  });
}

export function uploadedAttachments(req: Request): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files : [];
}

export async function cleanupUploadedAttachments(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
}

export async function deleteTaskAttachments(taskId: string): Promise<void> {
  const attachmentsRoot = resolve(resolveBeesWorkspaceDir(), 'attachments');
  const attachmentDir = resolve(attachmentsRoot, taskId);
  if (!attachmentDir.startsWith(`${attachmentsRoot}${sep}`)) return;
  await rm(attachmentDir, { recursive: true, force: true });
}

export async function saveTaskAttachments(
  taskId: string,
  files: Express.Multer.File[],
): Promise<ChatAttachment[]> {
  if (files.length === 0) return [];

  const attachmentDir = join(resolveBeesWorkspaceDir(), 'attachments', taskId);
  mkdirSync(attachmentDir, { recursive: true });

  const attachments: ChatAttachment[] = [];

  for (const file of files) {
    const id = randomUUID();
    const safeName = safeFileName(file.originalname || 'attachment');
    const targetPath = join(attachmentDir, `${Date.now()}-${id}-${safeName}`);

    try {
      await rename(file.path, targetPath);
    } catch {
      await copyFile(file.path, targetPath);
      await unlink(file.path).catch(() => undefined);
    }

    attachments.push({
      id,
      name: file.originalname || safeName,
      path: targetPath,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      kind: (file.mimetype || '').startsWith('image/') ? 'image' : 'file',
    });
  }

  return attachments;
}

export async function saveActivityImageAttachments(
  taskId: string,
  images: Iterable<unknown>,
): Promise<ChatAttachment[]> {
  const imageInputs = Array.from(images)
    .map(activityImageInput)
    .filter((image): image is ActivityImageInput => Boolean(image));
  if (imageInputs.length === 0) return [];

  const attachmentDir = join(resolveBeesWorkspaceDir(), 'attachments', taskId);
  mkdirSync(attachmentDir, { recursive: true });

  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();

  for (const image of imageInputs) {
    const dedupeKey = image.path || image.base64;
    if (dedupeKey && seen.has(dedupeKey)) continue;
    if (dedupeKey) seen.add(dedupeKey);

    const id = randomUUID();
    const sourceName = image.path ? basename(image.path) : 'activity-screenshot.png';
    const safeName = ensureImageExtension(safeFileName(sourceName), image.mimeType);
    const targetPath = join(attachmentDir, `${Date.now()}-${id}-${safeName}`);

    if (image.base64) {
      await writeFile(targetPath, Buffer.from(normalizeBase64(image.base64), 'base64'));
    } else if (image.path) {
      await copyFile(image.path, targetPath);
    } else {
      continue;
    }

    const targetStats = await stat(targetPath).catch(() => null);
    attachments.push({
      id,
      name: safeName,
      path: targetPath,
      mimeType: image.mimeType || mimeTypeForImagePath(safeName),
      size: targetStats?.size ?? 0,
      kind: 'image',
    });
  }

  return attachments;
}

export function appendAttachmentContext(message: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return message;

  const lines = attachments.map((attachment, index) => {
    return [
      `  <attachment index="${index + 1}" kind="${attachment.kind}">`,
      `    <name>${escapeXml(attachment.name)}</name>`,
      `    <mime_type>${escapeXml(attachment.mimeType)}</mime_type>`,
      `    <size_bytes>${attachment.size}</size_bytes>`,
      `    <absolute_path>${escapeXml(attachment.path)}</absolute_path>`,
      ...(attachment.visualSummary
        ? ['    <visual_summary>', indentXmlText(escapeXml(attachment.visualSummary), 6), '    </visual_summary>']
        : []),
      '  </attachment>',
    ].join('\n');
  });

  return `${message.trimEnd()}

The user attached the following file${attachments.length === 1 ? '' : 's'}. Use the visual summary and absolute path to understand image/file content when it is relevant.
<attachments>
${lines.join('\n')}
</attachments>`;
}

function safeFileName(value: string): string {
  const name = basename(value).trim().replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_');
  return name || 'attachment';
}

interface ActivityImageInput {
  path?: string;
  base64?: string;
  mimeType: string;
}

function activityImageInput(value: unknown): ActivityImageInput | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
  const rawBase64 = typeof record.base64 === 'string' && record.base64.trim() ? record.base64.trim() : undefined;
  const dataUrlMatch = rawBase64?.match(/^data:([^;,]+);base64,(.+)$/);
  const base64 = dataUrlMatch ? dataUrlMatch[2] : rawBase64;
  const mimeType = dataUrlMatch?.[1]
    || (typeof record.mimeType === 'string' && record.mimeType.trim())
    || (typeof record.mime_type === 'string' && record.mime_type.trim())
    || (path ? mimeTypeForImagePath(path) : 'image/png');

  if (!path && !base64) return null;
  return { path, base64, mimeType };
}

function normalizeBase64(value: string): string {
  const match = value.match(/^data:[^;,]+;base64,(.+)$/);
  return match ? match[1] : value;
}

function ensureImageExtension(name: string, mimeType: string): string {
  if (extname(name)) return name;
  return `${name}.${extensionForMimeType(mimeType)}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}

function mimeTypeForImagePath(imagePath: string): string {
  const lower = imagePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function indentXmlText(value: string, spaces: number): string {
  const padding = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${padding}${line}`).join('\n');
}
