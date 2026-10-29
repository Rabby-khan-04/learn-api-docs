import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { HttpProblem, notFound } from '../http/problem.js';
import { requireRole } from '../http/auth.js';
import { newId } from '../lib/ids.js';
import { iso } from '../lib/format.js';
import type { Store } from '../store/types.js';
import { pathParam, tenantIdOf } from './helpers.js';

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

// The extension is chosen from the bytes we actually received, never from the
// client-supplied filename. A file called shell.php with a PNG header stays .png.
function sniffImage(bytes: Buffer): { contentType: string; ext: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', ext: '.png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: '.jpg' };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { contentType: 'image/webp', ext: '.webp' };
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED.has(file.mimetype)) {
      callback(new HttpProblem(415, 'unsupported_media_type', 'Only PNG, JPEG, and WebP images are accepted.'));
      return;
    }
    callback(null, true);
  },
});

function singleFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      next(new HttpProblem(413, 'file_too_large', `Images must be at most ${MAX_BYTES} bytes.`));
      return;
    }
    next(error);
  });
}

export function uploadsRouter(prisma: PrismaClient, store: Store): Router {
  const router = Router({ mergeParams: true });

  router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), singleFile, async (req, res) => {
    const tenantId = tenantIdOf(req);
    const file = req.file;
    if (!file) {
      throw new HttpProblem(422, 'file_required', 'Send one file in the multipart field named "file".', {
        title: 'Validation Failed',
        errors: [{ pointer: '/file', code: 'required', message: 'A file is required.' }],
      });
    }

    const productIdRaw = typeof req.query.productId === 'string' ? req.query.productId : undefined;
    if (productIdRaw) {
      const product = await store.findProduct(tenantId, productIdRaw);
      if (!product) throw notFound('Product not found.');
    }

    const sniffed = sniffImage(file.buffer);
    if (!sniffed) {
      throw new HttpProblem(415, 'unsupported_media_type', 'The file content is not a PNG, JPEG, or WebP image.');
    }

    const id = newId('upl');
    const storageKey = join(tenantId, `${id}${sniffed.ext}`);
    const absolute = join(config.uploadDir, storageKey);
    await mkdir(join(config.uploadDir, tenantId), { recursive: true });
    await writeFile(absolute, file.buffer);

    const record = await prisma.upload.create({
      data: {
        id,
        tenantId,
        productId: productIdRaw ?? null,
        filename: sanitizeFilename(file.originalname),
        contentType: sniffed.contentType,
        sizeBytes: file.size,
        storageKey,
      },
    });

    res.set('Cache-Control', 'no-store');
    res.status(201).location(`/v1/tenants/${tenantId}/uploads/${record.id}`).json({
      id: record.id,
      productId: record.productId,
      filename: record.filename,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      url: `/v1/tenants/${tenantId}/uploads/${record.id}`,
      checksumSha256: createHash('sha256').update(file.buffer).digest('hex'),
      createdAt: iso(record.createdAt),
    });
  });

  router.get('/:uploadId', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const record = await prisma.upload.findFirst({
      where: { id: pathParam(req, 'uploadId'), tenantId },
    });
    if (!record) throw notFound('Upload not found.');

    res.type(record.contentType);
    res.set({
      'Content-Disposition': `inline; filename="${record.filename}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile(join(config.uploadDir, record.storageKey));
  });

  return router;
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'upload';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : `upload${extname(name) || ''}`;
}
