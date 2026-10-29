import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { canonicalJson } from '../lib/format.js';

export function etagFor(payload: unknown): string {
  const hash = createHash('sha256').update(canonicalJson(payload)).digest('base64url').slice(0, 20);
  return `"${hash}"`;
}

// Sends a single resource with a strong ETag and handles If-None-Match.
export function sendCacheable(req: Request, res: Response, payload: unknown): void {
  if (!config.cacheEnabled) {
    res.status(200).json(payload);
    return;
  }

  const etag = etagFor(payload);
  res.set({
    ETag: etag,
    'Cache-Control': 'private, max-age=60',
    Vary: 'Authorization',
  });

  const candidates = (req.get('if-none-match') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (candidates.includes(etag) || candidates.includes('*')) {
    res.status(304).end();
    return;
  }

  res.status(200).json(payload);
}

// Collections are not cached here: their parameters and tenant scope make
// shared caching dangerous and low-value.
export function noStore(res: Response): void {
  if (config.cacheEnabled) res.set('Cache-Control', 'private, no-store');
}

export function notModified(req: Request, res: Response, etag: string): boolean {
  const candidates = (req.get('if-none-match') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!candidates.includes(etag) && !candidates.includes('*')) return false;
  res.status(304).end();
  return true;
}
