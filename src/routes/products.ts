import { Router } from 'express';
import { config } from '../config.js';
import { etagFor, noStore, sendCacheable } from '../http/cache.js';
import { parseInput, notFound, HttpProblem } from '../http/problem.js';
import { pageMeta } from '../http/pagination.js';
import { requireRole } from '../http/auth.js';
import {
  bulkUpdateSchema,
  createProductSchema,
  patchProductSchema,
  productListQuerySchema,
  replaceProductSchema,
} from '../schemas/product.js';
import { productDto, type Store } from '../store/types.js';
import { assertPaginationMode, expectedVersionFrom, parseFields, pathParam, selectFields, tenantIdOf } from './helpers.js';

export function productsRouter(store: Store): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const query = parseInput(productListQuerySchema, req.query);
    assertPaginationMode(query);
    const fields = parseFields(query.fields);

    const result = await store.listProducts(tenantId, {
      q: query.q,
      active: query.active,
      minPriceCents: query.minPriceCents,
      maxPriceCents: query.maxPriceCents,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
      cursor: query.cursor,
      includeTotal: query.includeTotal,
    });

    noStore(res);
    res.status(200).json({
      data: result.items.map((item) => selectFields(productDto(item), fields)),
      pagination: pageMeta(result, {
        limit: query.limit,
        offset: query.offset,
        cursor: query.cursor,
        includeTotal: query.includeTotal,
      }),
    });
  });

  router.patch('/bulk', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const body = parseInput(bulkUpdateSchema, req.body);
    const result = await store.bulkUpdateProducts(tenantId, body.updates);
    if (!result.ok) {
      throw new HttpProblem(422, 'bulk_update_failed', 'No products were changed because some updates failed.', {
        title: 'Validation Failed',
        errors: result.errors.map((error) => ({
          pointer: '/updates',
          code: error.code,
          message: `${error.id}: ${error.message}`,
        })),
      });
    }
    noStore(res);
    res.status(200).json({ data: result.items.map(productDto) });
  });

  router.post('/', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const input = parseInput(createProductSchema, req.body);
    const record = await store.createProduct(tenantId, input);
    const dto = productDto(record);
    noStore(res);
    res.status(201).location(`${req.baseUrl}/${record.id}`).json(dto);
  });

  router.get('/:productId', async (req, res) => {
    const tenantId = tenantIdOf(req);
    const record = await store.findProduct(tenantId, pathParam(req, 'productId'));
    if (!record) throw notFound('Product not found.');
    const dto = productDto(record);
    if (config.cacheEnabled) {
      sendCacheable(req, res, dto);
    } else {
      res.status(200).json(dto);
    }
  });

  router.put('/:productId', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const current = await store.findProduct(tenantId, pathParam(req, 'productId'));
    if (!current) throw notFound('Product not found.');
    const expectedVersion = expectedVersionFrom(req, current);
    const input = parseInput(replaceProductSchema, req.body);
    const record = await store.replaceProduct(tenantId, current.id, input, expectedVersion);
    if (!record) throw notFound('Product not found.');
    const dto = productDto(record);
    if (config.cacheEnabled) {
      res.set({ ETag: etagFor(dto), 'Cache-Control': 'private, max-age=60' });
    }
    res.status(200).json(dto);
  });

  router.patch('/:productId', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const current = await store.findProduct(tenantId, pathParam(req, 'productId'));
    if (!current) throw notFound('Product not found.');
    const expectedVersion = expectedVersionFrom(req, current);
    const input = parseInput(patchProductSchema, req.body);
    const record = await store.patchProduct(tenantId, current.id, input, expectedVersion);
    if (!record) throw notFound('Product not found.');
    const dto = productDto(record);
    if (config.cacheEnabled) {
      res.set({ ETag: etagFor(dto), 'Cache-Control': 'private, max-age=60' });
    }
    res.status(200).json(dto);
  });

  router.delete('/:productId', requireRole('ADMIN', 'PLATFORM_ADMIN'), async (req, res) => {
    const tenantId = tenantIdOf(req);
    const deleted = await store.deleteProduct(tenantId, pathParam(req, 'productId'));
    if (!deleted) throw notFound('Product not found.');
    res.status(204).end();
  });

  return router;
}
