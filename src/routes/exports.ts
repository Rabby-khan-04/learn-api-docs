import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { HttpProblem, notFound } from '../http/problem.js';
import { requireRole } from '../http/auth.js';
import { iso } from '../lib/format.js';
import { newId } from '../lib/ids.js';
import type { Store } from '../store/types.js';
import { pathParam, tenantIdOf } from './helpers.js';

export const EXPORT_DELAY_MS = 1200;

function operationDto(record: {
  id: string;
  type: string;
  status: string;
  resultUrl: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    resultUrl: record.resultUrl,
    error: record.error,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportsRouter(prisma: PrismaClient, store: Store): Router {
  const router = Router({ mergeParams: true });

  router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const operation = await prisma.operation.create({
      data: { id: newId('op'), tenantId, type: 'products_csv', status: 'QUEUED' },
    });

    // A job queue would do this. Keeping it in-process makes the 202 flow
    // observable in a single tutorial server.
    setTimeout(() => {
      void runExport(prisma, store, tenantId, operation.id).catch((error) => {
        console.error('export failed', error);
      });
    }, EXPORT_DELAY_MS);

    res.set({ 'Cache-Control': 'no-store', 'Retry-After': '1' });
    res.status(202).location(`/v1/tenants/${tenantId}/exports/${operation.id}`).json({
      operation: operationDto(operation),
      links: { self: `/v1/tenants/${tenantId}/exports/${operation.id}` },
    });
  });

  router.get('/:operationId', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const operation = await prisma.operation.findFirst({
      where: { id: pathParam(req, 'operationId'), tenantId },
    });
    if (!operation) throw notFound('Operation not found.');
    res.set({ 'Cache-Control': 'no-store', ...(operation.status === 'QUEUED' ? { 'Retry-After': '1' } : {}) });
    res.status(200).json(operationDto(operation));
  });

  router.get('/:operationId/result', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const operation = await prisma.operation.findFirst({
      where: { id: pathParam(req, 'operationId'), tenantId },
    });
    if (!operation) throw notFound('Operation not found.');
    if (operation.status !== 'SUCCEEDED' || !operation.resultUrl) {
      throw new HttpProblem(
        409,
        'operation_not_complete',
        `The export is ${operation.status.toLowerCase()}. Poll the operation until it succeeds.`,
        { extensions: { operationStatus: operation.status } },
      );
    }
    const file = await readFile(join(config.uploadDir, 'exports', tenantId, `${operation.id}.csv`), 'utf8');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="products-${operation.id}.csv"`,
      'Cache-Control': 'private, no-store',
    });
    res.status(200).send(file);
  });

  return router;
}

async function runExport(
  prisma: PrismaClient,
  store: Store,
  tenantId: string,
  operationId: string,
): Promise<void> {
  try {
    await prisma.operation.update({
      where: { id: operationId },
      data: { status: 'RUNNING' },
    });

    const result = await store.listProducts(tenantId, {
      sort: 'createdAt',
      limit: 100,
      includeTotal: false,
    });

    const header = 'id,sku,slug,name,priceCents,currency,stock,active,version,createdAt';
    const lines = result.items.map((product) =>
      [
        product.id,
        product.sku,
        product.slug,
        product.name,
        product.priceCents,
        product.currency,
        product.stock,
        product.active,
        product.version,
        iso(product.createdAt),
      ]
        .map(csvCell)
        .join(','),
    );

    const dir = join(config.uploadDir, 'exports', tenantId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${operationId}.csv`), `${[header, ...lines].join('\n')}\n`, 'utf8');

    await prisma.operation.update({
      where: { id: operationId },
      data: {
        status: 'SUCCEEDED',
        resultUrl: `/v1/tenants/${tenantId}/exports/${operationId}/result`,
      },
    });
  } catch (error) {
    await prisma.operation
      .update({
        where: { id: operationId },
        data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 500) : 'export failed' },
      })
      .catch(() => undefined);
  }
}
