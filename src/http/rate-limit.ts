import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { HttpProblem } from './problem.js';

type Bucket = { count: number; resetAt: number };

// In-memory fixed-window limiter, partitioned by tenant. A real deployment
// would use a shared store (Redis) so limits hold across processes.
const buckets = new Map<string, Bucket>();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!config.rateLimitEnabled) {
    next();
    return;
  }

  const partition = req.tenantId ?? req.ip ?? 'unknown';
  const now = Date.now();
  const windowMs = config.rateLimitWindowSeconds * 1000;
  let bucket = buckets.get(partition);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(partition, bucket);
  }

  const remainingBefore = Math.max(0, config.rateLimitMax - bucket.count);
  const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
  res.set('RateLimit-Policy', `"standard";q=${config.rateLimitMax};w=${config.rateLimitWindowSeconds}`);
  res.set('RateLimit', `"standard";r=${remainingBefore};t=${resetSeconds}`);

  if (bucket.count >= config.rateLimitMax) {
    res.set('Retry-After', String(resetSeconds));
    throw new HttpProblem(429, 'rate_limited', 'Too many requests for this tenant. Retry later.', {
      extensions: {
        retryAfterSeconds: resetSeconds,
      },
    });
  }

  bucket.count += 1;
  res.set(
    'RateLimit',
    `"standard";r=${Math.max(0, config.rateLimitMax - bucket.count)};t=${resetSeconds}`,
  );
  next();
}
