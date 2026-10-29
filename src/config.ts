import 'dotenv/config';
import { resolve } from 'node:path';

function flag(name: string, fallback: 'on' | 'off'): boolean {
  const raw = (process.env[name] ?? fallback).toLowerCase();
  if (raw !== 'on' && raw !== 'off') {
    throw new Error(`${name} must be "on" or "off" (got "${raw}")`);
  }
  return raw === 'on';
}

export const config = {
  port: Number(process.env.PORT ?? 4010),
  // Authentication is off only for the early tutorial chapters.
  authEnabled: flag('AUTH_ENABLED', 'on'),
  rateLimitEnabled: flag('RATE_LIMIT_ENABLED', 'off'),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 3),
  rateLimitWindowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60),
  cacheEnabled: flag('CACHE_ENABLED', 'on'),
  // Chapters 1-13 run with this off so /api looks like a normal, current API.
  // Chapter 14 turns it on to show the real deprecation notice.
  legacyDeprecationHeaders: flag('LEGACY_DEPRECATION_HEADERS', 'on'),
  uploadDir: resolve(process.env.UPLOAD_DIR ?? 'uploads'),
  webhookReceiverUrl: process.env.WEBHOOK_RECEIVER_URL ?? 'http://localhost:4020/hooks/orders',
} as const;
