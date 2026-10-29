import { createHash } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { canonicalJson } from '../lib/format.js';
import { newId } from '../lib/ids.js';
import { HttpProblem } from '../http/problem.js';

export type IdempotentResult = {
  status: number;
  body: unknown;
  replayed: boolean;
};

function sameRequest(
  existing: {
    requestHash: string;
    method: string;
    path: string;
  },
  requestHash: string,
  method: string,
  path: string,
): boolean {
  return (
    existing.requestHash === requestHash &&
    existing.method === method &&
    existing.path === path
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

// Stores the first response for (tenant, key) and replays it on retries.
export async function runIdempotent(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    key: string;
    method: string;
    path: string;
    body: unknown;
    execute: (idempotencyRowId: string) => Promise<{ status: number; body: unknown }>;
  },
): Promise<IdempotentResult> {
  const requestHash = createHash('sha256')
    .update(canonicalJson(input.body))
    .digest('hex');

  const existing = await prisma.idempotencyKey.findUnique({
    where: { tenantId_key: { tenantId: input.tenantId, key: input.key } },
  });

  if (existing) {
    if (!sameRequest(existing, requestHash, input.method, input.path)) {
      throw new HttpProblem(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    if (existing.statusCode === null) {
      throw new HttpProblem(409, 'idempotency_in_progress', 'The original request is still in progress.');
    }
    return { status: existing.statusCode, body: existing.responseBody, replayed: true };
  }

  let row;
  try {
    row = await prisma.idempotencyKey.create({
      data: {
        id: newId('idem'),
        tenantId: input.tenantId,
        key: input.key,
        requestHash,
        method: input.method,
        path: input.path,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.idempotencyKey.findUnique({
      where: { tenantId_key: { tenantId: input.tenantId, key: input.key } },
    });
    if (raced?.statusCode !== null && raced) {
      if (!sameRequest(raced, requestHash, input.method, input.path)) {
        throw new HttpProblem(
          409,
          'idempotency_key_reused',
          'This Idempotency-Key was already used with a different request.',
        );
      }
      return { status: raced.statusCode, body: raced.responseBody, replayed: true };
    }
    throw new HttpProblem(409, 'idempotency_in_progress', 'The original request is still in progress.');
  }

  try {
    const result = await input.execute(row.id);
    await prisma.idempotencyKey.update({
      where: { id: row.id },
      data: {
        statusCode: result.status,
        // Round-trip through JSON to match the Json column type exactly.
        responseBody: JSON.parse(JSON.stringify(result.body)) as object,
      },
    });
    return { ...result, replayed: false };
  } catch (error) {
    // A failed attempt must not poison the key: let the client retry.
    await prisma.idempotencyKey.delete({ where: { id: row.id } }).catch(() => undefined);
    throw error;
  }
}
